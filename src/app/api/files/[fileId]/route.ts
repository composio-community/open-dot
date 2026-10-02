import { get } from "@/server/files";
import { isTrustedLoopbackRequest, loopbackForbiddenResponse } from "@/server/security";

// Download or preview a file. Images/PDFs render inline; `?download=1` forces a download.
export async function GET(req: Request, ctx: RouteContext<"/api/files/[fileId]">) {
  if (!isTrustedLoopbackRequest(req)) return loopbackForbiddenResponse();
  const { fileId } = await ctx.params;
  const f = get(fileId);
  if (!f) return new Response("Not found", { status: 404 });
  const inline = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain)$/.test(f.mime) && new URL(req.url).searchParams.get("download") !== "1";
  return new Response(new Uint8Array(f.data()), {
    headers: {
      "Content-Type": f.mime,
      "Content-Length": String(f.size),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
