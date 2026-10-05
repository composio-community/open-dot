import "server-only";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const port = process.env.PORT || process.env.OPEN_DOT_PORT || "3100";
const origins = new Set([...LOOPBACK].map(host => new URL(`http://${host}:${port}`).origin));
if (process.env.OPEN_DOT_DEV_URL) {
  const dev = new URL(process.env.OPEN_DOT_DEV_URL);
  if (LOOPBACK.has(dev.hostname) && ["http:", "https:"].includes(dev.protocol)) origins.add(dev.origin);
}

/** Browser-origin protection, not authentication against other local processes. */
export function isTrustedLoopbackRequest(req: Request, oauthCallbackNavigation = false): boolean {
  try {
    const host = req.headers.get("host") || "";
    const target = new URL(`${new URL(req.url).protocol}//${host}`);
    if (target.host !== host.toLowerCase() || !origins.has(target.origin)) return false;

    const origin = req.headers.get("origin");
    if (origin !== null && origin !== target.origin) return false;

    const site = req.headers.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") {
      // The provider returns to this GET callback in the user's default browser.
      return oauthCallbackNavigation && req.method === "GET" && origin === null && req.headers.get("sec-fetch-mode") === "navigate";
    }
    return true;
  } catch {
    return false;
  }
}

export function loopbackForbiddenResponse(): Response {
  return Response.json({ error: "Forbidden: Untrusted origin or host" }, { status: 403 });
}
