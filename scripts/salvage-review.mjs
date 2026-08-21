// 补救模式：提示词已发送+等待超时+页面已完成 → 只读提取，绝不重发
const { chromium } = await import("playwright");
const browser = await chromium.connectOverCDP("http://127.0.0.1:4319");
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => /chatgpt/.test(p.url()));
const text = await page.evaluate(() => {
  const turns = [...document.querySelectorAll("[data-message-author-role='assistant']")];
  return turns[turns.length - 1]?.textContent ?? "";
});
const { writeFileSync } = await import("node:fs");
writeFileSync("/tmp/salvaged-review.txt", text);
console.log(`提取 ${text.length} 字符 → /tmp/salvaged-review.txt`);
console.log("==== 审查结论全文 ====");
console.log(text);
await browser.close();
