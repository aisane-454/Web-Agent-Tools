# Codex 接入 web-agent-tools

## 配置（已实测验证，2026-08-19）

官方 CLI 注册（推荐，比手改 config.toml 安全）：

```sh
export WEB_AGENT_TOOLS_DIR="/path/to/web-agent-tools"

/Applications/ChatGPT.app/Contents/Resources/codex mcp add web-agent-tools \
  --env WEB_AGENT_CDP_URL=http://127.0.0.1:4319 \
  -- node "$WEB_AGENT_TOOLS_DIR/dist/index.js"
```

验证：`codex mcp list` / `codex mcp get web-agent-tools`（enabled: true）。
移除：`codex mcp remove web-agent-tools`。

**不改动 `openai_base_url`，官方模型保持原生直连**（如仍有 4390 托管路由，那是旧
web-agent-codex-runtime 方案，与本项目无关）。

## 已验证的端到端链路（2026-08-19）

```
codex exec（gpt-5.5）→ mcp: web_status (completed) → 汇报三页健康
codex exec（gpt-5.5）→ mcp: web_ask(deepseek) (completed) → 汇报网页回答 "2"
```

## 审批注意（重要）

`codex exec` 默认 `approval: never` + read-only sandbox 下，MCP 工具调用会被拒
（"MCP tool call requires approval"）。无人值守脚本需加 `-s danger-full-access`；
交互式 Codex 桌面端按正常审批流程放行即可。

另：若官方模型请求经过旧 runtime（4390）透传，日志会出现一次
`websocket 426` 错误——这是已知的 WS 预热回退噪声（SSE 正常工作），与本工具无关。

## 前置条件

同 `zcode.md`：CDP 4319 的日常 Chrome + 每个网页恰好一个已登录标签。

## R1 Decision Packet 消费模式（web_review）

- 日常：读 `structuredContent.packet`（verdict + 高危标题 + 计数）做决策即可。
- 需要采纳具体建议时：不带 `packet_only` 参数（默认回传全文），或从页面/turns.jsonl 取。
- 高频轮询/批量审查场景：`packet_only: true`，外层只收 ~100 字符决策包。
- 红线：web_delegate 的产物永不压缩——packet 只存在于 review 类返回。

## Salvage 补救模式（超时后回收）

`web_ask { salvage: true, provider: "chatgpt" }`：只读回收该页面上最后一条已完成
回答，不发送任何内容。任何 ask/review 超时（SEND_IDEMPOTENCY_UNKNOWN /
RESPONSE_TIMEOUT）后先 salvage 再考虑重试——页面经常在期限后完成回答。
真实实测：3.4s 回收 2296 字符 + 自动装配 decision packet。
页面仍在生成时返回 PROVIDER_BUSY，等空闲再试。

## 旧 runtime 退役记录（2026-08-21）

- 旧的 API 路由服务已退役，不随本仓库分发
- config.toml 的 4390 路由已除（codex 官方直连，实测 "正常" 走官方账号）
- web-agent-host@personal 插件已禁用（其 MCP 随之消失）
- 备份：~/.codex/config.toml.bak-before-runtime-retirement
- 旧项目源码保留作参考（新项目的 cdpWorker/turnLog 等抄自它并注明出处）
