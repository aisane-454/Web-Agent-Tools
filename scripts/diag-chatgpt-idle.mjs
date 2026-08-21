// 用生产判定式逐项检查当前 chatgpt 页面的 idle 条件
const { chromium } = await import("playwright");
const browser = await chromium.connectOverCDP("http://127.0.0.1:4319");
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => /chatgpt/.test(p.url()));
const STOP = "button[aria-label*='Stop'], button[aria-label*='停止'], [data-testid*='stop'], button[aria-busy='true'], [role='button'][aria-busy='true']";
const ASSISTANT = "[data-testid^='conversation-turn-'][data-turn='assistant'], [data-message-author-role='assistant']";
const ACTION = "button[data-testid='copy-turn-action-button'], button[aria-label*='Copy'], button[aria-label*='复制']";
const state = await page.evaluate(({ STOP, ASSISTANT, ACTION }) => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
  };
  // 1) activeStop：谁在匹配 stop 选择器
  const stopMatches = [...document.querySelectorAll(STOP)].map((el) => ({
    tag: el.tagName, testid: el.getAttribute("data-testid"), aria: el.getAttribute("aria-label"),
    busy: el.getAttribute("aria-busy"), visible: visible(el),
    html: el.outerHTML.slice(0, 80)
  }));
  // 2) 最新 assistant 节点与其内部动作按钮
  const assistants = [...document.querySelectorAll(ASSISTANT)].filter(visible);
  const latest = assistants.at(-1);
  const actionBtns = latest ? [...latest.querySelectorAll("button")].map((b) => ({
    testid: b.getAttribute("data-testid"), aria: b.getAttribute("aria-label"),
    visible: visible(b), opacity: getComputedStyle(b).opacity
  })) : [];
  const actionMatch = latest ? [...latest.querySelectorAll(ACTION)] : [];
  return {
    assistantCount: assistants.length,
    latestIsAnswer: latest?.textContent?.slice(0, 40),
    activeStopVisible: stopMatches.some((m) => m.visible && (!m.busy || m.tag === "BUTTON")),
    stopMatches: stopMatches.slice(0, 5),
    actionButtonCount: actionBtns.length,
    actionButtons: actionBtns.slice(0, 10),
    actionMatchCount: actionMatch.length,
    actionMatchVisible: actionMatch.some(visible)
  };
}, { STOP, ASSISTANT, ACTION });
console.log(JSON.stringify(state, null, 2));
await browser.close();
