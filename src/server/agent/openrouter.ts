import "server-only";
import OpenAI from "openai";
import { getSetting, setSetting } from "../db";
import { seal, unseal } from "../vault";

// Open models through OpenRouter. Off until the user adds an OpenRouter key (Settings, or OPENROUTER_API_KEY).
// Dots pick these models like any other; their ids carry an "openrouter:" prefix, e.g. "openrouter:qwen/qwen3-coder".
// OpenRouter's Responses API is stateless, so the runtime keeps each chat's history for these models itself.

export const OPENROUTER_PREFIX = "openrouter:";
const BASE_URL = "https://openrouter.ai/api/v1";
const KEY_SETTING = "openrouter_key";
const HEADERS = {
  "HTTP-Referer": "https://github.com/composio-community/open-dot",
  "X-Title": "Open Dot",
};

// Open-weight families worth offering (OpenRouter also lists closed models; those stay out of this group).
const OPEN_FAMILIES = [
  /^dots-studio\//,
  /^qwen\//,
  /^deepseek\//,
  /^moonshotai\//,
  /^z-ai\//,
  /^meta-llama\//,
  /^openai\/gpt-oss/,
  /^google\/gemma/,
  /^mistralai\/(mistral-small|devstral|ministral|mixtral|magistral-small|mistral-nemo)/,
  /^nousresearch\//,
  /^minimax\//,
  /^nvidia\//,
  /^microsoft\/phi/,
  /^arcee-ai\//,
];
// Variants and API-only models that aren't open weights, even inside open families.
const SKIP = [
  /:(batch|online|extended|beta|thinking)$/,
  /-exp\b/,
  /-prime\b/,
  /^qwen\/.*-(max|plus|turbo|flash|omni)/,
  /flashx/,
];
// Best first when an open model has to be picked for the user (no OpenAI key yet, or no choice made).
// Matched by family, newest first, so they keep working as new versions ship.
const MAIN_PREFERENCE = [
  /^moonshotai\/kimi-k\d/,
  /^deepseek\/deepseek-v\d(\.\d)?$/,
  /^z-ai\/glm-\d(\.\d)?$/,
  /^qwen\/qwen[\d.]+-coder/,
  /^openai\/gpt-oss-120b/,
];
const SMALL_PREFERENCE = [
  /^openai\/gpt-oss-20b/,
  /^deepseek\/.*flash/,
  /^z-ai\/glm-.*-(air|flash)$/,
  /^qwen\/qwen[\d.]+-\d+b$/,
  /^mistralai\/mistral-small/,
];

const g = globalThis as unknown as {
  __dotsOpenRouter?: { key: string; client: OpenAI };
  __dotsOpenModels?: { at: number; ids: string[] };
};

function envKey(): string | null {
  return process.env.OPENROUTER_API_KEY || null;
}

export function openRouterKey(): string | null {
  if (envKey()) return envKey();
  const sealed = getSetting(KEY_SETTING);
  if (!sealed) return null;
  try {
    return unseal(sealed);
  } catch {
    return null;
  }
}

export const openRouterSource = (): "env" | "settings" | null =>
  envKey() ? "env" : getSetting(KEY_SETTING) ? "settings" : null;

export const isOpenRouterModel = (model: string) =>
  model.startsWith(OPENROUTER_PREFIX);
export const openRouterId = (model: string) =>
  model.slice(OPENROUTER_PREFIX.length);

export function openrouter(): OpenAI {
  const key = openRouterKey();
  if (!key)
    throw new Error(
      "No OpenRouter key yet. Add one in Settings to use open models.",
    );
  if (g.__dotsOpenRouter?.key !== key)
    g.__dotsOpenRouter = {
      key,
      client: new OpenAI({
        apiKey: key,
        baseURL: BASE_URL,
        defaultHeaders: HEADERS,
      }),
    };
  return g.__dotsOpenRouter.client;
}

/** Check the key with OpenRouter, then save it encrypted. An empty key removes it. Returns an error or null. */
export async function saveOpenRouterKey(key: string): Promise<string | null> {
  if (envKey()) return "The OpenRouter key is set by OPENROUTER_API_KEY.";
  if (!key) {
    setSetting(KEY_SETTING, null);
    return null;
  }
  try {
    const res = await fetch(`${BASE_URL}/key`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.status === 401 || res.status === 403)
      return "OpenRouter didn't accept that key.";
    if (!res.ok)
      return `Couldn't check the key with OpenRouter (${res.status}).`;
  } catch (err) {
    return `Couldn't reach OpenRouter: ${err instanceof Error ? err.message : String(err)}`;
  }
  setSetting(KEY_SETTING, seal(key));
  g.__dotsOpenModels = undefined;
  return null;
}

/** Open-weight models on OpenRouter that can call tools, newest first, as app model ids. Cached for an hour. */
export async function openModels(): Promise<string[]> {
  if (!openRouterKey()) return [];
  if (g.__dotsOpenModels && Date.now() - g.__dotsOpenModels.at < 3_600_000)
    return g.__dotsOpenModels.ids;
  const res = await fetch(`${BASE_URL}/models?supported_parameters=tools`);
  if (!res.ok) throw new Error(`OpenRouter models: ${res.status}`);
  const { data } = (await res.json()) as {
    data: { id: string; created?: number }[];
  };
  const ids = data
    .filter(
      (m) =>
        OPEN_FAMILIES.some((re) => re.test(m.id)) &&
        !SKIP.some((re) => re.test(m.id)),
    )
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
    .slice(0, 40)
    .map((m) => OPENROUTER_PREFIX + m.id);
  g.__dotsOpenModels = { at: Date.now(), ids };
  return ids;
}

const pick = (ids: string[], prefs: RegExp[]) =>
  prefs
    .map((re) => ids.find((id) => re.test(openRouterId(id))))
    .find(Boolean) ?? ids[0];
export const preferredOpenModel = (ids: string[]) => pick(ids, MAIN_PREFERENCE);
export const smallOpenModel = (ids: string[]) => pick(ids, SMALL_PREFERENCE);
