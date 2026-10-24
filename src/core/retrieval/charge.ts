// src/core/retrieval/charge.ts
// 金字塔充能与聚集升级：切片桶候选的档位判定（PRD M6 档位表）。
// 纯函数：零 IO、不修改入参。

import type { Candidate, InjectionItem, UnitInfo, UnitMap } from './types.js';
import { detectCliff, type CliffOpts } from './cliff.js';

export type SliceGrade = 'mention' | 'precise' | 'nodeCluster' | 'chapterCluster';
export interface GradedSlice { id: string; grade: SliceGrade; score: number }
export interface ClusterResult {
  slices: GradedSlice[];
  upgrades: InjectionItem[];     // 聚集升级产物：节 body/章 body/对应上层 summary（按 PRD M6 档位表）
  charge: Map<string, number>;   // 每个祖先单元的充能值（节直接命中也在此并账）
}

const NODE = 1, CHAPTER = 2, VOLUME = 3;

// 沿 parent 链向上收集祖先（不含自身）；parent 指向缺失单元即止，成环即止。
function ancestors(id: string, units: UnitMap): UnitInfo[] {
  const out: UnitInfo[] = [];
  const seen = new Set<string>([id]);
  let p = units.get(id)?.parent ?? null;
  while (p !== null && !seen.has(p)) {
    const u = units.get(p);
    if (!u) break;
    out.push(u);
    seen.add(p);
    p = u.parent;
  }
  return out;
}

// 链上第一个指定层级的祖先（缺层返回 undefined，调用方跳过该层）
const atLayer = (chain: UnitInfo[], layer: number) => chain.find(u => u.layer === layer);

const item = (u: UnitInfo | undefined, form: 'summary' | 'body', reason: string): InjectionItem[] =>
  u ? [{ id: u.id, form, tokens: u.tokens[form], reason }] : [];

const isNode = (u: UnitInfo | undefined): u is UnitInfo => !!u && u.kind === 'unit' && u.layer === NODE;

export function gradeAndCluster(cands: Candidate[], units: UnitMap, opts: {
  cliff: CliffOpts; nodeClusterMin?: number;   // 同节≥2 默认
  directNodeHits?: Set<string>;                // 高层桶转来的"节直接命中"（节不占桶位，并入充能）
}): ClusterResult {
  const nodeClusterMin = opts.nodeClusterMin ?? 2;
  const charge = new Map<string, number>();
  const add = (id: string, v: number) => charge.set(id, (charge.get(id) ?? 0) + v);

  // 分数降序（同分按入参顺序稳定）
  const sorted = cands.map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.score - a.c.score || a.i - b.i)
    .map(x => x.c);

  // 1. 充能：切片分数沿链累加到每个祖先
  const chains = new Map<string, UnitInfo[]>();
  for (const c of sorted) {
    const chain = ancestors(c.id, units);
    chains.set(c.id, chain);
    for (const u of chain) add(u.id, c.score);
  }

  // 直接命中的节：计数型充能 +1，自身与其祖先并账；非节 / 不在 units 的 id 忽略
  const direct: UnitInfo[] = [];
  for (const id of opts.directNodeHits ?? []) {
    const u = units.get(id);
    if (!isNode(u)) continue;
    direct.push(u);
    add(u.id, 1);
    for (const a of ancestors(u.id, units)) add(a.id, 1);
  }
  const directIds = new Set(direct.map(u => u.id));

  // 2. 聚集统计：节命中数（切片数 + 直接命中折算 1），章内命中节集合
  const nodeOf = new Map<string, UnitInfo | undefined>();
  const chapterOf = new Map<string, UnitInfo | undefined>();
  const nodeHits = new Map<string, number>();
  const chapterNodes = new Map<string, Set<string>>();
  for (const c of sorted) {
    const chain = chains.get(c.id)!;
    const n = atLayer(chain, NODE);
    const ch = atLayer(chain, CHAPTER);
    nodeOf.set(c.id, n);
    chapterOf.set(c.id, ch);
    if (n) nodeHits.set(n.id, (nodeHits.get(n.id) ?? 0) + 1);
    if (n && ch) {
      if (!chapterNodes.has(ch.id)) chapterNodes.set(ch.id, new Set());
      chapterNodes.get(ch.id)!.add(n.id);
    }
  }
  for (const u of direct) {
    nodeHits.set(u.id, (nodeHits.get(u.id) ?? 0) + 1);
    const ch = atLayer(ancestors(u.id, units), CHAPTER);
    if (ch) {
      if (!chapterNodes.has(ch.id)) chapterNodes.set(ch.id, new Set());
      chapterNodes.get(ch.id)!.add(u.id);
    }
  }
  const nodeClustered = (id: string) => directIds.has(id) || (nodeHits.get(id) ?? 0) >= nodeClusterMin;
  const chapterClustered = (id: string) => (chapterNodes.get(id)?.size ?? 0) >= 2;

  // 3. 档位判定（高优先级先占，一条切片只归一档）
  const k = detectCliff(sorted.map(c => c.score), opts.cliff);
  const slices: GradedSlice[] = sorted.map((c, idx) => {
    let grade: SliceGrade = 'mention';
    const n = nodeOf.get(c.id), ch = chapterOf.get(c.id);
    if (idx < k) grade = 'precise';
    else if (n && nodeClustered(n.id)) grade = 'nodeCluster';
    else if (ch && chapterClustered(ch.id)) grade = 'chapterCluster';
    return { id: c.id, grade, score: c.score };
  });

  // 4. 升级产物：precise 按切片、nodeCluster 按节、chapterCluster 按章各出一组（跨组去重留给 Task 8）
  const upgrades: InjectionItem[] = [];
  const nodeOrder: UnitInfo[] = [];
  const chapterOrder: UnitInfo[] = [];
  for (const s of slices) {
    const chain = chains.get(s.id)!;
    if (s.grade === 'precise') {
      const reason = `precise:${s.id}`;
      upgrades.push(...item(nodeOf.get(s.id), 'body', reason),
        ...item(chapterOf.get(s.id), 'summary', reason),
        ...item(atLayer(chain, VOLUME), 'summary', reason));
    } else if (s.grade === 'nodeCluster') {
      const n = nodeOf.get(s.id)!;
      if (!nodeOrder.includes(n)) nodeOrder.push(n);
    } else if (s.grade === 'chapterCluster') {
      const ch = chapterOf.get(s.id)!;
      if (!chapterOrder.includes(ch)) chapterOrder.push(ch);
    }
  }
  // 直接命中但本轮无任何命中切片的节：仍按节内聚集产出，避免"节不占桶位"导致信息丢失
  const sliceNodes = new Set([...nodeOf.values()].filter(n => n).map(n => n!.id));
  for (const u of direct) if (!sliceNodes.has(u.id)) nodeOrder.push(u);

  for (const n of nodeOrder) {
    const chain = ancestors(n.id, units);
    const reason = `nodeCluster:${n.id}`;
    upgrades.push(...item(n, 'body', reason),
      ...item(atLayer(chain, CHAPTER), 'summary', reason),
      ...item(atLayer(chain, VOLUME), 'summary', reason));
  }
  for (const ch of chapterOrder) {
    const reason = `chapterCluster:${ch.id}`;
    upgrades.push(...item(ch, 'body', reason),
      ...item(atLayer(ancestors(ch.id, units), VOLUME), 'summary', reason));
  }

  return { slices, upgrades, charge };
}
