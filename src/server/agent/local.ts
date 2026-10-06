import "server-only";
import OpenAI from "openai";
import { z } from "zod";
import { getSetting, setSetting } from "../db";
import { seal, unseal } from "../vault";

// Locally served models through any OpenAI-compatible server on the user's machine or network:
// Ollama (http://localhost:11434/v1), LM Studio (http://localhost:1234/v1), vLLM, and friends.
// Off until a server is set, in Settings or with DOTS_LOCAL_BASE_URL (which wins). Their ids carry a "local:" prefix, e.g.
// "local:qwen3:8b". Local servers implement the stateless Responses API, so the runtime keeps
// each chat's history itself, exactly as it does for OpenRouter.

export const LOCAL_PREFIX = "local:";
const URL_SETTING = "local_base_url";
const KEY_SETTING = "local_key";

const g = globalThis as unknown as { __dotsLocal?: { baseURL: string; apiKey: string; client: OpenAI }; __dotsLocalModels?: { at: number; ids: string[] } };

const trimSlash = (url: string) => url.replace(/\/+$/, "");
const envURL = (): string | null => (process.env.DOTS_LOCAL_BASE_URL ? trimSlash(process.env.DOTS_LOCAL_BASE_URL) : null);

export const localBaseURL = (): string => envURL() ?? getSetting(URL_SETTING) ?? "";
export const localSource = (): "env" | "settings" | null => (envURL() ? "env" : getSetting(URL_SETTING) ? "settings" : null);
export const localEnabled = (): boolean => Boolean(localBaseURL());

/** The local server's key: DOTS_LOCAL_API_KEY with an env URL, else the one saved in Settings, else a placeholder. */
function localKey(): string {
  if (envURL()) return process.env.DOTS_LOCAL_API_KEY || "local";
  const sealed = getSetting(KEY_SETTING);
  if (!sealed) return "local";
  try {
    return unseal(sealed);
  } catch {
    return "local";
  }
}

export const isOpenLocalModel = (model: string) => model.startsWith(LOCAL_PREFIX);
export const localModelId = (model: string) => model.slice(LOCAL_PREFIX.length);

export function local(): OpenAI {
  const baseURL = localBaseURL();
  if (!baseURL) throw new Error("No local model server set. Add one in Settings, e.g. http://localhost:11434/v1 for Ollama.");
  const apiKey = localKey();
  if (g.__dotsLocal?.baseURL !== baseURL || g.__dotsLocal.apiKey !== apiKey) g.__dotsLocal = { baseURL, apiKey, client: new OpenAI({ apiKey, baseURL }) };
  return g.__dotsLocal.client;
}

const LocalServerInput = z.object({
  baseURL: z.string().trim().url("That doesn't look like a URL, e.g. http://localhost:11434/v1.").refine((u) => /^https?:\/\//.test(u), "The URL needs to start with http:// or https://."),
  apiKey: z.string().trim().max(512).optional(),
});

/**
 * Check a local model server answers, then save its URL (and key, encrypted). An empty URL removes both.
 * @returns an error to show, or null when saved.
 */
export async function saveLocalServer(input: { baseURL: string; apiKey?: string }): Promise<string | null> {
  if (envURL()) return "The local model server is set by DOTS_LOCAL_BASE_URL.";
  if (!input.baseURL.trim()) {
    setSetting(URL_SETTING, null);
    setSetting(KEY_SETTING, null);
    g.__dotsLocal = undefined;
    g.__dotsLocalModels = undefined;
    return null;
  }
  const parsed = LocalServerInput.safeParse(input);
  if (!parsed.success) return parsed.error.issues[0]?.message ?? "Check the URL and key.";
  const baseURL = trimSlash(parsed.data.baseURL);
  const apiKey = parsed.data.apiKey || null;
  try {
    const res = await fetch(`${baseURL}/models`, { headers: { Authorization: `Bearer ${apiKey ?? "local"}` }, signal: AbortSignal.timeout(5_000) });
    if (res.status === 401 || res.status === 403) return "The server didn't accept that key.";
    if (!res.ok) return `The server answered ${res.status}. Check the URL ends in /v1.`;
  } catch (err) {
    return `Couldn't reach ${baseURL}: ${err instanceof Error ? err.message : String(err)}`;
  }
  setSetting(URL_SETTING, baseURL);
  setSetting(KEY_SETTING, apiKey ? seal(apiKey) : null);
  g.__dotsLocal = undefined;
  g.__dotsLocalModels = undefined;
  return null;
}

/** Models the local server offers, as app model ids. A cheap request, so cached for just a minute. */
export async function localModels(): Promise<string[]> {
  if (!localEnabled()) return [];
  if (g.__dotsLocalModels && Date.now() - g.__dotsLocalModels.at < 60_000) return g.__dotsLocalModels.ids;
  const bare: string[] = [];
  for await (const m of local().models.list()) if (m.id && !bare.includes(m.id)) bare.push(m.id);
  g.__dotsLocalModels = { at: Date.now(), ids: bare.map((id) => LOCAL_PREFIX + id) };
  return g.__dotsLocalModels.ids;
}

// Best first when a local model has to be picked for the user (no OpenAI or OpenRouter key, or no choice
// made). Matched by family, so they keep working as new versions ship. Tested against bare ids.
const MAIN_PREFERENCE = [/^gpt-oss:120b/, /coder/, /^deepseek/, /^qwen/, /^gpt-oss/, /^llama/, /^(kimi|glm|minimax|mistral|gemma)/];
const SMALL_PREFERENCE = [/^gpt-oss:20b/, /(mini|small|flash|tiny)/, /:(1|3|4|7|8)b\b/, /^gpt-oss/, /^qwen/];

const pick = (ids: string[], prefs: RegExp[]) => prefs.map((re) => ids.find((id) => re.test(localModelId(id)))).find(Boolean) ?? ids[0];
export const preferredLocalModel = (ids: string[]) => pick(ids, MAIN_PREFERENCE);
export const smallLocalModel = (ids: string[]) => pick(ids, SMALL_PREFERENCE);
