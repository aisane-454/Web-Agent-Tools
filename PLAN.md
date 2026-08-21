## 定案架构：默认提取器 + 修复兜底（2026-08-20）

- 第一层：机械提取器（噪声剥离/弯引号成对转义/字符串断行还原/fence 救援），零网络成本
- 第二层：deepseek 修复工位（解析两败或验收失败触发，原始全文为证据，一次为限，带溯源）
- 实测：idx-12 最坏样本 16.7s 完整还原；正常路径零回归；测试 31/31

# web-agent-tools：Web Agent 工具化改造计划

创建：2026-08-19
状态：M1 + M2 + M3 完成（见 §8 实施记录）；M4（pi 内部编排）保持可选未实施

## 0. 一句话定位

把 web agent 从「冒充 Codex 模型后端的替身」改造为「任何 coding agent 都能调用的工具」：
客户端（Codex / ZCode / Trae / Kimi Code / dsh）的模型规划能力保持原生，web agent 只作为流程中的一节，
通过 MCP（及 dsh plugin）暴露六个稳定工具：`web_status / web_ask / web_review / web_delegate / web_council / web_handoff`。

## 1. 为什么换位置（动机备忘）

旧路线（web-agent-codex-runtime 的 API 式替换）站在**模型位置**上，被迫承接全部协议面
（Responses/SSE/compaction/encrypted_content/模型目录伪装/路由安装），任何失误的惩罚都是全局的。
2026-08-18 一天的四类事故全部产自这条路线：

1. 路由指向死端口 → Codex 整体变砖（4 次）
2. 本地假 `ocx1:` 压缩条目污染官方线程（`invalid_encrypted_content`）
3. SSE 悬空请求泄漏（active_http_requests 卡 24）
4. 网页会话绑定状态机的 answer 检测脆弱（GLM 409 / STREAM_DESYNC）

工具位置的失败半径 = 单次工具调用失败，客户端模型自行绕路。
详细事故记录保留在 `notes/`；本仓库不依赖旧 runtime 的目录结构。

## 2. 三条设计铁律（抄自 deepseek-harness）

1. **工具面稳定，provider 是配置**——模型只见固定工具 schema；选 chatgpt/deepseek/glm 是配置或参数，
   不让模型面对 provider 实现差异。
2. **fail-loud + fail-closed**——健康检查不过的 provider 不出现在 `web_status` 可用列表里，
   调用则明确报封闭错误码；能力缺失大声拒绝，绝不接受后静默忽略。
3. **one-shot、不继承调用方上下文**——每次调用独立，prompt/context 由调用方模型裁剪后显式传入；
   web agent 内部不复用调用方的会话历史。

## 3. 目标架构

```
Codex ──MCP(mcp_servers)──┐
ZCode ──MCP───────────────┤
Trae/Kimi ──MCP───────────┤→  web-agent-tools 服务
dsh ──plugin/MCP bridge───┘      │
                                 ├─ 工具面（稳定）: web_status / web_ask / web_review / web_delegate / web_council / web_handoff
                                 ├─ Provider 面（配置）: chatgpt / deepseek / glm 网页适配器
                                 ├─ 诊断: turns.jsonl 结构化日志（无正文）
                                 └─ 内部编排（可选 M4）: pi-agent-core loop
                                                        │
                                       复用 web-agent-codex-runtime 的 CDP 页面驱动
                                                        │
                                       用户日常 Chrome（CDP 127.0.0.1:4319）
```

关键决策：
- **传输层 = MCP stdio server**（每个客户端自持进程，随客户端起停，无常驻服务、无路由安装、
  不碰任何客户端的 config 里的模型后端）。多客户端并发访问同一 Chrome 时由 provider 层的
  surface lease 互斥（已验证的机制）。
- **不透传官方模型**。官方模型回到各客户端原生连接，本服务只做网页 provider。
  （旧 runtime 的透传是"替身位置"的伴生需求，随位置一起退役。）
- **HTTP 服务保留为内部实现细节**（可选）：provider 层复用现有 4390 runtime 的进程时，
  MCP 层通过 localhost HTTP 调它；不对外暴露。

## 4. 目录规划（本仓库）

```
web-agent-tools/
├─ PLAN.md                     # 本文件
├─ package.json                # @modelcontextprotocol/sdk + playwright（或经 HTTP 复用 runtime）
├─ tsconfig.json
├─ src/
│  ├─ mcp/server.ts            # MCP stdio server 入口，工具注册
│  ├─ mcp/tools.ts             # 工具 schema + handler
│  ├─ core/providerRegistry.ts # 命名 provider 注册表（Definition/Provider/Consumer 三分）
│  ├─ core/health.ts           # 启动/定期健康探测，fail-loud 目录摘除
│  ├─ core/errors.ts           # 封闭错误码联合（沿用 runtime 的 RuntimeErrorCode 裁剪）
│  ├─ core/turnLog.ts          # 迁移自 runtime 的 turns.jsonl（无正文诊断）
│  └─ providers/
│     ├─ bridge.ts             # 经 localhost HTTP 调 runtime（M1 最快路径）
│     └─ native/               # M2 起直接内嵌 worker（复制迁移，见 §5）
├─ clients/
│  ├─ zcode.md                 # ZCode 接入说明（我自己就是第一个用户）
│  ├─ codex.md                 # Codex mcp_servers 配置片段（不碰 openai_base_url）
│  └─ dsh-plugin.md            # dsh 接入两条路：MCP bridge / subagent provider
└─ tests/
   ├─ tools.test.ts            # 工具 schema 与错误映射
   └─ provider.e2e.ts          # 真实 CDP 冒烟（低频，手跑）
```

## 5. 复用代码路径映射（现有资产 → 新模块）

来源仓库：`<旧 runtime 项目目录>（本项目参考前身，不随仓库发布）`

| 新模块 | 复用来源（现有代码） | 说明 |
|---|---|---|
| providers/native/cdpWorker | `src/providers/cdpBrowserWorker.ts` | 页面定位/inspect/分块插入/发送取证/watchUntilIdle/copy-first 提取全套；含 2026-08-18 加入的 `raceWithStepTimeout`（轮内 15s 上限）与 abort 传播 |
| providers/native/selectors | `src/providers/selectorManifest.ts` | 三网页选择器 + 完成判定 manifest（GLM 终态标记/DeepSeek 操作栏/ChatGPT copy 动作） |
| core/turnLog | `src/runtime/turnLog.ts` | 已在生产验证：`~/.web-agent-codex-runtime/logs/turns.jsonl`，一天内定位两个真 bug |
| core/errors | `src/contracts.ts`（`RuntimeErrorCode` 联合，162-187 行） | 裁剪掉协议类码（MODEL_SWITCH/CONVERSATION_* 等），保留 provider 类（LOGIN_REQUIRED/UI_DRIFT/SEND_IDEMPOTENCY_UNKNOWN/BROWSER_STEP_TIMEOUT…） |
| 页面互斥 | `src/runtime/surfaceLease.ts` | 同一物理页面不并发写入 |
| 取消传播参考 | `src/providers/webProviderAdapter.ts`（`throwIfRequestAborted` 各阶段检查） | MCP 取消 → AbortSignal → worker |
| 发送幂等语义 | `src/backends/browserBackend.ts`（acceptedDispatches） | 工具模式下简化为：发送不确定即报 `SEND_IDEMPOTENCY_UNKNOWN`，不做会话级去重注册表 |

**明确不迁移**（旧位置的伴生复杂度）：
`src/integration/codexRouteInstaller.ts`、`src/integration/macosService.ts`（路由/LaunchAgent 接管）、
`src/runtime/responseState.ts`（877 行会话绑定状态机）、`src/protocol/`（Responses 协议层）、
`src/integration/codexModelCatalog.ts`（模型目录伪装）、`src/server.ts` 的透传与 SSE 网关。

## 6. 参考设计路径映射（学谁的什么）

### deepseek-harness —— 架构范式（最重要）

| 思想 | 参考路径（`<deepseek-harness 项目目录>`） |
|---|---|
| capability seam 三分（Definition/Provider/Consumer） | `docs/architecture.md:98-102`；全表 `docs/capability-seams.md:412-469` |
| "换 provider 不动工具面" | `docs/architecture.md:102` |
| subagent 命名 provider 注册表（外部 agent 作为工具的官方范式） | `docs/subsystems/subagent.md:7,406-458`；设计笔记 `.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.md` |
| "Provider selection is config, not model-facing" | 同上笔记 `:63-65`；`packages/subagent/tool-subagent/README.md` |
| one-shot / fail-closed 外部 agent（codex、claude-code provider 的约束） | `.agents/notes/implemented/feature/2026-08-04-claude-code-and-codex-subagent-backends.md:17-59` |
| 能力检查 rejected-loud | `docs/subsystems/subagent.md:13-33` |
| 工具执行管道（guard/approval/waterfall/finalize） | `docs/tool-execution-pipeline.md:6-60`；`docs/subsystems/tools.md:27-93` |
| 审批封闭联合、fail-closed | `docs/subsystems/approval.md:21-88` |
| MCP client bridge（dsh 接我们的通道） | `packages/mcp/README.md` |
| "model-visible means logged" 事件溯源 | `AGENTS.md:107`；`docs/architecture.md:92-96` |
| 设计笔记制度（非平凡改动先写 note） | `.agents/notes/`（270+ 篇） |

### pi —— 内部编排引擎（M4 可选）

| 用途 | 参考路径（`<pi 项目目录>`） |
|---|---|
| 可嵌入 agent loop（网页模型多步工具调用的内部闭环） | `packages/agent/src/agent-loop.ts:155-275` |
| AgentTool 定义（TypeBox schema + execute + 顺序/并行） | `packages/agent/src/types.ts:385-409` |
| 工具结果可含图片（截图回传） | `packages/agent/src/types.ts:360-375` |
| 流式事件协议（start/text_delta/done） | `packages/ai/src/types.ts:525-549` |
| pi-messages 后端协议（web agent 反向成为 pi 的 provider 的远期通道） | `packages/ai/src/api/pi-messages.ts:1-9` |
| 注意：pi 无 MCP、无浏览器自动化（哲学即如此），只作库用 | `packages/coding-agent/README.md:494-510` |

## 7. 工具接口（v1 草案）

```ts
web_ask({
  provider: "chatgpt" | "deepseek" | "glm",
  prompt: string,                 // 调用方模型已裁剪的任务文本
  context?: string,               // 可选补充上下文（代码片段、约束）
  timeout_ms?: number             // 默认 180_000，上限 300_000
}) => {
  ok: true, text: string, provider, duration_ms, answer_chars
} | { ok: false, error: ErrorCode, message, details }

web_review({ provider, content, focus? })   // 审计/二审场景，同上返回
web_status() => [{ provider, healthy, url, login_required, last_error }]
web_handoff({ provider, instruction })      // 人工处理通道：返回需用户在页面上完成的事项
```

错误码（封闭联合，映射自 RuntimeErrorCode 子集）：
`PROVIDER_UNAVAILABLE / LOGIN_REQUIRED / CAPTCHA_REQUIRED / UI_DRIFT / SEND_IDEMPOTENCY_UNKNOWN /
RESPONSE_TIMEOUT / BROWSER_STEP_TIMEOUT / INVALID_ARGUMENT / INTERNAL`

长调用体验：MCP progress notification 每 2s 上报阶段（send → streaming chars → copying）。

## 8. 里程碑与实施记录

### M1 已完成（2026-08-19，本仓库直接原生化，未走 bridge）

实施说明：用户拍板"该抄就抄、整体重写"，因此跳过原计划的"经 4390 bridge"路径，
provider 层直接从 web-agent-codex-runtime 复制内嵌（`src/browser/`），来源在文件头注明。

落地文件：
- `src/index.ts` — MCP stdio server，注册 `web_ask` / `web_status`，含墙钟兜底与进度通知
- `src/tools` 逻辑内联于 index.ts；`src/errors.ts` 封闭错误码；`src/providerRegistry.ts` 命名 provider 注册表
- `src/browser/cdpWorker.ts` — 抄 runtime cdpBrowserWorker（含 raceWithStepTimeout、DeepSeek 重渲染修复），裁剪会话绑定
- `src/browser/turn.ts` — 抄 webProviderAdapter 的单次编排，去工具信封/压缩
- `src/browser/{selectors,surfaceLease,appendOnlyText}.ts` — 原样复制
- `src/turnLog.ts` — 抄 runtime turnLog（stdout 归 MCP，日志只落文件）
- `scripts/smoke-{mcp,web}.mjs` — 协议冒烟与真实网页冒烟

工具位置的正当差异（相对 runtime 的实现，均有注释说明）：
1. **desync 宽松重同步**（cdpWorker）：runtime 禁止答案文本回写是因 SSE 增量不可撤；
   工具模式没有已发增量，ChatGPT 用"正在思考"占位符替换节点文本时可重对齐，连续重写 >5 次才判 UI_DRIFT。
2. **streamed/final 分歧降级为日志**（turn.ts）：copied-vs-DOM 指纹比对仍是权威防线。
3. **多同域标签 fail-loud**（pageFor）：绝不猜测操作哪个页面。

验证结果：
- MCP 协议冒烟：tools/list 正常，web_status 真实探查三页全部健康
- 真实网页：**deepseek ✅ 2.5s 返回 "pong"**；**glm ✅ 7.9s 返回 "pong"**（旧 runtime 中 GLM 长期 409 卡死）
- chatgpt ⚠️ 已知问题：页面长期停留在"正在思考"后静默（交叉验证：旧 runtime 同一页面同样失败，
  且会把"正在思考"占位符当最终答案返回）。判定为页面侧风控/限流（当日被自动化高频触发），
  需页面冷却或人工查看；不是本分支代码缺陷。新代码在此场景正确返回 RESPONSE_TIMEOUT 而非占位符。
- 诊断日志 `~/.web-agent-tools/logs/turns.jsonl` 全程记录阶段/耗时/计数

### M2 已完成（2026-08-19 同日）

dsh/pi 的融入从"原则层"推进到"机制层"：

- **事件溯源调用日志（schema v2）**（`src/turnLog.ts`）：每次调用以 `call.envelope`
  开场（tool/provider/prompt 指纹/超时），以 `call.settled` 收束（ok/duration/errorCode），
  阶段事件居中——失败可从日志独立回放分析（dsh "model-visible means logged" 纪律，
  architecture.md:92-96）。不存任何正文，只存 sha256 指纹。
- **canonical output schema**（`src/tools.ts`）：六个工具全部声明 MCP outputSchema
  （顶层必须是 object——discriminatedUnion 顶层不合规，SDK 兼容层会崩，见 note）。
  dsh mcp-client 会对 structuredContent 做 schema 校验，契约稳定可依赖。
- **`web_review`**：结构化审查模板（编号问题/严重度/位置/建议），实测 GLM 24.5s
  完成真实代码审查；**`web_handoff`**：humanActionCode → 中文操作指引；**`web_status`
  5s 健康缓存**（force 参数可绕过）。
- **`notes/` 设计笔记制度**：抄 dsh `.agents/notes/` 精神；首篇
  `2026-08-19-tool-position-and-divergences.md` 记录五处工具位置正当差异
  （含 M2 修复的 observed 置位缺陷：发送后新答案出现前的空窗会让 watch 提前退出）。

### M3 已完成（2026-08-19 同日）

- **dsh 接入**（`clients/dsh.md`）：经 `@deepseek-ai/dsh-mcp-client` bridge 零代码接入，
  cordis.yml 片段已给出；关键坑已标注（`toolCallTimeoutMs` 默认 60s 必须调到 300000，
  否则长 review 被掐 + 服务端已把超时视为不可重放）。subagent provider 深层集成
  记录为备选，MCP bridge 形态已与其他客户端完全一致。
- M3 原定的 web_review / web_handoff 已随 M2 落地。

### 真实验证汇总（2026-08-19）

| 工具 | provider | 结果 |
|---|---|---|
| web_ask | deepseek | ✅ 6.1s "pong" |
| web_ask | glm | ✅ 12.6s "pong"（旧 runtime 中 409 卡死） |
| web_review | glm | ✅ 24.5s 完整结构化审查意见 |
| web_handoff | glm | ✅ action_required=null + 页面状态 |
| web_status | 三页 | ✅ 全部健康（5s 缓存生效） |
| web_ask | chatgpt | ⚠️ 账号级限流（2026-08-19 全天数十次自动化请求所致）：发送成功、答案始终在 120-180s 超时**之后**才渲染（DOM 抓取证实三轮均如此）。失败语义正确（SEND_IDEMPOTENCY_UNKNOWN + 页面留痕）。等待限流解除后自然恢复；急用时可传 timeout_ms=300000 但仍在边缘 |

### 剩余

| 项 | 状态 |
|---|---|
| M4（可选）pi-agent-core 内部编排 | **决定不实施**（2026-08-19）：审查/问答场景下网页模型的价值就是"外层模型之外的一个视角"，one-shot 恰为最优；启动触发条件（见下）均未成立。触发条件：① 网页模型具备外层没有的能力且任务需多轮迭代；② 需要并行委托小时级长任务；③ 需要把几十轮工具中间过程隔离在外层上下文之外。任一出现再评估 |
| chatgpt 页面风控恢复后复测 | 待页面冷却 |
| 退役旧 runtime 路由/协议层 | 待与 Codex 协作执行（不单方面下线） |

## 9. 风险与对策

- **客户端 MCP 调用超时差异**：progress notification 心跳 + 服务端自设 300s 硬上限（沿用已验证的 wall-clock backstop 思路，`web-agent-codex-runtime/src/server.ts` 的 `raceTurnDeadline`）
- **网页 DOM 改版**：selectorManifest 已版本化，配合 fail-loud 摘除
- **与 Codex 那边的并行开发冲突**：provider 层源头留在 runtime 仓库由它维护，本仓库 M2 起以复制+注明来源方式同步；重大分歧在两边的 issues/notes 对齐
- **多客户端同时调一个网页**：surface lease 互斥（已验证），第二个调用方收到 `PROVIDER_BUSY` 排队或快速失败（配置项）
