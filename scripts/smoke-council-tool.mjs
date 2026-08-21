import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] });
const client = new Client({ name: "council-tool", version: "0" });
await client.connect(transport);
try {
  const t0 = Date.now();
  const r = await client.callTool({
    name: "web_council",
    arguments: {
      question: "个人开发者 2026 年要把一个日均千人访问的 Web 小产品从单体架构迁出，该选 serverless 还是小型 VPS 集群？请就成本、运维负担、故障恢复三点给出判断。",
      timeout_ms: 240000
    }
  }, undefined, { timeout: 560_000, onprogress: () => {} });
  const s = r.structuredContent ?? {};
  console.log(`总耗时 ${((Date.now()-t0)/1000).toFixed(1)}s | isError=${!!r.isError}`);
  for (const m of s.members ?? []) console.log(`  ${m.provider.padEnd(9)} ${m.ok ? "✅ " + m.characters + " 字符" : "❌ " + (m.error ?? "").slice(0, 60)}`);
  if (s.synthesis) {
    console.log("\n──── 四字段决议 ────");
    console.log("共识：", s.synthesis.consensus);
    console.log("分歧：", s.synthesis.disputes);
    console.log("建议：", s.synthesis.recommendation);
    console.log("少数意见：", s.synthesis.minority);
  } else if (s.message) console.log("汇总席:", s.message);
} finally { await client.close(); }
