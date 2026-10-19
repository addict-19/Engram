# Changelog

## [Unreleased]

### Added
- 仓库初始化：manifest.json（SillyTavern 扩展清单）、README、基础目录结构。
- 工程脚手架：TypeScript / vitest / esbuild 开发依赖与配置。
- 自带 `uuidv4()` 实现（不依赖 crypto，兼容 LAN http 环境）。
- 统一错误包装 `EngramError` / `wrapIO()` 与原子写 `writeFileAtomic()`（临时文件 + rename）。
- delta 日志核心纯函数：`applyDeltas`（create/update 浅合并/delete）、`rollbackView`（按楼层回溯视图，日志不删改）、JSONL `serializeDelta` / `parseDeltaLine`（坏行返回 null 不连坐）。实体 id 恒等于 delta.id，不会被 payload 覆盖；payload 不是普通对象的行解析时视为坏行。
- 库生命周期 `createLibrary` / `openLibrary` / `listLibraries`：`<root>/<库uuid>/` 下 meta.json（显示名，改名不动 id）、log.jsonl（appendDelta 串行追加，seq 递增，坏尾行容错）、snapshot.json（原子写快照）；`getState` 支持按楼层回滚视图，回滚点低于快照覆盖楼层时自动弃快照全量回放。IO 错误统一为 `E_LIB_*`。
