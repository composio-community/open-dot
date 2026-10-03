import "server-only";
import { routerClient, routerKey, routerModels, routerSource, saveRouter } from "./routers";
import { modelLabel } from "@/lib/model-providers";

// Compatibility for existing OpenRouter profiles and model IDs.
export const OPENROUTER_PREFIX = "openrouter:";
export const openRouterKey = () => routerKey("openrouter");
export const openRouterSource = () => routerSource("openrouter");
export const isOpenRouterModel = (model: string) => model.startsWith(OPENROUTER_PREFIX);
export const openRouterId = (model: string) => model.slice(OPENROUTER_PREFIX.length);
export const openrouter = () => routerClient("openrouter:default").client;
export const saveOpenRouterKey = (key: string) => saveRouter("openrouter", key, "https://openrouter.ai/api/v1", "");
export const openModels = () => routerModels();
const pick = (ids: string[], prefs: RegExp[]) => prefs.map((re) => ids.find((id) => re.test(modelLabel(id)))).find(Boolean) ?? ids[0];
export const preferredOpenModel = (ids: string[]) => pick(ids, [/kimi-k\d/, /deepseek-v\d/, /glm-[\d.]+/, /qwen.*coder/, /gpt-oss-120b/]);
export const smallOpenModel = (ids: string[]) => pick(ids, [/gpt-oss-20b/, /deepseek.*flash/, /glm-.*(air|flash)/, /gpt-.*mini/, /mistral-small/]);
