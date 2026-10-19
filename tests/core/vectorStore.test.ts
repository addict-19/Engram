// tests/core/vectorStore.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VectorStore } from '../../src/core/vectorStore.js';

const fp = { model: 'bge-small-zh-q8', dim: 4, quant: 'f32' as const };
const v = (...n: number[]) => new Float32Array(n);

describe('VectorStore', () => {
  it('add/remove/save/load round-trip，浮点精确保留', async () => {
    const s = new VectorStore(fp);
    s.add('a', v(1, 0, 0, 0));
    s.add('b', v(0.5, 0.5, 0, 0));
    s.remove('a');
    const dir = await mkdtemp(join(tmpdir(), 'engram-'));
    await s.save(dir);
    const r = await VectorStore.load(dir);
    expect(r.ids).toEqual(['b']);
    expect([...r.entries()][0]![1]).toEqual(v(0.5, 0.5, 0, 0));
  });
  it('维度不符拒收', () => {
    const s = new VectorStore(fp);
    expect(() => s.add('x', v(1, 2))).toThrowError(/E_VEC_DIM/);
  });
  it('指纹不符拒载（防混算）', async () => {
    const s = new VectorStore(fp);
    s.add('a', v(1, 0, 0, 0));
    const dir = await mkdtemp(join(tmpdir(), 'engram-'));
    await s.save(dir);
    const idx = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'));
    idx.fingerprint.model = 'other-model';
    await writeFile(join(dir, 'index.json'), JSON.stringify(idx));
    await expect(VectorStore.load(dir, fp)).rejects.toThrowError(/E_VEC_FINGERPRINT/);
    // 不传期望指纹：按文件自述载入
    const r = await VectorStore.load(dir);
    expect(r.fingerprint.model).toBe('other-model');
    expect(r.has('a')).toBe(true);
  });
  it('vectors.bin 按小端 Float32 平铺，目录无临时文件残留', async () => {
    const s = new VectorStore(fp);
    s.add('a', v(1, 2, 3, 4));
    s.add('b', v(-0.25, 0, 0, 1e-7));
    const dir = await mkdtemp(join(tmpdir(), 'engram-'));
    await s.save(dir);
    expect((await readdir(dir)).sort()).toEqual(['index.json', 'vectors.bin']);
    const buf = await readFile(join(dir, 'vectors.bin'));
    expect(buf.length).toBe(2 * 4 * 4);
    expect(buf.readFloatLE(0)).toBe(1);
    expect(buf.readFloatLE(16)).toBe(-0.25);
    const idx = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'));
    expect(idx).toEqual({ fingerprint: fp, ids: ['a', 'b'] });
  });
  it('add 拷贝向量，外部改动不污染库内数据', () => {
    const s = new VectorStore(fp);
    const x = v(1, 0, 0, 0);
    s.add('a', x);
    x[0] = 9;
    expect([...s.entries()][0]![1][0]).toBe(1);
  });
  it('vectors.bin 长度与 ids×dim 不符时拒载', async () => {
    const s = new VectorStore(fp);
    s.add('a', v(1, 0, 0, 0));
    const dir = await mkdtemp(join(tmpdir(), 'engram-'));
    await s.save(dir);
    await writeFile(join(dir, 'vectors.bin'), Buffer.alloc(7));
    await expect(VectorStore.load(dir)).rejects.toThrowError(/E_VEC_CORRUPT/);
  });
  it('目录不存在时 IO 错误带 E_VEC_ 前缀', async () => {
    await expect(VectorStore.load(join(tmpdir(), 'engram-nope-' + Date.now()))).rejects
      .toMatchObject({ code: expect.stringMatching(/^E_VEC_/) });
  });
});
