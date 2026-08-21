/**
 * Role-based provider routing: "Provider selection is config, not model-facing"
 * (deepseek-harness subagent seam rule, finally honored).
 *
 * Roles (user-tuned layering, 2026-08-19):
 *   executor — tool-grade domestic models for generation-heavy work
 *              (code writing, batch operations): fast, good enough.
 *   reviewer  — the strong model for gatekeeping (new-code review, discussion,
 *              summarization): slow is fine, quality is the point.
 *   advisor   — free-form Q&A / perspective supplementation.
 *
 * Failover walks the role chain ONLY on pre-send infrastructural failures.
 * Anything after the prompt reached the page stays on the same provider:
 * the SEND_IDEMPOTENCY_UNKNOWN contract must never silently resend elsewhere.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ToolError } from "./errors.js";
import { providerDefinitions } from "./providerRegistry.js";
import { logTurnEvent } from "./turnLog.js";

export type RoleName = "executor" | "reviewer" | "advisor";

export interface RoleConfig {
  chain: string[];
}

export interface RolesConfig {
  executor: RoleConfig;
  reviewer: RoleConfig;
  advisor: RoleConfig;
}

const DEFAULT_ROLES: RolesConfig = {
  executor: { chain: ["deepseek", "glm"] },
  reviewer: { chain: ["chatgpt", "glm"] },
  advisor: { chain: ["deepseek", "glm", "chatgpt"] }
};

function knownProviderIds(): Set<string> {
  return new Set(providerDefinitions.map((definition) => definition.providerId));
}

async function loadRolesConfig(): Promise<RolesConfig> {
  const path = process.env.WEB_AGENT_ROLES_CONFIG
    ?? join(process.env.WEB_AGENT_TOOLS_HOME || join(homedir(), ".web-agent-tools"), "config.json");
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as { roles?: Partial<Record<RoleName, RoleConfig>> };
    if (!raw.roles) return DEFAULT_ROLES;
    const known = knownProviderIds();
    const merged: RolesConfig = { ...DEFAULT_ROLES };
    for (const role of ["executor", "reviewer", "advisor"] as const) {
      const chain = raw.roles[role]?.chain;
      if (Array.isArray(chain) && chain.length > 0 && chain.every((id) => typeof id === "string" && known.has(id))) {
        merged[role] = { chain };
      }
    }
    return merged;
  } catch {
    return DEFAULT_ROLES; // missing or invalid file falls back to defaults
  }
}

let cachedRoles: Promise<RolesConfig> | undefined;

export function rolesConfig(): Promise<RolesConfig> {
  cachedRoles ??= loadRolesConfig();
  return cachedRoles;
}

/** Chain for a role, with an explicit override pinning to a single provider. */
export async function roleChain(role: RoleName, override?: string): Promise<string[]> {
  if (override) return [override];
  const config = await rolesConfig();
  return [...config[role].chain];
}

/** Pre-send infrastructural failures are safe to retry on the next chain member. */
function safeToFallback(error: unknown): boolean {
  if (!(error instanceof ToolError)) return false;
  const infraCodes = new Set([
    "PROVIDER_UNAVAILABLE", "LOGIN_REQUIRED", "CAPTCHA_REQUIRED", "TWO_FACTOR_REQUIRED",
    "RISK_CONTROL", "TERMS_DIALOG", "PROVIDER_BUSY", "BROWSER_DISCONNECTED"
  ]);
  if (infraCodes.has(error.code)) return true;
  if (error.code === "UI_DRIFT") {
    const phase = error.details?.phase;
    return phase === "inspect" || phase === "composer" || phase === "send";
  }
  return false;
}

export async function runWithRoleFallback<T>(
  role: RoleName,
  tool: string,
  requestId: string,
  override: string | undefined,
  attempt: (providerId: string) => Promise<T>
): Promise<T> {
  const chain = await roleChain(role, override);
  let lastError: unknown;
  for (let index = 0; index < chain.length; index++) {
    const providerId = chain[index];
    if (index === 0) {
      try {
        return await attempt(providerId);
      } catch (error) {
        lastError = error;
        if (index === chain.length - 1 || !safeToFallback(error)) throw error;
      }
      continue;
    }
    logTurnEvent({
      event: "role.fallback",
      tool,
      provider: providerId,
      requestId,
      from: chain[index - 1],
      reason: lastError instanceof ToolError ? lastError.code : "UNKNOWN"
    });
    try {
      return await attempt(providerId);
    } catch (error) {
      lastError = error;
      if (index === chain.length - 1 || !safeToFallback(error)) throw error;
    }
  }
  throw lastError;
}
