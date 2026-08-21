// F) 原生粘贴管线：clipboard.writeText + 真实 Meta+V 键事件
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

// 授权剪贴板（CDP）
const session = await page.context().newCDPSession(page);
await session.send("Browser.grantPermissions", {
  permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"]
}).catch((e) => console.log("grant:", e.message.slice(0, 80)));

const prev = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
await clear(); await page.waitForTimeout(200);

let t0 = Date.now();
const writeOk = await page.evaluate((t) => navigator.clipboard.writeText(t).then(() => true).catch((e) => String(e.message).slice(0, 60)), sample);
const writeMs = Date.now() - t0;
await composer.focus();
t0 = Date.now();
await page.keyboard.press("Meta+V");
await page.waitForTimeout(120);
const pasteMs = Date.now() - t0;
const inserted = (await composer.textContent() ?? "").length;
console.log(`F) writeText ${writeMs}ms (${writeOk === true ? "ok" : writeOk}) + Meta+V ${pasteMs}ms → 插入 ${inserted} 字符`);

// 恢复原剪贴板
await page.evaluate((p) => { if (typeof p === "string") navigator.clipboard.writeText(p).catch(() => {}); }, prev);
await clear();
console.log("剪贴板已恢复, 输入框已清空");
await session.detach();
await browser.close();
