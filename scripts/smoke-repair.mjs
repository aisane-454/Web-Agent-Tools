// Repair-floor E2E: worst-case corrupted answer (idx-12, mixed-delimiter quotes —
// mechanically unfixable) through the REAL production pieces:
// buildRepairPrompt → real deepseek send (via MCP web_ask) → parseDeliverable →
// runAcceptance → node --check.
//   node scripts/smoke-repair.mjs [fixture=path] [provider=deepseek]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildRepairPrompt, parseDeliverable, runAcceptance } from "../dist/delegate.js";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split("=")));
const fixture = args.fixture ?? "fixtures/history/idx-12.txt";
const provider = args.provider ?? "deepseek";

const raw = readFileSync(fixture, "utf8");
const deliverable = { format: "code-block" };

// 0) default extractor baseline — must FAIL acceptance so the repair floor is justified
const pre = parseDeliverable(raw, deliverable);
const preAcc = pre.ok ? runAcceptance(pre.value, deliverable, "parse") : { passed: false, reason: pre.reason };
console.log(`默认提取器: parse=${pre.ok} acceptance=${preAcc.passed ? "passed" : "FAILED: " + preAcc.reason}`);

const prompt = buildRepairPrompt(raw, deliverable, preAcc.reason ?? "unspecified");
console.log(`修复任务书: ${prompt.length} 字符`);

const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] });
const client = new Client({ name: "smoke-repair", version: "0" });
await client.connect(transport);
try {
  const t0 = Date.now();
  const r = await client.callTool({
    name: "web_ask",
    arguments: { provider, prompt }
  }, undefined, { timeout: 300_000, resetTimeoutOnProgress: true });
  const answer = r.content?.[0]?.text ?? "";
  console.log(`web_ask(${provider}) 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s | isError=${!!r.isError}`);
  if (r.isError) { console.log(answer.slice(0, 500)); process.exit(1); }

  const parsed = parseDeliverable(answer, deliverable);
  if (!parsed.ok) { console.log("❌ 修复产物解析失败:", parsed.reason); process.exit(1); }
  const acc = runAcceptance(parsed.value, deliverable, "parse");
  console.log(`修复产物: ${parsed.value.length} 字符 | acceptance=${acc.passed ? "passed" : "FAILED: " + acc.reason}`);
  const out = "/tmp/repair-floor-output.mjs";
  writeFileSync(out, parsed.value);
  execFileSync(process.execPath, ["--check", out], { stdio: "inherit" });
  console.log(`✅ node --check 通过 — 修复兜底在真实最坏样本上成立 (${out})`);
} finally { await client.close(); }
