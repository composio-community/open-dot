import "server-only";
import OpenAI from "openai";
import type { Response, ResponseCreateParamsNonStreaming, ResponseOutputItem } from "openai/resources/responses/responses";
import { getSetting, setSetting } from "../db";
import { seal, unseal } from "../vault";
import {
  chatGPTClient,
  chatGPTModelId,
  chatGPTModels,
  chatGPTStatus,
  isChatGPTModel,
} from "./chatgpt";
import { isOpenRouterModel, openModels, openRouterId, openRouterKey, openrouter, preferredOpenModel, smallOpenModel } from "./openrouter";

// Models are chosen from every provider the user connected. Precedence for a dot's model:
// the dot's own choice → the default picked in Settings → best available provider/model.
const MAIN_PREFERENCE = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.2", "gpt-5.1", "gpt-5"];
const REVIEW_PREFERENCE = ["gpt-6-luna", "gpt-5.6-luna", "gpt-5.4-mini", "gpt-5-mini", "gpt-5.4-nano", "gpt-5-nano", "gpt-4.1-mini"];

export type ModelProvider = "openai" | "chatgpt" | "openrouter";
export type ModelClient = { client: OpenAI; model: string; stateless: boolean; provider: ModelProvider };

const g = globalThis as unknown as {
  __dotsOpenAI?: OpenAI;
  __dotsOpenAIKey?: string;
  __dotsModels?: Promise<{ main: string; review: string; available: string[] }>;
  __dotsResolved?: { main: string; review: string; available: string[] };
};

// The key comes from OPENAI_API_KEY (development) or from Settings, sealed with the vault key (the desktop app).
const KEY_SETTING = "openai_key";

function apiKey(): string | null {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const sealed = getSetting(KEY_SETTING);
  if (!sealed) return null;
  try {
    return unseal(sealed);
  } catch {
    return null;
  }
}

export function hasKey(): boolean {
  return Boolean(apiKey());
}

/** Where the key came from, for Settings. */
export function keySource(): "env" | "settings" | null {
  return process.env.OPENAI_API_KEY ? "env" : getSetting(KEY_SETTING) ? "settings" : null;
}

export function openai(): OpenAI {
  const key = apiKey();
  if (!key) throw new Error("No OpenAI API key yet. Add one in Settings.");
  if (!g.__dotsOpenAI || g.__dotsOpenAIKey !== key) {
    g.__dotsOpenAI = new OpenAI({ apiKey: key });
    g.__dotsOpenAIKey = key;
  }
  return g.__dotsOpenAI;
}

/** Check the key works, then save it (encrypted) and re-pick models for it. Returns an error message or null. */
export async function saveApiKey(key: string): Promise<string | null> {
  try {
    await new OpenAI({ apiKey: key }).models.list();
  } catch (err) {
    return err instanceof Error && /401|Incorrect API key|invalid/i.test(err.message) ? "OpenAI didn't accept that key." : `Couldn't check the key: ${err instanceof Error ? err.message : String(err)}`;
  }
  setSetting(KEY_SETTING, seal(key));
  resetModels();
  return null;
}

/** Chat-capable API models worth offering in a picker (no audio/image/embedding/realtime variants). */
function isAgentModel(id: string): boolean {
  if (!/^(gpt-[4-9]|o[1-9])/.test(id)) return false;
  if (/audio|realtime|transcribe|tts|image|embedding|search|instruct|moderation|chat-latest|-\d{4}-\d{2}-\d{2}$|0613|0314|1106|0125|preview/.test(id)) return false;
  return !/^gpt-4(-|$)|gpt-4o|gpt-4-turbo|gpt-3/.test(id);
}

function rank(id: string): number {
  const m = id.match(/^gpt-(\d+)(?:\.(\d+))?/);
  const version = m ? Number(m[1]) * 100 + Number(m[2] ?? 0) : id.startsWith("o") ? 400 : 0;
  const tier = /-(pro)/.test(id) ? 0.5 : /-(mini)/.test(id) ? -0.3 : /-(nano)/.test(id) ? -0.6 : 0;
  return version + tier;
}

async function resolveOpenAI(): Promise<{ main: string; review: string; available: string[] } | null> {
  if (!apiKey()) return null;
  let ids: string[] = [];
  try {
    for await (const m of openai().models.list()) ids.push(m.id);
  } catch (err) {
    console.warn("[dots] couldn't list OpenAI models, using defaults:", err instanceof Error ? err.message : err);
    ids = [];
  }
  const set = new Set(ids);
  const pick = (envVar: string | undefined, prefs: string[]) => envVar || prefs.find((id) => set.has(id)) || prefs[0];
  const available = ids.filter(isAgentModel).sort((a, b) => rank(b) - rank(a) || a.localeCompare(b));
  return {
    main: pick(process.env.DOTS_MODEL, MAIN_PREFERENCE),
    review: pick(process.env.DOTS_REVIEW_MODEL, REVIEW_PREFERENCE),
    available: available.length ? available : MAIN_PREFERENCE,
  };
}

async function resolveChatGPT(): Promise<{ main: string; review: string; available: string[] } | null> {
  if (!chatGPTStatus().sharing) return null;
  const available = await chatGPTModels();
  if (!available.length) return null;
  const review =
    available.find((id) => /(?:mini|nano|luna)/i.test(chatGPTModelId(id))) ??
    available.find((id) => !/-pro\b/i.test(chatGPTModelId(id))) ??
    available[0];
  return { main: available[0], review, available };
}

/** API-key OpenAI first (preserves existing behavior), then ChatGPT-plan models, then OpenRouter. */
async function resolve() {
  const [oa, chatgpt, open] = await Promise.all([
    resolveOpenAI(),
    resolveChatGPT().catch((err) => {
      console.warn("[dots] couldn't list ChatGPT-plan models:", err instanceof Error ? err.message : err);
      return null;
    }),
    openModels().catch((err) => {
      console.warn("[dots] couldn't list OpenRouter models:", err instanceof Error ? err.message : err);
      return [] as string[];
    }),
  ]);
  const resolved = {
    main: oa?.main ?? chatgpt?.main ?? (open.length ? preferredOpenModel(open) : process.env.DOTS_MODEL || MAIN_PREFERENCE[0]),
    review: oa?.review ?? chatgpt?.review ?? (open.length ? smallOpenModel(open) : process.env.DOTS_REVIEW_MODEL || REVIEW_PREFERENCE[0]),
    available: [...(oa?.available ?? []), ...(chatgpt?.available ?? []), ...open],
  };
  g.__dotsResolved = resolved;
  console.log(`[dots] default ${resolved.main} (agent), ${resolved.review} (rule review); ${resolved.available.length} models available`);
  return resolved;
}

/** Forget the resolved model list (a provider was added, removed, or refreshed). */
export function resetModels() {
  g.__dotsModels = undefined;
  g.__dotsResolved = undefined;
}

/** The API client for a model, the provider's model id, and provider capabilities. */
export async function clientFor(model: string): Promise<ModelClient> {
  if (isOpenRouterModel(model)) return { client: openrouter(), model: openRouterId(model), stateless: true, provider: "openrouter" };
  if (isChatGPTModel(model)) return { client: await chatGPTClient(), model: chatGPTModelId(model), stateless: true, provider: "chatgpt" };
  return { client: openai(), model, stateless: false, provider: "openai" };
}

/**
 * Create one complete response. ChatGPT-plan token sharing requires streaming even for
 * short helper calls (rule review, titles, dot-to-dot consults), so collect that stream here.
 */
export async function completedResponse(
  target: ModelClient,
  params: ResponseCreateParamsNonStreaming,
  signal?: AbortSignal,
): Promise<Response> {
  if (target.provider !== "chatgpt") {
    return target.client.responses.create(params, signal ? { signal } : undefined);
  }

  const stream = await target.client.responses.create(
    { ...params, model: target.model, store: false, stream: true },
    signal ? { signal } : undefined,
  );
  let final: Response | null = null;
  const output = new Map<number, ResponseOutputItem>();
  for await (const event of stream) {
    if (event.type === "response.output_item.done") output.set(event.output_index, event.item);
    else if (event.type === "response.completed") final = event.response;
    else if (event.type === "response.failed") throw new Error(event.response.error?.message ?? "The model request failed");
    else if (event.type === "response.incomplete") throw new Error("The model response was incomplete");
    else if (event.type === "error") throw new Error(event.message);
  }
  if (!final) throw new Error("The model stream ended unexpectedly");
  // ChatGPT-plan streams may omit output items from the terminal response object.
  // Reconstruct them from the authoritative output_item.done events when present.
  const streamed = [...output.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
  return streamed.length ? { ...final, output: streamed } : final;
}

/** True when any model provider is set up. */
export function canThink(): boolean {
  return hasKey() || chatGPTStatus().sharing || Boolean(openRouterKey());
}

export function models(): Promise<{ main: string; review: string; available: string[] }> {
  g.__dotsModels ??= resolve().catch((err) => {
    g.__dotsModels = undefined;
    throw err;
  });
  return g.__dotsModels;
}

function providerAvailable(model: string): boolean {
  if (isChatGPTModel(model)) return chatGPTStatus().sharing;
  if (isOpenRouterModel(model)) return Boolean(openRouterKey());
  return hasKey();
}

/** The model a dot should run on right now. Stale choices fall back when their provider is disconnected. */
export async function modelFor(dotModel: string | null): Promise<string> {
  const chosen = dotModel ?? getSetting("default_model");
  if (chosen && providerAvailable(chosen)) return chosen;
  return (await models()).main;
}

/** Best-known model info for display, without blocking. */
export function knownModels(): { main: string; review: string; available: string[]; defaultModel: string } {
  const r = g.__dotsResolved ?? { main: process.env.DOTS_MODEL || MAIN_PREFERENCE[0], review: process.env.DOTS_REVIEW_MODEL || REVIEW_PREFERENCE[0], available: [] };
  const saved = getSetting("default_model");
  return { ...r, defaultModel: saved && providerAvailable(saved) ? saved : r.main };
}

/** API-key gpt-5.x / gpt-6 / o-series accept `reasoning`; ChatGPT-plan preview requests keep the minimal supported field set. */
export function isReasoningModel(model: string): boolean {
  return !isOpenRouterModel(model) && !isChatGPTModel(model) && /^(gpt-[5-9]|o[1-9])/.test(model) && !/chat/.test(model);
}

/** OpenAI's GA computer tool needs a recent API model; ChatGPT-plan preview currently uses Open Dot's own browser tools instead. */
export function supportsComputerTool(model: string): boolean {
  return !isChatGPTModel(model) && /^gpt-5\.[4-9]|^gpt-[6-9]|computer-use/.test(model);
}
