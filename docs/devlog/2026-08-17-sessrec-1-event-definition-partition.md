# SESSREC-1 Event Definition Partition

## 完成内容

本里程碑实现Issue #7的第二个production slice：M1-B F1/F2 event-definition boundary。

- 在`packages/schema/src/event.ts`将`Event.define`改为exact `ContractResult`边界，并加入definition-level `publication: "public" | "internal"` metadata；publication不进入payload wire shape。
- 对type、publication、durable version/aggregate与schema fields执行fail-closed validation；hostile reflection、accessor、Proxy和schema construction失败均转换为closed `EventDefinitionError`。
- 冻结definition、data schema、schema field snapshot与durable metadata；非durable definition持有own、不可写的`durable: undefined`槽，阻断prototype-chain注入。
- 用module-private `WeakSet`记录F1成功创建的精确object identity；F2仅为owner-created且再次验证为literal public的definition创建`PublicEventDefinitionV1` nominal brand。
- 实现`partitionDefinitionsByPublication`：单次有限扫描、保持identity/order、检测latest/versioned duplicate key、返回冻结且互斥完备的public/internal arrays，无partial output。
- 原子迁移全部现有callers。初始`53 calls / 12 files`只覆盖namespaced `Event.define`；重新盘点后的准确原始范围为`101 calls / 32 files`：schema source 89 calls / 29 modules、旧schema event test 4 calls / 1 file、core tests 8 calls / 2 files。production/core的89+8处均通过显式module-local initialization boundary消费exact result。
- `packages/schema/src/event-manifest.ts`在source level消费F2 public partition；未提前实现F3/F31、recovery definitions、private replay manifest或runtime recovery。
- 扩展runtime/property tests，新增compile-time type fixture，并同步architecture、detailed design、subplan与expectations中的partial implementation evidence。

## 关键决策

1. `ContractResult`只在各consumer module的private initialization boundary转为固定`globalThis.Error`，不导出共享throwing helper，避免形成绕过F1 exact result的第二public API。
2. 冻结和结构相似不足以证明authority provenance。F1成功对象进入module-private weak owner registry，F2必须验证精确identity；structural lookalike、独立Effect-schema lookalike、clone与Proxy均不能取得public brand。
3. Optional security metadata不能只依赖“当前没有own property”。非durable definition必须写入own undefined slot，才能在partition和branding完成后继续永久遮蔽mutable prototype上的恶意`durable`属性。
4. F2只负责当前definition publication partition。现有public manifest消费其public结果，但F3/F31、十个`session.recovery.*` definitions、all-durable private replay closure与public committed-event service继续留在后续slice。
5. Durable version由committed `SafePositiveInt` codec decode后复用；caller不使用`as` cast，definition identity、inventory order与payload wire shape保持不变。

## 验证结果

所有手动package tests均从对应package目录运行：

- Schema focused：`bun test test/event.test.ts test/recovery-contract-foundation.test.ts`——19 passed，0 failed，267 assertions。
- Schema typecheck：`bun run typecheck`通过，包含`event.types.ts` negative fixtures。
- Schema non-manifest regression：29 passed，0 failed，289 assertions。
- Schema完整`bun test`：29 passed，2 failed；仍仅为clean D0/M1-A已经复现的`event-manifest.test.ts` count/order baseline discrepancy，未修改expected values规避。
- Core focused：`bun test test/event.test.ts test/session-history.test.ts`——50 passed，0 failed，93 assertions。
- Core typecheck：`bun run typecheck`通过。
- Core完整package：1081 passed，0 failed，142 files。
- Repository-root Turbo typecheck：30 successful / 30 total。
- Runtime manifest import：`Definitions = 88`、`ServerDefinitions = 58`，与当前runtime surface一致；baseline test仍保留旧的85/55 expectation。

机械核查确认：P1/P2 marker各恰好一次；89/89 schema source callers与8/8 core callers显式初始化；public throwing initializer为0；`event.ts`之外durable-version cast为0；schema source对`@opencode-ai/llm` import为0；本slice未新增`session.recovery.*` definition。

## 独立审查

只读独立审查按“发现→修复→回归→复审”推进：

1. 首轮发现public brand可授予frozen structural/Proxy lookalike（1 P1）；引入WeakSet精确owner identity并补三类provenance regressions。
2. 次轮发现inherited publication/durable fail-open（1 P1）、F1 source generic窄于已批准签名及provenance证据不足（2 P2）；增加own-property fail-closed检查、mapped field validation type与broad-dictionary/type regressions，并同步规范。
3. 后续两轮分别发现partition前inherited durable与partition后prototype durable injection（各1 P1）；最终由non-durable own undefined slot从根因上封闭整个生命周期。
4. Owner最终复审：`0 P0 / 0 P1 / 0 P2`。
5. Integration首轮发现subplan status/callable ledger与schema assertion counts陈旧（2 P2）；同步文档后最终复审：`0 P0 / 0 P1 / 0 P2`。

## 经验教训

- Authority brand必须绑定canonical owner创建的精确identity；`Object.freeze`、字段shape或第三方schema identity只能证明结构，不能证明来源。
- Optional authority metadata必须明确区分own absent、own undefined、inherited与accessor；若对象prototype可变，own immutable undefined slot是防止事后注入的必要边界。
- Caller inventory不能只grep一种调用语法；必须同时覆盖namespaced import、direct import、re-export alias与test consumers，并用编译/typecheck反向验证迁移完整性。
- Shell工作目录会跨命令保持；package tests必须使用显式absolute `cd`，否则可能得到“没有匹配测试”或错误scope的假通过证据。
- 测试证据应同时记录test count与executed assertion count；文档同步后仍需独立integration review，避免实现状态与旧ledger互相矛盾。

## 度量

| 指标 | 数值 |
|---|---|
| 新增代码行数 | 约1230（production 681 + tests/type fixture 549） |
| 修改代码行数 | 约52（设计/审计状态与证据文档，不含本日志） |
| 删除代码行数 | 约285（production 192 + tests 42 + docs 51） |
| 涉及文件数 | 41（production/core/schema tests/docs + 本日志） |
| 新增测试用例数 | 7个runtime/property tests + 1个compile-time fixture suite；core既有tests补wire assertions |
| 测试通过率 | focused schema 19/19；non-manifest schema 29/29；focused core 50/50；full core 1081/1081；full schema 29/31，2项为clean baseline红项 |
| 发现 bug 数 | 4个P1实现缺陷 + 1个type契约偏差 + 3个测试/文档证据缺口；另确认1个pre-existing manifest baseline discrepancy |
| 修复 bug 数 | 8个in-scope findings全部修复；baseline discrepancy保持原样并明确记录 |
| 迭代轮次 | 设计1轮 / 实现2轮 / 独立修复4轮 / integration文档修复1轮 |
