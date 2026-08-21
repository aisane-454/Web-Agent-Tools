/**
 * Canonical, closed tool surface.
 *
 * Every tool declares its canonical output schema up front — the deepseek-harness
 * ToolDefinition discipline (docs/subsystems/tools.md:27-93): a model-facing input
 * schema, a typed canonical output, and nothing host-only leaking into the model
 * request. Output schemas are zod raw shapes consumed by MCP outputSchema so
 * bridges (dsh mcp-client validates structuredContent against them) and callers
 * can rely on one stable contract.
 */
import { z } from "zod/v4";
import type { ToolErrorCode } from "./errors.js";

export const PROVIDER_IDS = ["chatgpt", "deepseek", "glm"] as const;
export const providerIdSchema = z.enum(PROVIDER_IDS);

const promptLimit = 16_000;

export const webAskInput = z.object({
  provider: providerIdSchema.optional().describe("Optional explicit provider. Omit to use the advisor chain from config."),
  prompt: z.string().min(1).max(promptLimit).optional().describe("Fully self-contained prompt text (inline any code/context needed). Omit ONLY with salvage=true."),
  salvage: z.boolean().optional().describe("Read-only recovery of the latest completed answer on the provider page — nothing is sent. Requires explicit provider. Use after a timed-out call: the page often finishes the answer after the deadline. Fails with PROVIDER_BUSY if still generating; retry when idle."),
  timeout_ms: z.number().int().min(10_000).max(300_000).optional().describe("Overall deadline in ms (default 180000, max 300000).")
}).strict();

export const webReviewInput = z.object({
  provider: providerIdSchema.optional().describe("Optional explicit provider. Omit to use the reviewer chain (default: chatgpt first)."),
  content: z.string().min(1).max(promptLimit).describe("The content to review (code, plan, or document text)."),
  focus: z.string().max(2_000).optional().describe("Optional review focus, e.g. 'concurrency safety' or 'error handling'."),
  packet_only: z.boolean().optional().describe("Return only the mechanically assembled decision packet (verdict + high-severity titles + counts) instead of the full review text. Full text is always recoverable from the page or turn log."),
  timeout_ms: z.number().int().min(10_000).max(300_000).optional()
}).strict();

export const deliverableSchema = z.discriminatedUnion("format", [
  z.object({
    format: z.literal("code-block"),
    language: z.string().max(30).optional().describe("Fence language hint, e.g. 'ts', 'python'.")
  }),
  z.object({
    format: z.literal("json"),
    required_keys: z.array(z.string().min(1)).max(20).optional().describe("Top-level keys the JSON must contain.")
  })
]);

export const webDelegateInput = z.object({
  task_spec: z.string().min(1).max(12_000).describe("What to generate: input, output, hard constraints. Self-contained."),
  context: z.string().max(12_000).optional().describe("Dependencies the step needs (interface signatures, snippets, conventions)."),
  deliverable: deliverableSchema.describe("Product contract: how the raw answer must be shaped for lossless extraction."),
  acceptance: z.enum(["parse", "none"]).optional().describe("Machine acceptance on the parsed deliverable (default 'parse')."),
  review_rounds: z.number().int().min(0).max(2).optional().describe("Escalation operator #2: after machine acceptance, the reviewer chain audits the deliverable and the executor revises per findings, bounded to this many review passes (0=off, default). Each pass is a logged, artifact-snapshotted physical page send."),
  cross_check: z.boolean().optional().describe("Escalation operator #3: independently generate the same task on the next executor-chain provider in PARALLEL, then mechanically line-diff the two deliverables. Returns agreement ratio + conflict excerpts (both sides) for the outer to arbitrate; never merges or picks."),
  timeout_ms: z.number().int().min(10_000).max(300_000).optional(),
  override: providerIdSchema.optional().describe("Pin one executor provider; omit to use the executor chain (deepseek first).")
}).strict();

export const webCouncilInput = z.object({
  question: z.string().min(1).max(promptLimit).describe("Self-contained question — all attending web AIs answer it independently, in parallel; a synthesis seat compresses the answers into a four-field verdict."),
  providers: z.array(providerIdSchema).min(2).max(3).optional().describe("Council members (default: all three providers). The synthesis seat comes from the advisor chain and attends in addition."),
  timeout_ms: z.number().int().min(10_000).max(300_000).optional()
}).strict();

export const webCouncilOutput = z.object({
  ok: z.boolean(),
  duration_ms: z.number().int().optional(),
  synthesis: z.object({
    consensus: z.string(),
    disputes: z.string(),
    recommendation: z.string(),
    minority: z.string()
  }).optional().describe("Four-field verdict (共识/分歧/建议/少数意见). Member full texts are artifact-snapshotted."),
  members: z.array(z.object({
    provider: z.string(),
    ok: z.boolean(),
    characters: z.number().int().optional(),
    error: z.string().optional()
  })).optional(),
  error: z.string().optional(),
  message: z.string().optional()
});

export const webHandoffInput = z.object({
  provider: providerIdSchema.describe("Which page needs human attention.")
}).strict();

export const webStatusInput = z.object({
  force: z.boolean().optional().describe("Bypass the 5s health cache and probe pages now.")
}).strict();

// MCP output schemas must be top-level JSON objects (unions at the root are not
// representable), so success/error variants share one flat object with optional
// fields instead of a discriminated union.
export const decisionPacketSchema = z.object({
  verdict: z.string(),
  high: z.array(z.string()),
  medium_count: z.number().int(),
  low_count: z.number().int(),
  note: z.string().optional(),
  total_chars: z.number().int()
}).describe("Mechanically assembled digest of a structured review: verdict, up to 3 high-severity titles (≤120 chars), counts, original length. Zero extra web tokens.");

export const webAskOutput = z.object({
  ok: z.boolean(),
  provider: z.string().optional(),
  duration_ms: z.number().int().optional(),
  answer_characters: z.number().int().optional(),
  answer_count: z.number().int().optional().describe("Salvage mode: how many assistant answers exist on the page (the returned one is the latest)."),
  packet: decisionPacketSchema.optional().describe("Salvage mode: present when the recovered text parses as a structured review — verdict + high-severity digest without re-reading the full text."),
  error: z.string().optional(),
  message: z.string().optional()
});
export const webReviewOutput = z.object({
  ok: z.boolean(),
  provider: z.string().optional(),
  duration_ms: z.number().int().optional(),
  answer_characters: z.number().int().optional(),
  packet: decisionPacketSchema.optional(),
  error: z.string().optional(),
  message: z.string().optional()
});

export const webDelegateOutput = z.object({
  ok: z.boolean(),
  provider: z.string().optional(),
  format: z.string().optional(),
  duration_ms: z.number().int().optional(),
  acceptance: z.string().optional(),
  repair: z.string().optional().describe("Set when the default extractor failed and the executor chain (deepseek first) reconstructed the deliverable — value names the repairing provider."),
  review: z.string().optional().describe("Review-round provenance when review_rounds>0: reviewer verdicts and revision rounds, e.g. 'chatgpt: needs-changes → deepseek revised → accept (1/1)'."),
  cross_check: z.object({
    secondary_provider: z.string(),
    agreement_ratio: z.number(),
    conflict_count: z.number().int(),
    conflicts: z.array(z.object({ line: z.number().int(), primary: z.string(), secondary: z.string() })),
    secondary_error: z.string().optional()
  }).optional().describe("Generation-level agreement between the two providers (mechanical line diff; full diff in artifacts)."),
  error: z.string().optional(),
  message: z.string().optional()
});

export const webHandoffOutput = z.object({
  provider: z.string(),
  action_required: z.string().nullable().describe("Human-action code (LOGIN_REQUIRED etc.) or null when the page is fine."),
  guidance: z.string().describe("What the user should do on the visible page."),
  page_url: z.string().optional(),
  page_title: z.string().optional()
});

export const webStatusOutput = z.object({
  cdp_url: z.string(),
  providers: z.array(z.object({
    provider: z.string(),
    display_name: z.string(),
    healthy: z.boolean(),
    input_ready: z.boolean().optional(),
    generating: z.boolean().optional(),
    login_required: z.boolean().optional(),
    challenge_detected: z.boolean().optional(),
    url: z.string().optional(),
    title: z.string().optional(),
    error: z.string().optional(),
    message: z.string().optional()
  }))
});

/** Assemble the review prompt template (kept here so the contract is reviewable). */
/** Council member ticket: one independent answer, position-first, bounded length. */
export function buildCouncilMemberPrompt(question: string): string {
  const assembled = [
    "你是议事会成员。就下面的问题独立作答：先给结论，再给最多三条论据，最后给一条适用边界（什么情况下你的结论不成立）。全文 ≤400 字，不要客套。",
    "<question>",
    question,
    "</question>"
  ].join("\n");
  if (assembled.length > promptLimit) throw new RangeError(`council question exceeds ${promptLimit} characters`);
  return assembled;
}

/** Council synthesis ticket: fixed four-field verdict so extraction stays mechanical. */
export function buildCouncilSynthesisPrompt(question: string, answers: Array<{ provider: string; text: string }>): string {
  const assembled = [
    "你是议事会的汇总席。多家网页模型对同一问题独立作答。请汇总为四字段决议，只输出以下四个字段，每个字段以字段名开头，除这四行结构外不得有任何其他文字：",
    "共识：<多数一致的观点，分号分隔>",
    "分歧：<真正互斥的立场，标注持方>",
    "建议：<综合后的最强一条行动建议>",
    "少数意见：<值得记录的少数派洞见，没有则写'无'>",
    "<question>",
    question,
    "</question>",
    ...answers.flatMap((a) => [`<answer provider=\"${a.provider}\">`, a.text.slice(0, 6_000), "</answer>"])
  ].join("\n");
  if (assembled.length > promptLimit) {
    throw new RangeError(`council synthesis prompt exceeds ${promptLimit} characters (${assembled.length}); trim member answers`);
  }
  return assembled;
}

export function buildReviewPrompt(content: string, focus?: string): string {
  const focusLine = focus?.trim() ? `审查重点：${focus.trim()}\n` : "";
  const header = [
    "你是一名严格的独立审查者。请审查下面 <content> 中的内容。",
    focusLine,
    "输出要求：",
    "1. 用编号列表列出发现的问题，每条包含：[严重度: 高/中/低] 位置或主题 — 问题描述 — 修改建议。",
    "2. 没有发现问题时，明确说明“未发现明显问题”，并给出一到两条可选的改进方向。",
    "3. 直接给结论，不要复述原文。"
  ].filter(Boolean).join("\n");
  const prompt = `${header}\n<content>\n${content}\n</content>`;
  if (prompt.length > promptLimit) {
    // Caller-side contract violation is reported before touching any page.
    throw new RangeError(`review prompt exceeds ${promptLimit} characters (${prompt.length}); trim the content or split the review.`);
  }
  return prompt;
}
