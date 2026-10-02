// Real browser form filling, with intercepted local fixtures and synthetic credentials only.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const temp = fs.mkdtempSync(path.join(root, ".windows-check-login-"));
process.env.DOTS_DATA_DIR = temp;
process.env.DOTS_COMPUTER = "local";
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(root, ".desktop/browser");
await import("./windows-test-loader.mjs");
const browser = await import("../src/server/computer/browser.ts");
const { loginScript } = await import("../src/server/computer/dom-actions.ts");
const dotId = "dot_login_fixture";
try {
  await browser.wake(dotId);
  const { context } = await globalThis.__dotsBrowsers.get(dotId);
  const html = '<input type="email"><input type="password"><script>window.events=[];for(const e of document.querySelectorAll("input"))e.oninput=()=>window.events.push(e.type);</script>';
  await context.route("**/*", route => route.fulfill({ contentType: "text/html", body: html }));
  const page = context.pages()[0];
  await browser.openUrl(dotId, "https://trusted.synthetic.test/login");
  const result = await browser.fillLogin(dotId, "trusted.synthetic.test", "synthetic-user", "synthetic-password");
  assert(result.includes("username and password"));
  assert(!result.includes("synthetic-password"));
  assert.deepEqual(await page.locator("input").evaluateAll(els => els.map(e => e.value)), ["synthetic-user", "synthetic-password"]);
  assert.deepEqual(await page.evaluate(() => window.events), ["email", "password"]);
  for (const url of ["https://evil.synthetic.test/", "http://trusted.synthetic.test/", "https://trusted.synthetic.test.evil.test/", "https://sub.trusted.synthetic.test/"]) {
    await browser.openUrl(dotId, url);
    assert((await browser.fillLogin(dotId, "trusted.synthetic.test", "synthetic-user", "synthetic-password")).startsWith("Login blocked:"));
    assert.deepEqual(await page.locator("input").evaluateAll(els => els.map(e => e.value)), ["", ""]);
    assert.deepEqual(await page.evaluate(() => window.events), []);
  }
  assert.throws(() => loginScript("http://trusted.synthetic.test", "synthetic-user", "synthetic-password"), /HTTPS/);
  assert.throws(() => loginScript("https://user:pass@trusted.synthetic.test", "synthetic-user", "synthetic-password"), /HTTPS/);
  console.log("PASS: real browser login fill, exact HTTPS origin, lookalike/subdomain/HTTP refusal, no password in tool result");
} finally {
  await browser.closeBrowser(dotId);
  if (path.dirname(temp) !== root || fs.lstatSync(temp).isSymbolicLink()) throw new Error("Unexpected login cleanup target");
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
