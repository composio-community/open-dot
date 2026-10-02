import "server-only";
import OpenAI from "openai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Response, ResponseInputItem, ResponseOutputItem, Tool } from "openai/resources/responses/responses";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions/completions";
import { getSetting, setSetting } from "../db";
import { seal, unseal } from "../vault";

export const OPENCODE_GO_PREFIX = "opencode-go:";
export const OPENCODE_ZEN_PREFIX = "opencode-zen:";
const GO_BASE = "https://opencode.ai/zen/go/v1";
const ZEN_BASE = "https://opencode.ai/zen/v1";
const GO_KEY_SETTING = "opencode_go_key";
const ZEN_KEY_SETTING = "opencode_zen_key";
const PRODUCTS_SETTING = "opencode_products";

export type OpenCodeProduct = "go" | "zen";
type Product = OpenCodeProduct;
type Protocol = "responses" | "chat";
export type OpenCodeProducts = { go: boolean; zen: boolean };
export type OpenCodeSource = "settings" | "cli" | "env" | null;

type ModelRow = { id: string; created?: number };
type ToolCallAcc = { id: string; name: string; arguments: string };

const g = globalThis as unknown as {
  __dotsOpenCodeResponses?: Map<string, OpenAI>;
  __dotsOpenCodeChat?: Map<string, OpenAI>;
  __dotsOpenCodeModels?: { at: number; ids: string[] };
  __dotsOpenCodeSession?: string;
};

function envKey(product: Product): string | null {
  const specific = product === "go" ? process.env.OPENCODE_GO_API_KEY : process.env.OPENCODE_ZEN_API_KEY;
  return specific || process.env.OPENCODE_API_KEY || null;
}

function storedKey(product: Product): string | null {
  const stored = getSetting(product === "go" ? GO_KEY_SETTING : ZEN_KEY_SETTING);
  if (!stored) return null;
  try {
    return unseal(stored);
  } catch {
    return null;
  }
}

function cliKey(product: Product): string | null {
  try {
    const authFile = path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
    const auth = JSON.parse(fs.readFileSync(authFile, "utf8")) as Record<string, { type?: string; key?: string }>;
    const credential = auth[product === "go" ? "opencode-go" : "opencode"];
    return credential?.type === "api" && typeof credential.key === "string" && credential.key ? credential.key : null;
  } catch {
    return null;
  }
}

export function openCodeKey(product?: Product): string | null {
  if (product === "go") return storedKey("go") ?? cliKey("go") ?? envKey("go");
  if (product === "zen") return storedKey("zen") ?? cliKey("zen") ?? envKey("zen");
  return openCodeKey("go") ?? openCodeKey("zen");
}

export function openCodeSource(product: Product): OpenCodeSource {
  if (storedKey(product)) return "settings";
  if (cliKey(product)) return "cli";
  return envKey(product) ? "env" : null;
}

export function openCodeProducts(): OpenCodeProducts {
  const raw = getSetting(PRODUCTS_SETTING);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<OpenCodeProducts>;
      return { go: parsed.go === true, zen: parsed.zen === true };
    } catch {}
  }
  return {
    go: Boolean(storedKey("go") || cliKey("go") || process.env.OPENCODE_GO_API_KEY),
    zen: Boolean(storedKey("zen") || cliKey("zen") || process.env.OPENCODE_ZEN_API_KEY || process.env.OPENCODE_API_KEY),
  };
}

export function openCodeEnabled(product?: Product): boolean {
  const products = openCodeProducts();
  if (product) return products[product] && Boolean(openCodeKey(product));
  return (products.go && Boolean(openCodeKey("go"))) || (products.zen && Boolean(openCodeKey("zen")));
}

export function setOpenCodeProducts(products: OpenCodeProducts) {
  setSetting(PRODUCTS_SETTING, JSON.stringify(products));
  g.__dotsOpenCodeModels = undefined;
}

export async function saveOpenCodeProduct(product: Product, key: string, enabled: boolean, removeKey = false): Promise<string | null> {
  const setting = product === "go" ? GO_KEY_SETTING : ZEN_KEY_SETTING;
  if (removeKey) setSetting(setting, null);
  else if (key) setSetting(setting, seal(key));

  const products = openCodeProducts();
  products[product] = enabled;
  if (enabled && !openCodeKey(product)) return `Enter an OpenCode ${product === "go" ? "Go" : "Zen"} API key.`;
  setOpenCodeProducts(products);
  return null;
}

export const isOpenCodeModel = (model: string) => model.startsWith(OPENCODE_GO_PREFIX) || model.startsWith(OPENCODE_ZEN_PREFIX);
export const openCodeProduct = (model: string): Product => (model.startsWith(OPENCODE_GO_PREFIX) ? "go" : "zen");
export const openCodeModelId = (model: string) => model.replace(/^opencode-(?:go|zen):/, "");

function prefix(product: Product): string {
  return product === "go" ? OPENCODE_GO_PREFIX : OPENCODE_ZEN_PREFIX;
}

function base(product: Product): string {
  return product === "go" ? GO_BASE : ZEN_BASE;
}

/** Open Dot currently supports OpenCode's Responses and OpenAI-compatible Chat Completions protocols. */
export function openCodeProtocol(product: Product, id: string): Protocol | null {
  if (/^(gpt-|muse-spark-)/.test(id)) return "responses";
  if (product === "go" && /^grok-4\.[6-9]\b/.test(id)) return "responses";
  if (product === "zen" && /^grok-(?:build-|4\.[5-9]\b)/.test(id)) return "responses";
  if (product === "go" && /^(minimax-|qwen)/.test(id)) return null; // Go serves these through Anthropic Messages.
  if (product === "zen" && /^(claude-|gemini-|qwen|jev-)/.test(id)) return null; // Messages / Gemini / SystemOne.
  return "chat";
}

async function catalog(product: Product): Promise<ModelRow[]> {
  const res = await fetch(`${base(product)}/models`, { cache: "no-store" });
  if (!res.ok) throw new Error(`OpenCode ${product === "go" ? "Go" : "Zen"} models: ${res.status}`);
  const body = (await res.json()) as { data?: ModelRow[] };
  return body.data ?? [];
}

function priority(product: Product, id: string): number {
  const prefs = product === "go"
    ? ["gpt-6-luna", "kimi-k3", "deepseek-v4-pro", "glm-5.3", "grok-4.7", "gpt-5.6-luna", "glm-5.3-flash"]
    : ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "muse-spark-1.3"];
  const i = prefs.indexOf(id);
  return i < 0 ? 0 : prefs.length - i + 10;
}

export async function openCodeModels(): Promise<string[]> {
  if (!openCodeEnabled()) return [];
  if (g.__dotsOpenCodeModels && Date.now() - g.__dotsOpenCodeModels.at < 3_600_000) return g.__dotsOpenCodeModels.ids;
  const products = openCodeProducts();
  const enabled: Product[] = [
    ...(products.go && openCodeKey("go") ? ["go" as const] : []),
    ...(products.zen && openCodeKey("zen") ? ["zen" as const] : []),
  ];
  const groups = await Promise.all(enabled.map(async (product) => {
    try {
      const rows = await catalog(product);
      return rows
        .filter((m) => openCodeProtocol(product, m.id) !== null)
        .sort((a, b) => priority(product, b.id) - priority(product, a.id) || (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id))
        .map((m) => prefix(product) + m.id);
    } catch (err) {
      console.warn(`[dots] couldn't list OpenCode ${product === "go" ? "Go" : "Zen"} models:`, err instanceof Error ? err.message : err);
      return [];
    }
  }));
  const ids = groups.flat();
  g.__dotsOpenCodeModels = { at: Date.now(), ids };
  return ids;
}

export function preferredOpenCodeModel(ids: string[]): string | undefined {
  return ids.find((id) => /:gpt-6-(?:astra|luna)$/.test(id)) ?? ids.find((id) => /:kimi-k3$/.test(id)) ?? ids[0];
}

export function smallOpenCodeModel(ids: string[]): string | undefined {
  return ids.find((id) => /:gpt-6-luna$/.test(id)) ?? ids.find((id) => /:glm-5\.3-flash$/.test(id)) ?? ids[0];
}

function rawClient(product: Product, protocol: Protocol): OpenAI {
  const key = openCodeKey(product);
  if (!key) throw new Error("No OpenCode API key yet. Add one in Settings.");
  const mapKey = `${product}:${key}`;
  const slot = protocol === "responses" ? (g.__dotsOpenCodeResponses ??= new Map()) : (g.__dotsOpenCodeChat ??= new Map());
  let client = slot.get(mapKey);
  if (!client) {
    const fallbackSession = (g.__dotsOpenCodeSession ??= `open-dot-${crypto.randomUUID()}`);
    client = new OpenAI({
      apiKey: key,
      baseURL: base(product),
      defaultHeaders: { "User-Agent": "open-dot/0.1.0", "x-opencode-session": fallbackSession },
    });
    slot.set(mapKey, client);
  }
  return client;
}

function inputText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const p = part as Record<string, unknown>;
    if (typeof p.text === "string") return p.text;
    if (p.type === "input_file") return `[Attached file: ${String(p.filename ?? "file")}]`;
    return "";
  }).filter(Boolean).join("\n");
}

function chatMessages(instructions: string | undefined, input: unknown): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [];
  if (instructions) messages.push({ role: "system", content: instructions });
  if (!Array.isArray(input)) {
    if (input != null) messages.push({ role: "user", content: String(input) });
    return messages;
  }
  for (const item of input as ResponseInputItem[]) {
    if ("role" in item) {
      const content = inputText("content" in item ? item.content : "");
      if (item.role === "user") messages.push({ role: "user", content });
      else if (item.role === "assistant") messages.push({ role: "assistant", content });
      else if (item.role === "system") messages.push({ role: "system", content });
      if (item.role === "user" || item.role === "assistant" || item.role === "system") continue;
    }
    if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        content: "",
        tool_calls: [{ id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } }],
      });
      continue;
    }
    if (item.type === "function_call_output") {
      messages.push({ role: "tool", tool_call_id: String(item.call_id ?? ""), content: typeof item.output === "string" ? item.output : JSON.stringify(item.output) ?? "" });
    }
  }
  return messages;
}

function chatTools(tools: Tool[] | undefined): ChatCompletionTool[] | undefined {
  const functions = (tools ?? []).filter((tool) => tool.type === "function").map((tool) => {
    const f = tool as Extract<Tool, { type: "function" }>;
    return { type: "function", function: { name: f.name, description: f.description ?? undefined, parameters: f.parameters } } as ChatCompletionTool;
  });
  return functions.length ? functions : undefined;
}

function messageItem(id: string, text: string): ResponseOutputItem {
  return {
    type: "message",
    id,
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [], logprobs: [] }],
  } as ResponseOutputItem;
}

function callItem(call: ToolCallAcc, index: number): ResponseOutputItem {
  return {
    type: "function_call",
    id: `fc_${index}_${call.id}`,
    call_id: call.id,
    name: call.name,
    arguments: call.arguments || "{}",
    status: "completed",
  } as ResponseOutputItem;
}

function syntheticResponse(model: string, id: string, output: ResponseOutputItem[], text: string): Response {
  return { id, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model, output, output_text: text } as Response;
}

type OpenCodeRequestOptions = { signal?: AbortSignal; headers?: Record<string, string> };

async function completeChat(client: OpenAI, model: string, params: Record<string, unknown>, options?: OpenCodeRequestOptions): Promise<Response> {
  const completion = await client.chat.completions.create({
    model,
    messages: chatMessages(params.instructions as string | undefined, params.input),
    tools: chatTools(params.tools as Tool[] | undefined),
    parallel_tool_calls: false,
  }, options);
  const choice = completion.choices[0];
  const text = typeof choice?.message?.content === "string" ? choice.message.content : "";
  const output: ResponseOutputItem[] = [];
  if (text) output.push(messageItem(`msg_${completion.id}`, text));
  for (const [i, call] of (choice?.message?.tool_calls ?? []).entries()) {
    if (call.type === "function") output.push(callItem({ id: call.id, name: call.function.name, arguments: call.function.arguments }, i));
  }
  return syntheticResponse(model, completion.id, output, text);
}

async function* streamChat(client: OpenAI, model: string, params: Record<string, unknown>, options?: OpenCodeRequestOptions): AsyncGenerator<Record<string, unknown>> {
  const stream = await client.chat.completions.create({
    model,
    messages: chatMessages(params.instructions as string | undefined, params.input),
    tools: chatTools(params.tools as Tool[] | undefined),
    parallel_tool_calls: false,
    stream: true,
  }, options);
  const itemId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  let text = "";
  let added = false;
  let responseId = `resp_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const calls = new Map<number, ToolCallAcc>();
  for await (const chunk of stream) {
    responseId = chunk.id || responseId;
    const delta = chunk.choices[0]?.delta;
    if (!delta) continue;
    if (delta.content) {
      if (!added) {
        added = true;
        yield { type: "response.output_item.added", output_index: 0, item: messageItem(itemId, "") };
      }
      text += delta.content;
      yield { type: "response.output_text.delta", item_id: itemId, output_index: 0, content_index: 0, delta: delta.content };
    }
    for (const tc of delta.tool_calls ?? []) {
      const prev = calls.get(tc.index) ?? { id: tc.id ?? `call_${tc.index}`, name: "", arguments: "" };
      if (tc.id) prev.id = tc.id;
      if (tc.function?.name) prev.name += tc.function.name;
      if (tc.function?.arguments) prev.arguments += tc.function.arguments;
      calls.set(tc.index, prev);
    }
  }
  const output: ResponseOutputItem[] = [];
  let outputIndex = 0;
  if (text) {
    const item = messageItem(itemId, text);
    output.push(item);
    yield { type: "response.output_item.done", output_index: outputIndex++, item };
  }
  for (const [i, call] of [...calls.entries()].sort(([a], [b]) => a - b)) {
    const item = callItem(call, i);
    output.push(item);
    yield { type: "response.output_item.done", output_index: outputIndex++, item };
  }
  yield { type: "response.completed", response: syntheticResponse(model, responseId, output, text) };
}

/** Return an OpenAI-shaped client. Chat-completions models are adapted to the Responses contract used by Open Dot. */
export function openCodeClient(appModel: string): OpenAI {
  const product = openCodeProduct(appModel);
  const model = openCodeModelId(appModel);
  const protocol = openCodeProtocol(product, model);
  if (!protocol) throw new Error(`${model} uses an OpenCode protocol Open Dot doesn't support yet.`);
  const client = rawClient(product, protocol);
  if (protocol === "responses") return client;
  return {
    responses: {
      create: (params: Record<string, unknown>, options?: OpenCodeRequestOptions) =>
        params.stream ? streamChat(client, model, params, options) : completeChat(client, model, params, options),
    },
  } as unknown as OpenAI;
}
