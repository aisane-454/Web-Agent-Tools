// 粘贴快速路径生产验证：1KB 提示词真发 chatgpt，事后看 insert 阶段耗时
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const big = Array.from({ length: 14 }, (_, i) =>
  `要求${i + 1}：分析第${i + 1}个模块的边界条件处理，列出输入域、异常路径与修复建议，格式为三列表格。`
).join("\n") + "\n\n请把以上 14 条要求汇总成一段执行摘要（100 字内）。";
console.log(`提示词 ${big.length} 字符`);
const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] });
const client = new Client({ name: "paste-live", version: "0" });
await client.connect(transport);
try {
  const t0 = Date.now();
  const r = await client.callTool({ name: "web_ask", arguments: { provider: "chatgpt", prompt: big } },
    undefined, { timeout: 300_000, onprogress: () => {} });
  console.log(`总耗时 ${((Date.now()-t0)/1000).toFixed(1)}s | isError=${!!r.isError} | 回答 ${(r.content?.[0]?.text ?? "").length} 字符`);
  if (r.isError) console.log(r.content?.[0]?.text?.slice(0, 200));
} finally { await client.close(); }
