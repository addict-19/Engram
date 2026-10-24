// src/core/retrieval/types.ts
// 检索管线共享类型：Task 4-9 逐字引用，字段名不得擅改

export interface Candidate { id: string; score: number; sources: Array<'bm25'|'vec'>; anchorHit?: boolean }

export interface UnitInfo {              // 金字塔/切片的检索侧视图（由上层从库状态投影，本层只读）
  id: string; kind: 'slice'|'unit';      // unit=节/章/卷/部…
  layer: number;                          // slice=0, 节=1, 章=2, 卷=3, 部=4, 更高递增
  parent: string | null;
  tokens: { title: number; summary: number; body: number };  // 三形态 token 估算
  ts?: string;                            // 剧情时间（排序用，可缺）
}

export type UnitMap = Map<string, UnitInfo>;

export type Form = 'title' | 'summary' | 'body';

export interface InjectionItem { id: string; form: Form; tokens: number; reason: string }
