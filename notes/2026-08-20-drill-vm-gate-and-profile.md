# 2026-08-20 真实演练：语法门（层 1.5）+ 外层消耗画像

## 任务
给 runAcceptance 的 code-block 分支加真实语法解析门。全程 tool 位架构执行。

## 演练过程（每步真实委派）
1. **生成**：task_spec 438 字符 + context 561 字符 → web_delegate(deepseek) 7.6s →
   386 字符产物（精确满足规格，含非 SyntaxError 重抛）。外层本轮消耗 ≈1385 字符。
2. **集成**：外层接 amendments（TS 跳过/顶层 await 豁免——后被审查证明是错的）。
3. **审查**：web_review(chatgpt) 输入 777 字符。180s 墙钟到期报 SEND_IDEMPOTENCY_UNKNOWN；
   实际页面已生成完（2632 字符），只读补救提取。8 条发现，3 高危，核心原则：
   **无法检查 ≠ 检查通过**（三个 fail-open 豁免把"不支持"伪装成"有效"）。
4. **按审查重建**：acorn（零依赖）module 模式真解析替代 vm.Script + 三个正则/文案豁免；
   三态结果 valid/invalid/unsupported；unsupported 在 acceptance 字符串显式标注
   "syntax not checked: ts"；语言匹配精确枚举。38/38 测试含审查者给出的场景
   （import 后跟垃圾代码现在会被拦下）。

## 画像数据（R1 输入）
| 步骤 | 工位 | 外层输入 | 外层收到 | 耗时 |
|---|---|---|---|---|
| 生成 | deepseek | 999 字符 | 386 字符 | 7.6s |
| 审查 | chatgpt | 777 字符 | 2632 字符 | ~180s+（超时后补救） |
| 修复 idx-12 | deepseek | 2354 字符 | 2098 字符 | 16.7s |
| glm 代码任务 | glm | ~300 字符 | ~900 字符 | 36.7s |

初步结论：产物流量可控（任务书+产物 ≈ 1-3k 字符/步）；审查输出是最大变量
（2632 字符全量回传）。R1 的压缩对象优先级：审查结论 > 修复工位回传 > 生成产物（已最小）。

## chatgpt "限流"复盘（更正）
- 网页端无任何可见限流提示（用户确认）；此前"限流"归因于早先超时现象，是推断。
- web_status(force) 只证明页面健康（登录/输入框/无验证码），证明不了发送后会回复。
- 本次 180s 超时真相：不是限流，是**慢**——回答实际完成，晚于墙钟期限。
  处置正确：SEND_IDEMPOTENCY_UNKNOWN 不自动重发 → 事后只读补救提取成功。
- 后续改进候选：reviewer 默认墙钟延长或对 chatgpt 用更长 deadline；补救提取制度化
  （scripts/salvage-review.mjs 已有雏形）。

## 演练结论
生成/审查/修复三类工位 + 人（外层）的闭环真实可运转；审查工位抓到了外层自己的
设计错误并促成重建——这是"模型分层"设计的直接证据（reviewer 级审视 executor 级产物
与外层集成质量）。

## 补遗（同日晚）：salvage 制度化 + 内层死线修正

1. **web_ask salvage 模式**：超时后的一等公民回收动作（只读、需显式 provider、
   PROVIDER_BUSY 拒绝半成品、机会主义装配 packet）。实测 3.4s 回收 2296 字符。
2. **内层死线 bug**：watchAnswerUntilIdle 自带 180s 硬死线（WEB_AGENT_ANSWER_TIMEOUT_MS）
   先于 300s 外层墙钟爆掉（日志实证：RESPONSE_TIMEOUT @183s）。默认抬到 330s，
   外层墙钟恢复权威；死页由 240s noOutputIdle 看门狗负责。
3. **未解异常（待复现）**：web_review 服务端 183s 已正确 settle 并应答，但 MCP
   客户端 callTool 挂死未收到响应（重现条件：chatgpt 长审查 + resetTimeoutOnProgress
   + 大量 progress 通知）。已留日志线索（requestId ask_mt1r5011_01358c）。
4. **salvage 回收的审查再评估**：8 条发现均属"反损坏门 vs 目标环境认证"的已知
   权衡再确认（sourceType module 固定 / ecmaVersion latest / TS 语言标签边界），
   定位不变，不改动。fixture: review-chatgpt-acorn-live.txt。

## 补遗 2：客户端挂死异常定性 + progress 协议违规修复（同日）

**定性**：60s 受控复现未复现挂死；但复现脚本抓到确凿协议违规——服务端自造
progressToken（用内部 requestId），客户端每条阶段通知都报
"progress notification for unknown token"，且 resetTimeoutOnProgress 从未生效过。

**修复**：makeNotifier——仅当客户端在 request._meta 带 progressToken 时才发
notifications/progress，且回传客户端自己的 token；无 token 完全不发（规范要求）。
双向实测：无 onprogress → 零协议错误；带 onprogress（注意 SDK 拼写是全小写
onprogress）→ 客户端真实收到 inspect→baseline→result 阶段通知。

**原始 183s 挂死**：内层死线已修（见补遗 1）；协议违规已修。挂死本体未在受控
条件下复现，判定为与通知违规相关度最高的复合因素，转入日常使用观察。

**运营观察**：deepseek 对连续快速同款提示会显著放慢生成（一次 ask 120s 未完成），
页面随后正常完成——salvage 1.4s 回收成功。验证脚本应避免短间隔重复发送同款提示。
