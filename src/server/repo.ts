import "server-only";
import { db, getSetting, id, setSetting } from "./db";
import { emit } from "./bus";
import { Cron } from "croner";
import { normalizeLook } from "@/lib/look";
import type {
  AppTrigger, Attachment, CardData, Channel, Conversation, Dot, DotStatus, Look, Memory, Message, MessageRole, PasswordEntry, Routine, Rule, RuleDecision, Skill,
} from "@/lib/types";

type Row = Record<string, unknown>;
const now = () => Date.now();

// ---------- dots ----------

const toDot = (r: Row): Dot => ({
  id: r.id as string,
  name: r.name as string,
  purpose: r.purpose as string,
  instructions: r.instructions as string,
  look: normalizeLook(JSON.parse(r.look as string)),
  status: r.status as DotStatus,
  activity: activity.get(r.id as string) ?? null,
  localAccess: r.local_access === 1,
  model: (r.model as string) ?? null,
  createdAt: r.created_at as number,
});

// Transient "what is the dot doing right now" label; not persisted.
const g = globalThis as unknown as { __dotsActivity?: Map<string, string | null> };
const activity = (g.__dotsActivity ??= new Map());

export function listDots(): Dot[] {
  return db().prepare("SELECT * FROM dots ORDER BY created_at").all().map(toDot);
}

export function getDot(dotId: string): Dot | null {
  const r = db().prepare("SELECT * FROM dots WHERE id = ?").get(dotId);
  return r ? toDot(r) : null;
}

export function findDotByName(name: string): Dot | null {
  const r = db().prepare("SELECT * FROM dots WHERE lower(name) = lower(?)").get(name.trim());
  return r ? toDot(r) : null;
}

export function createDot(input: { name: string; purpose: string; instructions?: string; look: Look }): Dot {
  const dotId = id("dot");
  db().prepare("INSERT INTO dots (id, name, purpose, instructions, look, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(dotId, input.name, input.purpose, input.instructions ?? "", JSON.stringify(input.look), now());
  const dot = getDot(dotId)!;
  emit({ type: "dot", data: dot });
  return dot;
}

export function updateDot(
  dotId: string,
  patch: Partial<Pick<Dot, "name" | "purpose" | "instructions" | "look" | "status" | "localAccess" | "model">>,
): Dot | null {
  const cols: string[] = [];
  const vals: (string | number | null)[] = [];
  if (patch.name !== undefined) {
    cols.push("name = ?");
    vals.push(patch.name);
  }
  if (patch.purpose !== undefined) {
    cols.push("purpose = ?");
    vals.push(patch.purpose);
  }
  if (patch.instructions !== undefined) {
    cols.push("instructions = ?");
    vals.push(patch.instructions);
  }
  if (patch.look !== undefined) {
    cols.push("look = ?");
    vals.push(JSON.stringify(patch.look));
  }
  if (patch.status !== undefined) {
    cols.push("status = ?");
    vals.push(patch.status);
  }
  if (patch.model !== undefined) {
    cols.push("model = ?");
    vals.push(patch.model);
  }
  if (patch.localAccess !== undefined) {
    cols.push("local_access = ?");
    vals.push(patch.localAccess ? 1 : 0);
  }
  if (cols.length) db().prepare(`UPDATE dots SET ${cols.join(", ")} WHERE id = ?`).run(...vals, dotId);
  const dot = getDot(dotId);
  if (dot) emit({ type: "dot", data: dot });
  return dot;
}

export function setActivity(dotId: string, label: string | null) {
  if (activity.get(dotId) === label) return;
  activity.set(dotId, label);
  const dot = getDot(dotId);
  if (dot) emit({ type: "dot", data: dot });
}

export function deleteDot(dotId: string) {
  const d = db();
  for (const t of ["messages", "memories", "skills", "routines", "triggers", "rules", "conversations"]) d.prepare(`DELETE FROM ${t} WHERE dot_id = ?`).run(dotId);
  d.prepare("DELETE FROM dots WHERE id = ?").run(dotId);
  emit({ type: "dot_deleted", id: dotId });
}

// Conversation thread (OpenAI previous_response_id) and pending tool state for approvals.
// ---------- conversations ----------
// A dot has many conversations (like ChatGPT chats). While a dot works, the runtime routes it to one
// conversation; its model thread (previous_response_id), pending approvals, and messages live there.
// Routines and channel work use hidden conversations (kind "routine" / "channel") so they don't clutter the list.

const toConversation = (r: Row): Conversation => ({
  id: r.id as string, dotId: r.dot_id as string, title: r.title as string, model: (r.model as string) ?? null, createdAt: r.created_at as number, updatedAt: r.updated_at as number,
});

export function listConversations(dotId?: string): Conversation[] {
  const q = dotId
    ? db().prepare("SELECT * FROM conversations WHERE dot_id = ? AND kind = 'chat' ORDER BY updated_at DESC").all(dotId)
    : db().prepare("SELECT * FROM conversations WHERE kind = 'chat' ORDER BY updated_at DESC").all();
  return q.map(toConversation);
}

export function getConversation(convId: string): Conversation | null {
  const r = db().prepare("SELECT * FROM conversations WHERE id = ?").get(convId);
  return r ? toConversation(r) : null;
}

export function createConversation(dotId: string, title = "New chat", kind = "chat", ref: string | null = null, model: string | null = null): Conversation {
  const convId = id("conv");
  db().prepare("INSERT INTO conversations (id, dot_id, title, kind, ref, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(convId, dotId, title, kind, ref, model, now(), now());
  const c = getConversation(convId)!;
  if (kind === "chat") emit({ type: "conversation", data: c });
  return c;
}

/** A conversation reused across runs: a routine's (listed, kind "chat") or a dot's work in a channel (hidden). */
export function workConversation(dotId: string, kind: "chat" | "channel", ref: string, title: string): string {
  const r = db().prepare("SELECT id FROM conversations WHERE dot_id = ? AND kind = ? AND ref = ?").get(dotId, kind, ref) as Row | undefined;
  return (r?.id as string) ?? createConversation(dotId, title, kind, ref).id;
}

/** The dot's most recently active chat (created if it has none). */
export function latestConversationId(dotId: string): string {
  const r = db().prepare("SELECT id FROM conversations WHERE dot_id = ? AND kind = 'chat' ORDER BY updated_at DESC LIMIT 1").get(dotId) as Row | undefined;
  return (r?.id as string) ?? createConversation(dotId).id;
}

export function renameConversation(convId: string, title: string) {
  db().prepare("UPDATE conversations SET title = ? WHERE id = ?").run(title, convId);
  const c = getConversation(convId);
  if (c) emit({ type: "conversation", data: c });
}

export function setConversationModel(convId: string, model: string | null) {
  db().prepare("UPDATE conversations SET model = ? WHERE id = ?").run(model, convId);
  const c = getConversation(convId);
  if (c) emit({ type: "conversation", data: c });
}

function touchConversation(convId: string) {
  db().prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now(), convId);
}

export function deleteConversation(convId: string) {
  db().prepare("DELETE FROM messages WHERE conversation_id = ?").run(convId);
  db().prepare("DELETE FROM conversations WHERE id = ?").run(convId);
  emit({ type: "conversation_deleted", id: convId });
}

const gc = globalThis as unknown as { __dotsConvRouting?: Map<string, string> };
const convRouting = (gc.__dotsConvRouting ??= new Map());
export function routeToConversation(dotId: string, convId: string | null) {
  if (convId) convRouting.set(dotId, convId);
  else convRouting.delete(dotId);
}
/** The conversation a dot is working in right now (or its latest chat). */
export const currentConversation = (dotId: string) => convRouting.get(dotId) ?? latestConversationId(dotId);

/**
 * What was said on voice calls in this conversation since the text agent last saw it, as a transcript.
 * Voice lines are saved as ordinary chat messages (source "voice"); the text agent's thread doesn't include them.
 */
export function takeVoiceTranscript(convId: string, dotName: string): string {
  const key = `voiceSeen:${convId}`;
  const since = Number(getSetting(key) ?? 0);
  const rows = db()
    .prepare("SELECT * FROM messages WHERE conversation_id = ? AND source = 'voice' AND created_at > ? ORDER BY created_at")
    .all(convId, since)
    .map(toMessage);
  if (!rows.length) return "";
  setSetting(key, String(rows[rows.length - 1].createdAt));
  return rows.map((m) => `${m.role === "user" ? "User" : dotName}: ${m.text}`).join("\n");
}

export function conversationMessages(convId: string, limit = 400): Message[] {
  return db()
    .prepare("SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?) ORDER BY created_at")
    .all(convId, limit)
    .map(toMessage);
}

/** Model thread + pending approval state of a specific conversation. */
export function threadOf(convId: string): { thread: string | null; pending: string | null } {
  const r = db().prepare("SELECT thread, pending FROM conversations WHERE id = ?").get(convId) as Row | undefined;
  return { thread: (r?.thread as string) ?? null, pending: (r?.pending as string) ?? null };
}

/** Model thread + pending approval state of the conversation the dot is working in. */
export function getThread(dotId: string): { thread: string | null; pending: string | null } {
  const r = db().prepare("SELECT thread, pending FROM conversations WHERE id = ?").get(currentConversation(dotId)) as Row | undefined;
  return { thread: (r?.thread as string) ?? null, pending: (r?.pending as string) ?? null };
}

export function setThread(dotId: string, thread: string | null, pending: string | null) {
  db().prepare("UPDATE conversations SET thread = ?, pending = ? WHERE id = ?").run(thread, pending, currentConversation(dotId));
}

/** Model-facing history of the conversation the dot is working in (for stateless providers). */
export function getHistory(dotId: string): unknown[] {
  const r = db().prepare("SELECT history FROM conversations WHERE id = ?").get(currentConversation(dotId)) as Row | undefined;
  try {
    return r?.history ? (JSON.parse(r.history as string) as unknown[]) : [];
  } catch {
    return [];
  }
}

export function setHistory(dotId: string, items: unknown[] | null) {
  db().prepare("UPDATE conversations SET history = ? WHERE id = ?").run(items ? JSON.stringify(items) : null, currentConversation(dotId));
}

/** The dot's cloud computer (sandbox id), if it has one. */
export function getBoxId(dotId: string): string | null {
  const r = db().prepare("SELECT box_id FROM dots WHERE id = ?").get(dotId) as Row | undefined;
  return (r?.box_id as string) ?? null;
}

export function setBoxId(dotId: string, boxId: string | null) {
  db().prepare("UPDATE dots SET box_id = ? WHERE id = ?").run(boxId, dotId);
}

// ---------- messages ----------

const toMessage = (r: Row): Message => ({
  id: r.id as string,
  dotId: r.dot_id as string,
  role: r.role as MessageRole,
  text: r.text as string,
  title: (r.title as string) ?? null,
  card: r.card ? (JSON.parse(r.card as string) as CardData) : null,
  from: (r.source as string) ?? null,
  attachments: r.attachments ? (JSON.parse(r.attachments as string) as Attachment[]) : null,
  channelId: (r.channel_id as string) ?? null,
  conversationId: (r.conversation_id as string) ?? null,
  createdAt: r.created_at as number,
});

export function recentMessages(perDot = 200): Message[] {
  return db()
    .prepare(
      `SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY created_at DESC) rn FROM messages WHERE channel_id IS NULL) WHERE rn <= ? ORDER BY created_at`,
    )
    .all(perDot)
    .map(toMessage);
}

export function dotMessages(dotId: string, limit = 30): Message[] {
  return db()
    .prepare("SELECT * FROM (SELECT * FROM messages WHERE dot_id = ? AND channel_id IS NULL ORDER BY created_at DESC LIMIT ?) ORDER BY created_at")
    .all(dotId, limit)
    .map(toMessage);
}

export function getMessage(messageId: string): Message | null {
  const r = db().prepare("SELECT * FROM messages WHERE id = ?").get(messageId);
  return r ? toMessage(r) : null;
}

// While a dot works on a channel message, its output (replies, activity, cards) is posted to that channel.
const gr = globalThis as unknown as { __dotsRouting?: Map<string, string> };
const routing = (gr.__dotsRouting ??= new Map());
export function routeToChannel(dotId: string, channelId: string | null) {
  if (channelId) routing.set(dotId, channelId);
  else routing.delete(dotId);
}
export const channelRoute = (dotId: string) => routing.get(dotId) ?? null;

export function addMessage(input: {
  dotId: string; role: MessageRole; text: string; title?: string | null; card?: CardData | null; from?: string | null; attachments?: Attachment[] | null;
  channelId?: string | null;
  conversationId?: string | null;
}): Message {
  const msgId = id("msg");
  const channelId = input.channelId !== undefined ? input.channelId : ["dot", "activity", "card"].includes(input.role) ? channelRoute(input.dotId) : null;
  const conversationId = input.conversationId ?? (channelId && input.channelId !== undefined ? null : currentConversation(input.dotId));
  db().prepare("INSERT INTO messages (id, dot_id, role, text, title, card, source, attachments, channel_id, conversation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(msgId, input.dotId, input.role, input.text, input.title ?? null, input.card ? JSON.stringify(input.card) : null, input.from ?? null,
      input.attachments?.length ? JSON.stringify(input.attachments) : null, channelId, conversationId, now());
  if (conversationId && (input.role === "user" || input.role === "dot")) touchConversation(conversationId);
  const msg = getMessage(msgId)!;
  emit({ type: "message", data: msg });
  return msg;
}

export function updateMessage(messageId: string, patch: { text?: string; card?: CardData }): Message | null {
  if (patch.text !== undefined) db().prepare("UPDATE messages SET text = ? WHERE id = ?").run(patch.text, messageId);
  if (patch.card !== undefined) db().prepare("UPDATE messages SET card = ? WHERE id = ?").run(JSON.stringify(patch.card), messageId);
  const msg = getMessage(messageId);
  if (msg) emit({ type: "message", data: msg });
  return msg;
}

export function pendingCards(dotId: string): Message[] {
  return db()
    .prepare("SELECT * FROM messages WHERE dot_id = ? AND role = 'card' AND json_extract(card, '$.status') = 'pending'")
    .all(dotId)
    .map(toMessage);
}

// ---------- channels ----------

const toChannel = (r: Row): Channel => ({
  id: r.id as string, name: r.name as string, leadId: r.lead_id as string, memberIds: JSON.parse(r.members as string) as string[], createdAt: r.created_at as number,
});

export function listChannels(): Channel[] {
  return db().prepare("SELECT * FROM channels ORDER BY created_at").all().map(toChannel);
}

export function getChannel(channelId: string): Channel | null {
  const r = db().prepare("SELECT * FROM channels WHERE id = ?").get(channelId);
  return r ? toChannel(r) : null;
}

export function createChannel(name: string, leadId: string, memberIds: string[]): Channel {
  const chId = id("ch");
  const members = [...new Set([leadId, ...memberIds])];
  db().prepare("INSERT INTO channels (id, name, lead_id, members, created_at) VALUES (?, ?, ?, ?, ?)").run(chId, name, leadId, JSON.stringify(members), now());
  const ch = getChannel(chId)!;
  emit({ type: "channel", data: ch });
  return ch;
}

export function deleteChannel(channelId: string) {
  db().prepare("DELETE FROM messages WHERE channel_id = ?").run(channelId);
  db().prepare("DELETE FROM channels WHERE id = ?").run(channelId);
  emit({ type: "channel_deleted", id: channelId });
}

/** Channel messages for the snapshot (dot chats only carry messages without a channel). */
export function channelMessages(limit = 300): Message[] {
  return db()
    .prepare("SELECT * FROM (SELECT * FROM messages WHERE channel_id IS NOT NULL ORDER BY created_at DESC LIMIT ?) ORDER BY created_at")
    .all(limit)
    .map(toMessage);
}

// ---------- rules ----------

const toRule = (r: Row): Rule => ({
  id: r.id as string, dotId: (r.dot_id as string) ?? null, action: r.action as string,
  decision: r.decision as RuleDecision, createdAt: r.created_at as number,
});

export function listRules(): Rule[] {
  return db().prepare("SELECT * FROM rules ORDER BY created_at").all().map(toRule);
}

export function rulesFor(dotId: string): Rule[] {
  return db().prepare("SELECT * FROM rules WHERE dot_id IS NULL OR dot_id = ? ORDER BY created_at").all(dotId).map(toRule);
}

export function addRule(input: { dotId: string | null; action: string; decision: RuleDecision }): Rule {
  const ruleId = id("rule");
  db().prepare("INSERT INTO rules (id, dot_id, action, decision, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(ruleId, input.dotId, input.action, input.decision, now());
  const rule = toRule(db().prepare("SELECT * FROM rules WHERE id = ?").get(ruleId)!);
  emit({ type: "rule", data: rule });
  return rule;
}

export function deleteRule(ruleId: string) {
  db().prepare("DELETE FROM rules WHERE id = ?").run(ruleId);
  emit({ type: "rule_deleted", id: ruleId });
}

// ---------- memories ----------

const toMemory = (r: Row): Memory => ({ id: r.id as string, dotId: r.dot_id as string, text: r.text as string, createdAt: r.created_at as number });

export function listMemories(dotId?: string): Memory[] {
  const q = dotId
    ? db().prepare("SELECT * FROM memories WHERE dot_id = ? ORDER BY created_at").all(dotId)
    : db().prepare("SELECT * FROM memories ORDER BY created_at").all();
  return q.map(toMemory);
}

export function addMemory(dotId: string, text: string): Memory {
  const memId = id("mem");
  db().prepare("INSERT INTO memories (id, dot_id, text, created_at) VALUES (?, ?, ?, ?)").run(memId, dotId, text, now());
  const mem = toMemory(db().prepare("SELECT * FROM memories WHERE id = ?").get(memId)!);
  emit({ type: "memory", data: mem });
  return mem;
}

export function deleteMemory(memId: string) {
  db().prepare("DELETE FROM memories WHERE id = ?").run(memId);
  emit({ type: "memory_deleted", id: memId });
}

// ---------- skills ----------

const toSkill = (r: Row): Skill => ({
  id: r.id as string, dotId: r.dot_id as string, name: r.name as string, description: r.description as string,
  body: r.body as string, createdAt: r.created_at as number,
});

export function listSkills(dotId?: string): Skill[] {
  const q = dotId
    ? db().prepare("SELECT * FROM skills WHERE dot_id = ? ORDER BY created_at").all(dotId)
    : db().prepare("SELECT * FROM skills ORDER BY created_at").all();
  return q.map(toSkill);
}

export function upsertSkill(dotId: string, name: string, description: string, body: string): Skill {
  const existing = db().prepare("SELECT id FROM skills WHERE dot_id = ? AND lower(name) = lower(?)").get(dotId, name) as Row | undefined;
  const skillId = (existing?.id as string) ?? id("skill");
  if (existing) db().prepare("UPDATE skills SET description = ?, body = ? WHERE id = ?").run(description, body, skillId);
  else db().prepare("INSERT INTO skills (id, dot_id, name, description, body, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(skillId, dotId, name, description, body, now());
  const skill = toSkill(db().prepare("SELECT * FROM skills WHERE id = ?").get(skillId)!);
  emit({ type: "skill", data: skill });
  return skill;
}

export function deleteSkill(skillId: string) {
  db().prepare("DELETE FROM skills WHERE id = ?").run(skillId);
  emit({ type: "skill_deleted", id: skillId });
}

// ---------- routines ----------

function nextRun(schedule: string): number | null {
  try {
    return new Cron(schedule, { paused: true }).nextRun()?.getTime() ?? null;
  } catch {
    return null;
  }
}

const toRoutine = (r: Row): Routine => ({
  id: r.id as string, dotId: r.dot_id as string, name: r.name as string, instruction: r.instruction as string,
  schedule: r.schedule as string, enabled: r.enabled === 1, lastRunAt: (r.last_run_at as number) ?? null,
  nextRunAt: r.enabled === 1 ? nextRun(r.schedule as string) : null, createdAt: r.created_at as number,
});

export function listRoutines(dotId?: string): Routine[] {
  const q = dotId
    ? db().prepare("SELECT * FROM routines WHERE dot_id = ? ORDER BY created_at").all(dotId)
    : db().prepare("SELECT * FROM routines ORDER BY created_at").all();
  return q.map(toRoutine);
}

export function getRoutine(routineId: string): Routine | null {
  const r = db().prepare("SELECT * FROM routines WHERE id = ?").get(routineId);
  return r ? toRoutine(r) : null;
}

export function validSchedule(schedule: string): boolean {
  return nextRun(schedule) !== null;
}

export function addRoutine(input: { dotId: string; name: string; instruction: string; schedule: string }): Routine {
  const routineId = id("rtn");
  db().prepare("INSERT INTO routines (id, dot_id, name, instruction, schedule, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(routineId, input.dotId, input.name, input.instruction, input.schedule, now());
  const routine = getRoutine(routineId)!;
  emit({ type: "routine", data: routine });
  return routine;
}

export function updateRoutine(routineId: string, patch: { enabled?: boolean; lastRunAt?: number }): Routine | null {
  if (patch.enabled !== undefined) db().prepare("UPDATE routines SET enabled = ? WHERE id = ?").run(patch.enabled ? 1 : 0, routineId);
  if (patch.lastRunAt !== undefined) db().prepare("UPDATE routines SET last_run_at = ? WHERE id = ?").run(patch.lastRunAt, routineId);
  const routine = getRoutine(routineId);
  if (routine) emit({ type: "routine", data: routine });
  return routine;
}

export function deleteRoutine(routineId: string) {
  db().prepare("DELETE FROM routines WHERE id = ?").run(routineId);
  emit({ type: "routine_deleted", id: routineId });
}

// ---------- triggers (Composio events that wake a dot) ----------

const toTrigger = (r: Row): AppTrigger => ({
  id: r.id as string, dotId: r.dot_id as string, composioId: r.composio_id as string, slug: r.slug as string,
  toolkit: r.toolkit as string, name: r.name as string, config: JSON.parse(r.config as string) as Record<string, unknown>,
  instruction: r.instruction as string, enabled: r.enabled === 1, createdAt: r.created_at as number,
  lastFiredAt: (r.last_fired_at as number) ?? null, lastError: (r.last_error as string) ?? null,
});

export function listTriggers(dotId?: string): AppTrigger[] {
  const q = dotId
    ? db().prepare("SELECT * FROM triggers WHERE dot_id = ? ORDER BY created_at").all(dotId)
    : db().prepare("SELECT * FROM triggers ORDER BY created_at").all();
  return q.map(toTrigger);
}

export function getTrigger(triggerId: string): AppTrigger | null {
  const r = db().prepare("SELECT * FROM triggers WHERE id = ?").get(triggerId);
  return r ? toTrigger(r) : null;
}

export function triggerByComposioId(composioId: string): AppTrigger | null {
  const r = db().prepare("SELECT * FROM triggers WHERE composio_id = ?").get(composioId);
  return r ? toTrigger(r) : null;
}

export function addTrigger(input: { dotId: string; composioId: string; slug: string; toolkit: string; name: string; config: Record<string, unknown>; instruction: string }): AppTrigger {
  const triggerId = id("trg");
  db()
    .prepare("INSERT INTO triggers (id, dot_id, composio_id, slug, toolkit, name, config, instruction, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(triggerId, input.dotId, input.composioId, input.slug, input.toolkit, input.name, JSON.stringify(input.config), input.instruction, now());
  const t = getTrigger(triggerId)!;
  emit({ type: "trigger", data: t });
  return t;
}

export function updateTrigger(triggerId: string, patch: { enabled?: boolean; lastFiredAt?: number; lastError?: string | null }): AppTrigger | null {
  if (patch.enabled !== undefined) db().prepare("UPDATE triggers SET enabled = ? WHERE id = ?").run(patch.enabled ? 1 : 0, triggerId);
  if (patch.lastFiredAt !== undefined) db().prepare("UPDATE triggers SET last_fired_at = ? WHERE id = ?").run(patch.lastFiredAt, triggerId);
  if (patch.lastError !== undefined) db().prepare("UPDATE triggers SET last_error = ? WHERE id = ?").run(patch.lastError, triggerId);
  const t = getTrigger(triggerId);
  if (t) emit({ type: "trigger", data: t });
  return t;
}

export function deleteTrigger(triggerId: string) {
  db().prepare("DELETE FROM triggers WHERE id = ?").run(triggerId);
  emit({ type: "trigger_deleted", id: triggerId });
}

/** Start a conversation's next run from a clean model context (the chat itself keeps its messages). */
export function resetThread(convId: string) {
  db().prepare("UPDATE conversations SET thread = NULL, pending = NULL, history = NULL WHERE id = ?").run(convId);
}

// ---------- passwords (secret column is encrypted; see vault.ts) ----------

const toPassword = (r: Row): PasswordEntry => ({ id: r.id as string, site: r.site as string, username: r.username as string, createdAt: r.created_at as number });

export function listPasswords(): PasswordEntry[] {
  return db().prepare("SELECT id, site, username, created_at FROM passwords ORDER BY site").all().map(toPassword);
}

export function insertPassword(site: string, username: string, sealed: string): PasswordEntry {
  const pwId = id("pw");
  db().prepare("INSERT INTO passwords (id, site, username, secret, created_at) VALUES (?, ?, ?, ?, ?)").run(pwId, site, username, sealed, now());
  const entry = toPassword(db().prepare("SELECT * FROM passwords WHERE id = ?").get(pwId)!);
  emit({ type: "password", data: entry });
  return entry;
}

export function sealedPasswordFor(site: string): { username: string; sealed: string; site: string } | null {
  const rows = db().prepare("SELECT site, username, secret FROM passwords").all() as Row[];
  const host = hostOf(site);
  const match = rows.find((r) => hostOf(r.site as string) === host) ??
    rows.find((r) => host.endsWith("." + hostOf(r.site as string)) || hostOf(r.site as string).endsWith("." + host));
  return match ? { site: match.site as string, username: match.username as string, sealed: match.secret as string } : null;
}

export function deletePassword(pwId: string) {
  db().prepare("DELETE FROM passwords WHERE id = ?").run(pwId);
  emit({ type: "password_deleted", id: pwId });
}

export function hostOf(site: string): string {
  try {
    return new URL(site.includes("://") ? site : `https://${site}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return site.toLowerCase();
  }
}
