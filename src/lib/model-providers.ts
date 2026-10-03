// Endpoints from each service's documentation; similarly named services have separate keys.
export const ROUTER_PROVIDERS = [
  { id: "openrouter", name: "OpenRouter", baseURL: "https://openrouter.ai/api/v1", env: "OPENROUTER_API_KEY", docs: "https://openrouter.ai/docs/api_reference/authentication", responses: true },
  { id: "tokenrouter", name: "TokenRouter (tokenrouter.com)", baseURL: "https://api.tokenrouter.com/v1", env: "TOKENROUTER_API_KEY", docs: "https://www.tokenrouter.com/docs/zcode-setup/", responses: false },
  { id: "tokenrouter-io", name: "TokenRouter (tokenrouter.io)", baseURL: "https://api.tokenrouter.io/v1", env: "TOKENROUTER_IO_API_KEY", docs: "https://www.tokenrouter.io/docs/chat-completions", responses: false },
  { id: "tokenrouter-me", name: "TokenRouter (tokenrouter.me)", baseURL: "https://tokenrouter.me/v1", env: "TOKENROUTER_ME_API_KEY", docs: "https://docs.tokenrouter.me/", responses: false },
  { id: "agentrouter", name: "AgentRouter", baseURL: "https://co.agentrouter.org/v1", env: "AGENTROUTER_API_KEY", docs: "https://co.agentrouter.org/portal/guide", responses: false },
  { id: "nararouter", name: "NaraRouter", baseURL: "https://router.bynara.id/v1", env: "NARAROUTER_API_KEY", docs: "https://router.bynara.id/docs", responses: false },
] as const;

export type RouterId = (typeof ROUTER_PROVIDERS)[number]["id"];
export type RouterStatus = { id: RouterId; source: "env" | "settings" | null; baseURL: string; modelIds: string[] };
export const FREE_OPENROUTER_MODEL = "openrouter:openrouter/free";
export const isFreeOpenRouterModel = (id: string) => id === FREE_OPENROUTER_MODEL || (id.startsWith("openrouter:") && id.endsWith(":free"));
export const routerProvider = (id: string) => ROUTER_PROVIDERS.find((p) => p.id === id);
export function routerModel(id: string) {
  const colon = id.indexOf(":");
  const provider = routerProvider(id.slice(0, colon));
  return provider && colon > 0 ? { provider, model: id.slice(colon + 1) } : null;
}
export const modelLabel = (id: string) => routerModel(id)?.model ?? id;
export const modelProviderLabel = (id: string) => routerModel(id)?.provider.name ?? "OpenAI";
