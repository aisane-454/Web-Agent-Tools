// 升级链算子 #2 实弹演示：任务故意留边界缺口，审查应捕获、修订应补齐
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync } from "node:fs";

const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] });
const client = new Client({ name: "review-round", version: "0" });
await client.connect(transport);
try {
  const t0 = Date.now();
  const r = await client.callTool({
    name: "web_delegate",
    arguments: {
      task_spec: "写一个 TypeScript 函数 median(nums: number[]): number 返回中位数。附带 node:test 测试。",
      deliverable: { format: "code-block", language: "ts" },
      acceptance: "parse",
      review_rounds: 1,
      timeout_ms: 240000
    }
  }, undefined, { timeout: 580_000, onprogress: () => {} });
  const s = r.structuredContent ?? {};
  console.log(`总耗时 ${((Date.now()-t0)/1000).toFixed(1)}s | isError=${!!r.isError}`);
  console.log("structured:", JSON.stringify(s));
  if (r.isError) { console.log(r.content?.[0]?.text?.slice(0, 300)); process.exit(1); }
  const code = r.content[0].text;
  writeFileSync("/tmp/review-round-final.mts", code);
  console.log(`终稿 ${code.length} 字符 → /tmp/review-round-final.mts`);
  console.log("空数组处理:", /length\s*===?\s*0|\.length\s*<\s*1|throw|throwError|assert\.throws/i.test(code) ? "✅ 有" : "❌ 无");
  console.log("偶数平均:", /sort\(/.test(code) && code.includes("/ 2") ? "✅ 有" : "❌ 无");
} finally { await client.close(); }
