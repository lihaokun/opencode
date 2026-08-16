# SESSREC-1 Schema Foundation

## 完成内容

本里程碑实现Issue #7的第一个production slice：M1-A scalar/nominal contract foundation。

- 在`packages/schema/src/llm.ts`建立exact `ContractResult`与八类closed recovery errors。
- 增加safe integer三层codec、七个只验证不创建的recovery authority ID codecs。
- 增加unbranded `CanonicalDigestValue` exact structural codec与25-literal `CanonicalCommitmentDomainV1` codec。
- 增加25个type-only、pairwise non-substitutable commitment output brands；未暴露runtime brand constructor、generic cast、registry或digest builder。
- 增加focused runtime/property tests与compile-time type fixtures。
- 同步D0已push及M1-A partial implementation evidence；未回填Step 5实现位置或一致结论。

## 关键决策

1. Foundation直接放在现有`@opencode-ai/schema/llm` owner module中。Package的`./*` export会把新顶层source file自动暴露为第二external subpath，因此本slice不新增并行barrel。
2. `CanonicalDigestValue`只证明unbranded envelope结构有效。`SemanticDigest`等25个commitments保持type-only，后续只能由LLM-owned closed canonical registry/builders创建。
3. Recovery IDs验证现有值但不trim、normalize或派生新ID；不符合nonempty/NFC/no-trim/no-control invariant的输入直接拒绝。
4. Effect `Schema.Struct`默认会忽略excess properties；authority-sensitive digest envelope改用exact declaration guard，并通过property descriptors避免触发accessor。

## 验证结果

从`packages/schema`目录运行：

- `bun test test/recovery-contract-foundation.test.ts`：8 passed，0 failed，207 assertions。
- `bun run typecheck`：通过，包含`recovery-contract-foundation.types.ts`的compile-time negative fixtures。
- 不含既有manifest红项的schema regression：21 passed，0 failed，233 assertions。
- 完整`bun test`：21 passed，2 failed。两项均位于未修改的`test/event-manifest.test.ts`，并在从D0 clean HEAD `085698426...`创建的独立临时clone中原样复现：expected server definition count 55但当前为58，以及对应definition slice顺序断言。该baseline discrepancy未通过修改测试或扩大Issue #7范围规避。
- Fresh read-only implementation review：首轮`0 P0 / 0 P1 / 3 P2`；后续各轮继续发现hostile reflection与revoked Proxy边界。移除超范围types、取消local-realm prototype restriction、补齐exhaustive type fixtures并为两类Proxy补回归后，最终复审为`0 P0 / 0 P1 / 0 P2`。

## 经验教训

- Exact wire contract不能依赖Effect Struct的默认excess-property行为；默认strip会把malformed输入改写成valid输出。
- 带`./*` package export的仓库中，新增顶层source file本身就是public API decision，owner barrel设计必须先检查export map。
- Nominal subtype若要累积多个brands，brand carrier必须使用per-name mapped keys；单一symbol直接存literal name会让intersection brand退化并产生错误的assignability。

## 度量

| 指标 | 数值 |
|---|---|
| 新增代码行数 | 约845（production 287 + tests 558） |
| 修改代码行数 | 约37（状态/证据/brand contract文档） |
| 删除代码行数 | 约33（替换旧状态与错误brand carrier） |
| 涉及文件数 | 8 |
| 新增测试用例数 | 8个runtime/property tests + 1个compile-time fixture suite |
| 测试通过率 | 新增8/8；相关schema regression 21/21；完整package 21/23，2项为clean D0同样失败的既有manifest红项 |
| 发现 bug 数 | 4个implementation defects + 2个scope/test gaps；另确认1个pre-existing manifest baseline discrepancy |
| 修复 bug 数 | 6个in-scope findings全部修复 |
| 迭代轮次 | 设计1轮 / 实现2轮 / 修复4轮 |
