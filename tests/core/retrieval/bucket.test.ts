// tests/core/retrieval/bucket.test.ts
import { describe, it, expect } from 'vitest';
import { bucketSelect, type BucketOpts } from '../../../src/core/retrieval/bucket.js';
import type { Candidate, UnitInfo, UnitMap } from '../../../src/core/retrieval/types.js';

const C = (id: string, score: number): Candidate => ({ id, score, sources: ['vec'] });

// 三形态 token 按 id 区分，便于断言 tokens 取对了形态
const U = (id: string, layer: number, parent: string | null, base: number): UnitInfo => ({
  id, kind: layer === 0 ? 'slice' : 'unit', layer, parent,
  tokens: { title: base + 1, summary: base + 2, body: base + 3 },
});

// 部 P ─ 卷 V1 ─ 章 C1 / C2 / C4（C1 下有节 N1）
//      └ 卷 V2 ─ 章 C3
// 孤儿章 C9（无卷）
function tree(): UnitMap {
  const list: UnitInfo[] = [
    U('P', 4, null, 400),
    U('V1', 3, 'P', 310), U('V2', 3, 'P', 320),
    U('C1', 2, 'V1', 210), U('C2', 2, 'V1', 220), U('C4', 2, 'V1', 240),
    U('C3', 2, 'V2', 230), U('C9', 2, null, 290),
    U('N1', 1, 'C1', 110),
  ];
  return new Map(list.map(u => [u.id, u]));
}

const opts = (o: Partial<BucketOpts> = {}): BucketOpts => ({ floor: 1, cliff: { ratio: 1.5 }, ...o });
const items = (r: ReturnType<typeof bucketSelect>) =>
  r.requests.map(q => `${q.id}/${q.form}/${q.tokens}/${q.reason}`);

describe('bucketSelect：边界', () => {
  it('空输入 → 空结果', () => {
    expect(bucketSelect([], tree(), opts())).toEqual({ requests: [], chargeSignals: [] });
  });

  it('不修改入参（候选数组/对象、UnitMap、opts）', () => {
    const cands = [C('C1', 10), C('C2', 3), C('V1', 5)];
    const units = tree();
    const o = opts();
    const snapC = structuredClone(cands);
    const snapU = structuredClone([...units.entries()]);
    const snapO = structuredClone(o);
    bucketSelect(cands, units, o);
    expect(cands).toEqual(snapC);
    expect([...units.entries()]).toEqual(snapU);
    expect(o).toEqual(snapO);
  });

  it('不在 UnitMap 的 id 忽略；防御性忽略 slice / layer<2', () => {
    const units = tree();
    units.set('s1', U('s1', 0, 'N1', 0));
    const r = bucketSelect([C('ghost', 99), C('s1', 50), C('N1', 40), C('C1', 10)], units, opts());
    expect(items(r)).toEqual(['C1/body/213/bucket:lead:C1']);
  });
});

describe('bucketSelect：floor 舍弃', () => {
  it('低于 floor 的条目舍弃，不进请求也不计充能', () => {
    const r = bucketSelect([C('C1', 10), C('C2', 0.5)], tree(), opts({ floor: 1 }));
    expect(items(r)).toEqual(['C1/body/213/bucket:lead:C1']);
    expect(r.chargeSignals).toEqual([]);
  });

  it('全部低于 floor → 空', () => {
    const r = bucketSelect([C('C1', 0.9), C('V1', 0.2)], tree(), opts({ floor: 1 }));
    expect(r).toEqual({ requests: [], chargeSignals: [] });
  });

  it('等于 floor 算过线', () => {
    const r = bucketSelect([C('C1', 1)], tree(), opts({ floor: 1 }));
    expect(items(r)).toEqual(['C1/body/213/bucket:lead:C1']);
  });
});

describe('bucketSelect：两档', () => {
  it('领先档请求 body；擦线档请求 summary 并记入 chargeSignals', () => {
    const r = bucketSelect([C('C2', 3), C('C1', 10)], tree(), opts());
    expect(items(r)).toEqual([
      'C1/body/213/bucket:lead:C1',
      'C2/summary/222/bucket:graze:C2',
    ]);
    expect(r.chargeSignals).toEqual(['C2']);
  });

  it('群体领先：断点前多条都拿 body', () => {
    // 10, 9 与 2 之间断崖 → k=2
    const r = bucketSelect([C('C1', 10), C('C2', 9), C('C3', 2)], tree(), opts({ perLayerMax: 3 }));
    expect(items(r)).toEqual([
      'C1/body/213/bucket:lead:C1',
      'C2/body/223/bucket:lead:C2',
      'C3/summary/232/bucket:graze:C3',
    ]);
    expect(r.chargeSignals).toEqual(['C3']);
  });

  it('无断崖 → 全部擦线档', () => {
    const r = bucketSelect([C('C1', 10), C('C2', 9)], tree(), opts());
    expect(items(r)).toEqual([
      'C1/summary/212/bucket:graze:C1',
      'C2/summary/222/bucket:graze:C2',
    ]);
    expect(r.chargeSignals).toEqual(['C1', 'C2']);
  });

  it('断崖在 floor 过线序列上计算（被舍弃的低分不制造断崖）', () => {
    // 过线序列 [10, 9] 无断崖；若算上 0.1 会在 9→0.1 制造断崖
    const r = bucketSelect([C('C1', 10), C('C2', 9), C('C3', 0.1)], tree(), opts({ perLayerMax: 3 }));
    expect(r.requests.map(q => q.form)).toEqual(['summary', 'summary']);
  });
});

describe('bucketSelect：每层限额', () => {
  it('默认 perLayerMax=2：每层 body+summary 合计 ≤2，按分数取前', () => {
    const r = bucketSelect([C('C1', 10), C('C2', 9), C('C3', 2), C('C9', 1.5)], tree(), opts());
    expect(items(r)).toEqual([
      'C1/body/213/bucket:lead:C1',
      'C2/body/223/bucket:lead:C2',
    ]);
    expect(r.chargeSignals).toEqual([]);   // 超额被截的擦线条目不计充能
  });

  it('限额按层独立：章层满额不挤占卷层', () => {
    const r = bucketSelect(
      [C('C1', 10), C('C2', 9), C('C9', 8), C('V2', 5)],
      tree(), opts({ perLayerMax: 1 }),
    );
    expect(r.requests.map(q => q.id)).toEqual(['V2', 'C1']);
  });

  it('perLayerMax 自定义生效', () => {
    const r = bucketSelect([C('C1', 10), C('C2', 9), C('C3', 8.5)], tree(), opts({ perLayerMax: 1 }));
    expect(items(r)).toEqual(['C1/summary/212/bucket:graze:C1']);
    expect(r.chargeSignals).toEqual(['C1']);
  });
});

describe('bucketSelect：包含吸收逐级', () => {
  it('命中一卷 + 其下一章 → 只剩卷；无关章保留', () => {
    const r = bucketSelect([C('V1', 5), C('C1', 8), C('C9', 2)], tree(), opts());
    // 卷层 V1 单条领先；章层 C1 领先（被 V1 吞）、C9 擦线（孤儿章保留）
    expect(items(r)).toEqual([
      'V1/body/313/bucket:lead:V1',
      'C9/summary/292/bucket:graze:C9',
    ]);
    expect(r.chargeSignals).toEqual(['C9']);
  });

  it('被吞的擦线单元不进 chargeSignals', () => {
    // 章层 C1 领先、C2 擦线；卷层 V1 命中 → 两章都被吞
    const r = bucketSelect([C('C1', 10), C('C2', 3), C('V1', 5)], tree(), opts());
    expect(items(r)).toEqual(['V1/body/313/bucket:lead:V1']);
    expect(r.chargeSignals).toEqual([]);
  });

  it('部吞卷、卷吞章逐级；隔层祖先同样吞', () => {
    // P 命中 → 吞 V1（子）与 C3（孙，经 V2）；V1 下的 C1 同时被 V1/P 吞
    const r = bucketSelect([C('P', 3), C('V1', 6), C('C1', 8), C('C3', 7)], tree(), opts());
    expect(items(r)).toEqual(['P/body/403/bucket:lead:P']);
    expect(r.chargeSignals).toEqual([]);
  });

  it('擦线祖先不吞领先后代：卷 summary 与章 body 共存', () => {
    // 卷层 V1=5、V2=4.5 无断崖 → 两卷都擦线；章层 C1 单条领先（body）→ 不被 V1 吞
    const r = bucketSelect([C('V1', 5), C('V2', 4.5), C('C1', 10)], tree(), opts());
    expect(items(r)).toEqual([
      'V1/summary/312/bucket:graze:V1',
      'V2/summary/322/bucket:graze:V2',
      'C1/body/213/bucket:lead:C1',
    ]);
    expect(r.chargeSignals).toEqual(['V1', 'V2']);   // 卷擦线仍计充能；章领先本就不计
  });

  it('领先祖先吞领先后代（回归）', () => {
    const r = bucketSelect([C('V1', 5), C('C1', 10)], tree(), opts());
    expect(items(r)).toEqual(['V1/body/313/bucket:lead:V1']);
    expect(r.chargeSignals).toEqual([]);
  });

  it('擦线祖先吞擦线后代', () => {
    // 卷层 V1/V2 都擦线；章层 C1=10、C2=9 无断崖都擦线 → C1/C2 被 V1 吞
    const r = bucketSelect([C('V1', 5), C('V2', 4.5), C('C1', 10), C('C2', 9)], tree(), opts());
    expect(items(r)).toEqual([
      'V1/summary/312/bucket:graze:V1',
      'V2/summary/322/bucket:graze:V2',
    ]);
    expect(r.chargeSignals).toEqual(['V1', 'V2']);
  });

  it('逐级取任一满足条件的祖先：部领先吞擦线卷下的领先章', () => {
    // 部 P 单条领先；卷层 V1/V2 擦线（均被 P 吞）；章 C1 领先 → V1 擦线不能吞，但 P 领先可吞
    const r = bucketSelect([C('P', 3), C('V1', 5), C('V2', 4.5), C('C1', 10)], tree(), opts());
    expect(items(r)).toEqual(['P/body/403/bucket:lead:P']);
    expect(r.chargeSignals).toEqual([]);
  });

  it('被限额截掉的高层条目不参与吸收', () => {
    // 卷层 perLayerMax=1：V2 入选、V1 被截 → V1 下的 C1 不被吞
    const r = bucketSelect([C('V2', 9), C('V1', 8), C('C1', 5)], tree(), opts({ perLayerMax: 1 }));
    expect(r.requests.map(q => q.id)).toEqual(['V2', 'C1']);
  });

  it('parent 成环安全终止', () => {
    const units = tree();
    units.set('X', U('X', 3, 'Y', 500));
    units.set('Y', U('Y', 2, 'X', 600));
    const r = bucketSelect([C('X', 5), C('Y', 5)], units, opts());
    // Y 的 parent 是 X → Y 被吞；X 的链 Y→X 成环，终止不报错
    expect(r.requests.map(q => q.id)).toEqual(['X']);
  });
});
