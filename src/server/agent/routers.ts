import "server-only";
import OpenAI from "openai";
import { lookup } from "node:dns/promises";
import { isIP, BlockList } from "node:net";
import { getSetting, setSetting } from "../db";
import { seal, unseal } from "../vault";
import { FREE_OPENROUTER_MODEL, isFreeOpenRouterModel, modelLabel, ROUTER_PROVIDERS, routerModel, routerProvider, type RouterId, type RouterStatus } from "@/lib/model-providers";
import { chatResponses } from "./router-chat";

type Config = { key: string; baseURL: string; modelIds: string[] };
const setting = (id: string) => `router_config_${id}`;
const cache = new Map<string, { signature: string; at: number; models: string[] }>();
const clients = new Map<string, { signature: string; client: OpenAI }>();
const privateIPs = new BlockList();
for (const [ip, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["100.64.0.0", 10], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) privateIPs.addSubnet(ip, prefix);
for (const [ip, prefix] of [["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) privateIPs.addSubnet(ip, prefix, "ipv6");

export function routerBaseURL(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.port && url.port !== "443")) throw new Error("Use an HTTPS API base URL without credentials, query parameters, or a custom port.");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host.includes(".") || host.endsWith(".localhost") || host.endsWith(".local") || isIP(host)) throw new Error("Use your provider's public HTTPS API hostname.");
  if (/\/(chat\/completions|responses|models|key)\/?$/.test(url.pathname)) throw new Error("Enter the base URL ending in /v1, not a full request endpoint.");
  return url.href.replace(/\/+$/, "");
}

function config(id: RouterId): Config | null {
  const provider = routerProvider(id)!;
  const env = process.env[provider.env];
  if (env) return { key: env.trim(), baseURL: routerBaseURL(process.env[`${provider.env.replace(/_API_KEY$/, "")}_BASE_URL`] || provider.baseURL), modelIds: [] };
  const saved = getSetting(setting(id));
  if (saved) {
    try { return JSON.parse(unseal(saved)) as Config; } catch { return null; }
  }
  // Keep existing OpenRouter profiles working without asking users to re-enter their key.
  const legacy = id === "openrouter" && getSetting("openrouter_key");
  if (legacy) { try { return { key: unseal(legacy), baseURL: provider.baseURL, modelIds: [] }; } catch { return null; } }
  return null;
}

export function routerStatuses(): RouterStatus[] {
  return ROUTER_PROVIDERS.map((p) => {
    const c = config(p.id);
    return { id: p.id, source: process.env[p.env] ? "env" : c ? "settings" : null, baseURL: c?.baseURL ?? p.baseURL, modelIds: c?.modelIds ?? [] };
  });
}
export const hasRouterKey = () => ROUTER_PROVIDERS.some((p) => Boolean(config(p.id)?.key));
export const routerKey = (id: RouterId) => config(id)?.key ?? null;
export const routerSource = (id: RouterId) => routerStatuses().find((p) => p.id === id)!.source;

/** Keep useful provider diagnostics without forwarding credentials or raw HTML. */
async function routerError(c: Config, res: Response): Promise<string> {
  const mask = (value: string, max: number) => value
    .replaceAll(c.key, "[redacted]").replaceAll(encodeURIComponent(c.key), "[redacted]")
    .replace(/Bearer\s+[^\s"',;<>]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk[-_]|tr_)[a-zA-Z0-9_-]+/g, "[redacted]")
    .replace(/[\p{C}\s]+/gu, " ").trim().slice(0, max);
  let message = res.status === 401 ? "The key was rejected by the selected endpoint." : res.status === 402 ? "This request exceeds the available credits or key spending limit. Choose a cheaper model or add credits." : res.status === 403 ? "The provider denied this request. Check its dashboard or contact support." : res.status === 429 ? "Rate or quota limit reached." : "Check the endpoint and provider status.";
  let reference = "";
  if (/application\/(?:[\w.-]+\+)?json\b/i.test(res.headers.get("content-type") ?? "")) {
    const reader = res.body?.getReader();
    if (reader) {
      try {
        let text = "", size = 0;
        const decoder = new TextDecoder();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 8192) throw new Error("Oversized provider error");
          text += decoder.decode(chunk.value, { stream: true });
        }
        const error = JSON.parse(text + decoder.decode())?.error;
        if (typeof error?.message === "string") message += ` Provider: ${mask(error.message, 600)}`;
        if (typeof error?.type === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(error.type)) message += ` Type: ${mask(error.type, 64)}.`;
        if (typeof error?.request_id === "string") reference = mask(error.request_id, 100);
      } catch { /* Malformed or oversized bodies retain the safe status explanation. */ }
      finally { await reader.cancel().catch(() => {}); }
    }
  } else {
    if (res.headers.get("content-type")?.includes("text/html") || res.headers.get("cf-mitigated") === "challenge") message = "The endpoint returned a website/security page instead of an API response. Check the provider status or contact its support.";
    await res.body?.cancel().catch(() => {});
  }
  if (!reference) reference = mask(res.headers.get("cf-ray") ?? "", 100);
  if (/^[a-zA-Z0-9_-]{1,100}$/.test(reference)) message += ` Support reference: ${reference}.`;
  return `Router HTTP ${res.status}. ${message}`;
}

/** Credentials are sent only to the chosen origin, never forwarded through redirects. */
async function routerFetch(c: Config, input: RequestInfo | URL, init?: RequestInit) {
  const target = new URL(input instanceof Request ? input.url : String(input));
  const base = new URL(routerBaseURL(c.baseURL));
  if (target.origin !== base.origin || !target.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/`)) throw new Error("The router request left its configured API endpoint.");
  // Known documented hosts are pinned. Custom hosts must resolve to public addresses.
  if (!ROUTER_PROVIDERS.some((p) => new URL(p.baseURL).hostname === target.hostname) && target.hostname !== "agentrouter.org") {
    const addresses = await lookup(target.hostname, { all: true });
    if (!addresses.length || addresses.some((a) => privateIPs.check(a.address, a.family === 6 ? "ipv6" : "ipv4"))) throw new Error("The router endpoint must resolve to public internet addresses.");
  }
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  const res = await fetch(input, { ...init, headers, redirect: "error" });
  if (!res.ok) return Response.json({ error: { message: await routerError(c, res) } }, { status: res.status, headers: res.headers.has("retry-after") ? { "retry-after": res.headers.get("retry-after")! } : {} });
  return res;
}

async function listModels(c: Config, id: RouterId): Promise<string[]> {
  // The server-side tools filter excludes routers such as openrouter/free.
  const res = await routerFetch(c, c.baseURL + "/models", { headers: { Authorization: `Bearer ${c.key}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    if ((res.status === 404 || res.status === 405) && c.modelIds.length) return c.modelIds.map((m) => `${id}:${m}`);
    if (res.status === 404 || res.status === 405) throw new Error("This gateway does not list models. Enter model IDs from its dashboard, then save again.");
    throw new Error((await res.json()).error.message);
  }
  const body: unknown = await res.json();
  if (!body || typeof body !== "object" || !("data" in body) || !Array.isArray(body.data)) throw new Error("The endpoint did not return an OpenAI-compatible model catalog.");
  const ids = body.data.flatMap((m: unknown) => {
    if (!m || typeof m !== "object" || !("id" in m) || typeof m.id !== "string" || !m.id.trim() || m.id.includes(c.key) || /embedding|tts|transcrib|whisper|realtime|dall-e|moderation|image-generation/i.test(m.id)) return [];
    if (id === "openrouter" && "supported_parameters" in m && (!Array.isArray(m.supported_parameters) || !m.supported_parameters.includes("tools"))) return [];
    return [m.id];
  });
  const selected = c.modelIds.length ? c.modelIds : ids;
  if (!selected.length) throw new Error("No chat models are available on this key. Enter a model ID from your provider dashboard.");
  const free = modelLabel(FREE_OPENROUTER_MODEL);
  // Keep the free default even when it appears after the picker catalog limit.
  const ordered = id === "openrouter" && selected.includes(free) ? [free, ...selected] : selected;
  return [...new Set(ordered)].slice(0, 200).map((m) => `${id}:${m}`);
}

export async function saveRouter(id: string, key: string, baseURL: string, modelIds: string): Promise<string | null> {
  const provider = routerProvider(id);
  if (!provider) return "Choose a supported router.";
  if (process.env[provider.env]) return `This key is controlled by ${provider.env}.`;
  try {
    if (!key.trim()) {
      setSetting(setting(id), null);
      if (id === "openrouter") setSetting("openrouter_key", null);
      if (getSetting("default_model")?.startsWith(`${id}:`)) setSetting("default_model", null);
      cache.delete(id); clients.delete(id);
      return null;
    }
    if (key.length > 2048 || /\s/.test(key.trim())) return "Paste only the API key, without quotes, spaces, or a Bearer prefix.";
    const ids = modelIds.split(/[\n,]/).map((m) => m.trim()).filter(Boolean);
    if (ids.length > 200 || ids.some((m) => m.length > 200 || /\s/.test(m) || m.includes(key.trim()))) return "Enter at most 200 exact model IDs, separated by commas or newlines. Do not include the key.";
    const c: Config = { key: key.trim(), baseURL: routerBaseURL(baseURL), modelIds: ids };
    if (id === "openrouter" && c.baseURL === provider.baseURL) {
      const res = await routerFetch(c, c.baseURL + "/key", { headers: { Authorization: `Bearer ${c.key}` }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return (await res.json()).error.message;
    }
    const models = await listModels(c, provider.id);
    // Seal before touching the old configuration: errors must preserve existing credentials.
    setSetting(setting(id), seal(JSON.stringify(c)));
    cache.set(id, { signature: JSON.stringify(c), at: Date.now(), models });
    clients.delete(id);
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not save this router.";
    return key.trim() ? message.replaceAll(key.trim(), "[redacted]") : message;
  }
}

export async function routerModels(): Promise<string[]> {
  const lists = await Promise.all(ROUTER_PROVIDERS.map(async (p) => {
    const c = config(p.id);
    if (!c) return [];
    const signature = JSON.stringify(c), cached = cache.get(p.id);
    if (cached?.signature === signature && Date.now() - cached.at < 3_600_000) return cached.models;
    try {
      const models = await listModels(c, p.id);
      cache.set(p.id, { signature, at: Date.now(), models });
      return models;
    } catch {
      // A catalog outage must not turn the normal free default into a paid OpenAI call.
      if (p.id === "openrouter" && c.baseURL === p.baseURL && !c.modelIds.length) return [FREE_OPENROUTER_MODEL];
      return c.modelIds.map((m) => `${p.id}:${m}`);
    }
  }));
  return lists.flat();
}

export function routerClient(appModel: string): { client: OpenAI; model: string } {
  const route = routerModel(appModel);
  if (!route) throw new Error("Unknown router model.");
  const c = config(route.provider.id);
  if (!c) throw new Error(`Add your ${route.provider.name} key in Settings.`);
  const signature = JSON.stringify(c);
  let cached = clients.get(route.provider.id);
  if (cached?.signature !== signature) {
    const client = new OpenAI({ apiKey: c.key, baseURL: c.baseURL, fetch: (input, init) => routerFetch(c, input, init), maxRetries: 0, timeout: 120_000,
      defaultHeaders: route.provider.id === "openrouter" ? { "HTTP-Referer": "https://github.com/composio-community/open-dot", "X-OpenRouter-Title": "Open Dot" } : undefined });
    const routed = route.provider.responses ? client : chatResponses(client);
    const create = routed.responses.create.bind(routed.responses);
    // Unset limits can reserve a model's entire output window against a small balance.
    routed.responses.create = ((params, options) => create({
      ...params,
      // Hosted search has its own charge even on free models; retain local function tools.
      ...(route.provider.id === "openrouter" && isFreeOpenRouterModel(`openrouter:${params.model}`)
        ? { tools: params.tools?.filter((tool) => String(tool.type) !== "openrouter:web_search") } : {}),
      max_output_tokens: params.max_output_tokens ?? 2048,
    }, options)) as typeof routed.responses.create;
    cached = { signature, client: routed };
    clients.set(route.provider.id, cached);
  }
  return { client: cached!.client, model: route.model };
}
