// 真实场景 salvage：chatgpt 页面躺着一份审查调用超时后完成的长回答
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] });
const client = new Client({ name: "salvage-now", version: "0" });
await client.connect(transport);
try {
  const t0 = Date.now();
  const r = await client.callTool({ name: "web_ask", arguments: { salvage: true, provider: "chatgpt" } }, undefined, { timeout: 240_000 });
  const s = r.structuredContent ?? {};
  if (r.isError) { console.log("失败:", r.content?.[0]?.text?.slice(0, 300)); process.exit(1); }
  const text = r.content[0].text;
  const { writeFileSync } = await import("node:fs");
  writeFileSync("fixtures/review-chatgpt-acorn-live.txt", text);
  console.log(`✅ 耗时 ${((Date.now()-t0)/1000).toFixed(1)}s | 回收 ${text.length} 字符 | answer_count=${s.answer_count}`);
  console.log(`packet: verdict=${s.packet?.verdict} high=${JSON.stringify(s.packet?.high?.slice(0,2))} 中=${s.packet?.medium_count} 低=${s.packet?.low_count}`);
} finally { await client.close(); }
