// 真实演练：vm 语法验收扩展 —— 全程记录外层消耗画像（R1 数据）
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync, readFileSync } from "node:fs";

const TASK_SPEC = `在现有模块中新增一个导出函数 runSyntaxCheck(code: string): { ok: true } | { ok: false; error: string }，用 node:vm 的 new vm.Script(code) 做纯语法检查（不执行代码）：
1. code 包含顶层 import 或 export 语句（用正则 /^\\s*(import|export)\\s/m 检测）时直接返回 { ok: true }——vm.Script 不支持 ESM，这类代码跳过语法检查（上游还有花括号平衡检查兜底）。
2. 其余情况 try { new vm.Script(code) } 成功返回 { ok: true }；捕获 SyntaxError 时返回 { ok: false, error: "syntax: " + e.message }。
3. 不引入新依赖，只用 node:vm。TypeScript，风格与现有代码一致（单行简洁、无多余注释）。`;

const CONTEXT = `现有文件中的调用方签名与风格参考：
export function runAcceptance(value: string, deliverable: DeliverableFormat, mode: AcceptanceMode): AcceptanceResult {
  if (mode === "none") return { passed: true };
  if (!value.trim()) return { passed: false, reason: "deliverable is empty" };
  // ... JSON 分支略 ...
  const unbalanced = braceImbalance(value);
  if (Math.abs(unbalanced) > 0) return { passed: false, reason: "unbalanced braces: ..." };
  return { passed: true };
}
runSyntaxCheck 将作为 runAcceptance 的 code-block 分支在花括号检查之后调用：失败时 return { passed: false, reason: errObj.error }。`;

writeFileSync("/tmp/drill-spec.txt", TASK_SPEC);
writeFileSync("/tmp/drill-context.txt", CONTEXT);
console.log(`task_spec: ${TASK_SPEC.length} 字符 | context: ${CONTEXT.length} 字符`);

const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] });
const client = new Client({ name: "drill-vm", version: "0" });
await client.connect(transport);
try {
  const t0 = Date.now();
  const r = await client.callTool({
    name: "web_delegate",
    arguments: {
      task_spec: TASK_SPEC,
      context: CONTEXT,
      deliverable: { format: "code-block", language: "ts" },
      acceptance: "parse"
    }
  }, undefined, { timeout: 300_000, resetTimeoutOnProgress: true });
  const s = r.structuredContent ?? {};
  console.log(`[生成] 耗时 ${((Date.now()-t0)/1000).toFixed(1)}s | provider=${s.provider} | acceptance=${s.acceptance}${s.repair ? " | repair=" + s.repair : ""}`);
  if (r.isError) { console.log(r.content?.[0]?.text?.slice(0, 500)); process.exit(1); }
  const code = r.content[0].text;
  writeFileSync("/tmp/drill-vm-generated.ts", code);
  console.log(`[生成] 产物 ${code.length} 字符 → /tmp/drill-vm-generated.ts`);
  console.log(`[画像] 外层本轮总消耗 ≈ ${(TASK_SPEC.length + CONTEXT.length + code.length)} 字符（任务书+上下文+产物）`);
} finally { await client.close(); }
