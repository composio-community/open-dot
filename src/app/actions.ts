"use server";

import * as repo from "@/server/repo";
import * as runtime from "@/server/agent/runtime";
import * as computer from "@/server/computer";
import { savePassword as vaultSave } from "@/server/vault";
import { setSetting } from "@/server/db";
import { emit } from "@/server/bus";
import { computerInfo } from "@/server/snapshot";
import { models, resetModels, saveApiKey } from "@/server/agent/client";
import { saveOpenRouterKey } from "@/server/agent/openrouter";
import { saveOpenCodeProduct } from "@/server/agent/opencode";
import * as triggers from "@/server/triggers";
import * as composio from "@/server/composio";
import * as voice from "@/server/voice";
import { autoTitle } from "@/server/titles";
import type { Attachment, Dot, Look, RuleDecision, TriggerApp, TriggerType } from "@/lib/types";

// All mutations go through here; the UI updates from the event stream, not from return values.

export async function createDot(input: { name: string; purpose: string; look: Look }): Promise<string> {
  const name = input.name.trim() || "Dot";
  const dot = repo.createDot({ name, purpose: input.purpose.trim(), look: input.look });
  repo.addMessage({
    dotId: dot.id,
    role: "dot",
    text: `Hi, I'm ${dot.name}! Give me anything to work on — I have my own computer and browser, I'll remember what matters, and I'll ask before doing anything important.`,
  });
  return dot.id;
}

export async function updateDot(dotId: string, patch: Partial<Pick<Dot, "name" | "purpose" | "instructions" | "look">>) {
  repo.updateDot(dotId, patch);
}

export async function deleteDot(dotId: string) {
  runtime.stop(dotId);
  await computer.destroy(dotId);
  await triggers.removeTriggersFor(dotId);
  repo.deleteDot(dotId);
}

export async function sendMessage(dotId: string, text: string, attachments: Attachment[] = [], conversationId?: string) {
  if (!text.trim() && !attachments.length) return;
  runtime.sendMessage(dotId, text.trim(), attachments, conversationId);
  const conv = conversationId ? repo.getConversation(conversationId) : null;
  if (conv?.title === "New chat") void autoTitle(conv.id, text || attachments.map((a) => a.name).join(", "));
}

// ---------- conversations ----------

/** Start a new conversation with its first message. Returns the conversation id. */
export async function startConversation(dotId: string, text: string, attachments: Attachment[] = [], model: string | null = null): Promise<string> {
  const conv = repo.createConversation(dotId, "New chat", "chat", null, model);
  runtime.sendMessage(dotId, text.trim(), attachments, conv.id);
  void autoTitle(conv.id, text || attachments.map((a) => a.name).join(", "));
  return conv.id;
}

export async function renameConversation(convId: string, title: string) {
  if (title.trim()) repo.renameConversation(convId, title.trim().slice(0, 80));
}

export async function setConversationModel(convId: string, model: string | null) {
  repo.setConversationModel(convId, model);
  repo.resetThread(convId);
}

export async function deleteConversation(convId: string) {
  repo.deleteConversation(convId);
}

export async function stopDot(dotId: string) {
  runtime.stop(dotId);
}

export async function pauseDot(dotId: string) {
  runtime.pause(dotId);
}

export async function resumeDot(dotId: string) {
  runtime.resume(dotId);
}

export async function resolveCard(messageId: string, choice: "approve" | "deny" | "always" | "answer", answer?: string) {
  await runtime.resolveCard(messageId, choice, answer);
}

export async function setLocalAccess(dotId: string, allowed: boolean) {
  const dot = repo.updateDot(dotId, { localAccess: allowed });
  if (dot)
    repo.addMessage({
      dotId,
      role: "system",
      text: allowed
        ? `${dot.name} can now run tasks on this computer (it will still ask first).`
        : `${dot.name} will no longer be able to access this computer. You can allow access again from its settings on this computer.`,
    });
}

export async function addRule(dotId: string | null, action: string, decision: RuleDecision) {
  if (action.trim()) repo.addRule({ dotId, action: action.trim(), decision });
}

export async function deleteRule(ruleId: string) {
  repo.deleteRule(ruleId);
}

export async function addMemory(dotId: string, text: string) {
  if (text.trim()) repo.addMemory(dotId, text.trim());
}

export async function deleteMemory(memoryId: string) {
  repo.deleteMemory(memoryId);
}

export async function saveSkill(dotId: string, name: string, description: string, body: string) {
  if (name.trim() && body.trim()) repo.upsertSkill(dotId, name.trim(), description.trim(), body);
}

export async function deleteSkill(skillId: string) {
  repo.deleteSkill(skillId);
}

export async function addRoutine(dotId: string, name: string, instruction: string, schedule: string): Promise<string | null> {
  if (!repo.validSchedule(schedule)) return "That schedule isn't a valid cron expression.";
  repo.addRoutine({ dotId, name: name.trim() || "Routine", instruction, schedule: schedule.trim() });
  return null;
}

export async function toggleRoutine(routineId: string, enabled: boolean) {
  repo.updateRoutine(routineId, { enabled });
}

export async function runRoutineNow(routineId: string) {
  const r = repo.getRoutine(routineId);
  if (r) runtime.runRoutine({ ...r, enabled: true });
}

export async function deleteRoutine(routineId: string) {
  repo.deleteRoutine(routineId);
}

export async function savePassword(site: string, username: string, password: string): Promise<string | null> {
  if (!site.trim() || !password) return "Site and password are required.";
  vaultSave(site, username, password);
  return null;
}

export async function deletePassword(passwordId: string) {
  repo.deletePassword(passwordId);
}

/** Take over the dot's computer. Cloud: returns an interactive live-view URL. Local: opens the browser here. */
export async function takeOverComputer(dotId: string): Promise<{ url: string | null; error?: string }> {
  runtime.pause(dotId);
  try {
    return { url: await computer.takeOver(dotId) };
  } catch (err) {
    return { url: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Start the dot's computer from the Computer tab (Refresh), without pausing the dot. */
export async function wakeComputer(dotId: string) {
  await computer.wake(dotId);
}

export async function handBackComputer(dotId: string) {
  await computer.handBack(dotId);
  runtime.resume(dotId);
}

export async function resetComputer(dotId: string) {
  runtime.stop(dotId);
  await computer.reset(dotId);
  repo.addMessage({
    dotId,
    role: "system",
    text: computer.modeFor(dotId) === "cloud" ? "Computer reset. A fresh cloud computer starts next time." : "Computer reset. Files in /workspace were kept; installed packages were removed.",
  });
}

/** Pick a model for one dot (null = follow the default). */
export async function setDotModel(dotId: string, model: string | null) {
  repo.updateDot(dotId, { model });
}

/** Default model for dots that don't choose their own. */
/** Paste an OpenAI API key in Settings (the desktop app has no .env file). */
export async function setOpenAIKey(key: string): Promise<string | null> {
  const err = await saveApiKey(key.trim());
  if (err) return err;
  emit({ type: "computer", data: computerInfo() });
  void models().then(() => emit({ type: "computer", data: computerInfo() })).catch(() => {});
  return null;
}

/** Paste an OpenRouter key in Settings to add open models (empty removes it). */
export async function setOpenRouterKey(key: string): Promise<string | null> {
  const err = await saveOpenRouterKey(key.trim());
  if (err) return err;
  resetModels();
  emit({ type: "computer", data: computerInfo() });
  void models().then(() => emit({ type: "computer", data: computerInfo() })).catch(() => {});
  return null;
}

export async function setOpenCodeProduct(product: "go" | "zen", key: string, enabled: boolean, removeKey = false): Promise<string | null> {
  const err = await saveOpenCodeProduct(product, key.trim(), enabled, removeKey);
  if (err) return err;
  resetModels();
  emit({ type: "computer", data: computerInfo() });
  void models().then(() => emit({ type: "computer", data: computerInfo() })).catch(() => {});
  return null;
}

export async function refreshModels(): Promise<string | null> {
  resetModels();
  try {
    await models();
    emit({ type: "computer", data: computerInfo() });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// ---------- triggers (Composio API key) ----------

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Paste a Composio API key in Settings to turn on triggers (empty removes it). */
export async function setComposioKey(key: string): Promise<string | null> {
  const err = await triggers.saveComposioKey(key.trim());
  if (!err) emit({ type: "computer", data: computerInfo() });
  return err;
}

export async function listTriggerApps(): Promise<{ apps?: TriggerApp[]; error?: string }> {
  try {
    return { apps: await triggers.triggerApps() };
  } catch (err) {
    return { error: errText(err) };
  }
}

export async function connectTriggerApp(toolkit: string): Promise<{ url?: string; error?: string }> {
  try {
    return { url: await triggers.connectTriggerApp(toolkit) };
  } catch (err) {
    return { error: errText(err) };
  }
}

export async function listTriggerTypes(toolkit: string): Promise<{ types?: TriggerType[]; error?: string }> {
  try {
    return { types: await triggers.triggerTypes(toolkit) };
  } catch (err) {
    return { error: errText(err) };
  }
}

export async function addTrigger(dotId: string, toolkit: string, slug: string, config: Record<string, unknown>, instruction: string): Promise<string | null> {
  if (!instruction.trim()) return "Say what the dot should do when it fires.";
  try {
    await triggers.addTrigger(dotId, toolkit, slug, config, instruction.trim());
    return null;
  } catch (err) {
    return errText(err);
  }
}

export async function toggleTrigger(triggerId: string, enabled: boolean): Promise<string | null> {
  try {
    await triggers.setTriggerEnabled(triggerId, enabled);
    return null;
  } catch (err) {
    return errText(err);
  }
}

export async function deleteTrigger(triggerId: string) {
  await triggers.removeTrigger(triggerId).catch(() => {});
}

/** Paste an E2B key in Settings for cloud computers (empty removes it). */
export async function setCloudKey(key: string): Promise<string | null> {
  const err = await computer.saveCloudKey(key.trim());
  if (!err) emit({ type: "computer", data: computerInfo() });
  return err;
}

export async function setDefaultModel(model: string | null) {
  setSetting("default_model", model);
  emit({ type: "computer", data: computerInfo() });
}

// ---------- Composio For You (the user's apps) ----------

/** Start signing in to Composio. Returns the Composio sign-in URL to open, or nothing if already signed in. */
export async function signInComposio(): Promise<{ url?: string; error?: string }> {
  try {
    const url = await composio.signIn();
    return url ? { url } : {};
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function signOutComposio() {
  await composio.signOut();
  emit({ type: "computer", data: computerInfo() });
}

/** Start connecting an app from Settings. Returns the app's sign-in URL to open. */
export async function connectApp(toolkit: string): Promise<{ url?: string; error?: string }> {
  try {
    const r = await composio.startConnect(toolkit);
    if (r.already) return {};
    void r.wait().catch(() => {});
    return { url: r.url };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function refreshApps() {
  await composio.refresh();
}

/** "I've connected" on a connect card: verify, then let the dot continue. */
export async function confirmConnectCard(messageId: string): Promise<boolean> {
  const card = repo.getMessage(messageId)?.card;
  if (!card?.toolkit) return false;
  const ok = await composio.isConnected(card.toolkit).catch(() => false);
  if (ok) await runtime.resolveCard(messageId, "approve");
  return ok;
}

// ---------- voice ----------

/** Start a voice call with a dot: returns a short-lived realtime credential for the browser. */
export async function startVoiceCall(dotId: string, convId: string): Promise<{ token?: string; model?: string; error?: string }> {
  try {
    return await voice.createVoiceSession(dotId, convId);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Voice mode from a new chat: the call needs a conversation to write its transcript into. */
export async function startVoiceConversation(dotId: string): Promise<string> {
  return repo.createConversation(dotId, "Voice chat").id;
}

/** One finished line of a voice call, saved into the chat like any other message. */
export async function saveVoiceLine(dotId: string, convId: string, who: "you" | "dot", text: string) {
  if (!text.trim()) return;
  repo.addMessage({ dotId, role: who === "you" ? "user" : "dot", text: text.trim(), from: "voice", conversationId: convId, channelId: null });
  if (who === "you" && repo.getConversation(convId)?.title === "Voice chat") void autoTitle(convId, text);
}

/** send_task from a voice call: hand the job to the dot's working self, in the same chat. */
export async function sendVoiceTask(dotId: string, convId: string, request: string) {
  if (request.trim()) runtime.queueTask(dotId, request.trim(), convId);
}

// ---------- channels (group chats) ----------

export async function createChannel(name: string, leadId: string, memberIds: string[]): Promise<string> {
  const ch = repo.createChannel(name.trim().replace(/^#/, "") || "team", leadId, memberIds);
  const lead = repo.getDot(leadId);
  repo.addMessage({
    dotId: leadId,
    role: "system",
    text: `#${ch.name} created. ${lead?.name ?? "The lead"} coordinates; mention @Name to ask someone directly.`,
    channelId: ch.id,
  });
  return ch.id;
}

export async function deleteChannel(channelId: string) {
  repo.deleteChannel(channelId);
}

export async function sendChannelMessage(channelId: string, text: string) {
  if (text.trim()) runtime.sendToChannel(channelId, text.trim());
}
