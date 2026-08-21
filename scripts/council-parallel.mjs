// 三路并行设计会：一个连接并发三家，自动装配 packet
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, writeFileSync } from "node:fs";

const prompt = readFileSync("/tmp/council-question.txt", "utf8");
console.log(`议题 ${prompt.length} 字符，三路并行发送…`);
const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] });
const client = new Client({ name: "council-parallel", version: "0" });
await client.connect(transport);
const one = async (provider) => {
  const t0 = Date.now();
  try {
    const r = await client.callTool({ name: "web_ask", arguments: { provider, prompt, timeout_ms: 290000 } },
      undefined, { timeout: 310_000, onprogress: () => {} });
    if (r.isError) return { provider, secs: +((Date.now()-t0)/1000).toFixed(0), ok: false, text: r.content[0].text.slice(0, 120) };
    const text = r.content[0].text;
    writeFileSync(`/tmp/council-${provider}.txt`, text);
    return { provider, secs: +((Date.now()-t0)/1000).toFixed(0), ok: true, chars: text.length };
  } catch (e) {
    return { provider, secs: +((Date.now()-t0)/1000).toFixed(0), ok: false, text: String(e?.message ?? e).slice(0, 120) };
  }
};
const t0 = Date.now();
const rs = await Promise.all(["deepseek", "chatgpt", "glm"].map(one));
console.log(`并行墙钟 ${((Date.now()-t0)/1000).toFixed(0)}s`);
for (const r of rs) console.log(`${r.provider.padEnd(9)} ${r.secs}s ${r.ok ? `✅ ${r.chars} 字符 → /tmp/council-${r.provider}.txt` : `❌ ${r.text}`}`);
await client.close();
