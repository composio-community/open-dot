import { userInput, type UserInput } from "@/server/computer";
import { getDot } from "@/server/repo";
import { isTrustedLoopbackRequest, loopbackForbiddenResponse } from "@/server/security";

// One mouse / keyboard / navigation event from the Computer tab's live view.
export async function POST(req: Request, ctx: RouteContext<"/api/dots/[id]/input">) {
  if (!isTrustedLoopbackRequest(req)) return loopbackForbiddenResponse();
  const { id } = await ctx.params;
  if (!getDot(id)) return Response.json({ error: "Dot not found" }, { status: 404 });
  try {
    await userInput(id, (await req.json()) as UserInput);
    return new Response(null, { status: 204 });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
