// src/core/bm25.ts
// BM25 关键词索引：纯内存、零 IO、零运行时依赖。
// - 分词器可插拔（Tokenizer），v0 用 bigramTokenizer 占位，后续换 jieba-wasm 接口不变。
// - 锚点通道：剧情生造词（如 "the mouth thing"）绕过分词整词入索引，
//   查询串包含锚点原词时精确加入候选——embedding 对这类词不可靠，这里兜底。
// - toJSON/fromJSON 只是加速：全文在手随时可重建（D1 互备）。

import { EngramError } from './errors.js';

export type Tokenizer = (text: string) => string[];

const HAN = /\p{Script=Han}/u;
const WORD = /[\p{L}\p{N}]/u;

const isHan = (ch: string) => HAN.test(ch);
/** 非汉字的字母/数字（英文、数字、其他拼音文字）算"单词字符"。 */
const isWordChar = (ch: string) => WORD.test(ch) && !HAN.test(ch);

/**
 * v0 占位分词：连续汉字段出相邻二元组（段长为 1 时出单字），
 * 连续字母/数字段出小写整词，其余字符（标点、空白）只作分隔。
 */
export const bigramTokenizer: Tokenizer = (text) => {
  const out: string[] = [];
  const chars = Array.from(text);
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i]!;
    if (isHan(ch)) {
      let j = i;
      while (j < chars.length && isHan(chars[j]!)) j++;
      if (j - i === 1) out.push(ch);
      else for (let p = i; p < j - 1; p++) out.push(chars[p]! + chars[p + 1]!);
      i = j;
    } else if (isWordChar(ch)) {
      let j = i;
      while (j < chars.length && isWordChar(chars[j]!)) j++;
      out.push(chars.slice(i, j).join('').toLowerCase());
      i = j;
    } else {
      i++;
    }
  }
  return out;
};

/** 锚点/查询归一化：小写、空白折叠、去首尾空白。 */
function normalizePhrase(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 归一化后的 query 中是否含锚点；锚点首/尾是单词字符时要求词边界（"ring" 不命中 "bring"）。 */
function containsAnchor(q: string, anchor: string): boolean {
  const head = isWordChar(Array.from(anchor)[0]!);
  const tailChars = Array.from(anchor);
  const tail = isWordChar(tailChars[tailChars.length - 1]!);
  let from = 0;
  for (;;) {
    const pos = q.indexOf(anchor, from);
    if (pos < 0) return false;
    const before = pos > 0 ? Array.from(q.slice(0, pos)).pop()! : '';
    const after = Array.from(q.slice(pos + anchor.length))[0] ?? '';
    const okHead = !head || before === '' || !isWordChar(before);
    const okTail = !tail || after === '' || !isWordChar(after);
    if (okHead && okTail) return true;
    from = pos + 1;
  }
}

export interface BM25Options {
  k1?: number;
  b?: number;
  /** 锚点命中分的倍率（相对单个普通词满分），默认 3：生造词整词命中是强信号。 */
  anchorBoost?: number;
}

interface DocEntry { len: number; tf: Map<string, number> }

interface BM25JSON {
  v: 1;
  k1: number;
  b: number;
  anchorBoost: number;
  docs: Array<[string, number, Array<[string, number]>]>;
  anchors: Array<[string, string[]]>;
}

export class BM25Index {
  private readonly k1: number;
  private readonly b: number;
  private readonly anchorBoost: number;
  /** term → (id → tf) */
  private readonly postings = new Map<string, Map<string, number>>();
  private readonly docs = new Map<string, DocEntry>();
  private totalLen = 0;
  /** 归一化锚点 → id 集合 */
  private readonly anchorPostings = new Map<string, Set<string>>();
  private readonly anchorsById = new Map<string, Set<string>>();
  /** 有正文或锚点的全部 id（BM25 的 N） */
  private readonly ids = new Set<string>();

  constructor(private readonly tokenizer: Tokenizer, opts: BM25Options = {}) {
    this.k1 = opts.k1 ?? 1.2;
    this.b = opts.b ?? 0.75;
    this.anchorBoost = opts.anchorBoost ?? 3;
  }

  /** 已索引的文档数（含仅挂锚点的 id）。 */
  get size(): number { return this.ids.size; }

  /** 加入/更新正文。同 id 再 add 为更新语义：替换正文，保留已挂锚点。 */
  add(id: string, text: string): void {
    this.removeText(id);
    const tf = new Map<string, number>();
    const tokens = this.tokenizer(text);
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    this.insertDoc(id, tokens.length, tf);
  }

  /** 完整移除 id：正文与锚点一起清。不存在时静默。 */
  remove(id: string): void {
    this.removeText(id);
    const set = this.anchorsById.get(id);
    if (set) {
      for (const a of set) {
        const ids = this.anchorPostings.get(a)!;
        ids.delete(id);
        if (ids.size === 0) this.anchorPostings.delete(a);
      }
      this.anchorsById.delete(id);
    }
    this.ids.delete(id);
  }

  /** 锚点整词挂到 id 上（不经分词）。大小写/空白归一；空锚点忽略；可先于 add 调用。 */
  addAnchor(id: string, anchor: string): void {
    const a = normalizePhrase(anchor);
    if (!a) return;
    let ids = this.anchorPostings.get(a);
    if (!ids) this.anchorPostings.set(a, (ids = new Set()));
    ids.add(id);
    let mine = this.anchorsById.get(id);
    if (!mine) this.anchorsById.set(id, (mine = new Set()));
    mine.add(a);
    this.ids.add(id);
  }

  search(query: string, k: number): Array<{ id: string; score: number }> {
    if (!(k > 0) || this.ids.size === 0) return [];
    const N = this.ids.size;
    const avgdl = this.docs.size > 0 ? this.totalLen / this.docs.size : 1;
    const scores = new Map<string, number>();
    const addScore = (id: string, s: number) => scores.set(id, (scores.get(id) ?? 0) + s);

    for (const term of new Set(this.tokenizer(query))) {
      const plist = this.postings.get(term);
      if (!plist) continue;
      const idf = this.idf(N, plist.size);
      for (const [id, tf] of plist) {
        const dl = this.docs.get(id)!.len;
        const norm = tf + this.k1 * (1 - this.b + (this.b * dl) / (avgdl || 1));
        addScore(id, (idf * tf * (this.k1 + 1)) / norm);
      }
    }

    if (this.anchorPostings.size > 0) {
      const q = normalizePhrase(query);
      for (const [anchor, ids] of this.anchorPostings) {
        if (!containsAnchor(q, anchor)) continue;
        const s = this.anchorBoost * this.idf(N, ids.size);
        for (const id of ids) addScore(id, s);
      }
    }

    const out: Array<{ id: string; score: number }> = [];
    for (const [id, score] of scores) if (score > 0) out.push({ id, score });
    out.sort((x, y) => y.score - x.score);
    return out.slice(0, k);
  }

  toJSON(): unknown {
    const j: BM25JSON = {
      v: 1,
      k1: this.k1,
      b: this.b,
      anchorBoost: this.anchorBoost,
      docs: [...this.docs].map(([id, d]) => [id, d.len, [...d.tf]]),
      anchors: [...this.anchorsById].map(([id, set]) => [id, [...set]]),
    };
    return j;
  }

  static fromJSON(j: unknown, tokenizer: Tokenizer): BM25Index {
    const bad = (why: string): never => {
      throw new EngramError('E_BM25_FORMAT', `BM25 序列化数据无效：${why}`);
    };
    if (!j || typeof j !== 'object') bad('不是对象');
    const o = j as Partial<BM25JSON>;
    if (o.v !== 1) bad(`不支持的版本 ${String(o.v)}`);
    const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
    if (!num(o.k1) || !num(o.b) || !num(o.anchorBoost)) bad('参数缺失');
    if (!Array.isArray(o.docs) || !Array.isArray(o.anchors)) bad('docs/anchors 不是数组');

    const idx = new BM25Index(tokenizer, { k1: o.k1!, b: o.b!, anchorBoost: o.anchorBoost! });
    for (const d of o.docs!) {
      if (!Array.isArray(d) || typeof d[0] !== 'string' || !num(d[1]) || !Array.isArray(d[2])) bad('docs 条目结构错误');
      const tf = new Map<string, number>();
      for (const p of d[2]) {
        if (!Array.isArray(p) || typeof p[0] !== 'string' || !num(p[1])) bad('tf 条目结构错误');
        tf.set(p[0], p[1]);
      }
      idx.removeText(d[0]);
      idx.insertDoc(d[0], d[1], tf);
    }
    for (const a of o.anchors!) {
      if (!Array.isArray(a) || typeof a[0] !== 'string' || !Array.isArray(a[1])) bad('anchors 条目结构错误');
      for (const s of a[1]) {
        if (typeof s !== 'string') bad('锚点不是字符串');
        idx.addAnchor(a[0], s);
      }
    }
    return idx;
  }

  // ---- 内部 ----

  /** Lucene 式 idf：log(1 + (N-df+0.5)/(df+0.5))，恒正，避免经典 Okapi 在 df>N/2 时出负分。 */
  private idf(N: number, df: number): number {
    return Math.log(1 + (N - df + 0.5) / (df + 0.5));
  }

  private insertDoc(id: string, len: number, tf: Map<string, number>): void {
    for (const [t, n] of tf) {
      let plist = this.postings.get(t);
      if (!plist) this.postings.set(t, (plist = new Map()));
      plist.set(id, n);
    }
    this.docs.set(id, { len, tf });
    this.totalLen += len;
    this.ids.add(id);
  }

  /** 只移除正文部分（锚点不动）；无锚点时 id 也从 N 中撤出。 */
  private removeText(id: string): void {
    const d = this.docs.get(id);
    if (!d) return;
    for (const t of d.tf.keys()) {
      const plist = this.postings.get(t)!;
      plist.delete(id);
      if (plist.size === 0) this.postings.delete(t);
    }
    this.totalLen -= d.len;
    this.docs.delete(id);
    if (!this.anchorsById.has(id)) this.ids.delete(id);
  }
}
