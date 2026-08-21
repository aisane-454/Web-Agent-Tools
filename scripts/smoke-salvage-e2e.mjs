// 闭环验证：真审查（300s 新期限）→ salvage 回收 → 比对一致
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] });
const client = new Client({ name: "smoke-salvage-e2e", version: "0" });
await client.connect(transport);
try {
  const code = `export function runSyntaxCheck(code, deliverable) {
  const lang = (deliverable?.format === "code-block" ? deliverable.language : "")?.trim().toLowerCase() ?? "";
  if (/^(ts|tsx|typescript|jsx)$/.test(lang)) return { status: "unsupported", reason: lang };
  try {
    acorn.parse(code, { ecmaVersion: "latest", sourceType: "module", allowAwaitOutsideFunction: true });
    return { status: "valid" };
  } catch (e) {
    if (e instanceof SyntaxError) return { status: "invalid", error: "syntax: " + e.message };
    throw e;
  }
}`;
  console.log("===== 1) 真实 web_review（chatgpt，默认 300s 期限） =====");
  const t0 = Date.now();
  const r = await client.callTool({
    name: "web_review",
    arguments: { provider: "chatgpt", content: code, focus: "边界与正确性" }
  }, undefined, { timeout: 320_000, resetTimeoutOnProgress: true });
  const s = r.structuredContent ?? {};
  console.log(`耗时 ${((Date.now()-t0)/1000).toFixed(1)}s | isError=${!!r.isError} | ${s.answer_characters ?? 0} 字符 | packet.verdict=${s.packet?.verdict}`);
  if (r.isError) { console.log(r.content?.[0]?.text?.slice(0, 300)); process.exit(1); }
  const reviewText = r.content[0].text;

  console.log("\n===== 2) salvage 回收同一页 =====");
  const t1 = Date.now();
  const b = await client.callTool({
    name: "web_ask", arguments: { salvage: true, provider: "chatgpt" }
  }, undefined, { timeout: 240_000, resetTimeoutOnProgress: true });
  const bs = b.structuredContent ?? {};
  if (b.isError) { console.log("salvage 失败:", b.content?.[0]?.text?.slice(0, 300)); process.exit(1); }
  const salvaged = b.content[0].text;
  console.log(`耗时 ${((Date.now()-t1)/1000).toFixed(1)}s | 回收 ${salvaged.length} 字符 | answer_count=${bs.answer_count} | packet.verdict=${bs.packet?.verdict ?? "(非结构化，不带 packet)"}`);

  const same = salvaged.slice(0, 200) === reviewText.slice(0, 200);
  console.log(`\n===== 3) 一致性: 头部 200 字符 ${same ? "✅ 一致" : "❌ 不一致"}（${salvaged.length} vs ${reviewText.length}） =====`);
} finally { await client.close(); }
