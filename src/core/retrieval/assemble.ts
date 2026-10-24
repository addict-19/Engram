// src/core/retrieval/assemble.ts
// 检索管线汇流总闸：三方去重（常驻 > 充能产物 > 高层桶）→ 预算阶梯（降形态 → 整条弃，永不拆半条）→ 按剧情时间排序
import type { Form, InjectionItem, UnitMap } from './types.js';

export interface AssembleOpts { recallBudget: number /*召回池默认8000*/ }

export const DEFAULT_RECALL_BUDGET = 8000;

const RANK: Record<Form, number> = { title: 0, summary: 1, body: 2 };
const DOWN: Partial<Record<Form, Form>> = { body: 'summary', summary: 'title' };
const KEY_RE = /(^|:)(precise|lead)(:|$)/;

interface Merged {
  id: string; form: Form; tokens: number; reason: string;
  src: number;        // 0=cluster, 1=bucket（取首个出现该 id 的最高优先来源）
  key: boolean;       // 任一被合并条目的 reason 含 precise/lead
  order: number;      // 首次出现序，稳定排序用
}

export function assemble(parts: {
  resident: Map<string, Form>;
  clusterItems: InjectionItem[];
  bucketItems: InjectionItem[];
}, units: UnitMap, opts: AssembleOpts = { recallBudget: DEFAULT_RECALL_BUDGET }): { final: InjectionItem[]; dropped: InjectionItem[] } {
  // 1) 按 id 合并：每 id 一条，形态取最高；reason 取最高优先来源里最高形态的首条
  const merged = new Map<string, Merged>();
  let order = 0;
  const sources: InjectionItem[][] = [parts.clusterItems, parts.bucketItems];
  sources.forEach((list, src) => {
    for (const it of list) {
      const key = KEY_RE.test(it.reason);
      const m = merged.get(it.id);
      if (!m) {
        merged.set(it.id, { id: it.id, form: it.form, tokens: it.tokens, reason: it.reason, src, key, order: order++ });
        continue;
      }
      m.key ||= key;
      if (RANK[it.form] > RANK[m.form]) {
        m.form = it.form;
        m.tokens = it.tokens;
        if (src === m.src) m.reason = it.reason; // 低优先来源只贡献形态，不改 reason
      }
    }
  });

  // 2) 常驻去重：常驻已有形态 ≥ 合并后形态 → 删（不算 dropped）
  const live: Merged[] = [];
  for (const m of merged.values()) {
    const r = parts.resident.get(m.id);
    if (r !== undefined && RANK[r] >= RANK[m.form]) continue;
    const u = units.get(m.id);
    if (u) m.tokens = u.tokens[m.form]; // tokens 以 UnitMap 为准；孤儿用条目自带值
    live.push(m);
  }

  // 3) 预算阶梯：价值从低到高逐条 降形态 → 整条弃
  const dropped: InjectionItem[] = [];
  const out = new Map<string, InjectionItem>(live.map(m => [m.id, { id: m.id, form: m.form, tokens: m.tokens, reason: m.reason }]));
  let total = live.reduce((s, m) => s + m.tokens, 0);
  if (total > opts.recallBudget) {
    // 价值降序：src 小者高 → key 者高 → tokens 小者高 → 先出现者高；从末尾（最低）开始处理
    const byValue = [...live].sort((a, b) =>
      a.src - b.src || Number(b.key) - Number(a.key) || a.tokens - b.tokens || a.order - b.order);
    for (const m of byValue.reverse()) {
      if (total <= opts.recallBudget) break;
      const cur = out.get(m.id)!;
      const u = units.get(m.id);
      const degradable = u !== undefined && u.kind !== 'slice';
      while (degradable && total > opts.recallBudget && DOWN[cur.form]) {
        const f = DOWN[cur.form]!;
        total += u!.tokens[f] - cur.tokens;
        cur.form = f;
        cur.tokens = u!.tokens[f];
      }
      if (total > opts.recallBudget) {
        total -= cur.tokens;
        out.delete(m.id);
        dropped.push({ id: m.id, form: m.form, tokens: m.tokens, reason: m.reason });
      }
    }
  }

  // 4) 按剧情时间 ts 升序；缺 ts（含孤儿）排尾保持相对序
  const kept = live.filter(m => out.has(m.id));
  const withTs = kept.filter(m => units.get(m.id)?.ts !== undefined);
  const noTs = kept.filter(m => units.get(m.id)?.ts === undefined);
  withTs.sort((a, b) => {
    const ta = units.get(a.id)!.ts!, tb = units.get(b.id)!.ts!;
    return ta < tb ? -1 : ta > tb ? 1 : a.order - b.order;
  });
  return { final: [...withTs, ...noTs].map(m => out.get(m.id)!), dropped };
}
