// src/core/delta.ts
export type LibKind = 'chronicle' | 'persona' | 'atlas' | 'treasury' | 'knowledge' | 'extra';

export interface Delta {
  seq: number;          // 单库内单调递增，写入时后端分配（C7 版本号的基础）
  floor: number;        // 来源楼层号——回滚的坐标
  swipe?: number;       // 该楼 swipe 索引（可选）
  ts: string;           // 写入时刻 ISO
  lib: LibKind;
  op: 'create' | 'update' | 'delete';
  id: string;           // 实体 uuid（双轨宪法：delta 核销永远在 id 层）
  payload?: Record<string, unknown>;
}

export interface Entity { id: string; [k: string]: unknown }

export function applyDeltas(base: Record<string, Entity>, deltas: Delta[]): Record<string, Entity> {
  const out: Record<string, Entity> = { ...base };
  for (const dl of deltas) {
    // id 放在 spread 之后：payload 里的 id 字段永远覆盖不了实体 id
    if (dl.op === 'create') out[dl.id] = { ...dl.payload, id: dl.id };
    else if (dl.op === 'update') {
      const cur = out[dl.id];
      if (cur) out[dl.id] = { ...cur, ...dl.payload, id: dl.id };
      // 不存在则跳过：坏 delta 不连坐（局部容错）
    } else if (dl.op === 'delete') delete out[dl.id];
  }
  return out;
}

export function rollbackView(deltas: Delta[], maxFloor: number): Delta[] {
  return deltas.filter((dl) => dl.floor <= maxFloor);
}

export function serializeDelta(d: Delta): string {
  return JSON.stringify(d);
}

export function parseDeltaLine(line: string): Delta | null {
  if (!line.trim()) return null;
  try {
    const o = JSON.parse(line);
    if (typeof o?.seq !== 'number' || typeof o?.floor !== 'number' || typeof o?.id !== 'string') return null;
    // payload 若存在必须是普通对象：字符串/数组/null 被 spread 会污染实体
    if (o.payload !== undefined && (typeof o.payload !== 'object' || o.payload === null || Array.isArray(o.payload))) return null;
    return o as Delta;
  } catch { return null; }
}
