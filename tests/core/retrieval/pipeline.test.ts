// tests/core/retrieval/pipeline.test.ts
import { describe, it, expect } from 'vitest';
import { retrieve } from '../../../src/core/retrieval/pipeline.js';
import type { PPRNode } from '../../../src/core/retrieval/ppr.js';
import type { Form, InjectionItem, UnitInfo, UnitMap } from '../../../src/core/retrieval/types.js';

const U = (id: string, kind: 'slice' | 'unit', layer: number, parent: string | null, tk: [number, number, number], ts?: string): UnitInfo =>
  ({ id, kind, layer, parent, tokens: { title: tk[0], summary: tk[1], body: tk[2] }, ...(ts ? { ts } : {}) });

// V1 > C1 > { N1 > {a, b}, N2 > {c} }；V1 > C2
function units(): UnitMap {
  const list = [
    U('V1', 'unit', 3, null, [9, 90, 900], 'T0'),
    U('C1', 'unit', 2, 'V1', [7, 70, 700], 'T1'),
    U('C2', 'unit', 2, 'V1', [8, 80, 800], 'T9'),
    U('N1', 'unit', 1, 'C1', [5, 50, 500], 'T1'),
    U('N2', 'unit', 1, 'C1', [6, 60, 600], 'T5'),
    U('a', 'slice', 0, 'N1', [1, 10, 100], 'T2'),
    U('b', 'slice', 0, 'N1', [1, 10, 100], 'T3'),
    U('c', 'slice', 0, 'N2', [1, 10, 100], 'T6'),
  ];
  return new Map(list.map(u => [u.id, u]));
}
const meta = () => ({ atTagged: new Set<string>(), atPulsed: new Set<string>(), importance: new Map<string, number>(), prevSelected: new Map<string, number>() });
const hits = (...ids: string[]) => ids.map((id, i) => ({ id, score: 10 - i }));
const base = (over: Partial<Parameters<typeof retrieve>[0]> = {}): Parameters<typeof retrieve>[0] => ({
  bm25Results: [], vecResults: [], anchorHitIds: new Set(), units: units(), weightMeta: meta(),
  resident: new Map<string, Form>(), ...over,
});
const fmt = (xs: InjectionItem[]) => xs.map(x => `${x.id}/${x.form}/${x.tokens}/${x.reason}`);

describe('retrieve rerank 注入', () => {
  it('锚点免死金牌：anchorHit 取 max(rerank分, 原分)，其余用 rerank 分', () => {
    const rerank = () => new Map([['a', 0.001], ['b', 0.01], ['c', 0.005]]);
    const r = retrieve(base({ bm25Results: hits('a', 'b', 'c'), anchorHitIds: new Set(['a']), opts: { rerank, baseFloor: 0 } }));
    expect(r.grades.map(g => g.id)).toEqual(['a', 'b', 'c']);
    expect(r.grades[0]!.score).toBeCloseTo(1 / 61, 12);
    expect(r.grades[1]!.score).toBe(0.01);
    expect(r.grades[2]!.score).toBe(0.005);

    const r2 = retrieve(base({ bm25Results: hits('a', 'b', 'c'), opts: { rerank, baseFloor: 0 } }));
    expect(r2.grades.map(g => g.id)).toEqual(['b', 'c', 'a']);
    expect(r2.grades[2]!.score).toBe(0.001);
  });

  it('只对前 rerankTopN 条（默认 20）调用；之外的候选保留原分、排在重排段之后', () => {
    const calls: string[][] = [];
    const rerank = (ids: string[]) => { calls.push(ids); return new Map([['a', 0.5], ['b', 0.9]]); };
    const r = retrieve(base({ bm25Results: hits('a', 'b', 'c'), opts: { rerank, rerankTopN: 2 } }));
    expect(calls).toEqual([['a', 'b']]);
    expect(r.grades.map(g => [g.id, g.score])).toEqual([['b', 0.9], ['a', 0.5], ['c', 1 / 63]]);

    calls.length = 0;
    retrieve(base({ bm25Results: hits('a', 'b', 'c'), opts: { rerank } }));
    expect(calls).toEqual([['a', 'b', 'c']]);
  });
});

describe('retrieve 分流', () => {
  it('切片进充能流；layer=1 节转 directNodeHits；layer≥2 进高层桶', () => {
    const r = retrieve(base({ bm25Results: hits('a', 'N2', 'C2') }));
    expect(r.grades.map(g => `${g.id}:${g.grade}`)).toEqual(['a:precise']);
    const f = fmt(r.final);
    expect(f).toContain('a/body/100/precise');
    expect(f).toContain('N1/body/500/precise:a');
    expect(f).toContain('N2/body/600/nodeCluster:N2');   // 节直接命中 → 节聚集产物
    expect(f).toContain('C2/body/800/bucket:lead:C2');   // 章进高层桶
    expect(r.final.map(x => x.id)).not.toContain('c');
  });

  it('kind=unit 但 layer 非法（<1 / NaN）的候选按孤儿并入切片流，不消失', () => {
    const m = units();
    m.set('W', U('W', 'unit', 0, null, [2, 20, 200]));
    m.set('X', U('X', 'unit', Number.NaN, null, [3, 30, 300]));
    const r = retrieve(base({ units: m, bm25Results: hits('a', 'W', 'X'), vecResults: hits('X', 'W', 'a') }));
    expect(r.grades.map(g => `${g.id}:${g.grade}`).sort()).toEqual(['W:mention', 'X:mention', 'a:mention']);
    expect(r.final.map(x => x.id)).toEqual(expect.arrayContaining(['W', 'X']));
  });

  it('chargeSignals 原样透传 bucketSelect 擦线单元', () => {
    // 章层 C1、C2：C1 领先（≥1.5 倍）→ body，C2 擦线 → summary 并计充能
    const r = retrieve(base({ bm25Results: hits('C1', 'C2'), opts: { fuseK: 0 } }));
    expect(fmt(r.final)).toContain('C2/summary/80/bucket:graze:C2');
    expect(r.chargeSignals).toEqual(['C2']);
    expect(retrieve(base({ bm25Results: hits('a') })).chargeSignals).toEqual([]);
  });

  it('不在 units 中的孤儿 id 按切片处理，tokens 记 0', () => {
    const r = retrieve(base({ bm25Results: hits('zz') }));
    expect(fmt(r.final)).toEqual(['zz/body/0/precise']);
  });

  it('切片 InjectionItem：form=body、tokens 取 units、reason=档位', () => {
    const r = retrieve(base({ bm25Results: hits('a', 'c'), vecResults: hits('c', 'a') }));
    expect(r.grades.map(g => `${g.id}:${g.grade}`)).toEqual(['a:chapterCluster', 'c:chapterCluster']);
    expect(fmt(r.final).filter(s => /^[ac]\//.test(s))).toEqual(['a/body/100/chapterCluster', 'c/body/100/chapterCluster']);
  });
});

describe('retrieve PPR 补条', () => {
  const nodes: PPRNode[] = [
    { id: 'a', characters: [], anchors: [], tags: [], eventIds: ['e'] },
    { id: 'b', characters: [], anchors: [], tags: [], eventIds: ['e'] },
    { id: 'c', characters: [], anchors: [], tags: [] },
  ];
  const noSim = () => 0;

  it('补充 id 以 mention 档并入 clusterItems（reason=ppr），grades 追加 mention', () => {
    const r = retrieve(base({ bm25Results: hits('a'), pprNodes: nodes, vecSim: noSim }));
    expect(fmt(r.final)).toContain('b/body/100/ppr');
    expect(r.grades).toContainEqual({ id: 'b', grade: 'mention', score: 0 });
    expect(r.final.map(x => x.id)).not.toContain('c');
  });

  it('pprNodes 混入 unit 类 id（章）时不进补条，也不占名额', () => {
    // C2 排在 b 前：与 b 同分时旧逻辑会按 nodes 序选中 C2
    const mixed: PPRNode[] = [{ id: 'C2', characters: [], anchors: [], tags: [], eventIds: ['e'] }, ...nodes];
    const r = retrieve(base({ bm25Results: hits('a'), pprNodes: mixed, vecSim: noSim, opts: { ppr: { maxAdd: 1 } } }));
    expect(r.grades.map(g => g.id)).toEqual(['a', 'b']);
    expect(r.final.map(x => x.id)).not.toContain('C2');
  });

  it('未提供 pprNodes 或 vecSim 时不扩散', () => {
    expect(retrieve(base({ bm25Results: hits('a'), pprNodes: nodes })).final.map(x => x.id)).not.toContain('b');
    expect(retrieve(base({ bm25Results: hits('a'), vecSim: noSim })).final.map(x => x.id)).not.toContain('b');
  });

  it('PPR 补条预算内才进：超预算时它先被弃', () => {
    // a 100 + N1 500 + C1 70 + V1 90 = 760；补 b 后 860 > 800
    const r = retrieve(base({ bm25Results: hits('a'), pprNodes: nodes, vecSim: noSim, opts: { recallBudget: 800 } }));
    expect(r.final.map(x => x.id)).not.toContain('b');
    expect(fmt(r.dropped)).toContain('b/body/100/ppr');
  });
});

describe('retrieve 纯函数', () => {
  it('不修改入参', () => {
    const input = base({ bm25Results: hits('a', 'N2', 'C2'), anchorHitIds: new Set(['a']) });
    const snap = JSON.stringify([input.bm25Results, [...input.anchorHitIds], [...input.units], [...input.resident]]);
    retrieve(input);
    expect(JSON.stringify([input.bm25Results, [...input.anchorHitIds], [...input.units], [...input.resident]])).toBe(snap);
  });
});

const prev = (m: Record<string, number>) => ({ ...meta(), prevSelected: new Map(Object.entries(m)) });

describe('retrieve 基础线 baseFloor（默认 0.01）', () => {
  it('切片候选低于基础线剔除；节/桶候选同线过滤', () => {
    const rerank = () => new Map([['a', 0.5], ['b', 0.009], ['N2', 0.009], ['C2', 0.009]]);
    const r = retrieve(base({ bm25Results: hits('a', 'b', 'N2', 'C2'), opts: { rerank } }));
    expect(r.grades.map(g => g.id)).toEqual(['a']);
    const ids = r.final.map(x => x.id);
    expect(ids).not.toContain('b');
    expect(ids).not.toContain('N2');   // 节候选过不了线 → 不进 directNodeHits
    expect(ids).not.toContain('C2');   // 桶 floor 缺省取 baseFloor
  });

  it('bucket.floor 显式传入优先于 baseFloor', () => {
    const rerank = () => new Map([['C2', 0.009]]);
    const r = retrieve(base({ bm25Results: hits('C2'), opts: { rerank, bucket: { floor: 0 } } }));
    expect(r.final.map(x => x.id)).toContain('C2');
  });

  it('纯回响补入（sources 空）的节/章不进节路径与桶路径', () => {
    const r = retrieve(base({ weightMeta: prev({ N2: 1, C2: 1 }) }));
    expect(r.final).toEqual([]);
    expect(r.chargeSignals).toEqual([]);
  });
});

describe('retrieve 回响出局', () => {
  it('上轮入选、本轮零命中、衰减后跌破基础线 → 彻底出局', () => {
    const r = retrieve(base({ weightMeta: prev({ a: 0.015 }) }));   // 0.015×0.6 = 0.009 < 0.01
    expect(r.grades.map(g => g.id)).not.toContain('a');
    expect(r.final.map(x => x.id)).not.toContain('a');
  });

  it('衰减后仍过线 → 切片保底参赛生效', () => {
    const r = retrieve(base({ weightMeta: prev({ a: 0.02 }) }));    // 0.012 ≥ 0.01
    expect(r.grades.map(g => g.id)).toEqual(['a']);
    expect(r.final.map(x => x.id)).toContain('a');
  });

  it('约 3 轮自然出局：双路第一名的切片此后零命中，第 3 轮掉出', () => {
    const first = retrieve(base({ bm25Results: hits('a'), vecResults: hits('a') }));
    let score = first.grades[0]!.score;                                // 2/61 ≈ 0.0328
    const alive: boolean[] = [];
    for (let round = 1; round <= 4; round++) {
      const r = retrieve(base({ weightMeta: prev({ a: score }) }));
      const g = r.grades.find(x => x.id === 'a');
      alive.push(!!g);
      if (!g) break;
      score = g.score;
    }
    expect(alive).toEqual([true, true, false]);                        // 0.0197 → 0.0118 → 0.0071 出局
  });
});

describe('retrieve 切片条数上限 maxSlices（默认 10）', () => {
  const twelve = Array.from({ length: 12 }, (_, i) => `o${i + 1}`);   // 孤儿切片，tokens 0，不受预算干扰
  it('12 条过线切片默认只留 10 条，按分数序留前 10，其余进 dropped', () => {
    const r = retrieve(base({ bm25Results: hits(...twelve) }));
    const kept = r.final.map(x => x.id);
    expect(kept).toHaveLength(10);
    expect(kept).toEqual(twelve.slice(0, 10));
    expect(r.dropped.map(x => x.id)).toEqual(['o11', 'o12']);
  });

  it('上层单元不占名额；可配', () => {
    const r = retrieve(base({ bm25Results: hits('a', 'c', ...twelve), vecResults: hits('c', 'a'), opts: { maxSlices: 2 } }));
    const ids = r.final.map(x => x.id);
    expect(ids.filter(id => units().get(id)?.kind !== 'unit')).toEqual(['a', 'c']);
    expect(ids).toContain('C1');   // a、c 的升级产物照常注入，不受切片名额限制
  });
});

describe('retrieve 透传 charge', () => {
  it('返回 gradeAndCluster 的充能表', () => {
    const r = retrieve(base({ bm25Results: hits('a') }));
    expect(r.charge.get('N1')).toBeCloseTo(1 / 61, 12);
    expect(r.charge.get('V1')).toBeCloseTo(1 / 61, 12);
  });
});
