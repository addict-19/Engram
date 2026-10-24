// tests/core/library.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, appendFile, readFile, cp, rename } from 'node:fs/promises';
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

describe('meta.id 与目录名一致性', () => {
  it('复制库目录到新 uuid 名后 openLibrary 抛 E_LIB_ID_MISMATCH，原库不受影响', async () => {
    const root = await mkdtemp(join(tmpdir(), 'engram-'));
    const a = await createLibrary(root, 'A');
    const clone = '11111111-1111-4111-8111-111111111111';
    await cp(join(root, a.id), join(root, clone), { recursive: true });
    const err = await openLibrary(root, clone).catch((e) => e);
    expect(err).toMatchObject({ code: 'E_LIB_ID_MISMATCH' });
    expect(err.message).not.toMatch(/^E_LIB_/);
    expect((await openLibrary(root, a.id)).id).toBe(a.id);
  });

  it('库目录被改名后 openLibrary 抛 E_LIB_ID_MISMATCH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'engram-'));
    const a = await createLibrary(root, 'A');
    const moved = '22222222-2222-4222-8222-222222222222';
    await rename(join(root, a.id), join(root, moved));
    await expect(openLibrary(root, moved)).rejects.toMatchObject({ code: 'E_LIB_ID_MISMATCH' });
  });

  it('listLibraries 跳过 id 不符的目录并继续列出其余库', async () => {
    const root = await mkdtemp(join(tmpdir(), 'engram-'));
    const a = await createLibrary(root, 'A');
    const b = await createLibrary(root, 'B');
    await cp(join(root, a.id), join(root, '00000000-0000-4000-8000-000000000000'), { recursive: true });
    const list = await listLibraries(root);
    expect(list.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
  });
});

describe('原型键 id 端到端', () => {
  it('__proto__/constructor 作实体 id：落盘、快照、重开后状态正确', async () => {
    const root = await mkdtemp(join(tmpdir(), 'engram-'));
    const lib = await createLibrary(root, 'P');
    await lib.appendDelta({ floor: 1, lib: 'treasury', op: 'create', id: '__proto__', payload: { n: 1 } });
    await lib.appendDelta({ floor: 1, lib: 'treasury', op: 'update', id: 'toString', payload: { n: 1 } });
    await lib.writeSnapshot();
    await lib.appendDelta({ floor: 2, lib: 'treasury', op: 'create', id: 'constructor', payload: { n: 2 } });
    const re = await openLibrary(root, lib.id);
    const st = await re.getState('treasury');
    expect(Object.keys(st).sort()).toEqual(['__proto__', 'constructor']);
    expect(st['__proto__']).toMatchObject({ id: '__proto__', n: 1 });
    expect(st['constructor']).toMatchObject({ id: 'constructor', n: 2 });
  });
});

describe('appendDelta 写盘前校验', () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['payload 为 null', { floor: 2, lib: 'atlas', op: 'update', id: 'a', payload: null }],
    ['floor 为 NaN', { floor: NaN, lib: 'atlas', op: 'update', id: 'a', payload: { x: 1 } }],
    ['lib 非法', { floor: 2, lib: 'nope', op: 'update', id: 'a', payload: { x: 1 } }],
  ];
  for (const [name, d] of bad) {
    it(`${name}：抛 E_LIB_DELTA 且日志不新增行`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'engram-'));
      const lib = await createLibrary(root, 't');
      await lib.appendDelta({ floor: 1, lib: 'atlas', op: 'create', id: 'a', payload: { name: '港口' } });
      const logPath = join(root, lib.id, 'log.jsonl');
      const before = await readFile(logPath, 'utf8');
      await expect(lib.appendDelta(d as never)).rejects.toMatchObject({ code: 'E_LIB_DELTA' });
      expect(await readFile(logPath, 'utf8')).toBe(before);
      // seq 未被消耗
      const next = await lib.appendDelta({ floor: 3, lib: 'atlas', op: 'update', id: 'a', payload: { y: 1 } });
      expect(next.seq).toBe(2);
    });
  }
});
