// src/core/cosine.ts
// 余弦暴力检索：纯函数、零依赖、零 IO。
// 入库前用 normalize 归一化，检索时点积即余弦。
// 维度不符直接抛 E_COS_DIM，绝不静默产出错误分数。

import { EngramError } from './errors.js';

/** L2 归一化，返回新数组。零向量原样返回一个零向量副本（不除零、不抛错）。 */
export function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  const out = new Float32Array(v.length);
  if (sum === 0) return out;
  const inv = 1 / Math.sqrt(sum);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! * inv;
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  const n = a.length;
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

/**
 * 全量暴力扫描取前 k 条，分数降序。
 * 内部用长度 k 的最小堆（堆顶为当前第 k 名），O(n·dim + n·log k)。
 */
export function topK(
  query: Float32Array,
  entries: Iterable<[string, Float32Array]>,
  k: number,
): Array<{ id: string; score: number }> {
  if (!(k > 0)) return [];
  const ids: string[] = [];
  const scores: number[] = [];

  const swap = (i: number, j: number) => {
    const ts = scores[i]!; scores[i] = scores[j]!; scores[j] = ts;
    const ti = ids[i]!; ids[i] = ids[j]!; ids[j] = ti;
  };
  const siftUp = (i: number) => {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (scores[p]! <= scores[i]!) break;
      swap(i, p);
      i = p;
    }
  };
  const siftDown = (i: number) => {
    const n = scores.length;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < n && scores[l]! < scores[m]!) m = l;
      if (r < n && scores[r]! < scores[m]!) m = r;
      if (m === i) break;
      swap(i, m);
      i = m;
    }
  };

  const dim = query.length;
  for (const [id, vec] of entries) {
    if (vec.length !== dim) {
      throw new EngramError(
        'E_COS_DIM',
        `E_COS_DIM: entry "${id}" 维度 ${vec.length} 与 query 维度 ${dim} 不符`,
      );
    }
    const s = dot(query, vec);
    if (scores.length < k) {
      ids.push(id);
      scores.push(s);
      siftUp(scores.length - 1);
    } else if (s > scores[0]!) {
      ids[0] = id;
      scores[0] = s;
      siftDown(0);
    }
  }

  const out = ids.map((id, i) => ({ id, score: scores[i]! }));
  out.sort((a, b) => b.score - a.score);
  return out;
}
