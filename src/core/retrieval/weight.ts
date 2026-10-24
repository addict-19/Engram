// src/core/retrieval/weight.ts
// 加权层：@关联加权 × importance 加权 → 自然加权分，再与上轮回响保底取 max。
// 纯函数：零 IO、零全局状态、不修改入参（含 meta 的 Set/Map）。
import type { Candidate } from './types.js';

export interface WeightOpts {
  atTagBoost?: number;          // @关联：默认 1.2 倍（轻加权）
  atPulseBoost?: number;        // 新关联脉冲期：默认 1.5 倍
  importanceFactor?: number;    // 默认 0.02：score *= 1 + importance*factor（importance 0~10）
  echoDecay?: number;           // 回响衰减默认 0.6
}

// 回响规则：candScore = max(本轮自然加权分, 上轮分×echoDecay)——自然分高时绝不被回响拉低；
// 上轮入选但本轮无自然候选的 id 以保底分补入（sources 空、无 anchorHit，不吃 @/importance 加成）；
// 输出按分数降序，同分按输入顺序稳定（补入者排在原候选之后、按 prevSelected 迭代顺序）
export interface WeightMeta {
  atTagged: Set<string>; atPulsed: Set<string>;
  importance: Map<string, number>;
  prevSelected: Map<string, number>;
}

export function applyWeights(cands: Candidate[], meta: WeightMeta, opts?: WeightOpts): Candidate[] {
  const atTagBoost = opts?.atTagBoost ?? 1.2;
  const atPulseBoost = opts?.atPulseBoost ?? 1.5;
  const importanceFactor = opts?.importanceFactor ?? 0.02;
  const echoDecay = opts?.echoDecay ?? 0.6;

  const out: Candidate[] = [];
  const present = new Set<string>();

  for (const c of cands) {
    present.add(c.id);
    // 同在两集合取脉冲（更高者），不叠乘
    const atMul = meta.atPulsed.has(c.id) ? atPulseBoost : meta.atTagged.has(c.id) ? atTagBoost : 1;
    const impMul = 1 + (meta.importance.get(c.id) ?? 0) * importanceFactor;
    const natural = c.score * atMul * impMul;
    const prev = meta.prevSelected.get(c.id);
    const score = prev === undefined ? natural : Math.max(natural, prev * echoDecay);
    out.push({ ...c, sources: [...c.sources], score });
  }

  for (const [id, prev] of meta.prevSelected) {
    if (present.has(id)) continue;
    out.push({ id, score: prev * echoDecay, sources: [] });
  }

  // Array.prototype.sort 稳定（ES2019+），同分保持上面的推入顺序
  return out.sort((a, b) => b.score - a.score);
}
