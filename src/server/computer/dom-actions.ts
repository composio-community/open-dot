// Click and type by what's on the page (visible text, labels, placeholders) instead of screen coordinates.
// Used by models that don't have OpenAI's computer tool (open models on OpenRouter), on both the local
// browser (through Playwright) and the cloud computer (evaluated in the page over CDP).

/** Check the document origin and fill in one synchronous evaluation, before navigation can race the check. */
export function loginScript(site: string, username: string, password: string): string {
  const saved = new URL(site.includes("://") ? site : `https://${site}`);
  if (saved.protocol !== "https:" || saved.username || saved.password) throw new Error("Saved logins require an HTTPS site without credentials in its URL.");
  return `((origin, u, p) => {
    if (location.protocol !== 'https:' || location.origin !== origin) return {filled: 0, error: "Login blocked: open the exact HTTPS site saved in Settings, or take over to sign in yourself."};
    const vis = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !e.disabled && !e.readOnly; };
    const user = [...document.querySelectorAll('input[type=email],input[autocomplete=username],input[name*=user i],input[name*=email i],input[id*=user i],input[id*=email i],input[type=text]')].find(vis);
    const pass = [...document.querySelectorAll('input[type=password]')].find(vis);
    let filled = 0;
    for (const [el, value] of [[user, u], [pass, p]]) {
      if (!el || !value) continue;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', {bubbles: true}));
      el.dispatchEvent(new Event('change', {bubbles: true}));
      filled++;
    }
    return {filled};
  })(${JSON.stringify(saved.origin)}, ${JSON.stringify(username)}, ${JSON.stringify(password)})`;
}

/** In-page script: click the best match for `text`. Returns { ok, label } or { ok: false, error }. */
export function clickScript(text: string): string {
  return `((q) => {
    const norm = (s) => (s || "").replace(/\\s+/g, " ").trim().toLowerCase();
    const vis = (e) => { const r = e.getBoundingClientRect(); const st = getComputedStyle(e); return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none"; };
    const want = norm(q);
    const label = (e) => norm(e.innerText || e.value || e.getAttribute("aria-label") || e.getAttribute("title") || e.getAttribute("alt"));
    const sel = 'button, a, [role=button], [role=link], [role=tab], [role=option], [role=menuitem], [role=checkbox], [role=radio], input[type=submit], input[type=button], input[type=checkbox], input[type=radio], label, summary, [onclick], [tabindex]';
    const all = [...document.querySelectorAll(sel)].filter(vis);
    const pickFrom = (list) => list.find((e) => label(e) === want) || list.find((e) => label(e).startsWith(want)) || list.find((e) => label(e).includes(want));
    let el = pickFrom(all);
    if (!el) {
      const any = [...document.querySelectorAll("body *")].filter((e) => vis(e) && e.children.length === 0 && norm(e.textContent).includes(want));
      el = any[0] && (any[0].closest(sel) || any[0]);
    }
    if (!el) return { ok: false, error: "Nothing on the page matches " + JSON.stringify(q) + ". Read the page and use the exact text you see." };
    el.scrollIntoView({ block: "center" });
    el.click();
    return { ok: true, label: (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 80) };
  })(${JSON.stringify(text)})`;
}

/** In-page script: type `value` into the field best matching `field`, optionally pressing Enter. */
export function typeScript(field: string, value: string, submit: boolean): string {
  return `((q, v, submit) => {
    const norm = (s) => (s || "").replace(/\\s+/g, " ").trim().toLowerCase();
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const want = norm(q);
    const fields = [...document.querySelectorAll("input:not([type=hidden]):not([type=password]), textarea, [contenteditable=true], select")].filter(vis);
    const names = (e) => {
      const byFor = e.id ? document.querySelector('label[for="' + CSS.escape(e.id) + '"]') : null;
      return [byFor && byFor.innerText, e.closest("label") && e.closest("label").innerText, e.getAttribute("aria-label"), e.getAttribute("placeholder"), e.getAttribute("name"), e.id].map(norm).filter(Boolean);
    };
    const el = fields.find((e) => names(e).some((n) => n === want)) || fields.find((e) => names(e).some((n) => n.includes(want))) || (want ? null : fields[0]);
    if (!el) return { ok: false, error: "No field matches " + JSON.stringify(q) + ". Read the page and use the field's label or placeholder." };
    el.scrollIntoView({ block: "center" });
    el.focus();
    if (el.isContentEditable) { el.textContent = v; el.dispatchEvent(new InputEvent("input", { bubbles: true })); }
    else {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (submit) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
      const form = el.form || el.closest("form");
      if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
    }
    return { ok: true, field: names(el)[0] || el.tagName.toLowerCase() };
  })(${JSON.stringify(field)}, ${JSON.stringify(value)}, ${submit})`;
}

/** Clicks that spend money, send things or delete things ask first unless a rule says otherwise. */
export const RISKY_CLICK = /\b(pay|buy|purchase|place order|order now|checkout|check out|confirm|book|reserve|subscribe|send|submit|delete|remove|cancel)\b/i;
