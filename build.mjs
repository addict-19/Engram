// esbuild 构建脚本：本期只把 core barrel 打成 dist/core.js 验证打包链路
// （酒馆入口 dist/index.js 由接壳计划产出）
import { build } from 'esbuild';

await build({
  entryPoints: ['src/core/index.ts'],
  outfile: 'dist/core.js',
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'node',
  logLevel: 'info',
});
