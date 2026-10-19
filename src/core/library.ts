// src/core/library.ts
// 库生命周期：<rootDir>/<库uuid>/{meta.json, log.jsonl, snapshot.json}
// 双轨宪法：目录名永远是 uuid，显示名只活在 meta.json 里，改名不动 id。
import { mkdir, readFile, readdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { uuidv4 } from './uuid.js';
import { EngramError } from './errors.js';
import { writeFileAtomic } from './atomicWrite.js';
import {
  applyDeltas, rollbackView, serializeDelta, parseDeltaLine,
  type Delta, type Entity, type LibKind,
} from './delta.js';

export const LIB_KINDS: readonly LibKind[] = ['chronicle', 'persona', 'atlas', 'treasury', 'knowledge', 'extra'];
const DELTA_OPS: readonly Delta['op'][] = ['create', 'update', 'delete'];

const META = 'meta.json';
const LOG = 'log.jsonl';
const SNAPSHOT = 'snapshot.json';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface LibraryMeta {
  id: string;
  displayName: string;
  version: 1;
  createdAt: string;
  snapshotSeq: number;
}

interface Snapshot {
  seq: number;                                        // 快照覆盖到的 seq 截止点（含）
  state: Partial<Record<LibKind, Record<string, Entity>>>;
}

export interface LibraryHandle {
  readonly id: string;
  readonly displayName: string;
  appendDelta(d: Omit<Delta, 'seq' | 'ts'>): Promise<Delta>;
  getState(lib: LibKind, maxFloor?: number): Promise<Record<string, Entity>>;
  writeSnapshot(): Promise<void>;
  renameLibrary(name: string): Promise<void>;
}

// 全部 IO 过这一层：底层（含 writeFileAtomic 的 E_ATOMIC_WRITE）统一翻成 E_LIB_*，原错误留在 cause
async function libIO<T>(fn: () => Promise<T>, code: string): Promise<T> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof EngramError && e.code.startsWith('E_LIB_')) throw e;
    throw new EngramError(code, e instanceof Error ? e.message : String(e), e);
  }
}

function isENOENT(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ENOENT';
}

async function readTextOrNull(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); }
  catch (e) { if (isENOENT(e)) return null; throw e; }
}

function parseLog(text: string | null): Delta[] {
  if (!text) return [];
  const out: Delta[] = [];
  for (const line of text.split('\n')) {
    const d = parseDeltaLine(line);
    if (d) out.push(d);                               // 坏行丢弃，不连坐
  }
  return out;
}

function parseMeta(text: string): LibraryMeta {
  const m = JSON.parse(text) as LibraryMeta;
  if (typeof m?.id !== 'string' || typeof m?.displayName !== 'string') throw new Error('meta.json 结构不合法');
  if (typeof m.snapshotSeq !== 'number') m.snapshotSeq = 0;
  return m;
}

function parseSnapshot(text: string | null): Snapshot | null {
  if (!text) return null;
  try {
    const s = JSON.parse(text) as Snapshot;
    if (typeof s?.seq !== 'number' || typeof s?.state !== 'object' || s.state === null) return null;
    return s;
  } catch { return null; }                            // 坏快照 = 没有快照，退回全量回放
}

// 快照 + 回放 + 可选回滚视图。maxFloor 低于快照里该 kind 的最高楼层时，
// 快照里已经混进了"未来"的楼，必须弃快照从头回放（正确性优先于速度）。
function computeState(log: Delta[], snap: Snapshot | null, kind: LibKind, maxFloor?: number): Record<string, Entity> {
  const limit = maxFloor ?? Infinity;
  const ofKind = log.filter((d) => d.lib === kind);
  if (snap) {
    // 覆盖楼层从日志推算，隐含两个前提：① 日志永不压缩/截断（快照前的 delta 全在）；
    // ② 被 parse 丢弃的坏行恰好就是当初没生效的行（快照内容与可读日志一致）
    const covered = ofKind.filter((d) => d.seq <= snap.seq);
    const coveredFloor = covered.reduce((m, d) => Math.max(m, d.floor), -Infinity);
    if (limit >= coveredFloor) {
      const tail = ofKind.filter((d) => d.seq > snap.seq);
      return applyDeltas({ ...(snap.state[kind] ?? {}) }, rollbackView(tail, limit));
    }
  }
  return applyDeltas({}, rollbackView(ofKind, limit));
}

class Library implements LibraryHandle {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private meta: LibraryMeta,
    private lastSeq: number,
    private needsNewline: boolean,                    // 上次崩溃留下无换行的半行：先补换行，免得新行被拼坏
  ) {}

  get id(): string { return this.meta.id; }
  get displayName(): string { return this.meta.displayName; }

  // 单进程内写操作串行：防 appendFile 交错写行、seq 抢号、meta 互相覆盖
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async readLog(): Promise<Delta[]> {
    return parseLog(await readTextOrNull(join(this.dir, LOG)));
  }

  private async readSnapshot(): Promise<Snapshot | null> {
    return parseSnapshot(await readTextOrNull(join(this.dir, SNAPSHOT)));
  }

  private async writeMeta(next: LibraryMeta): Promise<void> {
    await writeFileAtomic(join(this.dir, META), JSON.stringify(next, null, 2));
    this.meta = next;
  }

  appendDelta(d: Omit<Delta, 'seq' | 'ts'>): Promise<Delta> {
    return this.serial(() => libIO(async () => {
      const full: Delta = { ...d, seq: this.lastSeq + 1, ts: new Date().toISOString() };
      // 写盘前校验：读取侧会丢弃的行绝不能写进去，否则"写入成功"却在读盘时静默消失
      if (!LIB_KINDS.includes(full.lib)) throw new EngramError('E_LIB_DELTA', `非法 lib：${String(full.lib)}`);
      if (!DELTA_OPS.includes(full.op)) throw new EngramError('E_LIB_DELTA', `非法 op：${String(full.op)}`);
      if (!parseDeltaLine(serializeDelta(full))) throw new EngramError('E_LIB_DELTA', 'delta 无法通过 round-trip 解析（检查 floor/id/payload）');
      const line = (this.needsNewline ? '\n' : '') + serializeDelta(full) + '\n';
      try {
        await appendFile(join(this.dir, LOG), line, 'utf8');   // 唯一不走原子写的文件：append-only，行自带完整性
      } catch (e) {
        // 失败时可能已落盘半行（如磁盘满）：保守地让下一次先补换行，免得新行被拼坏
        this.needsNewline = true;
        throw e;
      }
      this.needsNewline = false;
      this.lastSeq = full.seq;
      return full;
    }, 'E_LIB_APPEND'));
  }

  getState(lib: LibKind, maxFloor?: number): Promise<Record<string, Entity>> {
    return libIO(async () => {
      const [log, snap] = await Promise.all([this.readLog(), this.readSnapshot()]);
      return computeState(log, snap, lib, maxFloor);
    }, 'E_LIB_READ');
  }

  writeSnapshot(): Promise<void> {
    return this.serial(() => libIO(async () => {
      const [log, snap] = await Promise.all([this.readLog(), this.readSnapshot()]);
      const state: Snapshot['state'] = {};
      for (const kind of LIB_KINDS) state[kind] = computeState(log, snap, kind);
      const next: Snapshot = { seq: this.lastSeq, state };
      await writeFileAtomic(join(this.dir, SNAPSHOT), JSON.stringify(next));
      await this.writeMeta({ ...this.meta, snapshotSeq: next.seq });
    }, 'E_LIB_SNAPSHOT'));
  }

  renameLibrary(name: string): Promise<void> {
    return this.serial(() => libIO(() => this.writeMeta({ ...this.meta, displayName: name }), 'E_LIB_META'));
  }
}

function assertLibId(libId: string): void {
  if (!UUID_RE.test(libId)) throw new EngramError('E_LIB_ID', `非法库 id：${libId}`);
}

export async function createLibrary(rootDir: string, displayName: string): Promise<LibraryHandle> {
  return libIO(async () => {
    const id = uuidv4();
    const dir = join(rootDir, id);
    await mkdir(dir, { recursive: true });
    const meta: LibraryMeta = { id, displayName, version: 1, createdAt: new Date().toISOString(), snapshotSeq: 0 };
    await writeFileAtomic(join(dir, META), JSON.stringify(meta, null, 2));
    return new Library(dir, meta, 0, false);
  }, 'E_LIB_CREATE');
}

export async function openLibrary(rootDir: string, libId: string): Promise<LibraryHandle> {
  assertLibId(libId);
  return libIO(async () => {
    const dir = join(rootDir, libId);
    const meta = parseMeta(await readFile(join(dir, META), 'utf8'));
    const logText = await readTextOrNull(join(dir, LOG));
    const snap = parseSnapshot(await readTextOrNull(join(dir, SNAPSHOT)));
    // 不用 Math.max(...数组) 展开传参：日志永久增长，条数超引擎参数上限（约十万）会抛 RangeError 导致库打不开
    const lastSeq = parseLog(logText).reduce((m, d) => Math.max(m, d.seq), Math.max(0, meta.snapshotSeq, snap?.seq ?? 0));
    const needsNewline = !!logText && !logText.endsWith('\n');
    return new Library(dir, meta, lastSeq, needsNewline);
  }, 'E_LIB_OPEN');
}

export async function listLibraries(rootDir: string): Promise<Array<{ id: string; displayName: string }>> {
  return libIO(async () => {
    let names: string[];
    try { names = await readdir(rootDir); }
    catch (e) { if (isENOENT(e)) return []; throw e; }
    const out: Array<{ id: string; displayName: string }> = [];
    for (const name of names.filter((n) => UUID_RE.test(n)).sort()) {
      try {
        const meta = parseMeta(await readFile(join(rootDir, name, META), 'utf8'));
        out.push({ id: name, displayName: meta.displayName });
      } catch { /* 坏库目录跳过，不连坐 */ }
    }
    return out;
  }, 'E_LIB_LIST');
}
