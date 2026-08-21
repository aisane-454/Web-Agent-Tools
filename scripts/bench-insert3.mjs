// D) 合成 paste 事件（clipboardData 走 PM 粘贴管线） E) 分块 execCommand+yield
const { chromium } = await import("playwright");
const browser = await chromium.connectOverCDP("http://127.0.0.1:4319");
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => /chatgpt/.test(p.url()));
const SEL = "[data-testid='prompt-textarea']:not([data-writing-block-fullscreen-editor-region]), #prompt-textarea, form [contenteditable='true']:not([data-writing-block-fullscreen-editor-region])";
const composer = page.locator(SEL).filter({ visible: true }).last();
await composer.waitFor({ state: "visible", timeout: 10_000 });
const sample = Array.from({ length: 16 }, (_, i) =>
  `第${i + 1}行：生成一个处理边界条件的函数，输入为数字数组，输出为统计摘要，要求覆盖空数组与偶数长度场景。`
).join("\n");
const clear = () => page.evaluate((SEL) => {
  const el = [...document.querySelectorAll(SEL)].filter((e) => e.getBoundingClientRect().width > 0).at(-1);
  el?.focus(); document.execCommand("selectAll"); document.execCommand("delete");
}, SEL);
const readLen = async () => (await composer.textContent() ?? "").length;

// D) 合成 paste
await clear(); await page.waitForTimeout(200);
let t0 = Date.now();
const dR = await page.evaluate(({ SEL, text }) => {
  const el = [...document.querySelectorAll(SEL)].filter((e) => e.getBoundingClientRect().width > 0).at(-1);
  if (!el) return { ok: false };
  el.focus();
  const i0 = performance.now();
  const dt = new DataTransfer();
  dt.setData("text/plain", text);
  el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  return { ok: true, ms: performance.now() - i0 };
}, { SEL, text: sample });
console.log(`D) 合成 paste: 事件本体 ${dR.ms?.toFixed(0)}ms | 总 ${Date.now()-t0}ms | 插入 ${await readLen()} 字符`);
await clear(); await page.waitForTimeout(300);

// E) 分块 execCommand（8 块 × ~100 字符，块间 50ms）
t0 = Date.now();
const eR = await page.evaluate(async ({ SEL, text }) => {
  const el = [...document.querySelectorAll(SEL)].filter((e) => e.getBoundingClientRect().width > 0).at(-1);
  if (!el) return { ok: false };
  el.focus();
  const i0 = performance.now();
  const chunk = 100;
  for (let off = 0; off < text.length; off += chunk) {
    document.execCommand("insertText", false, text.slice(off, off + chunk));
    await new Promise((r) => setTimeout(r, 50));
  }
  return { ok: true, ms: performance.now() - i0 };
}, { SEL, text: sample });
console.log(`E) 分块插入: 本体 ${eR.ms?.toFixed(0)}ms | 总 ${Date.now()-t0}ms | 插入 ${await readLen()} 字符`);
await clear();
await browser.close();
