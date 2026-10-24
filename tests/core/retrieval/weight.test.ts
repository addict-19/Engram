// tests/core/retrieval/weight.test.ts
import { describe, it, expect } from 'vitest';
import { applyWeights } from '../../../src/core/retrieval/weight.js';
import type { Candidate } from '../../../src/core/retrieval/types.js';

const C = (id: string, score: number, extra: Partial<Candidate> = {}): Candidate =>
  ({ id, score, sources: ['bm25'], ...extra });

const meta = (m: Partial<{
  atTagged: Set<string>; atPulsed: Set<string>;
  importance: Map<string, number>; prevSelected: Map<string, number>;
}> = {}) => ({
  atTagged: m.atTagged ?? new Set<string>(),
  atPulsed: m.atPulsed ?? new Set<string>(),
  importance: m.importance ?? new Map<string, number>(),
  prevSelected: m.prevSelected ?? new Map<string, number>(),
});

const byId = (r: Candidate[], id: string) => r.find(c => c.id === id)!;

describe('applyWeights：@关联加权', () => {
  it('@轻加权默认 1.2 倍', () => {
    const r = applyWeights([C('a', 1), C('b', 1)], meta({ atTagged: new Set(['a']) }));
    expect(byId(r, 'a').score).toBeCloseTo(1.2, 12);
    expect(byId(r, 'b').score).toBeCloseTo(1, 12);
  });

  it('新关联脉冲默认 1.5 倍', () => {
    const r = applyWeights([C('a', 1)], meta({ atPulsed: new Set(['a']) }));
    expect(byId(r, 'a').score).toBeCloseTo(1.5, 12);
  });

  it('同时在 atTagged 与 atPulsed：取脉冲倍数，不叠乘', () => {
    const r = applyWeights([C('a', 1)], meta({ atTagged: new Set(['a']), atPulsed: new Set(['a']) }));
    expect(byId(r, 'a').score).toBeCloseTo(1.5, 12);
  });

  it('opts 可覆盖 @ 倍数', () => {
    const r = applyWeights([C('a', 2), C('b', 2)],
      meta({ atTagged: new Set(['a']), atPulsed: new Set(['b']) }),
      { atTagBoost: 1.1, atPulseBoost: 2 });
    expect(byId(r, 'a').score).toBeCloseTo(2.2, 12);
    expect(byId(r, 'b').score).toBeCloseTo(4, 12);
  });
});

describe('applyWeights：importance', () => {
  it('importance=10 与 0 的分差：1.2 倍 vs 1 倍', () => {
    const r = applyWeights([C('hi', 1), C('lo', 1)],
      meta({ importance: new Map([['hi', 10], ['lo', 0]]) }));
    expect(byId(r, 'hi').score).toBeCloseTo(1.2, 12);
    expect(byId(r, 'lo').score).toBeCloseTo(1, 12);
    expect(byId(r, 'hi').score - byId(r, 'lo').score).toBeCloseTo(0.2, 12);
  });

  it('缺省 importance 按 0', () => {
    const r = applyWeights([C('a', 0.5)], meta());
    expect(byId(r, 'a').score).toBeCloseTo(0.5, 12);
  });

  it('importanceFactor 可覆盖', () => {
    const r = applyWeights([C('a', 1)], meta({ importance: new Map([['a', 5]]) }), { importanceFactor: 0.1 });
    expect(byId(r, 'a').score).toBeCloseTo(1.5, 12);
  });

  it('@倍数与 importance 倍数相乘', () => {
    const r = applyWeights([C('a', 1)],
      meta({ atTagged: new Set(['a']), importance: new Map([['a', 10]]) }));
    expect(byId(r, 'a').score).toBeCloseTo(1.2 * 1.2, 12);
  });
});

describe('applyWeights：回响 max 保底', () => {
  it('自然分高于上轮分×0.6 时不被回响拉低（专门防误读）', () => {
    // 自然分 1.0，上轮分 1.0 → 保底 0.6；结果必须仍是 1.0，而不是 0.6 或任何混合值
    const r = applyWeights([C('a', 1)], meta({ prevSelected: new Map([['a', 1]]) }));
    expect(byId(r, 'a').score).toBeCloseTo(1, 12);
  });

  it('自然加权分（含 @ 与 importance）高时同样不被拉低', () => {
    const r = applyWeights([C('a', 1)], meta({
      atTagged: new Set(['a']), importance: new Map([['a', 10]]),
      prevSelected: new Map([['a', 2]]),   // 保底 1.2 < 自然 1.44
    }));
    expect(byId(r, 'a').score).toBeCloseTo(1.44, 12);
  });

  it('自然分低于保底时抬到上轮分×0.6', () => {
    const r = applyWeights([C('a', 0.1)], meta({ prevSelected: new Map([['a', 1]]) }));
    expect(byId(r, 'a').score).toBeCloseTo(0.6, 12);
  });

  it('保底比较用的是加权后的自然分，而非原始分', () => {
    // 原始 0.5 < 保底 0.54，但加权后 0.5×1.2=0.6 > 0.54
    const r = applyWeights([C('a', 0.5)], meta({
      atTagged: new Set(['a']), prevSelected: new Map([['a', 0.9]]),
    }));
    expect(byId(r, 'a').score).toBeCloseTo(0.6, 12);
  });

  it('上轮入选本轮零命中者以保底分补入，sources 为空、无 anchorHit', () => {
    const r = applyWeights([C('a', 1)], meta({ prevSelected: new Map([['ghost', 0.5]]) }));
    const g = byId(r, 'ghost');
    expect(g).toBeDefined();
    expect(g.score).toBeCloseTo(0.3, 12);
    expect(g.sources).toEqual([]);
    expect('anchorHit' in g).toBe(false);
    expect(r).toHaveLength(2);
  });

  it('补入的保底分不吃 @ 与 importance 加成', () => {
    const r = applyWeights([], meta({
      atPulsed: new Set(['ghost']), importance: new Map([['ghost', 10]]),
      prevSelected: new Map([['ghost', 1]]),
    }));
    expect(r).toHaveLength(1);
    expect(r[0]!.score).toBeCloseTo(0.6, 12);
  });

  it('echoDecay 可覆盖', () => {
    const r = applyWeights([], meta({ prevSelected: new Map([['g', 1]]) }), { echoDecay: 0.3 });
    expect(r[0]!.score).toBeCloseTo(0.3, 12);
  });
});

describe('applyWeights：输出与纯函数', () => {
  it('输出按分数降序', () => {
    const r = applyWeights([C('a', 1), C('b', 0.9), C('c', 0.1)], meta({
      atPulsed: new Set(['b']),                // 1.35
      prevSelected: new Map([['ghost', 2]]),   // 1.2
    }));
    expect(r.map(c => c.id)).toEqual(['b', 'ghost', 'a', 'c']);
  });

  it('同分保持输入顺序稳定', () => {
    const r = applyWeights([C('x', 1), C('y', 1), C('z', 1)], meta());
    expect(r.map(c => c.id)).toEqual(['x', 'y', 'z']);
  });

  it('保留 sources 与 anchorHit 字段', () => {
    const r = applyWeights([C('a', 1, { sources: ['bm25', 'vec'], anchorHit: true }), C('b', 1)], meta());
    expect(byId(r, 'a').sources).toEqual(['bm25', 'vec']);
    expect(byId(r, 'a').anchorHit).toBe(true);
    expect('anchorHit' in byId(r, 'b')).toBe(false);
  });

  it('不修改入参（候选数组/对象/sources 与 meta 的 Set/Map）', () => {
    const cands = [C('a', 1, { sources: ['vec'], anchorHit: true }), C('b', 0.2)];
    const m = meta({
      atTagged: new Set(['a']), atPulsed: new Set(['b']),
      importance: new Map([['a', 3]]), prevSelected: new Map([['b', 1], ['ghost', 1]]),
    });
    const snapC = structuredClone(cands);
    const snapM = structuredClone(m);
    const r = applyWeights(cands, m);
    expect(cands).toEqual(snapC);
    expect(m).toEqual(snapM);
    expect(r[0]).not.toBe(cands[0]);
    expect(byId(r, 'a').sources).not.toBe(cands[0]!.sources);
  });

  it('空输入空 meta 返回空数组', () => {
    expect(applyWeights([], meta())).toEqual([]);
  });
});
