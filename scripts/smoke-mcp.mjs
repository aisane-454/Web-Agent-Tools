import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] });
const client = new Client({ name: "smoke-mcp", version: "0.0.0" });
await client.connect(transport);

try {
  const tools = await client.listTools();
  console.log("registered tools:", tools.tools.map((tool) => tool.name).join(", "));

  const status = await client.callTool({ name: "web_status", arguments: {} });
  const payload = JSON.parse(status.content[0].text);
  console.log("cdp:", payload.cdp_url);
  for (const provider of payload.providers) {
    console.log(`  ${provider.provider}: healthy=${provider.healthy}` +
      (provider.healthy ? ` input_ready=${provider.input_ready} generating=${provider.generating} url=${String(provider.url).slice(0, 50)}` : ` error=${provider.error}`));
  }
  console.log("SMOKE:MCP:OK");
} finally {
  await client.close();
}
