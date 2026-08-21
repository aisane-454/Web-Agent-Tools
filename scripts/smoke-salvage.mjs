// salvage 两级验证：A) 参数校验零触页 B) 真实回收 chatgpt 页面的超时审查
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync } from "node:fs";

const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] });
const client = new Client({ name: "smoke-salvage", version: "0" });
await client.connect(transport);
const call = (args) => client.callTool({ name: "web_ask", arguments: args }, undefined, { timeout: 240_000, resetTimeoutOnProgress: true });

console.log("===== A) 协议级校验（不触页） =====");
const a1 = await call({ salvage: true }); // 无 provider
console.log("salvage 无 provider →", a1.structuredContent?.error, "✓" );
const a2 = await call({}); // 无 prompt 非 salvage
console.log("无 prompt 非 salvage →", a2.structuredContent?.error, "✓");

console.log("\n===== B) 真实 salvage chatgpt（页面遗留的超时审查答案） =====");
const t0 = Date.now();
const b = await call({ salvage: true, provider: "chatgpt" });
const s = b.structuredContent ?? {};
if (b.isError) {
  console.log("salvage 失败:", b.content?.[0]?.text?.slice(0, 300));
} else {
  const text = b.content[0].text;
  writeFileSync("/tmp/salvage-live.txt", text);
  console.log(`耗时 ${((Date.now()-t0)/1000).toFixed(1)}s | 回收 ${text.length} 字符 | answer_count=${s.answer_count}`);
  console.log(`packet: verdict=${s.packet?.verdict} high=${s.packet?.high?.length} 中=${s.packet?.medium_count} 低=${s.packet?.low_count}`);
  console.log("头部 100 字符:", JSON.stringify(text.slice(0, 100)));
}
await client.close();
