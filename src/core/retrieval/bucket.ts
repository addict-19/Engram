// src/core/retrieval/bucket.ts
// 高层直接命中桶：金字塔上层单元（章 layer=2、卷 3、部 4、更高）被直接检索命中时的分层选取（PRD M6）。
// 纯函数：零 IO、不修改入参。
//
// 输入契约：unitCands 只含 kind='unit' 且 layer≥2 的候选——调用方（管线层）已滤掉切片，
// layer=1 的节候选由管线层转成 directNodeHits 交给 gradeAndCluster，不进本函数。
// 防御：仍混入的切片 / layer<2 / 不在 units 中的 id 一律忽略。

import type { Candidate, InjectionItem, UnitInfo, UnitMap } from './types.js';
import { detectCliff, passFloor, type CliffOpts } from './cliff.js';

export interface BucketOpts { perLayerMax?: number /*默认2*/; floor: number; cliff: CliffOpts }
export interface BucketResult { requests: InjectionItem[]; chargeSignals: string[] /*擦线单元id，计充能*/ }

const MIN_LAYER = 2;

interface Pick { u: UnitInfo; score: number; lead: boolean }

// 流程：
// 1. 按 layer 分桶，每桶降序（同分按入参顺序稳定）；
// 2. 舍弃低于 floor 的；对过线序列跑 detectCliff 得 k，前 k 条为领先档（body），其余为擦线档（summary）；
// 3. 每层截前 perLayerMax 条（body+summary 合计）；被截掉的不产出、也不计充能；
// 4. 包含吸收：某入选单元的祖先链上有更高层、且请求形态不低于它（body > summary）的入选单元
//    → 删除它（部吞卷、卷吞章，隔层同样吞），不补位；被吞者不进 chargeSignals（信息由祖先承载）。
//    擦线祖先（summary）不吞领先后代（body）：两条共存，避免信息变粗；
// 5. chargeSignals = 最终存活的擦线档 id。
// 输出顺序：层高到低，层内分数降序。
export function bucketSelect(unitCands: Candidate[], units: UnitMap, opts: BucketOpts): BucketResult {
  const perLayerMax = opts.perLayerMax ?? 2;

  // 1. 分桶
  const buckets = new Map<number, Array<{ u: UnitInfo; score: number; i: number }>>();
  unitCands.forEach((c, i) => {
    const u = units.get(c.id);
    if (!u || u.kind !== 'unit' || u.layer < MIN_LAYER) return;
    let b = buckets.get(u.layer);
    if (!b) { b = []; buckets.set(u.layer, b); }
    b.push({ u, score: c.score, i });
  });

  // 2-3. 桶内 floor → 断崖分档 → 限额
  const picks: Pick[] = [];
  const layers = [...buckets.keys()].sort((a, b) => b - a);
  for (const layer of layers) {
    const passed = buckets.get(layer)!
      .filter(x => passFloor(x.score, opts.floor))
      .sort((a, b) => b.score - a.score || a.i - b.i);
    const k = detectCliff(passed.map(x => x.score), opts.cliff);
    passed.slice(0, Math.max(0, perLayerMax))
      .forEach((x, idx) => picks.push({ u: x.u, score: x.score, lead: idx < k }));
  }

  // 4. 包含吸收：沿 parent 链找更高层、形态不低于自身的入选祖先；断链 / 成环即止
  const picked = new Map(picks.map(p => [p.u.id, p]));
  const absorbed = (self: Pick): boolean => {
    const u = self.u;
    const seen = new Set<string>([u.id]);
    let p = u.parent;
    while (p !== null && !seen.has(p)) {
      const hit = picked.get(p);
      if (hit && hit.u.layer > u.layer && (hit.lead || !self.lead)) return true;
      const a = units.get(p);
      if (!a) return false;
      seen.add(p);
      p = a.parent;
    }
    return false;
  };

  const requests: InjectionItem[] = [];
  const chargeSignals: string[] = [];
  for (const p of picks) {
    if (absorbed(p)) continue;
    const form = p.lead ? 'body' : 'summary';
    requests.push({
      id: p.u.id, form, tokens: p.u.tokens[form],
      reason: `bucket:${p.lead ? 'lead' : 'graze'}:${p.u.id}`,
    });
    if (!p.lead) chargeSignals.push(p.u.id);
  }
  return { requests, chargeSignals };
}
