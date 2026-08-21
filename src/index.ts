#!/usr/bin/env node
/**
 * web-agent-tools — MCP stdio server (M2 surface).
 *
 * Tools: web_ask / web_review / web_status / web_handoff.
 * Position: a TOOL in the caller's workflow, not a model-backend replacement.
 * Calls are one-shot, stateless, fail-loud; an accepted send is never retried
 * automatically (SEND_IDEMPOTENCY_UNKNOWN).
 *
 * M2 additions (see notes/2026-08-19-tool-position-divergences.md):
 *   - canonical output schemas (dsh ToolDefinition discipline);
 *   - event-sourced call log with request envelopes (dsh session-log discipline);
 *   - 5s health cache for web_status;
 *   - web_review (structured review template) and web_handoff (human-action guidance).
 *
 * stdout belongs to the MCP wire protocol — diagnostics go to turns.jsonl only.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CdpBrowserWorker } from "./browser/cdpWorker.js";
import { WebAskRunner } from "./browser/turn.js";
import { ToolError, type HumanActionCode } from "./errors.js";
import { listProviders, resolveProvider } from "./providerRegistry.js";
import { roleChain, runWithRoleFallback, type RoleName } from "./roles.js";
import { storeArtifact } from "./turnLog.js";
import {
  assembleDecisionPacket, buildDelegatePrompt, buildRepairPrompt, buildRevisionPrompt, buildRetryPrompt, diffDeliverables, extractCouncilSynthesis,
  parseDeliverable, runAcceptance,
  type AcceptanceMode, type CouncilSynthesis, type DelegateInput, type DeliverableFormat,
} from "./delegate.js";
import {
  buildReviewPrompt,
  webAskInput, webAskOutput,
  webReviewInput, webReviewOutput,
  webDelegateInput, webDelegateOutput,
  webCouncilInput, webCouncilOutput, buildCouncilMemberPrompt, buildCouncilSynthesisPrompt,
  webHandoffInput, webHandoffOutput,
  webStatusInput, webStatusOutput
} from "./tools.js";
import { fingerprint, logTurnEvent } from "./turnLog.js";

const CDP_URL = process.env.WEB_AGENT_CDP_URL?.trim() || "http://127.0.0.1:4319";
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_TIMEOUT_MS = 300_000;
const STATUS_CACHE_TTL_MS = 5_000;

const worker = new CdpBrowserWorker({
  cdpUrl: CDP_URL,
  surfaces: listProviders().map((definition) => definition.surface)
});
const askRunner = new WebAskRunner(worker);

const HANDOFF_GUIDANCE: Record<HumanActionCode, string> = {
  LOGIN_REQUIRED: "在浏览器中完成该网页的登录，然后重新调用工具。",
  CAPTCHA_REQUIRED: "在浏览器中完成人机验证，然后重新调用工具。",
  TWO_FACTOR_REQUIRED: "在浏览器中完成两步验证，然后重新调用工具。",
  RISK_CONTROL: "该网页触发了风控提示，请在浏览器中按页面指引解除后重试。",
  TERMS_DIALOG: "请在浏览器中阅读并处理服务条款弹窗后重试。"
};

const server = new McpServer(
  { name: "web-agent-tools", version: "0.2.0" },
  {
    instructions: [
      "Delegate self-contained questions, reviews, or checks to signed-in web AI pages in the user's daily Chrome (CDP).",
      "Calls are one-shot: inline any needed code/context in the prompt; pages keep no shared state with you.",
      "Prefer web_status first when availability is unknown.",
      "Human-action errors (LOGIN/CAPTCHA/RISK/TERMS) need a human on the visible page — tell the user, do not retry.",
      "SEND_IDEMPOTENCY_UNKNOWN means the prompt may already be in the page; never auto-retry, ask the user to check the page."
    ].join("\n")
  }
);

function toErrorPayload(error: unknown): { error: string; message: string; details?: Record<string, unknown> } {
  if (error instanceof ToolError) {
    return { error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) };
  }
  return { error: "INTERNAL", message: error instanceof Error ? error.message : String(error) };
}

// ---------------------------------------------------------------------------
// web_status (with 5s cache)
// ---------------------------------------------------------------------------

interface StatusCacheEntry {
  at: number;
  payload: Record<string, unknown>;
}
let statusCache: StatusCacheEntry | undefined;

server.registerTool("web_status", {
  title: "Web agent status",
  description: "Health of the three web-AI pages (chatgpt / deepseek / glm): page present, composer ready, login/captcha state. Cached for 5s unless force=true. Call this first when availability is unknown.",
  inputSchema: webStatusInput,
  outputSchema: webStatusOutput
}, async ({ force }) => {
  if (!force && statusCache && Date.now() - statusCache.at < STATUS_CACHE_TTL_MS) {
    return { content: [{ type: "text", text: JSON.stringify(statusCache.payload, null, 2) }], structuredContent: statusCache.payload };
  }
  const providers = [];
  for (const definition of listProviders()) {
    const entry: Record<string, unknown> = { provider: definition.providerId, display_name: definition.displayName };
    try {
      const snapshot = await worker.inspect(definition.surface, AbortSignal.timeout(20_000));
      entry.healthy = true;
      entry.input_ready = snapshot.inputReady;
      entry.generating = snapshot.generating;
      entry.login_required = snapshot.loginRequired;
      entry.challenge_detected = snapshot.challengeDetected;
      entry.url = snapshot.url;
      entry.title = snapshot.title;
    } catch (error) {
      const payload = toErrorPayload(error);
      entry.healthy = false;
      entry.error = payload.error;
      entry.message = payload.message;
    }
    providers.push(entry);
  }
  const payload = { cdp_url: CDP_URL, providers };
  statusCache = { at: Date.now(), payload };
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
});

// ---------------------------------------------------------------------------
// web_ask + web_review (shared one-shot runner with wall-clock backstop)
// ---------------------------------------------------------------------------

interface AskCall {
  tool: "web_ask" | "web_review" | "web_delegate" | "web_council";
  role: RoleName;
  override?: string;
  prompt: string;
  timeoutMs: number;
}

/** MCP progress contract: send notifications/progress ONLY when the client supplied a
 * progressToken in request _meta, and echo THEIR token. We used to invent our own
 * requestId as the token — every stage notification landed client-side as a protocol
 * error ("unknown token", observed 2026-08-20) and resetTimeoutOnProgress never worked. */
function makeNotifier(extra: { signal?: AbortSignal; _meta?: { progressToken?: string | number }; sendNotification: (notification: never) => Promise<unknown> }): { signal?: AbortSignal; sendNotification: (n: { method: string; params: Record<string, unknown> }) => Promise<unknown> } {
  const token = extra._meta?.progressToken;
  if (token === undefined) {
    // Client did not opt in — the spec forbids progress notifications entirely.
    return { signal: extra.signal, sendNotification: async () => undefined };
  }
  return {
    signal: extra.signal,
    sendNotification: (n) => extra.sendNotification(
      (n.method === "notifications/progress"
        ? { ...n, params: { ...n.params, progressToken: token } }
        : n) as never)
  };
}

async function runAskCall(call: AskCall, extra: { signal?: AbortSignal; sendNotification: (notification: { method: string; params: Record<string, unknown> }) => Promise<unknown> }): Promise<{ provider: string; text: string; durationMs: number; requestId: string }> {
  const requestId = `ask_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
  logTurnEvent({
    event: "call.envelope", tool: call.tool, requestId, role: call.role, override: call.override,
    promptFingerprint: fingerprint(call.prompt), promptCharacters: call.prompt.length,
    timeoutMs: call.timeoutMs, cdpUrl: CDP_URL
  });

  const signal = extra.signal ?? AbortSignal.timeout(call.timeoutMs);
  const wallClock = (providerLabel: string): Promise<never> => new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new ToolError("SEND_IDEMPOTENCY_UNKNOWN",
      `${call.tool}(${providerLabel}) exceeded the ${call.timeoutMs}ms deadline; the prompt may already be sent — inspect the page before retrying.`,
      { provider: providerLabel, sourceError: "RESPONSE_TIMEOUT", wallClockMs: call.timeoutMs } as Record<string, unknown>)), call.timeoutMs);
    timer.unref?.();
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new ToolError("INTERNAL", "The tool call was cancelled by the client.", undefined));
    }, { once: true });
  });

  const startedAt = Date.now();
  const raw = await runWithRoleFallback(call.role, call.tool, requestId, call.override, async (providerId) => {
    const definition = resolveProvider(providerId);
    const notify = (stage: string): void => {
      void extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken: requestId, progress: 0, message: `${providerId}: ${stage}` }
      }).catch(() => undefined);
    };
    return Promise.race([
      askRunner.ask(definition.surface, call.prompt, { requestId, onProgress: notify, signal }),
      wallClock(providerId)
    ]);
  });
  logTurnEvent({ event: "call.settled", tool: call.tool, requestId, provider: raw.provider, ok: true, durationMs: Date.now() - startedAt, answerCharacters: raw.text.length });
  void storeArtifact(requestId, "answer", raw.text);
  return { ...raw, durationMs: Date.now() - startedAt, requestId };
}

/** Read-only recovery pass: extract the latest completed answer from one explicit
 * provider page. No prompt, no send, no chain — the mirror of a timed-out call. */
async function runSalvageCall(providerId: string, extra: { signal?: AbortSignal; sendNotification: (notification: { method: string; params: Record<string, unknown> }) => Promise<unknown> }): Promise<{ text: string; provider: string; durationMs: number; answerCharacters: number; answerCount: number; requestId: string }> {
  const requestId = `salvage_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
  logTurnEvent({ event: "call.envelope", tool: "web_ask", requestId, role: "salvage", override: providerId, promptFingerprint: "(salvage)", promptCharacters: 0, timeoutMs: DEFAULT_TIMEOUT_MS, cdpUrl: CDP_URL });
  const startedAt = Date.now();
  const definition = resolveProvider(providerId);
  const notify = (stage: string): void => {
    void extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken: requestId, progress: 0, message: `${providerId}: ${stage}` }
    }).catch(() => undefined);
  };
  const raw = await askRunner.salvage(definition.surface, { requestId, onProgress: notify, signal: extra.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
  logTurnEvent({ event: "call.settled", tool: "web_ask", requestId, provider: raw.provider, ok: true, durationMs: Date.now() - startedAt, answerCharacters: raw.text.length });
  void storeArtifact(requestId, "salvage", raw.text);
  return { ...raw, requestId };
}

function errorResult(call: string, requestId: string, providerLabel: string, error: unknown, startedAt: number) {
  const payload = toErrorPayload(error);
  logTurnEvent({ event: "call.settled", tool: call, requestId, provider: providerLabel, ok: false, durationMs: Date.now() - startedAt, errorCode: payload.error });
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ ok: false, ...payload }, null, 2) }],
    structuredContent: { ok: false, error: payload.error, ...(payload.message ? { message: payload.message } : {}) }
  };
}

server.registerTool("web_ask", {
  title: "Ask a web AI page",
  description: "Send one self-contained prompt to a web AI page and return its final answer text. One-shot: inline all needed context. Provider omitted = advisor chain from config. Long-running (up to 5 min).",
  inputSchema: webAskInput,
  outputSchema: webAskOutput
}, async ({ provider, prompt, salvage, timeout_ms }, extra) => {
  const startedAt = Date.now();
  if (salvage) {
    if (!provider) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: "INVALID_ARGUMENT", message: "salvage requires an explicit provider — it reads one specific page." }, null, 2) }], structuredContent: { ok: false, error: "INVALID_ARGUMENT", message: "salvage requires an explicit provider — it reads one specific page." } };
    }
    try {
      const result = await runSalvageCall(provider, makeNotifier(extra));
      // Opportunistic packet: if the recovered text is a structured review, hand the
      // outer agent the digest directly — this is the common post-timeout shape.
      const packet = assembleDecisionPacket(result.text);
      return {
        content: [{ type: "text", text: result.text }],
        structuredContent: {
          ok: true, provider: result.provider, duration_ms: result.durationMs,
          answer_characters: result.text.length, answer_count: result.answerCount,
          ...(packet.verdict !== "unclear" ? { packet } : {})
        }
      };
    } catch (error) {
      return errorResult("web_ask", "", provider, error, startedAt);
    }
  }
  if (!prompt) {
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: "INVALID_ARGUMENT", message: "prompt is required unless salvage=true." }, null, 2) }], structuredContent: { ok: false, error: "INVALID_ARGUMENT", message: "prompt is required unless salvage=true." } };
  }
  try {
    const result = await runAskCall({
      tool: "web_ask", role: "advisor", override: provider, prompt,
      timeoutMs: Math.min(timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
    }, makeNotifier(extra));
    return {
      content: [{ type: "text", text: result.text }],
      structuredContent: { ok: true, provider: result.provider, duration_ms: result.durationMs, answer_characters: result.text.length }
    };
  } catch (error) {
    return errorResult("web_ask", "", provider ?? "advisor", error, startedAt);
  }
});

server.registerTool("web_review", {
  title: "Have a web AI page review content",
  description: "Send code/plan/document content to a web AI page for a structured review (numbered findings with severity, location, suggestion). Provider omitted = reviewer chain (strong model first). One-shot; content limit 16000 chars.",
  inputSchema: webReviewInput,
  outputSchema: webReviewOutput
}, async ({ provider, content, focus, packet_only, timeout_ms }, extra) => {
  let prompt: string;
  try {
    prompt = buildReviewPrompt(content, focus);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ ok: false, error: "INVALID_ARGUMENT", message }, null, 2) }],
      structuredContent: { ok: false, error: "INVALID_ARGUMENT", message }
    };
  }
  const startedAt = Date.now();
  try {
    const result = await runAskCall({
      tool: "web_review", role: "reviewer", override: provider, prompt,
      // Reviewer wall clock defaults to the max: long-form reviews (chatgpt) routinely
      // exceed 180s — the 2026-08-20 drill salvaged one that arrived after the deadline.
      timeoutMs: Math.min(timeout_ms ?? MAX_TIMEOUT_MS, MAX_TIMEOUT_MS)
    }, makeNotifier(extra));
    // R1 decision packet: mechanical digest of the structured review — verdict +
    // high-severity titles + counts. The full text stays the default content;
    // packet_only swaps it for the digest when the outer agent trusts the packet.
    const packet = assembleDecisionPacket(result.text);
    const packetText = `[decision packet] verdict=${packet.verdict} high=${JSON.stringify(packet.high)} medium=${packet.medium_count} low=${packet.low_count}${packet.note ? ` note=${packet.note}` : ""} (full review: ${packet.total_chars} chars on the page / turn log)`;
    return {
      content: [{ type: "text", text: packet_only ? packetText : result.text }],
      structuredContent: { ok: true, provider: result.provider, duration_ms: result.durationMs, answer_characters: result.text.length, packet }
    };
  } catch (error) {
    return errorResult("web_review", "", provider ?? "reviewer", error, startedAt);
  }
});

// ---------------------------------------------------------------------------
// web_delegate — pipeline position: one generation step executed by the web side
// ---------------------------------------------------------------------------

server.registerTool("web_delegate", {
  title: "Delegate one generation step",
  description: "Hand a self-contained generation step (write a function, produce JSON, batch generation) to the executor chain (tool-grade models, deepseek first). Returns the deliverable itself — parsed per the contract and machine-checked — not an opinion and not a summary. The outer agent skips this step's computation entirely.",
  inputSchema: webDelegateInput,
  outputSchema: webDelegateOutput
}, async ({ task_spec, context, deliverable, acceptance, review_rounds, cross_check, timeout_ms, override }, extra) => {
  const startedAt = Date.now();
  const input: DelegateInput = { task_spec, ...(context ? { context } : {}), deliverable, acceptance: acceptance ?? "parse" };
  const extraRef = makeNotifier(extra);
  const repairTimeoutMs = Math.min(timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  // Escalation operator #3: fire the secondary generation in PARALLEL with the whole
  // primary flow (different page, no lease conflict). Its outcome is informational —
  // divergence data for the outer, never a gate; failures degrade to secondary_error.
  let crossCheckSecondary: Promise<{ provider: string; text: string } | { error: string }> | undefined;
  if (cross_check) {
    void (async () => {
      const chain = await roleChain("executor", override);
      const primary = override ?? chain[0];
      const secondary = chain.find((p) => p !== primary);
      if (!secondary) return;
      crossCheckSecondary = runAskCall({
        tool: "web_delegate", role: "executor", override: secondary,
        prompt: buildDelegatePrompt(input), timeoutMs: repairTimeoutMs
      }, extraRef)
        .then((r) => ({ provider: r.provider, text: r.text }))
        .catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
    })();
  }
  const crossCheckReport = async (primaryValue: string, requestId: string): Promise<Record<string, unknown> | undefined> => {
    if (!cross_check) return undefined;
    if (!crossCheckSecondary) {
      const chain = await roleChain("executor", override);
      return { secondary_provider: chain[0] === (override ?? chain[0]) ? "none" : chain[0], agreement_ratio: -1, conflict_count: 0, conflicts: [], secondary_error: "executor chain has no second provider" };
    }
    const secondary = await crossCheckSecondary;
    if ("error" in secondary) {
      return { secondary_provider: "unknown", agreement_ratio: -1, conflict_count: 0, conflicts: [], secondary_error: secondary.error.slice(0, 200) };
    }
    const parsedB = parseDeliverable(secondary.text, deliverable);
    void storeArtifact(requestId, "crosscheck-secondary", secondary.text);
    if (!parsedB.ok) {
      return { secondary_provider: secondary.provider, agreement_ratio: -1, conflict_count: 0, conflicts: [], secondary_error: `secondary deliverable unparseable: ${parsedB.reason}` };
    }
    const diff = diffDeliverables(primaryValue, parsedB.value);
    logTurnEvent({ event: "escalation.step", tool: "web_delegate", step: "crosscheck", requestId, agreementRatio: diff.agreementRatio, conflicts: diff.conflictCount });
    return { secondary_provider: secondary.provider, agreement_ratio: +diff.agreementRatio.toFixed(3), conflict_count: diff.conflictCount, conflicts: diff.conflicts };
  };
  // Repair floor (2026-08-20 architecture): the default mechanical extractor is the
  // first and only local pass; when it cannot produce an acceptable deliverable
  // (parse failed twice, or acceptance failed), hand the RAW answer — the fullest
  // evidence — to the executor chain (deepseek first) as a reconstruction ticket.
  // One repair attempt, never a resend of the original prompt.
  const repairStage = async (corrupted: string, reason: string, requestId: string): Promise<
    { ok: true; value: string; provider: string } | { ok: false; error: string }
  > => {
    logTurnEvent({ event: "escalation.step", tool: "web_delegate", step: "repair", trigger: reason, requestId });
    logTurnEvent({ event: "delegate.repair", tool: "web_delegate", reason });
    let repairRaw: { provider: string; text: string };
    try {
      const prompt = buildRepairPrompt(corrupted, deliverable, reason);
      repairRaw = await runAskCall({ tool: "web_delegate", role: "executor", prompt, timeoutMs: repairTimeoutMs }, extraRef);
    } catch (error) {
      return { ok: false, error: `repair stage failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    const reparsed = parseDeliverable(repairRaw.text, deliverable);
    void storeArtifact(requestId, "repair-input", corrupted);
    if (reparsed.ok) void storeArtifact(requestId, "repair-output", reparsed.value);
    if (!reparsed.ok) return { ok: false, error: `repair deliverable unparseable: ${reparsed.reason}` };
    const acceptance = runAcceptance(reparsed.value, deliverable, input.acceptance ?? "parse");
    if (!acceptance.passed) return { ok: false, error: `repair acceptance failed: ${acceptance.reason}` };
    return { ok: true, value: reparsed.value, provider: repairRaw.provider };
  };
  let prompt = buildDelegatePrompt(input);
  let retried = false;
  while (true) {
    let raw: { provider: string; text: string; requestId: string };
    try {
      raw = await runAskCall({
        tool: "web_delegate", role: "executor", override, prompt,
        timeoutMs: repairTimeoutMs
      }, extraRef);
    } catch (error) {
      return errorResult("web_delegate", "", override ?? "executor", error, startedAt);
    }
    const parsed = parseDeliverable(raw.text, deliverable);
    if (parsed.ok) void storeArtifact(raw.requestId, "deliverable", parsed.value);
    if (!parsed.ok && !retried) {
      // One contract-repair round on the same provider page (it keeps context).
      logTurnEvent({ event: "delegate.contract_retry", tool: "web_delegate", provider: raw.provider, reason: parsed.reason });
      prompt = buildRetryPrompt(input, parsed.reason ?? "unspecified");
      retried = true;
      continue;
    }
    if (!parsed.ok) {
      const repair = await repairStage(raw.text, parsed.reason ?? "unspecified", raw.requestId);
      if (repair.ok) {
        const cross = await crossCheckReport(repair.value, raw.requestId);
        return {
          content: [{ type: "text", text: repair.value }],
          structuredContent: {
            ok: true, provider: raw.provider, format: deliverable.format,
            duration_ms: Date.now() - startedAt, acceptance: "passed (after repair)",
            repair: repair.provider, ...(cross ? { cross_check: cross } : {})
          }
        };
      }
      const payload = { ok: false, error: "UI_DRIFT", message: "Deliverable contract violated twice and the repair floor failed; the raw answer is not shaped as requested." };
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ ...payload, reason: parsed.reason, repair_error: repair.error, raw_head: raw.text.slice(0, 400) }, null, 2) }],
        structuredContent: payload
      };
    }
    const acceptanceResult = runAcceptance(parsed.value, deliverable, input.acceptance ?? "parse");
    if (!acceptanceResult.passed) {
      const repair = await repairStage(raw.text, acceptanceResult.reason, raw.requestId);
      if (repair.ok) {
        const cross = await crossCheckReport(repair.value, raw.requestId);
        return {
          content: [{ type: "text", text: repair.value }],
          structuredContent: {
            ok: true, provider: raw.provider, format: deliverable.format,
            duration_ms: Date.now() - startedAt, acceptance: "passed (after repair)",
            repair: repair.provider, ...(cross ? { cross_check: cross } : {})
          }
        };
      }
      const payload = { ok: false, deliverable: parsed.value, acceptance_reason: acceptanceResult.reason, repair_error: repair.error };
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: { ok: false, error: "INVALID_ARGUMENT", message: `${acceptanceResult.reason}; repair floor also failed` }
      };
    }
    // ---- Escalation operator #2: review-round (2026-08-21) ----
    // Machine-accepted deliverable → reviewer audits → executor revises per findings.
    // Bounded by review_rounds (schema caps at 2); every pass is a logged physical
    // send with artifact snapshots; revision failure keeps the machine-accepted
    // previous version (escalation-as-signal goes into provenance, never hidden).
    let finalValue = parsed.value;
    let reviewProvenance: string | undefined;
    const roundsMax = review_rounds ?? 0;
    for (let round = 1; round <= roundsMax; round++) {
      logTurnEvent({ event: "escalation.step", tool: "web_delegate", step: "review", round, requestId: raw.requestId });
      const reviewPrompt = buildReviewPrompt(finalValue, "契约符合度与正确性：边界条件、错误处理、与任务书要求的偏差。");
      const reviewRaw = await runAskCall({
        tool: "web_delegate", role: "reviewer", prompt: reviewPrompt, timeoutMs: repairTimeoutMs
      }, extraRef);
      void storeArtifact(raw.requestId, `review-r${round}`, reviewRaw.text);
      const packet = assembleDecisionPacket(reviewRaw.text);
      if (packet.verdict !== "needs-changes") {
        reviewProvenance = `${reviewRaw.provider}: ${packet.verdict} (${round}/${roundsMax})`;
        break;
      }
      const findings = [...packet.high, ...Array.from({ length: packet.medium_count }, (_, i) => `中严重度发现 #${i + 1}（见快照 review-r${round}）`)];
      logTurnEvent({ event: "escalation.step", tool: "web_delegate", step: "revision", round, findings: findings.length, requestId: raw.requestId });
      const revisionPrompt = buildRevisionPrompt(task_spec, finalValue, findings, deliverable);
      const revisionRaw = await runAskCall({
        tool: "web_delegate", role: "executor", prompt: revisionPrompt, timeoutMs: repairTimeoutMs
      }, extraRef);
      const revisionParsed = parseDeliverable(revisionRaw.text, deliverable);
      const revisionOk = revisionParsed.ok && runAcceptance(revisionParsed.value, deliverable, input.acceptance ?? "parse").passed;
      if (revisionParsed.ok) void storeArtifact(raw.requestId, `revision-r${round}`, revisionParsed.value);
      if (!revisionOk) {
        reviewProvenance = `${reviewRaw.provider}: needs-changes → revision failed machine acceptance, kept previous (${round}/${roundsMax})`;
        break;
      }
      finalValue = revisionParsed.value;
      reviewProvenance = round === roundsMax
        ? `${reviewRaw.provider}: needs-changes → ${revisionRaw.provider} revised (${round}/${roundsMax}, final)`
        : undefined; // more rounds follow; provenance set on the last iteration
    }
    const cross = await crossCheckReport(finalValue, raw.requestId);
    return {
      content: [{ type: "text", text: finalValue }],
      structuredContent: {
        ok: true,
        provider: raw.provider,
        format: deliverable.format,
        duration_ms: Date.now() - startedAt,
        acceptance: `passed${acceptanceResult.syntax_note ? ` (${acceptanceResult.syntax_note})` : ""}`,
        ...(reviewProvenance ? { review: reviewProvenance } : {}),
        ...(cross ? { cross_check: cross } : {})
      }
    };
  }
});

// ---------------------------------------------------------------------------
// web_handoff
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// web_council — escalation operator #4: parallel council with a synthesis seat
// ---------------------------------------------------------------------------

server.registerTool("web_council", {
  title: "Convene a web AI council",
  description: "Ask one question to all attending web AIs in PARALLEL (independent answers), then a synthesis seat compresses them into a four-field verdict (consensus / disputes / recommendation / minority). Full member texts are artifact-snapshotted; the outer reads the verdict. Long-running (bounded by the slowest member + synthesis).",
  inputSchema: webCouncilInput,
  outputSchema: webCouncilOutput
}, async ({ question, providers, timeout_ms }, extra) => {
  const startedAt = Date.now();
  const requestId = `council_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
  const notify = makeNotifier(extra);
  const timeoutMs = Math.min(timeout_ms ?? MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);
  logTurnEvent({ event: "call.envelope", tool: "web_council", requestId, role: "advisor", promptFingerprint: fingerprint(question), promptCharacters: question.length, timeoutMs, cdpUrl: CDP_URL });
  const members = providers ?? ["deepseek", "chatgpt", "glm"];
  const prompt = buildCouncilMemberPrompt(question);
  const one = async (provider: string) => {
    try {
      const r = await runAskCall({ tool: "web_council", role: "advisor", override: provider, prompt, timeoutMs }, notify);
      void storeArtifact(requestId, `council-${provider}`, r.text);
      return { provider, ok: true as const, text: r.text };
    } catch (error) {
      return { provider, ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const answers = await Promise.all(members.map(one));
  const succeeded = answers.filter((a): a is { provider: string; ok: true; text: string } => a.ok);
  if (succeeded.length === 0) {
    const errorResult = { ok: false, error: "PROVIDER_UNAVAILABLE", message: "no council member answered" };
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ ...errorResult, members: answers.map(({ provider, ok, error }) => ({ provider, ok, error })) }, null, 2) }], structuredContent: errorResult };
  }
  // Synthesis seat: advisor chain first provider (config-driven; deepseek by default).
  const chain = await roleChain("advisor");
  const seat = chain.find((p) => p !== succeeded[0]?.provider) ?? chain[0];
  let synthesis: CouncilSynthesis | undefined;
  let synthesisNote: string | undefined;
  try {
    const synthesisPrompt = buildCouncilSynthesisPrompt(question, succeeded.map((a) => ({ provider: a.provider, text: a.text })));
    const seatRaw = await runAskCall({ tool: "web_council", role: "advisor", override: seat, prompt: synthesisPrompt, timeoutMs }, notify);
    void storeArtifact(requestId, "council-synthesis", seatRaw.text);
    synthesis = extractCouncilSynthesis(seatRaw.text);
    if (!synthesis) synthesisNote = `synthesis seat (${seat}) did not follow the four-field format; raw text is artifact-snapshotted`;
  } catch (error) {
    synthesisNote = `synthesis seat failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  logTurnEvent({ event: "call.settled", tool: "web_council", requestId, provider: seat, ok: true, durationMs: Date.now() - startedAt, members: succeeded.length });
  const memberSummary = answers.map(({ provider, ok, ...rest }) => ok
    ? { provider, ok, characters: (rest as { text: string }).text.length }
    : { provider, ok, error: (rest as { error: string }).error.slice(0, 150) });
  return {
    content: [{ type: "text", text: JSON.stringify({ synthesis, members: memberSummary, ...(synthesisNote ? { note: synthesisNote } : {}) }, null, 2) }],
    structuredContent: {
      ok: true,
      duration_ms: Date.now() - startedAt,
      ...(synthesis ? { synthesis } : {}),
      members: memberSummary,
      ...(synthesisNote ? { message: synthesisNote } : {})
    }
  };
});

server.registerTool("web_handoff", {
  title: "Resolve human action on a web page",
  description: "Report what human action (login / captcha / 2FA / risk control / terms) a provider page currently needs, with concrete guidance. Returns action_required=null when the page needs nothing.",
  inputSchema: webHandoffInput,
  outputSchema: webHandoffOutput
}, async ({ provider }) => {
  const definition = resolveProvider(provider);
  const requestId = `handoff_${Date.now().toString(36)}`;
  logTurnEvent({ event: "call.envelope", tool: "web_handoff", requestId, provider, cdpUrl: CDP_URL });
  const startedAt = Date.now();
  try {
    const snapshot = await worker.inspect(definition.surface, AbortSignal.timeout(20_000));
    const actionRequired = snapshot.humanActionCode ?? null;
    const payload = {
      provider,
      action_required: actionRequired,
      guidance: actionRequired ? HANDOFF_GUIDANCE[actionRequired]
        : "页面状态正常，无需人工处理。若工具调用失败，请查看 turns.jsonl 中的阶段记录。",
      ...(snapshot.url ? { page_url: snapshot.url } : {}),
      ...(snapshot.title ? { page_title: snapshot.title } : {})
    };
    logTurnEvent({ event: "call.settled", tool: "web_handoff", requestId, provider, ok: true, durationMs: Date.now() - startedAt });
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
  } catch (error) {
    const payload = toErrorPayload(error);
    logTurnEvent({ event: "call.settled", tool: "web_handoff", requestId, provider, ok: false, durationMs: Date.now() - startedAt, errorCode: payload.error });
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ ok: false, ...payload }, null, 2) }],
      structuredContent: { ok: false, error: payload.error, ...(payload.message ? { message: payload.message } : {}) }
    };
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logTurnEvent({ event: "server.start", cdpUrl: CDP_URL, providers: listProviders().map((p) => p.providerId).join(",") });
}

void main().catch((error) => {
  // stdout is the MCP wire; startup failures go to stderr so clients surface them.
  process.stderr.write(`web-agent-tools failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
