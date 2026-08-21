// Read-only replay: re-extract every historical GLM answer and run each through
// the current parseDeliverable pipeline.
//   node scripts/replay-glm-history.mjs           # live CDP read-only extraction (+ --save to fixtures/history)
//   node scripts/replay-glm-history.mjs --offline # replay saved fixtures, no browser
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";

const { parseDeliverable } = await import("../dist/delegate.js");

const offline = process.argv.includes("--offline");
let texts = [];
if (offline) {
  texts = readdirSync("fixtures/history").filter((f) => /^idx-\d+\.txt$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
    .map((f) => readFileSync(`fixtures/history/${f}`, "utf8"));
  console.log(`离线重放 fixtures/history/，共 ${texts.length} 条`);
} else {
  const { chromium } = await import("playwright");
  const browser = await chromium.connectOverCDP("http://127.0.0.1:4319");
  const page = browser.contexts().flatMap((c) => c.pages()).find((p) => /chatglm|bigmodel/.test(p.url()));
  if (!page) { console.error("未找到 GLM 标签页"); process.exit(1); }
  console.log("GLM 页面:", page.url().slice(0, 60));
  texts = await page.evaluate(async () => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const answers = [...document.querySelectorAll(".answer .answer-content-wrap:not(.text-advance-thinking-content)")].filter(visible);
    const scroller = document.querySelector(".chatScrollContainer") ?? document.scrollingElement;
    if (scroller instanceof HTMLElement) {
      let lastHeight = -1;
      for (let i = 0; i < 80 && scroller.scrollHeight !== lastHeight; i++) {
        lastHeight = scroller.scrollHeight;
        scroller.scrollTo({ top: scroller.scrollHeight });
        await new Promise((r) => setTimeout(r, 120));
      }
    }
    const collect = (answer) => {
      answer.scrollIntoView({ block: "center" });
      const content = answer.querySelector(".answer-content-wrap") ?? answer;
      const parts = [];
      const walk = (node) => {
        if (node instanceof HTMLElement && node.tagName === "PRE") {
          const langClass = [...node.classList].find((n) => n.startsWith("language-"));
          const lang = langClass ? langClass.replace("language-", "") : "";
          parts.push("```" + lang + "\n" + (node.textContent ?? "") + "\n```");
          return;
        }
        if (node instanceof HTMLElement && node.tagName === "P") {
          const text = node.innerText?.trim();
          if (text) parts.push(text);
          return;
        }
        for (const child of node.childNodes) walk(child);
      };
      walk(content);
      return parts.join("\n\n").trim();
    };
    const out = [];
    for (const a of answers) {
      out.push(collect(a));
      await new Promise((r) => setTimeout(r, 120));
    }
    return out;
  });
  if (process.argv.includes("--save")) {
    mkdirSync("fixtures/history", { recursive: true });
    texts.forEach((t, i) => writeFileSync(`fixtures/history/idx-${i}.txt`, t));
  }
  await browser.close();
}

const langOf = (raw) => {
  const chip = raw.match(/^\s*(ts|tsx|typescript|js|javascript|mjs)\s*\n/);
  const fence = raw.match(/```(ts|tsx|typescript)\b/);
  return chip?.[1] ?? fence?.[1] ?? "js";
};

console.log(`\n逐条过新管线：\n`);
let repairedCount = 0, passCount = 0, codeCount = 0;
for (let i = 0; i < texts.length; i++) {
  const raw = texts[i];
  if (!raw) { console.log(`idx ${String(i).padStart(2)}: <空>`); continue; }
  if (!raw.includes("```")) {
    console.log(`idx ${String(i).padStart(2)}: 无代码块 (${raw.length} 字符，纯文本)`);
    continue;
  }
  codeCount++;
  const lang = langOf(raw);
  const isTs = /^ts/.test(lang);
  const r = parseDeliverable(raw, { format: "code-block" });
  if (!r.ok) { console.log(`idx ${String(i).padStart(2)}: ❌ 解析失败: ${r.reason}`); continue; }
  if (r.value.endsWith("```")) { console.log(`idx ${String(i).padStart(2)}: ❌ 尾部残留 fence`); continue; }
  const f = `/tmp/history-idx-${i}.${isTs ? "ts" : "mjs"}`;
  writeFileSync(f, r.value);
  let ok = true, err = "";
  try {
    if (isTs) {
      // 只统计语法级错误（TS1xxx）；模块解析等语义错误不代表提取损坏
      const out = execFileSync("npx", ["tsc", "--noEmit", "--skipLibCheck", "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler", f], { stdio: "pipe", encoding: "utf8" }).toString();
    } else {
      execFileSync("node", ["--check", f], { stdio: "pipe" });
    }
  } catch (e) {
    const stderr = e.stderr?.toString() ?? "";
    if (isTs) {
      const syntaxErr = stderr.split("\n").filter((l) => /error TS1\d{3}/.test(l));
      if (syntaxErr.length) { ok = false; err = syntaxErr[0].slice(0, 70); }
    } else { ok = false; err = stderr.split("\n")[4]?.trim().slice(0, 60) ?? "syntax error"; }
  }
  const hadBareBreaks = /"[^"\n]*\n/.test(raw);
  if (ok) { passCount++; if (hadBareBreaks) repairedCount++; }
  console.log(`idx ${String(i).padStart(2)}: ${ok ? "✅ 语法通过" : `❌ ${err}`} [${lang}] (${r.value.length} 字符${hadBareBreaks ? ", 含断行损坏已还原" : ""})`);
}
console.log(`\n汇总: ${passCount}/${codeCount} 个代码块产物语法通过${repairedCount ? `，其中 ${repairedCount} 个经断行修复还原` : ""}`);
