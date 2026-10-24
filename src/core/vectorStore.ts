// src/core/vectorStore.ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EngramError, moduleIO } from './errors.js';
import { writeFileAtomic } from './atomicWrite.js';

// 向量指纹：模型/维度/量化一起决定"能不能放在一起算距离"
export interface VectorFingerprint { model: string; dim: number; quant: 'f32' }

const INDEX = 'index.json';
const BIN = 'vectors.bin';

const sameFingerprint = (a: VectorFingerprint, b: VectorFingerprint) =>
  a.model === b.model && a.dim === b.dim && a.quant === b.quant;

function isFingerprint(x: unknown): x is VectorFingerprint {
  if (!x || typeof x !== 'object') return false;
  const f = x as Record<string, unknown>;
  return typeof f.model === 'string' && Number.isInteger(f.dim) && (f.dim as number) > 0 && f.quant === 'f32';
}

// FNV-1a 32 位：给 vectors.bin 上完整性锁，防"新 bin 配旧 index"错位或字节损坏
export function fnv1a32(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const vecErr = (code: string, msg: string, cause?: unknown) => new EngramError(code, msg, cause);

// 底层错误（含 writeFileAtomic 的 E_ATOMIC_WRITE）统一翻成 E_VEC_*，原错误留在 cause
const vecIO = <T>(fn: () => Promise<T>, code: string) => moduleIO(fn, code, 'E_VEC_');

export class VectorStore {
  private readonly vecs = new Map<string, Float32Array>();

  constructor(public readonly fingerprint: VectorFingerprint) {
    if (!isFingerprint(fingerprint)) throw vecErr('E_VEC_FINGERPRINT', '非法向量指纹');
  }

  // 同 id 再 add 视为覆盖；入库时拷贝一份，外部改原数组不影响库内
  add(id: string, vec: Float32Array): void {
    if (vec.length !== this.fingerprint.dim) {
      throw vecErr('E_VEC_DIM', `向量维度 ${vec.length} 与指纹 ${this.fingerprint.dim} 不符：${id}`);
    }
    this.vecs.set(id, Float32Array.from(vec));
  }

  remove(id: string): void { this.vecs.delete(id); }

  has(id: string): boolean { return this.vecs.has(id); }

  get ids(): string[] { return [...this.vecs.keys()]; }

  // 返回库内数组本体（检索热路径不拷贝），调用方只读不写
  entries(): Iterable<[string, Float32Array]> { return this.vecs.entries(); }

  // 先写 vectors.bin 再写 index.json，各自 tmp+rename；index 记下 bin 的字节数与 hash，load 时双校验兜底跨文件不一致
  async save(dir: string): Promise<void> {
    const { dim } = this.fingerprint;
    const ids = this.ids;
    const buf = Buffer.alloc(ids.length * dim * 4);
    ids.forEach((id, i) => {
      const vec = this.vecs.get(id)!;
      for (let k = 0; k < dim; k++) buf.writeFloatLE(vec[k]!, (i * dim + k) * 4);
    });
    await vecIO(async () => {
      await mkdir(dir, { recursive: true });
      const bin = join(dir, BIN);
      // writeFileAtomic 只收 string，二进制在这里按同一套 tmp+rename 策略写
      const tmp = `${bin}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(tmp, buf);
      await rename(tmp, bin);
      await writeFileAtomic(join(dir, INDEX), JSON.stringify({ fingerprint: this.fingerprint, ids, binBytes: buf.length, binHash: fnv1a32(buf) }));
    }, 'E_VEC_SAVE');
  }

  // 传了 expected 且与文件指纹不符 → E_VEC_FINGERPRINT（防新旧模型向量混算）；不传则按文件自述载入
  static async load(dir: string, expected?: VectorFingerprint): Promise<VectorStore> {
    return vecIO(async () => {
      const idx: unknown = JSON.parse(await readFile(join(dir, INDEX), 'utf8'));
      const { fingerprint, ids, binBytes, binHash } =
        (idx ?? {}) as { fingerprint?: unknown; ids?: unknown; binBytes?: unknown; binHash?: unknown };
      if (!isFingerprint(fingerprint) || !Array.isArray(ids) || !ids.every((x) => typeof x === 'string')
        || !Number.isInteger(binBytes) || !Number.isInteger(binHash)) {
        throw vecErr('E_VEC_CORRUPT', `${INDEX} 结构非法`);
      }
      if (expected && !sameFingerprint(fingerprint, expected)) {
        throw vecErr('E_VEC_FINGERPRINT',
          `向量指纹不符：文件 ${JSON.stringify(fingerprint)}，期望 ${JSON.stringify(expected)}`);
      }
      const buf = await readFile(join(dir, BIN));
      if (buf.length !== binBytes) {
        throw vecErr('E_VEC_CORRUPT', `${BIN} 字节数 ${buf.length} 与 ${INDEX} 记录的 ${binBytes} 不符`);
      }
      if (fnv1a32(buf) !== binHash) throw vecErr('E_VEC_CORRUPT', `${BIN} hash 与 ${INDEX} 记录不符`);
      const { dim } = fingerprint;
      if (buf.length !== ids.length * dim * 4) {
        throw vecErr('E_VEC_CORRUPT', `${BIN} 长度 ${buf.length} 与 ${ids.length}×${dim}×4 不符`);
      }
      if (new Set(ids).size !== ids.length) throw vecErr('E_VEC_CORRUPT', `${INDEX} 含重复 id`);
      const store = new VectorStore({ model: fingerprint.model, dim, quant: fingerprint.quant });
      ids.forEach((id, i) => {
        const vec = new Float32Array(dim);
        for (let k = 0; k < dim; k++) vec[k] = buf.readFloatLE((i * dim + k) * 4);
        store.vecs.set(id, vec);
      });
      return store;
    }, 'E_VEC_LOAD');
  }
}
