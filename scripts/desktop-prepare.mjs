// Finish .next/standalone for the desktop app: copy the static assets the minimal server serves,
// and the full Playwright packages (tracing only picks up the files it can see being required).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
fs.copyFileSync(path.join(root, "build/icon.png"), path.join(root, "electron/icon.png"));
// Ship the pinned browser, so a clean Windows PC needs neither Chrome nor Node installed.
if (process.platform === "win32") {
  execFileSync(process.execPath, [path.join(root, "node_modules/playwright/cli.js"), "install", "chromium", "--no-shell"], {
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(root, ".desktop/browser") }, stdio: "inherit", windowsHide: true,
  });
  const browsers = path.join(root, ".desktop/browser");
  for (const entry of fs.readdirSync(browsers)) {
    if (!/^chromium_headless_shell-\d+$/.test(entry)) continue;
    const shell = path.resolve(browsers, entry);
    if (path.dirname(shell) !== browsers || fs.lstatSync(shell).isSymbolicLink()) throw new Error("Unexpected unused browser cleanup target");
    fs.rmSync(shell, { recursive: true, force: true });
  }
}
const out = path.join(root, ".next/standalone");
if (!fs.existsSync(path.join(out, "server.js"))) throw new Error("Run `next build` first (output: standalone).");

fs.cpSync(path.join(root, "public"), path.join(out, "public"), { recursive: true });
fs.cpSync(path.join(root, ".next/static"), path.join(out, ".next/static"), { recursive: true });

const require = createRequire(path.join(root, "package.json"));
const playwrightDir = path.dirname(fs.realpathSync(require.resolve("playwright/package.json")));
const coreDir = path.dirname(createRequire(path.join(playwrightDir, "package.json")).resolve("playwright-core/package.json"));
for (const dir of [playwrightDir, fs.realpathSync(coreDir)]) {
  const dest = path.join(out, path.relative(root, dir));
  fs.cpSync(dir, dest, { recursive: true, dereference: true });
  console.log("copied", path.relative(root, dir));
}

// Tracing also misses Next's own prebuilt server runtimes (e.g. the one API routes load).
const nextDir = fs.realpathSync(path.dirname(require.resolve("next/package.json")));
fs.cpSync(path.join(nextDir, "dist/compiled/next-server"), path.join(out, path.relative(root, nextDir), "dist/compiled/next-server"), {
  recursive: true,
  filter: (src) => fs.statSync(src).isDirectory() || /\.prod\.js$/.test(src), // production builds only
});
console.log("copied next/dist/compiled/next-server (production runtimes)");

// Playwright mentions electron, so tracing drags it in; the app already runs inside Electron.
const pnpmDir = path.join(out, "node_modules/.pnpm");
for (const d of fs.existsSync(pnpmDir) ? fs.readdirSync(pnpmDir) : []) if (/^electron(-builder)?@/.test(d)) fs.rmSync(path.join(pnpmDir, d), { recursive: true, force: true });
fs.rmSync(path.join(out, "node_modules/electron"), { recursive: true, force: true });

// Keep only what the server runs. Tracing also copies stray project files (source .ts, earlier desktop builds,
// local data); none of it is needed, and some of it must never ship.
const KEEP = new Set([".next", "node_modules", "public", "server.js", "package.json"]);
for (const entry of fs.readdirSync(out)) if (!KEEP.has(entry)) fs.rmSync(path.join(out, entry), { recursive: true, force: true });
// The packaged app gets its own copy. pnpm's symlinks stay (Node resolves packages through them), but every one
// must be relative and stay inside the folder, or code signing rejects the app.
const app = path.join(root, ".desktop/server");
fs.rmSync(app, { recursive: true, force: true });
fs.mkdirSync(path.dirname(app), { recursive: true });
fs.cpSync(out, app, { recursive: true, dereference: process.platform === "win32", verbatimSymlinks: process.platform !== "win32" });
if (process.platform === "win32") {
  // A materialized top-level pnpm link loses its sibling dependency lookup. Hoist the traced packages
  // into a normal, relocatable node_modules tree; ZIP extraction must not require creating junctions.
  const modules = path.join(app, "node_modules");
  const pnpm = path.join(modules, ".pnpm");
  // ponytail: traced packages are single-version here; preserve nested trees if a future lockfile has conflicts.
  const versions = new Map();
  const hoist = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const from = path.join(dir, entry.name);
      if (entry.name.startsWith("@")) { hoist(from); continue; }
      const manifest = path.join(from, "package.json");
      if (!fs.existsSync(manifest)) continue;
      const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (versions.has(pkg.name) && versions.get(pkg.name) !== pkg.version) {
        throw new Error(`Multiple traced versions of ${pkg.name}; preserve its nested dependencies before shipping.`);
      }
      versions.set(pkg.name, pkg.version);
      fs.cpSync(from, path.join(modules, pkg.name), { recursive: true, dereference: true });
    }
  };
  for (const entry of fs.readdirSync(pnpm)) {
    const dir = path.join(pnpm, entry, "node_modules");
    if (fs.existsSync(dir)) hoist(dir);
  }
  fs.rmSync(pnpm, { recursive: true, force: true });
  console.log(`hoisted ${versions.size} traced runtime packages for Windows`);
}
const links = fs.readdirSync(app, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isSymbolicLink()).map((entry) => path.join(entry.parentPath, entry.name));
const escaping = links.filter((l) => {
  const target = fs.readlinkSync(l);
  return path.isAbsolute(target) || !path.resolve(path.dirname(l), target).startsWith(app + path.sep) || !fs.existsSync(l);
});
if (escaping.length) throw new Error(`Symlinks that leave the desktop server (or are broken):\n${escaping.join("\n")}`);
console.log("desktop server ready:", path.relative(root, app));
await import("./desktop-notices.mjs");
