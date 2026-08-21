import type { HumanActionCode } from "../errors.js";

/** Copied (trimmed) from web-agent-codex-runtime/src/runtime/browserWorker.ts. */
export interface BrowserSurface {
  providerId: string;
  surfaceId: string;
  url: string;
}

export interface BrowserPageSnapshot {
  url: string;
  title: string;
  inputReady: boolean;
  generating: boolean;
  loginRequired: boolean;
  challengeDetected: boolean;
  humanActionCode?: HumanActionCode;
  /** GLM free tier shows a queue banner ("高峰期排队中") while the turn stalls. */
  queued?: boolean;
}

export type SendOutcome = "sent" | "not_sent" | "unknown";

export interface BrowserSendReceipt {
  outcome: SendOutcome;
  operationId: string;
}

export interface BrowserAnswerBaseline {
  count: number;
  latestText: string;
}

export type AnswerDeltaSink = (delta: string) => void | Promise<void>;
