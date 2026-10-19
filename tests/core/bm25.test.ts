// tests/core/bm25.test.ts
import { describe, it, expect } from 'vitest';
import { BM25Index, bigramTokenizer } from '../../src/core/bm25.js';
import { EngramError } from '../../src/core/errors.js';

describe('bigramTokenizer', () => {
  it('中文出二元组，英文出小写单词', () => {
    expect(bigramTokenizer('戒指丢了')).toEqual(['戒指', '指丢', '丢了']);
    expect(bigramTokenizer('The Ring')).toEqual(['the', 'ring']);
  });
  it('中英混排：中文段二元组、英文/数字段小写整词，标点空白只作分隔', () => {
    expect(bigramTokenizer('他买了iPhone15，送给她。')).toEqual([
      '他买', '买了', 'iphone15', '送给', '给她',
    ]);
    expect(bigramTokenizer('2024年的Ring')).toEqual(['2024', '年的', 'ring']);
  });
  it('孤立单个汉字原样出单字', () => {
    expect(bigramTokenizer('他，她')).toEqual(['他', '她']);
    expect(bigramTokenizer('A 猫 b')).toEqual(['a', '猫', 'b']);
  });
  it('空串/纯标点出空数组', () => {
    expect(bigramTokenizer('')).toEqual([]);
    expect(bigramTokenizer('，。！ ?')).toEqual([]);
  });
});

describe('BM25Index', () => {
  it('相关文档排在前', () => {
    const idx = new BM25Index(bigramTokenizer);
    idx.add('s1', '他把戒指交给了她，作为生日礼物');
    idx.add('s2', '食堂的汉堡不好吃，大家在抱怨午饭');
    const r = idx.search('戒指 礼物', 2);
    expect(r[0]!.id).toBe('s1');
    expect(r[0]!.score).toBeGreaterThan(r[1]?.score ?? 0);
  });
  it('anchor 整词命中（生造词不被分词拆碎）', () => {
    const idx = new BM25Index(bigramTokenizer);
    idx.add('s1', '那件事之后他们再没提过');
    idx.addAnchor('s1', 'the mouth thing');
    idx.add('s2', '普通的一天');
    const r = idx.search('the mouth thing', 1);
    expect(r[0]!.id).toBe('s1');
  });
  it('toJSON/fromJSON round-trip 检索结果一致', () => {
    const a = new BM25Index(bigramTokenizer);
    a.add('s1', '戒指');
    const b = BM25Index.fromJSON(a.toJSON(), bigramTokenizer);
    expect(b.search('戒指', 1)[0]!.id).toBe('s1');
  });
  it('remove 后不再命中', () => {
    const idx = new BM25Index(bigramTokenizer);
    idx.add('s1', '戒指');
    idx.remove('s1');
    expect(idx.search('戒指', 5)).toHaveLength(0);
  });

  // ---- 以下为边角行为钉子 ----

  it('零分文档不返回；k<=0 返回空', () => {
    const idx = new BM25Index(bigramTokenizer);
    idx.add('s1', '戒指');
    idx.add('s2', '汉堡');
    expect(idx.search('戒指', 5).map((r) => r.id)).toEqual(['s1']);
    expect(idx.search('戒指', 0)).toEqual([]);
  });

  it('结果按分数降序且截断到 k', () => {
    const idx = new BM25Index(bigramTokenizer);
    idx.add('a', '戒指 戒指 戒指');
    idx.add('b', '戒指 和很多很多别的无关的内容混在一起');
    idx.add('c', '戒指 一些');
    idx.add('d', '无关');
    const r = idx.search('戒指', 2);
    expect(r).toHaveLength(2);
    expect(r[0]!.score).toBeGreaterThanOrEqual(r[1]!.score);
    expect(r[0]!.id).toBe('a');
  });

  it('add 重复 id 为更新语义：旧文本不再命中，锚点保留', () => {
    const idx = new BM25Index(bigramTokenizer);
    idx.add('s1', '戒指');
    idx.addAnchor('s1', 'the mouth thing');
    idx.add('s1', '汉堡');
    expect(idx.search('戒指', 5)).toHaveLength(0);
    expect(idx.search('汉堡', 5)[0]!.id).toBe('s1');
    expect(idx.search('the mouth thing', 5)[0]!.id).toBe('s1');
    expect(idx.size).toBe(1);
  });

  it('remove 同时清掉锚点；remove 不存在的 id 静默', () => {
    const idx = new BM25Index(bigramTokenizer);
    idx.add('s1', '戒指');
    idx.addAnchor('s1', 'the mouth thing');
    idx.remove('s1');
    idx.remove('nope');
    expect(idx.search('the mouth thing', 5)).toHaveLength(0);
    expect(idx.size).toBe(0);
  });

  it('锚点大小写/空白不敏感，英文锚点要求词边界', () => {
    const idx = new BM25Index(bigramTokenizer);
    idx.add('s1', '那件事');
    idx.addAnchor('s1', '  The   Mouth  Thing ');
    idx.addAnchor('s1', 'ring');
    idx.add('s2', '别的');
    expect(idx.search('remember THE MOUTH thing?', 1)[0]!.id).toBe('s1');
    // "bring" 里的 ring 不算命中英文锚点
    expect(idx.search('bring', 5)).toHaveLength(0);
  });

  it('中文锚点按子串命中（中文无词边界），且不被二元组拆碎', () => {
    const idx = new BM25Index(bigramTokenizer);
    idx.add('s1', '那天在屋顶');
    idx.addAnchor('s1', '嘴巴那件事');
    idx.add('s2', '嘴巴很干，那件衣服不错');
    const r = idx.search('还记得嘴巴那件事吗', 2);
    expect(r[0]!.id).toBe('s1');
  });

  it('锚点可先于 add 挂上，空锚点忽略', () => {
    const idx = new BM25Index(bigramTokenizer);
    idx.addAnchor('s1', 'snowfall pact');
    idx.addAnchor('s1', '   ');
    expect(idx.search('the snowfall pact', 1)[0]!.id).toBe('s1');
    idx.add('s1', '约定');
    expect(idx.search('约定', 1)[0]!.id).toBe('s1');
  });

  it('round-trip 后分数完全一致，含锚点与自定义参数', () => {
    const a = new BM25Index(bigramTokenizer, { k1: 1.5, b: 0.5 });
    a.add('s1', '他把戒指交给了她，作为生日礼物');
    a.add('s2', '食堂的汉堡不好吃');
    a.addAnchor('s2', 'burger incident');
    const json = JSON.parse(JSON.stringify(a.toJSON()));
    const b = BM25Index.fromJSON(json, bigramTokenizer);
    for (const q of ['戒指 礼物', '汉堡', 'the burger incident']) {
      expect(b.search(q, 5)).toEqual(a.search(q, 5));
    }
  });

  it('fromJSON 遇格式错误抛 E_BM25_FORMAT', () => {
    expect(() => BM25Index.fromJSON(null, bigramTokenizer)).toThrow(EngramError);
    try {
      BM25Index.fromJSON({ v: 99 }, bigramTokenizer);
      expect.unreachable();
    } catch (e) {
      expect((e as EngramError).code).toBe('E_BM25_FORMAT');
    }
  });

  it('tokenizer 可插拔', () => {
    const ws = (t: string) => t.split(/\s+/).filter(Boolean);
    const idx = new BM25Index(ws);
    idx.add('x', 'alpha beta');
    idx.add('y', 'gamma');
    expect(idx.search('beta', 5).map((r) => r.id)).toEqual(['x']);
  });
});
