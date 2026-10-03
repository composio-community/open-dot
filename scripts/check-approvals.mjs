// Local rule-gate check. Model responses are synthetic; this does not validate a live provider.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const temp = fs.mkdtempSync(path.join(root, ".windows-check-approvals-"));
process.env.DOTS_DATA_DIR = temp;
await import("./windows-test-loader.mjs");
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith("/src/server/agent/review.ts") && specifier === "./client") {
      const source = `export async function models(){return {review:'synthetic'}};
        export function clientFor(){return {model:'synthetic',stateless:false,client:{responses:{async create(){
          if(globalThis.reviewFixture instanceof Error) throw globalThis.reviewFixture;
          return {output_text:globalThis.reviewFixture};
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
try {
  const dot = repo.createDot({ name: "Rule fixture", purpose: "Offline synthetic approval check", look: DEFAULT_LOOK });
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
  console.log("PASS: actual rule gate with synthetic responses, conflict precedence, malformed output, provider outage and built-in refusals");
} finally {
  db().close();
  if (path.dirname(temp) !== root || fs.lstatSync(temp).isSymbolicLink()) throw new Error("Unexpected approval cleanup target");
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
