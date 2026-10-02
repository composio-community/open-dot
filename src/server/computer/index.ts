import "server-only";
import fs from "node:fs";
import path from "node:path";
import * as repo from "../repo";
import * as cloud from "./cloud";
import * as browser from "./browser";
import { BOX_IMAGE, dockerAvailable, resetDotComputer, resolveWorkspacePath, runOnDotComputer, workspaceDir } from "./shell";
import type { ComputerAction } from "./browser";

// One interface for "the dot's computer", whichever kind it is:
//   cloud  — an E2B desktop sandbox per dot (Linux + Chrome + live stream); the agent still runs locally
//   docker — a local container for the shell, a local Chromium for the browser
//   local  — a workspace folder on this computer (commands ask first) and a local Chromium
// DOTS_COMPUTER=cloud|docker|local forces a mode; otherwise cloud when E2B_API_KEY is set, then docker, then local.

export type ComputerMode = "cloud" | "docker" | "local";
export const SCREEN = { width: 1280, height: 800 };

export function defaultMode(): ComputerMode {
  const pref = process.env.DOTS_COMPUTER;
  if (pref === "cloud" && cloud.cloudEnabled()) return "cloud";
  if (pref === "docker" || pref === "local") return pref === "docker" && dockerAvailable() ? "docker" : "local";
  if (cloud.cloudEnabled()) return "cloud";
  return dockerAvailable() ? "docker" : "local";
}

export function modeFor(dotId: string): ComputerMode {
  // A dot that already has a cloud computer keeps using it.
  if (cloud.cloudEnabled() && cloud.hasBox(dotId)) return "cloud";
  return defaultMode();
}

const isCloud = (dotId: string) => modeFor(dotId) === "cloud";

export function describe(dotId: string): string {
  switch (modeFor(dotId)) {
    case "cloud":
      return `a cloud Linux desktop (1280×800) with Google Chrome and a persistent ${cloud.WORKSPACE}; use Bash. The agent and scheduler require this app's PC to stay awake`;
    case "docker":
      return `a Linux container (${BOX_IMAGE}) with a persistent /workspace, plus a Chromium browser`;
    default:
      return `a workspace folder on the user's ${process.platform === "win32" ? "Windows PC; use Windows PowerShell commands" : "computer; use Bash commands"} (commands ask first; this is not an OS sandbox), plus a Chromium browser`;
  }
}

// ---------- shell & files ----------

export async function runCommand(dotId: string, command: string, signal?: AbortSignal): Promise<string> {
  const mode = modeFor(dotId);
  return mode === "cloud" ? cloud.run(dotId, command) : runOnDotComputer(dotId, command, signal, mode);
}

export async function readFile(dotId: string, p: string): Promise<Buffer> {
  if (isCloud(dotId)) return cloud.readFile(dotId, p);
  return fs.promises.readFile(resolveWorkspacePath(dotId, p));
}

export async function writeFile(dotId: string, p: string, data: string | Buffer): Promise<string> {
  if (isCloud(dotId)) return cloud.writeFile(dotId, p, data);
  const full = resolveWorkspacePath(dotId, p);
  await fs.promises.mkdir(path.dirname(full), { recursive: true });
  await fs.promises.writeFile(full, data);
  return `/workspace/${path.relative(workspaceDir(dotId), full).split(path.sep).join("/")}`;
}

export type FileEntry = { path: string; size: number; isDir: boolean };

export async function listFiles(dotId: string): Promise<FileEntry[]> {
  if (isCloud(dotId)) {
    return (await cloud.listFiles(dotId)).map((f) => ({ ...f, path: f.path.replace(`${cloud.WORKSPACE}/`, "") }));
  }
  const root = workspaceDir(dotId);
  const out: FileEntry[] = [];
  const walk = async (dir: string, depth: number) => {
    for (const e of await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith(".") || out.length >= 500) continue;
      const full = path.join(dir, e.name);
      try { resolveWorkspacePath(dotId, path.relative(root, full)); } catch { continue; }
      const stat = await fs.promises.stat(full).catch(() => null);
      if (!stat) continue;
      out.push({ path: path.relative(root, full), size: stat.size, isDir: e.isDirectory() });
      if (e.isDirectory() && depth < 3) await walk(full, depth + 1);
    }
  };
  await walk(root, 1);
  return out;
}

// ---------- browser & screen ----------

export const openUrl = (dotId: string, url: string) => (isCloud(dotId) ? cloud.openUrl(dotId, url) : browser.openUrl(dotId, url));
export const readPage = (dotId: string) => (isCloud(dotId) ? cloud.readPage(dotId) : browser.readPage(dotId));
export const fillLogin = (dotId: string, site: string, u: string, p: string) => (isCloud(dotId) ? cloud.fillLogin(dotId, site, u, p) : browser.fillLogin(dotId, site, u, p));
export const clickText = (dotId: string, text: string) => (isCloud(dotId) ? cloud.clickText(dotId, text) : browser.clickText(dotId, text));
export const typeText = (dotId: string, field: string, value: string, submit: boolean) =>
  isCloud(dotId) ? cloud.typeText(dotId, field, value, submit) : browser.typeText(dotId, field, value, submit);
export const doAction = (dotId: string, a: ComputerAction) => (isCloud(dotId) ? cloud.doAction(dotId, a) : browser.doAction(dotId, a));
export const screenshot = (dotId: string) => (isCloud(dotId) ? cloud.screenshot(dotId) : browser.screenshot(dotId));
export const lastScreenshot = (dotId: string) => (isCloud(dotId) ? cloud.lastScreenshot(dotId) : browser.lastScreenshot(dotId));

/** Live desktop stream (cloud only). */
export async function liveUrl(dotId: string, interactive: boolean): Promise<string | null> {
  return isCloud(dotId) ? cloud.liveUrl(dotId, interactive) : null;
}

/** Let the user drive. Cloud: an interactive stream URL. Local: the Computer tab streams the browser (see /stream, /input). */
export async function takeOver(dotId: string): Promise<string | null> {
  if (isCloud(dotId)) return cloud.liveUrl(dotId, true);
  await browser.wake(dotId);
  return null;
}

/** Start the dot's computer so the Computer tab can show it live (the cloud computer wakes via its live URL). */
export async function wake(dotId: string) {
  if (!isCloud(dotId)) await browser.wake(dotId);
}

export async function handBack(dotId: string) {
  if (!isCloud(dotId)) await browser.handBack(dotId);
}

export { saveCloudKey } from "./cloud";

// Live view of the local browser (the cloud computer has its own noVNC stream).
export const streamScreen = browser.stream;
export const userInput = browser.input;
export type { UserInput } from "./browser";

// ---------- lifecycle ----------

/** The dot was paused: let its computer sleep (cloud boxes pause with memory, so nothing is lost). */
export async function sleep(dotId: string) {
  if (isCloud(dotId)) await cloud.sleep(dotId);
}

/** Fresh computer: installed software is dropped. Cloud boxes are replaced entirely. */
export async function reset(dotId: string) {
  if (isCloud(dotId)) return cloud.destroy(dotId);
  await browser.closeBrowser(dotId);
  resetDotComputer(dotId);
}

/** The dot was deleted. */
export async function destroy(dotId: string) {
  await cloud.destroy(dotId).catch(() => {});
  resetDotComputer(dotId);
  await browser.deleteData(dotId).catch(() => {});
  repo.setBoxId(dotId, null);
}
