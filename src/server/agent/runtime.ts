import "server-only";
import type {
  ResponseComputerToolCall, ResponseFunctionToolCall, ResponseInputContent, ResponseInputItem, Response, Tool,
} from "openai/resources/responses/responses";
import { clientFor, isReasoningModel, modelFor, supportsComputerTool } from "./client";
import { systemPrompt, type Trigger } from "./prompt";
import { memoryContext as retrieveMemoryContext } from "../memory";
import { COMPUTER_ENABLED, findTool, setConsult, toolsForDot, type ToolCtx } from "./tools";
import { review } from "./review";
import * as repo from "../repo";
import * as computer from "../computer";
import type { ComputerAction } from "../computer/browser";
import { emit } from "../bus";
import * as composio from "../composio";
import type { AppTrigger, Attachment, CardData, Dot, Routine } from "@/lib/types";
import * as files from "../files";

type Call = ResponseFunctionToolCall | ResponseComputerToolCall;
type Pending = {
  responseId: string;
  calls: Call[];
  outputs: ResponseInputItem[];
  index: number; // next call to process
  cardId: string | null; // card the run is waiting on
  trigger: Trigger;
};
type InboxItem = { text: string; trigger: Trigger; conversationId: string; attachments?: Attachment[] };
// `after`: work queued while the dot was busy (e.g. an approval answered in another conversation).
type RunState = { running: boolean; abort: AbortController | null; inbox: InboxItem[]; after: (() => void)[] };

const MAX_STEPS = 60;
const g = globalThis as unknown as { __dotsRuns?: Map<string, RunState> };
const runs = (g.__dotsRuns ??= new Map());
const state = (dotId: string): RunState => {
  let s = runs.get(dotId);
  if (!s) runs.set(dotId, (s = { running: false, abort: null, inbox: [], after: [] }));
  s.after ??= [];
  return s;
};

// ---------------------------------------------------------------- public API

export function sendMessage(dotId: string, text: string, attachments: Attachment[] = [], conversationId?: string) {
  const dot = repo.getDot(dotId);
  if (!dot) throw new Error("No such dot");
  const conv = conversationId ?? repo.latestConversationId(dotId);
  repo.addMessage({ dotId, role: "user", text, attachments, conversationId: conv });
  if (dot.status === "paused") {
    repo.addMessage({ dotId, role: "system", text: `${dot.name} is paused. Resume it to pick this up.`, conversationId: conv });
  }
  state(dotId).inbox.push({ text, trigger: { kind: "chat" }, attachments, conversationId: conv });
  void pump(dotId);
}

/** Work handed off from a voice call. The user's words are already in the chat as voice lines, so no extra user message. */
export function queueTask(dotId: string, text: string, conversationId: string) {
  const dot = repo.getDot(dotId);
  if (!dot) throw new Error("No such dot");
  repo.addMessage({ dotId, role: "activity", text: `Voice task · ${text}`, conversationId, channelId: null });
  if (dot.status === "paused") repo.addMessage({ dotId, role: "system", text: `${dot.name} is paused. Resume it to pick this up.`, conversationId });
  state(dotId).inbox.push({ text: `${text}\n\n(Asked on a voice call.)`, trigger: { kind: "chat" }, conversationId });
  void pump(dotId);
}

/** The user posts in a channel: mentioned dots answer (@Name); otherwise the lead does, delegating as needed. */
export function sendToChannel(channelId: string, text: string) {
  const ch = repo.getChannel(channelId);
  if (!ch) throw new Error("No such channel");
  repo.addMessage({ dotId: ch.leadId, role: "user", text, channelId });
  const members = ch.memberIds.map((id) => repo.getDot(id)).filter((d): d is Dot => Boolean(d));
  const mentioned = members.filter((d) => new RegExp(`@${d.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text));
  const responders = mentioned.length ? mentioned : members.filter((d) => d.id === ch.leadId);
  for (const d of responders) {
    if (d.status === "paused") {
      repo.addMessage({ dotId: d.id, role: "system", text: `${d.name} is paused.`, channelId });
      continue;
    }
    state(d.id).inbox.push({
      text: `[#${ch.name}] ${text}`,
      trigger: { kind: "channel", channelId, name: ch.name },
      conversationId: repo.workConversation(d.id, "channel", channelId, `#${ch.name}`),
    });
    void pump(d.id);
  }
}

export function runRoutine(routine: Routine) {
  const dot = repo.getDot(routine.dotId);
  if (!dot || dot.status === "paused" || !routine.enabled) return;
  repo.updateRoutine(routine.id, { lastRunAt: Date.now() });
  // Each routine keeps its own conversation, so its runs read like a log you can open any time.
  const conv = repo.workConversation(dot.id, "chat", `routine:${routine.id}`, `Routine · ${routine.name}`);
  repo.addMessage({ dotId: dot.id, role: "system", text: `Routine “${routine.name}” started`, from: `routine:${routine.name}`, conversationId: conv });
  state(dot.id).inbox.push({ text: `[Routine: ${routine.name}] ${routine.instruction}`, trigger: { kind: "routine", name: routine.name }, conversationId: conv });
  void pump(dot.id);
}

/** A Composio trigger fired: run its dot on the instruction, in the trigger's own chat, from a fresh context. */
export function runTrigger(t: AppTrigger, event: Record<string, unknown>) {
  const dot = repo.getDot(t.dotId);
  if (!dot || dot.status === "paused" || !t.enabled) return;
  const conv = repo.workConversation(dot.id, "chat", `trigger:${t.id}`, `Trigger · ${t.name}`);
  repo.addMessage({ dotId: dot.id, role: "system", text: `Trigger “${t.name}” fired`, from: `trigger:${t.name}`, conversationId: conv });
  const data = JSON.stringify(event, null, 1).slice(0, 6000);
  state(dot.id).inbox.push({ text: `[Trigger: ${t.name}] ${t.instruction}\n\nWhat happened (${t.toolkit} event data):\n${data}`, trigger: { kind: "trigger", name: t.name }, conversationId: conv });
  void pump(dot.id);
}

export function stop(dotId: string) {
  const s = state(dotId);
  s.inbox = [];
  s.abort?.abort();
}

export function pause(dotId: string) {
  const dot = repo.getDot(dotId);
  if (!dot || dot.status === "paused") return;
  repo.updateDot(dotId, { status: "paused" });
  state(dotId).abort?.abort();
  repo.addMessage({ dotId, role: "system", text: `Paused. Any ongoing work was stopped, and ${dot.name} won't message you until you resume it.` });
  void computer.sleep(dotId).catch(() => {}); // its computer sleeps too (cloud boxes keep their state)
}

export function resume(dotId: string) {
  const dot = repo.getDot(dotId);
  if (!dot || dot.status !== "paused") return;
  const waiting = repo.pendingCards(dotId).length > 0;
  repo.updateDot(dotId, { status: waiting ? "waiting" : "idle" });
  repo.addMessage({ dotId, role: "system", text: `${dot.name} resumed.` });
  void pump(dotId);
}

/** The user answered a card: approve / deny / always allow an action, or answer a question. */
export async function resolveCard(messageId: string, choice: "approve" | "deny" | "always" | "answer", answer?: string) {
  const msg = repo.getMessage(messageId);
  const card = msg?.card;
  if (!msg || !card || card.status !== "pending") return;
  const dot = repo.getDot(msg.dotId);
  if (!dot || dot.status === "paused") return;

  const approved = choice === "approve" || choice === "always";
  const status: CardData["status"] = choice === "answer" ? "answered" : approved ? "approved" : "denied";
  repo.updateMessage(messageId, { card: { ...card, status, answer } });
  if (choice === "always" && card.ruleAction) repo.addRule({ dotId: dot.id, action: card.ruleAction, decision: "allow" });

  const convId = msg.conversationId ?? repo.latestConversationId(dot.id);
  const pending = parsePending(repo.threadOf(convId).pending);
  if (!pending || pending.cardId !== messageId) return;

  await withRun(dot.id, async (signal) => {
    repo.routeToConversation(dot.id, convId);
    repo.routeToChannel(dot.id, pending.trigger.kind === "channel" ? pending.trigger.channelId : null);
    const call = pending.calls[pending.index];
    pending.cardId = null;
    if (call.type === "computer_call") {
      if (!approved) {
        // Can't return a computer_call_output without acknowledging the checks; restart the thread instead.
        repo.setThread(dot.id, null, null);
        await turn(dot.id, `(I denied the on-screen action you asked about: ${card.detail ?? card.title}. Don't do it.)`, pending.trigger, signal, [], convId);
        return;
      }
      pending.outputs.push(await execComputer(dot, call, call.pending_safety_checks));
    } else {
      const def = findTool(call.name);
      let output: string;
      if (def?.pause === "question") output = `The user answered: ${answer ?? ""}`;
      else if (def?.pause === "approval") output = approved ? "The user approved. Go ahead." : "The user denied this. Do not do it; tell them briefly what you'll do instead, if anything.";
      else if (def?.pause === "connect") output = approved ? "Connected. Continue with the task." : "The user chose not to connect this app right now. Continue without it or tell them what you need.";
      else if (approved && def?.execute) output = await execTool(dot, call, signal);
      else output = "The user denied this action. Don't retry it; continue without it or ask what they'd prefer.";
      pending.outputs.push({ type: "function_call_output", call_id: call.call_id, output });
    }
    pending.index++;
    if (await processCalls(dot, pending, signal)) return;
    const latestUser = repo.conversationMessages(convId, 30).filter((m) => m.role === "user" && m.text).at(-1)?.text ?? card.title;
    const memoryCtx = retrieveMemoryContext(dot.id, latestUser, convId, dot.name);
    await drive(dot, pending.responseId, pending.outputs, pending.trigger, signal, memoryCtx.durable);
  });
}

// ---------------------------------------------------------------- run loop

async function pump(dotId: string) {
  const s = state(dotId);
  if (s.running) return;
  const dot = repo.getDot(dotId);
  if (!dot || dot.status === "paused" || !s.inbox.length) return;
  // Batch only items bound for the same place: a channel's messages go back to that channel.
  const where = (i: InboxItem) => (i.trigger.kind === "channel" ? `channel:${i.trigger.channelId}` : `conv:${i.conversationId}`);
  const head = where(s.inbox[0]);
  let n = 0;
  while (n < s.inbox.length && where(s.inbox[n]) === head) n++;
  const batch = s.inbox.splice(0, n);
  const trigger = batch.find((b) => b.trigger.kind === "chat")?.trigger ?? batch[batch.length - 1].trigger;
  const attachments = batch.flatMap((b) => b.attachments ?? []);
  const conversationId = batch[0].conversationId;
  let text = batch.map((b) => b.text).join("\n\n");
  // Catch the text agent up on anything said on a voice call in this chat.
  const voice = conversationId ? repo.takeVoiceTranscript(conversationId, dot.name) : "";
  if (voice) text = `[Voice call in this chat since your last turn — you (on the call) and the user said:]\n${voice}\n\n[Now:]\n${text}`;
  await withRun(dotId, (signal) => turn(dotId, text, trigger, signal, attachments, conversationId));
}

async function withRun(dotId: string, fn: (signal: AbortSignal) => Promise<void>) {
  const s = state(dotId);
  if (s.running) {
    s.after.push(() => void withRun(dotId, fn)); // e.g. an approval answered in another conversation
    return;
  }
  s.running = true;
  s.abort = new AbortController();
  const startedAt = Date.now();
  repo.updateDot(dotId, { status: "working" });
  try {
    await fn(s.abort.signal);
  } catch (err) {
    if (!s.abort.signal.aborted) {
      console.error("[dots] run failed", err);
      repo.addMessage({ dotId, role: "system", text: `Something went wrong: ${err instanceof Error ? err.message : String(err)}` });
    }
  } finally {
    s.running = false;
    s.abort = null;
    repo.routeToChannel(dotId, null);
    repo.setActivity(dotId, null);
    const dot = repo.getDot(dotId);
    if (dot && dot.status !== "paused") {
      repo.updateDot(dotId, { status: repo.pendingCards(dotId).length ? "waiting" : "idle" });
      notifyFinished(dot, startedAt);
    }
    repo.routeToConversation(dotId, null);
    const next = dot?.status !== "paused" ? s.after.shift() : undefined;
    if (next) next();
    else if (dot?.status !== "paused" && s.inbox.length) void pump(dotId);
  }
}

function notifyFinished(dot: Dot, since: number) {
  const fresh = repo.dotMessages(dot.id, 20).filter((m) => m.createdAt >= since && (m.role === "dot" || m.role === "card"));
  const last = fresh[fresh.length - 1];
  if (!last || last.title) return; // titled updates already notified
  const body = last.role === "card" ? `Needs your approval: ${last.card?.title ?? ""}` : last.text;
  emit({ type: "notify", dotId: dot.id, title: last.role === "card" ? `${dot.name} needs you` : dot.name, body: body.slice(0, 160) });
}

function historicalMemoryInput(history: string | null): ResponseInputItem[] {
  return history ? [{ role: "assistant", content: history }] : [];
}

async function turn(dotId: string, text: string, trigger: Trigger, signal: AbortSignal, attachments: Attachment[], conversationId: string) {
  repo.routeToConversation(dotId, conversationId);
  repo.routeToChannel(dotId, trigger.kind === "channel" ? trigger.channelId : null);
  const dot = repo.getDot(dotId)!;
  let { thread } = repo.getThread(dotId);
  const pending = parsePending(repo.getThread(dotId).pending);
  const input: ResponseInputItem[] = [];
  // Trigger runs start clean for each event, so a busy inbox doesn't pile up context. An approval
  // still open from the previous event expires, the same as when the user sends a new message.
  const fresh = trigger.kind === "trigger";
  if (pending) {
    const closed = closePending(dot, pending);
    if (closed && !fresh) input.push(...closed);
    else thread = null;
  }
  if (fresh) {
    repo.resetThread(conversationId);
    thread = null;
  }
  const { stateless } = clientFor(await modelFor(dot.model));
  if (!fresh && (stateless ? !repo.getHistory(dotId).length : !thread)) input.unshift(...rebuildContext(dotId, text));
  const memoryCtx = retrieveMemoryContext(dot.id, text, conversationId, dot.name);
  input.push(...historicalMemoryInput(memoryCtx.history));
  input.push(userInput(text, attachments));
  await drive(dot, thread, input, trigger, signal, memoryCtx.durable);
}

async function drive(dot: Dot, prevId: string | null, input: ResponseInputItem[], trigger: Trigger, signal: AbortSignal, memoryCtx: string) {
  for (let step = 0; step < MAX_STEPS; step++) {
    signal.throwIfAborted();
    let resp: Response;
    try {
      resp = await respond(dot, prevId, input, trigger, signal, memoryCtx);
    } catch (err) {
      if (!prevId || signal.aborted || clientFor(await modelFor(dot.model)).stateless || !/previous|not found|No tool output/i.test(String(err))) throw err;
      // The server-side thread is gone or broken: rebuild from our transcript and carry on.
      const userText = input.filter((i) => "role" in i && i.role === "user").map((i) => ("content" in i ? String(i.content) : "")).join("\n");
      input = [...rebuildContext(dot.id, userText), { role: "user", content: userText || "Continue." }];
      prevId = null;
      resp = await respond(dot, null, input, trigger, signal, memoryCtx);
    }
    repo.setThread(dot.id, clientFor(await modelFor(dot.model)).stateless ? null : resp.id, null);

    const calls = resp.output.filter((o): o is Call => o.type === "function_call" || o.type === "computer_call");
    if (!calls.length) return;
    const pending: Pending = { responseId: resp.id, calls, outputs: [], index: 0, cardId: null, trigger };
    if (await processCalls(dot, pending, signal)) return; // waiting on the user
    prevId = resp.id;
    input = pending.outputs;
  }
  repo.addMessage({ dotId: dot.id, role: "system", text: `Stopped after ${MAX_STEPS} steps. Say "continue" to keep going.` });
}

/** Stream one model response, mirroring text into the transcript as it arrives. */
async function respond(dot: Dot, prevId: string | null, input: ResponseInputItem[], trigger: Trigger, signal: AbortSignal, memoryCtx: string): Promise<Response> {
  const appModel = await modelFor(dot.model);
  const { client, model, stateless } = clientFor(appModel);
  const tools: Tool[] = [
    ...toolsForDot(dot).map((t): Tool => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: !stateless && t.strict !== false })),
    // OpenRouter's server-side search: the model decides when to search, same as OpenAI's web_search.
    stateless ? ({ type: "openrouter:web_search" } as unknown as Tool) : { type: "web_search" },
  ];
  if (!stateless && COMPUTER_ENABLED && supportsComputerTool(model)) tools.push({ type: "computer" } as Tool);

  // Stateless providers get the whole conversation every time; the app keeps it (trimmed) per chat.
  const history = stateless ? (repo.getHistory(dot.id) as ResponseInputItem[]) : [];
  repo.setActivity(dot.id, "Thinking");
  const stream = await client.responses.create(
    stateless
      ? { model, instructions: systemPrompt(dot, trigger, memoryCtx), input: [...history, ...input], tools, parallel_tool_calls: false, store: false, stream: true }
      : {
          model,
          instructions: systemPrompt(dot, trigger, memoryCtx),
          input,
          previous_response_id: prevId ?? undefined,
          tools,
          ...(isReasoningModel(model) ? { reasoning: { effort: "medium" as const } } : {}),
          truncation: "auto",
          parallel_tool_calls: false,
          store: true,
          stream: true,
        },
    { signal },
  );

  const drafts = new Map<string, { id: string; text: string }>();
  let final: Response | null = null;
  try {
    for await (const ev of stream) {
      switch (ev.type) {
        case "response.output_item.added":
          if (String(ev.item.type).includes("web_search")) repo.setActivity(dot.id, "Searching the web");
          else if (ev.item.type === "computer_call") repo.setActivity(dot.id, "Using its computer");
          else if (ev.item.type === "message") repo.setActivity(dot.id, "Writing");
          break;
        case "response.output_text.delta": {
          let d = drafts.get(ev.item_id);
          if (!d) {
            const m = repo.addMessage({ dotId: dot.id, role: "dot", text: "" });
            drafts.set(ev.item_id, (d = { id: m.id, text: "" }));
          }
          d.text += ev.delta;
          emit({ type: "message_delta", id: d.id, dotId: dot.id, delta: ev.delta });
          break;
        }
        case "response.output_item.done":
          if (ev.item.type === "message") {
            const d = drafts.get(ev.item.id);
            if (d) repo.updateMessage(d.id, { text: d.text });
          } else if (String(ev.item.type).includes("web_search")) {
            const action = (ev.item as { action?: { query?: string } }).action;
            activity(dot.id, "Searched the web", action?.query);
          }
          break;
        case "response.completed":
          final = ev.response;
          break;
        case "response.failed":
          throw new Error(ev.response.error?.message ?? "The model request failed");
        case "error":
          throw new Error(ev.message);
      }
    }
  } finally {
    // Persist whatever streamed, even if we were stopped mid-sentence.
    for (const d of drafts.values()) repo.updateMessage(d.id, { text: d.text || "…" });
  }
  if (!final) throw new Error("The model stream ended unexpectedly");
  if (stateless) {
    const persistentInput = input.filter((item) => !("role" in item && item.role === "assistant" && typeof item.content === "string" && item.content.startsWith("<retrieved_history>")));
    repo.setHistory(dot.id, trimHistory([...history.filter((item) => !("role" in item && item.role === "assistant" && typeof item.content === "string" && item.content.startsWith("<retrieved_history>"))), ...persistentInput, ...replayable(final.output)]));
  }
  return final;
}

/** The parts of a response worth sending back next turn: what the model said and the tools it called. */
function replayable(output: Response["output"]): ResponseInputItem[] {
  const items: ResponseInputItem[] = [];
  for (const o of output) {
    if (o.type === "message") {
      const text = o.content.map((c) => ("text" in c ? c.text : "")).join("");
      if (text) items.push({ role: "assistant", content: text });
    } else if (o.type === "function_call") {
      items.push({ type: "function_call", call_id: o.call_id, name: o.name, arguments: o.arguments });
    }
  }
  return items;
}

/** Keep the replayed history bounded: drop the oldest turns, always cutting at a user message. */
function trimHistory(items: ResponseInputItem[], maxItems = 80, maxChars = 160_000): ResponseInputItem[] {
  const size = (list: ResponseInputItem[]) => JSON.stringify(list).length;
  let start = 0;
  while (items.length - start > maxItems || size(items.slice(start)) > maxChars) {
    const next = items.findIndex((it, i) => i > start && "role" in it && it.role === "user");
    if (next < 0) break;
    start = next;
  }
  return items.slice(start);
}

/** Execute tool calls in order. Returns true if the run paused to wait for the user. */
async function processCalls(dot: Dot, pending: Pending, signal: AbortSignal): Promise<boolean> {
  for (; pending.index < pending.calls.length; pending.index++) {
    signal.throwIfAborted();
    savePending(dot.id, pending);
    const call = pending.calls[pending.index];

    if (call.type === "computer_call") {
      if (call.pending_safety_checks?.length) {
        const detail = call.pending_safety_checks.map((c) => c.message ?? c.code ?? "Sensitive action").join("\n");
        return pauseFor(dot, pending, { kind: "approval", status: "pending", title: "Review an on-screen action", detail, tool: "computer" });
      }
      pending.outputs.push(await execComputer(dot, call, []));
      continue;
    }

    const def = findTool(call.name);
    const args = safeParse(call.arguments);
    if (!def) {
      pending.outputs.push({ type: "function_call_output", call_id: call.call_id, output: `Unknown tool ${call.name}` });
      continue;
    }
    if (def.pause === "question") {
      return pauseFor(dot, pending, { kind: "question", status: "pending", title: String(args.question ?? ""), options: (args.options as string[]) ?? [] });
    }
    if (def.pause === "approval") {
      return pauseFor(dot, pending, { kind: "approval", status: "pending", title: String(args.action ?? ""), detail: String(args.details ?? ""), tool: def.name });
    }

    if (def.pause === "connect") {
      const toolkit = String(args.toolkit ?? "").trim().toLowerCase();
      const started = await composio.startConnect(toolkit).catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
      if ("error" in started) {
        pending.outputs.push({ type: "function_call_output", call_id: call.call_id, output: `Couldn't start connecting ${toolkit}: ${started.error}` });
        continue;
      }
      if (started.already) {
        pending.outputs.push({ type: "function_call_output", call_id: call.call_id, output: "Already connected." });
        continue;
      }
      pauseFor(dot, pending, {
        kind: "connect", status: "pending", title: `Connect ${started.name}`, toolkit, url: started.url,
        detail: `${dot.name} needs access to your ${started.name} to continue. You'll sign in with ${started.name} directly; ${dot.name} never sees your password.`,
      });
      const cardId = pending.cardId!;
      // Resume on its own as soon as the connection goes live (the OAuth callback route also resolves it).
      void started.wait().then(() => resolveCard(cardId, "approve")).catch(() => {});
      return true;
    }

    const ctx: ToolCtx = { dot, signal, depth: 0 };
    const blocked = await def.precheck?.(args, ctx).catch(() => null);
    if (blocked) {
      pending.outputs.push({ type: "function_call_output", call_id: call.call_id, output: blocked });
      continue;
    }
    if (def.describe) {
      const action = def.describe(args, ctx);
      repo.setActivity(dot.id, "Checking your rules");
      const verdict = await review(dot.id, action, (await def.defaultDecision?.(ctx, args)) ?? "allow");
      if (verdict.decision === "never") {
        activity(dot.id, "Blocked by your rule", verdict.rule?.action);
        pending.outputs.push({ type: "function_call_output", call_id: call.call_id, output: `Not allowed: the user's rule says never ${verdict.rule?.action ?? "do this"}. Don't try to work around it.` });
        continue;
      }
      if (verdict.decision === "ask") {
        return pauseFor(dot, pending, {
          kind: "approval", status: "pending", title: capitalize(action), tool: def.name, ruleAction: verdict.rule?.action ?? action,
          detail: [def.detail?.(args), verdict.rule ? `Your rule: ask first when it wants to ${verdict.rule.action}.` : null].filter(Boolean).join("\n\n") || undefined,
        });
      }
    }
    pending.outputs.push({ type: "function_call_output", call_id: call.call_id, output: await execTool(dot, call, signal) });
  }
  savePending(dot.id, pending);
  return false;
}

function pauseFor(dot: Dot, pending: Pending, card: CardData): true {
  const msg = repo.addMessage({ dotId: dot.id, role: "card", text: card.title, card });
  pending.cardId = msg.id;
  savePending(dot.id, pending);
  return true;
}

async function execTool(dot: Dot, call: ResponseFunctionToolCall, signal: AbortSignal): Promise<string> {
  const def = findTool(call.name)!;
  const args = safeParse(call.arguments);
  repo.setActivity(dot.id, def.label);
  activity(dot.id, def.label, summarize(args));
  try {
    return await def.execute!(args, { dot, signal, depth: 0 });
  } catch (err) {
    if (signal.aborted) throw err;
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function execComputer(
  dot: Dot, call: ResponseComputerToolCall, ack: ResponseComputerToolCall.PendingSafetyCheck[],
): Promise<ResponseInputItem> {
  repo.setActivity(dot.id, "Using its computer");
  activity(dot.id, "Using its computer");
  const actions = (call.actions ?? (call.action ? [call.action] : [])) as ComputerAction[];
  for (const a of actions) await computer.doAction(dot.id, a);
  const shot = await computer.screenshot(dot.id);
  return {
    type: "computer_call_output",
    call_id: call.call_id,
    output: { type: "computer_screenshot", image_url: `data:image/png;base64,${shot.toString("base64")}` },
    acknowledged_safety_checks: ack.map((c) => ({ id: c.id, code: c.code, message: c.message })),
  };
}

/** Close out calls left hanging (the user moved on / the run was stopped). Returns null if the thread must be reset. */
function closePending(dot: Dot, pending: Pending): ResponseInputItem[] | null {
  if (pending.cardId) {
    const card = repo.getMessage(pending.cardId)?.card;
    if (card?.status === "pending") repo.updateMessage(pending.cardId, { card: { ...card, status: "expired" } });
  }
  const outputs = [...pending.outputs];
  for (let i = pending.index; i < pending.calls.length; i++) {
    const call = pending.calls[i];
    if (call.type === "computer_call") return null;
    outputs.push({ type: "function_call_output", call_id: call.call_id, output: "Not run — the user sent a new message first." });
  }
  repo.setThread(dot.id, pending.responseId, null);
  return outputs;
}

function rebuildContext(dotId: string, exclude: string): ResponseInputItem[] {
  return repo
    .conversationMessages(repo.currentConversation(dotId), 40)
    .filter((m) => (m.role === "user" || m.role === "dot") && m.text && m.text !== exclude)
    .map((m) => ({ role: m.role === "user" ? ("user" as const) : ("assistant" as const), content: m.text }));
}

// ---------------------------------------------------------------- dot-to-dot

setConsult(async (target, message, from, _depth, signal) => {
  const channelId = repo.channelRoute(from.id);
  if (!channelId) repo.addMessage({ dotId: target.id, role: "user", text: message, from: `dot:${from.name}` });
  repo.setActivity(target.id, `Helping ${from.name}`);
  try {
    const { client, model, stateless } = clientFor(await modelFor(target.model));
    const targetMemory = retrieveMemoryContext(target.id, message, repo.currentConversation(target.id), target.name);
    const res = await client.responses.create(
      {
        model,
        instructions: systemPrompt(target, { kind: "dot", from: from.name }, targetMemory.durable),
        input: [...rebuildContext(target.id, message).slice(-12), ...historicalMemoryInput(targetMemory.history), { role: "user", content: `${from.name} asks: ${message}` }],
        tools: [stateless ? ({ type: "openrouter:web_search" } as unknown as Tool) : { type: "web_search" }],
        ...(stateless ? { store: false } : isReasoningModel(model) ? { reasoning: { effort: "low" as const } } : {}),
      },
      { signal },
    );
    const reply = res.output_text || "(no reply)";
    // In a channel the member answers in the channel (the user sees the team at work); otherwise in its own chat.
    repo.addMessage({ dotId: target.id, role: "dot", text: reply, from: `dot:${from.name}`, channelId });
    return `${target.name} replied: ${reply}`;
  } finally {
    repo.setActivity(target.id, null);
  }
});

// ---------------------------------------------------------------- helpers

/** A user turn with its attachments: images and PDFs go to the model directly; every file is also in the workspace. */
function userInput(text: string, attachments: Attachment[]): ResponseInputItem {
  if (!attachments.length) return { role: "user", content: text };
  const note = `\n\n[Attached: ${attachments.map((a) => `${a.name} (saved in your workspace at ${files.boxPathOf(a.id) ?? `uploads/${a.name}`})`).join("; ")}]`;
  const parts: ResponseInputContent[] = [{ type: "input_text", text: (text || "See the attached files.") + note }];
  for (const a of attachments) {
    const f = files.get(a.id);
    if (!f || f.size > 15 * 1024 * 1024) continue;
    const b64 = f.data().toString("base64");
    if (/^image\/(png|jpeg|gif|webp)$/.test(f.mime)) parts.push({ type: "input_image", image_url: `data:${f.mime};base64,${b64}`, detail: "auto" });
    else if (f.mime === "application/pdf") parts.push({ type: "input_file", filename: f.name, file_data: `data:application/pdf;base64,${b64}` });
  }
  return { role: "user", content: parts };
}

function activity(dotId: string, label: string, detail?: string) {
  const last = repo.dotMessages(dotId, 1)[0];
  const text = detail ? `${label} · ${detail}` : label;
  if (last?.role === "activity" && last.text === text) return;
  repo.addMessage({ dotId, role: "activity", text });
}

function summarize(a: Record<string, unknown>): string | undefined {
  const v = a.command ?? a.url ?? a.path ?? a.site ?? a.fact ?? a.name ?? a.dot_name;
  if (typeof v !== "string") return undefined;
  return v.length > 80 ? v.slice(0, 77) + "…" : v;
}

function savePending(dotId: string, pending: Pending) {
  repo.setThread(dotId, pending.responseId, JSON.stringify(pending));
}

function parsePending(raw: string | null): Pending | null {
  return raw ? (JSON.parse(raw) as Pending) : null;
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

const capitalize = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
