import path from "node:path";
import { listFiles, readFile } from "@/server/computer";
import { guessMime } from "@/server/files";
import { getDot } from "@/server/repo";
import { isTrustedLoopbackRequest, loopbackForbiddenResponse } from "@/server/security";

// The dot's workspace: GET lists files; GET ?path=… downloads one.
export async function GET(req: Request, ctx: RouteContext<"/api/dots/[id]/workspace">) {
  if (!isTrustedLoopbackRequest(req)) return loopbackForbiddenResponse();
  const { id } = await ctx.params;
  if (!getDot(id)) return Response.json({ files: [], error: "Dot not found" }, { status: 404 });
  const p = new URL(req.url).searchParams.get("path");
  try {
    if (!p) return Response.json({ files: await listFiles(id) });
    const data = await readFile(id, p);
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": guessMime(p),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(p))}`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    return Response.json({ files: [], error: err instanceof Error ? err.message : String(err) }, { status: p ? 404 : 200 });
  }
}
