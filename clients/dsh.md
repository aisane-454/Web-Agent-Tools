# DeepSeek Harness (dsh) 接入 web-agent-tools

dsh 的 MCP client bridge（`@deepseek-ai/dsh-mcp-client`）可以把我们的 stdio server
直接注册为 dsh 的原生工具（`mcp__webagent__web_ask` 等），零代码接入。

## 配置

在 dsh 的 `cordis.yml`（或对应 profile/bundle 的插件列表）加入：

```yaml
- id: mcp-web-agent
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: webagent
    transport: stdio
    command: node
    args:
      - '/path/to/web-agent-tools/dist/index.js'
    env:
      WEB_AGENT_CDP_URL: 'http://127.0.0.1:4319'
    # web_ask/web_review 可能运行数分钟：默认 60s 的调用超时必须调大
    toolCallTimeoutMs: 300000
```

将 `/path/to/web-agent-tools` 替换为本仓库的实际绝对路径。

模型将看到：`mcp__webagent__web_status`、`mcp__webagent__web_ask`、
`mcp__webagent__web_review`、`mcp__webagent__web_delegate`、
`mcp__webagent__web_council`、`mcp__webagent__web_handoff`。

## 关键注意

1. **`toolCallTimeoutMs` 必须显式调大**（建议 300000）。bridge 默认 60s，会把正常的长
   review 掐死在半路——而我们的 server 端语义是"超时即视为提示词可能已入页
   （SEND_IDEMPOTENCY_UNKNOWN）"，客户端中途掐断会造成页面上的孤儿回合。
2. **`serverName` 保持稳定**。工具名是 `(serverName, rawName)` 的纯函数；改名会使
   会话历史中的工具调用无法对应。
3. **进度通知**：server 在每个阶段发 progress notification；bridge 侧如支持
   resetTimeoutOnProgress 语义可进一步放宽总超时。
4. 重连由 bridge 自带（默认指数退避、10 次预算）；web-agent-tools 进程崩溃会由
   bridge 重启，Chrome 页面不受影响。

## 前置条件（同 zcode.md / codex.md）

- 日常 Chrome 以 CDP 4319 运行；
- chatgpt.com / chat.deepseek.com / chatglm.cn 各保留**恰好一个**已登录标签
  （多标签 fail-loud，绝不猜测操作哪个）。

## 备选：subagent provider 插件（未实施）

dsh 的 `ctx.subagents` 命名 provider 注册表（`docs/subsystems/subagent.md`）提供了
把外部 agent 作为子代理的更深层集成（one-shot、fail-closed、深度限制）。当
web-agent-tools 需要在 dsh 内以"子代理"而非"工具"的形态出现时再实施——
当前 MCP bridge 形态已覆盖主要场景，且与 ZCode/Codex/Trae/Kimi 的接入方式完全一致。
