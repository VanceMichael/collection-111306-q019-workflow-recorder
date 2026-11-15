# 操作录制与参数化回放：核对约定

面向“业务人员示范一遍 → 可审阅的重复录入流程”的完整链路。入口：`npm run workflow-demo`，产物在 `var/workflow/`（草案 Markdown、确认后草案 JSON、回放审计报告）。

## 1. 录制（src/recorder/record.mjs + instrument.mjs）

- 探针通过 `addInitScript` 注入，只采集 `isTrusted` 的真实界面事件；鼠标坐标不入流，定位只用语义描述符（id/name/分组/标签文本/角色）。
- 探针有 record / replay / off 三态。回放期间处于 replay 态，机器人事件一律不落账；每行回放结束执行零自录校验（`assertNoSelfRecording`）。
- 同时保存初始快照、结束快照与 MutationObserver 结构摘要，作为区分输入来源的证据。

## 2. 三类输入来源（src/recorder/compiler.mjs）

| 来源 | 判定依据 | 草案中的处理 |
|------|----------|--------------|
| 主动输入 user | 可信 input/change 事件，合并同控件连续输入 | 输入步骤，记录样本值，等待人工变量/固定值裁决 |
| 控件默认值 default | 初始快照中有值且全程未被触碰 | 单列“未触碰的控件默认值”，不混入主动输入 |
| 联动派生 derived | 非可信变更（mutation/output 文本变化），如 quantity×10 的金额 | 派生断言步骤，回放只核对结果、不录入；服务端回执 output 不算派生 |

变量建议是保守的：仅对疑似单据号/数值字段建议变量，普通文字保持“未自动参数化”待人工裁决。示例订单号 `order-104` 只作为样本值展示，未经确认的绑定会在“尚不确定的输入来源”中显式列出，禁止批量回放。

## 3. 人审与确认（src/recorder/review.mjs）

- `renderMarkdown` 输出逐行可核对的 Markdown 草案（步骤、来源、样本值、绑定、操作意图、待确认项）。
- `decideBinding` 接收人工裁决（variable/constant）；`confirmDraft` 显式确认并记录核对人。
- 草案内容带 sha256 哈希，确认与哈希绑定。任何修改（含回放期人工纠正）都会使旧确认失效，必须重新确认；`batchBlockers` 是批量回放的唯一准入门。

## 4. 回放与暂停（src/recorder/replay.mjs）

- 每次 `runRow` 重新加载干净表单；定位在页面上重新解析描述符，不使用录制期选择器快照。
- 解析结果 0 命中 → `not-found` 暂停；多命中 → `ambiguous` 暂停并附全部候选与原操作意图，系统不做相似度选择。
- 人工纠正（`applyCorrection`，如显式 `occurrence` 序号）写入步骤、留痕并作废旧确认，重新确认后方可继续。
- 结构漂移（分组与录制时不一致）写入审计；提交边界步骤没有逐单确认令牌必然暂停，令牌按 rowId+stepId 校验，防止跨单复用。

## 5. 演示覆盖的情形（npm run workflow-demo）

1. 本地门户真实键盘示范录制，产出草案；
2. 人工裁决 orderNo/quantity 为变量、contact 为固定值并确认；
3. row-201 在正常门户回放，提交边界暂停后逐单确认，落单值是 order-201 而非样本 order-104；
4. 门户切换为 duplicate-name + reorder，row-307 在同名控件处歧义暂停，人工指定候选、旧确认失效、重新确认后恢复，提交前再次逐单确认；
5. 源端回执核对两行真实落单，零自录校验全部通过。
