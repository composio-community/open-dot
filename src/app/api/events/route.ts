import { onEvent } from "@/server/bus";
import { snapshot } from "@/server/snapshot";
import type { ServerEvent } from "@/lib/types";
import { isTrustedLoopbackRequest, loopbackForbiddenResponse } from "@/server/security";

// Server-sent events: one full snapshot on connect, then every change as it happens.
export async function GET(req: Request) {
  if (!isTrustedLoopbackRequest(req)) return loopbackForbiddenResponse();
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (ev: ServerEvent) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
      send({ type: "snapshot", data: snapshot() });
      const off = onEvent(send);
      const ping = setInterval(() => controller.enqueue(encoder.encode(": ping\n\n")), 20_000);
      cleanup = () => {
        off();
        clearInterval(ping);
      };
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
