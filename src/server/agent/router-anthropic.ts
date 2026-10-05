import OpenAI from "openai";
import type { ResponseCreateParams, ResponseStreamEvent } from "openai/resources/responses/responses";
import { chatRequest, chatResponses, response, parseToolArguments, ToolArgumentsError } from "./router-chat";

type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown; [key: string]: unknown };
type Message = { id: string; model: string; content: Block[]; stop_reason: string | null };
type Event = { type: string; index?: number; message?: Message; content_block?: Block; delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string } };

/** Reuse Responses history conversion, then express Claude's native messages/tools. */
export function anthropicRequest(params: ResponseCreateParams) {
  const chat = chatRequest(params);
  const messages: { role: "user" | "assistant"; content: Block[] }[] = [];
  const system: string[] = [];
  for (const item of chat.messages) {
    if (item.role === "system" || item.role === "developer") {
      if (typeof item.content !== "string") throw new Error("Command Code requires text system instructions.");
      system.push(item.content);
      continue;
    }
    const role = item.role === "assistant" ? "assistant" : "user";
    const content: Block[] = [];
    if (item.role === "tool") content.push({ type: "tool_result", tool_use_id: item.tool_call_id, content: typeof item.content === "string" ? item.content : JSON.stringify(item.content) });
    else {
      if (typeof item.content === "string" && item.content) content.push({ type: "text", text: item.content });
      else if (Array.isArray(item.content)) for (const part of item.content) {
        if (part.type === "text") content.push({ type: "text", text: part.text });
        else if (part.type === "image_url") {
          const url = part.image_url.url;
          const image = url.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/);
          if (image) content.push({ type: "image", source: { type: "base64", media_type: image[1], data: image[2].replace(/\s/g, "") } });
          else if (/^https:\/\//.test(url)) content.push({ type: "image", source: { type: "url", url } });
          else throw new Error("Command Code needs a PNG, JPEG, GIF or WebP image, or an HTTPS image URL.");
        } else throw new Error("Command Code supports text and images, not file or audio attachments.");
      }
      if (item.role === "assistant") for (const call of item.tool_calls ?? []) {
        if (call.type !== "function") throw new Error("Command Code requires function tools.");
        content.push({ type: "tool_use", id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) });
      }
    }
    if (content.length) {
      const last = messages.at(-1);
      if (last?.role === role) last.content.push(...content);
      else messages.push({ role, content });
    }
  }
  const tools = chat.tools?.map((tool) => {
    if (tool.type !== "function") throw new Error("Command Code requires function tools.");
    return { name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters ?? {} };
  });
  const format = params.text?.format;
  return { model: chat.model, messages, max_tokens: chat.max_tokens ?? 2048, stream: Boolean(params.stream),
    ...(system.length ? { system: system.join("\n\n") } : {}),
    ...(tools?.length ? { tools, tool_choice: { type: "auto", disable_parallel_tool_use: true } } : {}),
    ...(format?.type === "json_schema" ? { output_config: { format: { type: "json_schema", schema: format.schema } } } : {}),
  };
}

function completed(message: Message) {
  if (!["end_turn", "tool_use", "stop_sequence"].includes(message.stop_reason ?? "")) throw new Error("Command Code stopped before completing its response. No tool action was executed.");
  if (!message.id || !message.model || !Array.isArray(message.content)) throw new Error("Command Code returned an incomplete message. No tool action was executed.");
  const text = message.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  const calls = message.content.filter((b) => b.type === "tool_use").map((b) => {
    if (!b.id || !b.name) throw new Error("Command Code returned an incomplete tool call. No action was executed.");
    if (!b.input || typeof b.input !== "object" || Array.isArray(b.input)) throw new ToolArgumentsError();
    return { id: b.id, name: b.name, arguments: JSON.stringify(b.input) };
  });
  return response(message.id, message.model, text, calls, message.id);
}

/** Command Code serves Claude only on /messages; other chat models use /chat/completions. */
export function commandCodeResponses(client: OpenAI): OpenAI {
  const chat = chatResponses(client);
  const create = async (params: ResponseCreateParams, options?: Parameters<OpenAI["responses"]["create"]>[1]) => {
    if (params.model === "typesafe/jev") throw new Error("Command Code's decision model cannot be used for chat. Choose a chat model in Settings.");
    if (Array.isArray(params.input) && params.input.some((item) => "content" in item && Array.isArray(item.content) && item.content.some((part) => part.type === "input_file"))) throw new Error("Command Code supports text and images, not file attachments. Paste the document's text instead.");
    if (!/^(?:anthropic\/)?claude-/i.test(params.model ?? "")) return chat.responses.create(params, options);
    const request = anthropicRequest(params);
    const post = { ...options, body: request, headers: { ...options?.headers, "anthropic-version": "2023-06-01" }, stream: Boolean(params.stream) };
    if (!params.stream) return completed(await client.post<Message>("/messages", post));
    const stream = await client.post<AsyncIterable<Event>>("/messages", post);
    return (async function* (): AsyncGenerator<ResponseStreamEvent> {
      let message: Message | undefined, stopped = false, sequence = 0;
      const blocks = new Map<number, { block: Block; json: string; closed: boolean }>();
      try {
        for await (const event of stream) {
          if (event.type === "message_start") {
            if (message || !event.message) throw new Error("Invalid message start");
            message = event.message;
          } else if (event.type === "content_block_start") {
            if (!message || !Number.isInteger(event.index) || !event.content_block || blocks.has(event.index!)) throw new Error("Invalid block start");
            blocks.set(event.index!, { block: { ...event.content_block }, json: "", closed: false });
            if (event.content_block.type === "text" && event.content_block.text) yield { type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: event.content_block.text, sequence_number: sequence++, logprobs: [] };
          } else if (event.type === "content_block_delta") {
            const state = blocks.get(event.index!);
            if (!message || !state || state.closed) throw new Error("Invalid block delta");
            if (event.delta?.type === "text_delta" && typeof event.delta.text === "string") {
              state.block.text = (state.block.text ?? "") + event.delta.text;
              yield { type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: event.delta.text, sequence_number: sequence++, logprobs: [] };
            } else if (event.delta?.type === "input_json_delta" && typeof event.delta.partial_json === "string") state.json += event.delta.partial_json;
          } else if (event.type === "content_block_stop") {
            const state = blocks.get(event.index!);
            if (!state || state.closed) throw new Error("Invalid block stop");
            if (state.json) state.block.input = parseToolArguments(state.json);
            state.closed = true;
          } else if (event.type === "message_delta") {
            if (!message) throw new Error("Missing message start");
            if (event.delta?.stop_reason) message.stop_reason = event.delta.stop_reason;
          } else if (event.type === "message_stop") { stopped = true; break; }
        }
        options?.signal?.throwIfAborted();
        if (!stopped || !message || [...blocks.values()].some((b) => !b.closed)) throw new Error("Incomplete message stream");
        message.content = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, b]) => b.block);
        const final = completed(message);
        for (const [output_index, item] of final.output.entries()) yield { type: "response.output_item.done", item, output_index, sequence_number: sequence++ };
        yield { type: "response.completed", response: final, sequence_number: sequence++ };
      } catch (err) {
        options?.signal?.throwIfAborted();
        if (err instanceof ToolArgumentsError) throw err;
        throw new Error("Command Code's Claude stream failed or ended early. No tool action was executed.");
      }
    })();
  };
  return Object.assign(Object.create(client), { responses: { create: create as OpenAI["responses"]["create"] } });
}
