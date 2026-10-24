// tests/core/retrieval/assemble.test.ts
import { describe, it, expect } from 'vitest';
import { assemble } from '../../../src/core/retrieval/assemble.js';
import type { Form, InjectionItem, UnitInfo, UnitMap } from '../../../src/core/retrieval/types.js';

// 三形态 token：title=t, summary=s, body=b
const U = (id: string, layer: number, tk: [number, number, number], ts?: string): UnitInfo => ({
  id, kind: layer === 0 ? 'slice' : 'unit', layer, parent: null,
  tokens: { title: tk[0], summary: tk[1], body: tk[2] }, ...(ts !== undefined ? { ts } : {}),
});
const I = (id: string, form: Form, tokens: number, reason: string): InjectionItem => ({ id, form, tokens, reason });
const fmt = (xs: InjectionItem[]) => xs.map(x => `${x.id}/${x.form}/${x.tokens}/${x.reason}`);
const ids = (xs: InjectionItem[]) => xs.map(x => x.id);

function units(): UnitMap {
  const list: UnitInfo[] = [
    U('N1', 1, [5, 50, 500], '001'),
    U('N2', 1, [6, 60, 600], '002'),
    U('C1', 2, [7, 70, 700], '003'),
    U('C2', 2, [8, 80, 800], '004'),
    U('V1', 3, [9, 90, 900], '005'),
    U('S1', 0, [1, 10, 100], '000'),
  ];
  return new Map(list.map(u => [u.id, u]));
}
const BIG = { recallBudget: 1_000_000 };
const none = new Map<string, Form>();

describe('assemble 三方去重', () => {
  it('常驻已有形态 ≥ 请求形态 → 删请求（相等与更高两种）', () => {
    const r = assemble({
      resident: new Map<string, Form>([['C1', 'summary'], ['V1', 'body']]),
      clusterItems: [I('C1', 'summary', 70, 'precise:S1')],
      bucketItems: [I('V1', 'summary', 90, 'bucket:graze:V1')],
    }, units(), BIG);
    expect(r.final).toEqual([]);
    expect(r.dropped).toEqual([]); // 去重删除不算 dropped
  });

  it('常驻形态低于请求形态 → 不删（升级保留）', () => {
    const r = assemble({
      resident: new Map<string, Form>([['C1', 'title'], ['C2', 'summary']]),
      clusterItems: [I('C1', 'summary', 70, 'precise:S1')],
      bucketItems: [I('C2', 'body', 800, 'bucket:lead:C2')],
    }, units(), BIG);
    expect(fmt(r.final)).toEqual(['C1/summary/70/precise:S1', 'C2/body/800/bucket:lead:C2']);
  });

  it('同 id 在 cluster 与 bucket 都出现 → 保一条，reason 记 cluster 来源', () => {
    const r = assemble({
      resident: none,
      clusterItems: [I('C1', 'body', 700, 'chapterCluster:C1')],
      bucketItems: [I('C1', 'body', 700, 'bucket:lead:C1')],
    }, units(), BIG);
    expect(fmt(r.final)).toEqual(['C1/body/700/chapterCluster:C1']);
  });

  it('bucket 形态更高时取最高形态，reason 仍记高优先来源 cluster', () => {
    const r = assemble({
      resident: none,
      clusterItems: [I('C1', 'summary', 70, 'precise:S1')],
      bucketItems: [I('C1', 'body', 700, 'bucket:lead:C1')],
    }, units(), BIG);
    expect(fmt(r.final)).toEqual(['C1/body/700/precise:S1']);
  });

  it('常驻对合并后的最高形态判定：常驻 summary、cluster summary + bucket body → 保 body', () => {
    const r = assemble({
      resident: new Map<string, Form>([['C1', 'summary']]),
      clusterItems: [I('C1', 'summary', 70, 'precise:S1')],
      bucketItems: [I('C1', 'body', 700, 'bucket:lead:C1')],
    }, units(), BIG);
    expect(fmt(r.final)).toEqual(['C1/body/700/precise:S1']);
  });
});

describe('assemble 同单元多形态合并', () => {
  it('Task 6 产物同一单元 summary 与 body 并存 → 只留 body 一条', () => {
    const r = assemble({
      resident: none,
      clusterItems: [
        I('C1', 'summary', 70, 'precise:S1'),
        I('N1', 'body', 500, 'precise:S1'),
        I('C1', 'body', 700, 'chapterCluster:C1'),
        I('C1', 'summary', 70, 'nodeCluster:N1'),
      ],
      bucketItems: [],
    }, units(), BIG);
    expect(fmt(r.final)).toEqual(['N1/body/500/precise:S1', 'C1/body/700/chapterCluster:C1']);
  });

  it('同形态多次出现取首条 reason', () => {
    const r = assemble({
      resident: none,
      clusterItems: [I('V1', 'summary', 90, 'precise:S1'), I('V1', 'summary', 90, 'nodeCluster:N1')],
      bucketItems: [],
    }, units(), BIG);
    expect(fmt(r.final)).toEqual(['V1/summary/90/precise:S1']);
  });
});

describe('assemble 预算阶梯', () => {
  it('不超预算全进（恰好等于预算也全进）', () => {
    const r = assemble({
      resident: none,
      clusterItems: [I('N1', 'body', 500, 'precise:S1')],
      bucketItems: [I('C2', 'summary', 80, 'bucket:graze:C2')],
    }, units(), { recallBudget: 580 });
    expect(fmt(r.final)).toEqual(['N1/body/500/precise:S1', 'C2/summary/80/bucket:graze:C2']);
    expect(r.dropped).toEqual([]);
  });

  it('降形态后装下：最低价值者 body→summary，tokens 换成 summary 值', () => {
    // bucket 来源价值最低 → C2 先降
    const r = assemble({
      resident: none,
      clusterItems: [I('N1', 'body', 500, 'precise:S1')],
      bucketItems: [I('C2', 'body', 800, 'bucket:lead:C2')],
    }, units(), { recallBudget: 600 });
    expect(fmt(r.final)).toEqual(['N1/body/500/precise:S1', 'C2/summary/80/bucket:lead:C2']);
    expect(r.dropped).toEqual([]);
  });

  it('降到 title 才装下', () => {
    const r = assemble({
      resident: none,
      clusterItems: [I('N1', 'body', 500, 'precise:S1')],
      bucketItems: [I('C2', 'body', 800, 'bucket:lead:C2')],
    }, units(), { recallBudget: 510 });
    expect(fmt(r.final)).toEqual(['N1/body/500/precise:S1', 'C2/title/8/bucket:lead:C2']);
  });

  it('降完仍超 → 整条弃进 dropped（原形态原 tokens），再处理下一条', () => {
    const r = assemble({
      resident: none,
      clusterItems: [I('N1', 'body', 500, 'precise:S1')],
      bucketItems: [I('C2', 'body', 800, 'bucket:lead:C2')],
    }, units(), { recallBudget: 60 });
    // C2 降到 title 仍超（500+8>60）→ 弃；N1 降到 summary 50 装下
    expect(fmt(r.final)).toEqual(['N1/summary/50/precise:S1']);
    expect(fmt(r.dropped)).toEqual(['C2/body/800/bucket:lead:C2']);
  });

  it('切片不可降：超预算直接整条弃', () => {
    const r = assemble({
      resident: none,
      clusterItems: [I('N1', 'summary', 50, 'precise:S1'), I('S1', 'body', 100, 'precise:S1')],
      bucketItems: [],
    }, units(), { recallBudget: 60 });
    // 同源同 key，tokens 大者价值低 → S1 先处理：切片不可降 → 弃
    expect(fmt(r.final)).toEqual(['N1/summary/50/precise:S1']);
    expect(fmt(r.dropped)).toEqual(['S1/body/100/precise:S1']);
  });

  it('永不拆半条：边界条目只差 1 token 也整条降/弃，不截断', () => {
    const r = assemble({
      resident: none,
      clusterItems: [I('S1', 'body', 100, 'precise:S1')],
      bucketItems: [],
    }, units(), { recallBudget: 99 });
    expect(r.final).toEqual([]);
    expect(fmt(r.dropped)).toEqual(['S1/body/100/precise:S1']);
    for (const x of [...r.final, ...r.dropped]) {
      const u = units().get(x.id)!;
      expect([u.tokens.title, u.tokens.summary, u.tokens.body]).toContain(x.tokens);
    }
  });

  it('价值序：cluster 优先于 bucket（bucket 先被弃）', () => {
    const r = assemble({
      resident: none,
      clusterItems: [I('S1', 'body', 100, 'mention:S1')],
      bucketItems: [I('S1x', 'body', 10, 'bucket:lead:S1x')],
    }, new Map([...units(), ['S1x', U('S1x', 0, [1, 1, 10])]]), { recallBudget: 100 });
    expect(ids(r.final)).toEqual(['S1']);
    expect(ids(r.dropped)).toEqual(['S1x']);
  });

  it('价值序：同源内 reason 含 precise/lead 的优先保留', () => {
    const m = new Map([...units(), ['Sa', U('Sa', 0, [1, 1, 10])], ['Sb', U('Sb', 0, [1, 1, 50])]]);
    const r = assemble({
      resident: none,
      clusterItems: [I('Sa', 'body', 10, 'nodeCluster:N1'), I('Sb', 'body', 50, 'precise:Sb')],
      bucketItems: [],
    }, m, { recallBudget: 55 });
    expect(ids(r.final)).toEqual(['Sb']);
    expect(ids(r.dropped)).toEqual(['Sa']);
  });

  it('价值序：同源同 key 时 tokens 小者优先保留', () => {
    const m = new Map([...units(), ['Sa', U('Sa', 0, [1, 1, 10])], ['Sb', U('Sb', 0, [1, 1, 50])]]);
    const r = assemble({
      resident: none,
      clusterItems: [I('Sb', 'body', 50, 'mention:Sb'), I('Sa', 'body', 10, 'mention:Sa')],
      bucketItems: [],
    }, m, { recallBudget: 55 });
    expect(ids(r.final)).toEqual(['Sa']);
    expect(ids(r.dropped)).toEqual(['Sb']);
  });

  it('默认预算 8000', () => {
    const m = new Map([['Sa', U('Sa', 0, [1, 1, 8001])]]);
    const r = assemble({ resident: none, clusterItems: [I('Sa', 'body', 8001, 'precise:Sa')], bucketItems: [] }, m);
    expect(ids(r.dropped)).toEqual(['Sa']);
  });
});

describe('assemble 时间排序与容错', () => {
  it('final 按 ts 升序，缺 ts 与孤儿排尾部保持相对序', () => {
    const m = units();
    m.set('X', U('X', 2, [1, 2, 3])); // 无 ts
    const r = assemble({
      resident: none,
      clusterItems: [I('V1', 'summary', 90, 'precise:S1'), I('orphan', 'body', 33, 'precise:orphan'), I('N1', 'body', 500, 'precise:S1')],
      bucketItems: [I('X', 'body', 3, 'bucket:lead:X'), I('C1', 'summary', 70, 'bucket:graze:C1')],
    }, m, BIG);
    expect(ids(r.final)).toEqual(['N1', 'C1', 'V1', 'orphan', 'X']);
  });

  it('孤儿切片 tokens 以条目自带值为准、不可降', () => {
    const r = assemble({
      resident: none,
      clusterItems: [I('orphan', 'body', 33, 'precise:orphan')],
      bucketItems: [],
    }, units(), { recallBudget: 32 });
    expect(fmt(r.dropped)).toEqual(['orphan/body/33/precise:orphan']);
  });

  it('空输入', () => {
    expect(assemble({ resident: none, clusterItems: [], bucketItems: [] }, new Map(), BIG))
      .toEqual({ final: [], dropped: [] });
  });

  it('不修改入参', () => {
    const resident = new Map<string, Form>([['C1', 'title']]);
    const clusterItems = [I('C1', 'body', 700, 'precise:S1'), I('C1', 'summary', 70, 'precise:S1')];
    const bucketItems = [I('C2', 'body', 800, 'bucket:lead:C2')];
    const m = units();
    const snap = JSON.stringify([[...resident], clusterItems, bucketItems, [...m]]);
    const r = assemble({ resident, clusterItems, bucketItems }, m, { recallBudget: 100 });
    expect(JSON.stringify([[...resident], clusterItems, bucketItems, [...m]])).toBe(snap);
    for (const x of r.final) expect(clusterItems.concat(bucketItems)).not.toContain(x);
  });
});

describe('assemble opts 逐项默认', () => {
  it('opts 传 {} 时 recallBudget 仍按默认 8000 生效（不静默失效）', () => {
    const m = new Map([['X', U('X', 2, [10, 100, 9000], '001')]]);
    const parts = { resident: none, clusterItems: [I('X', 'body', 9000, 'chapterCluster:X')], bucketItems: [] };
    expect(fmt(assemble(parts, m, {}).final)).toEqual(['X/summary/100/chapterCluster:X']);
    expect(fmt(assemble(parts, m).final)).toEqual(['X/summary/100/chapterCluster:X']);
  });
});
