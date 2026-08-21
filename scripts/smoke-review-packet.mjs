// R1 packet 端到端：packet_only=true 时外层只收到决策包
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";

const content = readFileSync("fixtures/review-chatgpt-vm-gate.txt", "utf8").slice(0, 4000);
const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] });
const client = new Client({ name: "smoke-packet", version: "0" });
await client.connect(transport);
try {
  const t0 = Date.now();
  const r = await client.callTool({
    name: "web_review",
    arguments: { provider: "deepseek", content, packet_only: true, focus: "packet 装配链路验证", timeout_ms: 240000 }
  }, undefined, { timeout: 300_000, resetTimeoutOnProgress: true });
  const s = r.structuredContent ?? {};
  const text = r.content?.[0]?.text ?? "";
  console.log(`耗时 ${((Date.now()-t0)/1000).toFixed(1)}s | isError=${!!r.isError}`);
  console.log(`外层收到文本: ${text.length} 字符（原文 ${s.answer_characters} 字符，压缩 ${(100 - text.length / s.answer_characters * 100).toFixed(0)}%）`);
  console.log("packet:", JSON.stringify(s.packet));
  console.log("---- packet 文本 ----");
  console.log(text);
} finally { await client.close(); }
