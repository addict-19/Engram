// tests/core/errors.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wrapIO, moduleIO, EngramError } from '../../src/core/errors.js';
import { VectorStore } from '../../src/core/vectorStore.js';
import { topK } from '../../src/core/cosine.js';
import { createLibrary, openLibrary } from '../../src/core/library.js';

const PREFIX_RE = /^E_[A-Z_]+:/;

describe('wrapIO', () => {
  it('已是 EngramError 时同对象 rethrow，code 保留', async () => {
    const orig = new EngramError('E_OTHER', 'x');
    const err = await wrapIO(async () => { throw orig; }, 'E_TEST').catch((e: unknown) => e);
    expect(err).toBe(orig);
    expect((err as EngramError).code).toBe('E_OTHER');
  });
  it('普通错误转码，message 原样、cause 保留', async () => {
    const raw = new Error('boom');
    const err = await wrapIO(async () => { throw raw; }, 'E_TEST').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'E_TEST', message: 'boom' });
    expect((err as EngramError).cause).toBe(raw);
  });
});

describe('moduleIO', () => {
  it('本模块前缀的 EngramError 同对象透传', async () => {
    const orig = new EngramError('E_LIB_DELTA', 'x');
    const err = await moduleIO(async () => { throw orig; }, 'E_LIB_APPEND', 'E_LIB_').catch((e: unknown) => e);
    expect(err).toBe(orig);
  });
  it('其他模块的 EngramError 转为本模块错误码，原错误留在 cause', async () => {
    const orig = new EngramError('E_ATOMIC_WRITE', 'disk full');
    const err = await moduleIO(async () => { throw orig; }, 'E_VEC_SAVE', 'E_VEC_').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngramError);
    expect(err).toMatchObject({ code: 'E_VEC_SAVE', message: 'disk full' });
    expect((err as EngramError).cause).toBe(orig);
  });
  it('非 Error 抛出值也转码', async () => {
    const err = await moduleIO(async () => { throw 'str'; }, 'E_VEC_LOAD', 'E_VEC_').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'E_VEC_LOAD', message: 'str', cause: 'str' });
  });
  it('成功时返回值原样', async () => {
    expect(await moduleIO(async () => 42, 'E_LIB_READ', 'E_LIB_')).toBe(42);
  });
});

// 一致性：错误码只活在 .code，message 一律不带 "CODE: " 前缀
describe('错误 message 不含错误码前缀（跨模块抽样）', () => {
  const fp = { model: 'm', dim: 4, quant: 'f32' as const };
  const catchErr = async (fn: () => unknown) => {
    try { await fn(); } catch (e) { return e as EngramError; }
    throw new Error('expected throw');
  };

  it('vectorStore / cosine / library 抛错样本', async () => {
    const samples: EngramError[] = [];
    // vectorStore：维度、指纹、损坏、IO
    samples.push(await catchErr(() => new VectorStore(fp).add('x', new Float32Array(2))));
    samples.push(await catchErr(() => new VectorStore({ model: '', dim: 0, quant: 'f32' })));
    const dir = await mkdtemp(join(tmpdir(), 'engram-'));
    const s = new VectorStore(fp);
    s.add('a', new Float32Array([1, 0, 0, 0]));
    await s.save(dir);
    samples.push(await catchErr(() => VectorStore.load(dir, { ...fp, model: 'other' })));
    await writeFile(join(dir, 'vectors.bin'), Buffer.alloc(7));
    samples.push(await catchErr(() => VectorStore.load(dir)));
    samples.push(await catchErr(() => VectorStore.load(join(tmpdir(), 'engram-nope-' + Date.now()))));
    // cosine
    samples.push(await catchErr(() => topK(new Float32Array(3), [['a', new Float32Array(2)]], 1)));
    // library：非法 id、非法 delta、IO
    const root = await mkdtemp(join(tmpdir(), 'engram-'));
    samples.push(await catchErr(() => openLibrary(root, '../etc')));
    const lib = await createLibrary(root, 't');
    samples.push(await catchErr(() => lib.appendDelta({ floor: 1, lib: 'nope', op: 'create', id: 'a', payload: {} } as never)));
    samples.push(await catchErr(() => openLibrary(root, '00000000-0000-4000-8000-000000000000')));

    expect(samples.length).toBe(9);
    for (const e of samples) {
      expect(e).toBeInstanceOf(EngramError);
      expect(e.code).toMatch(/^E_[A-Z_]+$/);
      expect(e.message).not.toMatch(PREFIX_RE);
    }
  });

  it('index.json 结构非法时 message 同样无前缀', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'engram-'));
    const s = new VectorStore(fp);
    await s.save(dir);
    const idx = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'));
    delete idx.ids;
    await writeFile(join(dir, 'index.json'), JSON.stringify(idx));
    const e = await catchErr(() => VectorStore.load(dir));
    expect(e.code).toBe('E_VEC_CORRUPT');
    expect(e.message).not.toMatch(PREFIX_RE);
  });
});
