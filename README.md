# web-agent-tools

把 ChatGPT / DeepSeek / GLM 三个**网页版**模型封装成六个 MCP 工具，供任意外层 coding agent（ZCode、Codex、dsh…）把流水线步骤委派给网页执行。外层只发任务书、只收无损产物——中间过程不占外层上下文，但全部快照在本地、随要随取（pull 式审计）。

## 架构：tool 位 + 三层防御 + 升级链

```
外层 agent（ZCode / Codex / …）
  │  task_spec + 产物契约 + 验收
  ▼
任务书（源头形态约束：禁多行字符串数组、\n 转义、直引号）
  │
  ├─ 角色路由（~/.web-agent-tools/config.json，配置驱动）
  │    executor = [deepseek, glm]   reviewer = [chatgpt, glm]   advisor = [deepseek, glm, chatgpt]
  │
  ├─ 第一层：机械提取器（零网络）——fence 救援 / 噪声剥离 / 弯引号成对转义 / 字符串断行还原
  ├─ 机器验收——JSON parse+required_keys；代码：括号平衡 + acorn 语法门（三态，TS 显式"未检查"）
  └─ 失败 → 升级链（声明式、有界、全程可审计）：
       #1 修复兜底     损坏产物+原始全文 → 跨模型修复（deepseek 优先）
       #2 审查-修订    review_rounds≤2：reviewer 审 → executor 修 → 复验
       #3 交叉验证     cross_check：并行副生成 → 机械 LCS diff → 一致率+冲突双方节选
       #4 议会         web_council：三家并行独立作答 → 汇总席四字段决议
```

横切：事件溯源日志（turns.jsonl + artifacts/ 全文快照）、fail-loud 错误闭联、
每页 surface 租约、salvage 超时回收、Decision Packet（审查/议会结论机械压缩）。

## 六个工具

| 工具 | 用途 |
|---|---|
| `web_status` | 三页健康探测（force 刷新） |
| `web_ask` | 一问一答（advisor 链）；`salvage: true` 只读回收超时后的迟到答案 |
| `web_review` | 结构化审查（reviewer 链，300s 墙钟）；自动附 decision packet；`packet_only` 压 78% |
| `web_delegate` | 无损产物委派（executor 链）+ 修复兜底 + `review_rounds` + `cross_check` |
| `web_council` | 三家并行议事 + 汇总席四字段决议（共识/分歧/建议/少数意见） |
| `web_handoff` | 报告页面需要的人工动作（登录/验证码/风控） |

## 前置条件

1. Node ≥22.5（开发用 26.x）
2. 日常 Chrome 以调试端口启动（CDP 4319）：`open -na "Google Chrome" --args --remote-debugging-port=4319`（保持用户配置）
3. 三个网页恰好各一个已登录标签

## 安装（每客户端）

- **ZCode**：见 `clients/zcode.md`（`.zcode/config.json`）
- **Codex**：见 `clients/codex.md`（`codex mcp add`，无人值守需 `-s danger-full-access`）
- **dsh**：见 `clients/dsh.md`（本机未装则暂缓）

```sh
npm install && npm run build
node scripts/smoke-mcp.mjs   # 六工具在线 + 三页健康
```

## 快速开始（Codex）

先让日常 Chrome 以 CDP 4319 启动，并在同一个 Chrome 中分别登录
ChatGPT、DeepSeek、GLM。然后在项目目录执行：

```sh
export WEB_AGENT_TOOLS_DIR="$(pwd)"
npm ci
npm run build

codex mcp add web-agent-tools \
  --env WEB_AGENT_CDP_URL=http://127.0.0.1:4319 \
  -- node "$WEB_AGENT_TOOLS_DIR/dist/index.js"

codex mcp list
```

新建一个 Codex 任务后，直接用自然语言请求即可，例如：

```text
先调用 web_status 检查网页 Agent 状态。
然后用 web_delegate 让 DeepSeek 分析这个方案，输出结构化审查结果。
```

也可以明确指定工具：`web_ask` 用于提问，`web_review` 用于审查，
`web_delegate` 用于带验收的任务委派，`web_council` 用于并行咨询多个网页模型。
这些工具不会出现在模型选择器中，而是作为 MCP 工具由 Codex 调用。

其他客户端的配置见 `clients/`：

- `clients/codex.md`
- `clients/zcode.md`
- `clients/dsh.md`

## 配置

`~/.web-agent-tools/config.json`（角色链）、`WEB_AGENT_*` 环境变量（各级超时，
见 `src/browser/cdpWorker.ts` 的 `configuredTimeout`）。

## 测试与日志

```sh
node --test tests/            # 52 项零成本回归（含 13 条真实历史损坏样本）
node scripts/replay-glm-history.mjs --offline   # 历史样本离线回归
tail -f ~/.web-agent-tools/logs/turns.jsonl     # 事件流
ls ~/.web-agent-tools/logs/artifacts/           # 全文快照（pull 式审计）
```

## 设计记录

决策、事故、复盘全部在 `notes/`（按日期）。关键脉络：
tool 位转向（08-19）→ 委派管线与提取器（08-20）→ 机械修复+修复兜底+语法门（08-20）
→ 旧 runtime 退役（08-21）→ chatgpt DOM 漂移排障（08-21）→ 升级链四算子（08-21）。

## 血泪教训（写入代码注释的)

- 网页 DOM 会漂移：完成判定/复制选择器以 turn 容器为锚（2026-08-21 chatgpt 事故）
- "无法检查 ≠ 检查通过"：验收门三态，unsupported 显式标注
- 跨块全局正则会吞掉相邻结构：fence 处理要局部化
- 短间隔重复发送同款提示会触发 provider 限速：验证脚本要错峰

## License

MIT License. See [LICENSE](LICENSE).

Source and design attributions are listed in [NOTICE.md](NOTICE.md).
