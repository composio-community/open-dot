import { isTrustedLoopbackRequest, loopbackForbiddenResponse } from "@/server/security";

// Details for one app (tools, triggers, suggested prompts), parsed from Composio's public toolkit page.

type AppDetail = {
  slug: string;
  description: string;
  prompts: string[];
  tools: { slug: string; name: string; description: string }[];
  auth: string[];
};

const g = globalThis as unknown as { __dotsAppDetails?: Map<string, { at: number; data: AppDetail }> };
const cache = (g.__dotsAppDetails ??= new Map());
const DAY = 24 * 60 * 60 * 1000;

function section(md: string, title: string): string {
  const m = md.match(new RegExp(`^## ${title}\\s*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m"));
  return m?.[1] ?? "";
}

function parse(slug: string, md: string): AppDetail {
  const tools = [...section(md, "Supported Tools").matchAll(/^\|\s*`([^`]+)`\s*\|\s*([^|]*)\|\s*([^|]*)\|/gm)].map((m) => ({
    slug: m[1].trim(),
    name: m[2].trim(),
    description: m[3].trim(),
  }));
  return {
    slug,
    description: section(md, "Description").trim(),
    prompts: [...section(md, "Suggested Prompts").matchAll(/^- (.+)$/gm)].map((m) => m[1].trim()),
    tools,
    auth: [...section(md, "Authentication").matchAll(/^- \*\*(.+?)\*\*/gm)].map((m) => m[1].trim()),
  };
}

export async function GET(req: Request, ctx: RouteContext<"/api/apps/[slug]">) {
  if (!isTrustedLoopbackRequest(req)) return loopbackForbiddenResponse();
  const { slug } = await ctx.params;
  if (!/^[a-z0-9_-]+$/i.test(slug)) return Response.json({ error: "bad slug" }, { status: 400 });
  const hit = cache.get(slug);
  if (hit && Date.now() - hit.at < DAY) return Response.json(hit.data);
  const res = await fetch(`https://composio.dev/toolkits/${slug}.md`, { headers: { "user-agent": "dots/1.0" }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!res?.ok) return Response.json({ error: "Couldn't load this app's details." }, { status: 502 });
  const data = parse(slug, await res.text());
  cache.set(slug, { at: Date.now(), data });
  return Response.json(data);
}
