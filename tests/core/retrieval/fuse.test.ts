// tests/core/retrieval/fuse.test.ts
import { describe, it, expect } from 'vitest';
import { rrfFuse, markAnchors } from '../../../src/core/retrieval/fuse.js';
import type { Candidate } from '../../../src/core/retrieval/types.js';

const L = (...ids: string[]) => ids.map((id, i) => ({ id, score: 100 - i }));

describe('rrfFuse', () => {
  it('两列表同 id 融合分叠加，sources 取并集', () => {
    const r = rrfFuse([L('a', 'b'), L('b', 'c')]);
    const b = r.find(c => c.id === 'b')!;
    expect(b.score).toBeCloseTo(1 / 62 + 1 / 61, 12);
    expect(b.sources).toEqual(['bm25', 'vec']);
    expect(r.find(c => c.id === 'a')!.sources).toEqual(['bm25']);
    expect(r.find(c => c.id === 'c')!.sources).toEqual(['vec']);
    expect(r[0]!.id).toBe('b');
    expect(r.map(c => c.id)).toHaveLength(3);
  });

  it('单列表退化保序，分数为 1/(k+rank)，rank 从 1 起', () => {
    const r = rrfFuse([L('x', 'y', 'z')]);
    expect(r.map(c => c.id)).toEqual(['x', 'y', 'z']);
    expect(r[0]!.score).toBeCloseTo(1 / 61, 12);
    expect(r[2]!.score).toBeCloseTo(1 / 63, 12);
  });

  it('只看名次不看原始分（量纲无关）', () => {
    const r1 = rrfFuse([[{ id: 'a', score: 9999 }, { id: 'b', score: 0.001 }]]);
    const r2 = rrfFuse([[{ id: 'a', score: 0.5 }, { id: 'b', score: 0.4 }]]);
    expect(r1).toEqual(r2);
  });

  it('k 可配，且能改变排序', () => {
    // a: bm25 第1 → 1/(k+1)
    // b: bm25 第3 + vec 第3 → 2/(k+3)
    // k=0: a=1 > b=0.667；k=60: a=1/61≈0.0164 < b=2/63≈0.0317
    const lists = [L('a', 'x', 'b'), L('y', 'z', 'b')];
    expect(rrfFuse(lists, { k: 0 })[0]!.id).toBe('a');
    expect(rrfFuse(lists)[0]!.id).toBe('b');
    expect(rrfFuse(lists, { k: 60 })[0]!.id).toBe('b');
  });

  it('同分并列时按首次出现顺序稳定排列', () => {
    const r = rrfFuse([L('a'), L('b')]);
    expect(r.map(c => c.id)).toEqual(['a', 'b']);
  });

  it('同一列表内重复 id 只取最佳名次', () => {
    const r = rrfFuse([L('a', 'b', 'a')]);
    expect(r.map(c => c.id)).toEqual(['a', 'b']);
    expect(r[0]!.score).toBeCloseTo(1 / 61, 12);
    expect(r[1]!.score).toBeCloseTo(1 / 62, 12);
  });

  it('空输入返回空数组', () => {
    expect(rrfFuse([])).toEqual([]);
    expect(rrfFuse([[], []])).toEqual([]);
  });

  it('不修改入参数组', () => {
    const lists = [L('a', 'b'), L('b', 'a')];
    const snap = JSON.parse(JSON.stringify(lists));
    rrfFuse(lists);
    expect(lists).toEqual(snap);
  });

  it('非法 k 抛 E_FUSE_K；超过两路列表抛 E_FUSE_LISTS', () => {
    expect(() => rrfFuse([L('a')], { k: -1 })).toThrow(expect.objectContaining({ code: 'E_FUSE_K' }));
    expect(() => rrfFuse([L('a')], { k: Number.NaN })).toThrow(expect.objectContaining({ code: 'E_FUSE_K' }));
    expect(() => rrfFuse([L('a'), L('b'), L('c')])).toThrow(expect.objectContaining({ code: 'E_FUSE_LISTS' }));
  });
});

describe('markAnchors', () => {
  const cands: Candidate[] = [
    { id: 'a', score: 0.03, sources: ['bm25'] },
    { id: 'b', score: 0.02, sources: ['vec'] },
  ];

  it('只打标不改分、不改顺序', () => {
    const r = markAnchors(cands, new Set(['b']));
    expect(r.map(c => c.id)).toEqual(['a', 'b']);
    expect(r.map(c => c.score)).toEqual([0.03, 0.02]);
    expect(r[1]!.anchorHit).toBe(true);
    expect(r[0]!.anchorHit).toBeUndefined();
  });

  it('不修改入参', () => {
    const snap = JSON.parse(JSON.stringify(cands));
    const r = markAnchors(cands, new Set(['a', 'b']));
    expect(cands).toEqual(snap);
    expect(r[0]).not.toBe(cands[0]);
    expect(r[0]!.sources).not.toBe(cands[0]!.sources);
  });

  it('集合中不在候选里的 id 被忽略', () => {
    expect(markAnchors(cands, new Set(['zzz'])).every(c => c.anchorHit === undefined)).toBe(true);
  });
});
