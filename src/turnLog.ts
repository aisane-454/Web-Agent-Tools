import { appendFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Append-only event-sourced call log (schema v2).
 *
 * Evolved from web-agent-codex-runtime/src/runtime/turnLog.ts toward the
 * deepseek-harness session-log discipline (docs/architecture.md:92-96
 * "Model-visible means logged"): every call opens with a request envelope
 * (call.envelope) and closes with a settlement record (call.settled), so a
 * failure can be replayed analytically from the log alone — provider, prompt
 * fingerprint, per-stage timings, counters and outcome — without ever storing
 * prompt or answer TEXT (privacy: fingerprints only).
 *
 * MCP stdio owns stdout; the sink is a file, never console.log.
 */
export const TURN_LOG_SCHEMA_VERSION = 2;

export type TurnLogEvent =
  | {
      event: "call.envelope";
      schemaVersion: 2;
      tool: "web_ask" | "web_review" | "web_delegate" | "web_council" | "web_status" | "web_handoff";
      requestId: string;
      provider?: string;
      promptFingerprint?: string;
      promptCharacters?: number;
      timeoutMs?: number;
      cdpUrl: string;
    }
  | {
      event: "provider.stage";
      schemaVersion: 2;
      provider: string;
      requestId: string;
      stage: string;
      durationMs: number;
      [key: string]: unknown;
    }
  | {
      event: "call.settled";
      schemaVersion: 2;
      tool: string;
      requestId: string;
      provider?: string;
      ok: boolean;
      durationMs: number;
      answerCharacters?: number;
      errorCode?: string;
    }
  | {
      event: "server.start" | "server.stop";
      schemaVersion: 2;
      [key: string]: unknown;
    };

function logFilePath(): string {
  return process.env.WEB_AGENT_TURN_LOG
    ?? join(process.env.WEB_AGENT_TOOLS_HOME || join(homedir(), ".web-agent-tools"), "logs", "turns.jsonl");
}

/** Irreversible, content-free identity of a prompt (first 16 hex chars). */
export function fingerprint(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

let appendChain: Promise<void> = Promise.resolve();

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/** What callers write; schemaVersion is injected on persist. */
export type TurnLogInput = DistributiveOmit<TurnLogEvent, "schemaVersion">;

/**
 * Full-artifact snapshots (2026-08-21): the event log alone stores fingerprints, so
 * intermediate products vanished once a call returned. Per the pull-based audit
 * doctrine — "not pushed into the outer context" is a token decision, never
 * information hiding — every meaningful text is snapshotted to disk and indexed
 * from the event stream by hash. The outer agent reads on demand.
 */
export async function storeArtifact(requestId: string, kind: string, text: string): Promise<string | undefined> {
  try {
    const hash = createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
    const day = new Date().toISOString().slice(0, 10);
    const file = join(dirname(logFilePath()), "artifacts", day, `${requestId}-${kind}-${hash.slice(0, 8)}.txt`);
    const { writeFile } = await import("node:fs/promises");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text, { encoding: "utf8", mode: 0o600 });
    logTurnEvent({ event: "artifact.stored", requestId, kind, artifactHash: hash, characters: text.length, artifactPath: file } as never);
    return hash;
  } catch {
    // Snapshots are audit gravy, never a request-path dependency.
    return undefined;
  }
}

export function logTurnEvent(event: TurnLogInput): void {
  const record = JSON.stringify({ ts: new Date().toISOString(), schemaVersion: TURN_LOG_SCHEMA_VERSION, ...event });
  appendChain = appendChain.then(async () => {
    try {
      const path = logFilePath();
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, record + "\n", { encoding: "utf8", mode: 0o600 });
    } catch {
      // Diagnostics must not surface inside the request path.
    }
  });
}
