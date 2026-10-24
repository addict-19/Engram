// tests/core/retrieval/ppr.test.ts
import { describe, it, expect } from 'vitest';
import {
  pprExpand, edgeWeight, PPR_WEIGHTS_SOLO, PPR_WEIGHTS_ENSEMBLE, type PPRNode,
} from '../../../src/core/retrieval/ppr.js';

const N = (id: string, p: Partial<PPRNode> = {}): PPRNode =>
  ({ id, characters: [], anchors: [], tags: [], ...p });

// 假相似度表：对称查表，缺省 0
function simTable(pairs: Array<[string, string, number]>) {
  const m = new Map<string, number>();
  for (const [a, b, v] of pairs) { m.set(`${a}|${b}`, v); m.set(`${b}|${a}`, v); }
  return (a: string, b: string) => m.get(`${a}|${b}`) ?? 0;
}
const noSim = () => 0;

describe('ppr 双档权重预设', () => {
  it('单人卡档：语义/事件/实体各 0.25，地点 0.15，互动对 0.10，楼层 0', () => {
    expect(PPR_WEIGHTS_SOLO).toEqual({ semantic: 0.25, event: 0.25, entity: 0.25, location: 0.15, pair: 0.10, floor: 0 });
  });
  it('多人卡档：地点与互动对互换（0.10 / 0.15），楼层 0', () => {
    expect(PPR_WEIGHTS_ENSEMBLE).toEqual({ semantic: 0.25, event: 0.25, entity: 0.25, location: 0.10, pair: 0.15, floor: 0 });
  });
});

describe('ppr 边权（六通道加权和，可手算）', () => {
  const a = N('a', { characters: ['甲', '乙'], location: 'L', anchors: ['x'], tags: ['y'], eventIds: ['e1'], floor: 10 });
  const b = N('b', { characters: ['甲', '乙', '丙'], location: 'L', anchors: ['x'], tags: ['z'], eventIds: ['e1', 'e2'], floor: 30 });
  const sim = simTable([['a', 'b', 0.8]]);
  // 语义 0.8；同事件 1；实体 Jaccard({x,y},{x,z})=1/3；同地点 1；互动对 Jaccard({甲乙},{甲乙,甲丙,乙丙})=1/3；楼层 1-20/80=0.75

  it('单人卡档', () => {
    expect(edgeWeight(a, b, sim, PPR_WEIGHTS_SOLO)).toBeCloseTo(0.25 * 0.8 + 0.25 + 0.25 / 3 + 0.15 + 0.10 / 3, 10);
  });
  it('多人卡档', () => {
    expect(edgeWeight(a, b, sim, PPR_WEIGHTS_ENSEMBLE)).toBeCloseTo(0.25 * 0.8 + 0.25 + 0.25 / 3 + 0.10 + 0.15 / 3, 10);
  });
  it('楼层通道代码保留：调高权重后按窗口线性衰减，超窗为 0', () => {
    const w = { semantic: 0, event: 0, entity: 0, location: 0, pair: 0, floor: 1 };
    expect(edgeWeight(a, b, sim, w, 80)).toBeCloseTo(0.75, 10);
    expect(edgeWeight(a, b, sim, w, 20)).toBe(0);
    expect(edgeWeight(a, N('c'), sim, w, 80)).toBe(0); // 缺楼层不连
  });
  it('负相似度截为 0；缺地点不算同地点；单角色无互动对', () => {
    const w = { semantic: 1, event: 0, entity: 0, location: 1, pair: 1, floor: 0 };
    const p = N('p', { characters: ['甲'] }), q = N('q', { characters: ['甲'] });
    expect(edgeWeight(p, q, () => -0.5, w)).toBe(0);
  });
});

describe('pprExpand', () => {
  it('小图排序：事件+地点连接 > 仅地点连接；无边节点不出', () => {
    const nodes = [
      N('S', { location: 'L', eventIds: ['e'] }),
      N('B', { location: 'L', eventIds: ['e'] }),
      N('C', { location: 'L' }),
      N('D'),
    ];
    expect(pprExpand(new Map([['S', 1]]), nodes, noSim)).toEqual(['B', 'C']);
  });

  it('两跳扩散：只与邻居相连的节点也能被带出，分低于一跳邻居', () => {
    const nodes = [
      N('S', { eventIds: ['e1'] }),
      N('B', { eventIds: ['e1'], location: 'L' }),
      N('E', { location: 'L' }),
    ];
    expect(pprExpand(new Map([['S', 1]]), nodes, noSim)).toEqual(['B', 'E']);
  });

  it('全局最多补 3 条（默认 maxAdd），可配', () => {
    const nodes = [N('S', { location: 'L' }), ...['a', 'b', 'c', 'd', 'e'].map(id => N(id, { location: 'L' }))];
    expect(pprExpand(new Map([['S', 1]]), nodes, noSim)).toHaveLength(3);
    expect(pprExpand(new Map([['S', 1]]), nodes, noSim, { maxAdd: 1 })).toHaveLength(1);
  });

  it('种子不在输出中（多种子互连时亦然）', () => {
    const nodes = [N('S1', { location: 'L' }), N('S2', { location: 'L' }), N('X', { location: 'L' })];
    expect(pprExpand(new Map([['S1', 1], ['S2', 0.5]]), nodes, noSim)).toEqual(['X']);
  });

  it('simFloor：与所有种子语义相似度都低于门槛的节点被过滤（图上再近也不要）', () => {
    const nodes = [N('S', { eventIds: ['e'] }), N('B', { eventIds: ['e'] }), N('C', { eventIds: ['e'] })];
    const sim = simTable([['S', 'B', 0.1], ['S', 'C', 0.6]]);
    expect(pprExpand(new Map([['S', 1]]), nodes, sim, { simFloor: 0.3 })).toEqual(['C']);
    expect(pprExpand(new Map([['S', 1]]), nodes, sim)).toEqual(['C', 'B']); // 默认门槛 0 不拦
  });

  it('种子带分：高分种子的邻居排在低分种子的邻居前', () => {
    const nodes = [
      N('S1', { eventIds: ['e1'] }), N('A', { eventIds: ['e1'] }),
      N('S2', { eventIds: ['e2'] }), N('B', { eventIds: ['e2'] }),
    ];
    expect(pprExpand(new Map([['S1', 0.2], ['S2', 0.9]]), nodes, noSim)).toEqual(['B', 'A']);
  });

  it('profile 选档 + channelWeights 逐项覆盖', () => {
    // S–P 互动对相同；S–L 同地点。单人卡档地点 0.15 > 互动对 0.10，多人卡档反之
    const nodes = [
      N('S', { characters: ['甲', '乙'], location: 'X' }),
      N('P', { characters: ['甲', '乙'] }),
      N('L', { location: 'X' }),
    ];
    const seeds = new Map([['S', 1]]);
    expect(pprExpand(seeds, nodes, noSim)).toEqual(['L', 'P']);
    expect(pprExpand(seeds, nodes, noSim, { profile: 'ensemble' })).toEqual(['P', 'L']);
    expect(pprExpand(seeds, nodes, noSim, { channelWeights: { location: 0 } })).toEqual(['P']);
  });

  it('空种子 / 种子不在 nodes 中 → 空数组', () => {
    const nodes = [N('A', { location: 'L' }), N('B', { location: 'L' })];
    expect(pprExpand(new Map(), nodes, noSim)).toEqual([]);
    expect(pprExpand(new Map([['Z', 1]]), nodes, noSim)).toEqual([]);
  });

  it('不修改入参', () => {
    const nodes = [N('S', { location: 'L', characters: ['甲', '乙'] }), N('B', { location: 'L' })];
    const seeds = new Map([['S', 1]]);
    const snap = JSON.stringify([[...seeds], nodes]);
    pprExpand(seeds, nodes, noSim);
    expect(JSON.stringify([[...seeds], nodes])).toBe(snap);
  });
});
