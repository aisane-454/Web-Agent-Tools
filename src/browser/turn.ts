/**
 * One-shot turn orchestration for a single web_ask call.
 *
 * Adapted from web-agent-codex-runtime/src/providers/webProviderAdapter.ts
 * (runTurnOnSurface) with tool-position trims:
 *   - no tool-envelope parsing (the calling agent owns the tool loop);
 *   - no compaction / conversation-state interaction (calls are stateless);
 *   - surface lease released on every exit path (kept from the original).
 *
 * Semantics kept verbatim:
 *   - post-send failures are non-replayable: once the browser accepted the
 *     prompt, the error surfaces as SEND_IDEMPOTENCY_UNKNOWN so no caller can
 *     transparently retry into a duplicate physical send;
 *   - caller cancellation after send stays CANCELLED (2026-08-19 review: never
 *     rewrite an abort into SEND_IDEMPOTENCY_UNKNOWN — different caller intent);
 *   - streamed-vs-final consistency check (answersCompatible);
 *   - copy-first extraction with DOM fallback for the same assistant node;
 *     the fallback only fires when a NEW answer node exists this turn
 *     (after.count > baseline.count) — never returns edited/stale baseline text.
 */
import { ToolError, type ToolErrorDetails } from "../errors.js";
import { logTurnEvent } from "../turnLog.js";
import { providerSelectorManifests } from "./selectors.js";
import { SurfaceLeaseManager } from "./surfaceLease.js";
import type { BrowserPageSnapshot } from "./types.js";
import type { BrowserSurface } from "./types.js";
import { CdpBrowserWorker } from "./cdpWorker.js";

export interface AskTurnResult {
  text: string;
  provider: string;
  durationMs: number;
  answerCharacters: number;
}

export interface AskTurnContext {
  requestId: string;
  onProgress?: (stage: string) => void;
  signal?: AbortSignal;
}

export class WebAskRunner {
  private readonly leases = new SurfaceLeaseManager();

  constructor(private readonly worker: CdpBrowserWorker) {}

  leaseSnapshot() {
    return this.leases.snapshot();
  }

  /**
   * Read-only recovery of the latest COMPLETED answer on a page. Never sends.
   * After a timed-out ask/review the page often finishes the answer later; this
   * mode makes that outcome retrievable without any duplicate-send risk.
   */
  async salvage(surface: BrowserSurface, context: AskTurnContext): Promise<AskTurnResult & { answerCount: number }> {
    const selectors = providerSelectorManifests[surface.providerId];
    if (!selectors) throw new ToolError("PROVIDER_UNAVAILABLE", `No selector manifest for ${surface.providerId}.`, { provider: surface.providerId });
    const startedAt = Date.now();
    const stage = (name: string, fields: Record<string, unknown> = {}): void => {
      logTurnEvent({
        event: "provider.stage", provider: surface.providerId, requestId: context.requestId,
        stage: name, durationMs: Date.now() - startedAt, ...fields
      });
      context.onProgress?.(name);
    };
    const lease = this.leases.acquire(surface.providerId, surface.surfaceId, context.requestId);
    try {
      const page = await this.worker.inspect(surface, context.signal);
      stage("inspect", { inputReady: page.inputReady, generating: page.generating, ...(page.humanActionCode ? { humanActionCode: page.humanActionCode } : {}) });
      if (page.humanActionCode) {
        throw new ToolError(page.humanActionCode,
          `${surface.providerId} requires visible user attention.`, pageDiagnostics(surface.providerId, "salvage-inspect", page));
      }
      // Salvaging mid-generation would return a partial answer — wait for idle.
      if (page.generating) {
        throw new ToolError("PROVIDER_BUSY",
          `${surface.providerId} is still generating; retry salvage once the page goes idle.`, pageDiagnostics(surface.providerId, "salvage-inspect", page));
      }
      const latest = await this.worker.readLatestAnswer(surface, selectors.assistant, context.signal);
      stage("baseline", { answerCount: latest.count, answerCharacters: latest.latestText.length });
      if (latest.count < 1 || !latest.latestText.trim()) {
        throw new ToolError("UI_DRIFT", `${surface.providerId} has no assistant answer to salvage.`, { ...pageDiagnostics(surface.providerId, "salvage", page), answerCount: latest.count });
      }
      let answer: string;
      try {
        const copied = await this.worker.copyLatestAnswer(surface, selectors.copy, context.signal, latest.count - 1);
        answer = selectSameTurnAnswer(copied, latest.latestText);
      } catch (error) {
        // Copy is best-effort here; the DOM text is the recovery path.
        answer = latest.latestText;
        stage("copy_fallback", { answerCount: latest.count, answerCharacters: answer.length, copyError: error instanceof ToolError ? error.code : "UNKNOWN" });
      }
      stage("result", { outcome: "salvage", answerCharacters: answer.length, answerCount: latest.count });
      return { text: answer.trim(), provider: surface.providerId, durationMs: Date.now() - startedAt, answerCharacters: answer.length, answerCount: latest.count };
    } finally {
      lease.release();
    }
  }

  async ask(surface: BrowserSurface, prompt: string, context: AskTurnContext): Promise<AskTurnResult> {    const selectors = providerSelectorManifests[surface.providerId];
    if (!selectors) throw new ToolError("PROVIDER_UNAVAILABLE", `No selector manifest for ${surface.providerId}.`, { provider: surface.providerId });
    const startedAt = Date.now();
    const stage = (name: string, fields: Record<string, unknown> = {}): void => {
      logTurnEvent({
        event: "provider.stage",
        provider: surface.providerId,
        requestId: context.requestId,
        stage: name,
        durationMs: Date.now() - startedAt,
        ...fields
      });
      context.onProgress?.(name);
    };

    const lease = this.leases.acquire(surface.providerId, surface.surfaceId, context.requestId);
    try {
      context.signal?.throwIfAborted?.();
      const page = await this.worker.inspect(surface, context.signal);
      stage("inspect", { inputReady: page.inputReady, generating: page.generating, ...(page.humanActionCode ? { humanActionCode: page.humanActionCode } : {}) });
      if (page.humanActionCode) {
        throw new ToolError(page.humanActionCode,
          `${surface.providerId} requires visible user attention before sending. Complete the action in the browser, then retry.`, pageDiagnostics(surface.providerId, "inspect", page));
      }
      if (page.generating) {
        throw new ToolError("PROVIDER_BUSY",
          `${surface.providerId} is still completing a previous answer; refusing to send a new prompt into an unfinished turn.`, pageDiagnostics(surface.providerId, "inspect", page));
      }
      if (!page.inputReady) throw new ToolError("UI_DRIFT", `${surface.providerId} composer is not ready.`, pageDiagnostics(surface.providerId, "inspect", page));

      const baseline = await this.worker.readLatestAnswer(surface, selectors.assistant, context.signal);
      stage("baseline", { answerCount: baseline.count, answerCharacters: baseline.latestText.length });
      context.signal?.throwIfAborted?.();
      await this.worker.insertText(surface, prompt, context.signal);
      stage("insert", { composerCharacters: prompt.length });
      context.signal?.throwIfAborted?.();
      const actual = await this.worker.readComposer(surface, context.signal);
      if (!actual.trim()) {
        throw new ToolError("UI_DRIFT", `${surface.providerId} composer was empty after insertion.`, {
          ...pageDiagnostics(surface.providerId, "composer", page), composerCharacters: actual.length
        });
      }

      const sent = await this.worker.send(surface, selectors.send, context.signal);
      stage("send", { sendOutcome: sent.outcome, sendOperationId: sent.operationId });
      context.signal?.throwIfAborted?.();
      if (sent.outcome === "unknown") {
        throw new ToolError("SEND_IDEMPOTENCY_UNKNOWN",
          `${surface.providerId} send state is unknown; inspect the page before retrying to avoid a duplicate send.`, {
            ...pageDiagnostics(surface.providerId, "send", page), sendOutcome: sent.outcome, sendOperationId: sent.operationId
          });
      }
      if (sent.outcome !== "sent") {
        throw new ToolError("UI_DRIFT",
          `${surface.providerId} did not accept the submission; the prompt remains in the composer.`, {
            ...pageDiagnostics(surface.providerId, "send", page), sendOutcome: sent.outcome, sendOperationId: sent.operationId
          });
      }

      try {
        let streamedAnswer = "";
        const onDelta = async (delta: string): Promise<void> => {
          streamedAnswer += delta;
        };
        await this.worker.watchAnswerUntilIdle(surface, selectors.assistant, baseline, onDelta, context.signal);
        stage("watch", { streamedCharacters: streamedAnswer.length });
        context.signal?.throwIfAborted?.();
        const after = await this.worker.readLatestAnswer(surface, selectors.assistant, context.signal);
        stage("answer", { answerCount: after.count, answerCharacters: after.latestText.length, baselineAnswerCount: baseline.count });
        context.signal?.throwIfAborted?.();
        if (after.count <= baseline.count && after.latestText === baseline.latestText) {
          throw new ToolError("UI_DRIFT", `${surface.providerId} did not expose a new assistant answer.`, {
            ...pageDiagnostics(surface.providerId, "answer", page),
            baselineAnswerCount: baseline.count, answerCount: after.count
          });
        }
        let answer: string;
        try {
          const copied = await this.worker.copyLatestAnswer(surface, selectors.copy, context.signal, after.count - 1);
          answer = selectSameTurnAnswer(copied, after.latestText);
        } catch (error) {
          // The answer was already observed to be complete. A failed copy action is an
          // extraction problem, not a reason to resend the accepted prompt. The DOM
          // fallback is only legitimate when a NEW answer node exists for this turn
          // (after.count > baseline.count); otherwise latestText may be an edited or
          // stale baseline answer and must not be silently returned (2026-08-19 review).
          if (after.latestText.trim() && after.count > baseline.count) {
            answer = after.latestText;
            stage("copy_fallback", { answerCount: after.count, answerCharacters: after.latestText.length });
          } else if (error instanceof ToolError) {
            throw new ToolError(error.code, error.message, { ...pageDiagnostics(surface.providerId, "copy", page), ...(error.details ?? {}) });
          } else {
            throw error;
          }
        }
        // Tool-position leniency: nothing was streamed to a caller during the turn,
        // so streamed/final divergence is a loggable fact, not a failure. The
        // copied-vs-DOM fingerprint choice (selectSameTurnAnswer) above remains the
        // authoritative guard against stale extraction.
        if (streamedAnswer.trim() && !answersCompatible(streamedAnswer, answer)) {
          stage("stream_final_divergence", { streamedCharacters: streamedAnswer.length, finalCharacters: answer.length });
        }
        stage("result", { outcome: "message", answerCharacters: answer.length });
        return {
          text: answer.trim(),
          provider: surface.providerId,
          durationMs: Date.now() - startedAt,
          answerCharacters: answer.length
        };
      } catch (error) {
        // Caller-initiated cancellation must stay distinguishable from infra failure:
        // rewriting an abort into SEND_IDEMPOTENCY_UNKNOWN would tell the caller
        // "irreplayable failure" when they in fact cancelled (2026-08-19 review).
        if (context.signal?.aborted) {
          stage("cancelled_after_send", { errorCode: error instanceof ToolError ? error.code : "ABORT" });
          throw new ToolError("CANCELLED",
            `${surface.providerId} turn was cancelled by the caller after the prompt was sent; the page may still complete the answer — inspect before re-delegating.`, {
              ...pageDiagnostics(surface.providerId, "cancel", page),
              sendOutcome: sent.outcome,
              baselineAnswerCount: baseline.count
            });
        }
        // Once the browser accepted the prompt, retrying the call is not safe: the
        // same prompt would be typed into the same physical conversation again.
        // Surface this as an explicit non-replayable error instead of anything a
        // caller might auto-retry.
        if (error instanceof ToolError && (error.code === "SEND_IDEMPOTENCY_UNKNOWN" || error.code === "INTERNAL")) {
          stage("post_send_error", { errorCode: error.code });
          throw error;
        }
        stage("post_send_error", { errorCode: error instanceof ToolError ? error.code : "UNKNOWN" });
        throw new ToolError("SEND_IDEMPOTENCY_UNKNOWN",
          `${surface.providerId} accepted the prompt but the answer could not be verified without risking a duplicate send. Inspect the page conversation before retrying.`, {
            ...pageDiagnostics(surface.providerId, "post_send", page),
            sendOutcome: sent.outcome,
            sendOperationId: sent.operationId,
            baselineAnswerCount: baseline.count,
            ...(error instanceof ToolError ? { sourceError: error.code, ...(error.details ?? {}) } : {})
          });
      }
    } finally {
      lease.release();
    }
  }
}

function selectSameTurnAnswer(copied: string, dom: string): string {
  if (!copied.trim() && dom.trim()) return dom;
  if (!dom.trim()) return copied;
  const copiedFingerprint = answerFingerprint(copied);
  const domFingerprint = answerFingerprint(dom);
  return copiedFingerprint.includes(domFingerprint) || domFingerprint.includes(copiedFingerprint)
    ? copied
    : dom;
}

function answerFingerprint(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[_`*#\s]/g, "")
    .slice(0, 512);
}

function answersCompatible(streamed: string, final: string): boolean {
  if (!streamed.trim() || !final.trim()) return false;
  const streamedFingerprint = answerFingerprint(streamed);
  const finalFingerprint = answerFingerprint(final);
  return streamedFingerprint.includes(finalFingerprint) || finalFingerprint.includes(streamedFingerprint);
}

function pageDiagnostics(providerId: string, phase: string, page: BrowserPageSnapshot): ToolErrorDetails {
  return {
    provider: providerId,
    phase,
    url: page.url,
    title: page.title,
    inputReady: page.inputReady,
    generating: page.generating,
    loginRequired: page.loginRequired,
    challengeDetected: page.challengeDetected,
    ...(page.humanActionCode ? { humanActionCode: page.humanActionCode } : {})
  };
}
