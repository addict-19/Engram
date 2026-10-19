import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { uuidv4 } from '../../src/core/uuid.js';

describe('uuidv4', () => {
  it('输出 v4 格式', () => {
    expect(uuidv4()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it('1000 次无重复', () => {
    const s = new Set(Array.from({ length: 1000 }, () => uuidv4()));
    expect(s.size).toBe(1000);
  });
  it('不依赖全局 crypto（LAN http 场景）', () => {
    // 模块代码里不得出现 crypto 引用——用源码断言（契约测试）
    const src = readFileSync(new URL('../../src/core/uuid.ts', import.meta.url), 'utf8');
    expect(/\bcrypto\./.test(src)).toBe(false);
  });
});
