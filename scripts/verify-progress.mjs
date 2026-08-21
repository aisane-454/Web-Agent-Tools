// 双向验证 makeNotifier：A) 无 onProgress → 零 onerror  B) 有 onProgress → 收到阶段通知
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function run(withProgress) {
  const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] });
  const client = new Client({ name: "verify-progress", version: "0" });
  const errors = [];
  const stages = [];
  client.onerror = (e) => errors.push(String(e?.message ?? e).slice(0, 80));
  await client.connect(transport);
  const opts = { timeout: 120_000, resetTimeoutOnProgress: true };
  if (withProgress) opts.onprogress = (p) => stages.push(String(p.message ?? ""));
  const r = await client.callTool({
    name: "web_ask",
    arguments: { provider: "deepseek", prompt: "只回答数字 3，不要任何其他内容。" }
  }, undefined, opts);
  await client.close();
  return { isError: !!r.isError, text: r.content?.[0]?.text?.slice(0, 40), errors, stages };
}

const a = await run(false);
console.log(`A) 无 onProgress: isError=${a.isError} 回答=${JSON.stringify(a.text)} 协议错误=${a.errors.length} 条 ${a.errors.length ? "❌ " + a.errors[0] : "✅ 零错误"}`);
const b = await run(true);
console.log(`B) 有 onProgress: isError=${b.isError} 回答=${JSON.stringify(b.text)} 协议错误=${b.errors.length} 条`);
console.log(`   收到阶段通知: ${b.stages.join(" → ") || "(无)"} ${b.stages.length ? "✅ token 回传正确" : "❌ 未收到"}`);
