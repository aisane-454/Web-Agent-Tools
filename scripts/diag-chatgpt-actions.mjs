// 找到复制按钮的真实位置：全文搜索，输出祖先链直到 turn 容器
const { chromium } = await import("playwright");
const browser = await chromium.connectOverCDP("http://127.0.0.1:4319");
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => /chatgpt/.test(p.url()));
const info = await page.evaluate(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
  };
  // 所有看起来像复制/动作栏的按钮
  const candidates = [...document.querySelectorAll("button")].filter((b) => {
    const t = (b.getAttribute("data-testid") ?? "") + (b.getAttribute("aria-label") ?? "") + (b.textContent ?? "");
    return /copy|复制/i.test(t);
  });
  const assistants = [...document.querySelectorAll("[data-message-author-role='assistant']")].filter(visible);
  const latest = assistants.at(-1);
  const turnOfLatest = latest?.closest("[data-testid^='conversation-turn']");
  return candidates.slice(0, 6).map((b) => {
    const chain = [];
    let n = b;
    for (let i = 0; i < 8 && n; i++) {
      chain.push(`${n.tagName}${n.getAttribute("data-testid") ? "#" + n.getAttribute("data-testid") : ""}${n.getAttribute("data-message-author-role") ? "@" + n.getAttribute("data-message-author-role") : ""}`);
      n = n.parentElement;
    }
    return {
      testid: b.getAttribute("data-testid"), aria: b.getAttribute("aria-label"),
      visible: visible(b), insideLatestAssistant: latest?.contains(b) ?? false,
      insideLatestTurn: turnOfLatest?.contains(b) ?? false,
      chain: chain.join(" < ")
    };
  });
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
