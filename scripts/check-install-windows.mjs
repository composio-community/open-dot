import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { _electron } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const temp = fs.mkdtempSync(path.join(root, ".windows-check-install-"));
const destination = path.join(temp, "install café 数据");
const profile = path.join(temp, "synthetic-profile");
fs.mkdirSync(profile, { recursive: true });
const installer = path.join(root, "dist/Open Dot Setup 0.1.0.exe");
const exe = path.join(destination, "Open Dot.exe");
const uninstaller = path.join(destination, "Uninstall Open Dot.exe");
const env = { ...process.env, OPEN_DOT_USER_DATA_DIR: profile, DOTS_COMPUTER: "local", OPENAI_API_KEY: "", OPENROUTER_API_KEY: "", COMPOSIO_API_KEY: "", E2B_API_KEY: "" };
delete env.ELECTRON_RUN_AS_NODE;
const installed = () => JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $entries=@(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Open Dot*' } | Select-Object DisplayName,UninstallString); $shell=New-Object -ComObject Shell.Application; $links=@((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Open Dot.lnk'), (Join-Path ([Environment]::GetFolderPath('Programs')) 'Open Dot.lnk')) | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object { $item=$shell.NameSpace([IO.Path]::GetDirectoryName($_)).ParseName([IO.Path]::GetFileName($_)); [pscustomobject]@{path=$_; target=$(if($item){$item.ExtendedProperty('System.Link.TargetParsingPath')}else{$null})} }; ConvertTo-Json -InputObject @{entries=$entries; shortcuts=@($links)} -Compress"], { windowsHide: true, encoding: "utf8" }));
const run = (file, args) => {
  const result = spawnSync(file, args, { env, windowsHide: true, timeout: 300_000, encoding: "utf8" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${path.basename(file)} failed: ${result.stderr}`);
};
const digest = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
// NSIS starts a temporary uninstaller process; the launcher can exit before cleanup finishes.
const waitForUninstall = async () => {
  const deadline = Date.now() + 30_000;
  let state;
  do {
    state = installed();
    if (!fs.existsSync(exe) && state.entries.length === 0 && state.shortcuts.length === 0) return state;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  throw new Error(`NSIS cleanup did not finish: ${JSON.stringify(state)}`);
};
let app, didInstall = false;
try {
  const before = installed();
  assert.deepEqual(before.entries, [], "Preserve existing Open Dot installations; run this check in a clean Windows account or VM");
  assert.deepEqual(before.shortcuts, [], "Preserve existing Open Dot shortcuts; use a separate Windows account");
  didInstall = true;
  run(installer, ["/S", `/D=${destination}`]);
  assert(fs.existsSync(exe));
  assert(fs.existsSync(uninstaller));
  assert.equal(digest(exe), digest(path.join(root, "dist/win-unpacked/Open Dot.exe")));
  const registration = installed();
  assert.equal(registration.entries.length, 1, "Recognize the versioned Open Dot registry DisplayName");
  assert.equal(registration.shortcuts.length, 2);
  for (const link of registration.shortcuts) assert.equal(path.resolve(link.target).toLowerCase(), exe.toLowerCase(), "Shortcut must target the actual Unicode install path");
  const notices = path.join(destination, "resources/notices");
  const provenance = JSON.parse(fs.readFileSync(path.join(root, "scripts/licenses/packages/PROVENANCE.json"), "utf8"));
  assert.equal(digest(path.join(notices, "PROVENANCE.json")), digest(path.join(root, "scripts/licenses/packages/PROVENANCE.json")));
  for (const [key, entry] of Object.entries(provenance)) for (const text of entry.texts) {
    assert.equal(digest(path.join(notices, encodeURIComponent(key), text.file)), text.sha256, key);
  }
  console.log("PASS: silent install and installed executable identity");
  console.log("PASS: versioned registration and Unicode shortcut targets");
  console.log("PASS: installed supplemental license/notice texts and provenance");
  app = await _electron.launch({ executablePath: exe, env, timeout: 60_000 });
  let page = await app.firstWindow();
  await page.waitForURL("http://localhost:3100/**", { timeout: 60_000 });
  await page.goto("http://localhost:3100/new");
  await page.getByPlaceholder("Pixel", { exact: true }).fill("Installer fixture");
  await page.getByPlaceholder("What should it help with?").fill("Synthetic upgrade persistence; no API calls");
  await page.getByRole("button", { name: "Create Installer fixture", exact: true }).click();
  await page.waitForURL(/\/dots\/dot_/);
  const dotId = new URL(page.url()).pathname.split("/").pop();
  await app.close(); app = null;
  console.log("PASS: installed app created synthetic dot and quit");
  run(installer, ["/S", `/D=${destination}`]);
  console.log("PASS: same-version silent reinstall");
  assert.equal(digest(exe), digest(path.join(root, "dist/win-unpacked/Open Dot.exe")));
  app = await _electron.launch({ executablePath: exe, env, timeout: 60_000 });
  page = await app.firstWindow();
  await page.waitForURL("http://localhost:3100/**", { timeout: 60_000 });
  await page.goto(`http://localhost:3100/dots/${dotId}`);
  await page.getByRole("heading", { name: "Hi, I'm Installer fixture", exact: true }).waitFor();
  await app.close(); app = null;
  console.log("PASS: synthetic dot persists after reinstall");
  run(uninstaller, ["/S"]);
  const after = await waitForUninstall();
  assert(!fs.existsSync(exe));
  assert(fs.existsSync(path.join(profile, "data/dots.db")), "Uninstall must preserve the external synthetic profile");
  assert.deepEqual(after.entries, []);
  assert.deepEqual(after.shortcuts, []);
  didInstall = false;
  const evidence = path.join(root, ".windows-check-output/evidence");
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, "installer-acceptance.json"), JSON.stringify({ checks: ["silent install into isolated spaces/Unicode directory", "installed executable hash matches packaged executable", "installed supplemental license/notice texts match pinned provenance hashes", "installed app launches", "same-version reinstall retains external synthetic profile and dot", "silent uninstall removes application, registration and created shortcuts", "external synthetic profile remains"], installerSha256: digest(installer), before, after }, null, 2));
  console.log("PASS: isolated NSIS install, installed launch, reinstall persistence, uninstall, registry and shortcut cleanup");
} finally {
  await app?.close().catch(() => {});
  if (didInstall && fs.existsSync(uninstaller)) {
    run(uninstaller, ["/S"]);
    await waitForUninstall();
  }
  if (didInstall && (installed().entries.length || installed().shortcuts.length)) throw new Error(`Retained incomplete install fixture for cleanup: ${temp}`);
  if (path.dirname(temp) !== root || fs.lstatSync(temp).isSymbolicLink()) throw new Error("Unexpected installer cleanup target");
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
