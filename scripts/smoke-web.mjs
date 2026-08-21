import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const provider = process.argv[2] || "deepseek";
const prompt = process.argv[3] || "请只回复两个字:pong";

const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] });
const client = new Client({ name: "smoke-web", version: "0.0.0" });
await client.connect(transport);

try {
  const started = Date.now();
  const result = await client.callTool({ name: "web_ask", arguments: { provider, prompt } }, undefined, {
    timeout: 300_000,
    resetTimeoutOnProgress: true
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.isError) {
    console.log(`[${provider}] ❌ (${seconds}s):`, result.content[0].text);
    process.exitCode = 1;
  } else {
    console.log(`[${provider}] ✅ (${seconds}s) structured:`, JSON.stringify(result.structuredContent));
    console.log(`answer: ${result.content[0].text.slice(0, 200)}`);
    console.log("SMOKE:WEB:OK");
  }
} finally {
  await client.close();
}
