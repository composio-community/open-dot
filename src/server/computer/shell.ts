import "server-only";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DATA_DIR } from "../db";

export const BOX_IMAGE = process.env.DOTS_BOX_IMAGE || "node:22-bookworm";
const MAX_OUTPUT = 12_000;

let dockerChecked: { ok: boolean; at: number } | null = null;

export function dockerAvailable(): boolean {
  if (dockerChecked && Date.now() - dockerChecked.at < 30_000) return dockerChecked.ok;
  const r = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 5000, windowsHide: true });
  dockerChecked = { ok: r.status === 0, at: Date.now() };
  return dockerChecked.ok;
}

export function workspaceDir(dotId: string): string {
  if (!/^[a-z0-9_-]+$/i.test(dotId)) throw new Error("Invalid dot ID");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let dir = DATA_DIR;
  for (const part of ["dots", dotId, "workspace"]) {
    dir = path.join(/* turbopackIgnore: true */ dir, part);
    try { if (fs.lstatSync(/* turbopackIgnore: true */ dir).isSymbolicLink()) throw new Error("Path must stay inside /workspace"); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    fs.mkdirSync(/* turbopackIgnore: true */ dir, { recursive: true });
  }
  return dir;
}

const containerName = (dotId: string) => `dot-${dotId.replace(/[^a-z0-9_]/gi, "")}`;

function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs: number; signal?: AbortSignal }): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 8 * 1024 * 1024, signal: opts.signal }, (err, stdout, stderr) => {
      let out = `${stdout ?? ""}${stderr ? `\n[stderr]\n${stderr}` : ""}`.trim();
      if (err && "code" in err && err.code !== undefined) out += `\n[exit ${String(err.code)}]`;
      if (err && err.name === "AbortError") out += "\n[stopped]";
      if (err && "killed" in err && err.killed) out += "\n[timed out]";
      if (out.length > MAX_OUTPUT) out = `${out.slice(0, MAX_OUTPUT / 2)}\n…[truncated]…\n${out.slice(-MAX_OUTPUT / 2)}`;
      resolve(out || "(no output)");
    });
  });
}

async function ensureContainer(dotId: string): Promise<void> {
  const name = containerName(dotId);
  const state = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", name]);
  if (state.status === 0 && state.stdout.toString().trim() === "true") return;
  if (state.status === 0) {
    spawnSync("docker", ["start", name]);
    return;
  }
  await run("docker", [
    "run", "-d", "--name", name, "--hostname", "dot", "--memory", "2g", "--cpus", "2",
    "-v", `${workspaceDir(dotId)}:/workspace`, "-w", "/workspace", BOX_IMAGE, "sleep", "infinity",
  ], { timeoutMs: 180_000 });
}

/** Run a shell command on the dot's own computer (its container, or its sandbox folder as a fallback). */
export async function runOnDotComputer(dotId: string, command: string, signal?: AbortSignal, mode: "local" | "docker" = "local"): Promise<string> {
  if (mode === "docker") {
    if (!dockerAvailable()) throw new Error("Docker is unavailable. Local execution requires a new approval.");
    await ensureContainer(dotId);
    return run("docker", ["exec", "-w", "/workspace", containerName(dotId), "bash", "-lc", command], { timeoutMs: 120_000, signal });
  }
  return runLocal(command, workspaceDir(dotId), signal);
}

/** Run a command on the user's own machine (the computer running this app). Always gated by approvals. */
export async function runOnUserComputer(command: string, signal?: AbortSignal): Promise<string> {
  return runLocal(command, os.homedir(), signal);
}

function runLocal(command: string, cwd: string, signal?: AbortSignal) {
  return process.platform === "win32"
    ? run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], { cwd, timeoutMs: 120_000, signal })
    : run("bash", ["-lc", command], { cwd, timeoutMs: 120_000, signal });
}

export function resolveWorkspacePath(dotId: string, p: string): string {
  const root = workspaceDir(dotId);
  if (p.includes("\0") || (process.platform === "win32" && /[:]/.test(p))) throw new Error("Path must stay inside /workspace");
  const rel = p.replace(/^[/\\]?workspace(?:[/\\]|$)/, "");
  const full = path.resolve(root, rel);
  const relative = path.relative(root, full);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Path must stay inside /workspace");
  // Check the nearest existing ancestor too: a junction/symlink must not escape the workspace.
  const realRoot = fs.realpathSync(/* turbopackIgnore: true */ root);
  let existing = full;
  while (!fs.existsSync(/* turbopackIgnore: true */ existing)) {
    // A dangling symlink must be rejected instead of following its outside target on a later write.
    try { if (fs.lstatSync(/* turbopackIgnore: true */ existing).isSymbolicLink()) throw new Error("Path must stay inside /workspace"); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    if (existing === root) break;
    existing = path.dirname(existing);
  }
  const realRelative = path.relative(realRoot, fs.realpathSync(/* turbopackIgnore: true */ existing));
  if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) throw new Error("Path must stay inside /workspace");
  return full;
}

export function resetDotComputer(dotId: string) {
  if (dockerAvailable()) spawnSync("docker", ["rm", "-f", containerName(dotId)]);
}
