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

### Fixed
- 库：日志条数极多时 openLibrary 不再因展开传参求最大 seq 抛 RangeError；运行中追加失败后，下一次追加先补换行，避免可能残留的半行拼坏新行。
