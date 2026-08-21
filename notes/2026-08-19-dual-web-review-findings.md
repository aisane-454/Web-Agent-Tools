# 双网页模型对 ask() 编排的审查发现（首次实战协作）

状态：adopted（第 1/2/5 项已修 2026-08-20：CANCELLED 独立错误码且不在 failover 白名单；
DOM 回退要求 after.count > baseline.count；第 5 项经查 TS 类型与 lease 幂等已由构造保证。
第 3 项锚点为架构级，留待事故复发时实施；第 4 项 cause 链留待 ToolError 改版。）
（原 proposed 2026-08-19，web_review × {deepseek, glm} 并行）
输入：turn.ts ask 流程摘录（2790 字符）；deepseek 13.3s / glm 80.5s

## 采纳（真问题，按优先级）

1. **[glm] 取消语义在 post-send 被吞**：`context.signal` 的取消发生在发送后时，
   被内层 catch 改写为 SEND_IDEMPOTENCY_UNKNOWN，调用方无法区分"用户取消"与
   "不可重放失败"。→ catch 中先判 `signal.aborted`，单独重抛明确的取消错误。
2. **[glm] DOM 回退未校验与 baseline 差异**：copy 失败回退 `after.latestText` 时，
   若它恰等于 baseline 旧答案会静默返回旧内容。→ 回退前要求与 baseline 存在差异，
   否则上抛。与"锚点"问题同源。
3. **[glm] 轮次锚点建议**：新答案判定依赖 count+文本双重巧合，应对"重复相同回答/
   编辑旧答案/折叠历史"脆弱。→ 发送前记录消息节点引用（锚点），锚点之后的节点
   才算本轮答案。这是"重复 pong"事故的架构级根治方案。
4. **[glm+deepseek] 错误包装丢 cause**：统一转 SEND_IDEMPOTENCY_UNKNOWN 时原始
   error/堆栈丢失（details.sourceError 只留了 code）。→ ToolError 增加 cause 链。
5. **[glm] answer 空值防御 + release 包裹**：`answer.trim()` 前无 null 防御；
   `lease.release()` 若抛错会掩盖原始异常。→ 小修。

## 部分有效（设计讨论）

- **[glm] not_sent 可重试的边界**：仅在 send() 严格保证"not_sent = 确定未提交"时
  安全——当前实现满足（证据：composer 文本仍在 + 无生成 + URL 未变），但在
  cdpWorker 注释中显式声明该契约。
- **[deepseek] post-send 错误全转不可重试丢失语义**：details.sourceError 已保留
  原始 code；改进方向是让客户端可读的 structured error 里也带上。

## 误报（片段上下文限制）

- deepseek: "selectSameTurnAnswer 未定义"——片段省略，实际存在。
- deepseek: "acquire 失败时 finally 引用未定义 lease"——acquire 在 try 块之前，
  抛出时不会进 finally；若未来移入 try 内则成立，注释标记。
- deepseek: "streamedAnswer 未使用"——已降级为日志（见
  2026-08-19-tool-position-and-divergences.md 差异 2），保留用于 divergence 观测。

## 元观察

首次双网页并行协作即产出 5 条有效发现，其中"锚点"建议直指我们踩过的真实事故。
web_review 的结构化模板（严重度/位置/建议）两家用得都很好。
