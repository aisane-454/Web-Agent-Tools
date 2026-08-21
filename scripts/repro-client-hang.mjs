// 复现客户端挂死：服务端 post-send 错误应答 vs 客户端 callTool 是否 resolve
// 用短墙钟强制同样的错误路径（不等待 3 分钟）
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";

const timeoutMs = Number(process.argv[2] ?? 60_000);
const content = readFileSync("fixtures/review-chatgpt-vm-gate.txt", "utf8"); // 长内容保证生成超窗

const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] });
const client = new Client({ name: "repro-hang", version: "0" });
client.onclose = () => console.log("[client] onclose");
client.onerror = (e) => console.log("[client] onerror:", e?.message);
await client.connect(transport);

const t0 = Date.now();
const watchdog = new Promise((resolve) => setTimeout(() => resolve("HANG"), timeoutMs + 45_000));
const result = await Promise.race([
  client.callTool({ name: "web_review", arguments: { provider: "chatgpt", content, timeout_ms: timeoutMs } },
    undefined, { timeout: timeoutMs + 30_000, resetTimeoutOnProgress: true })
    .then((r) => ({ kind: "resolved", r })).catch((e) => ({ kind: "rejected", e })),
  watchdog.then(() => ({ kind: "HANG" }))
]);
const secs = ((Date.now() - t0) / 1000).toFixed(1);

if (result.kind === "HANG") {
  console.log(`❌ 复现：客户端 ${secs}s 仍未收到应答（墙钟 ${timeoutMs / 1000}s）`);
} else if (result.kind === "rejected") {
  console.log(`✅ 客户端 ${secs}s 收到错误（异常抛出）: ${String(result.e?.message ?? result.e).slice(0, 120)}`);
} else {
  const s = result.r.structuredContent ?? {};
  console.log(`✅ 客户端 ${secs}s 收到应答 isError=${!!result.r.isError} error=${s.error} (${s.answer_characters ?? 0} 字符)`);
}
process.exit(0); // 强制退出，不等任何挂起句柄
