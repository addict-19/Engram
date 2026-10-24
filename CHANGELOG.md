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
- 金字塔充能与聚集升级 `gradeAndCluster`：切片分数沿 parent 链累加为各祖先充能，`directNodeHits` 中的节额外 +1 充能（自身与祖先并账）并直接触发节内聚集；切片按 precise（断崖前）> nodeCluster（同节命中 ≥ nodeClusterMin 默认 2，或节被直接命中）> chapterCluster（同章跨 ≥2 个节，直接命中节也计入）> mention 互斥归档；升级产物按档位表输出（精准/节聚集：节 body + 章 summary + 卷 summary；章聚集：章 body + 卷 summary），precise 按切片、节/章聚集按单元各出一组，祖先缺层跳过不报错，直接命中但无命中切片的节仍产出节聚集升级；parent 断链/成环安全终止。
- 高层直接命中桶 `bucketSelect`：章/卷/部及更高单元（layer≥2，节与切片由管线层分流不进本函数）按 layer 分层分桶，桶内降序、低于 floor 舍弃，对过线序列跑 `detectCliff`，断点前各条（领先档）请求 body，其余过线条目（擦线档）请求 summary 并记入 chargeSignals；每层 body+summary 合计不超过 perLayerMax（默认 2，超额按分数截掉，不产出也不计充能）；包含吸收逐级：入选单元的祖先链上有更高层、且请求形态不低于它（body > summary）的入选单元即删除（部吞卷、卷吞章、隔层同样吞，不补位），擦线祖先（summary）不吞领先后代（body），两条共存，被吞者不进 chargeSignals；reason 记 `bucket:lead:<id>` / `bucket:graze:<id>`；输出按层高到低、层内分数降序；parent 断链/成环安全终止。
- 三方去重与预算装配 `assemble`：充能产物（clusterItems）与高层桶（bucketItems）先按 id 合并为每单元一条（形态取最高 body>summary>title，同单元 body/summary 并存只留 body，reason 记最高优先来源），再与常驻比对（常驻已有形态 ≥ 合并形态即删，去重删除不计 dropped）；总 tokens 超 recallBudget（默认 8000）时按价值从低到高逐条先降形态（body→summary→title，tokens 换 UnitMap 对应值，切片与孤儿不可降）、降完仍超整条弃入 dropped，永不拆半条；价值序 = cluster 来源 > bucket 来源 → 同源内 reason 含 precise/lead 者优先 → tokens 小者优先 → 先出现者优先；final 按 UnitMap 的 ts 升序（缺 ts/孤儿排尾保持相对序），不改入参。
- PPR 临时图扩散 `pprExpand`：以本轮切片候选为种子（分数归一化为个性化向量），只在调用方传入的 nodes 上现建带权无向图、返回即丢；边权为六通道加权和——语义（注入的 vecSim，负值截 0）/ 同事件（共享任一 eventId）/ 实体（anchors∪tags 的 Jaccard）/ 同地点 / 互动对（角色两两成对的 Jaccard）/ 楼层（窗口默认 80 线性衰减）；双档预设 `PPR_WEIGHTS_SOLO`（单人卡，默认：0.25/0.25/0.25/地点 0.15/互动对 0.10/楼层 0）与 `PPR_WEIGHTS_ENSEMBLE`（多人卡：地点 0.10/互动对 0.15），`profile` 选档、`channelWeights` 逐项覆盖；α=0.15 幂迭代（至多 50 轮、L1 变化 <1e-6 提前停），无边节点质量回跳种子；输出非种子、分 >0、与任一种子 vecSim ≥ simFloor（默认 0）的补充 id，至多 maxAdd（默认 3）条。`edgeWeight` 单独导出便于核对。
- 检索管线总装 `retrieve`：rrfFuse → markAnchors → applyWeights → 可选 rerank（只送前 rerankTopN 默认 20 条，锚点命中者取 max(rerank 分, 原分)，其余用 rerank 分，段外候选原分接在其后）→ 按 units 分流（切片、不在 units 的孤儿、以及 layer 非法（<1/NaN）的 unit 都按孤儿语义进充能流；layer=1 节转 directNodeHits；layer≥2 进高层桶）→ gradeAndCluster + bucketSelect → PPR 补条（提供 pprNodes 与 vecSim 时启用；只有切片/孤儿节点参与建图，unit 类 id 不进补条也不占名额；补充切片以 mention 档、reason `ppr` 并入 clusterItems，预算内才进）→ assemble；切片本体注入项 form=body、tokens 取 UnitMap（孤儿 0）、reason=档位；基础线 `baseFloor`（默认 0.01）：切片与节候选低于此分剔除，高层桶 floor 缺省也取它（显式传入优先），纯回响补入（sources 空）的节/章不进节路径与桶路径，切片的回响补入保留保底参赛——回响按 0.6 衰减跌破基础线即自然出局（双路第一名零命中约第 3 轮掉出）；切片本体条数上限 `maxSlices`（默认 10，按分数序、PPR 补条排尾，进 assemble 前截断，超出者进 dropped 不占预算，常驻已有 body 的切片不计名额，升级产物与上层单元不受限）。返回 `{ final, dropped, grades, chargeSignals, charge }`，chargeSignals 原样透传 bucketSelect 的擦线单元 id、charge 透传 gradeAndCluster 充能表（供跨轮充能/面板）。加权层元数据类型抽出为 `WeightMeta`。
- core barrel 补齐 M2 检索管线全部导出，dist/core.js 同步重建。

### Changed
- 错误约定统一：错误码只放在 `.code`，message 不再带 `CODE: ` 前缀（vectorStore 的 `E_VEC_*`、cosine 的 `E_COS_DIM` 已去前缀）；库与向量存储的 IO 包装合并为 `errors.ts` 的 `moduleIO(fn, code, modulePrefix)`（本模块错误同对象透传，其余转码、原错误留 cause），错误码与抛错时机不变。

### Fixed
- 库：日志条数极多时 openLibrary 不再因展开传参求最大 seq 抛 RangeError；运行中追加失败后，下一次追加先补换行，避免可能残留的半行拼坏新行。
- 库：appendDelta 写盘前校验 lib/op 合法且能通过 round-trip 解析，不合法抛 `E_LIB_DELTA`，不再出现写入成功、读盘时却被静默丢弃的 delta。
- 库：openLibrary 校验 meta.json 的 id 与目录名一致，不符抛 `E_LIB_ID_MISMATCH`（手动复制/改名库目录导致的 id 分叉），listLibraries 跳过此类目录继续列出其余库；applyDeltas 内部改用无原型对象，实体 id 为 `__proto__` 时不再改写结果原型，id 为 `constructor`/`toString` 等继承键名时 update 不再凭空造实体（getState 返回值随之为无原型对象）。
- 测试护栏：crypto 零引用检查扩展到 src/core 全部源码与 dist/core.js；fnv1a32 加已知向量断言，锁定落盘哈希算法。
- 装配：`assemble` 的 opts 改为逐项取默认，调用方传 `{}` 或省略时召回池预算按默认 8000 生效，不再静默失效。
- 断崖检测：`detectCliff` 在 maxLead=0 时单元素也返回 0，保持 k ≤ maxLead 不变式。
