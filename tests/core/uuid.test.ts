import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { uuidv4 } from '../../src/core/uuid.js';

describe('uuidv4', () => {
  it('输出 v4 格式', () => {
    expect(uuidv4()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it('1000 次无重复', () => {
    const s = new Set(Array.from({ length: 1000 }, () => uuidv4()));
    expect(s.size).toBe(1000);
  });
  it('不依赖 crypto（LAN http 场景）：src/core 全部源码与 dist/core.js 零引用', () => {
    // 契约测试：任何 core 模块或打包产物里出现 crypto 字样都算违约
    const coreDir = new URL('../../src/core/', import.meta.url);
    const files = readdirSync(coreDir).filter((f) => f.endsWith('.ts')).map((f) => new URL(f, coreDir));
    files.push(new URL('../../dist/core.js', import.meta.url));
    for (const f of files) expect(/\bcrypto\b/.test(readFileSync(f, 'utf8')), f.pathname).toBe(false);
  });
});
