// 演练第二步：审查委派 chatgpt（reviewer 链），记录画像
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";

const code = readFileSync("/tmp/drill-vm-generated.ts", "utf8");
const integration = `// 外层集成（ Amendments，非生成产物）：
// 1. runAcceptance 的 code-block 分支在花括号平衡检查后调用 runSyntaxCheck(value, deliverable)，
//    失败时 return { passed: false, reason: syntax.error }。
// 2. TS 产物跳过 vm（vm.Script 不认类型标注），正则 /^(ts|tsx|typescript)/i 匹配 deliverable.language。
// 3. 顶层 await 豁免：SyntaxError 消息匹配 /await is only valid/i 时返回 ok（vm.Script 不支持顶层 await，属模块代码）。
// 4. import vm from "node:vm" 置于模块顶部。`;

const content = code + "\n\n" + integration;

const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] });
const client = new Client({ name: "drill-vm-review", version: "0" });
await client.connect(transport);
try {
  const t0 = Date.now();
  const r = await client.callTool({
    name: "web_review",
    arguments: {
      content,
      focus: "正确性与边界：vm.Script 语法门的误报/漏报风险（TS 跳过正则、ESM 跳过、顶层 await 豁免、非 SyntaxError 重抛），以及作为验收门的失败模式是否安全（fail-loud、不吞错误）。"
    }
  }, undefined, { timeout: 300_000, resetTimeoutOnProgress: true });
  const s = r.structuredContent ?? {};
  console.log(`[审查] 耗时 ${((Date.now()-t0)/1000).toFixed(1)}s | provider=${s.provider}`);
  console.log(`[画像] 审查输入 ${content.length} 字符 → 输出 ${r.content?.[0]?.text?.length ?? 0} 字符`);
  console.log("---- 审查结论 ----");
  console.log(r.content?.[0]?.text);
} finally { await client.close(); }
