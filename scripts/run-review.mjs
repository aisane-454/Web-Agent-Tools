import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";

const provider = process.argv[2];
const focus = process.argv[3] || "正确性与健壮性";
const content = readFileSync("/tmp/review-prompt-content.txt", "utf8");

const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] });
const client = new Client({ name: "review", version: "0" });
await client.connect(transport);
try {
  const t0 = Date.now();
  const r = await client.callTool({ name: "web_review", arguments: { provider, content, focus } },
    undefined, { timeout: 300_000, resetTimeoutOnProgress: true });
  console.log(`\n########## ${provider} (${((Date.now()-t0)/1000).toFixed(1)}s) ##########`);
  console.log(r.isError ? "❌ " + r.content[0].text.slice(0, 200) : r.content[0].text);
} finally { await client.close(); }
