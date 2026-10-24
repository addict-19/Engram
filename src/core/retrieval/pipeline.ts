// src/core/retrieval/pipeline.ts
// 检索管线总装 retrieve()：把 Task 4-9 的各层纯函数按 M2 专场第 7 题顺序串起来。
// 纯函数：零 IO、不修改入参；rerank / vecSim 由调用方注入（模型调用在上层）。
//
// 顺序：rrfFuse → markAnchors → applyWeights → （可选 rerank，锚点免死金牌）
//   → 按 units 分流（切片 / layer=1 节 → directNodeHits / layer≥2 → 高层桶）
//   → gradeAndCluster + bucketSelect → PPR 补条（mention 档并入 clusterItems）→ assemble

import type { Candidate, Form, InjectionItem, UnitMap } from './types.js';
import { rrfFuse, markAnchors } from './fuse.js';
import { applyWeights, type WeightMeta, type WeightOpts } from './weight.js';
import { gradeAndCluster, type GradedSlice } from './charge.js';
import { bucketSelect, type BucketOpts } from './bucket.js';
import { assemble } from './assemble.js';
import { pprExpand, type PPRNode, type PPROpts } from './ppr.js';
import type { CliffOpts } from './cliff.js';

export interface RetrieveOpts {
  fuseK?: number;                                   // RRF k，默认 60
  weight?: WeightOpts;
  rerank?: (ids: string[]) => Map<string, number>;  // 可选重排注入
  rerankTopN?: number;                              // 送重排的前 N 条，默认 20
  cliff?: CliffOpts;                                // 切片桶断崖参数
  nodeClusterMin?: number;
  bucket?: Partial<BucketOpts>;                     // floor 默认 0；cliff 缺省沿用切片 cliff
  ppr?: PPROpts;
  recallBudget?: number;                            // 召回池预算，缺省走 assemble 默认 8000
  baseFloor?: number;                               // 基础线，默认 0.01：切片/节候选低于此分剔除，桶 floor 缺省也取它
  maxSlices?: number;                               // 切片本体注入条数上限，默认 10（升级产物/上层单元不占名额）
}

export const DEFAULT_BASE_FLOOR = 0.01;
export const DEFAULT_MAX_SLICES = 10;

export interface RetrieveInput {
  bm25Results: Array<{ id: string; score: number }>;
  vecResults: Array<{ id: string; score: number }>;
  anchorHitIds: Set<string>;
  units: UnitMap;
  weightMeta: WeightMeta;
  resident: Map<string, Form>;
  pprNodes?: PPRNode[];
  vecSim?: (a: string, b: string) => number;
  opts?: RetrieveOpts;
}

export interface RetrieveResult {
  final: InjectionItem[]; dropped: InjectionItem[]; grades: GradedSlice[];
  chargeSignals: string[];   // bucketSelect 擦线单元 id，原样透传（供跨轮充能 / 面板）
  charge: Map<string, number>; // gradeAndCluster 的祖先充能表，原样透传
}

// 重排：只对前 topN 条调用；anchorHit 者取 max(rerank分, 原分)（锚点免死金牌），其余用 rerank 分；
// rerank 未返回分的条目保留原分。重排段内按新分降序（同分稳定），段外候选原序接在其后。
function applyRerank(cands: Candidate[], rerank: (ids: string[]) => Map<string, number>, topN: number): Candidate[] {
  const n = Math.max(0, topN);
  const head = cands.slice(0, n);
  const rest = cands.slice(n);
  if (head.length === 0) return cands;
  const scores = rerank(head.map(c => c.id));
  const rescored = head.map(c => {
    const r = scores.get(c.id);
    if (r === undefined) return c;
    return { ...c, score: c.anchorHit ? Math.max(r, c.score) : r };
  });
  rescored.sort((a, b) => b.score - a.score);
  return [...rescored, ...rest];
}

export function retrieve(input: RetrieveInput): RetrieveResult {
  const { units, opts = {} } = input;

  // 1-2. 融合 → 锚点打标 → 加权
  const fused = markAnchors(rrfFuse([input.bm25Results, input.vecResults], { k: opts.fuseK }), input.anchorHitIds);
  let ranked = applyWeights(fused, input.weightMeta, opts.weight);

  // 3. 可选重排
  if (opts.rerank) ranked = applyRerank(ranked, opts.rerank, opts.rerankTopN ?? 20);

  // 4. 分流：切片（含不在 units 的孤儿）/ 节 → directNodeHits / 章及以上 → 高层桶
  // 兜底：kind='unit' 但 layer 非法（<1、NaN 等）的候选不静默丢弃，按孤儿语义并入切片流容错
  // 基础线：切片与节候选低于 baseFloor 剔除（回响衰减跌破此线即自然出局，约 3 轮）；
  // 纯回响补入（sources 空）的非切片候选不进节/桶路径——切片流的回响补入保留（设计内的保底参赛）
  const baseFloor = opts.baseFloor ?? DEFAULT_BASE_FLOOR;
  const sliceCands: Candidate[] = [];
  const unitCands: Candidate[] = [];
  const directNodeHits = new Set<string>();
  for (const c of ranked) {
    const u = units.get(c.id);
    const isUnit = !!u && u.kind !== 'slice' && (u.layer === 1 || u.layer >= 2);
    if (isUnit) {
      if (c.sources.length === 0) continue;
      if (u!.layer === 1) { if (c.score >= baseFloor) directNodeHits.add(c.id); }
      else unitCands.push(c);   // 桶内由 floor（缺省 baseFloor）把关
    } else if (c.score >= baseFloor) {
      sliceCands.push(c);
    }
  }

  // 5. 充能聚集 + 高层桶
  const cliff = opts.cliff ?? {};
  const cluster = gradeAndCluster(sliceCands, units, { cliff, nodeClusterMin: opts.nodeClusterMin, directNodeHits });
  const bucket = bucketSelect(unitCands, units, {
    floor: opts.bucket?.floor ?? baseFloor,
    cliff: opts.bucket?.cliff ?? cliff,
    perLayerMax: opts.bucket?.perLayerMax,
  });

  const sliceItem = (id: string, reason: string): InjectionItem =>
    ({ id, form: 'body', tokens: units.get(id)?.tokens.body ?? 0, reason });
  const grades: GradedSlice[] = [...cluster.slices];
  const sliceItems: InjectionItem[] = cluster.slices.map(s => sliceItem(s.id, s.grade));

  // 6. PPR 补条：种子=最终切片候选；补充 id 以 mention 档并入（是否入选交给 assemble 预算）
  // 只有切片（含不在 units 的孤儿）能作补条：unit 类节点在建图前就滤掉，不占 maxAdd 名额
  if (input.pprNodes && input.vecSim && cluster.slices.length > 0) {
    const seeds = new Map(cluster.slices.map(s => [s.id, s.score]));
    const sliceNodes = input.pprNodes.filter(n => { const u = units.get(n.id); return !u || u.kind === 'slice'; });
    for (const id of pprExpand(seeds, sliceNodes, input.vecSim, opts.ppr)) {
      grades.push({ id, grade: 'mention', score: 0 });
      sliceItems.push(sliceItem(id, 'ppr'));
    }
  }

  // 7. 切片条数上限：sliceItems 已按分数序（档位判定序降序，PPR 补条分 0 排尾），
  // 在进 assemble 前截前 maxSlices 条，超出者进 dropped、不占预算；
  // 常驻已有 body 的切片会被 assemble 去重，不计名额
  const maxSlices = opts.maxSlices ?? DEFAULT_MAX_SLICES;
  const capDropped: InjectionItem[] = [];
  const keptSlices: InjectionItem[] = [];
  let counted = 0;
  for (const it of sliceItems) {
    if (input.resident.get(it.id) === 'body') keptSlices.push(it);
    else if (counted < maxSlices) { keptSlices.push(it); counted++; }
    else capDropped.push(it);
  }

  // 8. 三方去重 + 预算装配
  const { final, dropped } = assemble(
    { resident: input.resident, clusterItems: [...keptSlices, ...cluster.upgrades], bucketItems: bucket.requests },
    units, { recallBudget: opts.recallBudget },
  );
  return {
    final, dropped: [...capDropped, ...dropped], grades,
    chargeSignals: [...bucket.chargeSignals], charge: new Map(cluster.charge),
  };
}
