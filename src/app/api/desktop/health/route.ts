import { isTrustedLoopbackRequest, loopbackForbiddenResponse } from "@/server/security";

// Startup identity check: never attach the desktop window to an unrelated service on its port.
export const dynamic = "force-dynamic";
export function GET(req: Request) {
  if (!isTrustedLoopbackRequest(req)) return loopbackForbiddenResponse();
  return new Response(process.env.DOTS_DESKTOP_INSTANCE || "", { headers: { "Cache-Control": "no-store" } });
}
