// src/core/retrieval/ppr.ts
// PPR 临时图扩散：以本轮最终切片候选为种子，在调用方传入的 nodes 上现建一张带权无向图，
// 跑个性化 PageRank，补出少量"图上相近但检索没打中"的切片。图只活在函数调用期间，返回即丢。
// 纯函数：零 IO、零全局状态、不修改入参。

export interface PPRNode {
  id: string; characters: string[]; location?: string; anchors: string[]; tags: string[];
  floor?: number; eventIds?: string[];
}

export type PPRChannel = 'semantic' | 'event' | 'entity' | 'location' | 'pair' | 'floor';
export type ChannelWeights = Record<PPRChannel, number>;

// 六通道边权双档预设（10/24 定稿）：三大头（语义/同事件/实体）拉平各 0.25；
// 单人卡上"同角色/互动对"无区分度，故单人卡档地点 0.15 > 互动对 0.10，多人卡档两者互换。
// 楼层通道代码保留、两档默认均 0（同事件的切片楼层天然相邻，价值已被覆盖；要用自行调高）。
export const PPR_WEIGHTS_SOLO: Readonly<ChannelWeights> = Object.freeze({
  semantic: 0.25, event: 0.25, entity: 0.25, location: 0.15, pair: 0.10, floor: 0,
});
export const PPR_WEIGHTS_ENSEMBLE: Readonly<ChannelWeights> = Object.freeze({
  semantic: 0.25, event: 0.25, entity: 0.25, location: 0.10, pair: 0.15, floor: 0,
});

export interface PPROpts {
  alpha?: number;                          // 回跳（teleport）概率，默认 0.15
  maxAdd?: number;                         // 全局补充上限，默认 3
  simFloor?: number;                       // 语义门槛：与任一种子的 vecSim 最大值须 ≥ 此值，默认 0
  window?: number;                         // 楼层窗口，默认 80（楼层差 ≥ window 不连）
  profile?: 'solo' | 'ensemble';           // 权重档，默认 solo（单人卡）
  channelWeights?: Partial<ChannelWeights>; // 在所选档位上逐项覆盖
  maxIter?: number;                        // 幂迭代上限，默认 50
  tol?: number;                            // 收敛阈值（相邻两轮 L1 差），默认 1e-6
}

const DEFAULT_WINDOW = 80;

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// 互动对：同一切片里出场角色两两成对（无序），单角色切片没有互动对
function pairsOf(chars: string[]): Set<string> {
  const u = [...new Set(chars)].sort();
  const out = new Set<string>();
  for (let i = 0; i < u.length; i++) for (let j = i + 1; j < u.length; j++) out.add(`${u[i]}\u0000${u[j]}`);
  return out;
}

const entitiesOf = (n: PPRNode) => new Set([...n.anchors, ...n.tags]);

// 两节点间边权 = Σ 通道权重 × 通道强度（各通道强度 ∈ [0,1]）：
//   语义 max(0, vecSim)；同事件 共享任一 eventId 即 1；实体 Jaccard(anchors∪tags)；
//   同地点 双方都有且相等即 1；互动对 Jaccard(角色两两对)；楼层 max(0, 1-|Δ楼层|/window)（缺楼层为 0）
export function edgeWeight(a: PPRNode, b: PPRNode, vecSim: (a: string, b: string) => number,
  w: Readonly<ChannelWeights>, window: number = DEFAULT_WINDOW): number {
  return edgeWeightPre(prep(a), prep(b), vecSim, w, window);
}

interface Prepped { n: PPRNode; ents: Set<string>; pairs: Set<string>; events: Set<string> }
const prep = (n: PPRNode): Prepped => ({ n, ents: entitiesOf(n), pairs: pairsOf(n.characters), events: new Set(n.eventIds ?? []) });

function edgeWeightPre(a: Prepped, b: Prepped, vecSim: (a: string, b: string) => number,
  w: Readonly<ChannelWeights>, window: number): number {
  let s = 0;
  if (w.semantic) s += w.semantic * Math.max(0, vecSim(a.n.id, b.n.id));
  if (w.event) { for (const e of a.events) if (b.events.has(e)) { s += w.event; break; } }
  if (w.entity) s += w.entity * jaccard(a.ents, b.ents);
  if (w.location && a.n.location !== undefined && a.n.location === b.n.location) s += w.location;
  if (w.pair) s += w.pair * jaccard(a.pairs, b.pairs);
  if (w.floor && a.n.floor !== undefined && b.n.floor !== undefined && window > 0) {
    s += w.floor * Math.max(0, 1 - Math.abs(a.n.floor - b.n.floor) / window);
  }
  return s;
}

// 流程：
// 1. 个性化向量 p = 种子分归一化（只取在 nodes 中且分 >0 的种子；全非正则种子均分）；无可用种子 → []
// 2. 全对现算边权（O(n²)，n 为调用方给的候选池规模），行归一化成转移矩阵；无边节点的游走质量回跳到 p
// 3. 幂迭代 r ← α·p + (1-α)·Pᵀr，至多 maxIter 轮，L1 变化 < tol 提前停
// 4. 输出：非种子、r>0、过 simFloor 的节点按 r 降序（同分按 nodes 顺序），截前 maxAdd
export function pprExpand(seeds: Map<string, number>, nodes: PPRNode[],
  vecSim: (a: string, b: string) => number, opts?: PPROpts): string[] {
  const alpha = opts?.alpha ?? 0.15;
  const maxAdd = opts?.maxAdd ?? 3;
  const simFloor = opts?.simFloor ?? 0;
  const window = opts?.window ?? DEFAULT_WINDOW;
  const maxIter = opts?.maxIter ?? 50;
  const tol = opts?.tol ?? 1e-6;
  const base = opts?.profile === 'ensemble' ? PPR_WEIGHTS_ENSEMBLE : PPR_WEIGHTS_SOLO;
  const w: ChannelWeights = { ...base };
  for (const [k, v] of Object.entries(opts?.channelWeights ?? {}) as Array<[PPRChannel, number | undefined]>) {
    if (v !== undefined) w[k] = v;
  }
  if (maxAdd <= 0) return [];

  // 同 id 重复只取首个
  const list: PPRNode[] = [];
  const index = new Map<string, number>();
  for (const n of nodes) if (!index.has(n.id)) { index.set(n.id, list.length); list.push(n); }
  const n = list.length;

  // 1. 个性化向量
  const p = new Float64Array(n);
  const seedIdx: number[] = [];
  for (const [id] of seeds) { const i = index.get(id); if (i !== undefined && !seedIdx.includes(i)) seedIdx.push(i); }
  if (seedIdx.length === 0) return [];
  let mass = 0;
  for (const i of seedIdx) { const v = Math.max(0, seeds.get(list[i]!.id)!); p[i] = v; mass += v; }
  if (mass > 0) for (const i of seedIdx) p[i]! /= mass;
  else for (const i of seedIdx) p[i] = 1 / seedIdx.length;

  // 2. 临时图（邻接表 + 出度）
  const pre = list.map(prep);
  const adj: Array<Array<[number, number]>> = list.map(() => []);
  const deg = new Float64Array(n);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const ew = edgeWeightPre(pre[i]!, pre[j]!, vecSim, w, window);
    if (ew > 0) { adj[i]!.push([j, ew]); adj[j]!.push([i, ew]); deg[i]! += ew; deg[j]! += ew; }
  }

  // 3. 幂迭代
  let r = Float64Array.from(p);
  for (let it = 0; it < maxIter; it++) {
    const next = new Float64Array(n);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      const ri = r[i]!;
      if (ri === 0) continue;
      if (deg[i] === 0) { dangling += ri; continue; }
      for (const [j, ew] of adj[i]!) next[j]! += (1 - alpha) * ri * ew / deg[i]!;
    }
    let diff = 0;
    for (let i = 0; i < n; i++) {
      next[i]! += (alpha + (1 - alpha) * dangling) * p[i]!;
      diff += Math.abs(next[i]! - r[i]!);
    }
    r = next;
    if (diff < tol) break;
  }

  // 4. 选补充
  const seedSet = new Set(seedIdx);
  const out: Array<{ i: number; s: number }> = [];
  for (let i = 0; i < n; i++) {
    if (seedSet.has(i) || r[i]! <= 0) continue;
    let best = -Infinity;
    for (const si of seedIdx) best = Math.max(best, vecSim(list[i]!.id, list[si]!.id));
    if (best < simFloor) continue;
    out.push({ i, s: r[i]! });
  }
  return out.sort((a, b) => b.s - a.s || a.i - b.i).slice(0, maxAdd).map(x => list[x.i]!.id);
}
