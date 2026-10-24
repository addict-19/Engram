// src/core/retrieval/fuse.ts
// 候选融合：标准 RRF（Reciprocal Rank Fusion）。只看名次不看原始分，BM25 与向量量纲无关地合并。
// 纯函数：零 IO、零全局状态、不修改入参。
import { EngramError } from '../errors.js';
import type { Candidate } from './types.js';

// 路由约定：lists 按位置对应来源，lists[0]=BM25，lists[1]=向量
const SOURCES = ['bm25', 'vec'] as const;

// score = Σ 1/(k+rank)，rank 为列表内数组位置（从 1 起，入参视为已按各自分数降序排好）；
// 同一列表内重复 id 只取首次（最佳名次）；同 id 跨列表累加并合并 sources；
// 输出按融合分降序，同分按首次出现顺序稳定排列
export function rrfFuse(lists: Array<Array<{id:string;score:number}>>, opts?: {k?: number}): Candidate[] {
  const k = opts?.k ?? 60;
  if (!Number.isFinite(k) || k < 0) throw new EngramError('E_FUSE_K', `RRF k 必须是非负有限数，收到 ${k}`);
  if (lists.length > SOURCES.length) {
    throw new EngramError('E_FUSE_LISTS', `RRF 最多融合 ${SOURCES.length} 路（bm25, vec），收到 ${lists.length} 路`);
  }

  const acc = new Map<string, { score: number; sources: Array<'bm25'|'vec'>; order: number }>();
  lists.forEach((list, li) => {
    const src = SOURCES[li]!;
    const seen = new Set<string>();
    list.forEach((item, idx) => {
      if (seen.has(item.id)) return;
      seen.add(item.id);
      const add = 1 / (k + idx + 1);
      const cur = acc.get(item.id);
      if (cur) {
        cur.score += add;
        cur.sources.push(src);
      } else {
        acc.set(item.id, { score: add, sources: [src], order: acc.size });
      }
    });
  });

  return [...acc.entries()]
    .sort((a, b) => b[1].score - a[1].score || a[1].order - b[1].order)
    .map(([id, v]) => ({ id, score: v.score, sources: v.sources }));
}

// 给命中锚点的候选打 anchorHit 标；只打标，不改分、不改顺序，返回新数组新对象
export function markAnchors(cands: Candidate[], anchorHitIds: Set<string>): Candidate[] {
  return cands.map(c => {
    const out: Candidate = { ...c, sources: [...c.sources] };
    if (anchorHitIds.has(c.id)) out.anchorHit = true;
    return out;
  });
}
