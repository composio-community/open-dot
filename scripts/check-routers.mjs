// Actual SDK + router modules, synthetic HTTP responses only: no keys or paid requests.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
if (process.platform !== "win32") throw new Error("Run this router/vault acceptance check on Windows.");
const temp = fs.mkdtempSync(path.join(root, ".windows-check-routers-"));
process.env.DOTS_DATA_DIR = temp;
for (const name of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "TOKENROUTER_API_KEY", "TOKENROUTER_IO_API_KEY", "TOKENROUTER_ME_API_KEY", "AGENTROUTER_API_KEY", "NARAROUTER_API_KEY", "DOTS_MODEL", "DOTS_REVIEW_MODEL"]) delete process.env[name];
await import("./windows-test-loader.mjs");
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith("/src/server/agent/routers.ts") && specifier === "node:dns/promises") return { url: "data:text/javascript," + encodeURIComponent("export async function lookup(host){return [{address:host==='private.fixture.test'?'127.0.0.1':'203.0.113.10',family:4}]};"), shortCircuit: true };
  return next(specifier, context);
} });
const originalFetch = globalThis.fetch;
const { FREE_OPENROUTER_MODEL, ROUTER_PROVIDERS } = await import("../src/lib/model-providers.ts");
for (const p of ROUTER_PROVIDERS) delete process.env[`${p.env.replace(/_API_KEY$/, "")}_BASE_URL`];
const requests = [];
let failure = 0, streamMode = "normal", catalogMode = "normal", errorResponse = null;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const body = init.body ? JSON.parse(init.body) : null;
  const headers = new Headers(init.headers);
  requests.push({ url: url.href, body, auth: headers.get("Authorization"), accept: headers.get("Accept"), redirect: init.redirect });
  if (errorResponse) return errorResponse();
  if (failure) return Response.json({ error: { message: headers.get("Authorization") } }, { status: failure });
  if (url.pathname.endsWith("/key")) return Response.json({ data: { label: "synthetic" } });
  if (url.pathname.endsWith("/models")) {
    if (url.hostname === "api.openai.com") return Response.json({ object: "list", data: [{ id: "gpt-5.5" }, { id: "gpt-5.4-mini" }], has_more: false });
    if (catalogMode === "missing") return Response.json({}, { status: 404 });
    if (catalogMode === "html") return new Response("<html>wrong endpoint</html>");
    if (catalogMode === "free" && url.hostname === "openrouter.ai") {
      const data = [{ id: "moonshotai/kimi-k2", supported_parameters: ["tools"] }, { id: "text-only-fixture", supported_parameters: ["temperature"] }, ...Array.from({ length: 220 }, (_, i) => ({ id: `paid-fixture-${i}` })), { id: "openrouter/free", supported_parameters: ["tools", "structured_outputs"] }];
      // Reproduce the public API: its server-side tools filter omits the free router.
      return Response.json({ data: url.searchParams.has("supported_parameters") ? data.filter((m) => m.id !== "openrouter/free") : data });
    }
    return Response.json({ data: [{ id: "fixture-model" }, { id: "text-embedding-fixture" }] });
  }
  // Reproduce the reported gateway reservation: an unset limit defaults to 131,072.
  const outputLimit = body.max_output_tokens ?? body.max_tokens ?? 131072;
  if (outputLimit > 2834) return Response.json({ error: { message: `This request requires more credits, or fewer max_tokens. You requested up to ${outputLimit} tokens, but can only afford 2834.` } }, { status: 402 });
  if (url.pathname.endsWith("/responses")) return Response.json({ id: "resp_fixture", object: "response", model: body.model, output: [{ type: "message", id: "msg_native", role: "assistant", status: "completed", content: [{ type: "output_text", text: body.text?.format?.name === "verdict" ? '{"applying_rules":[]}' : "native response", annotations: [] }] }], status: "completed" });
  assert(url.pathname.endsWith("/chat/completions"), "Unexpected request: network access refused by test");
  if (!body.stream) return Response.json({ id: "chat_fixture", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: '{"applying_rules":[]}', tool_calls: [] }, finish_reason: "stop" }] });
  const delta = (value, finish_reason = null) => ({ id: "chat_fixture", model: body.model, choices: [{ index: 0, delta: value, finish_reason }] });
  const chunks = [delta({ role: "assistant" }), delta({ content: "Hello " }), { choices: [] }, delta({ content: "router" }),
    delta({ tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: { name: "read_page", arguments: '{"url":' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: streamMode === "bad-arguments" ? "broken" : '"https://example.org"}' } }] })];
  if (streamMode !== "truncated") chunks.push(delta({}, streamMode === "length" ? "length" : "tool_calls"));
  const wire = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(wire, { headers: { "Content-Type": "text/event-stream" } });
};
const routers = await import("../src/server/agent/routers.ts");
const { clientFor, canThink, modelFor, models, resetModels, saveApiKey } = await import("../src/server/agent/client.ts");
const { chatRequest } = await import("../src/server/agent/router-chat.ts");
const { db, getSetting, setSetting } = await import("../src/server/db.ts");
const { seal } = await import("../src/server/vault.ts");
try {
  assert(!canThink());
  assert.match(await saveApiKey("tr_synthetic-only"), /router key/);
  assert.equal(requests.length, 0, "Wrong-provider keys must not be sent to OpenAI");
  // Legacy OpenRouter profiles are still readable.
  setSetting("openrouter_key", seal("fixture-legacy-secret"));
  assert.equal(routers.routerKey("openrouter"), "fixture-legacy-secret");
  assert.equal(routers.routerSource("openrouter"), "settings");
  for (const p of ROUTER_PROVIDERS) {
    const key = `fixture-secret-${p.id}`, before = requests.length;
    assert.equal(await routers.saveRouter(p.id, key, p.baseURL, ""), null, p.name);
    assert(requests.slice(before).every((r) => new URL(r.url).origin === new URL(p.baseURL).origin && r.auth === `Bearer ${key}` && r.redirect === "error"));
    assert(!getSetting(`router_config_${p.id}`).includes(key), "Router configuration must be encrypted");
    assert(!JSON.stringify(routers.routerStatuses()).includes(key), "Snapshot must never include secrets");
    const route = clientFor(`${p.id}:fixture-model`);
    assert.equal(route.model, "fixture-model"); assert(route.stateless);
    const result = await route.client.responses.create({ model: route.model, instructions: "fixture instructions", input: "Hi", text: { format: { type: "json_schema", name: "verdict", schema: { type: "object" }, strict: true } } });
    assert(result.output_text);
    const sent = requests.at(-1).body;
    assert.equal(p.responses ? sent.max_output_tokens : sent.max_tokens, 2048, "Default calls must fit the synthetic small balance");
    await route.client.responses.create({ model: route.model, input: "Short response", max_output_tokens: 512 });
    assert.equal(p.responses ? requests.at(-1).body.max_output_tokens : requests.at(-1).body.max_tokens, 512, "Explicit caller limits must be preserved");
    const beforeDenied = requests.length;
    await assert.rejects(() => route.client.responses.create({ model: route.model, input: "Too large", max_output_tokens: 4096 }), /402.*credits/);
    assert.equal(requests.length, beforeDenied + 1, "An unaffordable explicit limit must not trigger automatic paid retries");
    if (p.responses) assert.equal(sent.input, "Hi");
    else {
      assert.equal(sent.messages[0].role, "system");
      assert.equal(sent.response_format.json_schema.name, "verdict");
      assert(!("store" in sent) && !("previous_response_id" in sent));
      const stream = await route.client.responses.create({ model: route.model, instructions: "fixture", input: [{ role: "user", content: [{ type: "input_text", text: "Read this" }, { type: "input_image", image_url: "data:image/png;base64,Zml4dHVyZQ==", detail: "auto" }] }], tools: [{ type: "function", name: "read_page", parameters: { type: "object" }, strict: false }], stream: true }, { signal: new AbortController().signal });
      const events = []; for await (const e of stream) events.push(e);
      assert.equal(events.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join(""), "Hello router");
      const final = events.at(-1).response;
      assert.equal(events.at(-1).type, "response.completed");
      assert.equal(final.output[1].call_id, "call_fixture");
      assert.deepEqual(JSON.parse(final.output[1].arguments), { url: "https://example.org" });
      assert.equal(requests.at(-1).body.messages[1].content[1].type, "image_url");
      const replay = chatRequest({ model: route.model, input: [{ role: "user", content: "question" }, { type: "function_call", call_id: "c1", name: "read_page", arguments: "{}" }, { type: "function_call", call_id: "c2", name: "read_page", arguments: "{}" }, { type: "function_call_output", call_id: "c1", output: "first result" }, { type: "function_call_output", call_id: "c2", output: "second result" }] });
      assert.equal(replay.messages[1].tool_calls.length, 2); assert.equal(replay.messages[2].tool_call_id, "c1");
    }
    const old = getSetting(`router_config_${p.id}`);
    for (const status of [401, 402, 403, 429, 500]) {
      failure = status;
      const error = await routers.saveRouter(p.id, "fixture-replacement-secret", p.baseURL, "");
      assert(error?.includes(String(status))); assert(!error.includes("fixture-replacement-secret"));
      assert.equal(getSetting(`router_config_${p.id}`), old, "Failed replacement must retain the old key");
    }
    failure = 0;
  }
  assert(canThink()); resetModels();
  const available = (await models()).available;
  for (const p of ROUTER_PROVIDERS) assert(available.includes(`${p.id}:fixture-model`));
  assert.equal(available.length, ROUTER_PROVIDERS.length);
  // The free dispatcher must survive catalog truncation and coexist with paid keys.
  catalogMode = "free";
  assert.equal(await routers.saveRouter("openrouter", "fixture-free-secret", "https://openrouter.ai/api/v1", ""), null);
  process.env.OPENAI_API_KEY = "fixture-openai-secret";
  resetModels();
  const freeDefaults = await models();
  assert.equal(freeDefaults.main, FREE_OPENROUTER_MODEL);
  assert.equal(freeDefaults.review, FREE_OPENROUTER_MODEL);
  assert(freeDefaults.available.includes(FREE_OPENROUTER_MODEL));
  assert(!freeDefaults.available.includes("openrouter:text-only-fixture"), "Filter explicit non-tool OpenRouter models locally");
  assert.equal(freeDefaults.available.filter((id) => id.startsWith("openrouter:")).length, 200);
  assert.equal(await modelFor(null), FREE_OPENROUTER_MODEL);
  setSetting("default_model", "openrouter:paid-choice");
  assert.equal(await modelFor(null), "openrouter:paid-choice", "Keep an explicit Settings model");
  assert.equal(await modelFor("tokenrouter:dot-choice"), "tokenrouter:dot-choice", "Keep an explicit dot model");
  setSetting("default_model", null);
  process.env.DOTS_MODEL = "gpt-5.5"; process.env.DOTS_REVIEW_MODEL = "gpt-5.4-mini";
  resetModels();
  assert.equal((await models()).main, "gpt-5.5"); assert.equal((await models()).review, "gpt-5.4-mini");
  delete process.env.DOTS_MODEL; delete process.env.DOTS_REVIEW_MODEL;
  // Changing the synthetic key invalidates the catalog cache and exercises an outage.
  process.env.OPENROUTER_API_KEY = "fixture-outage-secret";
  failure = 503; resetModels();
  assert.equal((await models()).main, FREE_OPENROUTER_MODEL, "A catalog outage must not switch to a paid key");
  failure = 0; delete process.env.OPENROUTER_API_KEY;
  assert.equal(await routers.saveRouter("openrouter", "fixture-free-secret", "https://openrouter.ai/api/v1", "moonshotai/kimi-k2"), null);
  resetModels();
  assert(!(await models()).available.includes(FREE_OPENROUTER_MODEL), "Respect manual model lists");
  assert.equal(await routers.saveRouter("openrouter", "fixture-free-secret", "https://openrouter.ai/api/v1", ""), null);
  resetModels();
  const openClient = clientFor(FREE_OPENROUTER_MODEL).client;
  const functionTool = { type: "function", name: "read_page", parameters: { type: "object" } };
  const tools = [{ type: "openrouter:web_search" }, functionTool];
  for (const model of ["openrouter/free", "qwen/fixture:free", "moonshotai/kimi-k2"]) {
    await openClient.responses.create({ model, input: "Synthetic tool check", tools });
    assert.deepEqual(requests.at(-1).body.tools, model === "moonshotai/kimi-k2" ? tools : [functionTool], "Free models must retain function tools without billed hosted search, even on a shared cached client");
  }
  failure = 429;
  const beforeFreeDenied = requests.length;
  await assert.rejects(() => openClient.responses.create({ model: "openrouter/free", input: "Synthetic quota check" }), /429/);
  assert.equal(requests.length, beforeFreeDenied + 1, "A free quota error must not retry on a paid model");
  assert.equal(requests.at(-1).body.model, "openrouter/free");
  failure = 0;
  const repo = await import("../src/server/repo.ts");
  const { DEFAULT_LOOK } = await import("../src/lib/look.ts");
  const { autoTitle } = await import("../src/server/titles.ts");
  const { review } = await import("../src/server/agent/review.ts");
  const dot = repo.createDot({ name: "Budget fixture", purpose: "Offline budget check", look: DEFAULT_LOOK });
  const conversation = repo.createConversation(dot.id);
  await autoTitle(conversation.id, "A short synthetic chat");
  assert.equal(requests.at(-1).body.model, "openrouter/free", "Titles must stay free even with a paid OpenAI key saved");
  assert.equal(requests.at(-1).body.max_output_tokens, 256, "Automatic titles must not reserve the chat allowance");
  repo.addRule({ dotId: dot.id, action: "a synthetic action", decision: "ask" });
  assert.equal((await review(dot.id, "a synthetic action", "ask")).decision, "ask");
  assert.equal(requests.at(-1).body.model, "openrouter/free", "Rule review must use the free dispatcher");
  assert.equal(requests.at(-1).body.max_output_tokens, 512, "Rule reviews must use their smaller allowance");
  delete process.env.OPENAI_API_KEY;
  // The same HTTP status can be an API permission denial or a website/security page.
  const nara = ROUTER_PROVIDERS.find((p) => p.id === "nararouter");
  const oldNara = getSetting("router_config_nararouter"), replacement = "sk-nry-replacement-secret";
  errorResponse = () => Response.json({ error: { type: "forbidden", message: "Your account is suspended.", request_id: "req_fixture_403" } }, { status: 403 });
  const denied = await routers.saveRouter(nara.id, replacement, nara.baseURL, "manual-model");
  assert.match(denied, /403.*account is suspended.*forbidden.*req_fixture_403/);
  assert.equal(getSetting("router_config_nararouter"), oldNara, "403 must not save or bypass authorization using manual model IDs");
  assert.equal(requests.at(-1).accept, "application/json");
  const naraClient = clientFor("nararouter:fixture-model").client;
  await assert.rejects(() => naraClient.responses.create({ model: "fixture-model", input: "fixture" }), /account is suspended.*req_fixture_403/);
  errorResponse = () => new Response("<html>" + replacement + "</html>", { status: 403, headers: { "Content-Type": "text/html", "cf-mitigated": "challenge", "cf-ray": "abc123-SIN" } });
  const blocked = await routers.saveRouter(nara.id, replacement, nara.baseURL, "");
  assert.match(blocked, /403.*website\/security page.*abc123-SIN/);
  assert(!blocked.includes(replacement) && !blocked.includes("<html>") && !blocked.includes("plan"));
  for (const message of ["Bearer " + replacement, encodeURIComponent(replacement), "The upstream key sk-or-private-credential was rejected.", "Bearer unrelated-upstream-secret", "Bad key " + replacement + "\n" + "x".repeat(1000)]) {
    errorResponse = () => Response.json({ error: { type: replacement, message, request_id: replacement } }, { status: 403 });
    const masked = await routers.saveRouter(nara.id, replacement, nara.baseURL, "");
    assert(!masked.includes(replacement) && !masked.includes("sk-or-private-credential") && !masked.includes("unrelated-upstream-secret"));
    assert(masked.length < 900 && !masked.includes("\n"));
  }
  // Decode escaped/encoded keys before truncation and never expose other body fields.
  const encodedKey = "fixture-secret+/=";
  errorResponse = () => Response.json({ error: { message: encodeURIComponent(encodedKey), request_id: encodedKey }, debug: encodedKey }, { status: 403 });
  const encoded = await routers.saveRouter(nara.id, encodedKey, nara.baseURL, "");
  assert(!encoded.includes(encodedKey) && !encoded.includes(encodeURIComponent(encodedKey)));
  for (const body of ["{broken", JSON.stringify({ error: { message: "x".repeat(9000) + replacement } })]) {
    errorResponse = () => new Response(body, { status: 403, headers: { "Content-Type": "application/json" } });
    const fallback = await routers.saveRouter(nara.id, replacement, nara.baseURL, "");
    assert.match(fallback, /403.*provider denied/i); assert(!fallback.includes(replacement) && fallback.length < 300);
  }
  errorResponse = null;
  for (const base of ["http://example.org/v1", "https://127.0.0.1/v1", "https://localhost/v1", "https://user:secret@example.org/v1", "https://example.org/v1?key=secret", "https://example.org:8443/v1", "https://example.org/v1/chat/completions"]) assert.throws(() => routers.routerBaseURL(base));
  const beforePrivate = requests.length;
  assert.match(await routers.saveRouter("agentrouter", "fixture-secret", "https://private.fixture.test/v1", ""), /public internet/);
  assert.equal(requests.length, beforePrivate);
  catalogMode = "missing";
  assert.match(await routers.saveRouter("agentrouter", "fixture-secret", "https://agentrouter.org/v1", ""), /model IDs/);
  assert.equal(await routers.saveRouter("agentrouter", "fixture-secret", "https://agentrouter.org/v1", "manual-model"), null);
  assert((await routers.routerModels()).includes("agentrouter:manual-model"));
  catalogMode = "html";
  assert(await routers.saveRouter("agentrouter", "fixture-secret", "https://agentrouter.org/v1", ""));
  catalogMode = "normal";
  const client = clientFor("tokenrouter:fixture-model").client;
  for (const mode of ["truncated", "bad-arguments", "length"]) {
    streamMode = mode;
    const stream = await client.responses.create({ model: "fixture-model", input: "fixture", stream: true });
    await assert.rejects(async () => { for await (const ignored of stream) void ignored; }, /No (tool )?action was executed/i);
  }
  streamMode = "normal"; failure = 401;
  await assert.rejects(() => client.responses.create({ model: "fixture-model", input: "fixture" }), (e) => !String(e).includes("fixture-secret-tokenrouter") && /401/.test(String(e)));
  failure = 0;
  setSetting("default_model", "agentrouter:manual-model");
  assert.equal(await routers.saveRouter("agentrouter", "", "", ""), null);
  assert.equal(getSetting("default_model"), null);
  assert.equal(routers.routerSource("agentrouter"), null);
  // A restart must decrypt the saved configuration without a provider request.
  const code = "const r=await import('./src/server/agent/routers.ts'); if(r.routerKey('tokenrouter')!=='fixture-secret-tokenrouter')throw Error('Restart lost router key'); const d=await import('./src/server/db.ts'); d.db().close();";
  const restarted = spawnSync(process.execPath, ["--import", pathToFileURL(path.join(root, "scripts/windows-test-loader.mjs")).href, "--input-type=module", "-e", code], { cwd: root, env: { ...process.env }, encoding: "utf8", windowsHide: true });
  assert.equal(restarted.status, 0, restarted.stderr);
  // Losing the vault key must not mint a replacement over saved router credentials.
  db().close();
  fs.renameSync(path.join(temp, "vault.key.dpapi"), path.join(temp, "vault.key.dpapi.saved"));
  const lost = spawnSync(process.execPath, ["--import", pathToFileURL(path.join(root, "scripts/windows-test-loader.mjs")).href, "--input-type=module", "-e", "const v=await import('./src/server/vault.ts');v.seal('fixture');"], { cwd: root, env: { ...process.env }, encoding: "utf8", windowsHide: true });
  assert.notEqual(lost.status, 0); assert.match(lost.stderr, /vault key is missing/); assert(!fs.existsSync(path.join(temp, "vault.key.dpapi")));
  console.log("PASS: six router presets, free chat/title/review defaults, catalog truncation/outage, explicit model overrides, no billed hosted search or paid quota retries, isolated credential routing, real SDK transports, stream/tool replay, JSON review, catalog errors, private/redirect guards, secret masking, DPAPI persistence and missing-key refusal; all requests synthetic.");
} finally {
  globalThis.fetch = originalFetch;
  try { db().close(); } catch {}
  if (path.dirname(temp) !== root || fs.lstatSync(temp).isSymbolicLink()) throw new Error("Unexpected router test cleanup target");
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
