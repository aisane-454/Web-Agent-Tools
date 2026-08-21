// 分解实验：纯 JS 单 evaluate（focus+insertText 一次完成）vs Playwright 分步
const { chromium } = await import("playwright");
const browser = await chromium.connectOverCDP("http://127.0.0.1:4319");
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => /chatgpt/.test(p.url()));
const composer = page.locator(
  "[data-testid='prompt-textarea']:not([data-writing-block-fullscreen-editor-region]), #prompt-textarea, form [contenteditable='true']:not([data-writing-block-fullscreen-editor-region])"
).filter({ visible: true }).last();
await composer.waitFor({ state: "visible", timeout: 10_000 });

const sample = Array.from({ length: 16 }, (_, i) =>
  `第${i + 1}行：生成一个处理边界条件的函数，输入为数字数组，输出为统计摘要，要求覆盖空数组与偶数长度场景。`
).join("\n");

// C) 纯 JS：一次 evaluate 完成 focus+insertText
let t0 = Date.now();
const result = await page.evaluate((t) => {
  const sel = "[data-testid='prompt-textarea']:not([data-writing-block-fullscreen-editor-region]), #prompt-textarea, form [contenteditable='true']:not([data-writing-block-fullscreen-editor-region])";
  const el = [...document.querySelectorAll(sel)].filter((e) => {
    const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden";
  }).at(-1);
  if (!el) return { ok: false };
  el.focus();
  const t0inner = performance.now();
  document.execCommand("insertText", false, t);
  return { ok: true, execMs: performance.now() - t0inner };
}, sample);
const totalMs = Date.now() - t0;
console.log(`C) 纯 JS 单次 evaluate: 总 ${totalMs}ms，其中 execCommand 本体 ${result.execMs?.toFixed(0)}ms`);

// 清空（纯 JS）
t0 = Date.now();
await page.evaluate(() => {
  const sel = "[data-testid='prompt-textarea']:not([data-writing-block-fullscreen-editor-region]), form [contenteditable='true']:not([data-writing-block-fullscreen-editor-region])";
  const el = [...document.querySelectorAll(sel)].filter((e) => e.getBoundingClientRect().width > 0).at(-1);
  el?.focus();
  document.execCommand("selectAll");
  document.execCommand("delete");
});
console.log(`纯 JS 清空: ${Date.now() - t0}ms | 残留: ${(await composer.textContent() ?? "").trim().length}`);

// 再测一次 C 看方差
t0 = Date.now();
await page.evaluate((t) => {
  const sel = "[data-testid='prompt-textarea']:not([data-writing-block-fullscreen-editor-region]), form [contenteditable='true']:not([data-writing-block-fullscreen-editor-region])";
  const el = [...document.querySelectorAll(sel)].filter((e) => e.getBoundingClientRect().width > 0).at(-1);
  el?.focus();
  document.execCommand("insertText", false, t);
}, sample);
console.log(`C2) 纯 JS 第二次: ${Date.now() - t0}ms`);
await page.evaluate(() => {
  const sel = "[data-testid='prompt-textarea']:not([data-writing-block-fullscreen-editor-region]), form [contenteditable='true']:not([data-writing-block-fullscreen-editor-region])";
  const el = [...document.querySelectorAll(sel)].filter((e) => e.getBoundingClientRect().width > 0).at(-1);
  el?.focus(); document.execCommand("selectAll"); document.execCommand("delete");
});
await browser.close();
