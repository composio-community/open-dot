// Local rule-gate check. Model responses are synthetic; this does not validate a live provider.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const temp = fs.mkdtempSync(path.join(root, ".windows-check-approvals-"));
process.env.DOTS_DATA_DIR = temp;
process.env.DOTS_COMPUTER = "local";
delete process.env.DOTS_REVIEW_MODEL;
await import("./windows-test-loader.mjs");
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith("/src/server/agent/review.ts") && specifier === "./client") {
      const source = `export async function modelFor(model){return model || 'synthetic'};
        export function clientFor(model){globalThis.reviewModel=model;return {model,stateless:false,client:{responses:{async create(body){
          globalThis.reviewBody=body;globalThis.reviewCount=(globalThis.reviewCount||0)+1;
          if(globalThis.reviewFixture instanceof Error) throw globalThis.reviewFixture;
          return {output_text:globalThis.reviewFixture};
        }}}}};`;
      return { url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true };
    }
    if (context.parentURL?.endsWith("/src/server/agent/runtime.ts") && specifier === "./client") {
      const source = `export async function modelFor(model){return model || 'synthetic'};
        export function isReasoningModel(){return false};export function supportsComputerTool(){return false};
        export function clientFor(){return {model:'synthetic',stateless:true,client:{responses:{async create(body){
          globalThis.runtimePrompts.push(body.instructions);
          const output=globalThis.approvalCalls.splice(0);
          return (async function*(){yield {type:'response.completed',response:{id:'resp_'+crypto.randomUUID(),output}}})();
        }}}}};`;
      return { url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true };
    }
    return next(specifier, context);
  },
});
const { review } = await import("../src/server/agent/review.ts");
const repo = await import("../src/server/repo.ts");
const { db } = await import("../src/server/db.ts");
const { DEFAULT_LOOK } = await import("../src/lib/look.ts");
const runtime = await import("../src/server/agent/runtime.ts");
const { workspaceDir } = await import("../src/server/computer/shell.ts");
globalThis.runtimePrompts = [];
globalThis.approvalCalls = [];
const tool = (name, args) => ({ type: "function_call", name, arguments: JSON.stringify(args), call_id: crypto.randomUUID() });
async function run(dot, calls) {
  globalThis.approvalCalls = calls;
  const conv = repo.createConversation(dot.id);
  runtime.sendMessage(dot.id, "Harmless offline approval fixture", [], conv.id);
  for (let i = 0; i < 400 && repo.getDot(dot.id).status === "working"; i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.notEqual(repo.getDot(dot.id).status, "working");
  assert(!repo.conversationMessages(conv.id).some(m => m.text.includes("Something went wrong")));
  return repo.conversationMessages(conv.id).filter(m => m.card?.status === "pending");
}
try {
  const dot = repo.createDot({ name: "Rule fixture", purpose: "Offline synthetic approval check", look: DEFAULT_LOOK });
  assert.equal(dot.approvalMode, "ask", "Existing approval behavior is preserved until the user chooses a mode");
  assert.equal((await review(dot.id, "synthetic safe action", "allow")).decision, "allow");
  assert.equal((await review(dot.id, "synthetic blocked action", "never")).decision, "never");
  const allowed = repo.addRule({ dotId: dot.id, action: "synthetic action", decision: "allow" });
  repo.addRule({ dotId: null, action: "synthetic action", decision: "ask" });
  globalThis.reviewFixture = '{"applying_rules":[1,2]}';
  assert.equal((await review(dot.id, "synthetic action", "allow")).decision, "ask", "Ask beats allow across per-dot and global rules");
  globalThis.reviewFixture = new Error("Synthetic provider outage");
  assert.equal((await review(dot.id, "synthetic action", "allow")).decision, "ask", "Outage must not silently allow a ruled action");
  const never = repo.addRule({ dotId: dot.id, action: "synthetic action", decision: "never" });
  const rules = repo.rulesFor(dot.id);
  const all = rules.map((_, i) => i + 1);
  globalThis.reviewFixture = JSON.stringify({ applying_rules: all });
  const blocked = await review(dot.id, "synthetic action", "allow");
  assert.equal(blocked.decision, "never");
  assert.equal(blocked.rule.id, never.id);
  globalThis.reviewFixture = JSON.stringify({ applying_rules: [rules.findIndex(r => r.id === allowed.id) + 1] });
  assert.equal((await review(dot.id, "synthetic action", "allow")).decision, "allow");
  assert.equal((await review(dot.id, "synthetic action", "never")).decision, "never", "Rules cannot override a built-in refusal");
  for (const invalid of ["not JSON", "null", '{"applying_rules":[999]}', '{"applying_rules":["1"]}', '{"applying_rules":null}']) {
    globalThis.reviewFixture = invalid;
    assert.equal((await review(dot.id, "synthetic action", "allow")).decision, "never", "Malformed review must not bypass a never rule");
  }
  globalThis.reviewFixture = new Error("Synthetic provider outage");
  assert.equal((await review(dot.id, "synthetic action", "allow")).decision, "never");
  globalThis.reviewFixture = '{"applying_rules":[]}';
  assert.equal((await review(dot.id, "unrelated action", "ask")).decision, "ask");
  for (const rule of repo.rulesFor(dot.id)) repo.deleteRule(rule.id);
  const second = repo.createDot({ name: "Independent bot", purpose: "Offline", look: DEFAULT_LOOK });
  repo.updateDot(dot.id, { model: "fixture:selected-bot-model", approvalMode: "balanced" });
  globalThis.reviewFixture = '{"applying_rules":[],"requires_approval":false,"reason":"Routine workspace read"}';
  assert.equal((await review(dot.id, "read data", "ask", "Get-Content data.json")).decision, "allow");
  assert.equal(globalThis.reviewModel, "fixture:selected-bot-model");
  assert(globalThis.reviewBody.input.includes("Get-Content data.json"));
  assert(globalThis.reviewBody.instructions.includes("not an OS sandbox"));
  assert.equal(repo.getDot(second.id).approvalMode, "ask", "Modes are scoped to one bot");
  // Persistence, including additive migration with the pre-existing dot/chat rows retained.
  const before = repo.createConversation(dot.id);
  db().close(); globalThis.__dotsDb = undefined;
  assert.equal(repo.getDot(dot.id).approvalMode, "balanced");
  assert.equal(repo.getConversation(before.id).dotId, dot.id);
  assert.throws(() => repo.updateDot(dot.id, { approvalMode: "invalid" }), /Invalid approval mode/);
  assert.equal(repo.getDot(dot.id).approvalMode, "balanced");
  for (const invalid of ['{"applying_rules":[]}', '{"applying_rules":[],"requires_approval":"false","reason":"x"}', "null", "not JSON", new Error("Offline reviewer outage")]) {
    globalThis.reviewFixture = invalid;
    const v = await review(dot.id, "read data", "ask");
    assert.equal(v.decision, "ask"); assert(v.reason.includes("Couldn't check"));
  }
  globalThis.reviewFixture = '{"applying_rules":[],"requires_approval":true,"reason":"Changes outside workspace"}';
  assert.equal((await review(dot.id, "change data", "ask")).decision, "ask");
  const safeCommand = "'approval-fixture' | Set-Content -LiteralPath approved.txt";
  // The real runtime executes two harmless commands without cards in balanced mode.
  globalThis.reviewFixture = '{"applying_rules":[],"requires_approval":false,"reason":"Routine workspace work"}';
  assert.equal((await run(dot, [tool("run_command", { command: safeCommand }), tool("run_command", { command: "Get-Content -LiteralPath approved.txt" })])).length, 0);
  assert.equal(fs.readFileSync(path.join(workspaceDir(dot.id), "approved.txt"), "utf8").trim(), "approval-fixture");
  globalThis.reviewFixture = '{"applying_rules":[],"requires_approval":true,"reason":"Uncertain effect"}';
  const waiting = await run(dot, [tool("run_command", { command: "'must-not-run' | Set-Content blocked.txt" })]);
  assert.equal(waiting.length, 1); assert(waiting[0].card.detail.includes("Uncertain effect"));
  assert(!fs.existsSync(path.join(workspaceDir(dot.id), "blocked.txt")));
  await runtime.resolveCard(waiting[0].id, "deny");
  // Auto mode avoids a reviewer request when no custom rules exist, even if it is unavailable.
  repo.updateDot(dot.id, { approvalMode: "auto" });
  globalThis.reviewFixture = new Error("Reviewer must not be called");
  const count = globalThis.reviewCount;
  assert.equal((await run(dot, [tool("request_approval", { action: "Read fixture data", details: "Offline" }), tool("run_command", { command: safeCommand })])).length, 0);
  assert.equal(globalThis.reviewCount, count);
  assert(globalThis.runtimePrompts.at(-1).includes("Approval mode: Auto approve"));
  // Reproduce the existing-profile bug: old Allow/Ask rules + failed reviewer prompted on every command in Auto mode.
  const legacyAllow = Array.from({ length: 15 }, (_, i) => repo.addRule({ dotId: dot.id, action: `legacy allowed action ${i}`, decision: "allow" }));
  const ask = repo.addRule({ dotId: dot.id, action: "run commands", decision: "ask" });
  assert.equal((await review(dot.id, "read workspace JSON", "ask")).decision, "allow", "Auto approve must not depend on reviewing saved Ask/Allow rules");
  assert.equal((await run(dot, [tool("request_approval", { action: "Read workspace JSON", details: "Offline fixture" }), tool("run_command", { command: safeCommand }), tool("run_command", { command: "Get-Content approved.txt" })])).length, 0);
  assert.equal(globalThis.reviewCount, count, "An unavailable reviewer must not restore approval prompts in Auto mode");
  assert(!globalThis.runtimePrompts.at(-1).includes("When you want to run commands: ask first"));
  // Stored Ask rules are retained and apply again when Auto mode is disabled.
  repo.updateDot(dot.id, { approvalMode: "ask" });
  const askIndex = repo.rulesFor(dot.id).findIndex(r => r.id === ask.id) + 1;
  globalThis.reviewFixture = JSON.stringify({ applying_rules: [askIndex] });
  assert.equal((await review(dot.id, "run commands", "allow")).decision, "ask");
  repo.updateDot(dot.id, { approvalMode: "auto" });
  for (const rule of legacyAllow) repo.deleteRule(rule.id);
  // Never rules and built-in refusal always retain precedence over Auto approve.
  const deny = repo.addRule({ dotId: null, action: "run commands", decision: "never" });
  globalThis.reviewFixture = new Error("Reviewer unavailable for Never rule");
  assert.equal((await review(dot.id, "run commands", "ask")).decision, "never");
  globalThis.reviewFixture = '{"applying_rules":[1]}';
  assert.equal((await run(dot, [tool("run_command", { command: "'never' | Set-Content never.txt" })])).length, 0);
  assert(!fs.existsSync(path.join(workspaceDir(dot.id), "never.txt")));
  assert.equal((await review(dot.id, "anything", "never")).decision, "never");
  repo.deleteRule(deny.id);
  repo.deleteRule(ask.id);
  const questions = await run(dot, [tool("ask_user", { question: "Missing information", options: [] })]);
  assert.equal(questions[0].card.kind, "question");
  await runtime.resolveCard(questions[0].id, "answer", "Fixture answer");
  const checks = await run(dot, [{ type: "computer_call", call_id: "safety", pending_safety_checks: [{ id: "check", message: "Safety check" }] }]);
  assert.equal(checks[0].card.tool, "computer", "Native computer safety checks cannot be bypassed by a mode");
  runtime.stop(dot.id);
  assert.equal((await run(dot, [tool("run_on_my_computer", { command: "throw 'Must not execute without local access'" })])).length, 0);
  repo.routeToConversation(dot.id, repo.latestConversationId(dot.id));
  assert(repo.getHistory(dot.id).some(i => i.type === "function_call_output" && i.output.includes("no longer have access")), "Auto approval must not enable the personal-computer tool");
  repo.routeToConversation(dot.id, null);
  repo.updateDot(dot.id, { approvalMode: "ask" });
  const strict = await run(dot, [tool("run_command", { command: safeCommand })]);
  assert.equal(strict.length, 1, "Switching back restores ordinary approval prompts");
  runtime.stop(dot.id);
  console.log("PASS: actual rule gate and runtime, persisted per-bot modes, automatic commands/approval tools, legacy Ask/Allow rules retained without reviewer calls in Auto, restored Ask rules outside Auto, Never refusal on reviewer failure, question/safety/local-access checks; synthetic providers only");
} finally {
  db().close();
  if (path.dirname(temp) !== root || fs.lstatSync(temp).isSymbolicLink()) throw new Error("Unexpected approval cleanup target");
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
