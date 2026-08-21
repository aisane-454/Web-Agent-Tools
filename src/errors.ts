/**
 * Closed error taxonomy. The union is deliberately small and tool-shaped: every
 * failure a client model can see maps to exactly one code, and providers are
 * never silently swapped on failure.
 *
 * Design rule (from deepseek-harness docs/subsystems/subagent.md "capabilities
 * are ... rejected loud, never accepted-then-ignored"): missing capability is a
 * loud error, not a fallback to another provider.
 */
export type ToolErrorCode =
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_BUSY"
  | "LOGIN_REQUIRED"
  | "CAPTCHA_REQUIRED"
  | "TWO_FACTOR_REQUIRED"
  | "RISK_CONTROL"
  | "RATE_LIMITED"
  | "TERMS_DIALOG"
  | "UI_DRIFT"
  | "COPY_UNAVAILABLE"
  | "CANCELLED"
  | "SEND_IDEMPOTENCY_UNKNOWN"
  | "RESPONSE_TIMEOUT"
  | "BROWSER_STEP_TIMEOUT"
  | "BROWSER_DISCONNECTED"
  | "INVALID_ARGUMENT"
  | "INTERNAL";

export interface ToolErrorDetails {
  provider?: string;
  phase?: string;
  [key: string]: unknown;
}

export class ToolError extends Error {
  constructor(
    public readonly code: ToolErrorCode,
    message: string,
    public readonly details?: ToolErrorDetails
  ) {
    super(message);
    this.name = "ToolError";
  }
}

/** Page-level human-attention codes surfaced by inspect(). */
export type HumanActionCode =
  | "LOGIN_REQUIRED"
  | "CAPTCHA_REQUIRED"
  | "TWO_FACTOR_REQUIRED"
  | "RISK_CONTROL"
  | "TERMS_DIALOG";

export function humanActionCodeToToolError(code: HumanActionCode): ToolErrorCode {
  return code;
}
