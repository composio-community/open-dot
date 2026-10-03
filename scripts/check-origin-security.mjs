import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { _electron, chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const evidence = path.join(root, ".windows-check-output/evidence");
const profile = fs.mkdtempSync(path.join(root, ".windows-check-origin-"));
const env = { ...process.env, OPEN_DOT_USER_DATA_DIR: profile, DOTS_COMPUTER: "local", OPENAI_API_KEY: "", OPENROUTER_API_KEY: "", E2B_API_KEY: "", COMPOSIO_API_KEY: "" };
delete env.ELECTRON_RUN_AS_NODE;
const exeIndex = process.argv.indexOf("--exe");
const options = exeIndex >= 0 || process.argv.includes("--packaged")
  ? { executablePath: exeIndex >= 0 ? path.resolve(process.argv[exeIndex + 1]) : path.join(root, "dist/win-unpacked/Open Dot.exe") }
  : { args: [path.join(root, "electron")] };
const result = { artifact: options.executablePath || "source Electron with prepared production server", http: [], browser: [] };
let app, browser, fixture;
try {
  app = await _electron.launch({ ...options, env, timeout: 60_000 });
  const page = await app.firstWindow();
  await page.waitForURL("http://localhost:3100/**", { timeout: 60_000 });
  await page.goto("http://localhost:3100/new");
  await page.getByPlaceholder("Pixel", { exact: true }).fill("Boundary check");
  await page.getByPlaceholder("What should it help with?").fill("Synthetic security acceptance; no model calls");
  const creating = page.waitForRequest(req => req.method() === "POST" && new URL(req.url()).pathname === "/new" && req.headers()["next-action"]);
  await page.getByRole("button", { name: "Create Boundary check", exact: true }).click();
  const creation = await creating;
  await page.waitForURL(/\/dots\/dot_/);
  const dotId = new URL(page.url()).pathname.split("/").pop();
  const uploadUrl = `http://localhost:3100/api/dots/${dotId}/files`;
  for (const [name, headers] of [
    ["server-action-untrusted-host", { host: "evil.test:3100", origin: "http://evil.test:3100" }],
    ["server-action-forged-forwarded-host", { origin: "http://evil.test:3100", "x-forwarded-host": "evil.test:3100" }],
    ["server-action-other-local-port", { origin: "http://localhost:4200" }],
    ["server-action-opaque", { origin: "null", "sec-fetch-mode": "navigate", "sec-fetch-site": "cross-site" }],
  ]) {
    const response = await page.request.post(creation.url(), { headers: { "next-action": creation.headers()["next-action"], "content-type": creation.headers()["content-type"], ...headers }, data: creation.postDataBuffer() });
    result.http.push({ name, status: response.status() });
    assert.equal(response.status(), 403, name);
  }
  for (const [name, headers, expected] of [
    ["trusted-control", { origin: "http://localhost:3100", "sec-fetch-site": "same-origin" }, 200],
    ["different-local-port", { origin: "http://localhost:4200", "sec-fetch-site": "same-site", "sec-fetch-mode": "cors" }, 403],
    ["opaque-navigation", { origin: "null", "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" }, 403],
    ["external-origin", { origin: "http://evil.test", "sec-fetch-site": "cross-site" }, 403],
  ]) {
    const response = await page.request.post(uploadUrl, { headers, multipart: { file: { name: `${name}.txt`, mimeType: "text/plain", buffer: Buffer.from("synthetic boundary probe") } } });
    result.http.push({ name, status: response.status() });
    assert.equal(response.status(), expected, name);
  }
  const callback = await page.request.get("http://localhost:3100/api/composio/oauth?error=synthetic-cancel", { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" } });
  assert.equal(callback.status(), 400, "Provider callback navigation must reach its error page");
  assert((await callback.text()).includes("synthetic-cancel"));
  assert.equal((await page.request.get("http://localhost:3100/api/composio/oauth")).status(), 400, "Missing OAuth code must not claim sign-in success");
  assert.equal((await page.request.get("http://localhost:3100/api/desktop/health", { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" } })).status(), 403, "Navigation exception belongs only to the callback");

  const sameSiteHtml = `<script>const f=new FormData();f.append('file',new File(['synthetic browser upload'],'actual-same-site.txt',{type:'text/plain'}));fetch(${JSON.stringify(uploadUrl)},{method:'POST',body:f}).catch(()=>{});</script>`;
  const opaqueHtml = `<form method="POST" enctype="multipart/form-data" action="${uploadUrl}"><input type="file" name="file" id="payload"></form><script>const d=new DataTransfer();d.items.add(new File(['synthetic opaque form upload'],'actual-opaque-form.txt',{type:'text/plain'}));document.getElementById('payload').files=d.files;document.querySelector('form').submit();</script>`;
  const escaped = opaqueHtml.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  fixture = http.createServer((req, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(req.url === "/opaque" ? `<iframe sandbox="allow-scripts allow-forms" srcdoc="${escaped}"></iframe>` : sameSiteHtml);
  });
  await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
  const resources = await app.evaluate(({ app }) => app.isPackaged ? process.resourcesPath : null);
  const bundled = resources ? path.join(resources, "browser") : path.join(root, ".desktop/browser");
  const chromiumDir = fs.readdirSync(bundled).find(name => /^chromium-\d+$/.test(name));
  assert(chromiumDir, "Bundled Chromium must exist");
  browser = await chromium.launch({ executablePath: path.join(bundled, chromiumDir, "chrome-win64/chrome.exe"), headless: true });
  const attack = await browser.newPage();
  for (const [route, name] of [["same-site", "actual-same-site.txt"], ["opaque", "actual-opaque-form.txt"]]) {
    const requested = attack.waitForRequest(req => req.url() === uploadUrl && req.method() === "POST");
    const settled = new Promise(resolve => {
      const finished = req => { if (req.url() !== uploadUrl) return; attack.off("requestfailed", finished); attack.off("requestfinished", finished); resolve(req); };
      attack.on("requestfailed", finished);
      attack.on("requestfinished", finished);
    });
    await attack.goto(`http://localhost:${fixture.address().port}/${route}`);
    const request = await requested;
    await Promise.race([settled, new Promise((_, reject) => setTimeout(() => reject(new Error(`${route} upload did not settle`)), 10_000))]);
    const response = await request.response();
    const fileCreated = fs.existsSync(path.join(profile, "data/dots", dotId, "workspace/uploads", name));
    result.browser.push({ route, method: request.method(), status: response?.status() ?? null, failure: request.failure()?.errorText ?? null, fileCreated });
    assert.equal(fileCreated, false, `${route} browser attack must not write a file`);
    if (response) assert.equal(response.status(), 403, `${route} browser attack`);
  }
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, "origin-security-acceptance.json"), JSON.stringify(result, null, 2));
  console.log("PASS: exact-origin controls, OAuth callback exception, real browser same-site and opaque multipart attacks", JSON.stringify(result));
} finally {
  await browser?.close();
  await app?.close();
  if (fixture) await new Promise(resolve => fixture.close(resolve));
  if (path.dirname(profile) !== root || fs.lstatSync(profile).isSymbolicLink()) throw new Error("Unexpected acceptance cleanup target");
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
