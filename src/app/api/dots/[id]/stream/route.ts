import { streamScreen } from "@/server/computer";
import { getDot } from "@/server/repo";
import { isTrustedLoopbackRequest, loopbackForbiddenResponse } from "@/server/security";

export const dynamic = "force-dynamic";

// The dot's browser as an MJPEG stream: an <img> pointed here shows it live. Each frame is followed by the next
// boundary right away, so the browser paints it immediately instead of waiting for the following frame.
export async function GET(req: Request, ctx: RouteContext<"/api/dots/[id]/stream">) {
  if (!isTrustedLoopbackRequest(req)) return loopbackForbiddenResponse();
  const { id } = await ctx.params;
  if (!getDot(id)) return Response.json({ error: "Dot not found" }, { status: 404 });
  const enc = new TextEncoder();
  let stop: (() => Promise<void>) | undefined;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const end = () => {
        void stop?.();
        try {
          controller.close();
        } catch {}
      };
      req.signal.addEventListener("abort", end);
      controller.enqueue(enc.encode("--frame\r\n"));
      try {
        stop = await streamScreen(id, (jpeg) => {
          try {
            controller.enqueue(enc.encode(`Content-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`));
            controller.enqueue(new Uint8Array(jpeg));
            controller.enqueue(enc.encode("\r\n--frame\r\n"));
          } catch {
            end();
          }
        });
        if (req.signal.aborted) end();
      } catch {
        end();
      }
    },
    cancel() {
      void stop?.();
    },
  });
  return new Response(body, {
    headers: { "Content-Type": "multipart/x-mixed-replace; boundary=frame", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" },
  });
}
