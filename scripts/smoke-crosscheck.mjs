import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] });
const client = new Client({ name: "crosscheck", version: "0" });
await client.connect(transport);
try {
  const t0 = Date.now();
  const r = await client.callTool({
    name: "web_delegate",
    arguments: {
      task_spec: "写一个 TypeScript 纯函数 levenshtein(a: string, b: string): number 计算编辑距离（经典 DP，O(n*m)），附 3 个 node:test 断言：空串相等、单字符替换、示例 'kitten'→'sitting' 为 3。",
      deliverable: { format: "code-block", language: "ts" },
      acceptance: "parse",
      cross_check: true,
      timeout_ms: 240000
    }
  }, undefined, { timeout: 560_000, onprogress: () => {} });
  const s = r.structuredContent ?? {};
  console.log(`总耗时 ${((Date.now()-t0)/1000).toFixed(1)}s | isError=${!!r.isError} | provider=${s.provider}`);
  if (r.isError) { console.log(r.content?.[0]?.text?.slice(0, 300)); process.exit(1); }
  console.log(`主产物 ${r.content[0].text.length} 字符`);
  const cc = s.cross_check;
  if (!cc) { console.log("无交叉报告（?）"); process.exit(1); }
  if (cc.secondary_error) console.log(`副生成降级: ${cc.secondary_provider} — ${cc.secondary_error}`);
  else {
    console.log(`交叉验证: 副生成 ${cc.secondary_provider} | 一致率 ${(cc.agreement_ratio * 100).toFixed(0)}% | 冲突块 ${cc.conflict_count}`);
    for (const c of cc.conflicts.slice(0, 3)) {
      console.log(`  L${c.line}: 主=${JSON.stringify(c.primary.slice(0, 60))} 副=${JSON.stringify(c.secondary.slice(0, 60))}`);
    }
  }
} finally { await client.close(); }
