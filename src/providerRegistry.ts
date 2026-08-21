/**
 * Named-provider registry (chatgpt / deepseek / glm).
 *
 * Pattern from deepseek-harness `ctx.subagents` (docs/subsystems/subagent.md):
 * providers are named, coexisting implementations behind one stable tool face;
 * "provider selection is config, not model-facing". Here the model MAY name a
 * provider explicitly (it is an argument, not an implementation detail), but the
 * set of providers and their surfaces is fixed at startup and duplicated
 * registration is a hard error — mirroring
 * web-agent-codex-runtime/src/runtime/providerRegistry.ts.
 */
import type { ToolErrorDetails } from "./errors.js";
import { ToolError } from "./errors.js";

export interface ProviderSurface {
  providerId: string;
  surfaceId: string;
  url: string;
}

export interface ProviderDefinition {
  providerId: "chatgpt" | "deepseek" | "glm";
  displayName: string;
  surface: ProviderSurface;
}

const PROVIDER_SURFACE_URLS: Record<ProviderDefinition["providerId"], string> = {
  chatgpt: "https://chatgpt.com/",
  deepseek: "https://chat.deepseek.com/",
  glm: "https://chatglm.cn/"
};

export const providerDefinitions: ProviderDefinition[] = [
  { providerId: "chatgpt", displayName: "ChatGPT Web", surface: { providerId: "chatgpt", surfaceId: "chatgpt-main", url: PROVIDER_SURFACE_URLS.chatgpt } },
  { providerId: "deepseek", displayName: "DeepSeek Web", surface: { providerId: "deepseek", surfaceId: "deepseek-main", url: PROVIDER_SURFACE_URLS.deepseek } },
  { providerId: "glm", displayName: "GLM Web (智谱清言)", surface: { providerId: "glm", surfaceId: "glm-main", url: PROVIDER_SURFACE_URLS.glm } }
];

const registered = new Map<string, ProviderDefinition>(providerDefinitions.map((definition) => [definition.providerId, definition]));

export function resolveProvider(providerId: string): ProviderDefinition {
  const definition = registered.get(providerId);
  if (!definition) {
    throw new ToolError("INVALID_ARGUMENT",
      `Unknown provider "${providerId}". Available: ${[...registered.keys()].join(", ")}.`,
      { provider: providerId, available: [...registered.keys()] } satisfies ToolErrorDetails);
  }
  return definition;
}

export function listProviders(): ProviderDefinition[] {
  return [...registered.values()];
}
