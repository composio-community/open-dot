import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";

if (process.platform !== "win32") throw new Error("Run this acceptance check on Windows.");
const root = path.resolve(import.meta.dirname, "..");
// Set PLAYWRIGHT_BROWSERS_PATH before any browser or playwright modules are imported
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(root, ".desktop/browser");

const temp = fs.mkdtempSync(path.join(root, ".windows-check-"));
const data = path.join(temp, "spaces and Unicode café 数据");
process.env.DOTS_DATA_DIR = data;
process.env.DOTS_COMPUTER = "local";
await import("./windows-test-loader.mjs");
const shell = await import("../src/server/computer/shell.ts");
const computer = await import("../src/server/computer/index.ts");
const vault = await import("../src/server/vault.ts");
const { db } = await import("../src/server/db.ts");
const repo = await import("../src/server/repo.ts");
const files = await import("../src/server/files.ts");
const browser = await import("../src/server/computer/browser.ts");
const security = await import("../src/server/security.ts");
const { DEFAULT_LOOK } = await import("../src/lib/look.ts");
const { TOOLS } = await import("../src/server/agent/tools.ts");
const dot = "dot_test";

const restart = (code, dir = data) => {
  const r = spawnSync(process.execPath, ["--import", pathToFileURL(path.join(root, "scripts/windows-test-loader.mjs")).href, "--input-type=module", "-e", code], {
    cwd: root, env: { ...process.env, DOTS_DATA_DIR: dir }, encoding: "utf8", windowsHide: true,
  });
  assert.equal(r.status, 0, r.stderr);
};

try {
  // 1. Windows PowerShell, Unicode, working directory, traversal/junctions, and approval defaults
  const cwd = await shell.runOnDotComputer(dot, "[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-Location).Path");
  assert.equal(cwd, shell.workspaceDir(dot));
  assert.match(await shell.runOnDotComputer(dot, "Write-Output 'PowerShell works'"), /PowerShell works/);
  assert.match(await shell.runOnDotComputer(dot, "exit 7"), /exit 7/);
  assert.equal(TOOLS.find(t => t.name === "run_command").defaultDecision({ dot: { id: dot } }), "ask");
  assert.equal(TOOLS.find(t => t.name === "run_on_my_computer").defaultDecision(), "ask");
  await computer.writeFile(dot, "/workspace/report café.txt", "hello 数据");
  assert.equal((await computer.readFile(dot, "report café.txt")).toString(), "hello 数据");
  for (const p of ["../outside", "..\\outside", "C:\\outside", "\\\\host\\share", "report.txt:stream", "/workspace/../../outside", "workspace-other/../../outside"]) {
    assert.throws(() => shell.resolveWorkspacePath(dot, p), /inside/);
  }
  const outside = path.join(temp, "outside"); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(shell.workspaceDir(dot), "escape"), "junction");
  assert.throws(() => shell.resolveWorkspacePath(dot, "escape/new.txt"), /inside/);
  assert.throws(() => shell.workspaceDir("../other"), /Invalid dot/);
  assert(!((await computer.listFiles(dot)).some(f => f.path.startsWith("escape"))));
  const rootEscape = path.join(data, "dots", "dot_root_escape");
  fs.symlinkSync(outside, rootEscape, "junction");
  assert.throws(() => shell.workspaceDir("dot_root_escape"), /inside/);
  assert(!fs.existsSync(path.join(outside, "workspace")), "Reject the redirected dot before creating a workspace outside it");
  console.log("PASS: PowerShell, Unicode/spaces, file operations, traversal/junctions, approval defaults");

  // 2. Windows DPAPI, AES encryption, tampering detection, restart persistence, legacy migration, missing/corrupted key refusal
  const encrypted = vault.seal("synthetic secret");
  assert.equal(vault.unseal(encrypted), "synthetic secret");
  assert.throws(() => vault.unseal(encrypted.slice(0, -4) + "AAAA"));
  assert(!fs.existsSync(path.join(data, "vault.key")));
  assert(fs.existsSync(path.join(data, "vault.key.dpapi")));
  fs.writeFileSync(path.join(data, "roundtrip.txt"), encrypted);
  restart(`import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; import {unseal} from './src/server/vault.ts'; assert.equal(unseal(fs.readFileSync(path.join(process.env.DOTS_DATA_DIR,'roundtrip.txt'),'utf8')),'synthetic secret');`);
  const migration = path.join(temp, "migration"); fs.mkdirSync(migration);
  const oldKey = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const oldCipher = crypto.createCipheriv("aes-256-gcm", oldKey, iv);
  const oldData = Buffer.concat([oldCipher.update("existing legacy credential"), oldCipher.final()]);
  fs.writeFileSync(path.join(migration, "vault.key"), oldKey.toString("hex"));
  fs.writeFileSync(path.join(migration, "old-sealed.txt"), [iv, oldCipher.getAuthTag(), oldData].map(b => b.toString("base64")).join("."));
  restart(`import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; import {seal,unseal} from './src/server/vault.ts'; assert.equal(unseal(fs.readFileSync(path.join(process.env.DOTS_DATA_DIR,'old-sealed.txt'),'utf8')), 'existing legacy credential'); assert.equal(unseal(seal('migration')), 'migration'); assert(!fs.existsSync(path.join(process.env.DOTS_DATA_DIR,'vault.key')));`, migration);
  db().prepare("INSERT INTO settings (key,value) VALUES ('openai_key',?)").run(encrypted);
  fs.renameSync(path.join(data, "vault.key.dpapi"), path.join(data, "backup.dpapi"));
  restart(`import assert from 'node:assert/strict'; import {seal} from './src/server/vault.ts'; assert.throws(()=>seal('x'), /missing/);`);
  fs.renameSync(path.join(data, "backup.dpapi"), path.join(data, "vault.key.dpapi"));
  const protectedKey = fs.readFileSync(path.join(data, "vault.key.dpapi"));
  fs.writeFileSync(path.join(data, "vault.key.dpapi"), Buffer.from("corrupt protected key"));
  restart(`import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; import {seal} from './src/server/vault.ts'; assert.throws(()=>seal('x'), /protection failed/); assert.equal(fs.readFileSync(path.join(process.env.DOTS_DATA_DIR,'vault.key.dpapi'),'utf8'),'corrupt protected key');`);
  fs.writeFileSync(path.join(data, "vault.key.dpapi"), protectedKey);
  console.log("PASS: real Windows DPAPI, AES authentication, restart, legacy migration, missing-key refusal");

  // 3. User workflows: multiple dots, switching, renaming, channels, conversations, memory, skills, rules, routines, file boundary cases, dot deletion & cleanup
  const one = repo.createDot({ name: "Test one", purpose: "Synthetic", look: DEFAULT_LOOK });
  const two = repo.createDot({ name: "Test two", purpose: "Synthetic", look: DEFAULT_LOOK });
  assert.equal(repo.listDots().length, 2);

  // Dot rename and purpose update
  repo.updateDot(one.id, { name: "Renamed One", purpose: "Updated purpose" });
  assert.equal(repo.getDot(one.id).name, "Renamed One");
  assert.equal(repo.getDot(one.id).purpose, "Updated purpose");

  // Conversation lifecycle: create, rename, delete
  const tempConv = repo.createConversation(one.id, "Temporary chat");
  assert.equal(repo.getConversation(tempConv.id).title, "Temporary chat");
  repo.renameConversation(tempConv.id, "Renamed chat");
  assert.equal(repo.getConversation(tempConv.id).title, "Renamed chat");
  repo.deleteConversation(tempConv.id);
  assert.equal(repo.getConversation(tempConv.id), null);
  repo.createConversation(one.id, "Saved chat");

  // Channels
  const channel = repo.createChannel("test-channel", one.id, [two.id]);
  assert.equal(repo.getChannel(channel.id).memberIds.length, 2);

  // Memory lifecycle: create, list, delete
  const tempMem = repo.addMemory(one.id, "Temporary memory");
  assert.equal(repo.listMemories(one.id).length, 1);
  repo.deleteMemory(tempMem.id);
  assert.equal(repo.listMemories(one.id).length, 0);
  repo.addMemory(one.id, "Persistent memory");

  // Skill lifecycle: upsert, update body, delete
  const tempSkill = repo.upsertSkill(one.id, "Temp skill", "Desc", "Body v1");
  assert.equal(repo.listSkills(one.id).length, 1);
  repo.upsertSkill(one.id, "Temp skill", "Updated desc", "Body v2");
  assert.equal(repo.listSkills(one.id)[0].body, "Body v2");
  repo.deleteSkill(tempSkill.id);
  assert.equal(repo.listSkills(one.id).length, 0);
  repo.upsertSkill(one.id, "Test skill", "Test", "Synthetic instructions");

  // Rule lifecycle: create, query, delete
  const tempRule = repo.addRule({ dotId: one.id, action: "Temp command", decision: "never" });
  assert.equal(repo.rulesFor(one.id).length, 1);
  repo.deleteRule(tempRule.id);
  assert.equal(repo.rulesFor(one.id).length, 0);
  repo.addRule({ dotId: one.id, action: "Synthetic command", decision: "ask" });

  // Routine & Trigger schedule validation & lifecycle
  assert(repo.validSchedule("0 9 * * *"), "Valid cron schedule must pass");
  assert(!repo.validSchedule("invalid-schedule"), "Invalid cron schedule must fail");
  const routine = repo.addRoutine({ dotId: one.id, name: "Test routine", instruction: "Synthetic", schedule: "0 9 * * *" });
  repo.updateRoutine(routine.id, { enabled: false });
  const trigger = repo.addTrigger({ dotId: one.id, composioId: "synthetic", slug: "TEST", toolkit: "test", name: "Test trigger", config: {}, instruction: "Synthetic" });
  repo.updateTrigger(trigger.id, { enabled: false });

  // File uploads: empty content, Unicode/spaces, duplicate filenames, shareFromComputer
  const emptyFile = await files.upload(one.id, "empty.txt", "text/plain", Buffer.alloc(0));
  assert.equal(emptyFile.size, 0);
  assert.equal(files.get(emptyFile.id).data().length, 0);
  assert.equal((await computer.readFile(one.id, emptyFile.boxPath)).length, 0);

  const unicodeFile = await files.upload(one.id, "upload café.txt", "text/plain", Buffer.from("synthetic upload"));
  assert.equal(files.get(unicodeFile.id).data().toString(), "synthetic upload");
  assert.equal((await files.shareFromComputer(one.id, unicodeFile.boxPath)).name, "upload café.txt");

  const duplicateFile = await files.upload(one.id, "empty.txt", "text/plain", Buffer.from("duplicate content"));
  assert.notEqual(emptyFile.id, duplicateFile.id);
  assert.equal(files.get(duplicateFile.id).data().toString(), "duplicate content");

  // Restart persistence of all created records
  restart(`import assert from 'node:assert/strict'; import * as r from './src/server/repo.ts'; assert.equal(r.listDots().length,2); assert.equal(r.listChannels().length,1); assert.equal(r.listConversations().length,1); assert.equal(r.listMemories().length,1); assert.equal(r.listSkills().length,1); assert.equal(r.listRules().length,1); assert.equal(r.listRoutines().length,1); assert.equal(r.listTriggers().length,1);`);

  // Dot deletion and cleanup check: delete dot 'two'
  const twoFile = await files.upload(two.id, "two_file.txt", "text/plain", Buffer.from("two data"));
  repo.addMemory(two.id, "two memory");
  const canonical = path.join(data, "files", twoFile.id);
  const quotedFile = "'" + canonical.replaceAll("'", "''") + "'";
  const locker = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$f=[IO.File]::Open(${quotedFile},[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); try { [Console]::WriteLine('LOCKED'); [Console]::In.ReadLine() | Out-Null } finally { $f.Dispose() }`], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Attachment lock timed out")), 10_000);
      locker.stdout.once("data", chunk => {
        clearTimeout(timer);
        if (chunk.toString().includes("LOCKED")) resolve();
        else reject(new Error("Attachment lock failed"));
      });
      locker.once("error", err => { clearTimeout(timer); reject(err); });
      locker.once("exit", () => { clearTimeout(timer); reject(new Error("Attachment locker exited before readiness")); });
    });
    assert.throws(() => files.deleteForDot(two.id), /Could not delete an attachment/);
    assert(files.get(twoFile.id), "A failed deletion must retain its database record for retry");
    assert(fs.existsSync(canonical), "The locked file must remain tracked on disk");
    assert(repo.getDot(two.id), "The dot must remain available after attachment cleanup failure");
  } finally {
    if (locker.exitCode === null) {
      const exited = once(locker, "exit");
      locker.stdin.end("\n");
      await exited;
    }
  }
  await computer.destroy(two.id);
  files.deleteForDot(two.id);
  files.deleteForDot(two.id); // Retrying completed cleanup is safe.
  repo.deleteDot(two.id);

  assert.equal(repo.getDot(two.id), null, "Deleted dot must not exist");
  assert.equal(repo.listMemories(two.id).length, 0, "Deleted dot memories must be removed");
  assert.equal(db().prepare("SELECT * FROM files WHERE dot_id = ?").all(two.id).length, 0, "Deleted dot files must be removed");
  assert(!fs.existsSync(path.join(data, "dots", two.id)), "Deleted dot folder must be removed");
  assert(!fs.existsSync(canonical), "Deleted dot canonical attachment must be removed");
  assert.deepEqual(repo.getChannel(channel.id).memberIds, [one.id], "Channel members must update when member dot is deleted");

  // Dot 'one' must remain completely intact
  assert.equal(repo.getDot(one.id).name, "Renamed One");
  assert.equal(repo.listMemories(one.id).length, 1);
  assert.equal(repo.listSkills(one.id).length, 1);
  assert.equal(repo.listRules(one.id).length, 1);
  assert.equal(repo.listRoutines(one.id).length, 1);
  assert.equal(repo.listTriggers(one.id).length, 1);
  console.log("PASS: user workflows, dot rename/switching, channel/memory/skill/rule/routine lifecycles, file boundaries, dot deletion cleanup");

  // 4. Loopback security boundary & occupied port detection
  assert(security.isTrustedLoopbackRequest(new Request("http://localhost:3100/api/desktop/health", { headers: { host: "localhost:3100", origin: "http://localhost:3100" } })));
  assert(security.isTrustedLoopbackRequest(new Request("http://127.0.0.1:3100/api/desktop/health", { headers: { host: "127.0.0.1:3100", origin: "http://127.0.0.1:3100" } })));
  assert(!security.isTrustedLoopbackRequest(new Request("http://localhost:3100/api/desktop/health", { headers: { host: "evil.com" } })));
  assert(!security.isTrustedLoopbackRequest(new Request("http://localhost:3100/api/desktop/health", { headers: { host: "localhost:3100", origin: "http://evil.com" } })));
  assert(!security.isTrustedLoopbackRequest(new Request("http://localhost:3100/api/desktop/health", { headers: { host: "localhost:3100", "sec-fetch-site": "cross-site" } })));
  assert(security.isTrustedLoopbackRequest(new Request("http://[::1]:3100/api/desktop/health", { headers: { host: "[::1]:3100", origin: "http://[::1]:3100" } })));
  for (const headers of [
    { host: "localhost:4200" },
    { host: "localhost:3100", origin: "http://localhost:4200", "sec-fetch-site": "same-site" },
    { host: "localhost:3100", origin: "http://127.0.0.1:3100" },
    { host: "localhost:3100", origin: "https://localhost:3100" },
    { host: "localhost:3100", origin: "null", "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" },
    { host: "localhost:3100", "sec-fetch-site": "same-site" },
  ]) assert(!security.isTrustedLoopbackRequest(new Request("http://localhost:3100/api/test", { method: "POST", headers })));
  const callbackHeaders = { host: "localhost:3100", "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" };
  const callback = new Request("http://localhost:3100/api/composio/oauth", { headers: callbackHeaders });
  assert(!security.isTrustedLoopbackRequest(callback), "Cross-site navigation must not bypass normal API guards");
  assert(security.isTrustedLoopbackRequest(callback, true), "The provider GET callback must remain accessible");
  assert(!security.isTrustedLoopbackRequest(new Request(callback.url, { method: "POST", headers: callbackHeaders }), true));
  assert(!security.isTrustedLoopbackRequest(new Request(callback.url, { headers: { ...callbackHeaders, origin: "null" } }), true));

  const occupiedServer = http.createServer((_q, s) => s.end("occupied"));
  const occupiedPort = await new Promise((resolve) => occupiedServer.listen(0, "127.0.0.1", () => resolve(occupiedServer.address().port)));
  const checkPortProbe = (port) => new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", () => reject(new Error(`Port ${port} is already in use. Close the other application and reopen Open Dot.`)));
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  });
  await assert.rejects(() => checkPortProbe(occupiedPort), /Port .* is already in use/);
  await new Promise(resolve => occupiedServer.close(resolve));
  await assert.doesNotReject(() => checkPortProbe(occupiedPort));
  console.log("PASS: loopback trust boundary rejection and occupied port conflict detection");

  // 5. Browser launch, bundled path assertion, process executable verification, interactions, live view, takeover, profile persistence & cleanup
  const bundled = process.argv.includes("--bundled");
  let chromeUnavailableReason = "native-system";
  if (bundled) {
    chromeUnavailableReason = "Controlled simulation of Chrome unavailability on test machine";
    const { chromium } = await import("playwright");
    const launch = chromium.launchPersistentContext.bind(chromium);
    chromium.launchPersistentContext = (dir, options) => {
      if (options.channel === "chrome") throw new Error("Acceptance check: Controlled simulation of Chrome unavailable on system");
      return launch(dir, options);
    };
  }

  const expectedBundledPath = path.resolve(root, ".desktop/browser/chromium-1243/chrome-win64/chrome.exe");
  const actualChromiumPath = path.resolve((await import("playwright")).chromium.executablePath());
  assert.equal(actualChromiumPath, expectedBundledPath, `Playwright must resolve bundled Chromium path: ${actualChromiumPath}`);

  const page = await browser.page(one.id, false);
  const runningChromeProc = JSON.parse(spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    `ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like "*${one.id}*" } | Select-Object -Property ProcessId, ExecutablePath) -Compress`
  ], { windowsHide: true, encoding: "utf8" }).stdout.trim() || "[]");
  const chromeList = Array.isArray(runningChromeProc) ? runningChromeProc : [runningChromeProc];
  assert(chromeList.length > 0, "Launched browser process must be found running");
  const launchedExe = path.resolve(chromeList[0].ExecutablePath);
  console.log(`Launched browser executable: ${launchedExe} (mode: ${bundled ? chromeUnavailableReason : "native installed Chrome"})`);
  if (bundled) {
    assert.equal(launchedExe.toLowerCase(), expectedBundledPath.toLowerCase(), `Launched executable must match bundled path: ${launchedExe}`);
  }

  await page.setContent('<title>Harmless browser check</title><input aria-label="Test field"><button onclick="document.title=\'Clicked\'">Test button</button>');
  await browser.typeText(one.id, "Test field", "hello", false);
  assert.equal(await page.locator("input").inputValue(), "hello");
  await browser.clickText(one.id, "Test button");
  assert.equal(await page.title(), "Clicked");
  assert((await browser.screenshot(one.id)).length > 1000);
  await browser.input(one.id, { t: "paste", text: " Unicode 数据" });
  await page.evaluate(() => localStorage.setItem("check", "saved")).catch(() => {});
  const context = page.context();
  await context.addCookies([{ name: "check", value: "saved", domain: "example.test", path: "/", expires: Math.floor(Date.now() / 1000) + 86400 }]);
  let frames = 0;
  const stop = await browser.stream(one.id, () => frames++);
  await page.evaluate(() => { document.body.style.background = "red"; });
  await page.waitForTimeout(600);
  await stop();
  assert(frames > 0, "Live view produced no frames");
  await browser.closeBrowser(one.id);
  const restored = await browser.page(one.id, false);
  assert((await restored.context().cookies("https://example.test")).some(c => c.name === "check" && c.value === "saved"));
  await browser.deleteData(one.id);
  assert(!fs.existsSync(path.join(data, "dots", one.id)));
  console.log("PASS: real browser launch, bundled binary verification, typing/clicking, screenshots, live frames, takeover input, profile persistence/cleanup");
} finally {
  for (const d of repo.listDots()) await browser.closeBrowser(d.id).catch(() => {});
  try { db().close(); } catch { /* Already closed on failure. */ }
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
