import "server-only";
import crypto from "node:crypto";
import http from "node:http";
import OpenAI from "openai";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { getSetting, setSetting } from "../db";
import { seal, unseal } from "../vault";

export const CHATGPT_PREFIX = "chatgpt:";
const AUTH_SETTING = "chatgpt_oauth";
const HOST_SETTING = "chatgpt_host_id";
const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const REVOKE_URL = "https://auth.openai.com/api/accounts/oauth/revoke";
const JWKS = createRemoteJWKSet(new URL("https://auth.openai.com/.well-known/jwks.json"));
const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const SHARING_SCOPE = "chatgpt.tokens.use.direct";
const DYNAMIC_CLIENT = "dynamic_agent_client";
// The account catalog can lag behind direct-route availability during model rollouts.
// Keep the current public flagship aliases visible as a compatibility overlay; the
// Responses request remains the final entitlement check for a selected model.
const CURRENT_PUBLIC_MODELS = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"] as const;

type Registration = {
  clientId: string;
  subject: string;
  email?: string;
  name?: string;
};

type Tokens = {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  tokenType: string;
  expiresAt: number;
  scopes: string[];
  savedAt: number;
};

type Stored = { registration?: Registration; tokens?: Tokens };
type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

type Pending = {
  server: http.Server;
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  expectedClientId: string | null;
  expectedSubject: string | null;
  timeout: NodeJS.Timeout;
};

const g = globalThis as unknown as {
  __dotsChatGPTPending?: Pending;
  __dotsChatGPTRefresh?: Promise<string>;
  __dotsChatGPTClient?: { token: string; client: OpenAI };
  __dotsChatGPTModels?: { at: number; ids: string[] };
};

function load(): Stored {
  const raw = getSetting(AUTH_SETTING);
  if (!raw) return {};
  try {
    return JSON.parse(unseal(raw)) as Stored;
  } catch {
    return {};
  }
}

function save(value: Stored) {
  setSetting(AUTH_SETTING, seal(JSON.stringify(value)));
}

function hostId(): string {
  const existing = getSetting(HOST_SETTING);
  if (existing) return existing;
  const created = `urn:uuid:${crypto.randomUUID()}`;
  setSetting(HOST_SETTING, created);
  return created;
}

function sharing(tokens?: Tokens): boolean {
  return Boolean(tokens?.accessToken && tokens.scopes.includes(SHARING_SCOPE));
}

export function chatGPTStatus(): {
  connected: boolean;
  sharing: boolean;
  email: string | null;
  name: string | null;
} {
  const stored = load();
  return {
    connected: Boolean(stored.registration && stored.tokens),
    sharing: sharing(stored.tokens),
    email: stored.registration?.email ?? null,
    name: stored.registration?.name ?? null,
  };
}

export const isChatGPTModel = (model: string) => model.startsWith(CHATGPT_PREFIX);
export const chatGPTModelId = (model: string) => model.slice(CHATGPT_PREFIX.length);

function randomBase64Url(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function callbackPage(message: string, ok: boolean) {
  const title = ok ? "Connected to ChatGPT" : "ChatGPT sign-in failed";
  const safe = message.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{font:15px -apple-system,BlinkMacSystemFont,sans-serif;background:#f7f7f5;color:#222;display:grid;place-items:center;min-height:100vh;margin:0}.card{max-width:460px;padding:28px 30px;border:1px solid #ddd;border-radius:16px;background:#fff;box-shadow:0 12px 40px #0001}h1{font-size:20px;margin:0 0 10px}p{color:#666;line-height:1.5;margin:0}</style></head><body><div class="card"><h1>${title}</h1><p>${safe}</p></div></body></html>`;
}

async function notifyChanged() {
  g.__dotsChatGPTModels = undefined;
  g.__dotsChatGPTClient = undefined;
  const [{ resetModels }, { computerInfo }, { emit }] = await Promise.all([import("./client"), import("../snapshot"), import("../bus")]);
  resetModels();
  emit({ type: "computer", data: computerInfo() });
  void import("./client")
    .then(({ models }) => models())
    .then(async () => {
      const [{ computerInfo }, { emit }] = await Promise.all([import("../snapshot"), import("../bus")]);
      emit({ type: "computer", data: computerInfo() });
    })
    .catch(() => {});
}

async function exchangeCode(code: string, clientId: string, verifier: string, redirectUri: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    resource: RESOURCE,
  });
  const res = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok) throw new Error(data.error_description || data.error || `Token exchange failed (${res.status}).`);
  return data;
}

async function completeCallback(url: URL, pending: Pending): Promise<string> {
  if (url.searchParams.get("state") !== pending.state) throw new Error("The sign-in response did not match this request.");
  const oauthError = url.searchParams.get("error");
  if (oauthError) throw new Error(url.searchParams.get("error_description") || (oauthError === "access_denied" ? "Sign-in was cancelled." : oauthError));
  const code = url.searchParams.get("code");
  if (!code) throw new Error("OpenAI did not return an authorization code.");

  const callbackClientId = url.searchParams.get("client_id");
  let clientId = pending.expectedClientId;
  if (clientId) {
    if (callbackClientId && callbackClientId !== clientId) throw new Error("OpenAI returned a different client registration than expected.");
  } else {
    if (!callbackClientId || callbackClientId === DYNAMIC_CLIENT) throw new Error("OpenAI did not return the issued client ID for this registration.");
    clientId = callbackClientId;
  }

  const token = await exchangeCode(code, clientId, pending.verifier, pending.redirectUri);
  if (!token.access_token || !token.refresh_token || !token.id_token) throw new Error("OpenAI returned an incomplete token set.");
  const verified = await jwtVerify(token.id_token, JWKS, { issuer: ISSUER, audience: clientId });
  if (verified.payload.nonce !== pending.nonce) throw new Error("The OpenAI identity token did not match this sign-in request.");
  if (typeof verified.payload.sub !== "string" || !verified.payload.sub) throw new Error("The OpenAI identity token did not include an account identifier.");
  if (pending.expectedSubject && verified.payload.sub !== pending.expectedSubject) throw new Error("A different ChatGPT account was selected. Start a new registration to use another account.");

  const scopes = (token.scope ?? "").split(/\s+/).filter(Boolean);
  const expiresIn = typeof token.expires_in === "number" && token.expires_in > 0 ? token.expires_in : 3600;
  save({
    registration: {
      clientId,
      subject: verified.payload.sub,
      ...(typeof verified.payload.email === "string" ? { email: verified.payload.email } : {}),
      ...(typeof verified.payload.name === "string" ? { name: verified.payload.name } : {}),
    },
    tokens: {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      idToken: token.id_token,
      tokenType: token.token_type || "Bearer",
      expiresAt: Date.now() + expiresIn * 1000,
      scopes,
      savedAt: Date.now(),
    },
  });
  await notifyChanged();
  return scopes.includes(SHARING_SCOPE)
    ? "Your ChatGPT plan is connected to Open Dot. You can close this tab."
    : "Your ChatGPT account is connected, but ChatGPT plan usage was not enabled. Return to Open Dot to enable it or use an API key.";
}

function cancelPending() {
  const pending = g.__dotsChatGPTPending;
  if (!pending) return;
  clearTimeout(pending.timeout);
  pending.server.close();
  g.__dotsChatGPTPending = undefined;
}

export async function startChatGPTSignIn(reconsent = false): Promise<string> {
  cancelPending();
  const stored = load();
  const returning = Boolean(stored.registration);
  const state = randomBase64Url();
  const nonce = randomBase64Url();
  const verifier = randomBase64Url(48);
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");

  let resolveReady!: (value: { server: http.Server; redirectUri: string }) => void;
  let rejectReady!: (reason?: unknown) => void;
  const ready = new Promise<{ server: http.Server; redirectUri: string }>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const server = http.createServer((req, res) => {
    void (async () => {
      const pending = g.__dotsChatGPTPending;
      if (!pending || !req.url) {
        res.writeHead(410, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("This sign-in request is no longer active.");
        return;
      }
      const url = new URL(req.url, pending.redirectUri);
      if (url.pathname !== "/auth/callback") {
        res.writeHead(404).end();
        return;
      }
      let ok = false;
      let message: string;
      try {
        message = await completeCallback(url, pending);
        ok = true;
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(callbackPage(message, ok));
      cancelPending();
    })();
  });
  server.once("error", rejectReady);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") return rejectReady(new Error("Could not start the ChatGPT sign-in callback."));
    resolveReady({ server, redirectUri: `http://127.0.0.1:${address.port}/auth/callback` });
  });

  const listening = await ready;
  const timeout = setTimeout(cancelPending, 5 * 60_000);
  g.__dotsChatGPTPending = {
    server: listening.server,
    state,
    nonce,
    verifier,
    redirectUri: listening.redirectUri,
    expectedClientId: stored.registration?.clientId ?? null,
    expectedSubject: stored.registration?.subject ?? null,
    timeout,
  };

  const params = new URLSearchParams({
    client_id: stored.registration?.clientId ?? DYNAMIC_CLIENT,
    ext_agent_host_id: hostId(),
    response_type: "code",
    redirect_uri: listening.redirectUri,
    scope: SCOPES,
    resource: RESOURCE,
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  if (!returning) params.set("agent_name_hint", "Open Dot");
  if (returning && stored.tokens?.idToken) params.set("id_token_hint", stored.tokens.idToken);
  if (returning && stored.registration?.email) params.set("login_hint", stored.registration.email);
  if (reconsent) params.set("prompt", "consent");
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function refreshAccessToken(): Promise<string> {
  const stored = load();
  if (!stored.registration || !stored.tokens?.refreshToken) throw new Error("ChatGPT is not connected. Sign in from Settings.");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: stored.registration.clientId,
    refresh_token: stored.tokens.refreshToken,
    resource: RESOURCE,
  });
  const res = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !data.access_token || !data.refresh_token) {
    const terminal = res.status === 400 && /invalid_grant|refresh_token_(expired|invalidated|reused)|invalid_refresh_token|token_expired/i.test(JSON.stringify(data));
    if (terminal) {
      save({ registration: stored.registration });
      await notifyChanged();
    }
    throw new Error(data.error_description || data.error || `Could not refresh ChatGPT sign-in (${res.status}).`);
  }
  const expiresIn = typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : 3600;
  const next: Stored = {
    registration: stored.registration,
    tokens: {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      idToken: data.id_token || stored.tokens.idToken,
      tokenType: data.token_type || stored.tokens.tokenType || "Bearer",
      expiresAt: Date.now() + expiresIn * 1000,
      scopes: data.scope ? data.scope.split(/\s+/).filter(Boolean) : stored.tokens.scopes,
      savedAt: Date.now(),
    },
  };
  save(next);
  g.__dotsChatGPTClient = undefined;
  g.__dotsChatGPTModels = undefined;
  return data.access_token;
}

export async function chatGPTAccessToken(): Promise<string> {
  const stored = load();
  if (!stored.tokens || !sharing(stored.tokens)) throw new Error("ChatGPT plan usage is not enabled. Connect it in Settings or use an OpenAI API key.");
  if (stored.tokens.expiresAt > Date.now() + 60_000) return stored.tokens.accessToken;
  g.__dotsChatGPTRefresh ??= refreshAccessToken().finally(() => {
    g.__dotsChatGPTRefresh = undefined;
  });
  return g.__dotsChatGPTRefresh;
}

export async function chatGPTClient(): Promise<OpenAI> {
  const token = await chatGPTAccessToken();
  if (g.__dotsChatGPTClient?.token !== token) {
    g.__dotsChatGPTClient = { token, client: new OpenAI({ apiKey: token, baseURL: RESOURCE, maxRetries: 0 }) };
  }
  return g.__dotsChatGPTClient.client;
}

/** Account-visible ChatGPT-plan models, preserving OpenAI's display order. */
export async function chatGPTModels(): Promise<string[]> {
  if (!chatGPTStatus().sharing) return [];
  if (g.__dotsChatGPTModels && Date.now() - g.__dotsChatGPTModels.at < 10 * 60_000) return g.__dotsChatGPTModels.ids;
  const token = await chatGPTAccessToken();
  const res = await fetch(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`ChatGPT models: ${res.status}`);
  const body = (await res.json()) as { models?: { slug?: string; visibility?: string; display_name?: string }[] };
  const listed = (body.models ?? [])
    .filter((m) => m.visibility === "list" && typeof m.slug === "string" && m.slug)
    .map((m) => m.slug!);

  const slugs = [
    ...CURRENT_PUBLIC_MODELS,
    ...listed.filter((slug) => !CURRENT_PUBLIC_MODELS.includes(slug as (typeof CURRENT_PUBLIC_MODELS)[number])),
  ];
  const ids = slugs.map((slug) => CHATGPT_PREFIX + slug);
  g.__dotsChatGPTModels = { at: Date.now(), ids };
  return ids;
}

export async function disconnectChatGPT(): Promise<string | null> {
  cancelPending();
  const stored = load();
  let warning: string | null = null;
  if (stored.registration && stored.tokens?.refreshToken) {
    try {
      const res = await fetch(REVOKE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: stored.tokens.refreshToken, token_type_hint: "refresh_token", client_id: stored.registration.clientId }),
      });
      if (!res.ok) warning = "Signed out locally, but OpenAI could not confirm session revocation. You can also disconnect Open Dot in ChatGPT settings.";
    } catch {
      warning = "Signed out locally, but OpenAI could not confirm session revocation. You can also disconnect Open Dot in ChatGPT settings.";
    }
  }
  save(stored.registration ? { registration: stored.registration } : {});
  g.__dotsChatGPTClient = undefined;
  g.__dotsChatGPTModels = undefined;
  await notifyChanged();
  return warning;
}
