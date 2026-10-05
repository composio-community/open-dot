// Actual runtime + SQLite + SDK; strict synthetic providers, no live keys or actions outside this profile.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const profile = fs.mkdtempSync(path.join(root, ".windows-check-tool-history-"));
process.env.DOTS_DATA_DIR = profile;
process.env.DOTS_COMPUTER = "local";
await import("./windows-test-loader.mjs");
const { ROUTER_PROVIDERS } = await import("../src/lib/model-providers.ts");
for (const p of ROUTER_PROVIDERS) {
  delete process.env[p.env];
  delete process.env[`${p.env.replace(/_API_KEY$/, "")}_BASE_URL`];
}
for (const name of ["OPENAI_API_KEY", "COMPOSIO_API_KEY", "E2B_API_KEY", "DOTS_MODEL", "DOTS_REVIEW_MODEL"]) delete process.env[name];
for (const id of ["tokenrouter", "commandcode", "openrouter"]) process.env[ROUTER_PROVIDERS.find(p => p.id === id).env] = "fixture-history-only-secret";
const originalFetch = globalThis.fetch;
const originalError = console.error;
const expectedFailures = [];
console.error = (...args) => {
  if (args[0] === "[dots] run failed" && (args[1]?.message?.includes("Synthetic one-shot failure") || args[1]?.constructor.name === "ToolArgumentsError")) expectedFailures.push(args[1].message);
  else originalError(...args);
};
let failNext = false;
let scriptedCalls = [];
const requests = [];

// Provider-side protocol validation: every assistant call must get exactly one immediately following result.
function validate(messages) {
  let expected = new Set();
  for (const m of messages) {
    if (m.role === "tool") {
      assert(expected.delete(m.tool_call_id), "Unexpected/duplicate tool result");
      continue;
    }
    assert.equal(expected.size, 0, "insufficient tool messages following tool_calls message");
    expected = new Set((m.tool_calls ?? []).map(c => c.id));
  }
  assert.equal(expected.size, 0, "insufficient tool messages following tool_calls message");
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assert(["api.tokenrouter.com", "api.commandcode.ai", "openrouter.ai"].includes(url.hostname), "Live network refused");
  if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "fixture-model", supported_parameters: ["tools"] }] });
  const body = JSON.parse(init.body);
  let messages = body.messages;
  if (url.pathname.endsWith("/responses")) {
    messages = [];
    for (const i of body.input) {
      if (i.type === "function_call") {
        const last = messages.at(-1);
        if (last?.tool_calls) last.tool_calls.push({ id: i.call_id });
        else messages.push({ role: "assistant", tool_calls: [{ id: i.call_id }] });
      } else if (i.type === "function_call_output") messages.push({ role: "tool", tool_call_id: i.call_id });
      else if (i.role) messages.push({ role: i.role });
    }
  } else if (url.pathname.endsWith("/messages")) {
    messages = body.messages.flatMap(m => {
      const calls = m.content.filter(b => b.type === "tool_use");
      const results = m.content.filter(b => b.type === "tool_result");
      if (results.length) {
        assert(m.content.slice(0, results.length).every(b => b.type === "tool_result"), "Claude results must precede text");
        return results.map(b => ({ role: "tool", tool_call_id: b.tool_use_id }));
      }
      return [{ role: m.role, tool_calls: calls.map(b => ({ id: b.id })) }];
    });
  }
  requests.push({ path: url.pathname, body });
  try { validate(messages); }
  catch (err) { return Response.json({ error: { message: err.message } }, { status: 400 }); }
  if (failNext) { failNext = false; return Response.json({ error: { message: "Synthetic one-shot failure" } }, { status: 400 }); }
  const batch = scriptedCalls.shift();
  if (batch) {
    let events;
    if (url.pathname.endsWith("/messages")) {
      events = [{ type: "message_start", message: { id: "msg_arguments", model: body.model, content: [], stop_reason: null } }];
      batch.forEach((c, index) => events.push(
        { type: "content_block_start", index, content_block: { type: "tool_use", id: c.call_id, name: c.name, input: {} } },
        { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: c.arguments } },
        { type: "content_block_stop", index },
      ));
      events.push({ type: "message_delta", delta: { stop_reason: "tool_use" } }, { type: "message_stop" });
    } else if (url.pathname.endsWith("/responses")) {
      events = [{ type: "response.completed", response: { id: "resp_arguments", status: "completed", output: batch } }];
    } else {
      events = [{ id: "chat_arguments", model: body.model, choices: [{ index: 0, delta: { tool_calls: batch.map((c, index) => ({ index, id: c.call_id, type: "function", function: { name: c.name, arguments: c.arguments } })) }, finish_reason: "tool_calls" }] }];
    }
    return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  }
  if (url.pathname.endsWith("/messages")) {
    const events = [
      { type: "message_start", message: { id: "msg_history", model: body.model, content: [], stop_reason: null } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Recovered." } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" },
    ];
    return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
  }
  if (url.pathname.endsWith("/responses")) {
    const response = { id: "resp_history", object: "response", model: body.model, status: "completed", output: [{ type: "message", id: "msg_history", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Recovered.", annotations: [] }] }] };
    const events = [{ type: "response.output_text.delta", item_id: "msg_history", delta: "Recovered." }, { type: "response.completed", response }];
    return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
  }
  assert(url.pathname.endsWith("/chat/completions"));
  return new Response(`data: ${JSON.stringify({ id: "chat_history", model: body.model, choices: [{ index: 0, delta: { content: "Recovered." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
};
const repo = await import("../src/server/repo.ts");
const runtime = await import("../src/server/agent/runtime.ts");
const { db } = await import("../src/server/db.ts");
const { DEFAULT_LOOK } = await import("../src/lib/look.ts");
const call = (id, name = "ask_user", args = { question: "Synthetic question", options: [] }) => ({ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) });
async function send(dot, conversation, text) {
  runtime.sendMessage(dot.id, text, [], conversation.id);
  for (let i = 0; i < 200 && repo.getDot(dot.id).status === "working"; i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.notEqual(repo.getDot(dot.id).status, "working", "Runtime did not finish");
}
function history(dot, conversation) {
  repo.routeToConversation(dot.id, conversation.id);
  const h = repo.getHistory(dot.id);
  repo.routeToConversation(dot.id, null);
  return h;
}
try {
  for (const model of ["tokenrouter:fixture-model", "commandcode:claude-fixture", "openrouter:fixture-model"]) {
    const dot = repo.createDot({ name: "History check", purpose: "Offline", look: DEFAULT_LOOK });
    repo.updateDot(dot.id, { model });
    const conversation = repo.createConversation(dot.id);
    repo.routeToConversation(dot.id, conversation.id);
    // Already-broken legacy history, including duplicate/orphan outputs and a second unfinished batch.
    repo.setHistory(dot.id, [{ role: "user", content: "Original request" }, call("lost"), { role: "user", content: "Interrupted" },
      { type: "function_call_output", call_id: "lost", output: "Late legacy result" },
      call("done"), { type: "function_call_output", call_id: "done", output: "Real recorded result" },
      { type: "function_call_output", call_id: "done", output: "Duplicate" }, call("unfinished"), call("partial"),
      { type: "function_call_output", call_id: "partial", output: "Partial batch recorded result" }]);
    repo.routeToConversation(dot.id, null);
    runtime.pause(dot.id); runtime.resume(dot.id);
    await send(dot, conversation, "Continue after interruption");
    assert(repo.conversationMessages(conversation.id).some(m => m.role === "dot" && m.text === "Recovered."), "Legacy interrupted chat must recover without a 400");
    assert(history(dot, conversation).some(i => i.type === "function_call_output" && i.call_id === "done" && i.output === "Real recorded result"));
    assert(history(dot, conversation).some(i => i.type === "function_call_output" && i.call_id === "partial" && i.output === "Partial batch recorded result"));
    assert(history(dot, conversation).some(i => i.type === "function_call_output" && i.call_id === "lost" && i.output === "Late legacy result"));
    assert(history(dot, conversation).some(i => i.type === "function_call_output" && i.call_id === "unfinished" && i.output.includes("may have started")));

    // A new message expires a pending question; request failure must not discard its result or the new message.
    repo.routeToConversation(dot.id, conversation.id);
    const pendingCall = call("pending");
    repo.setHistory(dot.id, [{ role: "user", content: "Ask first" }, pendingCall]);
    const card = repo.addMessage({ dotId: dot.id, role: "card", text: "Synthetic question", card: { kind: "question", status: "pending", title: "Synthetic question", options: [] } });
    repo.setThread(dot.id, "resp_pending", JSON.stringify({ responseId: "resp_pending", calls: [pendingCall], outputs: [], index: 0, cardId: card.id, trigger: { kind: "chat" } }));
    repo.routeToConversation(dot.id, null);
    failNext = true;
    await send(dot, conversation, "Move on");
    assert.equal(repo.getMessage(card.id).card.status, "expired");
    assert(history(dot, conversation).some(i => i.type === "function_call_output" && i.call_id === "pending"), "Tool results must be durable even when the next request fails");
    assert(history(dot, conversation).some(i => i.role === "user" && i.content === "Move on"));
    await send(dot, conversation, "Continue");

    // Actual approval resume and safe memory tool execute once; failed continuation and retry must not duplicate results/actions.
    repo.routeToConversation(dot.id, conversation.id);
    const calls = [call("approve", "request_approval", { action: "Offline check", details: "No external action" }), call("remember", "remember", { fact: "Synthetic durable result" })];
    repo.setHistory(dot.id, [{ role: "user", content: "Do the offline check" }, ...calls]);
    const approval = repo.addMessage({ dotId: dot.id, role: "card", text: "Offline check", card: { kind: "approval", status: "pending", title: "Offline check" } });
    repo.setThread(dot.id, "resp_approval", JSON.stringify({ responseId: "resp_approval", calls, outputs: [], index: 0, cardId: approval.id, trigger: { kind: "chat" } }));
    repo.routeToConversation(dot.id, null);
    failNext = true;
    await runtime.resolveCard(approval.id, "approve");
    assert.equal(db().prepare("SELECT COUNT(*) n FROM memories WHERE dot_id = ?").get(dot.id).n, 1);
    await send(dot, conversation, "Continue after the request failure");
    assert.equal(db().prepare("SELECT COUNT(*) n FROM memories WHERE dot_id = ?").get(dot.id).n, 1, "Recovery must not execute a completed action again");
    const h = history(dot, conversation);
    for (const id of ["approve", "remember"]) assert.equal(h.filter(i => i.type === "function_call_output" && i.call_id === id).length, 1);
    const errors = repo.conversationMessages(conversation.id).filter(m => m.text.includes("Something went wrong:"));
    assert.equal(errors.length, 2, "Only deliberately injected failures are allowed");
    assert(errors.every(m => m.text.includes("Synthetic one-shot failure")));
  }
  assert(requests.some(r => r.path.endsWith("/responses")) && requests.some(r => r.path.endsWith("/messages")) && requests.some(r => r.path.endsWith("/chat/completions")));
  assert.equal(expectedFailures.length, 6, "Both one-shot failures must be exercised on every transport");
  for (const model of ["tokenrouter:fixture-model", "commandcode:claude-fixture", "openrouter:fixture-model"]) {
    const dot = repo.createDot({ name: "Argument recovery", purpose: "Offline", look: DEFAULT_LOOK });
    repo.updateDot(dot.id, { model, approvalMode: "auto" });
    const conversation = repo.createConversation(dot.id);
    const valid = call("corrected", "remember", { fact: "Corrected once" });
    const invalid = { ...call("invalid", "remember"), arguments: '{"fact":"C:\\Users\\fixture"}' };
    scriptedCalls = [[call("must_not_run", "remember", { fact: "Rejected batch" }), invalid], [valid]];
    const before = requests.length;
    await send(dot, conversation, "Remember the fixture");
    assert.equal(requests.length - before, 3, "One correction and one tool-result continuation expected");
    assert.equal(db().prepare("SELECT COUNT(*) n FROM memories WHERE dot_id = ?").get(dot.id).n, 1, "Only the corrected call may execute");
    const h = history(dot, conversation);
    assert(!h.some(i => i.call_id === "invalid" || i.call_id === "must_not_run"), "Rejected batch must not enter replay history");
    assert.equal(h.filter(i => i.type === "function_call_output" && i.call_id === "corrected").length, 1);
    assert(!repo.conversationMessages(conversation.id).some(m => m.text.includes("Something went wrong:")), "Malformed arguments should recover once");
    assert.equal(h.filter(i => i.role === "user" && i.content === "Remember the fixture").length, 1, "Correction must not duplicate the original input");
    const correctedRequest = requests[before + 1];
    assert.equal(correctedRequest.body.model, requests[before].body.model, "Recovery must not change models");
    assert.equal(correctedRequest.path, requests[before].path);
    assert.equal(correctedRequest.body.max_tokens ?? correctedRequest.body.max_output_tokens, 2048, "Recovery retains the output budget");

    for (const batches of [[[invalid], [invalid]], [[invalid], [valid], [invalid]]]) {
      const retryChat = repo.createConversation(dot.id);
      scriptedCalls = batches;
      const count = batches.length, start = requests.length;
      const memoriesBefore = db().prepare("SELECT COUNT(*) n FROM memories WHERE dot_id = ?").get(dot.id).n;
      await send(dot, retryChat, "Exercise bounded correction");
      assert.equal(requests.length - start, count, "Only one correction attempt is allowed across the whole run");
      assert.equal(db().prepare("SELECT COUNT(*) n FROM memories WHERE dot_id = ?").get(dot.id).n, memoriesBefore + (count === 3 ? 1 : 0));
      assert(repo.conversationMessages(retryChat.id).some(m => m.text.includes("Something went wrong:") && m.text.includes("smaller commands")), "Repeated malformed arguments must stop with an actionable error");
    }
  }
  console.log("PASS: actual runtime repairs interrupted history, persists results before failed requests, expires approvals, corrects malformed arguments once per run without partial batch execution or duplicate actions/input, preserves model/output budgets and stops repeated failures across Responses, Chat Completions and Claude; synthetic providers only");
} finally {
  globalThis.fetch = originalFetch;
  console.error = originalError;
  db().close();
  if (path.dirname(profile) !== root || fs.lstatSync(profile).isSymbolicLink()) throw new Error("Unexpected test cleanup target");
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
