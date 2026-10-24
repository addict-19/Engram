// tests/core/retrieval/charge.test.ts
import { describe, it, expect } from 'vitest';
import { gradeAndCluster } from '../../../src/core/retrieval/charge.js';
import type { Candidate, UnitInfo, UnitMap } from '../../../src/core/retrieval/types.js';

const C = (id: string, score: number): Candidate => ({ id, score, sources: ['bm25'] });

// 每个单元的三形态 token 按 id 区分，便于断言 tokens 取对了形态
const U = (id: string, layer: number, parent: string | null, base: number): UnitInfo => ({
  id, kind: layer === 0 ? 'slice' : 'unit', layer, parent,
  tokens: { title: base + 1, summary: base + 2, body: base + 3 },
});

// 卷 V ─ 章 C1 ─ 节 N1(s1,s2,s3) / 节 N2(s4)
//      └ 章 C2 ─ 节 N3(s5,s6)；C2 下直挂切片 s7（无节）
// 另有孤儿章 C9（无卷）─ 节 N9(s9)
function tree(): UnitMap {
  const list: UnitInfo[] = [
    U('V', 3, null, 300),
    U('C1', 2, 'V', 210), U('C2', 2, 'V', 220),
    U('N1', 1, 'C1', 110), U('N2', 1, 'C1', 120), U('N3', 1, 'C2', 130),
    U('s1', 0, 'N1', 0), U('s2', 0, 'N1', 0), U('s3', 0, 'N1', 0),
    U('s4', 0, 'N2', 0), U('s5', 0, 'N3', 0), U('s6', 0, 'N3', 0),
    U('s7', 0, 'C2', 0),
    U('C9', 2, null, 290), U('N9', 1, 'C9', 190), U('s9', 0, 'N9', 0),
  ];
  return new Map(list.map(u => [u.id, u]));
}

const opts = (o: Partial<{ nodeClusterMin: number; directNodeHits: Set<string> }> = {}) =>
  ({ cliff: { ratio: 1.5 }, ...o });

const gradeOf = (r: ReturnType<typeof gradeAndCluster>, id: string) =>
  r.slices.find(s => s.id === id)?.grade;
const items = (r: ReturnType<typeof gradeAndCluster>) =>
  r.upgrades.map(u => `${u.id}/${u.form}/${u.tokens}/${u.reason}`);

describe('gradeAndCluster：四档', () => {
  it('precise：断崖前切片 → 节 body + 章 summary + 卷 summary', () => {
    const r = gradeAndCluster([C('s1', 10), C('s5', 2), C('s9', 1.9)], tree(), opts());
    expect(gradeOf(r, 's1')).toBe('precise');
    expect(gradeOf(r, 's5')).toBe('mention');
    expect(gradeOf(r, 's9')).toBe('mention');
    expect(items(r)).toEqual([
      'N1/body/113/precise:s1',
      'C1/summary/212/precise:s1',
      'V/summary/302/precise:s1',
    ]);
  });

  it('nodeCluster：同节 ≥2 条命中 → 节 body + 章 summary + 卷 summary', () => {
    const r = gradeAndCluster([C('s1', 1), C('s2', 1), C('s5', 1)], tree(), opts());
    expect(gradeOf(r, 's1')).toBe('nodeCluster');
    expect(gradeOf(r, 's2')).toBe('nodeCluster');
    expect(gradeOf(r, 's5')).toBe('mention');
    expect(items(r)).toEqual([
      'N1/body/113/nodeCluster:N1',
      'C1/summary/212/nodeCluster:N1',
      'V/summary/302/nodeCluster:N1',
    ]);
  });

  it('chapterCluster：同章跨 ≥2 个节 → 章 body + 卷 summary', () => {
    const r = gradeAndCluster([C('s1', 1), C('s4', 1), C('s5', 1)], tree(), opts());
    expect(gradeOf(r, 's1')).toBe('chapterCluster');
    expect(gradeOf(r, 's4')).toBe('chapterCluster');
    expect(gradeOf(r, 's5')).toBe('mention');
    expect(items(r)).toEqual([
      'C1/body/213/chapterCluster:C1',
      'V/summary/302/chapterCluster:C1',
    ]);
  });

  it('孤立低分 = mention，无升级产物', () => {
    const r = gradeAndCluster([C('s1', 1), C('s5', 1)], tree(), opts());
    expect(r.slices.map(s => s.grade)).toEqual(['mention', 'mention']);
    expect(r.upgrades).toEqual([]);
  });

  it('nodeClusterMin 可调：设 3 时同节 2 条不成聚集', () => {
    const r = gradeAndCluster([C('s1', 1), C('s2', 1), C('s5', 1)], tree(), opts({ nodeClusterMin: 3 }));
    expect(gradeOf(r, 's1')).toBe('mention');
    const r3 = gradeAndCluster([C('s1', 1), C('s2', 1), C('s3', 1)], tree(), opts({ nodeClusterMin: 3 }));
    expect(r3.slices.every(s => s.grade === 'nodeCluster')).toBe(true);
  });
});

describe('gradeAndCluster：档位互斥', () => {
  it('一条切片只归最高适用档：precise > nodeCluster > chapterCluster', () => {
    // s1 断崖领先且与 s2 同节，s4 与 N1 同章异节
    const r = gradeAndCluster([C('s1', 10), C('s2', 1), C('s4', 1)], tree(), opts());
    expect(r.slices).toEqual([
      { id: 's1', grade: 'precise', score: 10 },
      { id: 's2', grade: 'nodeCluster', score: 1 },
      { id: 's4', grade: 'chapterCluster', score: 1 },
    ]);
    expect(r.slices.length).toBe(3);
  });

  it('slices 按分数降序输出、同分稳定', () => {
    const r = gradeAndCluster([C('s5', 1), C('s1', 2), C('s9', 1)], tree(), opts({}));
    expect(r.slices.map(s => s.id)).toEqual(['s1', 's5', 's9']);
  });
});

describe('gradeAndCluster：充能', () => {
  it('充能沿 parent 链逐层累加切片分数', () => {
    const r = gradeAndCluster([C('s1', 1), C('s2', 2), C('s4', 4), C('s5', 8)], tree(), opts());
    expect(r.charge.get('N1')).toBeCloseTo(3, 12);
    expect(r.charge.get('N2')).toBeCloseTo(4, 12);
    expect(r.charge.get('N3')).toBeCloseTo(8, 12);
    expect(r.charge.get('C1')).toBeCloseTo(7, 12);
    expect(r.charge.get('C2')).toBeCloseTo(8, 12);
    expect(r.charge.get('V')).toBeCloseTo(15, 12);
    expect(r.charge.has('s1')).toBe(false); // 只记祖先
  });

  it('directNodeHits：节额外 +1 充能并沿链上传', () => {
    const r = gradeAndCluster([C('s1', 1), C('s5', 1)], tree(), opts({ directNodeHits: new Set(['N1']) }));
    expect(r.charge.get('N1')).toBeCloseTo(2, 12);
    expect(r.charge.get('C1')).toBeCloseTo(2, 12);
    expect(r.charge.get('V')).toBeCloseTo(3, 12);
  });

  it('directNodeHits 并账触发节内聚集（单条命中也升级）', () => {
    const r = gradeAndCluster([C('s1', 1), C('s5', 1)], tree(), opts({ directNodeHits: new Set(['N1']) }));
    expect(gradeOf(r, 's1')).toBe('nodeCluster');
    expect(gradeOf(r, 's5')).toBe('mention');
    expect(items(r)).toEqual([
      'N1/body/113/nodeCluster:N1',
      'C1/summary/212/nodeCluster:N1',
      'V/summary/302/nodeCluster:N1',
    ]);
  });

  it('directNodeHits 的节无命中切片时仍产出节内聚集升级，且计入章内跨节', () => {
    const r = gradeAndCluster([C('s4', 1), C('s5', 1)], tree(), opts({ directNodeHits: new Set(['N1']) }));
    expect(r.charge.get('N1')).toBeCloseTo(1, 12);
    expect(gradeOf(r, 's4')).toBe('chapterCluster'); // N1(直接命中) + N2(s4) 同章跨节
    expect(items(r)).toEqual([
      'N1/body/113/nodeCluster:N1',
      'C1/summary/212/nodeCluster:N1',
      'V/summary/302/nodeCluster:N1',
      'C1/body/213/chapterCluster:C1',
      'V/summary/302/chapterCluster:C1',
    ]);
  });

  it('directNodeHits 中不在 units 或非节的 id 忽略', () => {
    const r = gradeAndCluster([C('s1', 1), C('s5', 1)], tree(),
      opts({ directNodeHits: new Set(['ghost', 'C1', 's1']) }));
    expect(r.slices.every(s => s.grade === 'mention')).toBe(true);
    expect(r.upgrades).toEqual([]);
    expect(r.charge.get('C1')).toBeCloseTo(1, 12);
  });
});

describe('gradeAndCluster：祖先缺层不炸', () => {
  it('切片直挂章下：precise 跳过节层，只出章 summary + 卷 summary', () => {
    const r = gradeAndCluster([C('s7', 10), C('s1', 1), C('s9', 1)], tree(), opts());
    expect(gradeOf(r, 's7')).toBe('precise');
    expect(items(r)).toEqual(['C2/summary/222/precise:s7', 'V/summary/302/precise:s7']);
  });

  it('无节切片与同章节内切片：不算节数，但随章聚集归 chapterCluster', () => {
    const one = gradeAndCluster([C('s7', 1), C('s5', 1), C('s1', 1)], tree(), opts());
    expect(gradeOf(one, 's7')).toBe('mention'); // C2 只有 N3 一个节，无节切片不凑数
    expect(gradeOf(one, 's5')).toBe('mention');
    const m = tree();
    m.set('N4', U('N4', 1, 'C2', 140));
    m.set('s8', U('s8', 0, 'N4', 0));
    const r = gradeAndCluster([C('s7', 1), C('s5', 1), C('s8', 1)], m, opts());
    expect(r.slices.every(s => s.grade === 'chapterCluster')).toBe(true);
    expect(items(r)).toEqual(['C2/body/223/chapterCluster:C2', 'V/summary/302/chapterCluster:C2']);
  });

  it('树顶缺卷：章聚集 / 精准只出存在的层', () => {
    const r = gradeAndCluster([C('s9', 10), C('s1', 1), C('s5', 1)], tree(), opts());
    expect(gradeOf(r, 's9')).toBe('precise');
    expect(items(r)).toEqual(['N9/body/193/precise:s9', 'C9/summary/292/precise:s9']);
  });

  it('候选不在 units / parent 指向不存在的单元：归 mention、无充能、不抛', () => {
    const m = tree();
    m.set('sx', U('sx', 0, 'missing', 0));
    const r = gradeAndCluster([C('ghost', 1), C('sx', 1), C('s1', 1)], m, opts());
    expect(r.slices.map(s => s.grade)).toEqual(['mention', 'mention', 'mention']);
    expect(r.charge.has('missing')).toBe(false);
  });

  it('parent 成环不死循环', () => {
    const m: UnitMap = new Map([
      ['A', U('A', 1, 'B', 10)], ['B', U('B', 2, 'A', 20)], ['s', U('s', 0, 'A', 0)],
    ]);
    const r = gradeAndCluster([C('s', 1)], m, opts());
    expect(r.charge.get('A')).toBeCloseTo(1, 12);
    expect(r.charge.get('B')).toBeCloseTo(1, 12);
  });

  it('空候选返回空结果；不修改入参', () => {
    const r = gradeAndCluster([], tree(), opts());
    expect(r).toEqual({ slices: [], upgrades: [], charge: new Map() });
    const cands = [C('s2', 1), C('s1', 5)];
    const snap = JSON.stringify(cands);
    gradeAndCluster(cands, tree(), opts());
    expect(JSON.stringify(cands)).toBe(snap);
  });
});
