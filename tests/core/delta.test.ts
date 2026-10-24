// tests/core/delta.test.ts
import { describe, it, expect } from 'vitest';
import { applyDeltas, rollbackView, serializeDelta, parseDeltaLine, type Delta } from '../../src/core/delta.js';

const d = (seq: number, floor: number, op: Delta['op'], id: string, payload?: Record<string, unknown>): Delta =>
  ({ seq, floor, ts: '2026-10-19T20:00:00+08:00', lib: 'treasury', op, id, payload });

describe('applyDeltas', () => {
  it('create→update 字段级合并→delete 全程正确', () => {
    const out = applyDeltas({}, [
      d(1, 10, 'create', 'ring', { title: '戒指', count: 1, importance: 7 }),
      d(2, 12, 'update', 'ring', { count: 2 }),
    ]);
    expect(out['ring']).toMatchObject({ title: '戒指', count: 2, importance: 7 });
    const out2 = applyDeltas(out, [d(3, 15, 'delete', 'ring')]);
    expect(out2['ring']).toBeUndefined();
  });
  it('update 不存在的 id 跳过不炸（局部容错）', () => {
    expect(() => applyDeltas({}, [d(1, 1, 'update', 'ghost', { a: 1 })])).not.toThrow();
  });
});

describe('rollbackView', () => {
  it('删楼回滚：只保留 floor ≤ N 的 delta，日志本身不变', () => {
    const log = [d(1, 10, 'create', 'ring', { count: 1 }), d(2, 12, 'update', 'ring', { count: 2 })];
    const view = rollbackView(log, 11);
    expect(view).toHaveLength(1);
    expect(applyDeltas({}, view)['ring']).toMatchObject({ count: 1 });
    expect(log).toHaveLength(2);  // 原日志未动
  });
});

describe('JSONL 序列化', () => {
  it('round-trip 一致', () => {
    const x = d(7, 42, 'create', 'ring', { title: '戒指' });
    expect(parseDeltaLine(serializeDelta(x))).toEqual(x);
  });
  it('坏行返回 null 不抛异常', () => {
    expect(parseDeltaLine('{broken json')).toBeNull();
    expect(parseDeltaLine('')).toBeNull();
  });
});

describe('实体 id 不可被 payload 覆盖', () => {
  it('create：payload 带不同 id 时实体 id 仍等于 delta.id', () => {
    const out = applyDeltas({}, [d(1, 1, 'create', 'ring', { id: 'evil', title: '戒指' })]);
    expect(out['ring']?.id).toBe('ring');
  });
  it('update：payload 带不同 id 时实体 id 仍等于 delta.id', () => {
    const out = applyDeltas({}, [
      d(1, 1, 'create', 'ring', { title: '戒指' }),
      d(2, 2, 'update', 'ring', { id: 'evil', count: 2 }),
    ]);
    expect(out['ring']).toMatchObject({ id: 'ring', count: 2 });
  });
});

describe('parseDeltaLine payload 校验', () => {
  const base = { seq: 1, floor: 1, ts: '2026-10-19T20:00:00+08:00', lib: 'treasury', op: 'create', id: 'ring' };
  it('payload 为字符串返回 null', () => {
    expect(parseDeltaLine(JSON.stringify({ ...base, payload: 'abc' }))).toBeNull();
  });
  it('payload 为数组返回 null', () => {
    expect(parseDeltaLine(JSON.stringify({ ...base, payload: [1, 2] }))).toBeNull();
  });
  it('合法对象 payload 照常通过', () => {
    const line = JSON.stringify({ ...base, payload: { title: '戒指' } });
    expect(parseDeltaLine(line)).toEqual({ ...base, payload: { title: '戒指' } });
  });
});

describe('applyDeltas 原型键加固', () => {
  it('create __proto__：不改结果对象原型，实体作为自有键保留', () => {
    const out = applyDeltas({}, [d(1, 1, 'create', '__proto__', { title: 'x' })]);
    expect(Object.hasOwn(out, '__proto__')).toBe(true);
    expect(Object.keys(out)).toEqual(['__proto__']);
    expect(out['__proto__']).toMatchObject({ id: '__proto__', title: 'x' });
    expect(Object.getPrototypeOf(out)).not.toBe(out['__proto__']);
    expect((out as Record<string, unknown>)['title']).toBeUndefined();
  });
  it('update 继承键名（constructor/toString/hasOwnProperty）不凭空造实体', () => {
    const out = applyDeltas({}, [
      d(1, 1, 'update', 'constructor', { a: 1 }),
      d(2, 1, 'update', 'toString', { a: 1 }),
      d(3, 1, 'update', 'hasOwnProperty', { a: 1 }),
    ]);
    expect(Object.keys(out)).toEqual([]);
  });
  it('继承键名作 id 时 create→update→delete 全程正常', () => {
    const out = applyDeltas({}, [
      d(1, 1, 'create', 'constructor', { n: 1 }),
      d(2, 1, 'update', 'constructor', { n: 2 }),
      d(3, 1, 'create', '__proto__', { n: 1 }),
      d(4, 1, 'update', '__proto__', { n: 3 }),
    ]);
    expect(out['constructor']).toMatchObject({ id: 'constructor', n: 2 });
    expect(out['__proto__']).toMatchObject({ id: '__proto__', n: 3 });
    const out2 = applyDeltas(out, [d(5, 2, 'delete', '__proto__'), d(6, 2, 'delete', 'constructor')]);
    expect(Object.keys(out2)).toEqual([]);
  });
  it('base 中自有的 __proto__ 实体（如来自快照 JSON.parse）原样保留', () => {
    const base = JSON.parse('{"__proto__":{"id":"__proto__","n":1}}');
    const out = applyDeltas(base, [d(1, 1, 'update', '__proto__', { n: 2 })]);
    expect(Object.keys(out)).toEqual(['__proto__']);
    expect(out['__proto__']).toMatchObject({ id: '__proto__', n: 2 });
  });
  it('payload 内的 __proto__ 键不污染实体原型', () => {
    const line = JSON.stringify({ seq: 1, floor: 1, ts: 't', lib: 'treasury', op: 'create', id: 'e', payload: JSON.parse('{"__proto__":{"evil":1}}') });
    const dl = parseDeltaLine(line)!;
    const out = applyDeltas({}, [dl]);
    expect((out['e'] as Record<string, unknown>)['evil']).toBeUndefined();
    expect(({} as Record<string, unknown>)['evil']).toBeUndefined();
  });
});
