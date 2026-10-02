import { lastScreenshot, screenshot } from "@/server/computer";
import { getDot } from "@/server/repo";
import { isTrustedLoopbackRequest, loopbackForbiddenResponse } from "@/server/security";

// Latest frame of the dot's screen. `?fresh=1` captures a new one.
export async function GET(req: Request, ctx: RouteContext<"/api/dots/[id]/screen">) {
  if (!isTrustedLoopbackRequest(req)) return loopbackForbiddenResponse();
  const { id } = await ctx.params;
  if (!getDot(id)) return Response.json({ error: "Dot not found" }, { status: 404 });
  const fresh = new URL(req.url).searchParams.get("fresh") === "1";
  const shot = fresh ? await screenshot(id).catch(() => null) : await lastScreenshot(id);
  if (!shot) return new Response(null, { status: 204 });
  return new Response(new Uint8Array(shot), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } });
}
