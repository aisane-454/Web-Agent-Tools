# 使用教程

这份教程说明注册 MCP 之后，日常如何调用 Web Agent Tools。

## 用户需要做什么

你只需要：

1. 启动带 `127.0.0.1:4319` CDP 端口的 Chrome；
2. 在 Chrome 中登录 ChatGPT、DeepSeek、GLM；
3. 每个网页各保留一个匹配标签页；
4. 让当前的 Codex、ZCode 或 DeepSeek Harness 安装、验证和调用 MCP。

宿主 agent 仍然负责本地文件、终端命令、审批和最终决策。Web Agent Tools 负责浏览器操作和多模型协作。

## 第一次使用：先检查状态

安装完成后，新建一个任务，发送：

```text
调用 web_status，设置 force=true。告诉我 ChatGPT、DeepSeek、GLM 哪些健康，
每个页面是否可以输入，以及是否需要我进行人工操作。暂时不要向任何网页发送新问题。
```

主要字段：

- `healthy: true`：找到了对应页面并完成检查；
- `input_ready: true`：输入框可以接受任务；
- `generating: true`：页面还在生成上一条回答；
- `login_required` 或 `challenge_detected`：需要用户处理可见页面。

如果某个 provider 不可用，先确认它只打开了一个匹配标签。服务会拒绝在重复标签之间猜测目标页面。

## 调用一个网页模型

使用 `web_ask` 做提问、第二意见或短分析。提示词要自包含，因为网页模型不会自动获得宿主 agent 的隐藏上下文。

```text
调用 web_ask，provider=deepseek，提问：

“比较 SQLite WAL 模式和 rollback-journal 模式在小型桌面应用中的差异，
给出简短建议、三个取舍，以及一个会改变建议的条件。”
```

不指定 `provider` 时，工具会按配置的 advisor 链选择。需要结果可复现时，建议固定 provider。

## 审查方案或代码

使用 `web_review` 获取带严重度的问题清单：

```text
调用 web_review，provider=chatgpt。
请从取消传播和重试安全的角度审查下面的方案：

<在这里粘贴方案或代码>

用编号列出问题，每条包含严重度、位置、原因和修复建议。
如果我只需要结论、严重问题标题和统计数量，请设置 packet_only=true。
```

完整审查会保存为本地 artifact；`packet_only=true` 可以在不需要全文时减少宿主上下文。

## 让网页模型生成代码

当产物有明确格式时使用 `web_delegate`：

```text
调用 web_delegate：

task_spec：写一个 Python 脚本，从 argv 读取 CSV 文件路径，按 status 列统计行数，
输出 JSON；文件不存在或缺少 status 列时给出清晰错误。

deliverable：{ format: "code-block", language: "python" }
acceptance："parse"
override："deepseek"
```

当前版本会提取和验证代码，然后把产物返回给宿主 agent，**不会静默写入用户业务目录，也不会自行执行任意代码**。如果要落地，明确要求宿主 agent 继续使用自己的原生工具：

```text
先用 web_delegate 生成脚本。返回后，使用你的原生文件工具写入
scripts/count_status.py，再用本地终端运行测试，并汇报命令和结果。
```

这样权限和本地执行仍由 Codex/ZCode 控制。

## 让多个模型协作

### 生成后审查

```text
使用 web_delegate 完成这个实现任务，并设置 review_rounds=1。
执行模型生成代码后，让审查模型检查一次；如果有问题，让执行模型只修订一次，
最后返回机器验收通过的版本。
```

默认角色链：

| 角色 | 默认链 | 典型工作 |
| --- | --- | --- |
| Executor | DeepSeek -> GLM | 生成代码或结构化产物； |
| Reviewer | ChatGPT -> GLM | 找正确性和契约问题； |
| Advisor | DeepSeek -> GLM -> ChatGPT | 比较方案和提供第二意见。 |

### 独立交叉校验

```text
使用 web_delegate，并设置 cross_check=true。
让下一个 executor provider 独立生成第二份产物，比较两份结果；不要静默合并，
返回一致率和冲突位置。
```

### 三模型议事

```text
调用 web_council，providers=["deepseek", "chatgpt", "glm"]。
让三家独立回答这个架构问题，最后返回：共识、分歧、建议、少数意见。
```

成员会并行运行，之后由汇总席生成四字段决议；各成员的完整回答仍会保存为本地 artifact。

## 超时和安全恢复

遇到不确定发送，不能立刻重复发送。如果返回 `SEND_IDEMPOTENCY_UNKNOWN`，说明提示词可能已经进入网页：

```text
不要重发。先调用 web_status，再调用 web_ask，设置 salvage=true、
provider=deepseek，尝试回收该页面最新一条已完成回答。
```

页面需要人工处理时使用：

```text
调用 web_handoff，provider=glm，告诉我当前可见浏览器需要做什么。
不要自动重试页面。
```

常见错误：

- `PROVIDER_BUSY`：等待当前页面任务结束；
- `LOGIN_REQUIRED`、`CAPTCHA_REQUIRED`、`RISK_CONTROL`、`TERMS_DIALOG`：在可见浏览器中处理后再重试；
- `UI_DRIFT`：页面结构变化，先检查页面，不要盲目重复发送。

## 配置角色链

可以在 `~/.web-agent-tools/config.json` 中调整角色链：

```json
{
  "roles": {
    "executor": { "chain": ["deepseek", "glm"] },
    "reviewer": { "chain": ["chatgpt", "glm"] },
    "advisor": { "chain": ["deepseek", "glm", "chatgpt"] }
  }
}
```

只想固定某一次调用时，使用工具参数 `override`，不需要修改全局配置。

## 出错时看哪里

```text
~/.web-agent-tools/logs/turns.jsonl
~/.web-agent-tools/logs/artifacts/
```

`turns.jsonl` 保存生命周期事件和 fingerprint；完整回答、审查、修复和交叉校验结果会以 artifact 单独保存，需要时再读取。

## 重要边界

- MCP 工具不会出现在模型选择器中；
- 新增或修改 MCP 后，可能需要新建宿主任务；
- 除非宿主 agent 把上下文写进提示词，否则网页模型不会自动看到宿主的隐藏上下文；
- 当前版本是多 provider MCP 能力层，不是原生模型后端，也不替换 Codex 的本地工具 runtime。

