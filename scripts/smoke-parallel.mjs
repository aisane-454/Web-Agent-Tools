// 并行能力实测：一个 MCP 连接同时发三个不同 provider 的 ask，看墙钟 vs 各自耗时
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] });
const client = new Client({ name: "smoke-parallel", version: "0" });
await client.connect(transport);
const jobs = [
  ["deepseek", "只回答数字 71，不要其他内容。"],
  ["glm", "只回答数字 72，不要其他内容。"],
  ["chatgpt", "只回答数字 73，不要其他内容。"]
];
const runOne = async ([provider, prompt]) => {
  const t0 = Date.now();
  try {
    const r = await client.callTool({ name: "web_ask", arguments: { provider, prompt } },
      undefined, { timeout: 300_000, onprogress: () => {} });
    return { provider, secs: +((Date.now() - t0) / 1000).toFixed(1), ok: !r.isError, head: (r.content?.[0]?.text ?? "").slice(0, 20) };
  } catch (e) {
    return { provider, secs: +((Date.now() - t0) / 1000).toFixed(1), ok: false, head: String(e?.message ?? e).slice(0, 40) };
  }
};
const t0 = Date.now();
const results = await Promise.all(jobs.map(runOne));
const wall = ((Date.now() - t0) / 1000).toFixed(1);
const sum = results.reduce((a, r) => a + r.secs, 0).toFixed(1);
for (const r of results) console.log(`${r.provider.padEnd(9)} ${String(r.secs).padStart(6)}s  ${r.ok ? "✅" : "❌"} ${JSON.stringify(r.head)}`);
console.log(`\n并行墙钟 ${wall}s vs 串行合计 ${sum}s → 加速 ${sum / wall}x`);
await client.close();
