# 2026-08-21 chatgpt DOM 漂移：推翻"chatgpt 慢"的误诊

## 用户的关键观察（ falsify ）
"chatgpt 一下就好了，我并没有看到失败和所谓的超时" —— 页面秒回，管线却 177.6s
超时。由此定位：**答案早就在页面上，是完成检测瞎了**，watcher 烧满墙钟。

## 根因（DOM 实证）
ChatGPT 把动作栏（复制等按钮）移出了 `[data-message-author-role='assistant']`
节点，现在住在 turn 容器 `SECTION#conversation-turn-N` 内、消息节点之外。
两处选择器建立在旧结构上：
1. 完成判定 `requiresCompletionAction` 在消息节点内找按钮 → 永远 false →
   永不判定完成 → 烧满墙钟 → SEND_IDEMPOTENCY_UNKNOWN。
2. 复制选择器同样限定消息节点内 → 永不命中 → 静默走 DOM 兜底
   （readLatestChatGptAnswerText，空白折叠版，对代码有损）。

回溯性解释了全部"chatgpt 慢"事件：drill 180s、E2E 183s、并行 177.6s——
同一根因。chatgpt 真实延迟：trivial ask 全链路 ~15s（答案本身 ~5s）。

## 连环修复（三处）
1. 完成判定作用域上升到 `closest('[data-testid^=conversation-turn]')`。
2. 复制选择器脱离消息节点限定（turn 容器内找，.last() 取最新）。
3. click 双层：悬停浮现动作栏过不了 Playwright 可操作性 → 普通点击 3s 超时
   后降级 DOM 级 click（页面自己的处理器照常触发，剪贴板截获不变）。

## 用户第二观察（体验）："不应该先拖动再处理"
回答结束时视口就在底部、按钮就在眼前。Playwright click 自动滚对位 + 超时
重试造成可见的页面拖动——不合理。修复：**视口门控**——按钮已在视口内才点
（无滚动路径）；不在视口直接走 DOM 文本，绝不为提取拖用户的页面。

## 验证
修复前 177.6s 超时 → 修复后 14.6-14.7s 完整走通（两次实测）。
三路并行：deepseek 15.6s ✅ / chatgpt 26s ✅ / glm 20.9s ❌（晚高峰排队，
重提两次耗尽 fail-loud——正确的页面状态响应，非 bug）。并行加速 2.4x。
42/42 回归。

## 遗留
- 300s/330s 墙钟保留（长审查真实需要），但不再是 trivial ask 的约束。
- readLatestChatGptAnswerText 的空白折叠对代码有损——复制优先级维持，
  DOM 兜底仅小文本可靠；若未来 clipboard 路径全面失效需重写为结构化收集。
