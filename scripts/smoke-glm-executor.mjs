import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] });
const client = new Client({ name: "smoke-glm-executor", version: "0" });
await client.connect(transport);
try {
  const t0 = Date.now();
  const r = await client.callTool({
    name: "web_delegate",
    arguments: {
      task_spec: `写一个 TypeScript 函数 renderTemplate(source: string, vars: Record<string,string>): string：把 source 中 {{name}} 形式的占位符替换为 vars 里的值，未提供的占位符替换为空字符串。写 4 个 node:test 单元测试，其中一个测试的输入必须是包含多行内容的字符串（用 \\n 转义写成单行字面量），覆盖占位符替换、未提供变量、连续占位符、空 source 四种情况。`,
      deliverable: { format: "code-block", language: "ts" },
      acceptance: "parse",
      override: "glm",
      timeout_ms: 240000
    }
  }, undefined, { timeout: 300_000, resetTimeoutOnProgress: true });
  const s = r.structuredContent ?? {};
  console.log(`耗时 ${((Date.now()-t0)/1000).toFixed(1)}s | isError: ${!!r.isError}`);
  console.log("structured:", JSON.stringify(s));
  if (r.isError) { console.log(r.content?.[0]?.text?.slice(0, 600)); process.exit(1); }
  writeFileSync("/tmp/glm-executor-out.mts", r.content[0].text);
  // .mts 让 node --check 按 ESM+TS 检查（node 26 支持）
  execFileSync(process.execPath, ["--check", "/tmp/glm-executor-out.mts"], { stdio: "inherit" });
  console.log("✅ glm 产物语法通过（含多行字符串测试）");
} finally { await client.close(); }
