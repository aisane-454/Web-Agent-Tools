# 2026-08-21 升级链落地：算子 #1（修复）入链 + 算子 #2（审查-修订闭环）

## 实现
- 修复兜底入链：escalation.step 事件（step=repair, trigger=reason），行为零变化。
- 算子 #2：web_delegate 新参数 review_rounds（schema 硬顶 2，默认 0=关）。
  机器验收通过后：reviewer 链审查产物（buildReviewPrompt 复用）→ packet 装配 →
  needs-changes 则 executor 修订（新 buildRevisionPrompt：任务书+发现+当前产物，
  最小化修改约束）→ 修订稿重过 parse+acceptance → 有界循环。
  修订失败保留机器验收过的上一版（升级即信号进溯源，绝不隐藏）。
  全程 escalation.step 事件 + artifact 快照（review-rN / revision-rN）。
- 测试 44/44（含 buildRevisionPrompt 形状/限额）。

## 实弹验证（median 任务，故意不提边界条件）
- deepseek 生成 1031 字符 → chatgpt 审查 51s（含 27s 的 1KB 提示词打字插入），
  6 条发现：**两个预埋缺口全中**（空数组/输入域、偶数长度中位数），另抓
  输入不可变性、错误类型、溢出边界三个未预埋问题。
- packet 判 needs-changes → 修订触发 → deepseek 修订稿（salvage 回收验证：
  空数组 ✅ 偶数平均 ✅，两缺口均修复）。
- 完整链路真实走通；唯一未达成的是窗口内返回终稿——两次重跑分别被
  客户端总预算（300s）和 deepseek 限速（生成步 240s 墙钟）截断。
  页面侧节流源于本日测试洪水（已知模式），非链路缺陷。

## 运营观察（进设计账本）
1. 多步算子的超时预算要按"级数和"给：生成+审查+修订 ≈ 40+51+40s 典型值，
   外层调用方需给足总窗口（ZCode/Codex 的 MCP toolCallTimeout 建议 ≥480s）。
2. chatgpt 大提示词打字插入慢（1KB≈27s）——insertText 是下一优化点
   （可考虑剪贴板粘贴路径，但要评估页面检测风险）。
3. 演示/验证脚本避免同页短间隔重复发送（限速放大一切超时问题）。

## 下一步（未实施）
- 算子 #3 结构化交叉验证、算子 #4 议会 synthesis（council note 里的序）。

## 补遗：insertText 优化落地 + 算子 #3 交叉验证（同日）

### 粘贴快速路径（生产验证 ✅）
基准定位：chatgpt 编辑器对直接插入指令 ~13ms/字符（1KB≈10-27s），原生粘贴管线瞬时。
实现：剪贴板 writeText + 真实 Meta+V 键事件 + 读回校验 + 失败回退 fill 路径 +
用户剪贴板保存恢复。生产实测：656 字符提示词 insert 1.6s（原路径 8-27s）。
注意：基准测试期间页面上会出现可见的重复文本输入（用户已知晓）。

### 算子 #3：结构化交叉验证（实弹：降级路径 ✅，正路径待 glm 非高峰）
- 实现：cross_check 参数 → 副生成在另一 executor 链成员上**并行**发射
  （与主流程全程并行，不同页面无租约冲突）→ 机械行级 LCS diff
  （deepseek 红线：纯比对零判断，永不合并/择优）→ 一致率 + 冲突块
  （双方节选，上限 5 块，全文进快照）→ escalation.step 事件。
- 降级设计：副生成任何失败 → secondary_error 字段，主产物零影响。
- 实弹：deepseek 主产物 18.5s ✅；glm 副生成撞晚高峰排队（RATE_LIMITED
  两轮重提耗尽）→ 优雅降级 ✅。salvage 确认页面无新答案（排队未出）。
- 测试 49/49（diff 语义：全同/单行分歧/纯插入/空白不敏感/块上限）。
- 正路径（双家出产物算一致率）待 glm 非高峰时段自然验证。

### 遗留
- glm 晚高峰排队是当前副生成的固定约束（executor 链第二位）；如需全天候
  交叉验证，可考虑 reviewer 链的 glm 或配置位调整——待真实使用数据决定。
- 算子 #4 议会 synthesis 未实施。

## 收官（同日）：算子 #4 + v1.0.0 打包

**算子 #4 web_council**：成员任务书（结论先行/三条论据/适用边界，≤400字）→
三家并行独立作答 → 汇总席（advisor 链首位，配置驱动）四字段决议
（共识/分歧/建议/少数意见，标签契约+机械提取，garbage→undefined 绝不伪造）。
实弹 106.9s：三家全出（355/333/540 字符），决议质量高——真分歧带持方
（chatgpt+glm 主 serverless vs deepseek 主 VPS 集群）、可执行建议、真少数意见。
升级链四算子至此齐备。

**v1.0.0 打包**：README 汇总（架构图/六工具表/前置/安装/教训）、版本 1.0.0、
install.sh（构建+CDP 检查+页面健康+注册指引）、git 初始化+初始提交+tag v1.0.0。
测试终态 52/52。六工具：status/ask/review/delegate/council/handoff。
