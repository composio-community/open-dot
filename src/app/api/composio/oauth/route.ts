import { emit } from "@/server/bus";
import { finishSignIn } from "@/server/composio";
import { computerInfo } from "@/server/snapshot";
import { isTrustedLoopbackRequest, loopbackForbiddenResponse } from "@/server/security";

// Composio For You sends the user back here after they sign in. Sign-in happens in the user's own browser
// (a separate tab, or the default browser from the desktop app), so this page just says it worked; the app
// itself updates live through the event stream.
export async function GET(req: Request) {
  if (!isTrustedLoopbackRequest(req, true)) return loopbackForbiddenResponse();
  const params = new URL(req.url).searchParams;
  const code = params.get("code");
  let error = params.get("error_description") ?? params.get("error");
  if (!code && !error) error = "Missing sign-in code. Start sign-in again from Open Dot Settings.";
  if (code && !error) {
    try {
      await finishSignIn(code);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
  emit({ type: "computer", data: computerInfo() });
  return new Response(page(error), { status: error ? 400 : 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(error: string | null): string {
  const title = error ? "Couldn't sign in to Composio" : "You're signed in to Composio";
  const body = error ? escape(error) : "Your dots can use your apps now. You can close this tab and go back to Open Dot.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Open Dot</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f6f6; --card: #fff; --fg: #0a0a0a; --muted: #0a0a0a99; --line: #0a0a0a14; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0e0e0e; --card: #171717; --fg: #f4f4f4; --muted: #f4f4f499; --line: #ffffff14; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
    font: 15px/1.5 -apple-system, system-ui, sans-serif; padding: 16px; box-sizing: border-box; }
  .card { max-width: 420px; width: 100%; background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 32px; }
  .dots { display: flex; margin-bottom: 20px; } .dots span { width: 16px; height: 16px; border-radius: 50%; margin-right: -4px; box-shadow: 0 0 0 3px var(--card); }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; } p { margin: 0; color: var(--muted); }
</style></head><body><div class="card">
<div class="dots"><span style="background:#0a0a0a"></span><span style="background:#51a2ff"></span><span style="background:#c8f169"></span></div>
<h1>${title}</h1><p>${body}</p></div></body></html>`;
}
