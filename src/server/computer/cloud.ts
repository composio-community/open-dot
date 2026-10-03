import "server-only";
import { Sandbox } from "@e2b/desktop";
import * as repo from "../repo";
import { emit } from "../bus";
import { getSetting, setSetting } from "../db";
import { seal, unseal } from "../vault";
import { CDP_HELPER, CDP_HELPER_PATH } from "./cdp-helper";
import { clickScript, typeScript, loginScript } from "./dom-actions";
import type { ComputerAction } from "./browser";

// Cloud computers: each dot gets its own E2B desktop sandbox (Linux + Chrome + a live stream).
// It sleeps when idle (paused with its memory, so Chrome and logins survive) and resumes on demand,
// The sandbox can run remotely, but the agent loop and scheduler run in this app on the user's PC.

export const CLOUD_SCREEN = { width: 1280, height: 800 };
export const WORKSPACE = "/home/user/workspace";
const IDLE_MS = 10 * 60_000;
const MAX_OUTPUT = 12_000;

// The E2B key comes from E2B_API_KEY (development) or from Settings, sealed with the vault key (the desktop app
// has no .env). The E2B SDK reads process.env, so a saved key is loaded there.
const KEY_SETTING = "e2b_key";
const KEY_FROM_ENV = Boolean(process.env.E2B_API_KEY);

function loadSavedKey() {
  if (KEY_FROM_ENV) return;
  const sealed = getSetting(KEY_SETTING);
  let key: string | null = null;
  try {
    key = sealed ? unseal(sealed) : null;
  } catch {}
  if (key) process.env.E2B_API_KEY = key;
  else delete process.env.E2B_API_KEY;
}

export const cloudEnabled = () => (loadSavedKey(), Boolean(process.env.E2B_API_KEY));

export const cloudKeySource = (): "env" | "settings" | null => (KEY_FROM_ENV ? "env" : getSetting(KEY_SETTING) ? "settings" : null);

/** Check the key with E2B, then save it (encrypted). Empty removes it. Returns an error message or null. */
export async function saveCloudKey(key: string): Promise<string | null> {
  if (KEY_FROM_ENV) return "The E2B key is set by E2B_API_KEY.";
  if (!key) {
    setSetting(KEY_SETTING, null);
    loadSavedKey();
    return null;
  }
  try {
    const res = await fetch("https://api.e2b.dev/sandboxes", { headers: { "X-API-Key": key } });
    if (res.status === 401 || res.status === 403) return "E2B didn't accept that key.";
    if (!res.ok) return `Couldn't check the key with E2B (${res.status}).`;
  } catch (err) {
    return `Couldn't reach E2B: ${err instanceof Error ? err.message : String(err)}`;
  }
  setSetting(KEY_SETTING, seal(key));
  loadSavedKey();
  return null;
}

type Box = { sb: Sandbox; streaming: boolean; lastShot: Buffer | null; touchedAt: number };
const g = globalThis as unknown as { __dotsBoxes?: Map<string, Promise<Box>> };
const boxes = (g.__dotsBoxes ??= new Map());

async function setup(sb: Sandbox) {
  await sb.commands.run(`mkdir -p ${WORKSPACE} /home/user/.dots`);
  await sb.files.write(CDP_HELPER_PATH, CDP_HELPER);
  await ensureChrome(sb);
}

async function ensureChrome(sb: Sandbox) {
  const ready = () => sb.commands.run(`python3 ${CDP_HELPER_PATH} ready`).then(() => true, () => false);
  if (await ready()) return;
  await sb.commands.run(
    "google-chrome --remote-debugging-port=9222 --user-data-dir=/home/user/.config/dots-chrome --no-first-run --no-default-browser-check --start-maximized --disable-features=Translate about:blank",
    { background: true },
  );
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await ready()) return;
  }
  throw new Error("Chrome didn't start on the dot's computer.");
}

async function open(dotId: string): Promise<Box> {
  const saved = repo.getBoxId(dotId);
  let sb: Sandbox | null = null;
  if (saved) sb = await Sandbox.connect(saved).catch(() => null); // resumes a paused box
  if (!sb) {
    sb = await Sandbox.create({
      resolution: [CLOUD_SCREEN.width, CLOUD_SCREEN.height],
      dpi: 96,
      timeoutMs: IDLE_MS,
      lifecycle: { onTimeout: "pause" },
      metadata: { app: "dots", dot: dotId },
    });
    repo.setBoxId(dotId, sb.sandboxId);
  }
  await sb.setTimeout(IDLE_MS);
  await setup(sb);
  return { sb, streaming: false, lastShot: null, touchedAt: Date.now() };
}

/** The dot's cloud computer, created or resumed as needed. */
export async function box(dotId: string): Promise<Box> {
  let b = boxes.get(dotId);
  if (!b) {
    b = open(dotId);
    boxes.set(dotId, b);
    b.catch(() => boxes.delete(dotId));
  }
  const ready = await b;
  // Keep it awake while in use (at most one keep-alive call every 30s).
  if (Date.now() - ready.touchedAt > 30_000) {
    ready.touchedAt = Date.now();
    await ready.sb.setTimeout(IDLE_MS).catch(() => boxes.delete(dotId));
  }
  return ready;
}

// ---------- shell & files ----------

export async function run(dotId: string, command: string): Promise<string> {
  const { sb } = await box(dotId);
  let out: string;
  try {
    const r = await sb.commands.run(command, { cwd: WORKSPACE, timeoutMs: 120_000 });
    out = `${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`.trim();
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; exitCode?: number; message?: string };
    out = `${e.stdout ?? ""}${e.stderr ? `\n[stderr]\n${e.stderr}` : ""}`.trim();
    out += `\n[exit ${e.exitCode ?? "?"}]${e.stdout === undefined ? ` ${e.message ?? ""}` : ""}`;
  }
  if (out.length > MAX_OUTPUT) out = `${out.slice(0, MAX_OUTPUT / 2)}\n…[truncated]…\n${out.slice(-MAX_OUTPUT / 2)}`;
  return out || "(no output)";
}

const abs = (p: string) => (p.startsWith("/") ? p : `${WORKSPACE}/${p.replace(/^\.?\/?(workspace\/)?/, "")}`);

export async function readFile(dotId: string, p: string): Promise<Buffer> {
  const { sb } = await box(dotId);
  return Buffer.from(await sb.files.read(abs(p), { format: "bytes" }));
}

export async function writeFile(dotId: string, p: string, data: string | Buffer): Promise<string> {
  const { sb } = await box(dotId);
  const target = abs(p);
  await sb.files.write(target, typeof data === "string" ? data : new Uint8Array(data).buffer);
  return target;
}

export async function listFiles(dotId: string, dir = WORKSPACE): Promise<{ path: string; size: number; isDir: boolean }[]> {
  const out = await run(dotId, `find ${JSON.stringify(abs(dir))} -maxdepth 3 -not -path '*/.*' -printf '%y %s %p\\n' 2>/dev/null | head -500`);
  return out
    .split("\n")
    .map((l) => l.match(/^([fd]) (\d+) (.+)$/))
    .flatMap((m) => (m && m[3] !== abs(dir) ? [{ path: m[3], size: Number(m[2]), isDir: m[1] === "d" }] : []));
}

// ---------- browser (Chrome in the box, via the CDP helper) ----------

async function helper(dotId: string, args: string): Promise<Record<string, unknown>> {
  const { sb } = await box(dotId);
  await ensureChrome(sb);
  const r = await sb.commands.run(`python3 ${CDP_HELPER_PATH} ${args}`, { timeoutMs: 60_000 });
  return JSON.parse(r.stdout.trim().split("\n").pop() || "{}");
}

export async function openUrl(dotId: string, url: string): Promise<string> {
  const target = /^https?:\/\//.test(url) ? url : `https://${url}`;
  const r = await helper(dotId, `open ${JSON.stringify(target)}`);
  await screenshot(dotId);
  return `Opened ${r.url ?? target} — "${r.title ?? ""}"`;
}

export async function readPage(dotId: string): Promise<string> {
  const r = await helper(dotId, "text");
  const text = String(r.text ?? "").replace(/\n{3,}/g, "\n\n").slice(0, 15_000);
  return `URL: ${r.url ?? ""}\nTitle: ${r.title ?? ""}\n\n${text}`;
}

export async function fillLogin(dotId: string, site: string, username: string, password: string): Promise<string> {
  const r = await runScript(dotId, loginScript(site, username, password));
  if (r.error) return String(r.error);
  await screenshot(dotId);
  const n = Number(r.filled ?? 0);
  if (!n) return "No visible login fields found on this page. Navigate to the sign-in form first.";
  return `Filled ${n === 2 ? "username and password" : "the only login field visible (it may be a multi-step form; continue and call again)"} for ${username}. Submit the form to continue (the password itself is hidden from you).`;
}

async function runScript(dotId: string, code: string): Promise<Record<string, unknown>> {
  const { sb } = await box(dotId);
  const tmp = `/tmp/.dots-${crypto.randomUUID()}.js`;
  await sb.files.write(tmp, code);
  try { return await helper(dotId, `js ${tmp}`); }
  finally { await sb.commands.run(`rm -f ${tmp}`).catch(() => {}); }
}

export async function clickText(dotId: string, text: string): Promise<string> {
  const r = await runScript(dotId, clickScript(text));
  if (!r.ok) return String(r.error ?? "Couldn't click that.");
  await new Promise((res) => setTimeout(res, 800));
  const info = await helper(dotId, "text");
  await screenshot(dotId);
  return `Clicked "${String(r.label || text)}". Now on ${info.url ?? ""} — "${info.title ?? ""}". Read the page to see what changed.`;
}

export async function typeText(dotId: string, field: string, value: string, submit: boolean): Promise<string> {
  const r = await runScript(dotId, typeScript(field, value, submit));
  if (!r.ok) return String(r.error ?? "Couldn't find that field.");
  await screenshot(dotId);
  return submit ? `Typed into "${field}" and submitted.` : `Typed into "${field}".`;
}

// ---------- screen (OpenAI computer-use actions) ----------

export async function screenshot(dotId: string): Promise<Buffer> {
  const b = await box(dotId);
  const shot = Buffer.from(await b.sb.screenshot());
  b.lastShot = shot;
  emit({ type: "screen", dotId, at: Date.now() });
  return shot;
}

export async function lastScreenshot(dotId: string): Promise<Buffer | null> {
  const b = boxes.get(dotId);
  return b ? (await b.catch(() => null))?.lastShot ?? null : null;
}

const KEY: Record<string, string> = {
  ENTER: "enter", RETURN: "enter", ESC: "escape", ESCAPE: "escape", TAB: "tab", SPACE: "space", BACKSPACE: "backspace",
  DELETE: "delete", UP: "up", DOWN: "down", LEFT: "left", RIGHT: "right", ARROWUP: "up", ARROWDOWN: "down",
  ARROWLEFT: "left", ARROWRIGHT: "right", CTRL: "ctrl", CONTROL: "ctrl", CMD: "ctrl", META: "ctrl", SUPER: "super",
  ALT: "alt", OPTION: "alt", SHIFT: "shift", PAGEUP: "page_up", PAGEDOWN: "page_down", HOME: "home", END: "end",
};
const key = (k: string) => KEY[k.toUpperCase()] ?? k.toLowerCase();

export async function doAction(dotId: string, action: ComputerAction): Promise<void> {
  const { sb } = await box(dotId);
  switch (action.type) {
    case "click":
      if (action.button === "right") await sb.rightClick(action.x, action.y);
      else if (action.button === "wheel") await sb.middleClick(action.x, action.y);
      else if (action.button === "back") await sb.press(["alt", "left"]);
      else if (action.button === "forward") await sb.press(["alt", "right"]);
      else await sb.leftClick(action.x, action.y);
      break;
    case "double_click":
      await sb.doubleClick(action.x, action.y);
      break;
    case "drag": {
      const [first, ...rest] = action.path;
      if (!first) break;
      await sb.moveMouse(first.x, first.y);
      await sb.mousePress("left");
      for (const p of rest) await sb.moveMouse(p.x, p.y);
      await sb.mouseRelease("left");
      break;
    }
    case "keypress":
      await sb.press(action.keys.length === 1 ? key(action.keys[0]) : action.keys.map(key));
      break;
    case "move":
      await sb.moveMouse(action.x, action.y);
      break;
    case "scroll":
      await sb.moveMouse(action.x, action.y);
      if (action.scroll_y) await sb.scroll(action.scroll_y < 0 ? "up" : "down", Math.max(1, Math.round(Math.abs(action.scroll_y) / 100)));
      break;
    case "type":
      await sb.write(action.text, { chunkSize: 50, delayInMs: 15 });
      break;
    case "wait":
      await sb.wait(1500);
      break;
    case "screenshot":
      break;
  }
  if (action.type !== "wait" && action.type !== "screenshot") await sb.wait(350);
}

// ---------- live view ----------

/** A noVNC URL for the dot's desktop: view-only for watching, interactive for taking over. */
export async function liveUrl(dotId: string, interactive: boolean): Promise<string> {
  const b = await box(dotId);
  if (!b.streaming) {
    await b.sb.stream.start({ requireAuth: true }).catch((err: unknown) => {
      if (!/already/i.test(String(err))) throw err;
    });
    b.streaming = true;
  }
  return b.sb.stream.getUrl({ authKey: b.sb.stream.getAuthKey(), autoConnect: true, viewOnly: !interactive, resize: "scale" });
}

// ---------- lifecycle ----------

/** Put the box to sleep now (e.g. the dot was paused). It resumes on next use. */
export async function sleep(dotId: string) {
  const b = boxes.get(dotId);
  boxes.delete(dotId);
  const id = repo.getBoxId(dotId);
  if (b) await (await b.catch(() => null))?.sb.pause().catch(() => {});
  else if (id) await Sandbox.pause(id).catch(() => {});
}

/** Throw the box away (fresh computer next time, or the dot was deleted). */
export async function destroy(dotId: string) {
  const id = repo.getBoxId(dotId);
  boxes.delete(dotId);
  repo.setBoxId(dotId, null);
  if (id) await Sandbox.kill(id).catch(() => {});
}

export function hasBox(dotId: string): boolean {
  return Boolean(repo.getBoxId(dotId));
}
