import { conversationMessages, getConversation } from "@/server/repo";
import { isTrustedLoopbackRequest, loopbackForbiddenResponse } from "@/server/security";

// Full history of one conversation (the live snapshot only carries recent messages).
export async function GET(req: Request, ctx: RouteContext<"/api/conversations/[id]">) {
  if (!isTrustedLoopbackRequest(req)) return loopbackForbiddenResponse();
  const { id } = await ctx.params;
  if (!getConversation(id)) return Response.json({ error: "Conversation not found", messages: [] }, { status: 404 });
  return Response.json({ messages: conversationMessages(id, 1000) });
}
