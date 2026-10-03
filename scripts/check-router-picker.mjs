// Actual compiled server + browser UI, with synthetic catalog replies and no live keys.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
await import("./windows-test-loader.mjs");
const { ROUTER_PROVIDERS } = await import("../src/lib/model-providers.ts");
const root = path.resolve(import.meta.dirname, "..");
const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const serverDir = path.resolve(arg("--server", path.join(root, ".desktop/server")));
const browserExe = arg("--browser", path.join(root, ".desktop/browser/chromium-1243/chrome-win64/chrome.exe"));
const profile = fs.mkdtempSync(path.join(root, ".windows-check-router-picker-"));
const fixture = path.join(profile, "catalog.mjs"), requestLog = path.join(profile, "requests.jsonl");
fs.writeFileSync(fixture, `import fs from "node:fs";
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = init.method ?? (input instanceof Request ? input.method : "GET");
  fs.appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify({url:url.href,method}) + "\\n");
  if (method !== "GET" || url.origin !== "https://openrouter.ai" || url.pathname !== "/api/v1/models") throw new Error("External request refused by synthetic picker check");
  const data = [{id:"moonshotai/kimi-k3",supported_parameters:["tools"]},{id:"text-only-fixture",supported_parameters:["temperature"]},...Array.from({length:220},(_,i)=>({id:"paid-fixture-"+i,supported_parameters:["tools"]})),{id:"openrouter/free",supported_parameters:["tools","structured_outputs"]}];
  return Response.json({data:url.searchParams.has("supported_parameters") ? data.filter(m=>m.id!=="openrouter/free") : data});
};
`);
const env = { ...process.env, NODE_ENV: "production", NODE_OPTIONS: "", PORT: "3105", HOSTNAME: "127.0.0.1", DOTS_DESKTOP_INSTANCE: crypto.randomUUID(), DOTS_PUBLIC_URL: "http://localhost:3105", DOTS_DATA_DIR: path.join(profile, "data"), DOTS_COMPUTER: "local", DOTS_MODEL: "", DOTS_REVIEW_MODEL: "", OPENAI_API_KEY: "", COMPOSIO_API_KEY: "", E2B_API_KEY: "" };
for (const p of ROUTER_PROVIDERS) { env[p.env] = ""; env[`${p.env.replace(/_API_KEY$/, "")}_BASE_URL`] = ""; }
env.OPENROUTER_API_KEY = "fixture-picker-only-secret";
const server = spawn(process.execPath, ["--import", pathToFileURL(fixture).href, path.join(serverDir, "server.js")], { cwd: serverDir, env, windowsHide: true });
let output = "", browser;
server.stdout.on("data", chunk => { output = (output + chunk).slice(-4000); });
server.stderr.on("data", chunk => { output = (output + chunk).slice(-4000); });
server.on("error", err => { output += err.message; });
try {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(output);
    const ready = await fetch("http://127.0.0.1:3105/api/desktop/health").catch(() => null);
    if (ready?.ok && await ready.text() === env.DOTS_DESKTOP_INSTANCE) break;
    if (i === 99) throw new Error("Synthetic picker server did not start: " + output);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  browser = await chromium.launch({ executablePath: browserExe, headless: true });
  const page = await browser.newPage({ viewport: { width: 1300, height: 860 } });
  await page.goto("http://localhost:3105/settings");
  const picker = page.locator('button[aria-haspopup="listbox"]');
  await picker.filter({ hasText: "openrouter/free" }).waitFor();
  await picker.click();
  const free = page.getByRole("option", { name: /^openrouter\/free/ });
  await free.waitFor({ state: "visible" });
  assert.equal(await page.getByRole("option", { name: /text-only-fixture/ }).count(), 0);
  const evidence = path.join(root, ".windows-check-output/evidence");
  fs.mkdirSync(evidence, { recursive: true });
  await page.screenshot({ path: path.join(evidence, "windows-free-model-picker.png") });
  await page.getByRole("option", { name: /^moonshotai\/kimi-k3/ }).click();
  await picker.filter({ hasText: "moonshotai/kimi-k3" }).waitFor();
  await page.reload();
  await picker.filter({ hasText: "moonshotai/kimi-k3" }).waitFor();
  await picker.click(); await free.click();
  await picker.filter({ hasText: "openrouter/free" }).waitFor();
  await page.goto("http://localhost:3105/new");
  await page.getByPlaceholder("Pixel", { exact: true }).fill("Free picker check");
  await page.getByPlaceholder("What should it help with?").fill("Synthetic model selection check; no inference");
  await page.getByRole("button", { name: "Create Free picker check", exact: true }).click();
  await page.waitForURL(/\/dots\/dot_/);
  await picker.filter({ hasText: /Default.*openrouter\/free/ }).waitFor();
  await picker.click(); await free.waitFor({ state: "visible" });
  await page.screenshot({ path: path.join(evidence, "windows-dot-free-model-picker.png") });
  await page.getByRole("option", { name: /^moonshotai\/kimi-k3/ }).click();
  await picker.filter({ hasText: "moonshotai/kimi-k3" }).waitFor();
  await picker.click(); await page.getByRole("option", { name: /^Default/ }).click();
  await picker.filter({ hasText: /Default.*openrouter\/free/ }).waitFor();
  const requests = fs.readFileSync(requestLog, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert(requests.length > 0 && requests.every(r => r.method === "GET" && new URL(r.url).pathname === "/api/v1/models" && !new URL(r.url).searchParams.has("supported_parameters")));
  console.log("PASS: compiled-server free default, visible Settings/dot dropdowns, paid-to-free selection, reload persistence and dot inheritance; synthetic catalogs only, no inference");
} catch (err) { throw new Error(`${err.message}\n${output}`, { cause: err }); }
finally {
  await browser?.close();
  if (server.exitCode === null) { const exited = new Promise(resolve => server.once("exit", resolve)); server.kill(); await exited; }
  if (path.dirname(profile) !== root || fs.lstatSync(profile).isSymbolicLink()) throw new Error("Unexpected picker profile cleanup target");
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
