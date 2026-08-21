# R1 设计+实施：Decision Packet（外层消费压缩）

状态：层 A 已实施（2026-08-20）：assembleDecisionPacket 装配器（delegate.ts）+
web_review 的 packet 字段与 packet_only 模式 + 真实 fixture 测试（42/42）+
deepseek 端到端实测（477→103 字符，78% 压缩，verdict 正确装配）。
层 B（收敛式提示词）暂缓——层 A 已覆盖主要收益。

依据：2026-08-20 演练画像（drill note）+ 设计会 R7 原则
"优化外层消费的 token，不优化回答质量"。

## 数据画像（回传量排序）
| 工位 | 回传 | 占比场景 |
|---|---|---|
| web_review（chatgpt） | 2632 字符 | 最大变量：审查越长外层越贵 |
| 修复工位（deepseek） | 2098 字符 | 产物本身，不可压 |
| glm 生成 | ~900 字符 | 产物本身 |
| deepseek 生成 | 386 字符 | 已最小 |

## 核心原则（继承自用户否决过的教训）
**压缩"判决与元数据"，永不压缩"产物"。**
- 产物（code-block/JSON deliverable）必须无损——这是 tool 位架构的立身之本。
- 可压的是：审查结论的包装、讨论型回答的冗余、跨轮重复的上下文。

## 设计：两层 Decision Packet

### 层 A：机械 packet（零额外 token，优先）
web_review 的提示词已要求结构化输出（[严重度: N] 分段）。在提取器层加
packet 装配器（纯本地，不发新请求）：
```
{
  verdict: "needs-changes" | "accept" | "reject",   // 由最高严重度推导
  high: [≤3 条，每条截断 ≤120 字符],                  // 高危项必须给外层看
  medium_count / low_count: 数字,
  full_at: "turns.jsonl 的 call 指纹",                // 全文指针，可追溯
  total_chars: 原始长度
}
```
典型压缩：2632 → ~500 字符（81%↓），高危信息零损失（条数少且截断保留结论句）。
外层读 packet 决策；只有需要采纳具体建议时才按指针取全文。

### 层 B：packet 模式提示词（可选，审查方自行收敛）
web_review 加 `packet: true` 参数 → 提示词追加"结论用固定五字段，建议每条
≤80 字符"。省的是网页端生成的冗余，不是外层的读取。默认关闭，层 A 优先。

## 落点与顺序
1. `src/delegate.ts` 加 `assembleDecisionPacket(reviewText)` 纯函数 + fixtures 测试
   （用今天抢救的 2632 字符真实审查做 fixture——零成本测试制度）。
2. `web_review` 输出加 `packet` 字段（全文保留在 text，structuredContent 带 packet）。
3. `web_ask` 暂不动（advisor 讨论价值密度难判定，等更多使用数据）。
4. 外层（codex/zcode）消费文档：clients/*.md 加"读 packet、按指针取全文"用法。

## 明确不做
- 不给 web_delegate 的产物加压缩/摘要（无损红线）。
- 不做跨轮缓存（状态复杂度 > 收益，当前画像未证明需要）。
