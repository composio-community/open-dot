import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import crypto from "node:crypto";

const root = path.resolve(import.meta.dirname, "..");
const notices = path.join(root, ".desktop/notices");
const cached = path.join(root, "scripts/licenses/packages");
const provenance = JSON.parse(fs.readFileSync(path.join(cached, "PROVENANCE.json"), "utf8"));
if (fs.existsSync(notices) && fs.lstatSync(notices).isSymbolicLink()) throw new Error("Notices directory must not be a link");
fs.rmSync(notices, { recursive: true, force: true });
fs.mkdirSync(notices, { recursive: true });
const seen = new Set();
const packages = [];
const missing = new Set();
function visit(name, from) {
  const require = createRequire(path.join(from, "package.json"));
  const parent = JSON.parse(fs.readFileSync(path.join(from, "package.json"), "utf8"));
  const spec = { ...parent.dependencies, ...parent.optionalDependencies, ...parent.peerDependencies }[name];
  const actualName = typeof spec === "string" && spec.startsWith("npm:") ? spec.slice(4).replace(/@[^@]*$/, "") : name;
  let dir;
  try { dir = path.dirname(fs.realpathSync(require.resolve(`${name}/package.json`))); }
  catch {
    try {
      dir = path.dirname(fs.realpathSync(require.resolve(name)));
      while (dir !== path.dirname(dir)) {
        const manifest = path.join(dir, "package.json");
        if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, "utf8")).name === actualName) break;
        dir = path.dirname(dir);
      }
    } catch { missing.add(name); return; }
  }
  // Some export maps resolve package.json to a nested module-format marker.
  while (dir !== path.dirname(dir)) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, "utf8")).name === actualName) break;
    dir = path.dirname(dir);
  }
  if (!fs.existsSync(path.join(dir, "package.json"))) { missing.add(name); return; }
  if (seen.has(dir)) return;
  seen.add(dir);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  if (pkg.name !== actualName) throw new Error(`Could not locate notices for ${name}`);
  const texts = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && /^(licen[cs]e|notice|copying)([._-]|$)/i.test(e.name)).map(e => e.name);
  const folder = encodeURIComponent(`${pkg.name}@${pkg.version}`);
  if (texts.length) {
    fs.mkdirSync(path.join(notices, folder));
    for (const file of texts) fs.copyFileSync(path.join(dir, file), path.join(notices, folder, file));
  }
  const supplemental = provenance[`${pkg.name}@${pkg.version}`];
  if (supplemental) for (const text of supplemental.texts) {
    if (path.basename(text.file) !== text.file) throw new Error("Invalid cached notice filename");
    const data = fs.readFileSync(path.join(cached, folder, text.file));
    if (crypto.createHash("sha256").update(data).digest("hex") !== text.sha256) throw new Error(`Cached notice hash mismatch: ${pkg.name}/${text.file}`);
    fs.mkdirSync(path.join(notices, folder), { recursive: true });
    fs.writeFileSync(path.join(notices, folder, text.file), data);
    if (!texts.includes(text.file)) texts.push(text.file);
  }
  packages.push({ name: pkg.name, version: pkg.version, license: pkg.license ?? null, texts: texts.map(f => `${folder}/${f}`), homepage: pkg.homepage ?? null });
  for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })) visit(dependency, dir);
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
for (const dependency of Object.keys(manifest.dependencies)) visit(dependency, root);
packages.sort((a, b) => a.name.localeCompare(b.name));
fs.writeFileSync(path.join(notices, "packages.json"), JSON.stringify({ packages, unresolvedOptionalOrPeerPackages: [...missing].sort() }, null, 2));
fs.copyFileSync(path.join(cached, "PROVENANCE.json"), path.join(notices, "PROVENANCE.json"));
fs.writeFileSync(path.join(notices, "README.txt"), "Third-party notices for installed production dependencies and peers. Full available license/notice texts are preserved in the accompanying folders. PROVENANCE.json records pinned supplemental sources and hashes. This inventory does not grant a license to Open Dot itself. Electron notices are at the application root; bundled Chromium credits are in Chromium-Credits.html. The upstream redistribution permission remains a separate release requirement.\n");
fs.copyFileSync(path.join(root, "scripts/licenses/Geist-OFL.txt"), path.join(notices, "Geist-OFL.txt"));
fs.copyFileSync(path.join(root, "scripts/licenses/JetBrainsMono-OFL.txt"), path.join(notices, "JetBrainsMono-OFL.txt"));

if (process.platform === "win32") {
  // Preserve the credits from the exact Chromium build that ships, without remote requests.
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(root, ".desktop/browser");
  const { chromium } = await import("playwright");
  const revision = fs.readdirSync(process.env.PLAYWRIGHT_BROWSERS_PATH).find(name => /^chromium-\d+$/.test(name));
  if (!revision) throw new Error("Bundled Chromium is missing");
  const browser = await chromium.launch({ headless: true, executablePath: path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, revision, "chrome-win64/chrome.exe") });
  try {
    const page = await browser.newPage();
    await page.goto("chrome://credits/");
    const credits = await page.content();
    if (!credits.includes("Chromium") || !credits.includes("license")) throw new Error("Chromium credits were not rendered");
    fs.writeFileSync(path.join(notices, "Chromium-Credits.html"), credits);
  } finally { await browser.close(); }
}
console.log(`preserved third-party notices for ${packages.length} installed packages`);
