# Changelog

## [Unreleased]

### Added
- 仓库初始化：manifest.json（SillyTavern 扩展清单）、README、基础目录结构。
- 工程脚手架：TypeScript / vitest / esbuild 开发依赖与配置。
- 自带 `uuidv4()` 实现（不依赖 crypto，兼容 LAN http 环境）。
- 统一错误包装 `EngramError` / `wrapIO()` 与原子写 `writeFileAtomic()`（临时文件 + rename）。
- delta 日志核心纯函数：`applyDeltas`（create/update 浅合并/delete）、`rollbackView`（按楼层回溯视图，日志不删改）、JSONL `serializeDelta` / `parseDeltaLine`（坏行返回 null 不连坐）。
