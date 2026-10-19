// tests/core/atomicWrite.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '../../src/core/atomicWrite.js';
import { wrapIO, EngramError } from '../../src/core/errors.js';

describe('writeFileAtomic', () => {
  it('写入后内容一致，且目录里没有残留临时文件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'engram-'));
    const f = join(dir, 'a.json');
    await writeFileAtomic(f, '{"v":1}');
    expect(await readFile(f, 'utf8')).toBe('{"v":1}');
    const files = await readdir(dir);
    expect(files).toEqual(['a.json']);   // 无 .tmp 残留
  });
  it('覆盖写不损坏旧内容语义（写成功才替换）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'engram-'));
    const f = join(dir, 'a.json');
    await writeFileAtomic(f, 'old');
    await writeFileAtomic(f, 'new');
    expect(await readFile(f, 'utf8')).toBe('new');
  });
});

describe('wrapIO', () => {
  it('异常被包成 EngramError 带 code，不裸奔', async () => {
    await expect(wrapIO(async () => { throw new Error('boom'); }, 'E_TEST'))
      .rejects.toSatisfy((e: unknown) => e instanceof EngramError && e.code === 'E_TEST');
  });
});
