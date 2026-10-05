import OpenAI from "openai";
import type { ChatCompletion, ChatCompletionMessageParam, ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import type { Response, ResponseCreateParams, ResponseInputItem, ResponseOutputItem, ResponseStreamEvent } from "openai/resources/responses/responses";

export class ToolArgumentsError extends Error {
  constructor() {
    super("The router returned malformed tool arguments. No tool action was executed from this response. Try continuing with smaller commands.");
  }
}

export function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new ToolArgumentsError(); }
}

/** Translate the app's Responses history to a gateway's Chat Completions protocol. */
export function chatRequest(params: ResponseCreateParams): ChatCompletionCreateParamsNonStreaming {
  const messages: ChatCompletionMessageParam[] = [];
  if (params.instructions) messages.push({ role: "system", content: params.instructions });
  const input: ResponseInputItem[] = typeof params.input === "string" ? [{ role: "user", content: params.input }] : params.input ?? [];
  for (const item of input) {
    if (item.type === "function_call") {
      if (!item.call_id || !item.name || typeof item.arguments !== "string") throw new Error("Cannot replay an incomplete tool call.");
      const call = { id: item.call_id, type: "function" as const, function: { name: item.name, arguments: item.arguments } };
      const last = messages[messages.length - 1];
      if (last?.role === "assistant" && last.tool_calls) last.tool_calls.push(call);
      else messages.push({ role: "assistant", content: null, tool_calls: [call] });
    } else if (item.type === "function_call_output") {
      if (!item.call_id) throw new Error("Cannot replay a tool result without a call ID.");
      messages.push({ role: "tool", tool_call_id: item.call_id, content: typeof item.output === "string" ? item.output : JSON.stringify(item.output) });
    } else if ("role" in item && "content" in item) {
      const role = item.role === "developer" ? "system" : item.role;
      if (typeof item.content === "string") messages.push({ role, content: item.content } as ChatCompletionMessageParam);
      else {
        const content = item.content.map((part) => {
          if (part.type === "input_text" || part.type === "output_text") return { type: "text", text: part.text };
          if (part.type === "input_image" && part.image_url) return { type: "image_url", image_url: { url: part.image_url, detail: part.detail } };
          if (part.type === "input_file" && part.file_data) return { type: "file", file: { filename: part.filename, file_data: part.file_data } };
          if (part.type === "refusal") return { type: "text", text: part.refusal };
          throw new Error("This router cannot receive this attachment or conversation item. Use a supported attachment or an OpenAI model.");
        });
        messages.push({ role, content } as ChatCompletionMessageParam);
      }
    } else throw new Error("This router cannot replay this item. Start a new chat or use the original provider.");
  }
  const tools = params.tools?.map((tool) => {
    if (tool.type !== "function") throw new Error("This router supports function tools, but not provider-hosted tools.");
    return { type: "function" as const, function: { name: tool.name, description: tool.description ?? undefined, parameters: tool.parameters ?? {}, strict: false } };
  });
  return { model: params.model!, messages,
    ...(tools?.length ? { tools, parallel_tool_calls: false } : {}),
    ...(params.text?.format?.type === "json_schema" ? { response_format: { type: "json_schema", json_schema: { name: params.text.format.name, schema: params.text.format.schema, strict: params.text.format.strict ?? true } } } : {}),
    ...(params.max_output_tokens ? { max_tokens: params.max_output_tokens } : {}), stream: false };
}

export function response(id: string, model: string, text: string, calls: { id: string; name: string; arguments: string }[], messageId: string): Response {
  const output: ResponseOutputItem[] = [];
  if (text) output.push({ id: messageId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [], logprobs: [] }] });
  for (const call of calls) {
    if (!call.id || !call.name) throw new Error("The router returned an incomplete tool call.");
    parseToolArguments(call.arguments);
    output.push({ id: `fc_${call.id}`, type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments, status: "completed" });
  }
  return { id, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model, output, output_text: text, error: null, incomplete_details: null } as Response;
}

function completionResponse(completion: ChatCompletion): Response {
  const choice = completion.choices?.[0];
  if (!choice) throw new Error("The router returned no completion.");
  if (choice.finish_reason === "length" || choice.finish_reason === "content_filter") throw new Error(`The router stopped the response (${choice.finish_reason}). No tool action was executed.`);
  const calls = (choice.message.tool_calls ?? []).map((call) => {
    if (call.type !== "function") throw new Error("The router returned an unsupported tool call.");
    return { id: call.id, name: call.function.name, arguments: call.function.arguments };
  });
  return response(completion.id, completion.model, choice.message.content ?? choice.message.refusal ?? "", calls, `msg_${completion.id}`);
}

/** Keep existing callers on one API; translate only these gateways' transport. */
export function chatResponses(client: OpenAI): OpenAI {
  const create = async (params: ResponseCreateParams, options?: Parameters<OpenAI["responses"]["create"]>[1]) => {
    const request = chatRequest(params);
    if (!params.stream) return completionResponse(await client.chat.completions.create(request, options));
    const stream = await client.chat.completions.create({ ...request, stream: true }, options);
    return (async function* (): AsyncGenerator<ResponseStreamEvent> {
      const messageId = `msg_${crypto.randomUUID()}`;
      let text = "", id = `resp_${crypto.randomUUID()}`, model = request.model, sequence = 0, finished = false;
      const calls = new Map<number, { id: string; name: string; arguments: string }>();
      for await (const chunk of stream) {
        if (!chunk) continue;
        if ("error" in chunk) throw new Error("The router reported an error while streaming.");
        id = chunk.id || id; model = chunk.model || model;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.delta?.content || choice.delta?.refusal) {
          const delta = choice.delta.content || choice.delta.refusal!;
          text += delta;
          yield { type: "response.output_text.delta", item_id: messageId, output_index: 0, content_index: 0, delta, sequence_number: sequence++, logprobs: [] };
        }
        for (const part of choice.delta?.tool_calls ?? []) {
          const call = calls.get(part.index) ?? { id: "", name: "", arguments: "" };
          call.id += part.id ?? ""; call.name += part.function?.name ?? ""; call.arguments += part.function?.arguments ?? "";
          calls.set(part.index, call);
        }
        if (choice.finish_reason) {
          if (choice.finish_reason === "length" || choice.finish_reason === "content_filter") throw new Error(`The router stopped the response (${choice.finish_reason}). No tool action was executed.`);
          finished = true;
        }
      }
      if (!finished) throw new Error("The router stream ended before completion. No tool action was executed.");
      const final = response(id, model, text, [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call), messageId);
      for (const [output_index, item] of final.output.entries()) yield { type: "response.output_item.done", item, output_index, sequence_number: sequence++ };
      yield { type: "response.completed", response: final, sequence_number: sequence++ };
    })();
  };
  return Object.assign(Object.create(client), { responses: { create: create as OpenAI["responses"]["create"] } });
}
