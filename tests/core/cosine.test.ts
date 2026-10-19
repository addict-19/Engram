// tests/core/cosine.test.ts
import { describe, it, expect } from 'vitest';
import { normalize, topK } from '../../src/core/cosine.js';

const v = (...n: number[]) => new Float32Array(n);

describe('cosine topK', () => {
  it('同向量分数≈1 且排第一', () => {
    const entries: [string, Float32Array][] = [
      ['same', normalize(v(1, 2, 3))],
      ['orth', normalize(v(-2, 1, 0))],
    ];
    const r = topK(normalize(v(1, 2, 3)), entries, 2);
    expect(r[0]!.id).toBe('same');
    expect(r[0]!.score).toBeCloseTo(1, 5);
    expect(r[1]!.score).toBeCloseTo(0, 5);
  });
  it('k 大于条目数不炸，k=0 返回空', () => {
    expect(topK(v(1), [['a', v(1)]], 5)).toHaveLength(1);
    expect(topK(v(1), [['a', v(1)]], 0)).toHaveLength(0);
  });
  it('分数降序，只取前 k 条', () => {
    const entries: [string, Float32Array][] = [
      ['lo', normalize(v(0, 1))],
      ['hi', normalize(v(1, 0))],
      ['mid', normalize(v(1, 1))],
      ['neg', normalize(v(-1, 0))],
    ];
    const r = topK(v(1, 0), entries, 3);
    expect(r.map((x) => x.id)).toEqual(['hi', 'mid', 'lo']);
  });
  it('normalize 零向量返回零向量（不除零、不抛错）', () => {
    const r = normalize(v(0, 0, 0));
    expect(Array.from(r)).toEqual([0, 0, 0]);
  });
  it('3 万条 512 维暴力扫描 < 500ms（性能护栏）', () => {
    const dim = 512, n = 30000;
    const entries: [string, Float32Array][] = Array.from({ length: n }, (_, i) => {
      const x = new Float32Array(dim);
      for (let j = 0; j < dim; j++) x[j] = Math.random();
      return [`e${i}`, normalize(x)];
    });
    const q = normalize(entries[0]![1]);
    const t0 = performance.now();
    topK(q, entries, 50);
    const elapsed = performance.now() - t0;
    console.log(`[perf] topK 30000x512 k=50: ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(500);
  });
});
