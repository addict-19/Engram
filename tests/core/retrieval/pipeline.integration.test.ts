// tests/core/retrieval/pipeline.integration.test.ts
// 端到端：一张小金字塔（2 卷 / 4 章 / 8 节 / 20 切片）跑完整 retrieve 管线
import { describe, it, expect } from 'vitest';
import { retrieve } from '../../../src/core/retrieval/pipeline.js';
import type { PPRNode } from '../../../src/core/retrieval/ppr.js';
import type { Form, InjectionItem, UnitInfo, UnitMap } from '../../../src/core/retrieval/types.js';

// V1 > C1 > N1{s1,s2,s3} N2{s4,s5,s6}；V1 > C2 > N3{s7,s8} N4{s9,s10}
// V2 > C3 > N5{s11,s12,s13} N6{s14,s15,s16}；V2 > C4 > N7{s17,s18} N8{s19,s20}
// tokens：切片 [5,20,100] 节 [10,50,300] 章 [10,80,600] 卷 [10,100,900]；ts = 首切片序
function pyramid(): UnitMap {
  const m: UnitMap = new Map();
  const put = (u: UnitInfo) => m.set(u.id, u);
  const tk = { 0: [5, 20, 100], 1: [10, 50, 300], 2: [10, 80, 600], 3: [10, 100, 900] } as const;
  const mk = (id: string, layer: 0 | 1 | 2 | 3, parent: string | null, first: number): UnitInfo => ({
    id, kind: layer === 0 ? 'slice' : 'unit', layer, parent,
    tokens: { title: tk[layer][0], summary: tk[layer][1], body: tk[layer][2] },
    ts: `T${String(first).padStart(2, '0')}`,
  });
  const nodeSizes = [3, 3, 2, 2, 3, 3, 2, 2];
  let s = 1;
  for (let v = 1; v <= 2; v++) {
    put(mk(`V${v}`, 3, null, s));
    for (let c = 2 * v - 1; c <= 2 * v; c++) {
      put(mk(`C${c}`, 2, `V${v}`, s));
      for (let n = 2 * c - 1; n <= 2 * c; n++) {
        put(mk(`N${n}`, 1, `C${c}`, s));
        for (let k = 0; k < nodeSizes[n - 1]!; k++, s++) put(mk(`s${s}`, 0, `N${n}`, s));
      }
    }
  }
  return m;
}

const meta = () => ({ atTagged: new Set<string>(), atPulsed: new Set<string>(), importance: new Map<string, number>(), prevSelected: new Map<string, number>() });
const hits = (...ids: string[]) => ids.map((id, i) => ({ id, score: 100 - i }));
const fmt = (xs: InjectionItem[]) => xs.map(x => `${x.id}/${x.form}/${x.tokens}/${x.reason}`);
const run = (bm25: string[], vec: string[], resident: Array<[string, Form]> = [], recallBudget?: number) =>
  retrieve({
    bm25Results: hits(...bm25), vecResults: hits(...vec), anchorHitIds: new Set(),
    units: pyramid(), weightMeta: meta(), resident: new Map(resident),
    opts: recallBudget === undefined ? {} : { recallBudget },
  });

describe('金字塔结构自检', () => {
  it('2 卷 / 4 章 / 8 节 / 20 切片', () => {
    const count = (layer: number) => [...pyramid().values()].filter(u => u.layer === layer).length;
    expect([count(3), count(2), count(1), count(0)]).toEqual([2, 4, 8, 20]);
  });
});

describe('retrieve 端到端', () => {
  it('跨节命中 → 章 body 注入（同章两节各中一片，无断崖 → 章聚集）', () => {
    const r = run(['s1', 's4'], ['s4', 's1']);
    expect(r.grades.map(g => `${g.id}:${g.grade}`)).toEqual(['s1:chapterCluster', 's4:chapterCluster']);
    expect(fmt(r.final)).toEqual([
      's1/body/100/chapterCluster', 'C1/body/600/chapterCluster:C1', 'V1/summary/100/chapterCluster:C1',
      's4/body/100/chapterCluster',
    ]);
  });

  it('命中卷吞其下章（卷与章都领先取 body → 章被吸收）', () => {
    const r = run(['V2', 'C3'], ['V2']);
    expect(fmt(r.final)).toEqual(['V2/body/900/bucket:lead:V2']);
    expect(r.grades).toEqual([]);
  });

  it('常驻去重：常驻已有形态 ≥ 请求形态的单元不重复注入', () => {
    const r = run(['s1', 's4'], ['s4', 's1'], [['C1', 'body'], ['V1', 'summary']]);
    expect(fmt(r.final)).toEqual(['s1/body/100/chapterCluster', 's4/body/100/chapterCluster']);
    expect(r.dropped).toEqual([]);
  });

  it('预算降档：先降形态，降到底仍超则整条弃', () => {
    // 900 → 预算 400：章 body(600) 降 summary(80) 即达标
    const a = run(['s1', 's4'], ['s4', 's1'], [], 400);
    expect(fmt(a.final)).toContain('C1/summary/80/chapterCluster:C1');
    expect(a.dropped).toEqual([]);
    // 预算 250：章降到 title 仍超 → 弃；卷 summary 再降 title 达标
    const b = run(['s1', 's4'], ['s4', 's1'], [], 250);
    expect(fmt(b.final)).toEqual(['s1/body/100/chapterCluster', 'V1/title/10/chapterCluster:C1', 's4/body/100/chapterCluster']);
    expect(fmt(b.dropped)).toEqual(['C1/body/600/chapterCluster:C1']);
  });

  it('四场景合一：跨节章聚集 + 卷吞章 + 常驻去重 + 预算降档', () => {
    const r = run(['s1', 'V2', 's4', 'C3'], ['s4', 's1', 'V2'], [['V1', 'summary']], 1000);
    // 切片 s1/s4 → C1 body（章聚集）；V2 吞 C3；V1 summary 已常驻；1700 > 1000 → 桶来源 V2 先降 summary
    expect(fmt(r.final)).toEqual([
      's1/body/100/chapterCluster', 'C1/body/600/chapterCluster:C1', 's4/body/100/chapterCluster',
      'V2/summary/100/bucket:lead:V2',
    ]);
    expect(r.dropped).toEqual([]);
  });

  it('PPR 补条：与命中切片同事件的邻节切片以 mention 档补入', () => {
    const nodes: PPRNode[] = [...pyramid().values()].filter(u => u.kind === 'slice')
      .map(u => ({ id: u.id, characters: [], anchors: [], tags: [], eventIds: u.id === 's1' || u.id === 's9' ? ['e'] : [] }));
    const r = retrieve({
      bm25Results: hits('s1', 's4'), vecResults: hits('s4', 's1'), anchorHitIds: new Set(),
      units: pyramid(), weightMeta: meta(), resident: new Map(),
      pprNodes: nodes, vecSim: () => 0,
    });
    expect(fmt(r.final)).toContain('s9/body/100/ppr');
    expect(r.grades.at(-1)).toEqual({ id: 's9', grade: 'mention', score: 0 });
  });
});
