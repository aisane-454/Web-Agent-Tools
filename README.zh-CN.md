# Web Agent Tools

复用已有网页账号，让 ChatGPT、DeepSeek、GLM 通过 MCP 协作服务本地 coding agent。

[![Node.js](https://img.shields.io/badge/node-%3E%3D22.5-339933.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[English](README.md) | **简体中文**

Web Agent Tools 是一个本地优先的 MCP server。它把自包含的问题、代码审查和有明确产物契约的子任务，委派给用户日常 Chrome 中已经登录的网页 AI。

它是一个**能力层**，不是新的 coding-agent runtime，也不是模型 API 代理。Codex、ZCode、DeepSeek Harness 或其他 MCP client 仍然负责任务、工作区、工具、审批和最终决策；本项目只提供一组稳定接口，让这些宿主能够调用网页智能资源。

### 复用网页额度，不要求 provider API Key

项目通过 Chrome 调用你已经使用的网页，而不是接入各家 API。因此不要求配置 provider API key，也不会产生本项目额外的按请求 API 费用。具体账号是否免费、额度和网页限制，仍由对应 provider 决定。

### 多模型协作

三个 provider 不只是三个可以轮流调用的网页接口，而是可以在一个有边界的工作流中分工：

```text
DeepSeek  -> executor：生成产物
ChatGPT   -> reviewer：审查产物并指出修改项
GLM       -> cross-check：独立生成第二份结果
三个模型  -> council：并行回答，再综合成决议
```

默认角色链可配置：执行使用 DeepSeek/GLM，审查使用 ChatGPT/GLM，咨询使用 DeepSeek/GLM/ChatGPT。

## 架构

```text
宿主 coding agent
  | MCP / stdio
  v
Web Agent Tools
  | CDP
  v
用户日常 Chrome：ChatGPT | DeepSeek | GLM
```

宿主 agent 保持本地执行和决策权。Web Agent Tools 负责浏览器定位、提示词边界、结果提取、机器验收、恢复和本地审计记录。

## 功能

- 不要求 provider API key：复用用户 Chrome 中已登录的网页账号。
- 支持 executor、reviewer、advisor、repair、cross-check、council 等多模型协作阶段。
- 六个 MCP 工具：状态检查、提问、审查、产物委派、并行议事和人工接管提示。
- 复用用户日常 Chrome；登录凭据和浏览器 profile 不进入本仓库。
- ChatGPT、DeepSeek、GLM 的显式 provider 路由和可配置角色链。
- JSON 与 fenced code block 的无损产物提取和机器验收。
- 有界的修复、审查、交叉校验，避免模型无限循环。
- `turns.jsonl` 事件日志和完整回答 artifact，方便事后检查。
- 多标签、登录、验证码、风控和页面漂移均 fail-closed，不猜测目标页面。
- MCP stdio 传输，每个宿主按照自己的任务生命周期启动和停止。

## 六个工具

| 工具 | 用途 |
| --- | --- |
| `web_status` | 检查三个网页的存在、登录态、输入框和生成状态。 |
| `web_ask` | 发送一个自包含问题并取得最终回答；超时后支持只读 salvage。 |
| `web_review` | 请求带严重度、问题和建议的结构化审查，并生成决策摘要。 |
| `web_delegate` | 生成 JSON 或代码产物，并执行提取、验收、修复、审查和可选交叉校验。 |
| `web_council` | 让两个或三个 provider 独立回答，再返回四字段综合结论。 |
| `web_handoff` | 页面需要登录、验证码、风控或条款操作时，给出人工处理指引。 |

这些是宿主 agent 调用的 MCP 工具，不会出现在模型选择器中，也不会替换宿主 agent 的原生执行链。

## 前置条件

- Node.js `22.5` 或更高版本。
- 运行在 CDP `http://127.0.0.1:4319` 的 Chrome。
- 每个 provider 恰好一个已登录标签页：
  - `chatgpt.com`
  - `chat.deepseek.com`
  - `chatglm.cn`

如果同一个 provider 有多个匹配标签，服务会直接报错，避免把任务发到错误会话。

## 推荐安装方式：让 Agent 自己安装

通常不需要手动输入安装命令。先启动带 CDP 的 Chrome，并手动登录三个网页，然后把下面的任务交给当前 coding agent：

```text
请从 https://github.com/aisane-454/Web-Agent-Tools 安装 Web Agent Tools。
先阅读它的 README，在本地 tools 目录中完成依赖安装和构建，按照当前客户端
注册 MCP，并设置 WEB_AGENT_CDP_URL=http://127.0.0.1:4319，最后调用
web_status 验证可用的网页。所有改动限制在 Web Agent Tools 目录内，
不要修改我的业务代码。
```

Agent 会根据当前客户端选择 Codex、ZCode 或 DeepSeek Harness 的正确注册方式。登录、验证码和风控仍需要用户在可见浏览器中处理。

## 快速开始

下面是希望手动安装时使用的备用流程。

### 1. 启动 Chrome CDP

启动包含目标账号的日常 Chrome，并开放 `4319` 端口。macOS 示例：

```sh
open -na "Google Chrome" --args --remote-debugging-port=4319
```

手动登录三个网页，并保持每个网页只留下一个匹配标签。本项目不会复制登录信息，也不会创建独立浏览器 profile。

### 2. 构建

```sh
git clone https://github.com/aisane-454/Web-Agent-Tools.git
cd Web-Agent-Tools
npm ci
npm run build
```

### 3. 注册到 Codex

```sh
codex mcp add web-agent-tools \
  --env WEB_AGENT_CDP_URL=http://127.0.0.1:4319 \
  -- node "$PWD/dist/index.js"
```

检查注册结果：

```sh
codex mcp list
```

Codex 桌面端新增或修改 MCP 后，建议新建一个任务，让任务加载最新工具列表。

### 4. 调用

```text
先调用 web_status。然后使用 web_delegate，让 DeepSeek 对下面的方案做风险审查，
输出包含 risks、mitigations、recommendation 三个字段的 JSON，不要修改本地文件。
```

其他客户端配置：

- [Codex](clients/codex.md)
- [ZCode](clients/zcode.md)
- [DeepSeek Harness](clients/dsh.md)

完整的任务示例见[使用教程](docs/USAGE.zh-CN.md)。

## 配置和日志

角色链配置：

```text
~/.web-agent-tools/config.json
```

主要环境变量：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `WEB_AGENT_CDP_URL` | `http://127.0.0.1:4319` | Chrome DevTools 地址。 |
| `WEB_AGENT_*` | 见源码 | 可选的超时和浏览器调参。 |

日志与产物：

```text
~/.web-agent-tools/logs/turns.jsonl
~/.web-agent-tools/logs/artifacts/
```

`SEND_IDEMPOTENCY_UNKNOWN` 表示提示词可能已经进入网页，禁止盲目自动重试；应先检查页面或使用 `web_ask` 的 `salvage: true`。登录、验证码、风控和条款弹窗需要通过 `web_handoff` 交给人工处理。

## 开发

```sh
npm ci
npm test
npm run smoke:mcp
```

## 设计参考

本项目参考但不复制以下开源项目：

- [codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web)：原生任务上下文、流式输出、可观测性和浏览器模型接入思路。
- [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)：插件边界、MCP 合约、能力组合和事件化工作流思路。

本项目有意保持 MCP 能力层定位，可以服务多个宿主 agent 和多个网页 provider，不改写宿主 agent 的模型路由或本地工具 runtime。

## 安全和限制

- 这是浏览器自动化，不是 provider 官方 API。
- 请使用自己的账号，并遵守各服务的条款和工作区策略。
- Chrome 登录态属于敏感信息，CDP 只应监听本机回环地址，不要暴露到网络。
- 网页 UI 变化可能导致 selector 失效；服务会显式失败，不会静默猜测页面。
- 本项目不包含账号凭据、浏览器 profile 或后台常驻服务。

## License

MIT。详见 [LICENSE](LICENSE) 和 [NOTICE.md](NOTICE.md)。
