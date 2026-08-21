// glm-deepseek repaired pipeline
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDeliverable, runAcceptance, buildDelegatePrompt, assembleDecisionPacket, buildRevisionPrompt, diffDeliverables, extractCouncilSynthesis } from "../dist/delegate.js";
import { readFileSync } from "node:fs";

const DELIV_CODE = { format: "code-block" };
const DELIV_JSON = (keys) => keys ? { format: "json", required_keys: keys } : { format: "json" };

// ---------- parseDeliverable: code-block ----------

test("parseDeliverable code-block: extracts first fenced block and strips noise lines", () => {
  const raw = [
    "Here is the answer:",
    "",
    "```ts",
    "const x = 1;",
    "```",
    "download",
    "Thanks!",
  ].join("\n");
  const r = parseDeliverable(raw, DELIV_CODE);
  assert.equal(r.ok, true);
  assert.equal(r.value, "const x = 1;");
});

test("parseDeliverable code-block: strips language names, copy variants and combos at head/tail", () => {
  const raw = "python\npython\ncopy code\nts复制\ndef f():\n    return 42\n分享\njs\nbash复制\n";
  const r = parseDeliverable(raw, DELIV_CODE);
  assert.equal(r.ok, true);
  assert.equal(r.value, "def f():\n    return 42");
});

test("parseDeliverable code-block: empty fenced content returns ok:false", () => {
  const raw = "前言\n\n```\n\n```\n后记";
  const r = parseDeliverable(raw, DELIV_CODE);
  assert.equal(r.ok, false);
});

test("parseDeliverable code-block: no fence but looks like bare code is extracted", () => {
  const raw = "Some intro text.\nconst answer = 42;";
  const r = parseDeliverable(raw, DELIV_CODE);
  assert.equal(r.ok, true);
  assert.ok(r.value.includes("const answer = 42"));
});

test("parseDeliverable code-block: empty string returns ok:false", () => {
  const r = parseDeliverable("", DELIV_CODE);
  assert.equal(r.ok, false);
});

test("parseDeliverable code-block: plain prose without fence or code-like content returns ok:false", () => {
  const r = parseDeliverable("This is just a plain sentence.\nAnother line of prose.", DELIV_CODE);
  assert.equal(r.ok, false);
});

// ---------- parseDeliverable: json ----------

test("parseDeliverable json: direct JSON.parse path returns value as string", () => {
  const raw = '{"a":1,"b":[2,3]}';
  const r = parseDeliverable(raw, DELIV_JSON());
  assert.equal(r.ok, true);
  assert.equal(r.value, raw);
});

test("parseDeliverable json: extracts from json fenced block", () => {
  const raw = 'Answer:\n```json\n{"a": 1}\n```\ndone';
  const r = parseDeliverable(raw, DELIV_JSON());
  assert.equal(r.ok, true);
  assert.ok(r.value.includes('"a"'));
});

test("parseDeliverable json: extracts balanced-brace segment from prose", () => {
  const raw = 'The result is {"a":1,"b":{"c":2}} as requested.';
  const r = parseDeliverable(raw, DELIV_JSON());
  assert.equal(r.ok, true);
  assert.ok(r.value.includes('"a"'));
});

test("parseDeliverable json: empty string returns ok:false", () => {
  const r = parseDeliverable("", DELIV_JSON());
  assert.equal(r.ok, false);
});

test("parseDeliverable json: no JSON anywhere returns ok:false", () => {
  const r = parseDeliverable("just plain text, nothing parseable here", DELIV_JSON());
  assert.equal(r.ok, false);
});

// ---------- runAcceptance ----------

test("runAcceptance mode none always passes regardless of content", () => {
  assert.equal(runAcceptance("", DELIV_CODE, "none").passed, true);
  assert.equal(runAcceptance("{{{{ not balanced", DELIV_CODE, "none").passed, true);
  assert.equal(runAcceptance("garbage", DELIV_JSON(), "none").passed, true);
});

test("runAcceptance json: passes when object contains all required keys", () => {
  const r = runAcceptance('{"a":1,"b":2}', DELIV_JSON(["a", "b"]), "parse");
  assert.equal(r.passed, true);
});

test("runAcceptance json: missing required keys fails with proper reason", () => {
  const r = runAcceptance('{"a":1}', DELIV_JSON(["a", "b", "c"]), "parse");
  assert.equal(r.passed, false);
  assert.ok(r.reason.startsWith("missing required keys"));
});

test("runAcceptance json: non-object JSON fails", () => {
  const r = runAcceptance("[1,2,3]", DELIV_JSON(), "parse");
  assert.equal(r.passed, false);
});
// 2026-08-20: GLM 三重损坏（弯引号 + 字符串内裸换行 + 字符串内嵌 ```）纯规则修复回归
// 样本来自真实 GLM 页面提取（fixtures/glm-smartquote-multiline.txt 同源）
test("parseDeliverable: repairs bare newlines inside string literals (GLM \\n-escape corruption)", () => {
  const broken = [
    'const raw = "Here is the answer:',
    "",
    '  ts";',
    'console.log(raw);'
  ].join("\n");
  const r = parseDeliverable("```js\n" + broken + "\n```", DELIV_CODE);
  assert.equal(r.ok, true);
  assert.equal(r.value, 'const raw = "Here is the answer:\\n\\n  ts";\nconsole.log(raw);');
});

test("parseDeliverable: keeps real newlines inside template literals untouched", () => {
  const src = "const t = `line1\nline2`;\nconsole.log(t.length);";
  const r = parseDeliverable("```js\n" + src + "\n```", DELIV_CODE);
  assert.equal(r.ok, true);
  assert.equal(r.value, src);
});

test("parseDeliverable: survives ``` embedded in a string literal (fence truncation rescue)", () => {
  const inner = 'const parts = ["a",\n"```",\n"done"].join("\\n");\nconsole.log(parts.length);';
  const r = parseDeliverable("```js\n" + inner + "\n```", DELIV_CODE);
  assert.equal(r.ok, true);
  assert.ok(r.value.includes('"done"'), "must not truncate at inner fence");
  assert.ok(r.value.includes("].join"), "array closer survives");
});

test("parseDeliverable: multi-block answers still take the first block (rescue is minimal-intervention)", () => {
  const two = "说明：\n```js\nconst a = {x:1};\n```\n再补：\n```js\nconst b = 2;\n```\n完";
  const r = parseDeliverable(two, DELIV_CODE);
  assert.equal(r.value.trim(), "const a = {x:1};");
});

// 2026-08-20 第二波：GLM 弯引号定界 + 内容直引号（“{"a":1}” 形态）——
// 必须在定界信息尚存时给内容引号加转义，否则盲转会产出 "{"a":1}" 无法再消歧
test("parseDeliverable: escapes straight quotes inside curly-delimited strings", () => {
  const src = 'const raw = “{"a":1,"b":[2,3]}”;\nconsole.log(JSON.parse(raw).b.length);';
  const r = parseDeliverable("```js\n" + src + "\n```", DELIV_CODE);
  assert.equal(r.ok, true);
  assert.equal(r.value, 'const raw = "{\\"a\\":1,\\"b\\":[2,3]}";\nconsole.log(JSON.parse(raw).b.length);');
});

test("parseDeliverable: plain curly-quoted strings still normalize without escapes", () => {
  const src = 'const s = “纯内容没有内嵌引号”;\nconsole.log(s.length);';
  const r = parseDeliverable("```js\n" + src + "\n```", DELIV_CODE);
  assert.equal(r.ok, true);
  assert.equal(r.value, 'const s = "纯内容没有内嵌引号";\nconsole.log(s.length);');
});

test("parseDeliverable: rescue span drops trailing dangling fence line", () => {
  // GLM 历史渲染会在真闭合后留一个悬挂 ``` 段；span 尾部剥离后救援才能对齐真闭合
  const code = 'const parts = [\n"fence:",\n"```",\n"tail",].join("\\n");\nconsole.log(parts.length);';
  const raw = "```js\n" + code + "\n```\n\n```";
  const r = parseDeliverable(raw, DELIV_CODE);
  assert.equal(r.ok, true);
  assert.ok(r.value.includes('"tail"'), "must not truncate at inner fence");
  assert.ok(r.value.includes("].join"), "array closer survives");
});

// 2026-08-20 演练：语法门（层 1.5）——生成委派 deepseek、chatgpt 审查后按意见重建：
// acorn module 模式真解析替代 vm.Script+三个 fail-open 豁免；三态结果，unsupported 显式标注
test("runSyntaxCheck: catches brace-balanced but syntactically broken code (mixed-quote damage class)", () => {
  const r = runAcceptance('const raw = "unterminated\nconsole.log(raw);', { format: "code-block" }, "parse");
  assert.equal(r.passed, false);
  assert.ok(r.reason.startsWith("syntax:"), `reason=${r.reason}`);
});

test("runSyntaxCheck: valid script passes with checked note", () => {
  const r = runAcceptance("const a = {x:1};\nconsole.log(a.x);", { format: "code-block" }, "parse");
  assert.equal(r.passed, true);
  assert.match(r.syntax_note, /syntax checked/);
});

test("runSyntaxCheck: ESM is REALLY parsed now — import plus later garbage fails (review finding 1)", () => {
  const r = runAcceptance('import x from "y";\nconst broken = "unterminated', { format: "code-block" }, "parse");
  assert.equal(r.passed, false);
  assert.ok(r.reason.startsWith("syntax:"));
});

test("runSyntaxCheck: valid ESM passes (acorn module mode)", () => {
  const r = runAcceptance('import x from "y";\nconsole.log(x);', { format: "code-block" }, "parse");
  assert.equal(r.passed, true);
});

test("runSyntaxCheck: TS is unsupported — passes braces but the gap is REPORTED, never hidden (review findings 3/8)", () => {
  const r = runAcceptance("function f(a: string): number { return a.length; }", { format: "code-block", language: "ts" }, "parse");
  assert.equal(r.passed, true);
  assert.match(r.syntax_note, /not checked: ts/);
});

test("runSyntaxCheck: language match is exact — 'tsx-anything' is NOT TS (review finding 4)", () => {
  const r = runAcceptance("const ok = 1;", { format: "code-block", language: "tsx-anything" }, "parse");
  assert.equal(r.passed, true);
  assert.match(r.syntax_note, /syntax checked/);
});

test("runSyntaxCheck: top-level await is natively valid in module mode (review finding 2)", () => {
  const r = runAcceptance("const d = await Promise.resolve(1);\nconsole.log(d);", { format: "code-block" }, "parse");
  assert.equal(r.passed, true);
});

// 2026-08-20 R1：Decision Packet 机械装配——fixture 是 chatgpt 真实审查（vm 门，8 条发现）
test("assembleDecisionPacket: real review -> verdict + high titles + counts", () => {
  const raw = readFileSync("fixtures/review-chatgpt-vm-gate.txt", "utf8");
  const p = assembleDecisionPacket(raw);
  assert.equal(p.verdict, "needs-changes");
  assert.equal(p.high.length, 3);
  assert.ok(p.high[0].includes("ESM"));
  assert.ok(p.high[1].includes("await"));
  assert.ok(p.high[2].includes("TS/TSX"));
  assert.equal(p.medium_count, 4);
  assert.equal(p.low_count, 1);
  assert.ok(p.high.every((t) => t.length <= 120), "high titles capped at 120 chars");
  assert.equal(p.total_chars, raw.length);
});

test("assembleDecisionPacket: clean review -> accept", () => {
  const p = assembleDecisionPacket("审查完成：未发现明显问题。可选改进：增加一个示例。");
  assert.equal(p.verdict, "accept");
  assert.deepEqual(p.high, []);
});

test("assembleDecisionPacket: unstructured text -> unclear, never a fake verdict", () => {
  const p = assembleDecisionPacket("看起来还行吧，我觉得可以合并。");
  assert.equal(p.verdict, "unclear");
  assert.ok(p.note?.includes("contract"));
});

test("assembleDecisionPacket: more than 3 high findings -> first 3 only, counts intact", () => {
  const raw = [1, 2, 3, 4, 5].map((i) => `[严重度: 高] 发现${i} — 细节描述`).join("\n") + "\n[严重度: 中] 中等项 — 细节";
  const p = assembleDecisionPacket(raw);
  assert.equal(p.high.length, 3);
  assert.equal(p.high[0], "发现1");
  assert.equal(p.medium_count, 1);
});

// 2026-08-21 升级链算子 #2：审查-修订闭环
test("buildRevisionPrompt: embeds task, findings, deliverable and fence contract", () => {
  const p = buildRevisionPrompt("写一个 median 函数", "function median(n){return n[0]}", ["空数组未处理", "偶数长度未平均"], { format: "code-block", language: "ts" });
  assert.ok(p.includes("<original_task>") && p.includes("median 函数"));
  assert.ok(p.includes("1. 空数组未处理") && p.includes("2. 偶数长度未平均"));
  assert.ok(p.includes("function median(n){return n[0]}"));
  assert.ok(p.includes("```ts"));
  assert.ok(p.includes("最小化修改"));
});

test("buildRevisionPrompt: respects prompt limit", () => {
  const big = "x".repeat(20_000);
  assert.throws(() => buildRevisionPrompt(big, big, ["f"], { format: "code-block" }), /exceeds/);
});

// 2026-08-21 升级链算子 #3：机械交叉验证 diff
test("diffDeliverables: identical deliverables -> full agreement", () => {
  const d = diffDeliverables("const a = 1;\nconst b = 2;", "const a = 1;\nconst b = 2;");
  assert.equal(d.agreementRatio, 1);
  assert.equal(d.conflictCount, 0);
});

test("diffDeliverables: single divergent line reported with both excerpts", () => {
  const a = "function f() {\n  return 1;\n}";
  const b = "function f() {\n  return 2;\n}";
  const d = diffDeliverables(a, b);
  assert.equal(d.conflictCount, 1);
  assert.equal(d.conflicts[0].line, 2);
  assert.equal(d.conflicts[0].primary, "  return 1;");
  assert.equal(d.conflicts[0].secondary, "  return 2;");
  assert.ok(d.agreementRatio > 0.5 && d.agreementRatio < 1);
});

test("diffDeliverables: pure insertion -> conflict with empty primary side", () => {
  const a = "const x = 1;";
  const b = "const x = 1;\nconst y = 2;";
  const d = diffDeliverables(a, b);
  assert.equal(d.conflictCount, 1);
  assert.equal(d.conflicts[0].primary, "");
  assert.equal(d.conflicts[0].secondary, "const y = 2;");
});

test("diffDeliverables: whitespace-insensitive agreement, capped conflicts", () => {
  const a = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
  const b = a.split("\n").map((l) => "  " + l + "  ").join("\n");
  assert.equal(diffDeliverables(a, b).agreementRatio, 1);
  // 交替分歧：same/X1/same/X2/…——每处分歧是独立的冲突块
  const c = Array.from({ length: 8 }, (_, i) => `same ${i % 2 ? "anchor" : i}\ndivergent ${i}`).join("\n");
  const anchor = Array.from({ length: 8 }, (_, i) => `same ${i % 2 ? "anchor" : i}\nline ${i}`).join("\n");
  const d = diffDeliverables(anchor, c);
  assert.equal(d.conflicts.length, 5, "conflict cap at 5");
  assert.ok(d.conflictCount >= 8, "8 divergent blocks total");
});

test("diffDeliverables: empty inputs -> agreement 1, no conflicts", () => {
  const d = diffDeliverables("", "");
  assert.equal(d.agreementRatio, 1);
  assert.equal(d.conflictCount, 0);
});

// 2026-08-21 升级链算子 #4：议会四字段机械提取
test("extractCouncilSynthesis: well-formed four fields", () => {
  const t = "共识：A与B都支持X；都反对Y\n分歧：A主张快、B主张稳\n建议：分阶段先快后稳\n少数意见：C认为应完全重做";
  const s = extractCouncilSynthesis(t);
  assert.ok(s);
  assert.equal(s.consensus, "A与B都支持X；都反对Y");
  assert.equal(s.disputes, "A主张快、B主张稳");
  assert.equal(s.recommendation, "分阶段先快后稳");
  assert.equal(s.minority, "C认为应完全重做");
});

test("extractCouncilSynthesis: markdown-bold labels tolerated", () => {
  const t = "**共识：** 升级链可行\n**分歧：** 轮数上限\n**建议：** 表驱动\n**少数意见：** 无";
  const s = extractCouncilSynthesis(t);
  assert.ok(s);
  assert.equal(s.consensus, "升级链可行");
});

test("extractCouncilSynthesis: garbage -> undefined (never fake a verdict)", () => {
  assert.equal(extractCouncilSynthesis("我觉得都挺好的"), undefined);
});
