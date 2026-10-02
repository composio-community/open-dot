import { NextResponse, type NextRequest } from "next/server";
import { isTrustedLoopbackRequest, loopbackForbiddenResponse } from "./server/security";

// Server Actions have their own POST entry points outside the guarded API routes.
export function proxy(req: NextRequest) {
  if (!["GET", "HEAD"].includes(req.method) && !isTrustedLoopbackRequest(req)) return loopbackForbiddenResponse();
  return NextResponse.next();
}
