import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";

const provider = process.argv[2];
const prompt = readFileSync("/tmp/design-question.txt", "utf8");
const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] });
const client = new Client({ name: "council", version: "0" });
await client.connect(transport);
try {
  const t0 = Date.now();
  const r = await client.callTool({ name: "web_ask", arguments: { provider, prompt, timeout_ms: 300000 } },
    undefined, { timeout: 330_000, resetTimeoutOnProgress: true });
  console.log(`\n${"=".repeat(20)} ${provider} (${((Date.now()-t0)/1000).toFixed(0)}s) ${"=".repeat(20)}`);
  console.log(r.isError ? "[失败] " + r.content[0].text.slice(0, 150) : r.content[0].text);
} finally { await client.close(); }
