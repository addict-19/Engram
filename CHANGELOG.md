# Changelog

## [Unreleased]

### Added
- 仓库初始化：manifest.json（SillyTavern 扩展清单）、README、基础目录结构。
- 工程脚手架：TypeScript / vitest / esbuild 开发依赖与配置。
- 自带 `uuidv4()` 实现（不依赖 crypto，兼容 LAN http 环境）。
- 统一错误包装 `EngramError` / `wrapIO()` 与原子写 `writeFileAtomic()`（临时文件 + rename）。
- delta 日志核心纯函数：`applyDeltas`（create/update 浅合并/delete）、`rollbackView`（按楼层回溯视图，日志不删改）、JSONL `serializeDelta` / `parseDeltaLine`（坏行返回 null 不连坐）。实体 id 恒等于 delta.id，不会被 payload 覆盖；payload 不是普通对象的行解析时视为坏行。
- 库生命周期 `createLibrary` / `openLibrary` / `listLibraries`：`<root>/<库uuid>/` 下 meta.json（显示名，改名不动 id）、log.jsonl（appendDelta 串行追加，seq 递增，坏尾行容错）、snapshot.json（原子写快照）；`getState` 支持按楼层回滚视图，回滚点低于快照覆盖楼层时自动弃快照全量回放。IO 错误统一为 `E_LIB_*`。
- 向量存储 `VectorStore`：指纹（model/dim/quant）+ `index.json`（fingerprint+ids）+ `vectors.bin`（按 ids 顺序平铺小端 Float32），两文件均 tmp+rename 原子写，index.json 另记 `binBytes` 与 FNV-1a 32 位 `binHash` 给 bin 上完整性锁（防跨文件错位/字节损坏）；`load(dir, expected?)` 指纹不符抛 `E_VEC_FINGERPRINT` 防新旧向量混算，维度不符拒收 `E_VEC_DIM`，文件长度/结构异常 `E_VEC_CORRUPT`，IO 错误统一为 `E_VEC_*`。
- 余弦暴力检索 `normalize` / `topK`：纯函数零依赖，入库前 L2 归一化（零向量原样返回零向量），检索时点积即余弦；entry 维度与 query 不符抛 `E_COS_DIM`（不静默产出错误分数）；全量扫描 + 长度 k 最小堆，分数降序；3 万条 512 维约 15ms（测试护栏 < 500ms）。
- BM25 索引 `BM25Index`：分词器可插拔（v0 `bigramTokenizer`：汉字段二元组/孤字出单字，字母数字段小写整词），Okapi BM25（k1=1.2, b=0.75，idf 取 Lucene 恒正式）；`addAnchor` 锚点整词通道绕过分词，查询串含锚点原词（大小写/空白不敏感，英文锚点要求词边界）即精确加入候选，命中分 = anchorBoost(默认 3)×idf；同 id 再 `add` 为更新语义（替换正文、保留锚点），`remove` 连锚点一起清；`toJSON`/`fromJSON` 存 tf 与文档长度，round-trip 分数一致，格式错误抛 `E_BM25_FORMAT`；序列化带分词器指纹 `tokenizerName`（默认 `bigram-v1`），载入时不符或缺失抛 `E_BM25_TOKENIZER`，拒载并从全文重建，不让新旧分词的 term 混在一起。
- M1 地基收尾：core barrel 导出与 esbuild 构建脚本（dist/core.js）。
- 检索管线类型 `src/core/retrieval/types.ts`（Candidate / UnitInfo / UnitMap / Form / InjectionItem）与候选融合 `rrfFuse`：标准 RRF，score=Σ1/(k+rank)，rank 从 1 起、k 默认 60；按位置约定 lists[0]=bm25、lists[1]=vec，同 id 跨列表累加并合并 sources，列表内重复 id 只取最佳名次，输出降序（同分按首次出现稳定）；k 非法抛 `E_FUSE_K`，超两路抛 `E_FUSE_LISTS`。`markAnchors` 只打 `anchorHit` 标不改分。
- 加权层 `applyWeights`：@关联轻加权（默认 1.2 倍，新关联脉冲期 1.5 倍，同在两集合取脉冲不叠乘）× importance 加权（`1 + importance×0.02`，缺省按 0）得自然加权分，再与回响保底取 max（`max(自然分, 上轮分×0.6)`，自然分高时不被拉低）；上轮入选本轮无候选的 id 以保底分补入（sources 空、无 anchorHit）；输出降序（同分稳定），保留 sources/anchorHit，不改入参。
- 断崖检测 `detectCliff` / `passFloor`：通用相对领先判定器，在降序分数前 min(maxLead, n-1) 个相邻间隔里找触发强度最大的落差（ratio 与 margin 各自按阈值归一化取较强者，并列取靠前），满足 ratio（默认 1.5 倍）或 margin（默认不启用）任一即返回断档位置 k（前 k 条领先，k ≤ maxLead 默认 3），否则 0；单元素正分返回 1，空数组/全 0 返回 0；后项 ≤0 视为无穷倍领先不除零；可选 minScore 要求断点前各条不低于该分。`passFloor` 即 `score >= floor`。

### Changed
- 错误约定统一：错误码只放在 `.code`，message 不再带 `CODE: ` 前缀（vectorStore 的 `E_VEC_*`、cosine 的 `E_COS_DIM` 已去前缀）；库与向量存储的 IO 包装合并为 `errors.ts` 的 `moduleIO(fn, code, modulePrefix)`（本模块错误同对象透传，其余转码、原错误留 cause），错误码与抛错时机不变。

### Fixed
- 库：日志条数极多时 openLibrary 不再因展开传参求最大 seq 抛 RangeError；运行中追加失败后，下一次追加先补换行，避免可能残留的半行拼坏新行。
- 库：appendDelta 写盘前校验 lib/op 合法且能通过 round-trip 解析，不合法抛 `E_LIB_DELTA`，不再出现写入成功、读盘时却被静默丢弃的 delta。
- 库：openLibrary 校验 meta.json 的 id 与目录名一致，不符抛 `E_LIB_ID_MISMATCH`（手动复制/改名库目录导致的 id 分叉），listLibraries 跳过此类目录继续列出其余库；applyDeltas 内部改用无原型对象，实体 id 为 `__proto__` 时不再改写结果原型，id 为 `constructor`/`toString` 等继承键名时 update 不再凭空造实体（getState 返回值随之为无原型对象）。
- 测试护栏：crypto 零引用检查扩展到 src/core 全部源码与 dist/core.js；fnv1a32 加已知向量断言，锁定落盘哈希算法。
