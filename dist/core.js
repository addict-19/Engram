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
var toMessage = (e) => e instanceof Error ? e.message : String(e);
async function wrapIO(fn, code) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof EngramError) throw e;
    throw new EngramError(code, toMessage(e), e);
  }
}
async function moduleIO(fn, code, modulePrefix) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof EngramError && e.code.startsWith(modulePrefix)) throw e;
    throw new EngramError(code, toMessage(e), e);
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
  const out = Object.assign(/* @__PURE__ */ Object.create(null), base);
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
var libIO = (fn, code) => moduleIO(fn, code, "E_LIB_");
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
    if (meta.id !== libId) throw new EngramError("E_LIB_ID_MISMATCH", `meta.json \u7684 id\uFF08${meta.id}\uFF09\u4E0E\u76EE\u5F55\u540D\uFF08${libId}\uFF09\u4E0D\u4E00\u81F4`);
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
        if (meta.id !== name) continue;
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
var vecErr = (code, msg, cause) => new EngramError(code, msg, cause);
var vecIO = (fn, code) => moduleIO(fn, code, "E_VEC_");
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
        `entry "${id}" \u7EF4\u5EA6 ${vec.length} \u4E0E query \u7EF4\u5EA6 ${dim} \u4E0D\u7B26`
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

// src/core/retrieval/fuse.ts
var SOURCES = ["bm25", "vec"];
function rrfFuse(lists, opts) {
  const k = opts?.k ?? 60;
  if (!Number.isFinite(k) || k < 0) throw new EngramError("E_FUSE_K", `RRF k \u5FC5\u987B\u662F\u975E\u8D1F\u6709\u9650\u6570\uFF0C\u6536\u5230 ${k}`);
  if (lists.length > SOURCES.length) {
    throw new EngramError("E_FUSE_LISTS", `RRF \u6700\u591A\u878D\u5408 ${SOURCES.length} \u8DEF\uFF08bm25, vec\uFF09\uFF0C\u6536\u5230 ${lists.length} \u8DEF`);
  }
  const acc = /* @__PURE__ */ new Map();
  lists.forEach((list, li) => {
    const src = SOURCES[li];
    const seen = /* @__PURE__ */ new Set();
    list.forEach((item2, idx) => {
      if (seen.has(item2.id)) return;
      seen.add(item2.id);
      const add = 1 / (k + idx + 1);
      const cur = acc.get(item2.id);
      if (cur) {
        cur.score += add;
        cur.sources.push(src);
      } else {
        acc.set(item2.id, { score: add, sources: [src], order: acc.size });
      }
    });
  });
  return [...acc.entries()].sort((a, b) => b[1].score - a[1].score || a[1].order - b[1].order).map(([id, v]) => ({ id, score: v.score, sources: v.sources }));
}
function markAnchors(cands, anchorHitIds) {
  return cands.map((c) => {
    const out = { ...c, sources: [...c.sources] };
    if (anchorHitIds.has(c.id)) out.anchorHit = true;
    return out;
  });
}

// src/core/retrieval/weight.ts
function applyWeights(cands, meta, opts) {
  const atTagBoost = opts?.atTagBoost ?? 1.2;
  const atPulseBoost = opts?.atPulseBoost ?? 1.5;
  const importanceFactor = opts?.importanceFactor ?? 0.02;
  const echoDecay = opts?.echoDecay ?? 0.6;
  const out = [];
  const present = /* @__PURE__ */ new Set();
  for (const c of cands) {
    present.add(c.id);
    const atMul = meta.atPulsed.has(c.id) ? atPulseBoost : meta.atTagged.has(c.id) ? atTagBoost : 1;
    const impMul = 1 + (meta.importance.get(c.id) ?? 0) * importanceFactor;
    const natural = c.score * atMul * impMul;
    const prev = meta.prevSelected.get(c.id);
    const score = prev === void 0 ? natural : Math.max(natural, prev * echoDecay);
    out.push({ ...c, sources: [...c.sources], score });
  }
  for (const [id, prev] of meta.prevSelected) {
    if (present.has(id)) continue;
    out.push({ id, score: prev * echoDecay, sources: [] });
  }
  return out.sort((a, b) => b.score - a.score);
}

// src/core/retrieval/cliff.ts
function gapStrength(a, b, ratio, margin) {
  let rs;
  if (a <= 0) rs = 0;
  else if (b <= 0) rs = Infinity;
  else rs = a / b / ratio;
  const ms = margin !== void 0 && margin > 0 ? (a - b) / margin : 0;
  return Math.max(rs, ms);
}
function detectCliff(sorted, opts) {
  const ratio = opts?.ratio ?? 1.5;
  const maxLead = opts?.maxLead ?? 3;
  const margin = opts?.margin;
  const minScore = opts?.minScore;
  const n = sorted.length;
  if (n === 0) return 0;
  let k = 0;
  if (n === 1) {
    k = sorted[0] > 0 ? 1 : 0;
  } else {
    const gaps = Math.min(maxLead, n - 1);
    let best = -Infinity;
    let bestIdx = -1;
    for (let i = 0; i < gaps; i++) {
      const s = gapStrength(sorted[i], sorted[i + 1], ratio, margin);
      if (s > best) {
        best = s;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && best >= 1) k = bestIdx + 1;
  }
  if (k > 0 && minScore !== void 0) {
    for (let i = 0; i < k; i++) if (sorted[i] < minScore) return 0;
  }
  return k;
}
function passFloor(score, floor) {
  return score >= floor;
}

// src/core/retrieval/charge.ts
var NODE = 1;
var CHAPTER = 2;
var VOLUME = 3;
function ancestors(id, units) {
  const out = [];
  const seen = /* @__PURE__ */ new Set([id]);
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
var atLayer = (chain, layer) => chain.find((u) => u.layer === layer);
var item = (u, form, reason) => u ? [{ id: u.id, form, tokens: u.tokens[form], reason }] : [];
var isNode = (u) => !!u && u.kind === "unit" && u.layer === NODE;
function gradeAndCluster(cands, units, opts) {
  const nodeClusterMin = opts.nodeClusterMin ?? 2;
  const charge = /* @__PURE__ */ new Map();
  const add = (id, v) => charge.set(id, (charge.get(id) ?? 0) + v);
  const sorted = cands.map((c, i) => ({ c, i })).sort((a, b) => b.c.score - a.c.score || a.i - b.i).map((x) => x.c);
  const chains = /* @__PURE__ */ new Map();
  for (const c of sorted) {
    const chain = ancestors(c.id, units);
    chains.set(c.id, chain);
    for (const u of chain) add(u.id, c.score);
  }
  const direct = [];
  for (const id of opts.directNodeHits ?? []) {
    const u = units.get(id);
    if (!isNode(u)) continue;
    direct.push(u);
    add(u.id, 1);
    for (const a of ancestors(u.id, units)) add(a.id, 1);
  }
  const directIds = new Set(direct.map((u) => u.id));
  const nodeOf = /* @__PURE__ */ new Map();
  const chapterOf = /* @__PURE__ */ new Map();
  const nodeHits = /* @__PURE__ */ new Map();
  const chapterNodes = /* @__PURE__ */ new Map();
  for (const c of sorted) {
    const chain = chains.get(c.id);
    const n = atLayer(chain, NODE);
    const ch = atLayer(chain, CHAPTER);
    nodeOf.set(c.id, n);
    chapterOf.set(c.id, ch);
    if (n) nodeHits.set(n.id, (nodeHits.get(n.id) ?? 0) + 1);
    if (n && ch) {
      if (!chapterNodes.has(ch.id)) chapterNodes.set(ch.id, /* @__PURE__ */ new Set());
      chapterNodes.get(ch.id).add(n.id);
    }
  }
  for (const u of direct) {
    nodeHits.set(u.id, (nodeHits.get(u.id) ?? 0) + 1);
    const ch = atLayer(ancestors(u.id, units), CHAPTER);
    if (ch) {
      if (!chapterNodes.has(ch.id)) chapterNodes.set(ch.id, /* @__PURE__ */ new Set());
      chapterNodes.get(ch.id).add(u.id);
    }
  }
  const nodeClustered = (id) => directIds.has(id) || (nodeHits.get(id) ?? 0) >= nodeClusterMin;
  const chapterClustered = (id) => (chapterNodes.get(id)?.size ?? 0) >= 2;
  const k = detectCliff(sorted.map((c) => c.score), opts.cliff);
  const slices = sorted.map((c, idx) => {
    let grade = "mention";
    const n = nodeOf.get(c.id), ch = chapterOf.get(c.id);
    if (idx < k) grade = "precise";
    else if (n && nodeClustered(n.id)) grade = "nodeCluster";
    else if (ch && chapterClustered(ch.id)) grade = "chapterCluster";
    return { id: c.id, grade, score: c.score };
  });
  const upgrades = [];
  const nodeOrder = [];
  const chapterOrder = [];
  for (const s of slices) {
    const chain = chains.get(s.id);
    if (s.grade === "precise") {
      const reason = `precise:${s.id}`;
      upgrades.push(
        ...item(nodeOf.get(s.id), "body", reason),
        ...item(chapterOf.get(s.id), "summary", reason),
        ...item(atLayer(chain, VOLUME), "summary", reason)
      );
    } else if (s.grade === "nodeCluster") {
      const n = nodeOf.get(s.id);
      if (!nodeOrder.includes(n)) nodeOrder.push(n);
    } else if (s.grade === "chapterCluster") {
      const ch = chapterOf.get(s.id);
      if (!chapterOrder.includes(ch)) chapterOrder.push(ch);
    }
  }
  const sliceNodes = new Set([...nodeOf.values()].filter((n) => n).map((n) => n.id));
  for (const u of direct) if (!sliceNodes.has(u.id)) nodeOrder.push(u);
  for (const n of nodeOrder) {
    const chain = ancestors(n.id, units);
    const reason = `nodeCluster:${n.id}`;
    upgrades.push(
      ...item(n, "body", reason),
      ...item(atLayer(chain, CHAPTER), "summary", reason),
      ...item(atLayer(chain, VOLUME), "summary", reason)
    );
  }
  for (const ch of chapterOrder) {
    const reason = `chapterCluster:${ch.id}`;
    upgrades.push(
      ...item(ch, "body", reason),
      ...item(atLayer(ancestors(ch.id, units), VOLUME), "summary", reason)
    );
  }
  return { slices, upgrades, charge };
}

// src/core/retrieval/bucket.ts
var MIN_LAYER = 2;
function bucketSelect(unitCands, units, opts) {
  const perLayerMax = opts.perLayerMax ?? 2;
  const buckets = /* @__PURE__ */ new Map();
  unitCands.forEach((c, i) => {
    const u = units.get(c.id);
    if (!u || u.kind !== "unit" || u.layer < MIN_LAYER) return;
    let b = buckets.get(u.layer);
    if (!b) {
      b = [];
      buckets.set(u.layer, b);
    }
    b.push({ u, score: c.score, i });
  });
  const picks = [];
  const layers = [...buckets.keys()].sort((a, b) => b - a);
  for (const layer of layers) {
    const passed = buckets.get(layer).filter((x) => passFloor(x.score, opts.floor)).sort((a, b) => b.score - a.score || a.i - b.i);
    const k = detectCliff(passed.map((x) => x.score), opts.cliff);
    passed.slice(0, Math.max(0, perLayerMax)).forEach((x, idx) => picks.push({ u: x.u, score: x.score, lead: idx < k }));
  }
  const picked = new Map(picks.map((p) => [p.u.id, p]));
  const absorbed = (self) => {
    const u = self.u;
    const seen = /* @__PURE__ */ new Set([u.id]);
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
  const requests = [];
  const chargeSignals = [];
  for (const p of picks) {
    if (absorbed(p)) continue;
    const form = p.lead ? "body" : "summary";
    requests.push({
      id: p.u.id,
      form,
      tokens: p.u.tokens[form],
      reason: `bucket:${p.lead ? "lead" : "graze"}:${p.u.id}`
    });
    if (!p.lead) chargeSignals.push(p.u.id);
  }
  return { requests, chargeSignals };
}

// src/core/retrieval/assemble.ts
var DEFAULT_RECALL_BUDGET = 8e3;
var RANK = { title: 0, summary: 1, body: 2 };
var DOWN = { body: "summary", summary: "title" };
var KEY_RE = /(^|:)(precise|lead)(:|$)/;
function assemble(parts, units, opts) {
  const recallBudget = opts?.recallBudget ?? DEFAULT_RECALL_BUDGET;
  const merged = /* @__PURE__ */ new Map();
  let order = 0;
  const sources = [parts.clusterItems, parts.bucketItems];
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
        if (src === m.src) m.reason = it.reason;
      }
    }
  });
  const live = [];
  for (const m of merged.values()) {
    const r = parts.resident.get(m.id);
    if (r !== void 0 && RANK[r] >= RANK[m.form]) continue;
    const u = units.get(m.id);
    if (u) m.tokens = u.tokens[m.form];
    live.push(m);
  }
  const dropped = [];
  const out = new Map(live.map((m) => [m.id, { id: m.id, form: m.form, tokens: m.tokens, reason: m.reason }]));
  let total = live.reduce((s, m) => s + m.tokens, 0);
  if (total > recallBudget) {
    const byValue = [...live].sort((a, b) => a.src - b.src || Number(b.key) - Number(a.key) || a.tokens - b.tokens || a.order - b.order);
    for (const m of byValue.reverse()) {
      if (total <= recallBudget) break;
      const cur = out.get(m.id);
      const u = units.get(m.id);
      const degradable = u !== void 0 && u.kind !== "slice";
      while (degradable && total > recallBudget && DOWN[cur.form]) {
        const f = DOWN[cur.form];
        total += u.tokens[f] - cur.tokens;
        cur.form = f;
        cur.tokens = u.tokens[f];
      }
      if (total > recallBudget) {
        total -= cur.tokens;
        out.delete(m.id);
        dropped.push({ id: m.id, form: m.form, tokens: m.tokens, reason: m.reason });
      }
    }
  }
  const kept = live.filter((m) => out.has(m.id));
  const withTs = kept.filter((m) => units.get(m.id)?.ts !== void 0);
  const noTs = kept.filter((m) => units.get(m.id)?.ts === void 0);
  withTs.sort((a, b) => {
    const ta = units.get(a.id).ts, tb = units.get(b.id).ts;
    return ta < tb ? -1 : ta > tb ? 1 : a.order - b.order;
  });
  return { final: [...withTs, ...noTs].map((m) => out.get(m.id)), dropped };
}

// src/core/retrieval/ppr.ts
var PPR_WEIGHTS_SOLO = Object.freeze({
  semantic: 0.25,
  event: 0.25,
  entity: 0.25,
  location: 0.15,
  pair: 0.1,
  floor: 0
});
var PPR_WEIGHTS_ENSEMBLE = Object.freeze({
  semantic: 0.25,
  event: 0.25,
  entity: 0.25,
  location: 0.1,
  pair: 0.15,
  floor: 0
});
var DEFAULT_WINDOW = 80;
function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
function pairsOf(chars) {
  const u = [...new Set(chars)].sort();
  const out = /* @__PURE__ */ new Set();
  for (let i = 0; i < u.length; i++) for (let j = i + 1; j < u.length; j++) out.add(`${u[i]}\0${u[j]}`);
  return out;
}
var entitiesOf = (n) => /* @__PURE__ */ new Set([...n.anchors, ...n.tags]);
function edgeWeight(a, b, vecSim, w, window = DEFAULT_WINDOW) {
  return edgeWeightPre(prep(a), prep(b), vecSim, w, window);
}
var prep = (n) => ({ n, ents: entitiesOf(n), pairs: pairsOf(n.characters), events: new Set(n.eventIds ?? []) });
function edgeWeightPre(a, b, vecSim, w, window) {
  let s = 0;
  if (w.semantic) s += w.semantic * Math.max(0, vecSim(a.n.id, b.n.id));
  if (w.event) {
    for (const e of a.events) if (b.events.has(e)) {
      s += w.event;
      break;
    }
  }
  if (w.entity) s += w.entity * jaccard(a.ents, b.ents);
  if (w.location && a.n.location !== void 0 && a.n.location === b.n.location) s += w.location;
  if (w.pair) s += w.pair * jaccard(a.pairs, b.pairs);
  if (w.floor && a.n.floor !== void 0 && b.n.floor !== void 0 && window > 0) {
    s += w.floor * Math.max(0, 1 - Math.abs(a.n.floor - b.n.floor) / window);
  }
  return s;
}
function pprExpand(seeds, nodes, vecSim, opts) {
  const alpha = opts?.alpha ?? 0.15;
  const maxAdd = opts?.maxAdd ?? 3;
  const simFloor = opts?.simFloor ?? 0;
  const window = opts?.window ?? DEFAULT_WINDOW;
  const maxIter = opts?.maxIter ?? 50;
  const tol = opts?.tol ?? 1e-6;
  const base = opts?.profile === "ensemble" ? PPR_WEIGHTS_ENSEMBLE : PPR_WEIGHTS_SOLO;
  const w = { ...base };
  for (const [k, v] of Object.entries(opts?.channelWeights ?? {})) {
    if (v !== void 0) w[k] = v;
  }
  if (maxAdd <= 0) return [];
  const list = [];
  const index = /* @__PURE__ */ new Map();
  for (const n2 of nodes) if (!index.has(n2.id)) {
    index.set(n2.id, list.length);
    list.push(n2);
  }
  const n = list.length;
  const p = new Float64Array(n);
  const seedIdx = [];
  for (const [id] of seeds) {
    const i = index.get(id);
    if (i !== void 0 && !seedIdx.includes(i)) seedIdx.push(i);
  }
  if (seedIdx.length === 0) return [];
  let mass = 0;
  for (const i of seedIdx) {
    const v = Math.max(0, seeds.get(list[i].id));
    p[i] = v;
    mass += v;
  }
  if (mass > 0) for (const i of seedIdx) p[i] /= mass;
  else for (const i of seedIdx) p[i] = 1 / seedIdx.length;
  const pre = list.map(prep);
  const adj = list.map(() => []);
  const deg = new Float64Array(n);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const ew = edgeWeightPre(pre[i], pre[j], vecSim, w, window);
    if (ew > 0) {
      adj[i].push([j, ew]);
      adj[j].push([i, ew]);
      deg[i] += ew;
      deg[j] += ew;
    }
  }
  let r = Float64Array.from(p);
  for (let it = 0; it < maxIter; it++) {
    const next = new Float64Array(n);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      const ri = r[i];
      if (ri === 0) continue;
      if (deg[i] === 0) {
        dangling += ri;
        continue;
      }
      for (const [j, ew] of adj[i]) next[j] += (1 - alpha) * ri * ew / deg[i];
    }
    let diff = 0;
    for (let i = 0; i < n; i++) {
      next[i] += (alpha + (1 - alpha) * dangling) * p[i];
      diff += Math.abs(next[i] - r[i]);
    }
    r = next;
    if (diff < tol) break;
  }
  const seedSet = new Set(seedIdx);
  const out = [];
  for (let i = 0; i < n; i++) {
    if (seedSet.has(i) || r[i] <= 0) continue;
    let best = -Infinity;
    for (const si of seedIdx) best = Math.max(best, vecSim(list[i].id, list[si].id));
    if (best < simFloor) continue;
    out.push({ i, s: r[i] });
  }
  return out.sort((a, b) => b.s - a.s || a.i - b.i).slice(0, maxAdd).map((x) => list[x.i].id);
}

// src/core/retrieval/pipeline.ts
function applyRerank(cands, rerank, topN) {
  const n = Math.max(0, topN);
  const head = cands.slice(0, n);
  const rest = cands.slice(n);
  if (head.length === 0) return cands;
  const scores = rerank(head.map((c) => c.id));
  const rescored = head.map((c) => {
    const r = scores.get(c.id);
    if (r === void 0) return c;
    return { ...c, score: c.anchorHit ? Math.max(r, c.score) : r };
  });
  rescored.sort((a, b) => b.score - a.score);
  return [...rescored, ...rest];
}
function retrieve(input) {
  const { units, opts = {} } = input;
  const fused = markAnchors(rrfFuse([input.bm25Results, input.vecResults], { k: opts.fuseK }), input.anchorHitIds);
  let ranked = applyWeights(fused, input.weightMeta, opts.weight);
  if (opts.rerank) ranked = applyRerank(ranked, opts.rerank, opts.rerankTopN ?? 20);
  const sliceCands = [];
  const unitCands = [];
  const directNodeHits = /* @__PURE__ */ new Set();
  for (const c of ranked) {
    const u = units.get(c.id);
    if (u && u.kind !== "slice" && u.layer === 1) directNodeHits.add(c.id);
    else if (u && u.kind !== "slice" && u.layer >= 2) unitCands.push(c);
    else sliceCands.push(c);
  }
  const cliff = opts.cliff ?? {};
  const cluster = gradeAndCluster(sliceCands, units, { cliff, nodeClusterMin: opts.nodeClusterMin, directNodeHits });
  const bucket = bucketSelect(unitCands, units, {
    floor: opts.bucket?.floor ?? 0,
    cliff: opts.bucket?.cliff ?? cliff,
    perLayerMax: opts.bucket?.perLayerMax
  });
  const sliceItem = (id, reason) => ({ id, form: "body", tokens: units.get(id)?.tokens.body ?? 0, reason });
  const grades = [...cluster.slices];
  const clusterItems = [
    ...cluster.slices.map((s) => sliceItem(s.id, s.grade)),
    ...cluster.upgrades
  ];
  if (input.pprNodes && input.vecSim && cluster.slices.length > 0) {
    const seeds = new Map(cluster.slices.map((s) => [s.id, s.score]));
    const sliceNodes = input.pprNodes.filter((n) => {
      const u = units.get(n.id);
      return !u || u.kind === "slice";
    });
    for (const id of pprExpand(seeds, sliceNodes, input.vecSim, opts.ppr)) {
      grades.push({ id, grade: "mention", score: 0 });
      clusterItems.push(sliceItem(id, "ppr"));
    }
  }
  const { final, dropped } = assemble(
    { resident: input.resident, clusterItems, bucketItems: bucket.requests },
    units,
    { recallBudget: opts.recallBudget }
  );
  return { final, dropped, grades, chargeSignals: [...bucket.chargeSignals] };
}
export {
  BM25Index,
  DEFAULT_RECALL_BUDGET,
  EngramError,
  LIB_KINDS,
  PPR_WEIGHTS_ENSEMBLE,
  PPR_WEIGHTS_SOLO,
  VectorStore,
  applyDeltas,
  applyWeights,
  assemble,
  bigramTokenizer,
  bucketSelect,
  createLibrary,
  detectCliff,
  edgeWeight,
  fnv1a32,
  gradeAndCluster,
  listLibraries,
  markAnchors,
  normalize,
  openLibrary,
  parseDeltaLine,
  passFloor,
  pprExpand,
  retrieve,
  rollbackView,
  rrfFuse,
  serializeDelta,
  topK,
  uuidv4,
  wrapIO,
  writeFileAtomic
};
