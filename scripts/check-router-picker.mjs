// Actual compiled server + browser UI, with synthetic catalog replies and no live keys.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { DatabaseSync } from "node:sqlite";
await import("./windows-test-loader.mjs");
const { ROUTER_PROVIDERS } = await import("../src/lib/model-providers.ts");
const root = path.resolve(import.meta.dirname, "..");
const commandCode = process.argv.includes("--commandcode");
const brokenHistory = process.argv.includes("--broken-history");
const approvalModes = process.argv.includes("--approval-modes");
assert(!approvalModes || commandCode, "Approval mode smoke requires --commandcode");
const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const reloads = Number(arg("--reloads", "0"));
assert(Number.isInteger(reloads) && reloads >= 0 && reloads <= 30, "Reload count must be between 0 and 30");
const serverDir = path.resolve(arg("--server", path.join(root, ".desktop/server")));
const browserExe = arg("--browser", path.join(root, ".desktop/browser/chromium-1243/chrome-win64/chrome.exe"));
const profile = fs.mkdtempSync(path.join(root, ".windows-check-router-picker-"));
const fixture = path.join(profile, "catalog.mjs"), requestLog = path.join(profile, "requests.jsonl");
fs.writeFileSync(fixture, `import fs from "node:fs";
import assert from "node:assert/strict";
function validTools(messages) {
  const waiting = new Set();
  for (const m of messages) {
    if (m.role === "tool") { assert(waiting.delete(m.tool_call_id), "Unexpected tool result"); continue; }
    const results = Array.isArray(m.content) ? m.content.filter(b=>b.type==="tool_result") : [];
    if (results.length) {
      assert(m.content.slice(0,results.length).every(b=>b.type==="tool_result"));
      for (const b of results) assert(waiting.delete(b.tool_use_id), "Unexpected Claude tool result");
    }
    assert.equal(waiting.size,0,"insufficient tool messages following tool_calls message");
    for (const c of m.tool_calls ?? []) waiting.add(c.id);
    for (const b of Array.isArray(m.content) ? m.content : []) if (b.type==="tool_use") waiting.add(b.id);
  }
  assert.equal(waiting.size,0,"insufficient tool messages following tool_calls message");
}
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = init.method ?? (input instanceof Request ? input.method : "GET");
  fs.appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify({url:url.href,method,legacyRuleReview:!!init.body && String(init.body).includes("legacy-ask-rule-fixture")}) + "\\n");
  if (${commandCode} && url.origin === "https://api.commandcode.ai" && url.pathname.startsWith("/provider/v1/")) {
    if (method === "GET" && url.pathname.endsWith("/models")) return Response.json({data:[{id:"deepseek/fixture-flash",supported_endpoints:["/chat/completions"]},{id:"claude-fixture",supported_endpoints:["/messages"]},{id:"typesafe/jev",supported_endpoints:["/systemone"]}]});
    const body = JSON.parse(init.body);
    try { validTools(body.messages); }
    catch(err) { return Response.json({error:{message:err.message}},{status:400}); }
    if (method === "POST" && url.pathname.endsWith("/chat/completions")) {
      if (body.response_format && String(init.body).includes("legacy-ask-rule-fixture")) return Response.json({error:{message:"Synthetic existing-rule reviewer outage"}},{status:400});
      const content = body.messages.findLast(m=>m.role==="user")?.content;
      const userText = typeof content === "string" ? content : (content ?? []).map(b=>b.text ?? "").join("");
      const mode = ${approvalModes} ? /^Approval mode (auto|balanced|ask|risky)$/.exec(userText)?.[1] : null;
      const riskReview = body.response_format?.json_schema?.schema?.properties?.requires_approval;
      const text = body.response_format ? JSON.stringify({applying_rules:[],...(riskReview ? {requires_approval:userText.includes("mode_risky"),reason:userText.includes("mode_risky")?"Synthetic uncertain effect":"Synthetic routine workspace work"} : {})}) : mode ? mode+" mode finished." : body.stream ? "Chat Completion route completed the offline demo." : "Command Code demo";
      const c = {id:"chat_cmd",model:body.model,choices:[{index:0,message:{role:"assistant",content:text},finish_reason:"stop"}]};
      if (!body.stream) return Response.json(c);
      if (mode && !body.messages.some(m=>m.role==="tool" && m.tool_call_id==="mode_"+mode+"_0")) {
        const tool_calls=Array.from({length:mode==="balanced"||mode==="auto"?2:1},(_,i)=>({index:i,id:"mode_"+mode+"_"+i,type:"function",function:{name:"run_command",arguments:JSON.stringify({command:"'mode-fixture' | "+(i?"Add-Content":"Set-Content")+" -LiteralPath mode_"+mode+".txt"})}}));
        return new Response('data: '+JSON.stringify({id:c.id,model:body.model,choices:[{index:0,delta:{tool_calls},finish_reason:"tool_calls"}]})+'\\n\\ndata: [DONE]\\n\\n',{headers:{"Content-Type":"text/event-stream"}});
      }
      return new Response('data: '+JSON.stringify({id:c.id,model:body.model,choices:[{index:0,delta:{content:text},finish_reason:"stop"}]})+'\\n\\ndata: [DONE]\\n\\n',{headers:{"Content-Type":"text/event-stream"}});
    }
    if (method === "POST" && url.pathname.endsWith("/messages") && body.stream) {
      if (${brokenHistory}) assert(body.messages.some(m=>m.content.some(b=>b.type==="tool_result"&&b.tool_use_id==="call_legacy"&&b.content.includes("may have started"))), "Broken legacy history was not repaired");
      const resumed = body.messages.some(m=>m.content.some(b=>b.type==="tool_result"&&b.tool_use_id==="call_demo"));
      const block = resumed ? {type:"text",text:""} : {type:"tool_use",id:"call_demo",name:"run_command",input:{}};
      const delta = resumed ? {type:"text_delta",text:"Command Code completed the offline demo."} : {type:"input_json_delta",partial_json:JSON.stringify({command:"Write-Output 'command-code-fixture'"})};
      const events=[{type:"message_start",message:{id:"msg_demo",model:body.model,content:[],stop_reason:null}},{type:"content_block_start",index:0,content_block:block},{type:"content_block_delta",index:0,delta},{type:"content_block_stop",index:0},{type:"message_delta",delta:{stop_reason:resumed?"end_turn":"tool_use"}},{type:"message_stop"}];
      return new Response(events.map(e=>'event: '+e.type+'\\ndata: '+JSON.stringify(e)+'\\n\\n').join(''),{headers:{"Content-Type":"text/event-stream"}});
    }
    throw new Error("Unsupported synthetic Command Code request");
  }
  if (method !== "GET" || url.origin !== "https://openrouter.ai" || url.pathname !== "/api/v1/models") throw new Error("External request refused by synthetic picker check");
  const data = [{id:"moonshotai/kimi-k3",supported_parameters:["tools"]},{id:"text-only-fixture",supported_parameters:["temperature"]},...Array.from({length:220},(_,i)=>({id:"paid-fixture-"+i,supported_parameters:["tools"]})),{id:"openrouter/free",supported_parameters:["tools","structured_outputs"]}];
  return Response.json({data:url.searchParams.has("supported_parameters") ? data.filter(m=>m.id!=="openrouter/free") : data});
};
`);
const env = { ...process.env, NODE_ENV: "production", NODE_OPTIONS: "", PORT: "3105", HOSTNAME: "127.0.0.1", DOTS_DESKTOP_INSTANCE: crypto.randomUUID(), DOTS_PUBLIC_URL: "http://localhost:3105", DOTS_DATA_DIR: path.join(profile, "data"), DOTS_COMPUTER: "local", DOTS_MODEL: "", DOTS_REVIEW_MODEL: "", OPENAI_API_KEY: "", COMPOSIO_API_KEY: "", E2B_API_KEY: "" };
for (const p of ROUTER_PROVIDERS) { env[p.env] = ""; env[`${p.env.replace(/_API_KEY$/, "")}_BASE_URL`] = ""; }
env.OPENROUTER_API_KEY = commandCode ? "" : "fixture-picker-only-secret";
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
  const pageErrors = [];
  page.on("pageerror", err => pageErrors.push(`${page.url()}\n${err.stack ?? err.message}`));
  await page.goto("http://localhost:3105/settings");
  const picker = page.locator('button[aria-haspopup="listbox"]');
  const evidence = path.join(root, ".windows-check-output/evidence");
  fs.mkdirSync(evidence, { recursive: true });
  if (commandCode) {
    const routers = page.locator("#open-models");
    await routers.getByLabel("Router provider", { exact: true }).selectOption("commandcode");
    assert.equal(await routers.getByLabel("Router API base URL", { exact: true }).inputValue(), "https://api.commandcode.ai/provider/v1");
    await routers.getByLabel("Command Code API key", { exact: true }).fill("fixture-commandcode-ui-only-secret");
    await routers.getByRole("button", { name: "Save", exact: true }).click();
    await routers.getByText(/Saved encrypted.*2 models loaded/).waitFor();
    await page.screenshot({ path: path.join(evidence, "windows-commandcode-settings.png") });
    await picker.click();
    assert.equal(await page.getByRole("option", { name: /typesafe\/jev/ }).count(), 0);
    await page.getByRole("option", { name: /^claude-fixture/ }).click();
    await page.reload();
    await picker.filter({ hasText: "claude-fixture" }).waitFor();
    await page.goto("http://localhost:3105/new");
    await page.getByPlaceholder("Pixel", { exact: true }).fill("Command Code check");
    await page.getByPlaceholder("What should it help with?").fill("Synthetic Command Code chat, approval and tool check");
    await page.getByRole("button", { name: "Create Command Code check", exact: true }).click();
    await page.waitForURL(/\/dots\/dot_/);
    await picker.filter({ hasText: /Default.*claude-fixture/ }).waitFor();
    if (brokenHistory) {
      const data = new DatabaseSync(path.join(profile, "data/dots.db"));
      try {
        const dotId = new URL(page.url()).pathname.split("/").pop();
        data.prepare("UPDATE conversations SET history = ? WHERE dot_id = ?").run(JSON.stringify([
          { role: "user", content: "An older interrupted request" },
          { type: "function_call", call_id: "call_legacy", name: "remember", arguments: '{"fact":"Must not execute this interrupted action"}' },
        ]), dotId);
      } finally { data.close(); }
    }
    const composer = page.getByPlaceholder("Message Command Code check…", { exact: true });
    await composer.fill("Run the harmless offline demo command.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByRole("button", { name: "Approve", exact: true }).waitFor({ timeout: 30000 });
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await page.getByText("Command Code completed the offline demo.", { exact: true }).waitFor({ timeout: 30000 });
    await page.screenshot({ path: path.join(evidence, "windows-commandcode-chat.png") });
    await picker.click(); await page.getByRole("option", { name: /^deepseek\/fixture-flash/ }).click();
    await composer.fill("Check the other Command Code protocol.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByText("Chat Completion route completed the offline demo.", { exact: true }).waitFor({ timeout: 30000 });
    if (approvalModes) {
      const base = new URL(page.url()).origin + new URL(page.url()).pathname;
      const dotId = new URL(page.url()).pathname.split("/").pop();
      await page.goto(base + "?tab=setup#approvals");
      const setupMode = page.locator("#approvals").getByLabel("Approval mode", { exact: true });
      assert.equal(await setupMode.inputValue(), "ask");
      await setupMode.selectOption("balanced");
      await setupMode.waitFor({ state: "visible" });
      await page.waitForFunction(() => [...document.querySelectorAll('#approvals select')].some(s=>!s.disabled && s.value==="balanced"));
      await page.reload(); assert.equal(await setupMode.inputValue(), "balanced");
      await page.screenshot({path:path.join(evidence,"windows-approval-modes.png")});
      await page.goto(base);
      await composer.fill("Approval mode balanced"); await page.getByRole("button",{name:"Send",exact:true}).click();
      await page.getByText("balanced mode finished.",{exact:true}).waitFor({timeout:30000});
      assert.equal(await page.getByRole("button",{name:"Approve",exact:true}).count(),0);
      // Sensitive/uncertain review still creates a real card; the model does not execute before approval.
      await composer.fill("Approval mode risky"); await page.getByRole("button",{name:"Send",exact:true}).click();
      await page.getByRole("button",{name:"Approve",exact:true}).waitFor({timeout:30000});
      assert(!fs.existsSync(path.join(profile,"data/dots",dotId,"workspace/mode_risky.txt")));
      await page.getByRole("link",{name:"Approval settings",exact:true}).click();
      await page.locator("#approvals").waitFor();
      await page.goto(base); await page.getByRole("button",{name:"Approve",exact:true}).click();
      await page.getByText("risky mode finished.",{exact:true}).waitFor({timeout:30000});
      // Existing user profiles already contain Allow/Ask rules. An unavailable reviewer must not prompt in Auto mode.
      const legacyRules = new DatabaseSync(path.join(profile,"data/dots.db"));
      try {
        const insert = legacyRules.prepare("INSERT INTO rules (id,dot_id,action,decision,created_at) VALUES (?,?,?,?,?)");
        for (let i=0;i<15;i++) insert.run("legacy_allow_"+i,dotId,"legacy allowed action "+i,"allow",Date.now());
        insert.run("legacy_ask",dotId,"legacy-ask-rule-fixture: spend money or send external messages","ask",Date.now());
      } finally { legacyRules.close(); }
      const headerMode = page.getByLabel("Approval mode",{exact:true});
      await headerMode.selectOption("auto");
      await page.waitForFunction(() => [...document.querySelectorAll('select[aria-label="Approval mode"]')].some(s=>!s.disabled&&s.value==="auto"));
      await page.reload(); assert.equal(await headerMode.inputValue(),"auto");
      await composer.fill("Approval mode auto"); await page.getByRole("button",{name:"Send",exact:true}).click();
      await page.getByText("auto mode finished.",{exact:true}).waitFor({timeout:30000});
      assert.equal(await page.getByRole("button",{name:"Approve",exact:true}).count(),0);
      for (const mode of ["auto","balanced"]) assert.equal(fs.readFileSync(path.join(profile,"data/dots",dotId,"workspace/mode_"+mode+".txt"),"utf8").trim().split(/\r?\n/).length,2,"Each command must execute exactly once");
      await page.setViewportSize({width:390,height:860}); await page.goto(base+"?tab=setup#approvals");
      await page.getByText("Inactive in Auto approve",{exact:true}).waitFor();
      const legacyRequests = fs.readFileSync(requestLog,"utf8").trim().split("\n").map(line=>JSON.parse(line));
      assert(!legacyRequests.some(r=>r.legacyRuleReview),"Auto mode must not send old Ask/Allow rules to an unavailable reviewer");
      const persistedRules = new DatabaseSync(path.join(profile,"data/dots.db"));
      try { assert.equal(persistedRules.prepare("SELECT COUNT(*) n FROM rules WHERE dot_id=?").get(dotId).n,16,"Mode changes must retain existing rules"); }
      finally { persistedRules.close(); }
      await setupMode.selectOption("ask");
      await page.waitForFunction(() => [...document.querySelectorAll('#approvals select')].some(s=>!s.disabled&&s.value==="ask"));
      await page.goto(base); await composer.fill("Approval mode ask"); await page.getByRole("button",{name:"Send",exact:true}).click();
      await page.getByRole("button",{name:"Approve",exact:true}).waitFor({timeout:30000});
      assert(!fs.existsSync(path.join(profile,"data/dots",dotId,"workspace/mode_ask.txt")));
      await page.getByRole("button",{name:"Approve",exact:true}).click();
      await page.getByText("ask mode finished.",{exact:true}).waitFor({timeout:30000});
      await page.setViewportSize({width:1300,height:860});
      console.log("PASS: packaged UI approval modes, Setup/header saves and reload persistence, repeated balanced/auto commands execute once without approval, old Ask/Allow rules retained without reviewer calls in Auto, risk/ask cards wait for approval, mobile controls and approval-settings link; synthetic provider only");
    }
    if (brokenHistory) {
      const data = new DatabaseSync(path.join(profile, "data/dots.db"));
      try { assert.equal(data.prepare("SELECT COUNT(*) n FROM memories").get().n, 0, "Recovery must not execute the legacy action"); }
      finally { data.close(); }
    }
    const requests = fs.readFileSync(requestLog, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert(requests.every(r => new URL(r.url).origin === "https://api.commandcode.ai"));
    assert(requests.some(r => r.method === "POST" && new URL(r.url).pathname.endsWith("/messages")));
    assert(requests.some(r => r.method === "POST" && new URL(r.url).pathname.endsWith("/chat/completions")));
    console.log("PASS: compiled-server Command Code save, catalog filtering, encrypted profile, Settings/dot pickers, selection persistence, real bot/tool approval and resumed Claude/chat protocol switching" + (brokenHistory ? ", strict provider accepted repaired legacy history without rerunning its action" : "") + "; synthetic APIs only");
  } else {
  await picker.filter({ hasText: "openrouter/free" }).waitFor();
  await picker.click();
  const free = page.getByRole("option", { name: /^openrouter\/free/ });
  await free.waitFor({ state: "visible" });
  assert.equal(await page.getByRole("option", { name: /text-only-fixture/ }).count(), 0);
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
  }
  const dotUrl = page.url();
  for (let i = 0; i < reloads; i++) {
    await page.setViewportSize({ width: i % 2 ? 1300 : 390, height: 860 });
    await page.goto("http://localhost:3105/settings");
    await page.locator('[aria-label="Open menu"]').waitFor({ state: "attached" });
    assert.equal(await page.locator('[aria-label="Open menu"]').count(), 1);
    await page.goto(dotUrl);
    await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
    assert.equal(await page.locator('[aria-label="Open menu"]').count(), 1, "Dot pages must not duplicate the mobile header");
  }
  assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  if (reloads) console.log(`PASS: ${reloads} Settings/dot hard-navigation round trips at mobile/desktop widths, correct menu count and no hydration/page errors`);
} catch (err) { throw new Error(`${err.message}\n${output}`, { cause: err }); }
finally {
  await browser?.close();
  if (server.exitCode === null) { const exited = new Promise(resolve => server.once("exit", resolve)); server.kill(); await exited; }
  if (path.dirname(profile) !== root || fs.lstatSync(profile).isSymbolicLink()) throw new Error("Unexpected picker profile cleanup target");
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
