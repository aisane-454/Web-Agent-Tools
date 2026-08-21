# 2026-08-21 旧 runtime 退役（用户拍板："旧的都关闭，就开新的"）

API 位方案（web-agent-codex-runtime，4390，模型后端伪装）全面下线；
tool 位方案（web-agent-tools，MCP 五工具）成为唯一在役链路。

退役清单：launchd 服务 bootout + plist 存档 + 4390 路由移除 + 旧插件禁用。
有趣的一笔：openai_base_url 行在我动手前已被 codex 自行清除（4390 死后
某次 exec 启动时清理），留下 6 个连续空行的删除残迹——工具自己完成了半步退役。

验证终态：端口/launchd/config 三处干净；codex exec 官方直连正常；
web-agent-tools MCP enabled 且本日两度端到端验证（web_status / 答数）。

方案对比结语：API 位换模型后端（重、需托管路由、会话状态易中毒）；
tool 位换流程节点（轻、零路由、fail-loud 可恢复）。前者退役是必然终点。
