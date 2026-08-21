# Usage Tutorial

This guide shows the normal workflow after Web Agent Tools is registered as an MCP server.

## What the user does

You only need to:

1. Start Chrome with CDP on `127.0.0.1:4319`.
2. Sign in to ChatGPT, DeepSeek, and GLM in Chrome.
3. Leave one matching tab open for each provider.
4. Ask your host coding agent to install, verify, and use the MCP tools.

The host agent remains responsible for local files, commands, approvals, and final decisions. Web Agent Tools is the browser and multi-model layer.

## First run

After installation, start a new task and say:

```text
Call web_status with force=true. Report which of ChatGPT, DeepSeek, and GLM
are healthy, whether each page is ready, and what human action is required.
Do not send a new prompt to any provider yet.
```

Expected behavior:

- `healthy: true` means the provider page was found and inspected.
- `input_ready: true` means the composer can accept a task.
- `generating: true` means another answer is still being produced.
- `login_required` or `challenge_detected` means the user must handle the visible page.

If a provider is missing, check that exactly one matching tab exists. The server intentionally refuses to guess between duplicate tabs.

## Ask one web model

Use `web_ask` for a question, second opinion, or short analysis. Keep the prompt self-contained because the web page does not automatically share the host agent's hidden context.

```text
Call web_ask with provider=deepseek and ask:

"Compare SQLite WAL mode and rollback-journal mode for a small desktop app.
Give a concise recommendation, three trade-offs, and one condition where the
recommendation changes."
```

Omit `provider` when you want the configured advisor chain to select one. Pin a provider when reproducibility matters.

## Review a plan or code snippet

Use `web_review` when you want findings rather than a general answer:

```text
Call web_review with provider=chatgpt.
Review the following plan with focus on cancellation and retry safety:

<paste the plan or code here>

Return numbered findings with severity, location, explanation, and a fix.
Use packet_only=true if I only need the verdict, high-severity titles, and counts.
```

The full review is stored as a local artifact. `packet_only=true` keeps the host context small when the full text is not needed immediately.

## Generate a code deliverable

Use `web_delegate` when the output has a clear shape. Tell the host agent to keep the task bounded and specify the deliverable format:

```text
Call web_delegate with:

task_spec: "Write a Python script that reads a CSV file path from argv,
counts rows by the status column, and prints a JSON object. Include a helpful
error for a missing file or missing status column."

deliverable: { format: "code-block", language: "python" }
acceptance: "parse"
override: "deepseek"
```

The current MCP release extracts and validates the code, then returns it to the host agent. It does **not** silently write into the user's application or execute arbitrary code. To complete the local part, say:

```text
Use web_delegate to generate the script. After it returns, use your native
file tool to write it to scripts/count_status.py, run the appropriate local
test, and report the command and result.
```

This separation keeps the host agent in charge of permissions and local execution.

## Use multiple models in one task

### Bounded generation plus review

Ask the host to use the executor chain, then enable one review round:

```text
Use web_delegate for this implementation task with review_rounds=1.
After the executor produces the code, let the reviewer inspect it and let the
executor revise it once if needed. Return the final accepted code only.
```

The default roles are:

| Role | Default chain | Typical job |
| --- | --- | --- |
| Executor | DeepSeek -> GLM | Generate code or structured output. |
| Reviewer | ChatGPT -> GLM | Find correctness and contract issues. |
| Advisor | DeepSeek -> GLM -> ChatGPT | Compare options and give a second opinion. |

### Independent cross-check

For work where two independent answers are useful:

```text
Use web_delegate with cross_check=true. Compare the primary deliverable with
an independently generated deliverable from the next executor provider. Do
not merge them silently; report the agreement ratio and conflicts.
```

### Council mode

For architecture choices or ambiguous questions:

```text
Call web_council with providers=["deepseek", "chatgpt", "glm"] and ask all
three to answer independently. Return the synthesized consensus, disputes,
recommendation, and minority opinion.
```

The members run in parallel, then a synthesis seat produces the four-field decision. Full member answers remain available as local artifacts.

## Timeouts and safe recovery

Never immediately resend after an uncertain send. If a call returns `SEND_IDEMPOTENCY_UNKNOWN`, the prompt may already be in the page:

```text
Do not resend. First call web_status. Then call web_ask with
salvage=true and provider=deepseek to recover the latest completed answer.
```

Use `web_handoff` when the page needs a human action:

```text
Call web_handoff with provider=glm and tell me exactly what I need to do in
the visible browser. Do not retry the page automatically.
```

Typical meanings:

- `PROVIDER_BUSY`: wait for the current page turn to finish.
- `LOGIN_REQUIRED`, `CAPTCHA_REQUIRED`, `RISK_CONTROL`, `TERMS_DIALOG`: act in the visible browser, then retry.
- `UI_DRIFT`: the page changed or the selector no longer matches; inspect before retrying.

## Configuration

Role chains can be customized in `~/.web-agent-tools/config.json`:

```json
{
  "roles": {
    "executor": { "chain": ["deepseek", "glm"] },
    "reviewer": { "chain": ["chatgpt", "glm"] },
    "advisor": { "chain": ["deepseek", "glm", "chatgpt"] }
  }
}
```

Use `override` on a single call when you need one fixed provider without changing the global chains.

## Where to look when something fails

```text
~/.web-agent-tools/logs/turns.jsonl
~/.web-agent-tools/logs/artifacts/
```

`turns.jsonl` contains structured lifecycle events and fingerprints. Full answers, reviews, repairs, and cross-checks are stored as separate artifacts so the host can retrieve them on demand.

## Important boundaries

- MCP tools do not appear in the model picker.
- A new host task may be required after adding or changing an MCP server.
- The web provider does not receive the host agent's hidden context unless the host includes it in the prompt.
- The current release is a multi-provider MCP capability layer, not a native model backend and not a replacement for Codex's local tool runtime.

