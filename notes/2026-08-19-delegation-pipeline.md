# 委托执行流程：流水线工位替换模式

状态：**accepted 并已实施**（2026-08-19，web_delegate 上线；角色路由一并落地）
定位：这是用户原始意图的准确形态——外层 pipeline 中的**生成步骤本身**委托给网页端执行，
外层不做该步计算、只做规格与验收。区别于已实现的"咨询模式"（web_ask/web_review：
网页模型给意见、外层继续自己干）。产物类委托**无损回传**（代码/结构化数据本来紧凑，
不做语言压缩——Decision Packet 只适用于分析/意见类）。

## 一、外层 pipeline 视角（谁干什么）

```
外层模型（ZCode / Codex）
  ① 理解任务、拆解成节
  ② 逐节决策：自己做 or 委托？
       委托判据（同时满足才委托）：
       - 节的产物自包含：规格能一次写清（输入/输出/约束/验收标准）
       - 产物是"生成密集型"（写代码/长分析/批量生成）——外层自己算要烧大量 token
       - 该节不依赖仓库现场上下文（依赖的接口以文字随规格携带）
       否则自己做
  ③ web_delegate(...) 执行该节（见下）
  ④ 验收：规格核对 + 能机器验的机器验
       ├─ 通过 → 产物入 pipeline，继续下一节
       └─ 不通过 → 携验收失败输出 re-delegate（≤2 次）→ 仍失败则外层自己做（降级兜底）
  ⑤ 汇总、集成、收尾（外层）
```

## 二、单次委托内部流程（服务端视角）

```
外层调用: web_delegate({
  task_spec:    任务规格（做什么、输入、输出、硬约束）
  context:      该节所需的外层已知信息（依赖的接口签名、代码片段、约定）
  deliverable:  产物契约（如 { format: "code-block", language: "ts" } 或 JSON schema）
  acceptance:   验收规则（"tsc --noEmit 通过" / "输出解析为 JSON" / "无解释文字"）
  providers:    执行方优先级（如 ["deepseek", "glm"]）
})

服务端:
  1. 选执行方：健康检查 → 按优先级取首个健康者；全不健康 → 明确报错（外层自己做）
  2. 组装任务书：规格 + context + 产物契约 + "只返回契约形态的产物，不要解释"
                → 单一自包含 prompt（服务端模板，格式统一）
  3. 驱动网页：粘贴 → 发送 → 等完成 → 提取全文（现有 CDP 链路，不变）
  4. 产物解析：按契约提取（如第一个 ```ts 代码块）
       ├─ 成功 → 产物
       └─ 失败（夹带解释/形态不符）→ 附修正指令重试一轮（"只输出代码块"）
  5. 机器验收（能自动的）：语法 parse / JSON schema / 可选 tsc
  6. 回传（紧凑、无损）：
       { deliverable: <产物本体>, provider, durationMs,
         acceptance: "passed" | "failed:<原因+输出>", raw_ref }
       raw_ref = 原文留在服务端（turns.jsonl），外层要细节再取
  7. 失败语义沿用现行封闭错误码：SEND_IDEMPOTENCY_UNKNOWN 不自动重发等
```

## 三、失败路径（全部显式，无静默降级）

| 故障 | 处理 |
|---|---|
| 网页登录/风控/不健康 | 依优先级换下一执行方；全败 → 报错，外层自己做 |
| 发送状态不确定 | 沿用 SEND_IDEMPOTENCY_UNKNOWN，绝不自动重发 |
| 产物形态不符 | 带修正指令重试一轮；仍不符 → 回传 failed + 原文 ref |
| 机器验收不过 | 回传 failed + 验收输出；外层决定 re-delegate 或自己修 |
| re-delegate 上限 | ≤2 次，之后外层兜底自己做（流水线不因网页端卡死） |

## 四、具体例子走一遍

任务：为 branch-zcode 写 `parseReviewItems(text): ReviewItem[]`（从网页审查长文提取结构化条目）

```
外层拆节：① 函数实现 ② 单元测试 ③ 仓库集成
决策：①②自包含、生成密集 → 委托（可两路并行）；③依赖仓库现场 → 自己做
委托①：spec=输入输出+类型定义, 契约=单个 ts 代码块, 验收=语法 parse 通过, providers=[deepseek]
委托②：spec=针对①签名写 5 用例（含边界）, 契约=ts 块, providers=[glm]（并行）
回收：两个代码块直接入库位；外层抽查接口匹配 → 集成 → 跑测试
token 账：外层只花"两份规格 + 读两个代码块 + 验收集成"；生成大头在网页订阅里
```

## 五、与现有资产的关系

- `web_ask` / `web_review`（咨询模式）保留——意见/分析类场景仍最优
- `web_delegate` 为新核心工具；`web_status`/`web_handoff` 原样复用
- CDP 驱动层（cdpWorker/selectors/lease/turnLog）原样复用，新增的只是
  任务书模板、产物解析器、验收器三段（纯函数，挂在 post-execute 位置）
- 决策权全部在外层（选节、规格、验收、降级），服务端不充当第二个 agent
  ——与 dsh "provider selection is config"、"one-shot fail-closed" 一致

## 六、实施记录（2026-08-19）

**角色路由**（src/roles.ts）：executor=[deepseek,glm] / reviewer=[chatgpt,glm] /
advisor=[deepseek,glm,chatgpt]；配置文件 `~/.web-agent-tools/config.json` 的 roles
字段可覆盖；failover 仅在**发送前**基础设施错误时走链内下一个（SEND_IDEMPOTENCY_UNKNOWN
语义绝不静默换人重发）。web_ask / web_review 的 provider 参数变为可选（缺省走角色链）。

**web_delegate**（src/delegate.ts + index.ts 注册）：
- 任务书模板：规格+context+产物契约+"只返回产物"
- 产物解析：code-block（fence 提取 + DOM 噪声清理，见下）/ json（直接/fence/平衡花括号三级提取）
- 契约违背：同一 provider 页面带修正指令重试一轮（页面保留上下文）
- 机器验收：json=parse+required_keys；code-block=花括号平衡
- 网页代码块工具栏按钮文字（"ts/复制/下载"）会混入 DOM fallback 文本——
  stripUiNoise() 清理首尾噪声行（DeepSeek 实测）

**真实验证（全部通过）**：
- code-block 委托：slugify 函数 16.6s（发现噪声→修复）；clamp 一行函数 11s 零噪声
- json 委托：函数元数据 13.2s，required_keys 验收通过，产物即标准 JSON
- advisor 链回归：web_ask 无 provider 参数 7.6s 返回
- 执行方均为 deepseek（executor 链首选），全程 turns.jsonl 留痕（含 role.fallback 事件）

## 七、GLM 提取问题追查记录（2026-08-19 深夜）

用户观察到 GLM 代码块有两个复制键（最左"复制"=纯文本；旁边"复制 markdown"=GLM 自己的
markdown 渲染）。追查链：glm copy 选择器宽泛匹配（.answer .copy 等）从未命中可点键 →
waitFor 2s 超时 → 静默落入 DOM fallback（innerText）→ 按钮文字+渲染层弯引号/断行混入。

修复：selectors.ts 的 glm.copy 改为 `.answer div.copy-button:not(:has-text('markdown'))`
优先（代码块头部纯复制键）+ stripUiNoise 扩展（语言名+按钮组合词如 "ts复制"）。

修复后实测：
- **短代码产物完全干净**（chunk 函数：直引号、格式完好、JSDoc 完整）✅
- **长代码产物仍碎**：GLM 前端把长代码块**分段渲染**（一个 6.8k 文件被切成多个
  400-600 字符的 pre），copy/textContent/innerText 任何路径拿到的都是碎片段 +
  多行字符串处断行退化。此为 GLM 渲染层限制，不可在提取侧修复。

裁决：**executor 维持 deepseek 首选**（提取稳定是硬门槛）；glm 修复后内容质量
（接口遵从、用例设计）已优于 deepseek，但长产物提取不可靠 → glm 适合短委托、
审查（reviewer 链现役）、以及 advisor。若未来 GLM 修复长代码渲染可重测。

## 八、两级修复管线验证（2026-08-19 深夜，用户提议）

提议：GLM 碎掉的长代码 → deepseek 自动修复重组。

实测链路：glm 生成 6.8k 测试文件（格式损坏：弯引号/断行/首部噪声）→ 从页面回收
（不重发，遵守防重复契约；GLM 生成超 180s watch 上限时等待页面完成后只读提取）→
deepseek 修复委托（弯引号还原/断行整理/去噪/不编造缺失）→ 机器验收。

结果对比：
- 纯 deepseek 单家：9 测 2 过（22%），需人工修 10 分钟
- glm 生成 + deepseek 修复：15 测 15 过（100%），零人工

结论：**修复管线成立且值得用**——GLM 的内容质量优势（接口遵从/用例设计）+
deepseek 的格式还原能力组合，超过任何单家。附带产出三个修复：
1. web_delegate context 上限 4000→12000（真实委托两度撞墙）+ 任务书 16k 总长保护
2. JSON 验收漏数组（typeof object 不排除 Array.isArray）——glm 用例抓出的真实现缺陷
3. GLM 长生成撞 180s watch 上限的 salvage 模式验证：等待+只读回收，绝不重发

角色结论修订：glm 在"生成"位的价值经修复管线兑现——长委托可用
glm→deepseek 管线（外层编排两级 web_delegate），executor 单发仍 deepseek。

## 九、GLM 页面渲染专项适配（2026-08-19 深夜，用户提议"web agent 参与最少"）

侦察结论（DOM 实证）：
- 排队横幅：`span.vip-limit-text`（"高峰期排队中…"）——免费档高峰期 turn 静默停滞，
  GLM 官方恢复路径是"重新提交/重新生成"按钮（恢复本轮，非重复 prompt，安全可自动化）
- 长代码分段渲染：一份长文件被 GLM 前端切成多个 <pre>
- 弯引号/字符串断行的真正源头：GLM 流式生成管线（DOM 里就是坏的，非提取层问题）

落地四层适配（参与程度递减）：
1. **排队检测+自动恢复**（cdpWorker watch）：检测 vip-limit-text → 点击官方"重新提交"
   （≤2 次）→ 仍停滞报新错误码 RATE_LIMITED（fail-loud，外层换 provider/告知用户）
2. **滚动收集提取器**（collectGlmAnswer）：强制滚动渲染全部分段 → 按 DOM 序重组
   （pre.textContent 包 fence + 段落 innerText）——解决分段与丢失，短长通吃
3. **弯引号机械规范化**（delegate.parseDeliverable）：代码产物 “”'' → "'"
   （离线验证：真实坏产物弯引号清零；9/9 回归通过）
4. **断行语义修复**：GLM 流式管线对多行字符串数组的损坏无法机械还原——
   这是 glm→deepseek 两级修复管线（§八）必须存在的最后理由

最终 GLM 长代码委托配方：scroll-collect（完整性）+ 引号规范化（机械）+
deepseek 修复级（语义断行）。单发短产物（无复杂字符串）GLM 可独立完成。

## 十、零成本提取器测试法（2026-08-19，用户纠偏）

用户指出：提取器验证不必重复发消息——坏样本在本地、页面历史答案 DOM 还在，
两层都可零成本测。立即落地：

1. **fixtures 资产**：fixtures/glm-broken-recovered.txt（4075 字符真实回收样本）、
   fixtures/glm-smartquote-multiline.txt（弯引号+断行特征样本）——parseDeliverable
   离线回归，不打网页。
2. **只读 DOM 测试**：collectGlmAnswer 对页面现存历史答案随便跑（只读，零发送）。

零成本测试当场抓出两个真 bug（此前真发消息从未暴露）：
- "取最后一个 .answer"会拿到 GLM 的短确认回复（"Only 8 test cases…"48 字符，
  目标代码在它前面）；
- 收紧为"含非空 pre"仍被空 pre 钻空。

根治：**索引对齐**——watch 观察者已数过 assistant-selector 集合
（baseline.count → after.count），把新答案索引直接传给提取器
（turn.ts → copyLatestAnswer(answerIndex) → collectGlmAnswer），彻底不猜。
只读终验：12 条 wraps 中 index 10 精确命中 6515 字符目标长答案，完整无碎。

方法论结论：**提取层迭代一律 fixtures + 只读 DOM 驱动；真实网页调用只留给
端到端冒烟**。
