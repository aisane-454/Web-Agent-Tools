# ZCode 接入 web-agent-tools

## 配置（2026-08-19 修正：ZCode 读 `.zcode/config.json`，不读 `.mcp.json`）

在目标工作区创建 `.zcode/config.json`，内容如下。请将 `<repo-path>` 替换为本仓库的绝对路径：

```json
{
  "mcp": {
    "servers": {
      "web-agent-tools": {
        "type": "stdio",
        "command": "node",
        "args": ["<repo-path>/dist/index.js"],
        "env": { "WEB_AGENT_CDP_URL": "http://127.0.0.1:4319" }
      }
    }
  }
}
```

注意（ZCode 的 MCP schema 是严格的）：
- 位置是 `<repo>/.zcode/config.json`，字段是**嵌套的 `mcp.servers`**（不是 `.mcp.json` 的顶层 `mcpServers`——那是 Codex/Cursor 约定，ZCode 不读）
- `command` 必须是字符串（不要 OpenCode 风格的数组），参数放 `args`
- 路径用绝对路径（配置文件不做环境变量或 `${...}` 模板展开）
- 未知键会导致整个 server 被静默丢弃

改完**新建会话**生效（恢复的旧会话不会重新加载工具）。可在 设置 → MCP 里看连接状态；排查用 `/diagnosing-mcp`。

## 前置条件

1. 日常 Chrome 以 CDP 调试端口 4319 运行（与其他 web agent 项目共用同一 Chrome）。
2. 三个网页各保留**恰好一个**标签页且已登录：chatgpt.com、chat.deepseek.com、chatglm.cn。
   多个同域标签会 fail-loud（`PROVIDER_UNAVAILABLE`），绝不猜测操作哪个。

## 工具

- `web_status()` — 三页面健康、登录态、是否在生成；不确定可用性时先调它。
- `web_ask({ provider, prompt, timeout_ms? })` — 一次性提问，返回最终答案文本。
  - prompt 必须自包含（需要代码就内联），网页端与调用方无共享状态。
  - 长调用：server 侧进度通知 + 默认 180s / 上限 300s。
- `web_review({ provider, content, focus? })` — 结构化审查（编号问题/严重度/建议）。
- `web_delegate({ task_spec, deliverable, ... })` — 带验收、修复、审查和交叉校验的委派。
- `web_council({ question, providers, ... })` — 并行咨询多个网页模型并综合结论。
- `web_handoff({ provider })` — 报告页面需要的人工操作及指引。

## 错误语义（调用方模型需要知道的）

- `SEND_IDEMPOTENCY_UNKNOWN`：提示词可能已进入网页，**禁止自动重试**，请用户检查页面。
- `LOGIN_REQUIRED / CAPTCHA_REQUIRED / RISK_CONTROL / TERMS_DIALOG`：需要人工在可见页面上处理。
- `PROVIDER_BUSY`：该页面正在被另一个调用使用；稍后重试或换 provider。
- 其余（`UI_DRIFT / RESPONSE_TIMEOUT / BROWSER_STEP_TIMEOUT / PROVIDER_UNAVAILABLE`）：可安全重试。

## 诊断

结构化日志（不含正文）：`~/.web-agent-tools/logs/turns.jsonl`

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
