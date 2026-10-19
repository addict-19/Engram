// tests/core/library.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, appendFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLibrary, openLibrary, listLibraries } from '../../src/core/library.js';

describe('library 生命周期', () => {
  it('create→open round-trip，meta 显示名保留，uuid 目录名合法', async () => {
    const root = await mkdtemp(join(tmpdir(), 'engram-'));
    const lib = await createLibrary(root, '测试世界线①');
    expect(lib.id).toMatch(/^[0-9a-f-]{36}$/);
    const re = await openLibrary(root, lib.id);
    expect(re.displayName).toBe('测试世界线①');
    expect((await listLibraries(root))[0]).toMatchObject({ id: lib.id, displayName: '测试世界线①' });
  });

  it('appendDelta 分配递增 seq，getState 正确回放', async () => {
    const root = await mkdtemp(join(tmpdir(), 'engram-'));
    const lib = await createLibrary(root, 't');
    const d1 = await lib.appendDelta({ floor: 1, lib: 'treasury', op: 'create', id: 'ring', payload: { title: '戒指' } });
    const d2 = await lib.appendDelta({ floor: 2, lib: 'treasury', op: 'update', id: 'ring', payload: { count: 2 } });
    expect(d2.seq).toBe(d1.seq + 1);
    const state = await lib.getState('treasury');
    expect(state['ring']).toMatchObject({ title: '戒指', count: 2 });
  });

  it('maxFloor 回滚视图：删楼后旧状态恢复', async () => {
    const root = await mkdtemp(join(tmpdir(), 'engram-'));
    const lib = await createLibrary(root, 't');
    await lib.appendDelta({ floor: 1, lib: 'treasury', op: 'create', id: 'ring', payload: { count: 1 } });
    await lib.appendDelta({ floor: 5, lib: 'treasury', op: 'update', id: 'ring', payload: { count: 9 } });
    expect((await lib.getState('treasury', 4))['ring']).toMatchObject({ count: 1 });
  });

  it('writeSnapshot 后重开库，状态不变且日志坏行不连坐', async () => {
    const root = await mkdtemp(join(tmpdir(), 'engram-'));
    const lib = await createLibrary(root, 't');
    await lib.appendDelta({ floor: 1, lib: 'persona', op: 'create', id: 'p1', payload: { name: 'Samir' } });
    await lib.writeSnapshot();
    await lib.appendDelta({ floor: 2, lib: 'persona', op: 'update', id: 'p1', payload: { mood: '不安' } });
    const re = await openLibrary(root, lib.id);
    expect((await re.getState('persona'))['p1']).toMatchObject({ name: 'Samir', mood: '不安' });
  });
});

describe('library 补充行为', () => {
  it('maxFloor 低于快照覆盖楼层时弃快照，从全量日志回放', async () => {
    const root = await mkdtemp(join(tmpdir(), 'engram-'));
    const lib = await createLibrary(root, 't');
    await lib.appendDelta({ floor: 1, lib: 'treasury', op: 'create', id: 'ring', payload: { count: 1 } });
    await lib.appendDelta({ floor: 5, lib: 'treasury', op: 'update', id: 'ring', payload: { count: 9 } });
    await lib.writeSnapshot();
    expect((await lib.getState('treasury'))['ring']).toMatchObject({ count: 9 });
    expect((await lib.getState('treasury', 4))['ring']).toMatchObject({ count: 1 });
    const re = await openLibrary(root, lib.id);
    expect((await re.getState('treasury', 4))['ring']).toMatchObject({ count: 1 });
    expect((await re.getState('treasury', 0))['ring']).toBeUndefined();
  });

  it('日志坏尾行被丢弃，之后追加的行仍可读，seq 接续', async () => {
    const root = await mkdtemp(join(tmpdir(), 'engram-'));
    const lib = await createLibrary(root, 't');
    const d1 = await lib.appendDelta({ floor: 1, lib: 'atlas', op: 'create', id: 'a', payload: { name: '港口' } });
    // 模拟崩溃：写了半行、没有换行
    await appendFile(join(root, lib.id, 'log.jsonl'), '{"seq":99,"floor":2,"li', 'utf8');
    const re = await openLibrary(root, lib.id);
    const d2 = await re.appendDelta({ floor: 2, lib: 'atlas', op: 'update', id: 'a', payload: { weather: '雨' } });
    expect(d2.seq).toBe(d1.seq + 1);
    const again = await openLibrary(root, lib.id);
    expect((await again.getState('atlas'))['a']).toMatchObject({ name: '港口', weather: '雨' });
  });

  it('并发 appendDelta 串行化：seq 唯一且每行完整', async () => {
    const root = await mkdtemp(join(tmpdir(), 'engram-'));
    const lib = await createLibrary(root, 't');
    const ds = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        lib.appendDelta({ floor: i, lib: 'knowledge', op: 'create', id: `k${i}`, payload: { n: i } })),
    );
    expect(new Set(ds.map((d) => d.seq)).size).toBe(50);
    const lines = (await readFile(join(root, lib.id, 'log.jsonl'), 'utf8')).split('\n').filter(Boolean);
    expect(lines).toHaveLength(50);
    lines.forEach((l) => expect(() => JSON.parse(l)).not.toThrow());
    expect(Object.keys(await lib.getState('knowledge'))).toHaveLength(50);
  });

  it('renameLibrary 只改显示名，id 不变，重开可见', async () => {
    const root = await mkdtemp(join(tmpdir(), 'engram-'));
    const lib = await createLibrary(root, '旧名');
    await lib.renameLibrary('新名');
    expect(lib.displayName).toBe('新名');
    const re = await openLibrary(root, lib.id);
    expect(re.id).toBe(lib.id);
    expect(re.displayName).toBe('新名');
  });

  it('openLibrary 拒绝非 uuid 的 libId（防路径穿越），不存在的库报 E_LIB_ 错误', async () => {
    const root = await mkdtemp(join(tmpdir(), 'engram-'));
    await expect(openLibrary(root, '../etc')).rejects.toMatchObject({ code: expect.stringMatching(/^E_LIB_/) });
    await expect(openLibrary(root, '00000000-0000-4000-8000-000000000000'))
      .rejects.toMatchObject({ code: expect.stringMatching(/^E_LIB_/) });
  });

  it('listLibraries：空根目录返回空数组，坏目录跳过', async () => {
    const root = await mkdtemp(join(tmpdir(), 'engram-'));
    expect(await listLibraries(root)).toEqual([]);
    expect(await listLibraries(join(root, 'nope'))).toEqual([]);
    const a = await createLibrary(root, 'A');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'junk'));
    const list = await listLibraries(root);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: a.id, displayName: 'A' });
  });
});
