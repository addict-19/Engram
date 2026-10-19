// tests/core/vectorStore.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VectorStore, fnv1a32 } from '../../src/core/vectorStore.js';

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
    expect(idx).toMatchObject({ fingerprint: fp, ids: ['a', 'b'], binBytes: 32 });
    expect(typeof idx.binHash).toBe('number');
  });
  it('vectors.bin 长度不变但字节被篡改时拒载（hash 校验）', async () => {
    const s = new VectorStore(fp);
    s.add('a', v(1, 0, 0, 0));
    s.add('b', v(0, 1, 0, 0));
    const dir = await mkdtemp(join(tmpdir(), 'engram-'));
    await s.save(dir);
    const buf = await readFile(join(dir, 'vectors.bin'));
    buf[5] = buf[5]! ^ 0xff;
    await writeFile(join(dir, 'vectors.bin'), buf);
    await expect(VectorStore.load(dir)).rejects.toThrowError(/E_VEC_CORRUPT/);
  });
  it('新 bin 配旧 index 且条数相同时拒载（防错位）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'engram-'));
    const s1 = new VectorStore(fp);
    s1.add('a', v(1, 0, 0, 0));
    await s1.save(dir);
    const oldIdx = await readFile(join(dir, 'index.json'), 'utf8');
    const s2 = new VectorStore(fp);
    s2.add('z', v(0, 0, 0, 1));
    await s2.save(dir);
    await writeFile(join(dir, 'index.json'), oldIdx);
    await expect(VectorStore.load(dir)).rejects.toThrowError(/E_VEC_CORRUPT/);
  });
  it('vectors.bin 被截断或加长时拒载', async () => {
    const s = new VectorStore(fp);
    s.add('a', v(1, 0, 0, 0));
    const dir = await mkdtemp(join(tmpdir(), 'engram-'));
    await s.save(dir);
    const buf = await readFile(join(dir, 'vectors.bin'));
    await writeFile(join(dir, 'vectors.bin'), buf.subarray(0, 12));
    await expect(VectorStore.load(dir)).rejects.toThrowError(/E_VEC_CORRUPT/);
    await writeFile(join(dir, 'vectors.bin'), Buffer.concat([buf, Buffer.alloc(4)]));
    await expect(VectorStore.load(dir)).rejects.toThrowError(/E_VEC_CORRUPT/);
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

describe('fnv1a32 已知向量（落盘格式护栏，换算法即红）', () => {
  it('空输入 = 0x811c9dc5', () => expect(fnv1a32(new Uint8Array())).toBe(0x811c9dc5));
  it('单字节 "a" = 0xe40c292c', () => expect(fnv1a32(new TextEncoder().encode('a'))).toBe(0xe40c292c));
});
