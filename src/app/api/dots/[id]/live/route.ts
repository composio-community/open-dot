import { liveUrl } from "@/server/computer";
import { getDot } from "@/server/repo";
import { isTrustedLoopbackRequest, loopbackForbiddenResponse } from "@/server/security";

// Live-view URL for a dot's cloud computer (wakes it if it's asleep). `?interactive=1` for take-over.
export async function GET(req: Request, ctx: RouteContext<"/api/dots/[id]/live">) {
  if (!isTrustedLoopbackRequest(req)) return loopbackForbiddenResponse();
  const { id } = await ctx.params;
  if (!getDot(id)) return Response.json({ url: null, error: "Dot not found" }, { status: 404 });
  const interactive = new URL(req.url).searchParams.get("interactive") === "1";
  try {
    return Response.json({ url: await liveUrl(id, interactive) });
  } catch (err) {
    return Response.json({ url: null, error: err instanceof Error ? err.message : String(err) });
  }
}
