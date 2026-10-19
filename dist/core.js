// src/core/uuid.ts
function uuidv4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === "x" ? r : r & 3 | 8;
    return v.toString(16);
  });
}

// src/core/errors.ts
var EngramError = class extends Error {
  constructor(code, message, cause) {
    super(message);
    this.code = code;
    this.cause = cause;
    this.name = "EngramError";
  }
  code;
  cause;
};
async function wrapIO(fn, code) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof EngramError) throw e;
    throw new EngramError(code, e instanceof Error ? e.message : String(e), e);
  }
}

// src/core/atomicWrite.ts
import { writeFile, rename } from "node:fs/promises";
async function writeFileAtomic(path, data) {
  return wrapIO(async () => {
    const tmp = `${path}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, data, "utf8");
    await rename(tmp, path);
  }, "E_ATOMIC_WRITE");
}

// src/core/delta.ts
function applyDeltas(base, deltas) {
  const out = { ...base };
  for (const dl of deltas) {
    if (dl.op === "create") out[dl.id] = { ...dl.payload, id: dl.id };
    else if (dl.op === "update") {
      const cur = out[dl.id];
      if (cur) out[dl.id] = { ...cur, ...dl.payload, id: dl.id };
    } else if (dl.op === "delete") delete out[dl.id];
  }
  return out;
}
function rollbackView(deltas, maxFloor) {
  return deltas.filter((dl) => dl.floor <= maxFloor);
}
function serializeDelta(d) {
  return JSON.stringify(d);
}
function parseDeltaLine(line) {
  if (!line.trim()) return null;
  try {
    const o = JSON.parse(line);
    if (typeof o?.seq !== "number" || typeof o?.floor !== "number" || typeof o?.id !== "string") return null;
    if (o.payload !== void 0 && (typeof o.payload !== "object" || o.payload === null || Array.isArray(o.payload))) return null;
    return o;
  } catch {
    return null;
  }
}

// src/core/library.ts
import { mkdir, readFile, readdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
var LIB_KINDS = ["chronicle", "persona", "atlas", "treasury", "knowledge", "extra"];
var DELTA_OPS = ["create", "update", "delete"];
var META = "meta.json";
var LOG = "log.jsonl";
var SNAPSHOT = "snapshot.json";
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
async function libIO(fn, code) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof EngramError && e.code.startsWith("E_LIB_")) throw e;
    throw new EngramError(code, e instanceof Error ? e.message : String(e), e);
  }
}
function isENOENT(e) {
  return typeof e === "object" && e !== null && e.code === "ENOENT";
}
async function readTextOrNull(path) {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if (isENOENT(e)) return null;
    throw e;
  }
}
function parseLog(text) {
  if (!text) return [];
  const out = [];
  for (const line of text.split("\n")) {
    const d = parseDeltaLine(line);
    if (d) out.push(d);
  }
  return out;
}
function parseMeta(text) {
  const m = JSON.parse(text);
  if (typeof m?.id !== "string" || typeof m?.displayName !== "string") throw new Error("meta.json \u7ED3\u6784\u4E0D\u5408\u6CD5");
  if (typeof m.snapshotSeq !== "number") m.snapshotSeq = 0;
  return m;
}
function parseSnapshot(text) {
  if (!text) return null;
  try {
    const s = JSON.parse(text);
    if (typeof s?.seq !== "number" || typeof s?.state !== "object" || s.state === null) return null;
    return s;
  } catch {
    return null;
  }
}
function computeState(log, snap, kind, maxFloor) {
  const limit = maxFloor ?? Infinity;
  const ofKind = log.filter((d) => d.lib === kind);
  if (snap) {
    const covered = ofKind.filter((d) => d.seq <= snap.seq);
    const coveredFloor = covered.reduce((m, d) => Math.max(m, d.floor), -Infinity);
    if (limit >= coveredFloor) {
      const tail = ofKind.filter((d) => d.seq > snap.seq);
      return applyDeltas({ ...snap.state[kind] ?? {} }, rollbackView(tail, limit));
    }
  }
  return applyDeltas({}, rollbackView(ofKind, limit));
}
var Library = class {
  constructor(dir, meta, lastSeq, needsNewline) {
    this.dir = dir;
    this.meta = meta;
    this.lastSeq = lastSeq;
    this.needsNewline = needsNewline;
  }
  dir;
  meta;
  lastSeq;
  needsNewline;
  queue = Promise.resolve();
  get id() {
    return this.meta.id;
  }
  get displayName() {
    return this.meta.displayName;
  }
  // 单进程内写操作串行：防 appendFile 交错写行、seq 抢号、meta 互相覆盖
  serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => void 0);
    return run;
  }
  async readLog() {
    return parseLog(await readTextOrNull(join(this.dir, LOG)));
  }
  async readSnapshot() {
    return parseSnapshot(await readTextOrNull(join(this.dir, SNAPSHOT)));
  }
  async writeMeta(next) {
    await writeFileAtomic(join(this.dir, META), JSON.stringify(next, null, 2));
    this.meta = next;
  }
  appendDelta(d) {
    return this.serial(() => libIO(async () => {
      const full = { ...d, seq: this.lastSeq + 1, ts: (/* @__PURE__ */ new Date()).toISOString() };
      if (!LIB_KINDS.includes(full.lib)) throw new EngramError("E_LIB_DELTA", `\u975E\u6CD5 lib\uFF1A${String(full.lib)}`);
      if (!DELTA_OPS.includes(full.op)) throw new EngramError("E_LIB_DELTA", `\u975E\u6CD5 op\uFF1A${String(full.op)}`);
      if (!parseDeltaLine(serializeDelta(full))) throw new EngramError("E_LIB_DELTA", "delta \u65E0\u6CD5\u901A\u8FC7 round-trip \u89E3\u6790\uFF08\u68C0\u67E5 floor/id/payload\uFF09");
      const line = (this.needsNewline ? "\n" : "") + serializeDelta(full) + "\n";
      try {
        await appendFile(join(this.dir, LOG), line, "utf8");
      } catch (e) {
        this.needsNewline = true;
        throw e;
      }
      this.needsNewline = false;
      this.lastSeq = full.seq;
      return full;
    }, "E_LIB_APPEND"));
  }
  getState(lib, maxFloor) {
    return libIO(async () => {
      const [log, snap] = await Promise.all([this.readLog(), this.readSnapshot()]);
      return computeState(log, snap, lib, maxFloor);
    }, "E_LIB_READ");
  }
  writeSnapshot() {
    return this.serial(() => libIO(async () => {
      const [log, snap] = await Promise.all([this.readLog(), this.readSnapshot()]);
      const state = {};
      for (const kind of LIB_KINDS) state[kind] = computeState(log, snap, kind);
      const next = { seq: this.lastSeq, state };
      await writeFileAtomic(join(this.dir, SNAPSHOT), JSON.stringify(next));
      await this.writeMeta({ ...this.meta, snapshotSeq: next.seq });
    }, "E_LIB_SNAPSHOT"));
  }
  renameLibrary(name) {
    return this.serial(() => libIO(() => this.writeMeta({ ...this.meta, displayName: name }), "E_LIB_META"));
  }
};
function assertLibId(libId) {
  if (!UUID_RE.test(libId)) throw new EngramError("E_LIB_ID", `\u975E\u6CD5\u5E93 id\uFF1A${libId}`);
}
async function createLibrary(rootDir, displayName) {
  return libIO(async () => {
    const id = uuidv4();
    const dir = join(rootDir, id);
    await mkdir(dir, { recursive: true });
    const meta = { id, displayName, version: 1, createdAt: (/* @__PURE__ */ new Date()).toISOString(), snapshotSeq: 0 };
    await writeFileAtomic(join(dir, META), JSON.stringify(meta, null, 2));
    return new Library(dir, meta, 0, false);
  }, "E_LIB_CREATE");
}
async function openLibrary(rootDir, libId) {
  assertLibId(libId);
  return libIO(async () => {
    const dir = join(rootDir, libId);
    const meta = parseMeta(await readFile(join(dir, META), "utf8"));
    const logText = await readTextOrNull(join(dir, LOG));
    const snap = parseSnapshot(await readTextOrNull(join(dir, SNAPSHOT)));
    const lastSeq = parseLog(logText).reduce((m, d) => Math.max(m, d.seq), Math.max(0, meta.snapshotSeq, snap?.seq ?? 0));
    const needsNewline = !!logText && !logText.endsWith("\n");
    return new Library(dir, meta, lastSeq, needsNewline);
  }, "E_LIB_OPEN");
}
async function listLibraries(rootDir) {
  return libIO(async () => {
    let names;
    try {
      names = await readdir(rootDir);
    } catch (e) {
      if (isENOENT(e)) return [];
      throw e;
    }
    const out = [];
    for (const name of names.filter((n) => UUID_RE.test(n)).sort()) {
      try {
        const meta = parseMeta(await readFile(join(rootDir, name, META), "utf8"));
        out.push({ id: name, displayName: meta.displayName });
      } catch {
      }
    }
    return out;
  }, "E_LIB_LIST");
}

// src/core/vectorStore.ts
import { mkdir as mkdir2, readFile as readFile2, rename as rename2, writeFile as writeFile2 } from "node:fs/promises";
import { join as join2 } from "node:path";
var INDEX = "index.json";
var BIN = "vectors.bin";
var sameFingerprint = (a, b) => a.model === b.model && a.dim === b.dim && a.quant === b.quant;
function isFingerprint(x) {
  if (!x || typeof x !== "object") return false;
  const f = x;
  return typeof f.model === "string" && Number.isInteger(f.dim) && f.dim > 0 && f.quant === "f32";
}
function fnv1a32(bytes) {
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
var vecErr = (code, msg, cause) => new EngramError(code, `${code}: ${msg}`, cause);
async function vecIO(fn, code) {
  try {
    return await wrapIO(fn, code);
  } catch (e) {
    if (e instanceof EngramError && e.code.startsWith("E_VEC_")) throw e;
    throw vecErr(code, e instanceof Error ? e.message : String(e), e);
  }
}
var VectorStore = class _VectorStore {
  constructor(fingerprint) {
    this.fingerprint = fingerprint;
    if (!isFingerprint(fingerprint)) throw vecErr("E_VEC_FINGERPRINT", "\u975E\u6CD5\u5411\u91CF\u6307\u7EB9");
  }
  fingerprint;
  vecs = /* @__PURE__ */ new Map();
  // 同 id 再 add 视为覆盖；入库时拷贝一份，外部改原数组不影响库内
  add(id, vec) {
    if (vec.length !== this.fingerprint.dim) {
      throw vecErr("E_VEC_DIM", `\u5411\u91CF\u7EF4\u5EA6 ${vec.length} \u4E0E\u6307\u7EB9 ${this.fingerprint.dim} \u4E0D\u7B26\uFF1A${id}`);
    }
    this.vecs.set(id, Float32Array.from(vec));
  }
  remove(id) {
    this.vecs.delete(id);
  }
  has(id) {
    return this.vecs.has(id);
  }
  get ids() {
    return [...this.vecs.keys()];
  }
  // 返回库内数组本体（检索热路径不拷贝），调用方只读不写
  entries() {
    return this.vecs.entries();
  }
  // 先写 vectors.bin 再写 index.json，各自 tmp+rename；index 记下 bin 的字节数与 hash，load 时双校验兜底跨文件不一致
  async save(dir) {
    const { dim } = this.fingerprint;
    const ids = this.ids;
    const buf = Buffer.alloc(ids.length * dim * 4);
    ids.forEach((id, i) => {
      const vec = this.vecs.get(id);
      for (let k = 0; k < dim; k++) buf.writeFloatLE(vec[k], (i * dim + k) * 4);
    });
    await vecIO(async () => {
      await mkdir2(dir, { recursive: true });
      const bin = join2(dir, BIN);
      const tmp = `${bin}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile2(tmp, buf);
      await rename2(tmp, bin);
      await writeFileAtomic(join2(dir, INDEX), JSON.stringify({ fingerprint: this.fingerprint, ids, binBytes: buf.length, binHash: fnv1a32(buf) }));
    }, "E_VEC_SAVE");
  }
  // 传了 expected 且与文件指纹不符 → E_VEC_FINGERPRINT（防新旧模型向量混算）；不传则按文件自述载入
  static async load(dir, expected) {
    return vecIO(async () => {
      const idx = JSON.parse(await readFile2(join2(dir, INDEX), "utf8"));
      const { fingerprint, ids, binBytes, binHash } = idx ?? {};
      if (!isFingerprint(fingerprint) || !Array.isArray(ids) || !ids.every((x) => typeof x === "string") || !Number.isInteger(binBytes) || !Number.isInteger(binHash)) {
        throw vecErr("E_VEC_CORRUPT", `${INDEX} \u7ED3\u6784\u975E\u6CD5`);
      }
      if (expected && !sameFingerprint(fingerprint, expected)) {
        throw vecErr(
          "E_VEC_FINGERPRINT",
          `\u5411\u91CF\u6307\u7EB9\u4E0D\u7B26\uFF1A\u6587\u4EF6 ${JSON.stringify(fingerprint)}\uFF0C\u671F\u671B ${JSON.stringify(expected)}`
        );
      }
      const buf = await readFile2(join2(dir, BIN));
      if (buf.length !== binBytes) {
        throw vecErr("E_VEC_CORRUPT", `${BIN} \u5B57\u8282\u6570 ${buf.length} \u4E0E ${INDEX} \u8BB0\u5F55\u7684 ${binBytes} \u4E0D\u7B26`);
      }
      if (fnv1a32(buf) !== binHash) throw vecErr("E_VEC_CORRUPT", `${BIN} hash \u4E0E ${INDEX} \u8BB0\u5F55\u4E0D\u7B26`);
      const { dim } = fingerprint;
      if (buf.length !== ids.length * dim * 4) {
        throw vecErr("E_VEC_CORRUPT", `${BIN} \u957F\u5EA6 ${buf.length} \u4E0E ${ids.length}\xD7${dim}\xD74 \u4E0D\u7B26`);
      }
      if (new Set(ids).size !== ids.length) throw vecErr("E_VEC_CORRUPT", `${INDEX} \u542B\u91CD\u590D id`);
      const store = new _VectorStore({ model: fingerprint.model, dim, quant: fingerprint.quant });
      ids.forEach((id, i) => {
        const vec = new Float32Array(dim);
        for (let k = 0; k < dim; k++) vec[k] = buf.readFloatLE((i * dim + k) * 4);
        store.vecs.set(id, vec);
      });
      return store;
    }, "E_VEC_LOAD");
  }
};

// src/core/cosine.ts
function normalize(v) {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const out = new Float32Array(v.length);
  if (sum === 0) return out;
  const inv = 1 / Math.sqrt(sum);
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv;
  return out;
}
function dot(a, b) {
  const n = a.length;
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}
function topK(query, entries, k) {
  if (!(k > 0)) return [];
  const ids = [];
  const scores = [];
  const swap = (i, j) => {
    const ts = scores[i];
    scores[i] = scores[j];
    scores[j] = ts;
    const ti = ids[i];
    ids[i] = ids[j];
    ids[j] = ti;
  };
  const siftUp = (i) => {
    while (i > 0) {
      const p = i - 1 >> 1;
      if (scores[p] <= scores[i]) break;
      swap(i, p);
      i = p;
    }
  };
  const siftDown = (i) => {
    const n = scores.length;
    for (; ; ) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < n && scores[l] < scores[m]) m = l;
      if (r < n && scores[r] < scores[m]) m = r;
      if (m === i) break;
      swap(i, m);
      i = m;
    }
  };
  const dim = query.length;
  for (const [id, vec] of entries) {
    if (vec.length !== dim) {
      throw new EngramError(
        "E_COS_DIM",
        `E_COS_DIM: entry "${id}" \u7EF4\u5EA6 ${vec.length} \u4E0E query \u7EF4\u5EA6 ${dim} \u4E0D\u7B26`
      );
    }
    const s = dot(query, vec);
    if (scores.length < k) {
      ids.push(id);
      scores.push(s);
      siftUp(scores.length - 1);
    } else if (s > scores[0]) {
      ids[0] = id;
      scores[0] = s;
      siftDown(0);
    }
  }
  const out = ids.map((id, i) => ({ id, score: scores[i] }));
  out.sort((a, b) => b.score - a.score);
  return out;
}

// src/core/bm25.ts
var HAN = /\p{Script=Han}/u;
var WORD = /[\p{L}\p{N}]/u;
var isHan = (ch) => HAN.test(ch);
var isWordChar = (ch) => WORD.test(ch) && !HAN.test(ch);
var bigramTokenizer = (text) => {
  const out = [];
  const chars = Array.from(text);
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    if (isHan(ch)) {
      let j = i;
      while (j < chars.length && isHan(chars[j])) j++;
      if (j - i === 1) out.push(ch);
      else for (let p = i; p < j - 1; p++) out.push(chars[p] + chars[p + 1]);
      i = j;
    } else if (isWordChar(ch)) {
      let j = i;
      while (j < chars.length && isWordChar(chars[j])) j++;
      out.push(chars.slice(i, j).join("").toLowerCase());
      i = j;
    } else {
      i++;
    }
  }
  return out;
};
function normalizePhrase(s) {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}
function containsAnchor(q, anchor) {
  const head = isWordChar(Array.from(anchor)[0]);
  const tailChars = Array.from(anchor);
  const tail = isWordChar(tailChars[tailChars.length - 1]);
  let from = 0;
  for (; ; ) {
    const pos = q.indexOf(anchor, from);
    if (pos < 0) return false;
    const before = pos > 0 ? Array.from(q.slice(0, pos)).pop() : "";
    const after = Array.from(q.slice(pos + anchor.length))[0] ?? "";
    const okHead = !head || before === "" || !isWordChar(before);
    const okTail = !tail || after === "" || !isWordChar(after);
    if (okHead && okTail) return true;
    from = pos + 1;
  }
}
var DEFAULT_TOKENIZER_NAME = "bigram-v1";
var BM25Index = class _BM25Index {
  constructor(tokenizer, opts = {}) {
    this.tokenizer = tokenizer;
    this.k1 = opts.k1 ?? 1.2;
    this.b = opts.b ?? 0.75;
    this.anchorBoost = opts.anchorBoost ?? 3;
    this.tokenizerName = opts.tokenizerName ?? DEFAULT_TOKENIZER_NAME;
  }
  tokenizer;
  k1;
  b;
  anchorBoost;
  tokenizerName;
  /** term → (id → tf) */
  postings = /* @__PURE__ */ new Map();
  docs = /* @__PURE__ */ new Map();
  totalLen = 0;
  /** 归一化锚点 → id 集合 */
  anchorPostings = /* @__PURE__ */ new Map();
  anchorsById = /* @__PURE__ */ new Map();
  /** 有正文或锚点的全部 id（BM25 的 N） */
  ids = /* @__PURE__ */ new Set();
  /** 已索引的文档数（含仅挂锚点的 id）。 */
  get size() {
    return this.ids.size;
  }
  /** 加入/更新正文。同 id 再 add 为更新语义：替换正文，保留已挂锚点。 */
  add(id, text) {
    this.removeText(id);
    const tf = /* @__PURE__ */ new Map();
    const tokens = this.tokenizer(text);
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    this.insertDoc(id, tokens.length, tf);
  }
  /** 完整移除 id：正文与锚点一起清。不存在时静默。 */
  remove(id) {
    this.removeText(id);
    const set = this.anchorsById.get(id);
    if (set) {
      for (const a of set) {
        const ids = this.anchorPostings.get(a);
        ids.delete(id);
        if (ids.size === 0) this.anchorPostings.delete(a);
      }
      this.anchorsById.delete(id);
    }
    this.ids.delete(id);
  }
  /** 锚点整词挂到 id 上（不经分词）。大小写/空白归一；空锚点忽略；可先于 add 调用。 */
  addAnchor(id, anchor) {
    const a = normalizePhrase(anchor);
    if (!a) return;
    let ids = this.anchorPostings.get(a);
    if (!ids) this.anchorPostings.set(a, ids = /* @__PURE__ */ new Set());
    ids.add(id);
    let mine = this.anchorsById.get(id);
    if (!mine) this.anchorsById.set(id, mine = /* @__PURE__ */ new Set());
    mine.add(a);
    this.ids.add(id);
  }
  search(query, k) {
    if (!(k > 0) || this.ids.size === 0) return [];
    const N = this.ids.size;
    const avgdl = this.docs.size > 0 ? this.totalLen / this.docs.size : 1;
    const scores = /* @__PURE__ */ new Map();
    const addScore = (id, s) => scores.set(id, (scores.get(id) ?? 0) + s);
    for (const term of new Set(this.tokenizer(query))) {
      const plist = this.postings.get(term);
      if (!plist) continue;
      const idf = this.idf(N, plist.size);
      for (const [id, tf] of plist) {
        const dl = this.docs.get(id).len;
        const norm = tf + this.k1 * (1 - this.b + this.b * dl / (avgdl || 1));
        addScore(id, idf * tf * (this.k1 + 1) / norm);
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
    const out = [];
    for (const [id, score] of scores) if (score > 0) out.push({ id, score });
    out.sort((x, y) => y.score - x.score);
    return out.slice(0, k);
  }
  toJSON() {
    const j = {
      v: 1,
      tokenizerName: this.tokenizerName,
      k1: this.k1,
      b: this.b,
      anchorBoost: this.anchorBoost,
      docs: [...this.docs].map(([id, d]) => [id, d.len, [...d.tf]]),
      anchors: [...this.anchorsById].map(([id, set]) => [id, [...set]])
    };
    return j;
  }
  /**
   * 还原索引。JSON 内 tokenizerName 与期望（opts.tokenizerName ?? 'bigram-v1'）不符、
   * 或缺此字段时抛 E_BM25_TOKENIZER——宁可拒载从全文重建，不让新旧分词的 term 静默混用。
   */
  static fromJSON(j, tokenizer, opts = {}) {
    const bad = (why) => {
      throw new EngramError("E_BM25_FORMAT", `BM25 \u5E8F\u5217\u5316\u6570\u636E\u65E0\u6548\uFF1A${why}`);
    };
    if (!j || typeof j !== "object") bad("\u4E0D\u662F\u5BF9\u8C61");
    const o = j;
    if (o.v !== 1) bad(`\u4E0D\u652F\u6301\u7684\u7248\u672C ${String(o.v)}`);
    const expected = opts.tokenizerName ?? DEFAULT_TOKENIZER_NAME;
    if (o.tokenizerName !== expected) {
      throw new EngramError(
        "E_BM25_TOKENIZER",
        `BM25 \u5206\u8BCD\u5668\u6307\u7EB9\u4E0D\u7B26\uFF1A\u6570\u636E\u4E3A ${String(o.tokenizerName)}\uFF0C\u671F\u671B ${expected}\uFF0C\u9700\u4ECE\u5168\u6587\u91CD\u5EFA`
      );
    }
    const num = (x) => typeof x === "number" && Number.isFinite(x);
    if (!num(o.k1) || !num(o.b) || !num(o.anchorBoost)) bad("\u53C2\u6570\u7F3A\u5931");
    if (!Array.isArray(o.docs) || !Array.isArray(o.anchors)) bad("docs/anchors \u4E0D\u662F\u6570\u7EC4");
    const idx = new _BM25Index(tokenizer, {
      k1: o.k1,
      b: o.b,
      anchorBoost: o.anchorBoost,
      tokenizerName: expected
    });
    for (const d of o.docs) {
      if (!Array.isArray(d) || typeof d[0] !== "string" || !num(d[1]) || !Array.isArray(d[2])) bad("docs \u6761\u76EE\u7ED3\u6784\u9519\u8BEF");
      const tf = /* @__PURE__ */ new Map();
      for (const p of d[2]) {
        if (!Array.isArray(p) || typeof p[0] !== "string" || !num(p[1])) bad("tf \u6761\u76EE\u7ED3\u6784\u9519\u8BEF");
        tf.set(p[0], p[1]);
      }
      idx.removeText(d[0]);
      idx.insertDoc(d[0], d[1], tf);
    }
    for (const a of o.anchors) {
      if (!Array.isArray(a) || typeof a[0] !== "string" || !Array.isArray(a[1])) bad("anchors \u6761\u76EE\u7ED3\u6784\u9519\u8BEF");
      for (const s of a[1]) {
        if (typeof s !== "string") bad("\u951A\u70B9\u4E0D\u662F\u5B57\u7B26\u4E32");
        idx.addAnchor(a[0], s);
      }
    }
    return idx;
  }
  // ---- 内部 ----
  /** Lucene 式 idf：log(1 + (N-df+0.5)/(df+0.5))，恒正，避免经典 Okapi 在 df>N/2 时出负分。 */
  idf(N, df) {
    return Math.log(1 + (N - df + 0.5) / (df + 0.5));
  }
  insertDoc(id, len, tf) {
    for (const [t, n] of tf) {
      let plist = this.postings.get(t);
      if (!plist) this.postings.set(t, plist = /* @__PURE__ */ new Map());
      plist.set(id, n);
    }
    this.docs.set(id, { len, tf });
    this.totalLen += len;
    this.ids.add(id);
  }
  /** 只移除正文部分（锚点不动）；无锚点时 id 也从 N 中撤出。 */
  removeText(id) {
    const d = this.docs.get(id);
    if (!d) return;
    for (const t of d.tf.keys()) {
      const plist = this.postings.get(t);
      plist.delete(id);
      if (plist.size === 0) this.postings.delete(t);
    }
    this.totalLen -= d.len;
    this.docs.delete(id);
    if (!this.anchorsById.has(id)) this.ids.delete(id);
  }
};
export {
  BM25Index,
  EngramError,
  LIB_KINDS,
  VectorStore,
  applyDeltas,
  bigramTokenizer,
  createLibrary,
  fnv1a32,
  listLibraries,
  normalize,
  openLibrary,
  parseDeltaLine,
  rollbackView,
  serializeDelta,
  topK,
  uuidv4,
  wrapIO,
  writeFileAtomic
};
