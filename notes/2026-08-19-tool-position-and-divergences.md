# 工具位置的正当差异与抄写来源决策

状态：accepted（M1 2026-08-19 实施，M2 2026-08-19 修订）
范围：src/browser/*、src/tools.ts、src/turnLog.ts

## 背景

web-agent-codex-runtime 站在**模型后端位置**（改写 Codex 的 `openai_base_url`），
其全部协议面复杂度（Responses/SSE/compaction/路由安装）与 2026-08-18 的四类全局事故
均源于该位置。branch-zcode 换到**工具位置**（MCP），provider 层代码整体抄写自 runtime，
但五处语义差异是"位置变化"的正当结果，不是抄写走样：

## 差异清单

1. **desync 宽松重同步**（cdpWorker.watchAnswerUntilIdle）
   - runtime 禁止答案文本回写（STREAM_DESYNC）：SSE 增量已发给 Codex，不可撤。
   - 工具模式没有已发增量 → ChatGPT"正在思考"占位符替换节点、GLM 思考流持续重写
     均可重对齐（reset 到新值）。预算 WEB_AGENT_RESYNC_LIMIT 默认 400 次（~100s 持续
     重写），配 no-output 120s 与 wall-clock 300s 双兜底。实测 GLM 思考期重写频繁，
     5 次的初版预算 1.25s 即耗尽误判。
2. **streamed/final 分歧降级为日志**（turn.ts）
   - runtime 强校验防"已流出的增量与最终复制不一致"；工具模式 copied-vs-DOM 指纹
     比对（selectSameTurnAnswer）已是权威防线，分歧只记录不失败。
3. **多同域标签 fail-loud**（cdpWorker.pageFor）
   - 绝不猜测操作哪个页面：同 origin 标签数 ≠1 时报 PROVIDER_UNAVAILABLE。
     （dsh 铁律：能力缺失大声拒绝。）
4. **observed 只能由 baseline 变化置位**（cdpWorker.watchAnswerUntilIdle，M2 修复）
   - runtime 原实现里"latestText 非空"也置 observed=true；发送后、新答案出现前的
     空窗中页面显示旧答案且不生成，watch 会满足 idle 谓词提前退出（DeepSeek 长
     prompt 实测复现）。删除该置位路径，observed 仅由 count 增长或文本相对 baseline
     变化触发。
5. **MCP outputSchema 必须顶层 object**
   - discriminatedUnion 在顶层不是 object，MCP SDK 的 zod 兼容层处理 union 时抛
     `_zod` undefined。成功/错误共用扁平 object + 可选字段。

## 抄写来源（有据可查）

- runtime：`cdpBrowserWorker.ts`（含 2026-08-18 的 raceWithStepTimeout / DeepSeek
  重渲染修复）、`selectorManifest.ts`、`surfaceLease.ts`、`appendOnlyText.ts`、
  `webProviderAdapter.ts` 的单次编排、`raceTurnDeadline` 墙钟兜底。
- dsh（思想 → 实现）：closed error union（approval.md）、fail-loud（subagent.md
  "rejected loud"）、provider registry（ctx.subagents 命名注册表）、
  canonical output 声明（tools.md:27-93）、事件溯源信封（architecture.md:92-96）。
- pi：M1/M2 未引入；其 loop/steering 定位为 M4 内部编排引擎，前提（网页模型需要
  服务内多步工具调用）未成立前不引入。

## 被否决的备选

- **bridge 路线**（MCP 壳转发 4390 runtime）：被用户否决——该抄就抄、整体重写；
  且 bridge 会保留旧位置的路由风险面。
- **provider 作为纯配置（dsh 严格版）**：web_ask 的 provider 参数让模型显式选择
  "问谁"，属于用户意图而非实现细节；注册表本身仍是封闭集合（重复注册硬错误）。

## 维护提醒

- 从 runtime 同步 provider 层修复时，逐条对照本 note 的差异清单，防止"抄新修旧"
  把工具位置的正当差异覆盖回去。
