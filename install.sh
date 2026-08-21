#!/usr/bin/env bash
# web-agent-tools 一键安装：构建 + 前置检查 + 注册指引
set -euo pipefail
cd "$(dirname "$0")"

echo "== 1/4 构建 =="
npm install --no-fund --no-audit >/dev/null && npm run build >/dev/null && echo "构建完成 (dist/index.js)"

echo "== 2/4 CDP 4319 检查 =="
if curl -sf http://127.0.0.1:4319/json/version >/dev/null 2>&1; then
  echo "CDP 4319 在线"
else
  echo "⚠ CDP 4319 未响应。先启动调试端口 Chrome："
  echo "  open -na \"Google Chrome\" --args --remote-debugging-port=4319"
fi

echo "== 3/4 页面健康 =="
node scripts/smoke-mcp.mjs || true

echo "== 4/4 客户端注册 =="
echo "ZCode : 按 clients/zcode.md 写入 .zcode/config.json"
echo "Codex : codex mcp add web-agent-tools --env WEB_AGENT_CDP_URL=http://127.0.0.1:4319 -- node \"$(pwd)/dist/index.js\""
echo "dsh   : 按 clients/dsh.md（未装则暂缓）"
