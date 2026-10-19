// tests/core/library.appendFail.test.ts
// 单独文件：要 mock node:fs/promises 的 appendFile，不污染其他用例
import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fail = vi.hoisted(() => ({ next: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    // 模拟磁盘满：真写进去半行（无换行），然后抛错
    appendFile: async (...args: Parameters<typeof real.appendFile>) => {
      if (fail.next) {
        fail.next = false;
        const [path, data] = args;
        await real.appendFile(path, String(data).slice(0, 10), 'utf8');
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      }
      return real.appendFile(...args);
    },
  };
});

const { createLibrary, openLibrary } = await import('../../src/core/library.js');

describe('appendDelta 写入失败后的防御', () => {
  it('运行中 append 写了半行再失败，下一条成功写入的行仍完整可解析', async () => {
    const root = await mkdtemp(join(tmpdir(), 'engram-'));
    const lib = await createLibrary(root, 't');
    await lib.appendDelta({ floor: 1, lib: 'atlas', op: 'create', id: 'a', payload: { name: '港口' } });
    fail.next = true;
    await expect(lib.appendDelta({ floor: 2, lib: 'atlas', op: 'update', id: 'a', payload: { x: 1 } }))
      .rejects.toMatchObject({ code: 'E_LIB_APPEND' });
    await lib.appendDelta({ floor: 3, lib: 'atlas', op: 'update', id: 'a', payload: { weather: '雨' } });
    const lines = (await readFile(join(root, lib.id, 'log.jsonl'), 'utf8')).split('\n');
    expect(lines.filter((l) => l.includes('"weather"'))).toHaveLength(1);
    expect(() => JSON.parse(lines.find((l) => l.includes('"weather"'))!)).not.toThrow();
    const re = await openLibrary(root, lib.id);
    expect((await re.getState('atlas'))['a']).toMatchObject({ name: '港口', weather: '雨' });
  });
});
