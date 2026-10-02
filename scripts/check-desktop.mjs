import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execFileSync, spawnSync } from "node:child_process";
import { _electron } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const evidence = path.join(root, ".windows-check-output/evidence");
fs.mkdirSync(evidence, { recursive: true });
const profile = fs.mkdtempSync(path.join(root, ".windows-check-desktop-cafe-"));
fs.mkdirSync(profile, { recursive: true });
const packaged = process.argv.includes("--packaged");
const env = { ...process.env, OPEN_DOT_USER_DATA_DIR: profile, DOTS_COMPUTER: "local", OPENAI_API_KEY: "", OPENROUTER_API_KEY: "", COMPOSIO_API_KEY: "", E2B_API_KEY: "" };
delete env.ELECTRON_RUN_AS_NODE;
const exeIndex = process.argv.indexOf("--exe");
const options = packaged || exeIndex >= 0 ? { executablePath: exeIndex >= 0 ? process.argv[exeIndex + 1] : path.join(root, "dist/win-unpacked/Open Dot.exe"), args: [] } : { args: [path.join(root, "electron")] };
const tree = (pid) => JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$all = Get-CimInstance Win32_Process; $byId = @{}; foreach ($p in $all) { $byId[$p.ProcessId] = $p }; if (!$byId.ContainsKey([uint32]${pid})) { ConvertTo-Json -InputObject @() -Compress; exit }; $owned = @(${pid}); do { $previous = $owned.Count; $owned += @($all | Where-Object { $_.ParentProcessId -in $owned -and $_.ProcessId -notin $owned -and $_.CreationDate -ge $byId[$_.ParentProcessId].CreationDate } | Select-Object -ExpandProperty ProcessId) } while ($owned.Count -gt $previous); ConvertTo-Json -InputObject @($owned | ForEach-Object { $p = Get-Process -Id $_ -ErrorAction SilentlyContinue; if ($p) { [pscustomobject]@{ pid=$p.Id; createdUtc=$byId[[uint32]$p.Id].CreationDate.ToUniversalTime().ToString('o'); cpuSeconds=$p.CPU; workingSet=$p.WorkingSet64 } } }) -Compress`], { windowsHide: true, encoding: "utf8" }).trim());

let remoteClicked = false;
let remoteTyped = "";
let remoteWheel = null;
let remoteSpecialKey = "";
const fixture = http.createServer((req, res) => {
  const u = new URL(req.url, "http://fixture.test");
  if (u.pathname === "/clicked") { remoteClicked = true; res.end("ok"); return; }
  if (u.pathname === "/typed") { remoteTyped = u.searchParams.get("value"); res.end("ok"); return; }
  if (u.pathname === "/wheeled") { remoteWheel = { dy: Number(u.searchParams.get("dy")) }; res.end("ok"); return; }
  if (u.pathname === "/special") { remoteSpecialKey = u.searchParams.get("key"); res.end("ok"); return; }
  res.end('<html><title>Harmless fixture</title><body onwheel="fetch(\'/wheeled?dy=\'+event.deltaY)"><h1 id="heading">Windows browser test</h1><input aria-label="Test input" style="position:absolute;left:100px;top:160px;width:180px;height:40px" oninput="fetch(\'/typed?value=\'+encodeURIComponent(this.value))" onkeydown="if(event.key===\'Backspace\'||event.key===\'Enter\')fetch(\'/special?key=\'+encodeURIComponent(event.key))"><button style="position:absolute;left:100px;top:100px;width:120px;height:40px" onclick="document.getElementById(\'heading\').textContent=\'Clicked\';fetch(\'/clicked\')">Test button</button></body></html>');
});
await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}`;

let app;
try {
  app = await _electron.launch({ ...options, env, timeout: 60_000 });
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", err => errors.push(err.message));
  page.on("response", r => { if (r.url().includes("/stream?")) console.log("Live response", r.status(), r.headers()["content-type"], r.headers()["content-encoding"] ?? "uncompressed"); });
  await page.waitForURL("http://localhost:3100/**", { timeout: 60_000 });
  await page.waitForLoadState("load");
  await page.getByRole("link", { name: "Create your first dot", exact: true }).waitFor();
  const bindings = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "ConvertTo-Json -InputObject @(Get-NetTCPConnection -LocalPort 3100 -State Listen | Select-Object -ExpandProperty LocalAddress) -Compress"], { windowsHide: true, encoding: "utf8" }));
  assert(bindings.length > 0 && bindings.every(ip => ip === "127.0.0.1" || ip === "::1"), "Server must bind only to loopback");
  const idleBefore = tree(app.process().pid);
  const idleStarted = performance.now();
  await page.waitForTimeout(2000);
  const idleAfter = tree(app.process().pid);
  fs.writeFileSync(path.join(evidence, "resources-idle.json"), JSON.stringify({ intervalSeconds: (performance.now() - idleStarted) / 1000, before: idleBefore, after: idleAfter }, null, 2));
  await page.screenshot({ path: path.join(evidence, "windows-home.png") });
  await page.goto("http://localhost:3100/new");
  await page.getByPlaceholder("Pixel", { exact: true }).fill("Windows check");
  await page.getByPlaceholder("What should it help with?").fill("Synthetic acceptance check; no API calls");
  await page.getByRole("button", { name: "Create Windows check", exact: true }).click();
  await page.waitForURL(/\/dots\/dot_/);
  const dotId = new URL(page.url()).pathname.split("/").pop();
  const html = await page.locator("body").innerText();
  assert(html.includes("Windows check"));
  await page.getByRole("heading", { name: "Hi, I'm Windows check", exact: true }).waitFor();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(evidence, "windows-dot.png") });
  await page.goto("http://localhost:3100/settings");
  await page.getByPlaceholder("Site, e.g. github.com").fill("synthetic.test");
  await page.getByPlaceholder("Username or email").fill("synthetic-user");
  await page.getByPlaceholder("Password", { exact: true }).fill("synthetic-password");
  await page.getByRole("button", { name: "Save login", exact: true }).click();
  await page.getByText("synthetic.test", { exact: true }).waitFor();
  assert((await page.locator("body").innerText()).includes("Windows DPAPI"));
  await page.screenshot({ path: path.join(evidence, "windows-settings.png") });
  assert(!fs.existsSync(path.join(profile, "data/vault.key")));
  assert(fs.existsSync(path.join(profile, "data/vault.key.dpapi")));

  // File upload and download assertions
  const createFile = await page.request.post(`http://localhost:3100/api/dots/${dotId}/files`, { multipart: { file: { name: "fixture café.txt", mimeType: "text/plain", buffer: Buffer.from("synthetic upload") } } });
  assert.equal(createFile.status(), 200, await createFile.text());
  const download = await page.request.get(`http://localhost:3100/api/dots/${dotId}/workspace?path=uploads%2Ffixture%20caf%C3%A9.txt`);
  assert.equal(await download.text(), "synthetic upload");
  assert.equal((await page.request.get(`http://localhost:3100/api/dots/${dotId}/workspace?path=..%2Foutside`)).status(), 404);

  // Loopback trust boundary security verification
  const evilOrigin = await page.request.post(`http://localhost:3100/api/dots/${dotId}/input`, {
    headers: { origin: "http://evil.com" },
    data: { t: "move", x: 10, y: 10 },
  });
  assert.equal(evilOrigin.status(), 403, "Cross-origin requests from untrusted Origin must be rejected");

  const evilHost = await page.request.get("http://localhost:3100/api/desktop/health", {
    headers: { host: "evil.com" },
  });
  assert.equal(evilHost.status(), 403, "Requests with untrusted Host header must be rejected");

  const crossSite = await page.request.post(`http://localhost:3100/api/dots/${dotId}/files`, {
    headers: { "sec-fetch-site": "cross-site" },
    multipart: { file: { name: "evil.txt", mimeType: "text/plain", buffer: Buffer.from("bad") } },
  });
  assert.equal(crossSite.status(), 403, "Cross-site fetch requests must be rejected");

  const nav = await page.request.post(`http://localhost:3100/api/dots/${dotId}/input`, { data: { t: "nav", url: fixtureUrl } });
  assert.equal(nav.status(), 204, await nav.text());
  const activeBefore = tree(app.process().pid);
  const activeStarted = performance.now();
  const shot = await page.request.get(`http://localhost:3100/api/dots/${dotId}/screen?fresh=1`);
  assert.equal(shot.status(), 200, await shot.text());
  fs.writeFileSync(path.join(evidence, "windows-browser.png"), await shot.body());
  await page.goto(`http://localhost:3100/dots/${dotId}?tab=computer`);
  await page.getByRole("button", { name: "Take over", exact: true }).click();
  await page.getByRole("button", { name: "Hand back to Windows check", exact: true }).waitFor();
  const liveImage = page.locator('img[src*="/stream?"]');
  await page.waitForFunction(() => document.querySelector('img[src*="/stream?"]')?.naturalWidth > 0, null, { timeout: 20_000 }).catch(async err => {
    console.log("Live image state", await liveImage.evaluate(e => ({ width: e.naturalWidth, height: e.naturalHeight, complete: e.complete, source: e.currentSrc })));
    throw err;
  });
  const bounds = await liveImage.boundingBox();

  // Coordinate scaling check: clicking outside the button at (50, 50) does not click button
  await page.mouse.click(bounds.x + bounds.width * 50 / 1280, bounds.y + bounds.height * 50 / 800);
  await page.waitForTimeout(200);
  assert(!remoteClicked, "Clicking outside the target button must not click it");

  // Coordinate scaling check: clicking at (160, 120) hits the center of button (left: 100, top: 100, width: 120, height: 40)
  await page.mouse.click(bounds.x + bounds.width * 160 / 1280, bounds.y + bounds.height * 120 / 800);
  // Focus text input at (160, 180)
  await page.mouse.click(bounds.x + bounds.width * 160 / 1280, bounds.y + bounds.height * 180 / 800);
  await page.keyboard.type("Windows takeover");
  for (let i = 0; i < 30 && (!remoteClicked || remoteTyped !== "Windows takeover"); i++) await page.waitForTimeout(100);
  assert(remoteClicked, "Takeover click scaled to (160, 120) must reach button");
  assert.equal(remoteTyped, "Windows takeover");

  // Special keys assertion: press Backspace and assert browser received the special key
  await page.keyboard.press("Backspace");
  for (let i = 0; i < 30 && !remoteSpecialKey; i++) await page.waitForTimeout(100);
  assert.equal(remoteSpecialKey, "Backspace", "Special key Backspace must reach the browser");

  // Wheel scrolling assertion: dispatch wheel event over stream image and assert remote page received wheel event
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.wheel(0, 120);
  for (let i = 0; i < 30 && !remoteWheel; i++) await page.waitForTimeout(100);
  assert(remoteWheel && remoteWheel.dy !== 0, "Wheel scroll event must reach the browser");

  await page.screenshot({ path: path.join(evidence, "windows-live-takeover.png") });
  await page.getByRole("button", { name: "Hand back to Windows check", exact: true }).click();
  const activeAfter = tree(app.process().pid);
  fs.writeFileSync(path.join(evidence, "resources-active.json"), JSON.stringify({ intervalSeconds: (performance.now() - activeStarted) / 1000, before: activeBefore, after: activeAfter, condition: "local fixture navigation, screenshot, live view, wheel, special keys and takeover UI; no model calls" }, null, 2));
  console.log("PASS: desktop server/UI, SQLite, DPAPI save, file upload/download/traversal, loopback security, real browser navigation/screenshot/wheel/keys/takeover");

  // Test window close hides to tray, server stays active
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  assert.equal((await page.request.get("http://localhost:3100/api/desktop/health")).status(), 200);

  // Real second process spawn: verify single instance lock across distinct OS processes
  const secondExe = options.executablePath || path.join(root, "node_modules/electron/dist/electron.exe");
  const secondArgs = options.executablePath ? [] : [path.join(root, "electron")];
  const secondProc = spawnSync(secondExe, secondArgs, { env, timeout: 20_000, windowsHide: true });
  assert.equal(secondProc.status, 0, `Second process must exit with code 0: ${secondProc.stderr}`);

  // Assert primary instance window was restored and made visible by the second instance trigger
  for (let i = 0; i < 40 && !(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())); i++) {
    await page.waitForTimeout(100);
  }
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true, "Original window must reopen when second process launches");

  const metrics = await app.evaluate(({ app }) => app.getAppMetrics().map(m => ({ type: m.type, pid: m.pid, cpu: m.cpu, memory: m.memory })));
  fs.writeFileSync(path.join(evidence, "electron-metrics.json"), JSON.stringify(metrics, null, 2));
  const owned = tree(app.process().pid);
  fs.writeFileSync(path.join(evidence, "resources-browser-open.json"), JSON.stringify(owned, null, 2));
  await app.close();
  app = null;
  await new Promise(resolve => setTimeout(resolve, 1000));
  await assert.rejects(fetch("http://127.0.0.1:3100/api/desktop/health"));
  assert.deepEqual(tree(owned[0].pid), [], "Electron tree must stop on full quit");
  const surviving = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -in @(${owned.map(p => p.pid).join(",")}) } | ForEach-Object { [pscustomobject]@{ pid=$_.ProcessId; createdUtc=$_.CreationDate.ToUniversalTime().ToString('o') } }) -Compress`], { windowsHide: true, encoding: "utf8" }));
  assert.deepEqual(surviving.filter(p => owned.some(o => o.pid === p.pid && o.createdUtc === p.createdUtc)), [], "Owned app processes must stop; reused PIDs are unrelated");

  // Restart persistence check
  app = await _electron.launch({ ...options, env, timeout: 60_000 });
  const reopened = await app.firstWindow();
  await reopened.waitForURL("http://localhost:3100/**", { timeout: 60_000 });
  await reopened.waitForLoadState("load");
  await reopened.goto("http://localhost:3100/settings");
  await reopened.getByText("synthetic.test", { exact: true }).waitFor();
  await reopened.goto(`http://localhost:3100/dots/${dotId}`);
  await reopened.getByRole("heading", { name: "Hi, I'm Windows check", exact: true }).waitFor();
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log("PASS: close hides, server stays alive, real second-process launch reopens, full quit stops loopback server, restart persistence");
} finally {
  await app?.close().catch(() => {});
  fixture.close();
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {}
}
