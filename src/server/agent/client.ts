import "server-only";
import OpenAI from "openai";
import { getSetting, setSetting } from "../db";
import { seal, unseal } from "../vault";
import { isOpenRouterModel, openModels, openRouterId, openRouterKey, openrouter, preferredOpenModel, smallOpenModel } from "./openrouter";
import { isOpenLocalModel, local, localEnabled, localModelId, localModels, preferredLocalModel, smallLocalModel } from "./local";

// Models are chosen from what the API key can actually use. Precedence for a dot's model:
// the dot's own choice → the default picked in Settings → DOTS_MODEL → best available.
const MAIN_PREFERENCE = ["gpt-5.5", "gpt-5.4", "gpt-5.2", "gpt-5.1", "gpt-5"];
const REVIEW_PREFERENCE = ["gpt-5.4-mini", "gpt-5-mini", "gpt-5.4-nano", "gpt-5-nano", "gpt-4.1-mini"];

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

/** Chat-capable models worth offering in a picker (no audio/image/embedding/realtime variants). */
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
    console.warn("[dots] couldn't list models, using defaults:", err instanceof Error ? err.message : err);
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

/** OpenAI models (with an OpenAI key) first, then open models (OpenRouter), then local models (DOTS_LOCAL_BASE_URL). */
async function resolve() {
  const [oa, open, localIds] = await Promise.all([
    resolveOpenAI(),
    openModels().catch((err) => {
      console.warn("[dots] couldn't list OpenRouter models:", err instanceof Error ? err.message : err);
      return [] as string[];
    }),
    localModels().catch((err) => {
      console.warn("[dots] couldn't list local models:", err instanceof Error ? err.message : err);
      return [] as string[];
    }),
  ]);
  // DOTS_MODEL / DOTS_REVIEW_MODEL can name a local model, with or without the "local:" prefix.
  const envLocal = (env: string | undefined) => (env ? localIds.find((id) => localModelId(id) === env.replace(/^local:/, "")) ?? null : null);
  const resolved = {
    main:
      oa?.main
      ?? (open.length ? preferredOpenModel(open) : null)
      ?? (localIds.length ? envLocal(process.env.DOTS_MODEL) ?? preferredLocalModel(localIds) : null)
      ?? process.env.DOTS_MODEL
      ?? MAIN_PREFERENCE[0],
    review:
      oa?.review
      ?? (open.length ? smallOpenModel(open) : null)
      ?? (localIds.length ? envLocal(process.env.DOTS_REVIEW_MODEL) ?? smallLocalModel(localIds) : null)
      ?? process.env.DOTS_REVIEW_MODEL
      ?? REVIEW_PREFERENCE[0],
    available: [...(oa?.available ?? []), ...open, ...localIds],
  };
  g.__dotsResolved = resolved;
  console.log(`[dots] default ${resolved.main} (agent), ${resolved.review} (rule review); ${resolved.available.length} models available`);
  return resolved;
}

/** Forget the resolved model list (a key was added or removed). */
export function resetModels() {
  g.__dotsModels = undefined;
  g.__dotsResolved = undefined;
}

/** The API client for a model, the model id that API expects, and whether it keeps conversation state. */
export function clientFor(model: string): { client: OpenAI; model: string; stateless: boolean } {
  if (isOpenRouterModel(model)) return { client: openrouter(), model: openRouterId(model), stateless: true };
  if (isOpenLocalModel(model)) return { client: local(), model: localModelId(model), stateless: true };
  return { client: openai(), model, stateless: false };
}

/** True when any model provider is set up (OpenAI, OpenRouter, or a local server). */
export function canThink(): boolean {
  return hasKey() || Boolean(openRouterKey()) || localEnabled();
}

export function models(): Promise<{ main: string; review: string; available: string[] }> {
  g.__dotsModels ??= resolve().catch((err) => {
    g.__dotsModels = undefined;
    throw err;
  });
  return g.__dotsModels;
}

/** The model a dot should run on right now. */
export async function modelFor(dotModel: string | null): Promise<string> {
  if (dotModel) return dotModel;
  return getSetting("default_model") ?? (await models()).main;
}

/** Best-known model info for display, without blocking. */
export function knownModels(): { main: string; review: string; available: string[]; defaultModel: string } {
  const r = g.__dotsResolved ?? { main: process.env.DOTS_MODEL || MAIN_PREFERENCE[0], review: process.env.DOTS_REVIEW_MODEL || REVIEW_PREFERENCE[0], available: [] };
  return { ...r, defaultModel: getSetting("default_model") ?? r.main };
}

/** gpt-5.x / gpt-6 / o-series accept `reasoning`; gpt-4.1 and friends reject it. */
export function isReasoningModel(model: string): boolean {
  return !isOpenRouterModel(model) && /^(gpt-[5-9]|o[1-9])/.test(model) && !/chat/.test(model);
}

/** OpenAI's GA computer tool needs a recent model; older ones get the page-reading tools only. */
export function supportsComputerTool(model: string): boolean {
  return /^gpt-5\.[4-9]|^gpt-[6-9]|computer-use/.test(model);
}
