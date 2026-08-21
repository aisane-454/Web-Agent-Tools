# Web Agent Tools

Reuse your web access and let ChatGPT, DeepSeek, and GLM work together as MCP tools for local coding agents.

[![Node.js](https://img.shields.io/badge/node-%3E%3D22.5-339933.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**English** | [简体中文](README.zh-CN.md)

Web Agent Tools is a local-first MCP server for delegating self-contained questions, reviews, and bounded deliverables to web AI pages that are already open in the user's everyday Chrome profile.

It is a **capability layer**, not another coding-agent runtime and not a model API proxy. Codex, ZCode, DeepSeek Harness, or another MCP client remains the task owner; this project gives that host a small, auditable interface to web-based intelligence.

### Web access, no provider API key

The project talks to the web pages you already use through Chrome. It does not require provider API keys or add per-request API billing. Whether an individual provider account is free or paid, and what quotas or web limits apply, is still determined by that provider.

### Multi-model collaboration

The three providers are not treated as interchangeable one-shot endpoints. They can take different roles in one bounded workflow:

```text
DeepSeek  -> executor: generate a deliverable
ChatGPT   -> reviewer: inspect it and identify changes
GLM       -> cross-check: independently produce a second result
All three -> council: answer in parallel, then synthesize a decision
```

The default role chains are configurable: DeepSeek/GLM for execution, ChatGPT/GLM for review, and DeepSeek/GLM/ChatGPT for advice.

## Why this project

Many coding agents are excellent at local execution but do not expose every web model a user already has access to. Web Agent Tools keeps those responsibilities separate:

```text
Host coding agent
  | MCP / stdio
  v
Web Agent Tools
  | CDP
  v
User's Chrome: ChatGPT | DeepSeek | GLM
```

The host agent keeps control of the workspace, tools, approvals, and final decisions. Web Agent Tools handles browser targeting, bounded prompts, extraction, validation, recovery, and local audit artifacts.

## Features

- No provider API key required: reuse signed-in web accounts in the user's Chrome.
- Multi-model workflows with executor, reviewer, advisor, repair, cross-check, and council stages.
- Six MCP tools for status checks, questions, reviews, deliverables, council-style comparison, and human handoff.
- Works with the user's existing Chrome session; credentials and browser profiles stay outside this repository.
- Explicit provider routing for ChatGPT, DeepSeek, and GLM, with configurable role chains.
- Lossless deliverable extraction with machine acceptance for JSON and fenced code blocks.
- Bounded repair, review, and cross-check stages instead of unbounded model loops.
- Append-only turn logs and full answer artifacts for later inspection.
- Fail-closed browser behavior: ambiguous tabs, login prompts, risk checks, and uncertain sends become explicit errors.
- MCP stdio transport, so each host can start and stop the server with its own task lifecycle.

## Tools

| Tool | Use it for |
| --- | --- |
| `web_status` | Check the three browser surfaces, login state, composer readiness, and generation state. |
| `web_ask` | Ask one self-contained question and receive the final answer. Supports read-only salvage after a timeout. |
| `web_review` | Request a structured review with severity, findings, and a compact decision packet. |
| `web_delegate` | Produce a bounded JSON or code deliverable with extraction, acceptance, repair, review, and optional cross-check. |
| `web_council` | Ask two or three providers independently and return a four-field synthesis. |
| `web_handoff` | Explain the manual action required when a page needs login, CAPTCHA, risk-control, or terms handling. |

The tools are called by the host agent. They do not appear as models in a model picker and they do not replace the host agent's native execution loop.

## Requirements

- Node.js `22.5` or newer.
- Chrome running with a DevTools Protocol endpoint, normally `http://127.0.0.1:4319`.
- One signed-in tab for each provider:
  - `chatgpt.com`
  - `chat.deepseek.com`
  - `chatglm.cn`

The server deliberately fails when multiple tabs match the same provider. This avoids silently sending a task to the wrong conversation.

## Quick start

### 1. Start Chrome with CDP

Start the Chrome installation that contains the accounts you want to use and expose CDP on port `4319`. For a standard macOS installation:

```sh
open -na "Google Chrome" --args --remote-debugging-port=4319
```

Keep exactly one matching tab per provider, sign in manually, and leave those tabs open. The server does not copy credentials or create a managed browser profile.

### 2. Build the MCP server

```sh
git clone https://github.com/aisane-454/Web-Agent-Tools.git
cd Web-Agent-Tools
npm ci
npm run build
```

### 3. Register it in Codex

```sh
codex mcp add web-agent-tools \
  --env WEB_AGENT_CDP_URL=http://127.0.0.1:4319 \
  -- node "$PWD/dist/index.js"
```

Check the registration:

```sh
codex mcp list
```

For the desktop app, start a new Codex task after adding or changing an MCP server so the task loads the current tool list.

### 4. Use it from the host agent

Example request:

```text
Call web_status first. Then use web_delegate to ask DeepSeek to produce
a JSON risk review of the following plan. Require keys: risks, mitigations,
and recommendation. Do not modify local files.
```

Other clients are documented here:

- [Codex](clients/codex.md)
- [ZCode](clients/zcode.md)
- [DeepSeek Harness](clients/dsh.md)

## Configuration

Provider role chains are configured in:

```text
~/.web-agent-tools/config.json
```

The main environment variables are:

| Variable | Default | Purpose |
| --- | --- | --- |
| `WEB_AGENT_CDP_URL` | `http://127.0.0.1:4319` | Chrome DevTools endpoint. |
| `WEB_AGENT_*` | See source | Optional timeout and browser tuning values. |

The provider registry and role chains are intentionally configuration-driven so additional web providers can be added without changing the MCP contract.

## Error and recovery behavior

The server does not blindly retry browser sends. In particular:

- `SEND_IDEMPOTENCY_UNKNOWN` means the prompt may already have reached the page. Inspect the visible page or use `web_ask` with `salvage: true` before considering another send.
- `LOGIN_REQUIRED`, `CAPTCHA_REQUIRED`, `RISK_CONTROL`, and `TERMS_DIALOG` require a human action in the visible browser. Use `web_handoff` for the exact guidance.
- `PROVIDER_BUSY` means another call owns that provider surface.
- `UI_DRIFT`, `RESPONSE_TIMEOUT`, and `BROWSER_STEP_TIMEOUT` are explicit failures that can be investigated or retried according to the caller's policy.

Turn metadata is written to:

```text
~/.web-agent-tools/logs/turns.jsonl
~/.web-agent-tools/logs/artifacts/
```

Logs contain fingerprints and structured metadata; answer artifacts are kept separately so the host can pull them when needed.

## Development

```sh
npm ci
npm test
npm run smoke:mcp
```

`npm test` runs the zero-cost regression suite. `npm run smoke:mcp` builds the server and checks the MCP surface; browser smoke tests additionally require a reachable CDP endpoint and signed-in pages.

## Design notes

This project is informed by several open-source projects, but it is not a fork or a replacement for them:

- [codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web): native task context, streaming, observability, and browser-backed model integration patterns.
- [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness): plugin boundaries, MCP contracts, explicit capability composition, and event-oriented workflows.

The important boundary here is intentional: Web Agent Tools remains an MCP capability layer that can serve multiple host agents and multiple web providers. It does not rewrite the host agent's model routing or local tool runtime.

## Security and limitations

- This is browser automation, not an official provider API.
- Use your own accounts and comply with each provider's terms and workspace policies.
- Your Chrome login state is sensitive. Keep the CDP endpoint on loopback and do not expose it to a network.
- Web UI changes can break selectors. The server is designed to fail explicitly rather than silently target an unknown page.
- The project does not ship credentials, browser profiles, or a background service.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md) for attribution and third-party design references.
