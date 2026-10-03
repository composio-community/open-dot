import "server-only";
import path from "node:path";
import fs from "node:fs";
import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright";
import { DATA_DIR } from "../db";
import { emit } from "../bus";
import { clickScript, typeScript, loginScript } from "./dom-actions";

// Each dot gets its own persistent Chrome profile, so logins survive restarts. It always runs headless:
// the Computer tab streams its screen and forwards your mouse and keyboard when you take over.

export const SCREEN = { width: 1280, height: 800 };

// Bumped when sessions launched by older code must be replaced (v2: always headless; v1 could be a visible window).
const SESSION_V = 2;
type Session = { context: BrowserContext; lastShot: Buffer | null; shotAt: number; v?: number };
const g = globalThis as unknown as { __dotsBrowsers?: Map<string, Promise<Session>> };
const sessions: Map<string, Promise<Session>> = (g.__dotsBrowsers ??= new Map());

function profileDir(dotId: string) {
  const dir = path.join(DATA_DIR, "dots", dotId, "browser");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// The last real page the dot was on. Kept on disk so closing the window (or restarting) doesn't lose its place.
const lastUrlFile = (dotId: string) => path.join(DATA_DIR, "dots", dotId, "last-url");
const isReal = (url: string) => /^https?:\/\//.test(url);

function lastUrl(dotId: string): string | null {
  try {
    const url = fs.readFileSync(lastUrlFile(dotId), "utf8").trim();
    return isReal(url) ? url : null;
  } catch {
    return null;
  }
}

function track(dotId: string, p: Page) {
  p.on("framenavigated", (frame) => {
    if (frame !== p.mainFrame()) return;
    emit({ type: "browser_url", dotId, url: frame.url() });
    if (isReal(frame.url())) fs.writeFile(lastUrlFile(dotId), frame.url(), () => {});
  });
}

// The real installed Chrome, not Playwright's test build: Google refuses sign-in on the test build.
// Falls back to Playwright's Chromium if Chrome isn't installed.
let channel: "chrome" | "chromium" = "chrome";
// Headless Chrome still says "HeadlessChrome" in its user agent, which sites treat as a bot. Use the normal one.
let chromeUA: string | null = null;

/**
 * A Chrome left over from an earlier server run (or an old visible window) keeps the profile locked, and a new
 * launch on a locked profile just hangs. The profile only ever belongs to this dot's browser, so close it.
 */
async function freeProfile(dir: string) {
  let pid: number;
  try {
    pid = Number(fs.readlinkSync(path.join(dir, "SingletonLock")).split("-").pop());
  } catch {
    return;
  }
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  if (!pid || pid === process.pid || !alive()) return;
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
  if (alive()) process.kill(pid, "SIGKILL");
}

async function launch(dotId: string): Promise<Session> {
  await freeProfile(profileDir(dotId));
  const open = () =>
    chromium.launchPersistentContext(profileDir(dotId), {
      channel,
      headless: true,
      timeout: 30_000,
      viewport: SCREEN,
      deviceScaleFactor: 1,
      locale: "en-US",
      timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
      // Keep Chrome's sandbox on (Playwright turns it off by default, which shows an "unsupported flag" warning).
      chromiumSandbox: true,
      // No "Chrome is being controlled by automated software" flag, and no navigator.webdriver.
      ignoreDefaultArgs: ["--enable-automation", "--unsafely-disable-devtools-self-xss-warnings"],
      args: ["--disable-blink-features=AutomationControlled", ...(chromeUA ? [`--user-agent=${chromeUA}`] : [])],
    });
  let context: BrowserContext;
  try {
    context = await open();
  } catch (err) {
    if (channel !== "chrome") throw err;
    channel = "chromium";
    context = await open();
  }
  if (!chromeUA) {
    // First launch: learn this Chrome's version, then relaunch looking like the normal browser.
    const probe = context.pages()[0] ?? (await context.newPage());
    const ua = await probe.evaluate(() => navigator.userAgent);
    chromeUA = ua.replace("HeadlessChrome/", "Chrome/");
    if (ua !== chromeUA) {
      await context.close();
      context = await open();
    }
  }
  for (const p of context.pages()) track(dotId, p);
  context.on("page", (p) => track(dotId, p));
  // Forget the session only if it's still this one.
  context.on("close", () => {
    sessions.get(dotId)?.then((cur) => cur.context === context && sessions.delete(dotId), () => {});
  });
  return { context, lastShot: null, shotAt: 0, v: SESSION_V };
}

async function session(dotId: string): Promise<Session> {
  let s = sessions.get(dotId);
  const stale = s && (await s.catch(() => null))?.v !== SESSION_V;
  if (stale && sessions.get(dotId) === s) {
    sessions.delete(dotId);
    await (await s!.catch(() => null))?.context.close().catch(() => {});
    s = undefined;
  }
  s = sessions.get(dotId) ?? s;
  if (!s) {
    s = launch(dotId);
    sessions.set(dotId, s);
    s.catch(() => sessions.delete(dotId));
  }
  return s;
}

/** The dot's current tab. A fresh browser picks up where the dot left off unless `restore` is false. */
export async function page(dotId: string, restore = true): Promise<Page> {
  const { context } = await session(dotId);
  const pages = context.pages();
  const p = pages[pages.length - 1] ?? (await context.newPage());
  const resume = restore && !isReal(p.url()) && pages.length <= 1 ? lastUrl(dotId) : null;
  if (resume) await p.goto(resume, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
  return p;
}

export async function screenshot(dotId: string): Promise<Buffer> {
  const s = await session(dotId);
  const p = await page(dotId);
  const buf = await p.screenshot({ type: "png" });
  s.lastShot = buf;
  s.shotAt = Date.now();
  emit({ type: "screen", dotId, at: s.shotAt });
  return buf;
}

export async function lastScreenshot(dotId: string): Promise<Buffer | null> {
  const s = sessions.get(dotId);
  return s ? (await s).lastShot : null;
}

export async function openUrl(dotId: string, url: string): Promise<string> {
  const p = await page(dotId, false);
  const target = /^https?:\/\//.test(url) ? url : `https://${url}`;
  await p.goto(target, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await p.waitForTimeout(800);
  await screenshot(dotId);
  return `Opened ${p.url()} — "${await p.title()}"`;
}

export async function readPage(dotId: string): Promise<string> {
  const p = await page(dotId);
  const text = await p.evaluate(() => document.body?.innerText ?? "");
  const clipped = text.replace(/\n{3,}/g, "\n\n").slice(0, 15_000);
  return `URL: ${p.url()}\nTitle: ${await p.title()}\n\n${clipped}`;
}

const KEY_MAP: Record<string, string> = {
  ENTER: "Enter", RETURN: "Enter", ESC: "Escape", ESCAPE: "Escape", TAB: "Tab", SPACE: " ", BACKSPACE: "Backspace",
  DELETE: "Delete", UP: "ArrowUp", DOWN: "ArrowDown", LEFT: "ArrowLeft", RIGHT: "ArrowRight", ARROWUP: "ArrowUp",
  ARROWDOWN: "ArrowDown", ARROWLEFT: "ArrowLeft", ARROWRIGHT: "ArrowRight", CTRL: "Control", CONTROL: "Control",
  CMD: "Meta", META: "Meta", SUPER: "Meta", ALT: "Alt", OPTION: "Alt", SHIFT: "Shift", PAGEUP: "PageUp", PAGEDOWN: "PageDown",
  HOME: "Home", END: "End",
};
const key = (k: string) => KEY_MAP[k.toUpperCase()] ?? (k.length === 1 ? k : k[0].toUpperCase() + k.slice(1).toLowerCase());

export type ComputerAction =
  | { type: "click"; x: number; y: number; button?: string; keys?: string[] | null }
  | { type: "double_click"; x: number; y: number; keys?: string[] | null }
  | { type: "drag"; path: { x: number; y: number }[] }
  | { type: "keypress"; keys: string[] }
  | { type: "move"; x: number; y: number }
  | { type: "screenshot" }
  | { type: "scroll"; x: number; y: number; scroll_x: number; scroll_y: number }
  | { type: "type"; text: string }
  | { type: "wait" };

/** Execute one OpenAI computer-use action against the dot's browser. */
export async function doAction(dotId: string, action: ComputerAction): Promise<void> {
  const p = await page(dotId);
  switch (action.type) {
    case "click": {
      const button = action.button === "right" ? "right" : action.button === "wheel" ? "middle" : "left";
      if (action.button === "back") await p.goBack().catch(() => {});
      else if (action.button === "forward") await p.goForward().catch(() => {});
      else await p.mouse.click(action.x, action.y, { button });
      break;
    }
    case "double_click":
      await p.mouse.dblclick(action.x, action.y);
      break;
    case "drag": {
      const [first, ...rest] = action.path;
      if (!first) break;
      await p.mouse.move(first.x, first.y);
      await p.mouse.down();
      for (const pt of rest) await p.mouse.move(pt.x, pt.y, { steps: 4 });
      await p.mouse.up();
      break;
    }
    case "keypress":
      await p.keyboard.press(action.keys.map(key).join("+"));
      break;
    case "move":
      await p.mouse.move(action.x, action.y);
      break;
    case "scroll":
      await p.mouse.move(action.x, action.y);
      await p.mouse.wheel(action.scroll_x, action.scroll_y);
      break;
    case "type":
      await p.keyboard.type(action.text, { delay: 15 });
      break;
    case "wait":
      await p.waitForTimeout(1500);
      break;
    case "screenshot":
      break;
  }
  await p.waitForTimeout(action.type === "wait" ? 0 : 400);
}

/** Click by visible text: Playwright's own locators first (real mouse events), then an in-page search. */
export async function clickText(dotId: string, text: string): Promise<string> {
  const p = await page(dotId, false);
  const name = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const target = p.getByRole("button", { name }).or(p.getByRole("link", { name })).or(p.getByText(text, { exact: false }));
  let label = text;
  try {
    await target.first().click({ timeout: 4000 });
  } catch {
    const r = (await p.evaluate(clickScript(text))) as { ok: boolean; label?: string; error?: string };
    if (!r.ok) return r.error ?? "Couldn't click that.";
    label = r.label || text;
  }
  await p.waitForTimeout(700);
  await screenshot(dotId);
  return `Clicked "${label}". Now on ${p.url()} — "${await p.title()}". Read the page to see what changed.`;
}

/** Type into the field whose label, placeholder or name matches `field`. */
export async function typeText(dotId: string, field: string, value: string, submit: boolean): Promise<string> {
  const p = await page(dotId, false);
  const target = p.getByLabel(field, { exact: false }).or(p.getByPlaceholder(field, { exact: false }));
  try {
    await target.first().fill(value, { timeout: 4000 });
    if (submit) await target.first().press("Enter");
  } catch {
    const r = (await p.evaluate(typeScript(field, value, submit))) as { ok: boolean; error?: string };
    if (!r.ok) return r.error ?? "Couldn't find that field.";
  }
  await p.waitForTimeout(submit ? 1200 : 300);
  await screenshot(dotId);
  return submit ? `Typed into "${field}" and submitted. Now on ${p.url()}.` : `Typed into "${field}".`;
}

/**
 * Fill a login form on the current page with a stored credential. The secret is typed
 * straight into the page; the model only learns whether it worked.
 */
export async function fillLogin(dotId: string, site: string, username: string, password: string): Promise<string> {
  const p = await page(dotId);
  const result = await p.evaluate(loginScript(site, username, password)) as { filled: number; error?: string };
  if (result.error) return result.error;
  const filled = result.filled;
  await screenshot(dotId);
  if (!filled) return "No visible login fields found on this page. Navigate to the sign-in form first.";
  const what = filled === 2 ? "username and password" : "the only login field visible (it may be a multi-step form; continue and call again)";
  return `Filled ${what} for ${username}. Submit the form to continue (the password itself is hidden from you).`;
}

/** Start the browser if needed and make sure it's showing something: its last page, or Google. */
export async function wake(dotId: string): Promise<void> {
  const p = await page(dotId);
  if (!isReal(p.url())) await p.goto("https://www.google.com", { waitUntil: "domcontentloaded" }).catch(() => {});
}

/** The user is done: refresh the still frame so the tab shows where they left it. */
export async function handBack(dotId: string): Promise<void> {
  if (sessions.has(dotId)) await screenshot(dotId).catch(() => {});
}

/**
 * Stream the dot's screen as JPEG frames (Chrome's screencast only sends a frame when something changes).
 * Follows the newest tab, so popups like "Sign in with Google" show up. Returns a function that stops it.
 */
export async function stream(dotId: string, onFrame: (jpeg: Buffer) => void): Promise<() => Promise<void>> {
  const { context } = await session(dotId);
  let cdp: CDPSession | null = null;
  let stopped = false;
  const attach = async () => {
    if (stopped) return;
    const p = await page(dotId, false);
    await cdp?.detach().catch(() => {});
    const s = (cdp = await context.newCDPSession(p));
    s.on("Page.screencastFrame", (f) => {
      onFrame(Buffer.from(f.data, "base64"));
      s.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    });
    await p.bringToFront().catch(() => {});
    await s.send("Page.startScreencast", { format: "jpeg", quality: 80, maxWidth: SCREEN.width, maxHeight: SCREEN.height });
    // Static pages may not repaint after attaching; show the current screen immediately.
    onFrame(await p.screenshot({ type: "jpeg", quality: 80 }));
    emit({ type: "browser_url", dotId, url: p.url() });
    p.once("close", () => void attach().catch(() => {}));
  };
  const onPage = () => void attach().catch(() => {});
  context.on("page", onPage);
  await attach();
  return async () => {
    stopped = true;
    context.off("page", onPage);
    await cdp?.detach().catch(() => {});
  };
}

export type UserInput =
  | { t: "down" | "up"; x: number; y: number; button: "left" | "right" | "middle"; clicks: number }
  | { t: "move"; x: number; y: number }
  | { t: "wheel"; x: number; y: number; dx: number; dy: number }
  | { t: "keydown" | "keyup"; key: string }
  | { t: "type" | "paste"; text: string }
  | { t: "nav"; url: string }
  | { t: "back" | "forward" | "reload" };

/** Apply one mouse / keyboard / navigation event from the user's live view. */
export async function input(dotId: string, e: UserInput): Promise<void> {
  const p = await page(dotId, false);
  switch (e.t) {
    case "move":
      return p.mouse.move(e.x, e.y);
    case "down":
    case "up":
      await p.mouse.move(e.x, e.y);
      return e.t === "down" ? p.mouse.down({ button: e.button, clickCount: e.clicks }) : p.mouse.up({ button: e.button, clickCount: e.clicks });
    case "wheel":
      await p.mouse.move(e.x, e.y);
      return p.mouse.wheel(e.dx, e.dy);
    case "keydown":
    case "keyup":
      // Keys Chrome doesn't know (dead keys, IME) are skipped rather than failing the whole stream of input.
      return (e.t === "keydown" ? p.keyboard.down(e.key) : p.keyboard.up(e.key)).catch(() => {});
    case "type":
      return p.keyboard.type(e.text).catch(() => p.keyboard.insertText(e.text));
    case "paste":
      return p.keyboard.insertText(e.text);
    case "nav": {
      const url = /^[a-z]+:\/\//i.test(e.url) ? e.url : /^[^\s]+\.[^\s]+$/.test(e.url) ? `https://${e.url}` : `https://www.google.com/search?q=${encodeURIComponent(e.url)}`;
      await p.goto(url, { waitUntil: "commit" }).catch(() => {});
      return;
    }
    case "back":
      await p.goBack({ waitUntil: "commit" }).catch(() => {});
      return;
    case "forward":
      await p.goForward({ waitUntil: "commit" }).catch(() => {});
      return;
    case "reload":
      await p.reload({ waitUntil: "commit" }).catch(() => {});
      return;
  }
}

export async function closeBrowser(dotId: string) {
  const s = sessions.get(dotId);
  if (s) await (await s).context.close().catch(() => {});
}

/** The dot was deleted: drop its browser profile (and the logins in it) along with its workspace. */
export async function deleteData(dotId: string) {
  await closeBrowser(dotId);
  sessions.delete(dotId);
  fs.rmSync(path.join(DATA_DIR, "dots", dotId), { recursive: true, force: true });
}
