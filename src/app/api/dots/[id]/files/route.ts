import { MAX_UPLOAD, upload } from "@/server/files";
import { getDot } from "@/server/repo";
import { isTrustedLoopbackRequest, loopbackForbiddenResponse } from "@/server/security";

// The user attaches files in chat. Returns the stored attachments.
export async function POST(req: Request, ctx: RouteContext<"/api/dots/[id]/files">) {
  if (!isTrustedLoopbackRequest(req)) return loopbackForbiddenResponse();
  const { id } = await ctx.params;
  if (!getDot(id)) return Response.json({ error: "Dot not found" }, { status: 404 });
  try {
    const form = await req.formData();
    const out = [];
    for (const entry of form.getAll("file")) {
      if (!(entry instanceof File)) continue;
      if (entry.size > MAX_UPLOAD) return Response.json({ error: `${entry.name} is over 25 MB.` }, { status: 413 });
      const f = await upload(id, entry.name, entry.type, Buffer.from(await entry.arrayBuffer()));
      out.push({ id: f.id, name: f.name, mime: f.mime, size: f.size });
    }
    return Response.json({ files: out });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
