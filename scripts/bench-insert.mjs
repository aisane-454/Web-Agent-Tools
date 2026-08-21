// 零发送基准：chatgpt 输入框插入 1KB，fill vs execCommand，测完清空
const { chromium } = await import("playwright");
const browser = await chromium.connectOverCDP("http://127.0.0.1:4319");
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => /chatgpt/.test(p.url()));
const composer = page.locator(
  "[data-testid='prompt-textarea']:not([data-writing-block-fullscreen-editor-region]), #prompt-textarea, form [contenteditable='true']:not([data-writing-block-fullscreen-editor-region])"
).filter({ visible: true }).last();
await composer.waitFor({ state: "visible", timeout: 10_000 });

const sample = Array.from({ length: 16 }, (_, i) =>
  `第${i + 1}行：生成一个处理边界条件的函数，输入为数字数组，输出为统计摘要，要求覆盖空数组与偶数长度场景。`
).join("\n"); // ≈1.1KB
console.log(`样本 ${sample.length} 字符`);

// A) playwright fill
let t0 = Date.now();
await composer.fill(sample);
const fillMs = Date.now() - t0;
const afterFill = (await composer.textContent() ?? "").length;

t0 = Date.now();
await composer.fill("");
const clear1 = Date.now() - t0;
await page.waitForTimeout(300);

// B) focus + execCommand insertText
t0 = Date.now();
await composer.focus();
await page.evaluate((t) => { document.execCommand("insertText", false, t); }, sample);
const execMs = Date.now() - t0;
const afterExec = (await composer.textContent() ?? "").length;

t0 = Date.now();
await composer.fill("");
const clear2 = Date.now() - t0;
const leftover = (await composer.textContent() ?? "").trim().length;

console.log(`A) fill:          ${fillMs}ms  插入后 ${afterFill} 字符`);
console.log(`B) focus+execCmd: ${execMs}ms  插入后 ${afterExec} 字符`);
console.log(`清空耗时 ${clear1}ms / ${clear2}ms，输入框残留: ${leftover}`);
await browser.close();
