/**
 * CDP page driver for the three web-AI providers.
 *
 * Copied from web-agent-codex-runtime/src/providers/cdpBrowserWorker.ts
 * (2026-08-18 state: includes raceWithStepTimeout poll caps, the DeepSeek
 * latest-node re-render fix, and copy-is-extraction-not-completion semantics).
 * Trims made for the tool position:
 *   - no conversation binding / expectedConversationId (calls are one-shot);
 *   - no ChatGPT turn marker slicing (no tool envelopes in tool mode);
 *   - RuntimeError replaced by the closed ToolError taxonomy.
 */
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { ToolError } from "../errors.js";
import { AppendOnlyTextAccumulator } from "./appendOnlyText.js";
import { completionManifestFor } from "./selectors.js";
import type {
  AnswerDeltaSink,
  BrowserAnswerBaseline,
  BrowserPageSnapshot,
  BrowserSendReceipt,
  BrowserSurface,
} from "./types.js";

// The composer must never resolve to ChatGPT's full-screen "writing block" editor
// (Canvas). That ProseMirror surface accepts text but syncs/reformats it and is not
// the conversation composer — typing there produced the 2026-08-19 "composer changed
// text during atomic insertion" incident on a page left with Canvas open.
const CHATGPT_NOT_FULLSCREEN = ":not([data-writing-block-fullscreen-editor-region])";
const CHATGPT_EDITABLE_COMPOSER_SELECTOR = `form [contenteditable='true']${CHATGPT_NOT_FULLSCREEN}, [contenteditable='true'][data-testid='prompt-textarea']${CHATGPT_NOT_FULLSCREEN}, [contenteditable='true']#prompt-textarea${CHATGPT_NOT_FULLSCREEN}, div.ProseMirror[contenteditable='true']${CHATGPT_NOT_FULLSCREEN}`;
const CHATGPT_TEXTAREA_COMPOSER_SELECTOR = "textarea[data-testid='prompt-textarea']:not(.wcDTda_fallbackTextarea), textarea[name='prompt-textarea']:not(.wcDTda_fallbackTextarea), textarea[aria-label='与 ChatGPT 聊天']:not(.wcDTda_fallbackTextarea), textarea[placeholder*='Message']:not(.wcDTda_fallbackTextarea)";

export interface BrowserSubmissionState {
  composerText?: string;
  generating: boolean;
  url: string;
}

export interface DeepSeekCompletionState {
  continuationVisible: boolean;
  latestAnswerText: string;
  latestActionsVisible: boolean;
}

export interface GlmCompletionState {
  completionMarkerVisible: boolean;
  latestAnswerText: string;
  readyControlVisible: boolean;
}

export function isDeepSeekAnswerComplete(state: DeepSeekCompletionState): boolean {
  return !state.continuationVisible
    && Boolean(state.latestAnswerText.trim())
    && state.latestActionsVisible;
}

export function isGlmAnswerComplete(state: GlmCompletionState): boolean {
  return Boolean(state.latestAnswerText.trim())
    && (state.completionMarkerVisible || state.readyControlVisible);
}

export function hasBrowserSubmissionEvidence(before: BrowserSubmissionState, after: BrowserSubmissionState): boolean {
  return after.generating
    || after.url !== before.url
    || (Boolean(before.composerText?.trim()) && after.composerText?.trim() === "");
}

export interface CdpBrowserWorkerOptions {
  cdpUrl: string;
  surfaces: BrowserSurface[];
}

export class CdpBrowserWorker {
  private browser?: Browser;
  private readonly surfaces = new Map<string, BrowserSurface>();
  private readonly pages = new Map<string, Page>();

  constructor(private readonly options: CdpBrowserWorkerOptions) {
    for (const surface of options.surfaces) this.surfaces.set(this.key(surface.providerId, surface.surfaceId), surface);
  }

  async inspect(surface: BrowserSurface, signal?: AbortSignal): Promise<BrowserPageSnapshot> {
    throwIfRequestAborted(signal);
    const page = await this.pageFor(surface);
    throwIfRequestAborted(signal);
    const completion = completionManifestFor(surface.providerId);
    return page.evaluate((completion) => {
      const visible = (element: Element): boolean => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const textOf = (elements: Element[]): string => elements
        .filter(visible)
        .map((element) => (element.textContent || element.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join(" ");
      const challengeSurface = [
        ...document.querySelectorAll("[role='alert'], [role='dialog'], [aria-modal='true'], iframe[src*='captcha'], iframe[src*='challenge'], [id^='captcha'], [data-testid*='captcha'], [id^='challenge'], [data-testid*='challenge']")
      ];
      const authControls = [...document.querySelectorAll("button, a, [role='button']")]
        .filter(visible)
        .map((element) => (element.textContent || element.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim())
        .filter((text) => /^(登录|登陆|登录 ChatGPT|log in|sign in|verify|验证|验证码)$/i.test(text));
      const actionSurface = `${textOf(challengeSurface)} ${authControls.join(" ")}`.replace(/\s+/g, " ").trim();
      const inputReady = [...document.querySelectorAll("textarea:not([disabled]), [contenteditable='true']")].some(visible);
      const humanActionCode = /验证码|captcha|challenge|verify you are human/i.test(actionSurface)
        ? "CAPTCHA_REQUIRED"
        : /两步验证|二次验证|two-factor|2fa|verification code/i.test(actionSurface)
          ? "TWO_FACTOR_REQUIRED"
          : /风险控制|异常活动|suspicious activity|risk control/i.test(actionSurface)
            ? "RISK_CONTROL"
            : /用户协议|terms of use|accept terms/i.test(actionSurface)
              ? "TERMS_DIALOG"
              : (/登录后继续|登录 ChatGPT|Sign in to continue|Log in to continue/i.test(actionSurface) || /\/sign[_-]?in|\/login|\/auth(?:\/|\?|$)/i.test(location.pathname)) && !inputReady
                ? "LOGIN_REQUIRED"
                : undefined;
      const queued = [...document.querySelectorAll(".vip-limit-text")]
        .some((element) => visible(element) && /排队|高峰期/.test(element.textContent ?? ""));
      const stopControlVisible = [...document.querySelectorAll(completion.stopSelector)].some(visible);
      const continuationVisible = Boolean(completion.continuationText)
        && [...document.querySelectorAll("button, [role='button']")]
          .filter(visible)
          .some((element) => new RegExp(completion.continuationText ?? "", "i").test(element.textContent ?? ""));
      return {
        url: location.href,
        title: document.title,
        inputReady,
        generating: stopControlVisible || continuationVisible,
        loginRequired: humanActionCode === "LOGIN_REQUIRED",
        challengeDetected: humanActionCode === "CAPTCHA_REQUIRED",
        humanActionCode,
        queued
      };
    }, completion);
  }

  async insertText(surface: BrowserSurface, text: string, signal?: AbortSignal): Promise<void> {
    throwIfRequestAborted(signal);
    const page = await this.pageFor(surface);
    const input = surface.providerId === "chatgpt"
      ? await this.chatGptComposer(page)
      : page.locator("textarea:not([disabled]), [contenteditable='true']").filter({ visible: true }).last();
    await raceWithAbort(input.waitFor({ state: "visible", timeout: 30_000 }).catch(() => undefined), signal);
    if (await input.count() === 0) throw new ToolError("UI_DRIFT", "No visible provider composer was found.", { provider: surface.providerId, phase: "composer" });
    if (surface.providerId === "chatgpt") {
      // Fast path (2026-08-21): ChatGPT's editor spends ~13ms/char processing direct
      // insertion commands (1KB ≈ 10-27s — measured), while the NATIVE paste pipeline
      // is instant (same 1KB ≈ 0.3s via clipboard + real Meta+V key event). Save the
      // user's clipboard, paste, verify the readback (same normalization contract),
      // restore. Any step failing falls back to the fill path below.
      const pasteMod = process.platform === "darwin" ? "Meta+V" : "Control+V";
      let pasted = false;
      let session: import("playwright").CDPSession | undefined;
      try {
        session = await page.context().newCDPSession(page);
        await session.send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
        const previous = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
        const wrote = await page.evaluate((t) => navigator.clipboard.writeText(t).then(() => true).catch(() => false), text);
        if (wrote) {
          await raceWithAbort(input.focus(), signal);
          await raceWithAbort(page.keyboard.press(pasteMod), signal);
          await waitForPageTimeout(page, 150, signal);
          const observed = await readComposerValue(input);
          if (normalizeComposerText(observed) === normalizeComposerText(text)) {
            pasted = true;
          } else {
            await input.fill("").catch(() => undefined);
          }
        }
        await page.evaluate((p) => { if (typeof p === "string") navigator.clipboard.writeText(p).catch(() => undefined); }, previous).catch(() => undefined);
      } catch {
        // Paste path is an optimization; any failure falls through to fill.
      } finally {
        await session?.detach().catch(() => undefined);
      }
      if (pasted) return;
      // Fallback + verification: `fill` commits one input event, so content cannot be
      // reordered between chunks. Verify the rendered text before the send control.
      await raceWithAbort(input.fill(text), signal);
      await waitForPageTimeout(page, 150, signal);
      const observed = await readComposerValue(input);
      const expectedCanonical = normalizeComposerText(text);
      const observedCanonical = normalizeComposerText(observed);
      if (observedCanonical !== expectedCanonical) {
        await input.fill("").catch(() => undefined);
        throw new ToolError("UI_DRIFT", `${surface.providerId} composer changed text during atomic insertion.`, {
          provider: surface.providerId, phase: "composer",
          expectedCharacters: text.length, observedCharacters: observed.length
        });
      }
      return;
    }

    await input.fill("");
    await input.focus();
    const chunkSize = 8_000;
    for (let offset = 0; offset < text.length; offset += chunkSize) {
      throwIfRequestAborted(signal);
      const end = Math.min(text.length, offset + chunkSize);
      await page.keyboard.insertText(text.slice(offset, end));
      await waitForPageTimeout(page, 80, signal);
      const observed = await readComposerValue(input);
      if (!normalizeComposerText(observed).startsWith(normalizeComposerText(text.slice(0, end)))) {
        throw new ToolError("UI_DRIFT", `${surface.providerId} composer lost text during insertion at ${end}/${text.length} characters.`, {
          provider: surface.providerId, phase: "composer", insertedCharacters: end, expectedCharacters: text.length
        });
      }
    }
  }

  async readComposer(surface: BrowserSurface, signal?: AbortSignal): Promise<string> {
    throwIfRequestAborted(signal);
    const page = await this.pageFor(surface);
    const input = surface.providerId === "chatgpt"
      ? await this.chatGptComposer(page)
      : page.locator("textarea:not([disabled]), [contenteditable='true']").filter({ visible: true }).last();
    return readComposerValue(input);
  }

  async readLatestAnswer(surface: BrowserSurface, selector: string, signal?: AbortSignal): Promise<BrowserAnswerBaseline> {
    throwIfRequestAborted(signal);
    const page = await this.pageFor(surface);
    const stepTimeoutMs = configuredTimeout("WEB_AGENT_POLL_STEP_TIMEOUT_MS", 15_000);
    const answers = page.locator(selector).filter({ visible: true });
    const count = await raceWithStepTimeout(answers.count().catch(() => 0), signal, stepTimeoutMs);
    const latestText = count ? await raceWithStepTimeout(answers.last().evaluate((element, providerId) => {
      if (providerId !== "glm") return (element as HTMLElement).innerText ?? element.textContent ?? "";

      // GLM renders Markdown emphasis as <strong>. Reconstruct the source markers so
      // identifiers such as __file__ survive DOM fallback extraction.
      const clone = element.cloneNode(true) as HTMLElement;
      for (const strong of clone.querySelectorAll("strong")) {
        strong.replaceWith(document.createTextNode(`__${strong.textContent ?? ""}__`));
      }
      return clone.innerText ?? clone.textContent ?? "";
    }, surface.providerId).catch(() => ""), signal, stepTimeoutMs) : "";
    return { count, latestText };
  }

  async waitForNewAnswer(surface: BrowserSurface, selector: string, baseline: BrowserAnswerBaseline, signal?: AbortSignal): Promise<void> {
    const page = await this.pageFor(surface);
    const deadline = Date.now() + configuredTimeout("WEB_AGENT_ANSWER_START_TIMEOUT_MS", 60_000);
    while (Date.now() < deadline) {
      throwIfRequestAborted(signal);
      const current = await this.readLatestAnswer(surface, selector, signal);
      if (current.count > baseline.count || (current.latestText && current.latestText !== baseline.latestText)) return;
      await waitForPageTimeout(page, 250, signal);
    }
    throw new ToolError("RESPONSE_TIMEOUT", "The provider did not expose a new assistant answer before timeout.", { provider: surface.providerId, phase: "answer_start" });
  }

  async watchAnswerUntilIdle(surface: BrowserSurface, selector: string, baseline: BrowserAnswerBaseline, onDelta: AnswerDeltaSink, signal?: AbortSignal): Promise<void> {
    let page = await this.pageFor(surface);
    // Hard stop must sit ABOVE the MCP wall clock (300s max, reviewer role now
    // defaults there): the outer deadline is authoritative. The 180s legacy default
    // fired first on chatgpt long reviews (observed 2026-08-20: RESPONSE_TIMEOUT at
    // 183s while the wall clock was 300s). Dead pages are caught by the
    // noOutputIdleMs watchdog below, not by this deadline.
    const deadline = Date.now() + configuredTimeout("WEB_AGENT_ANSWER_TIMEOUT_MS", 330_000);
    let observed = false;
    let reconnects = 0;
    let resyncs = 0;
    let queueResumes = 0;
    const textAccumulator = new AppendOnlyTextAccumulator(baseline.latestText);
    let stableIdleMs = 0;
    const stableIdleRequiredMs = configuredTimeout("WEB_AGENT_STABLE_IDLE_MS", 1_500);
    // Slow-page headroom: ChatGPT under rate-limiting has been observed to render
    // answers only after >120s; fast providers never reach this watchdog (they
    // settle via the stable-idle window), so a higher cap only delays the error
    // path for genuinely dead pages. The 300s wall-clock backstop still applies.
    const noOutputIdleMs = configuredTimeout("WEB_AGENT_NO_OUTPUT_IDLE_TIMEOUT_MS", 240_000);
    const stepTimeoutMs = configuredTimeout("WEB_AGENT_POLL_STEP_TIMEOUT_MS", 15_000);
    let lastOutputAt = Date.now();
    while (Date.now() < deadline) {
      try {
        throwIfRequestAborted(signal);
        if (Date.now() - lastOutputAt >= noOutputIdleMs) {
          throw new ToolError("RESPONSE_TIMEOUT", `${surface.providerId} produced no observable answer output for ${noOutputIdleMs}ms.`, {
            provider: surface.providerId, phase: "no_output_idle", noOutputIdleMs
          });
        }
        const current = await this.readLatestAnswer(surface, selector, signal);
        if (!observed && (current.count > baseline.count || (current.latestText && current.latestText !== baseline.latestText))) {
          // A new answer may replace the latest node's content without growing the
          // node count (observed on DeepSeek when it re-renders the last assistant
          // turn). Treat any change from the baseline as the start of the new answer
          // so the append-only tracker restarts instead of misreading the new answer
          // as a rewrite of the old one.
          observed = true;
          textAccumulator.reset();
        }
        if (current.latestText) {
          const observation = textAccumulator.observe(current.latestText);
          if (observation.kind === "desynchronized") {
            // Tool-position leniency: unlike the model-backend position, nothing has
            // been streamed to a caller yet, so a provider that REPLACES its node
            // text mid-turn (GLM streams its thinking block by rewriting the node;
            // ChatGPT swaps a "thinking" placeholder for the answer) can be
            // realigned instead of failing the call. The budget is generous on
            // purpose — sustained rewrites during generation are normal; the
            // no-output watchdog and the wall-clock deadline remain the backstops.
            resyncs += 1;
            if (resyncs > configuredTimeout("WEB_AGENT_RESYNC_LIMIT", 400)) {
              throw new ToolError("UI_DRIFT", `${surface.providerId} rewrote the visible answer repeatedly while streaming.`, {
                provider: surface.providerId, phase: "stream",
                previousCharacters: observation.previousCharacters, observedCharacters: observation.observedCharacters, resyncs
              });
            }
            textAccumulator.reset(current.latestText);
            lastOutputAt = Date.now();
            stableIdleMs = 0;
          }
          if (observation.kind === "delta") {
            await onDelta(observation.delta);
            lastOutputAt = Date.now();
            // Only new text means the provider is still streaming. An unchanged
            // final answer must be allowed to accumulate the stable-idle window.
            stableIdleMs = 0;
          }
          // NOTE: unlike the runtime original, a non-empty latestText does NOT set
          // observed=true here. Between the send and the first sign of the new
          // answer the page still shows the OLD answer while not generating, which
          // would otherwise satisfy the idle predicate and end the watch before the
          // new answer even starts (observed mid-flight on DeepSeek with a longer
          // prompt). observed may only be set by a change from the baseline.
        }
        const completion = completionManifestFor(surface.providerId);
        // GLM free tier: a visible queue banner means the turn stalled server-side.
        // GLM's own recovery is an official "重新提交/重新生成" button — clicking it
        // resumes THIS turn (not a duplicate prompt), so it is safe to automate,
        // bounded to two attempts before failing loud as RATE_LIMITED.
        if (surface.providerId === "glm" && completion.strategy === "glm") {
          const queueState = await raceWithStepTimeout(page.evaluate(() => {
            const visible = (element: Element): boolean => {
              const rect = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
            };
            const banner = [...document.querySelectorAll(".vip-limit-text")]
              .some((element) => visible(element) && /排队|高峰期/.test(element.textContent ?? ""));
            if (!banner) return { queued: false };
            const retry = [...document.querySelectorAll("button, [role='button'], [class*='btn'], span")]
              .find((element) => visible(element) && /^(重新提交|重新生成|重新回答|重新发送)/.test((element.textContent ?? "").trim()));
            return { queued: true, retryText: retry ? (retry.textContent ?? "").trim() : undefined };
          }), signal, stepTimeoutMs) as { queued: boolean; retryText?: string };
          if (queueState.queued) {
            if (queueResumes >= 2) {
              throw new ToolError("RATE_LIMITED",
                "glm is stuck in a peak-hours queue (free tier) and resume attempts are exhausted. Retry later, switch provider, or upgrade the account.",
                { provider: surface.providerId, phase: "queue", resumes: queueResumes });
            }
            if (queueState.retryText) {
              queueResumes += 1;
              await raceWithStepTimeout(page.evaluate(() => {
                const visible = (element: Element): boolean => {
                  const rect = element.getBoundingClientRect();
                  const style = getComputedStyle(element);
                  return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
                };
                const retry = [...document.querySelectorAll("button, [role='button'], [class*='btn'], span")]
                  .find((element) => visible(element) && /^(重新提交|重新生成|重新回答|重新发送)/.test((element.textContent ?? "").trim()));
                (retry as HTMLElement | undefined)?.click();
              }), signal, stepTimeoutMs);
              lastOutputAt = Date.now();
              await waitForPageTimeout(page, 1_500, signal);
              continue;
            }
            // Queued with no official resume control: keep waiting within the deadline.
            lastOutputAt = Date.now();
          }
        }
        const idleState = await raceWithStepTimeout(page.evaluate(({ completion, fallbackAnswerSelector }) => {
          const visible = (element: Element): boolean => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
          };
          const activeStop = [...document.querySelectorAll(completion.stopSelector)].some((element) => {
            if (!visible(element)) return false;
            // Some providers leave aria-busy on a layout wrapper after generation.
            // Only interactive controls can represent an active stop state.
            return !element.matches("[aria-busy='true']")
              || element.matches("button, [role='button'], input, textarea");
          });
          let ready = true;
          let readyControlVisible = true;
          if (completion.readySelector) {
            const control = [...document.querySelectorAll(completion.readySelector)].find(visible);
            readyControlVisible = Boolean(control);
            ready = readyControlVisible
              && !/stop|loading|generat|abort/i.test(String(control?.className))
              && !/停止生成|Stop generating/i.test(control?.textContent ?? "");
          }
          let deepSeekCompletion: DeepSeekCompletionState | undefined;
          let glmCompletion: GlmCompletionState | undefined;
          if (completion.requiresAnswerActions) {
            const continuation = [...document.querySelectorAll("button, [role='button']")]
              .filter(visible)
              .some((element) => new RegExp(completion.continuationText ?? "", "i").test(element.textContent ?? ""));
            const assistants = [...document.querySelectorAll(completion.answerSelector ?? fallbackAnswerSelector)].filter(visible);
            const latest = assistants.at(-1);
            const message = latest?.closest(".ds-message");
            const actions = message?.nextElementSibling;
            const latestActionsVisible = Boolean(actions)
              && [...(actions?.querySelectorAll(".ds-button[role='button'], button[role='button'], button") ?? [])].some(visible);
            deepSeekCompletion = {
              continuationVisible: continuation,
              latestAnswerText: latest?.textContent ?? "",
              latestActionsVisible
            };
          }
          if (completion.strategy === "glm") {
            const assistants = [...document.querySelectorAll(completion.answerSelector ?? fallbackAnswerSelector)].filter(visible);
            const latest = assistants.at(-1);
            const answerRoot = latest?.closest(".answer") ?? latest?.parentElement ?? latest;
            const answerScope = answerRoot?.textContent ?? latest?.textContent ?? "";
            glmCompletion = {
              completionMarkerVisible: Boolean(completion.completionMarkerText)
                && new RegExp(completion.completionMarkerText ?? "", "i").test(answerScope),
              latestAnswerText: latest?.textContent ?? "",
              readyControlVisible
            };
          }
          let completionActionVisible = true;
          if (completion.requiresCompletionAction) {
            const assistants = [...document.querySelectorAll(completion.answerSelector ?? fallbackAnswerSelector)].filter(visible);
            const latest = assistants.at(-1);
            // 2026-08-21: ChatGPT moved the action bar OUT of the
            // [data-message-author-role] node — copy buttons now live in the
            // surrounding turn <section>. Scoping to the message node made this
            // predicate permanently false: answers completed instantly while the
            // watcher burned the full wall clock (user-observed, DOM-verified).
            const actionScope = latest?.closest("[data-testid^='conversation-turn']") ?? latest;
            completionActionVisible = Boolean(latest && completion.completionActionSelector)
              && [...(actionScope?.querySelectorAll(completion.completionActionSelector ?? "") ?? [])].some(visible);
          }
          return { activeStop, ready, deepSeekCompletion, glmCompletion, completionActionVisible };
        }, { completion, fallbackAnswerSelector: selector }), signal, stepTimeoutMs);
        const glmIdle = completion.strategy === "glm"
          && Boolean(idleState.glmCompletion && isGlmAnswerComplete(idleState.glmCompletion))
          // GLM can leave a stale aria-busy/stop control mounted after it shows
          // the explicit "思考结束" marker. The marker is stronger evidence.
          && Boolean(idleState.glmCompletion?.completionMarkerVisible || !idleState.activeStop);
        const idle = completion.strategy === "glm"
          ? glmIdle
          : !idleState.activeStop
            && idleState.ready
            && (!completion.requiresAnswerActions
              || Boolean(idleState.deepSeekCompletion && isDeepSeekAnswerComplete(idleState.deepSeekCompletion)))
            && (!completion.requiresCompletionAction || idleState.completionActionVisible);
        if (observed && idle) {
          stableIdleMs += 250;
          if (stableIdleMs >= stableIdleRequiredMs) return;
        } else {
          stableIdleMs = 0;
        }
        await waitForPageTimeout(page, 250, signal);
      } catch (error) {
        if (signal?.aborted) throw requestCancelledError();
        if (reconnects >= 1 || !isRecoverableBrowserDisconnect(error)) throw error;
        reconnects += 1;
        this.resetPageConnection();
        page = await this.pageFor(surface);
        stableIdleMs = 0;
      }
    }
    throw new ToolError("RESPONSE_TIMEOUT", "The provider did not finish the assistant answer before timeout.", { provider: surface.providerId, phase: "answer" });
  }

  async send(surface: BrowserSurface, selector: string, signal?: AbortSignal): Promise<BrowserSendReceipt> {
    throwIfRequestAborted(signal);
    const operationId = `send_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const page = await this.pageFor(surface);
    if (surface.providerId === "chatgpt") {
      const composer = await this.chatGptComposer(page);
      const formButton = composer.locator("xpath=ancestor::form[1]").locator("button[data-testid='send-button']").filter({ visible: true }).last();
      const pageButton = page.locator("button[data-testid='send-button']").filter({ visible: true }).last();
      const sendButton = await formButton.count() ? formButton : pageButton;
      try {
        if (await sendButton.count() === 0 || !await sendButton.isEnabled()) return { outcome: "not_sent", operationId };
        const beforeUserTurns = await page.locator("[data-message-author-role='user'], [data-testid^='conversation-turn-'][data-message-author-role='user']").filter({ visible: true }).count();
        const beforeAssistantTurns = await page.locator("[data-message-author-role='assistant'], [data-testid^='conversation-turn-'][data-turn='assistant']").filter({ visible: true }).count();
        await sendButton.press("Enter");
        await page.waitForFunction(({ beforeUser, beforeAssistant }) => {
          const visible = (element: Element): boolean => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
          };
          const userTurns = [...document.querySelectorAll("[data-message-author-role='user'], [data-testid^='conversation-turn-'][data-message-author-role='user']")].filter(visible);
          const assistantTurns = [...document.querySelectorAll("[data-message-author-role='assistant'], [data-testid^='conversation-turn-'][data-turn='assistant']")].filter(visible);
          const generationStarted = [...document.querySelectorAll("button[aria-label*='Stop'], button[aria-label*='停止'], [aria-busy='true']")].some(visible);
          return userTurns.length > beforeUser || assistantTurns.length > beforeAssistant || generationStarted;
        }, { beforeUser: beforeUserTurns, beforeAssistant: beforeAssistantTurns }, { timeout: 5_000 });
        throwIfRequestAborted(signal);
        return { outcome: "sent", operationId };
      } catch {
        return { outcome: "unknown", operationId };
      }
    }
    const before = await this.submissionState(page, surface);
    if (!before.composerText?.trim()) return { outcome: "not_sent", operationId };

    const target = page.locator(selector).filter({ visible: true }).first();
    if (await target.count() === 0) return { outcome: "not_sent", operationId };
    try {
      const disabled = await target.evaluate((element) => {
        if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) return element.disabled;
        return element.getAttribute("aria-disabled") === "true"
          || element.getAttribute("disabled") === "true"
          || /disabled|empty/.test(String(element.className));
      });
      if (disabled) return { outcome: "not_sent", operationId };
      await target.click({ timeout: 5_000 });
      if (await this.waitForSubmissionEvidence(page, surface, before, 5_000, signal)) {
        return { outcome: "sent", operationId };
      }
      const finalState = await this.submissionState(page, surface);
      return finalState.composerText === before.composerText
        && !finalState.generating
        && finalState.url === before.url
        ? { outcome: "not_sent", operationId }
        : { outcome: "unknown", operationId };
    } catch {
      return { outcome: "unknown", operationId };
    }
  }

  async copyLatestAnswer(surface: BrowserSurface, selector: string, signal?: AbortSignal, answerIndex?: number): Promise<string> {
    throwIfRequestAborted(signal);
    const page = await this.pageFor(surface);
    if (surface.providerId === "glm") {
      // Scroll-collect first: it is complete for segmented long code and quote-safe.
      // answerIndex (from the observer) targets the exact turn's answer.
      const collected = await this.collectGlmAnswer(page, signal, answerIndex);
      if (collected.trim()) return collected;
    }
    const target = page.locator(selector).filter({ visible: true }).last();
    try {
      // Copy is an extraction optimization, not the completion signal. A provider can
      // render the final answer before its action row is mounted (GLM does this on some
      // turns), so do not hold an already-complete answer for a long UI wait.
      await raceWithAbort(target.waitFor({ state: "visible", timeout: configuredTimeout("WEB_AGENT_COPY_TIMEOUT_MS", 2_000) }), signal);
    } catch {
      if (surface.providerId === "chatgpt") return this.readLatestChatGptAnswerText(page);
      if (surface.providerId === "glm") {
        // Long code gets SPLIT into multiple <pre> segments on GLM; the copy button
        // also mangles multi-line strings. Scroll-collect rebuilds the answer from
        // textContent (raw, quote-safe) instead.
        const collected = await this.collectGlmAnswer(page, signal, answerIndex);
        if (collected.trim()) return collected;
        const fallback = await this.readLatestAnswer(surface, ".answer .answer-content-wrap:not(.text-advance-thinking-content)");
        if (fallback.latestText.trim()) return fallback.latestText;
      }
      throw new ToolError("COPY_UNAVAILABLE", `No visible copy control matched ${selector}.`, { provider: surface.providerId, phase: "copy" });
    }
    await page.evaluate(() => {
      const key = "__WEB_AGENT_COPY_CAPTURE__";
      const state: { text: string; cleanup?: () => void } = { text: "" };
      const onCopy = (event: ClipboardEvent) => {
        const text = event.clipboardData?.getData("text/plain") ?? "";
        if (text) state.text = text;
      };
      document.addEventListener("copy", onCopy, false);
      const clipboard = navigator.clipboard;
      const originalWriteText = clipboard?.writeText;
      const originalWrite = clipboard?.write;
      if (clipboard) {
        try {
          Object.defineProperty(clipboard, "writeText", { configurable: true, value: async (text: string) => { state.text = String(text ?? ""); } });
        } catch { /* The page may expose a non-configurable clipboard object. */ }
        try {
          Object.defineProperty(clipboard, "write", { configurable: true, value: async (items: ClipboardItems) => {
            for (const item of items ?? []) {
              if (!item?.types?.includes?.("text/plain")) continue;
              state.text = await (await item.getType("text/plain")).text();
              break;
            }
          } });
        } catch { /* The page may expose a non-configurable clipboard object. */ }
      }
      state.cleanup = () => {
        document.removeEventListener("copy", onCopy, false);
        if (clipboard) {
          try { Object.defineProperty(clipboard, "writeText", { configurable: true, value: originalWriteText }); } catch { /* best effort */ }
          try { Object.defineProperty(clipboard, "write", { configurable: true, value: originalWrite }); } catch { /* best effort */ }
        }
      };
      (window as Window & { __WEB_AGENT_COPY_CAPTURE__?: typeof state }).__WEB_AGENT_COPY_CAPTURE__ = state;
    });
    let text = "";
    try {
      // Viewport gate (2026-08-21, user-observed): when a reply finishes, the answer
      // and its action bar are already in view — scrolling the page to reach a copy
      // button is needless and visibly drags the user's browser. If the button is
      // outside the viewport, take the DOM text instead of scrolling for it.
      const inViewport = await target.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth;
      }).catch(() => false);
      if (!inViewport && surface.providerId === "chatgpt") {
        const domText = await this.readLatestChatGptAnswerText(page);
        if (domText.trim()) return domText;
      }
      try {
        await target.click({ timeout: 3_000 });
      } catch {
        // ChatGPT's action bar is hover-revealed / can be covered by overlays, so a
        // geometrically visible button still fails Playwright actionability. A
        // DOM-level click fires the page's own handler — our clipboard shim
        // captures the write either way.
        await target.evaluate((el) => { (el as HTMLElement).click(); });
      }
      await waitForPageTimeout(page, 100, signal);
      text = await raceWithAbort(page.evaluate(async () => {
        const state = (window as Window & { __WEB_AGENT_COPY_CAPTURE__?: { text?: string } }).__WEB_AGENT_COPY_CAPTURE__;
        return state?.text ?? "";
      }), signal);
    } catch {
      // Click or capture failed — provider DOM fallbacks below.
    } finally {
      await page.evaluate(() => {
        const target = window as Window & { __WEB_AGENT_COPY_CAPTURE__?: { cleanup?: () => void } };
        target.__WEB_AGENT_COPY_CAPTURE__?.cleanup?.();
        delete target.__WEB_AGENT_COPY_CAPTURE__;
      }).catch(() => undefined);
    }
    if (!text.trim()) {
      if (surface.providerId === "chatgpt") {
        const domText = await this.readLatestChatGptAnswerText(page);
        if (domText.trim()) return domText;
      }
      throw new ToolError("COPY_UNAVAILABLE", "The provider copy action returned an empty clipboard value.", { provider: surface.providerId, phase: "copy" });
    }
    return text;
  }

  /**
   * GLM render adaptation: scroll the latest answer into full render, then rebuild
   * it from DOM order — <pre> segments via textContent (raw code, no smart quotes,
   * no line-break mangling) wrapped in fences with the language class, prose via
   * innerText. Defeats both the segmented-code rendering and the lossy copy path.
   */
  /**
   * answerIndex comes from the observer (readLatestAnswer counted the same
   * assistant-selector set before/after the turn), so the extractor targets the
   * exact new answer instead of guessing "the last substantive one" — short ack
   * replies also render as answers and can arrive after the real payload.
   */
  private async collectGlmAnswer(page: Page, signal: AbortSignal | undefined, answerIndex?: number): Promise<string> {
    return raceWithStepTimeout(page.evaluate(async ({ answerIndex }) => {
      const visible = (element: Element): boolean => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      // Same collection as readLatestAnswer's assistant selector, so indexes align.
      const answers = [...document.querySelectorAll(".answer .answer-content-wrap:not(.text-advance-thinking-content)")].filter(visible);
      let answer: Element | undefined = answerIndex != null ? answers[answerIndex as number] : undefined;
      if (!answer) {
        const substantive = answers.filter((element) =>
          [...element.querySelectorAll("pre")].some((pre) => (pre.textContent ?? "").trim().length > 100)
          || (element.textContent ?? "").trim().length > 500);
        answer = substantive.at(-1) ?? answers.at(-1);
      }
      if (!answer) return "";
      const scroller = answer.closest(".chatScrollContainer") ?? document.scrollingElement;
      if (scroller && scroller instanceof HTMLElement) {
        // Force every lazy segment to render before reading.
        const before = answer.getBoundingClientRect().top + window.scrollY;
        let lastHeight = -1;
        for (let i = 0; i < 60 && scroller.scrollHeight !== lastHeight; i++) {
          lastHeight = scroller.scrollHeight;
          scroller.scrollTo({ top: scroller.scrollHeight });
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
        scroller.scrollTo({ top: Math.max(0, before - 80) });
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      const content = answer.querySelector(".answer-content-wrap") ?? answer;
      const parts: string[] = [];
      const walk = (node: Node): void => {
        if (node instanceof HTMLElement && node.tagName === "PRE") {
          const langClass = [...node.classList].find((name) => name.startsWith("language-"));
          const lang = langClass ? langClass.replace("language-", "") : "";
          parts.push("```" + lang + "\n" + (node.textContent ?? "") + "\n```");
          return;
        }
        if (node instanceof HTMLElement && node.tagName === "P") {
          const text = node.innerText?.trim();
          if (text) parts.push(text);
          return;
        }
        for (const child of node.childNodes) walk(child);
      };
      walk(content);
      return parts.join("\n\n").trim();
    }, { answerIndex: answerIndex ?? null }), signal, 30_000);
  }

  private async readLatestChatGptAnswerText(page: Page): Promise<string> {
    const text = await page.evaluate(() => {
      const visible = (element: Element): boolean => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const assistantTurns = [
        ...document.querySelectorAll("[data-message-author-role='assistant'], [data-testid^='conversation-turn-'][data-turn='assistant']")
      ].filter(visible);
      const latest = assistantTurns.at(-1);
      return (latest?.textContent ?? "").replace(/\s+/g, " ").trim();
    }).catch(() => "");
    if (!text.trim()) throw new ToolError("COPY_UNAVAILABLE", "ChatGPT answer text was not readable without a copy control.", { provider: "chatgpt", phase: "copy" });
    return text;
  }

  private async chatGptComposer(page: Page): Promise<Locator> {
    const editable = page.locator(CHATGPT_EDITABLE_COMPOSER_SELECTOR).filter({ visible: true }).first();
    if (await editable.waitFor({ state: "visible", timeout: 30_000 }).then(() => true).catch(() => false)) return editable;
    const textarea = page.locator(CHATGPT_TEXTAREA_COMPOSER_SELECTOR).filter({ visible: true }).first();
    if (await textarea.waitFor({ state: "visible", timeout: 10_000 }).then(() => true).catch(() => false)) return textarea;
    throw new ToolError("UI_DRIFT", "No visible ChatGPT composer was found.", { provider: "chatgpt", phase: "composer" });
  }

  private genericComposer(page: Page): Locator {
    return page.locator("textarea:not([disabled]), [contenteditable='true']").filter({ visible: true }).last();
  }

  private async submissionState(page: Page, surface: BrowserSurface): Promise<BrowserSubmissionState> {
    const composer = this.genericComposer(page);
    const composerText = await composer.evaluate((element) => {
      if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return element.value;
      return element.textContent ?? "";
    }).catch(() => undefined);
    const completion = completionManifestFor(surface.providerId);
    const generating = await page.evaluate((completion) => {
      const visible = (element: Element): boolean => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      if ([...document.querySelectorAll(completion.stopSelector)].some(visible)) return true;
      if (!completion.readySelector) return false;
      return [...document.querySelectorAll(completion.readySelector)]
        .filter(visible)
        .some((element) => /stop|loading|generat|abort/i.test(String(element.className))
          || /停止生成|Stop generating/i.test(element.textContent ?? ""));
    }, completion).catch(() => false);
    return { composerText, generating, url: page.url() };
  }

  private async waitForSubmissionEvidence(
    page: Page,
    surface: BrowserSurface,
    before: BrowserSubmissionState,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      throwIfRequestAborted(signal);
      const after = await this.submissionState(page, surface);
      if (hasBrowserSubmissionEvidence(before, after)) return true;
      await waitForPageTimeout(page, 100, signal);
    }
    return false;
  }

  private async pageFor(surface: BrowserSurface): Promise<Page> {
    const key = this.key(surface.providerId, surface.surfaceId);
    const browser = await this.ensureBrowser();
    const cached = this.pages.get(key);
    if (cached && !cached.isClosed()) return cached;
    if (surface.providerId === "chatgpt") {
      // Reuse a visible, already-open ChatGPT page in the user's daily Chrome.
      // One-shot tool calls never open tabs or navigate.
      const page = await this.findReusableChatGptPage();
      if (!page) throw new ToolError("PROVIDER_UNAVAILABLE",
        "No open ChatGPT page with a ready composer was found. Open chatgpt.com in the daily Chrome (CDP) and retry.", { provider: "chatgpt" });
      this.pages.set(key, page);
      return page;
    }
    const pages = browser.contexts().flatMap((context) => context.pages()).filter((page) => !page.isClosed());
    const expectedOrigin = new URL(surface.url).origin;
    const sameOrigin = pages.filter((candidate) => {
      try { return new URL(candidate.url()).origin === expectedOrigin; } catch { return false; }
    });
    // Fail loud on ambiguity: with several same-origin tabs we cannot prove which one
    // the user means, and typing into the wrong private conversation is irreversible.
    if (sameOrigin.length === 0) {
      throw new ToolError("PROVIDER_UNAVAILABLE",
        `No visible page matched ${surface.providerId}. Open the provider page in the daily Chrome (CDP) and retry.`, { provider: surface.providerId });
    }
    if (sameOrigin.length > 1) {
      throw new ToolError("PROVIDER_UNAVAILABLE",
        `${sameOrigin.length} ${surface.providerId} tabs are open; refusing to guess which one to use. Keep exactly one tab for this provider.`, { provider: surface.providerId, openTabs: sameOrigin.length });
    }
    const page = sameOrigin[0];
    if (!page) throw new ToolError("PROVIDER_UNAVAILABLE", `No visible page matched ${surface.providerId}.`, { provider: surface.providerId });
    this.pages.set(key, page);
    return page;
  }

  private async findReusableChatGptPage(): Promise<Page | undefined> {
    const browser = await this.ensureBrowser();
    const pages = browser.contexts().flatMap((context) => context.pages()).filter((page) => !page.isClosed());
    for (const page of pages) {
      try {
        const url = new URL(page.url());
        if (url.origin !== "https://chatgpt.com") continue;
        await this.chatGptComposer(page);
        return page;
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    this.resetPageConnection();
    try {
      // Chrome's HTTP discovery endpoint responds, but Playwright's built-in
      // http:// connect path can stall during the browser-wide auto-attach
      // handshake on the user's long-lived daily profile. Resolve the browser
      // WebSocket explicitly so the connection has one deterministic path.
      const endpoint = await resolveCdpWebSocket(this.options.cdpUrl);
      this.browser = await chromium.connectOverCDP(endpoint, {
        timeout: configuredTimeout("WEB_AGENT_CDP_CONNECT_TIMEOUT_MS", 15_000)
      });
      await this.grantProviderClipboardPermissions();
      return this.browser;
    } catch (error) {
      throw new ToolError("BROWSER_DISCONNECTED", `Could not connect to Chrome CDP: ${error instanceof Error ? error.message : String(error)}`, undefined);
    }
  }

  private resetPageConnection(): void {
    this.pages.clear();
    this.browser = undefined;
  }

  private async grantProviderClipboardPermissions(): Promise<void> {
    const origins = [...new Set(this.options.surfaces.map((surface) => {
      try { return new URL(surface.url).origin; } catch { return undefined; }
    }).filter((origin): origin is string => Boolean(origin)))];
    for (const context of this.browser?.contexts() ?? []) {
      for (const origin of origins) {
        await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin }).catch(() => undefined);
      }
    }
  }

  private key(providerId: string, surfaceId: string): string {
    return `${providerId}:${surfaceId}`;
  }
}

async function readComposerValue(input: Locator): Promise<string> {
  return input.evaluate((element) => {
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return element.value;
    if ("value" in element) return String((element as { value?: unknown }).value ?? "");
    return element.textContent ?? "";
  }).catch(() => "");
}

function normalizeComposerText(value: string): string {
  // ProseMirror renders paragraphs as block boundaries: textContent drops the
  // newlines that fill() wrote (observed 2026-08-19: a 683-char prompt read back
  // as 665 chars with every \n\n gone while the DOM was correct). Whitespace-only
  // differences are therefore representation, not corruption — compare the
  // substantive character stream. Insertions/deletions/replacements of real
  // characters still fail the check.
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, "");
}

async function resolveCdpWebSocket(cdpUrl: string): Promise<string> {
  const versionUrl = new URL("/json/version", cdpUrl).toString();
  const response = await fetch(versionUrl, { signal: AbortSignal.timeout(configuredTimeout("WEB_AGENT_CDP_HTTP_TIMEOUT_MS", 8_000)) });
  if (!response.ok) throw new Error(`CDP ${versionUrl} returned HTTP ${response.status}`);
  const payload = await response.json() as { webSocketDebuggerUrl?: string };
  const endpoint = payload.webSocketDebuggerUrl;
  if (!endpoint) throw new Error("CDP /json/version did not include webSocketDebuggerUrl");
  return endpoint;
}

function isRecoverableBrowserDisconnect(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Target closed|Browser has been closed|WebSocket|socket|disconnect/i.test(message);
}

function configuredTimeout(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 1_000 ? value : fallback;
}

function requestCancelledError(): ToolError {
  return new ToolError("INTERNAL", "The tool call was cancelled by the client.", undefined);
}

function throwIfRequestAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw requestCancelledError();
}

async function waitForPageTimeout(page: Page, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  await raceWithAbort(page.waitForTimeout(timeoutMs), signal);
}

async function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfRequestAborted(signal);
  let settled = false;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(requestCancelledError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    }, (error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}

/**
 * Playwright calls do not observe AbortSignals, and a single hung CDP round-trip
 * (page.evaluate, locator.count) inside a 250ms polling loop would block that loop
 * forever even though the loop head checks the signal every iteration. Cap each
 * polling step so a stuck browser round-trip surfaces as a typed error instead of a
 * leaked call.
 */
async function raceWithStepTimeout<T>(promise: Promise<T>, signal: AbortSignal | undefined, timeoutMs: number): Promise<T> {
  let clearTimer: (() => void) | undefined;
  const capped = Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new ToolError("BROWSER_STEP_TIMEOUT",
        `A browser polling step did not settle within ${timeoutMs}ms.`, { stepTimeoutMs: timeoutMs })), timeoutMs);
      timer.unref?.();
      clearTimer = () => clearTimeout(timer);
    })
  ]);
  if (clearTimer) capped.finally(clearTimer).catch(() => undefined);
  return raceWithAbort(capped, signal);
}
