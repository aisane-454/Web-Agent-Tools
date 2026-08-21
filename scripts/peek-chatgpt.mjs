const { chromium } = await import("playwright");
const browser = await chromium.connectOverCDP("http://127.0.0.1:4319");
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => /chatgpt/.test(p.url()));
if (!page) { console.log("未找到 chatgpt 标签页"); process.exit(0); }
const state = await page.evaluate(() => {
  const composer = document.querySelector("[data-testid='prompt-textarea'], #prompt-textarea, form [contenteditable='true']");
  const composerText = composer ? (composer.value ?? composer.textContent ?? "").trim() : "";
  const turns = [...document.querySelectorAll("[data-message-author-role='assistant']")];
  const last = turns[turns.length - 1];
  const stopBtn = [...document.querySelectorAll("button")].some((b) => /stop/i.test(b.getAttribute("aria-label") ?? ""));
  const alerts = [...document.querySelectorAll("[role='alert'], [class*='toast']")]
    .map((e) => e.textContent?.trim()).filter((t) => t && t.length > 0 && t.length < 200);
  return {
    composerChars: composerText.length,
    composerHead: composerText.slice(0, 60),
    assistantTurns: turns.length,
    lastAnswerHead: last ? (last.textContent ?? "").slice(0, 120) : "(无)",
    generating: stopBtn,
    alerts: alerts.slice(0, 3)
  };
});
console.log(JSON.stringify(state, null, 2));
await browser.close();
