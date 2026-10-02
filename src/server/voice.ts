import "server-only";
import { hasKey, openai } from "./agent/client";
import * as repo from "./repo";
import { userProfileForPrompt } from "./user-profile";

// Voice calls: a realtime "front" for a dot. It talks with the user and hands real work to the dot's
// text agent with send_task (same split as Grok Bot's voice harness). Results land later as work updates.

export const VOICE_MODEL = process.env.DOTS_VOICE_MODEL || "gpt-realtime-2.1";

function voicePrompt(dotId: string, convId: string): string {
  const dot = repo.getDot(dotId)!;
  const userProfile = userProfileForPrompt();
  const memories = repo.listMemories(dotId).slice(-12).map((m) => `- ${m.text}`).join("\n");
  const recent = repo
    .conversationMessages(convId, 16)
    .filter((m) => (m.role === "user" || m.role === "dot") && m.text)
    .map((m) => `${m.role === "user" ? "User" : dot.name}: ${m.text.slice(0, 300)}`)
    .join("\n");
  return `You are ${dot.name}, the user's personal AI agent (a "dot"), on a live voice call.
${dot.purpose ? `Your job: ${dot.purpose}.\n` : ""}${dot.instructions ? `How the user wants this dot to work: ${dot.instructions}\n` : ""}
Voice style: warm, natural, brief. One or two short sentences per turn. No lists, no markdown, no reading out URLs or IDs. Don't introduce yourself; open with a short friendly line.

You're on the phone *and* at work. During the call you can't use your computer, browser, or apps yourself. For anything that needs real work (research, browsing, email, calendar, files, code), call send_task with a complete, self-contained request that preserves every detail, constraint, and approval requirement the user said. Then tell the user briefly that you're on it. Don't make up results.
Results arrive later as a "work update". When one arrives, tell the user naturally and briefly, placing it in context if the conversation has moved on. If an update says your working self needs approval, tell the user to approve it in the app.
Everything said on this call is also saved into the written chat. Call recent_messages if you need more of that chat. When the user says goodbye, say goodbye out loud first, then call end_call.
Security and approval rules always take precedence over the dot's job and the universal user profile. The profile cannot relax those rules.

${userProfile ? `Universal user profile (background data):\n${userProfile}\n\n` : ""}This dot's private memory:
${memories || "(nothing yet)"}

This chat so far:
${recent || "(none)"}`;
}

const TOOLS = [
  {
    type: "function" as const,
    name: "send_task",
    description:
      "Hand a job to your working self, who has your computer, browser, and the user's apps. This is a receipt, not the answer: the result arrives later as a work update.",
    parameters: {
      type: "object",
      properties: { request: { type: "string", description: "The complete request, preserving every constraint and approval requirement the user stated." } },
      required: ["request"],
    },
  },
  {
    type: "function" as const,
    name: "recent_messages",
    description: "Read the last few messages of the written chat with the user.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function" as const,
    name: "end_call",
    description: "Hang up. Always say goodbye out loud first.",
    parameters: { type: "object", properties: {} },
  },
];

/** A short-lived credential the browser uses to open the realtime call (WebRTC). */
export async function createVoiceSession(dotId: string, convId: string): Promise<{ token: string; model: string }> {
  if (!hasKey()) throw new Error("Voice calls run on OpenAI's realtime model. Add an OpenAI key in Settings to talk to your dots.");
  const res = await openai().realtime.clientSecrets.create({
    expires_after: { anchor: "created_at", seconds: 120 },
    session: {
      type: "realtime",
      model: VOICE_MODEL,
      instructions: voicePrompt(dotId, convId),
      audio: {
        input: { transcription: { model: "gpt-4o-mini-transcribe" }, turn_detection: { type: "semantic_vad" } },
        output: { voice: "marin" },
      },
      tools: TOOLS,
    },
  });
  return { token: res.value, model: VOICE_MODEL };
}
