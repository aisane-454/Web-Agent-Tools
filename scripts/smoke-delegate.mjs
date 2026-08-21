import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] });
const client = new Client({ name: "smoke-delegate", version: "0" });
await client.connect(transport);
try {
  const tools = await client.listTools();
  console.log("tools:", tools.tools.map((t) => t.name).join(", "));
  const t0 = Date.now();
  const r = await client.callTool({
    name: "web_delegate",
    arguments: {
      task_spec: "写一个 TypeScript 函数 slugify(title: string): string：把标题转成 URL slug。规则：转小写；中文字符保留；空白和连续特殊字符折叠为单个连字符；去掉首尾连字符。附带 2 行注释说明折叠规则。",
      deliverable: { format: "code-block", language: "ts" },
      acceptance: "parse"
    }
  }, undefined, { timeout: 300_000, resetTimeoutOnProgress: true });
  console.log(`耗时 ${((Date.now()-t0)/1000).toFixed(1)}s | isError: ${!!r.isError}`);
  console.log("structured:", JSON.stringify(r.structuredContent));
  console.log("---- 产物 ----");
  console.log(r.content[0].text);
} finally { await client.close(); }
