/**
 * web_delegate core: turn a self-contained task spec into a provider prompt
 * (the "job ticket"), then parse the web model's answer back into the declared
 * deliverable and machine-check it. See notes/2026-08-19-delegation-pipeline.md.
 *
 * The pipeline position is the point: the outer agent skips the generation step
 * entirely and receives the deliverable itself — code/JSON are compact and
 * lossless, so no summarization happens on this path.
 */
import * as acorn from "acorn";
import { ToolError } from "./errors.js";

/** Matches the web composer comfort budget; the page hard limit is far higher. */
const promptLimit = 16_000;

export type DeliverableFormat =
  | { format: "code-block"; language?: string }
  | { format: "json"; required_keys?: string[] };

export type AcceptanceMode = "parse" | "none";

export interface DelegateInput {
  task_spec: string;
  context?: string;
  deliverable: DeliverableFormat;
  acceptance?: AcceptanceMode;
}

/** Assemble the single self-contained job ticket sent to the page. */
export function buildDelegatePrompt(input: DelegateInput): string {
  const contract = input.deliverable.format === "code-block"
    ? `产物契约：只返回一个 ${"`".repeat(3)}${input.deliverable.language ?? ""} 代码块，代码块之外不得有任何文字。`
    : `产物契约：只返回一个合法 JSON（无注释、无尾逗号、代码块标记也不需要），JSON 之外不得有任何文字。${input.deliverable.required_keys?.length ? `顶层必须包含这些键：${input.deliverable.required_keys.join(", ")}。` : ""}`;
  const assembled = [
    "你是流水线中的一个执行工位。严格按照任务规格完成生成，输出只包含产物本身。",
    contract,
    "<task_spec>",
    input.task_spec,
    "</task_spec>",
    ...(input.context ? ["<context>", input.context, "</context>"] : []),
    // Source-shape guard: GLM's streaming pipeline corrupts multi-line string-array
    // literals (real newlines inside quotes + smart quotes). Forbidding the shape in
    // the job ticket keeps the DOM clean at the source, so extraction stays trivial.
    "代码形态约束：不要使用多行字符串数组字面量（数组元素分行书写的形式）。需要包含换行的字符串一律写成单行并用 \\n 转义（例如 \"line1\\nline2\"）；构造多行测试输入时用这种单行字符串。引号一律使用半角直引号 \"。",
    "禁止：解释、寒暄、多个代码块、markdown 标题、开头结尾的任何说明文字。"
  ].join("\n");
  if (assembled.length > promptLimit) {
    throw new Error(`delegate prompt exceeds ${promptLimit} characters (${assembled.length}); shrink task_spec/context`);
  }
  return assembled;
}

/** Follow-up ticket when the first answer broke the deliverable contract. */
export function buildRetryPrompt(input: DelegateInput, reason: string): string {
  const contract = input.deliverable.format === "code-block"
    ? `只重新输出该 ${input.deliverable.language ?? ""} 代码块，从第一行代码开始，到最后一行代码结束。`
    : "只重新输出该 JSON，从 { 开始到 } 结束。";
  return `你上一轮的输出未遵循产物契约（原因：${reason}）。${contract}不要任何其他文字。`;
}

/** Repair-floor ticket: the default extractor could not produce an acceptable
 * deliverable (e.g. GLM mixed-delimiter corruption is informationally ambiguous
 * for local rules). Hand the RAW answer — the fullest evidence — to the executor
 * chain (deepseek first) as a reconstruction job. */
export function buildRepairPrompt(corrupted: string, deliverable: DeliverableFormat, reason: string): string {
  const contract = deliverable.format === "code-block"
    ? `产物契约：只返回修复后的完整代码，放在单个 ${"`".repeat(3)}${deliverable.language ?? ""} 代码块中，代码块之外不得有任何文字。`
    : `产物契约：只返回修复后的合法 JSON（无注释、无尾逗号、不需要代码块标记），JSON 之外不得有任何文字。${deliverable.required_keys?.length ? `顶层必须包含这些键：${deliverable.required_keys.join(", ")}。` : ""}`;
  const assembled = [
    "你是流水线中的修复工位。下面 <corrupted> 是从网页端提取的损坏产物：渲染管线破坏了排版（字符串内换行、弯引号、fence 残留、噪声行等）。",
    "任务：还原出语法合法的原始代码/JSON。只修复损坏形态，不得改变逻辑、标识符、字符串内容，不得增删功能或测试。",
    "依据：<corrupted> 中的代码结构本身；引号配对以代码结构为准。个别无法唯一确定原样时，选择保持语法合法的最小改动。",
    `默认提取器验收失败原因：${reason}`,
    contract,
    "<corrupted>",
    corrupted,
    "</corrupted>"
  ].join("\n");
  if (assembled.length > promptLimit) {
    throw new Error(`repair prompt exceeds ${promptLimit} characters (${assembled.length}); the corrupted answer is too large for the repair floor`);
  }
  return assembled;
}

/** Review-round revision ticket (escalation operator #2): the reviewer found real
 * issues; the executor revises the DELIVERABLE minimally against the findings.
 * Original task_spec rides along so the revision optimizes the same goal. */
export function buildRevisionPrompt(taskSpec: string, deliverableCode: string, findings: string[], deliverable: DeliverableFormat): string {
  const contract = deliverable.format === "code-block"
    ? `产物契约：只返回修订后的完整代码，放在单个 ${"`".repeat(3)}${deliverable.language ?? ""} 代码块中，代码块之外不得有任何文字。`
    : `产物契约：只返回修订后的合法 JSON，之外不得有任何文字。${deliverable.required_keys?.length ? `顶层必须包含：${deliverable.required_keys.join(", ")}。` : ""}`;
  const assembled = [
    "你是流水线中的修订工位。下方 <deliverable> 是上一版产物，审查工位给出了发现的问题。",
    "任务：最小化修改，逐条解决 <findings> 中的问题；不要重构无关部分，不要改变接口，不要新增未要求的功能。",
    "源代码形态约束：需要换行的字符串一律单行并用 \\n 转义；引号一律半角直引号。",
    "<original_task>",
    taskSpec,
    "</original_task>",
    "<findings>",
    ...findings.map((f, i) => `${i + 1}. ${f}`),
    "</findings>",
    "<deliverable>",
    deliverableCode,
    "</deliverable>",
    contract
  ].join("\n");
  if (assembled.length > promptLimit) {
    throw new Error(`revision prompt exceeds ${promptLimit} characters (${assembled.length})`);
  }
  return assembled;
}

export interface ParsedDeliverable {
  ok: boolean;
  value: string;
  reason?: string;
}

/** Web code-block toolbars leak button captions into copied/DOM text
 * (observed 2026-08-19: DeepSeek "ts / 复制 / 下载" lines; GLM glues language and
 * caption into one token like "ts复制"). Strip leading/trailing noise lines. */
const NOISE_WORD = "复制|下载|分享|重新生成|copy code|copy|download|share|edit|运行|run";
const LANG_WORD = "ts|js|tsk|javascript|typescript|python|py|json|bash|sh|shell|java|go|rust|c|cpp|c\\+\\+|csharp|cs|sql|html|css|yaml|yml|xml|md|markdown|txt|text";
const UI_NOISE_LINE = new RegExp(`^(?:(?:${LANG_WORD})\\s*(?:${NOISE_WORD})|(?:${NOISE_WORD})|(?:${LANG_WORD}))$`, "i");

/**
 * GLM's streaming pipeline replaces \\n escapes INSIDE string literals with REAL
 * newlines (observed 2026-08-19: "Here is the answer:\n<newline>ts..."), leaving
 * syntactically broken multi-line strings. The transform is invertible: scan with a
 * quote/comment state machine and turn bare newlines back into \\n escapes.
 * Template literals (`) legally span lines and are left untouched; comments are
 * skipped. Misalignment risk is contained by acceptance checks downstream.
 */
function repairBareNewlinesInStrings(code: string): string {
  let out = "";
  let quote: string | undefined;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      out += ch; i++; continue;
    }
    if (inBlockComment) {
      if (ch === "*" && code[i + 1] === "/") { out += "*/"; i += 2; inBlockComment = false; continue; }
      out += ch; i++; continue;
    }
    if (quote) {
      if (escaped) { out += ch; escaped = false; i++; continue; }
      if (ch === "\\") { out += ch; escaped = true; i++; continue; }
      if (ch === "\n" && quote !== "`") { out += "\\n"; i++; continue; }
      if (ch === quote) quote = undefined;
      out += ch; i++; continue;
    }
    if (ch === "/" && code[i + 1] === "/") { inLineComment = true; out += "//"; i += 2; continue; }
    if (ch === "/" && code[i + 1] === "*") { inBlockComment = true; out += "/*"; i += 2; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; out += ch; i++; continue; }
    out += ch; i++;
  }
  return out;
}

/** GLM's streaming pipeline smart-quotes string literals even inside code blocks
 * (chunk-with-strings turns " into “ ). For code deliverables curly quotes are
 * never intentional — normalize them mechanically before acceptance. */
function normalizeSmartQuotes(code: string): string {
  // GLM smart-quotes string DELIMITERS while straight quotes inside the string are
  // content (observed 2026-08-20: “{"a":1}”). Blind conversion yields `"{"a":1}"`
  // which no later stage can disambiguate — so escape inner quotes while the
  // curly delimiters still carry the boundary information, then sweep orphans.
  const doubles = code.replace(/“([^“”]*)”/g, (_m, inner: string) => '"' + inner.replace(/(?<!\\)"/g, '\\"') + '"');
  const singles = doubles.replace(/‘([^‘’]*)’/g, (_m, inner: string) => "'" + inner.replace(/(?<!\\)'/g, "\\'") + "'");
  return singles.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

function stripUiNoise(code: string): string {
  const lines = code.split(/\r?\n/);
  let start = 0;
  let end = lines.length;
  while (start < end && (UI_NOISE_LINE.test(lines[start].trim()) || !/\S/.test(lines[start]))) start++;
  while (end > start && (UI_NOISE_LINE.test(lines[end - 1].trim()) || !/\S/.test(lines[end - 1]))) end--;
  const stripped = lines.slice(start, end).join("\n");
  // If everything was noise (e.g. a block whose only line is a language name),
  // fall back to the original: stripping must never destroy the deliverable.
  return stripped.trim() ? stripped : code.trim();
}

/** Extract the deliverable from a raw web answer per the contract. */
export function parseDeliverable(raw: string, deliverable: DeliverableFormat): ParsedDeliverable {
  const text = raw.trim();
  if (!text) return { ok: false, value: "", reason: "answer was empty" };
  if (deliverable.format === "code-block") {
    const first = text.match(/```[a-zA-Z0-9+#-]*\r?\n([\s\S]*?)```/);
    if (first?.[1]?.trim()) {
      let value = repairBareNewlinesInStrings(normalizeSmartQuotes(stripUiNoise(first[1])));
      // Generated code sometimes embeds ``` inside a string literal (e.g. tests for
      // this very extractor); the non-greedy first-pair match then truncates the
      // deliverable mid-string. Rescue with the span from the first opening fence
      // to the LAST fence close, but only when it balances and the first pair
      // does not (minimal intervention: multi-block answers keep first-block behavior).
      if (bracketImbalance(value) !== 0) {
        const open = text.match(/```[a-zA-Z0-9+#-]*\r?\n/);
        const last = text.lastIndexOf("```");
        if (open?.index !== undefined && last > open.index + open[0].length) {
          const span = text.slice(open.index + open[0].length, last);
          if (span.trim()) {
            // lastIndexOf lands on the LAST fence, which may be a stray marker AFTER
            // the real closing fence (observed 2026-08-20: GLM history renders a
            // dangling "```" paragraph); that swallows the real close into the span.
            // A bare trailing fence line is always structural, never content — strip it.
            const spanTrimmed = span.replace(/\r?\n[ \t]*```[\s]*$/, "");
            const repaired = repairBareNewlinesInStrings(normalizeSmartQuotes(stripUiNoise(spanTrimmed)));
            if (bracketImbalance(repaired) === 0) value = repaired;
          }
        }
      }
      return { ok: true, value };
    }
    // Some providers drop fences; accept a bare answer only if it looks like code.
    const lines = text.split(/\r?\n/);
    const codeLike = lines.filter((line) => /\S/.test(line) && !/^(好的|以下是|这是|Here|Sure|当然)/i.test(line.trim()));
    if (codeLike.length === lines.filter((line) => /\S/.test(line)).length && /[{;=()}\[\]]/.test(text)) {
      return { ok: true, value: repairBareNewlinesInStrings(normalizeSmartQuotes(stripUiNoise(text))) };
    }
    return { ok: false, value: "", reason: "no fenced code block found and answer does not look like bare code" };
  }
  // json
  const direct = tryParseJson(text);
  if (direct !== undefined) return { ok: true, value: text };
  const fenced = text.match(/```(?:json)?\r?\n([\s\S]*?)```/);
  if (fenced?.[1] && tryParseJson(fenced[1]) !== undefined) return { ok: true, value: fenced[1].trim() };
  const braced = extractBalancedBraces(text);
  if (braced && tryParseJson(braced) !== undefined) return { ok: true, value: braced };
  return { ok: false, value: "", reason: "answer is not valid JSON (direct, fenced, or braced extraction all failed)" };
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractBalancedBraces(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

export type AcceptanceResult =
  | { passed: true; syntax_note?: string }
  | { passed: false; reason: string };

/** Machine acceptance on the parsed deliverable (cheap checks only). */
export function runAcceptance(value: string, deliverable: DeliverableFormat, mode: AcceptanceMode): AcceptanceResult {
  if (mode === "none") return { passed: true };
  if (!value.trim()) return { passed: false, reason: "deliverable is empty" };
  if (deliverable.format === "json") {
    const parsed = tryParseJson(value);
    if (parsed === undefined || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { passed: false, reason: "deliverable does not parse as a JSON object" };
    }
    const missing = (deliverable.required_keys ?? []).filter((key) => !(key in (parsed as Record<string, unknown>)));
    if (missing.length) return { passed: false, reason: `missing required keys: ${missing.join(", ")}` };
    return { passed: true };
  }
  // code-block: structural sanity, then a real parser pass (acorn, module mode).
  // TS/JSX deliverables have no in-process parser here — the gap is REPORTED as a
  // syntax_note, never silently equated with "checked" (2026-08-20 review finding:
  // 无法检查 ≠ 检查通过). Brace balance applies to every dialect; repair floor backstops all.
  const unbalanced = braceImbalance(value);
  if (Math.abs(unbalanced) > 0) return { passed: false, reason: `unbalanced braces: ${unbalanced > 0 ? "missing }" : "extra }"}` };
  const syntax = runSyntaxCheck(value, deliverable);
  if (syntax.status === "invalid") return { passed: false, reason: syntax.error };
  if (syntax.status === "unsupported") return { passed: true, syntax_note: `syntax not checked: ${syntax.reason}` };
  return { passed: true, syntax_note: "syntax checked (acorn, module)" };
}

export type SyntaxCheckResult =
  | { status: "valid" }
  | { status: "invalid"; error: string }
  | { status: "unsupported"; reason: string };

/** Anti-corruption syntax gate (drill 2026-08-20: implementation delegated to the
 * executor chain, then rebuilt per chatgpt review — acorn module-mode parsing
 * replaced vm.Script plus three fail-open exemptions; result is three-state so
 * "unsupported" is never mistaken for "verified"). */
export function runSyntaxCheck(code: string, deliverable?: DeliverableFormat): SyntaxCheckResult {
  const lang = (deliverable?.format === "code-block" ? deliverable.language : "")?.trim().toLowerCase() ?? "";
  if (/^(ts|tsx|typescript|jsx)$/.test(lang)) {
    return { status: "unsupported", reason: lang };
  }
  try {
    acorn.parse(code, { ecmaVersion: "latest", sourceType: "module", allowAwaitOutsideFunction: true });
    return { status: "valid" };
  } catch (e) {
    if (e instanceof SyntaxError) return { status: "invalid", error: "syntax: " + e.message };
    throw e;
  }
}

function braceImbalance(code: string): number {
  let depth = 0;
  let inString: string | undefined;
  let escaped = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (ch === "\\") escaped = true;
      else if (ch === inString) inString = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inString = ch; continue; }
    if (code.startsWith("//", i)) { const nl = code.indexOf("\n", i); if (nl < 0) break; i = nl; continue; }
    if (code.startsWith("/*", i)) { const end = code.indexOf("*/", i + 2); if (end < 0) break; i = end + 1; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  return depth;
}

/** Like braceImbalance but counts (), [], and {} — used only to detect truncation
 * when choosing between fence candidates; acceptance keeps the brace-only check
 * so regex literals with escaped parens cannot false-fail deliverables. */
function bracketImbalance(code: string): number {
  let depth = 0;
  let inString: string | undefined;
  let escaped = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (ch === "\\") escaped = true;
      else if (ch === inString) inString = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inString = ch; continue; }
    if (code.startsWith("//", i)) { const nl = code.indexOf("\n", i); if (nl < 0) break; i = nl; continue; }
    if (code.startsWith("/*", i)) { const end = code.indexOf("*/", i + 2); if (end < 0) break; i = end + 1; continue; }
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
  }
  return depth;
}


// ---------------------------------------------------------------------------
// Escalation operator #3: cross-validation (mechanical diff only — no judgment,
// no merging; deepseek's council red line). Line-level LCS alignment of two
// independently generated deliverables: matched lines are agreed, unmatched
// runs are conflicts reported with BOTH excerpts for the outer to arbitrate.
// ---------------------------------------------------------------------------

export interface DeliverableDiff {
  agreementRatio: number;
  primaryLines: number;
  secondaryLines: number;
  conflictCount: number;
  conflicts: Array<{ line: number; primary: string; secondary: string }>;
}

const DIFF_CONFLICT_CAP = 5;
const DIFF_EXCERPT_CHARS = 200;

/** Council synthesis extraction: fixed four-field labels keep this mechanical
 * (same doctrine as the decision packet — the prompt mandates the shape). */
export interface CouncilSynthesis {
  consensus: string;
  disputes: string;
  recommendation: string;
  minority: string;
}

export function extractCouncilSynthesis(text: string): CouncilSynthesis | undefined {
  const labels = ["共识", "分歧", "建议", "少数意见"];
  const grab = (label: string): string => {
    const re = new RegExp(`(?:^|\\n)[^\\n]{0,10}${label}\\s*[：:]\\s*([\\s\\S]*?)(?=(?:^|\\n)[^\\n]{0,10}(?:${labels.join("|")})\\s*[：:]|$)`, "i");
    const m = text.match(re);
    // Strip leading markdown decoration (bold/italic markers after the label colon).
    return m ? m[1].replace(/^[*_\s]+/, "").trim().slice(0, 800) : "";
  };
  const synthesis: CouncilSynthesis = {
    consensus: grab("共识"),
    disputes: grab("分歧"),
    recommendation: grab("建议"),
    minority: grab("少数意见")
  };
  if (!synthesis.consensus && !synthesis.disputes && !synthesis.recommendation) return undefined;
  return synthesis;
}

export function diffDeliverables(primary: string, secondary: string): DeliverableDiff {
  const a = primary.split("\n");
  const b = secondary.split("\n");
  // LCS table on trimmed lines (whitespace-insensitive agreement, consistent with
  // the extraction normalizations upstream).
  const ta = a.map((l) => l.trim());
  const tb = b.map((l) => l.trim());
  const n = ta.length, m = tb.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = ta[i] === tb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const matchedA = new Array<boolean>(n).fill(false);
  const matchedB = new Array<boolean>(m).fill(false);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (ta[i] === tb[j]) { matchedA[i] = true; matchedB[j] = true; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  const excerpt = (lines: string[]): string => {
    const joined = lines.join("\n");
    return joined.length > DIFF_EXCERPT_CHARS ? joined.slice(0, DIFF_EXCERPT_CHARS) + "…" : joined;
  };
  const conflicts: DeliverableDiff["conflicts"] = [];
  let conflictCount = 0;
  // Walk unmatched runs in A; pair each with the nearest unmatched run in B.
  let bi = 0;
  const nextUnmatchedRunB = (from: number): [number, number] => {
    let s = from;
    while (s < m && matchedB[s]) s++;
    let e = s;
    while (e < m && !matchedB[e]) e++;
    return [s, e];
  };
  let ai = 0;
  while (ai < n) {
    while (ai < n && matchedA[ai]) ai++;
    if (ai >= n) break;
    let ae = ai;
    while (ae < n && !matchedA[ae]) ae++;
    while (bi < m && matchedB[bi]) bi++;
    const [bs, be] = nextUnmatchedRunB(bi);
    conflictCount += 1;
    if (conflicts.length < DIFF_CONFLICT_CAP) {
      conflicts.push({
        line: ai + 1,
        primary: excerpt(a.slice(ai, ae)),
        secondary: bs < be ? excerpt(b.slice(bs, be)) : ""
      });
    }
    if (bs < be) bi = be;
    ai = ae;
  }
  // Unmatched B-only runs (pure secondary insertions) count as conflicts too.
  while (bi < m) {
    while (bi < m && matchedB[bi]) bi++;
    if (bi >= m) break;
    let be2 = bi;
    while (be2 < m && !matchedB[be2]) be2++;
    conflictCount += 1;
    if (conflicts.length < DIFF_CONFLICT_CAP) {
      conflicts.push({ line: 0, primary: "", secondary: excerpt(b.slice(bi, be2)) });
    }
    bi = be2;
  }
  const matched = matchedA.filter(Boolean).length;
  return {
    agreementRatio: Math.max(n, m) === 0 ? 1 : matched / Math.max(n, m),
    primaryLines: n,
    secondaryLines: m,
    conflictCount,
    conflicts
  };
}

// ---------------------------------------------------------------------------
// R1 Decision Packet: compress what the OUTER agent must read, never the
// deliverable. The review prompt contract mandates "[严重度: 高/中/低] 主题 — 描述 —
// 建议" segments and an explicit 未发现明显问题 when clean — both are mechanically
// parseable, so the packet costs zero extra web tokens (2026-08-20 drill data:
// 2632-char review -> ~500-char packet, high-severity items lossless).
// ---------------------------------------------------------------------------

export interface DecisionPacket {
  verdict: "accept" | "needs-changes" | "unclear";
  high: string[];
  medium_count: number;
  low_count: number;
  note?: string;
  total_chars: number;
}

const HIGH_ITEM_LIMIT = 120;
const HIGH_ITEMS_MAX = 3;

export function assembleDecisionPacket(reviewText: string): DecisionPacket {
  const total_chars = reviewText.length;
  const marker = /\[严重度[:：]\s*(高|中|低)\]/g;
  const high: string[] = [];
  let medium_count = 0;
  let low_count = 0;
  let m: RegExpExecArray | null;
  while ((m = marker.exec(reviewText)) !== null) {
    if (m[1] === "高") {
      if (high.length < HIGH_ITEMS_MAX) {
        // Title runs from after the marker to the first em-dash/newline (contract
        // separator " — "); cap at HIGH_ITEM_LIMIT so the packet stays a digest.
        const rest = reviewText.slice(marker.lastIndex, marker.lastIndex + HIGH_ITEM_LIMIT + 40);
        const stop = rest.search(/[—\n]/);
        let title = (stop >= 0 ? rest.slice(0, stop) : rest).trim();
        if (title.length > HIGH_ITEM_LIMIT) title = title.slice(0, HIGH_ITEM_LIMIT - 1) + "…";
        if (title) high.push(title);
      }
    } else if (m[1] === "中") medium_count++;
    else low_count++;
  }
  if (high.length + medium_count + low_count > 0) {
    return { verdict: "needs-changes", high, medium_count, low_count, total_chars };
  }
  if (/未发现(明显)?(问题|缺陷)|no (obvious )?(issues|problems)/i.test(reviewText)) {
    return { verdict: "accept", high: [], medium_count: 0, low_count: 0, total_chars };
  }
  // No contract markers and no clean phrase — say so instead of faking a verdict.
  return { verdict: "unclear", high: [], medium_count: 0, low_count: 0, note: "no severity-marked findings detected; review output did not follow the structure contract", total_chars };
}

export function delegateToolError(message: string): ToolError {
  return new ToolError("INVALID_ARGUMENT", message, undefined);
}
