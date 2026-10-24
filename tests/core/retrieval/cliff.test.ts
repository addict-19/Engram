import { describe, it, expect } from 'vitest';
import { detectCliff, passFloor } from '../../../src/core/retrieval/cliff.js';

describe('detectCliff', () => {
  it('top1 独高 → 1', () => {
    expect(detectCliff([0.9, 0.4, 0.38, 0.35])).toBe(1);
  });

  it('前三成团后断档 → 3', () => {
    expect(detectCliff([0.85, 0.82, 0.8, 0.5, 0.48])).toBe(3);
  });

  it('前二成团后断档 → 2', () => {
    expect(detectCliff([0.8, 0.78, 0.4, 0.38])).toBe(2);
  });

  it('挤成一团 → 0', () => {
    expect(detectCliff([0.8, 0.75, 0.7, 0.65, 0.6])).toBe(0);
  });

  it('断档在 maxLead 之外 → 0（名额保险）', () => {
    expect(detectCliff([0.8, 0.78, 0.76, 0.74, 0.3])).toBe(0);
    // 放宽 maxLead 后能看到第 4 名后的断档
    expect(detectCliff([0.8, 0.78, 0.76, 0.74, 0.3], { maxLead: 4 })).toBe(4);
  });

  it('多处落差取最大的那处', () => {
    // 间隔1 比值 1.6，间隔3 比值 2.5 → 取 3
    expect(detectCliff([0.8, 0.5, 0.48, 0.192, 0.19])).toBe(3);
  });

  it('单元素 → 1；空数组 → 0', () => {
    expect(detectCliff([0.42])).toBe(1);
    expect(detectCliff([])).toBe(0);
  });

  it('全 0 数组 → 0', () => {
    expect(detectCliff([0, 0, 0])).toBe(0);
    expect(detectCliff([0])).toBe(0);
  });

  it('ratio 单独触发（未传 margin 只按 ratio 判）', () => {
    expect(detectCliff([0.3, 0.1])).toBe(1);
    expect(detectCliff([0.3, 0.25])).toBe(0);
    // 自定义 ratio
    expect(detectCliff([0.3, 0.25], { ratio: 1.1 })).toBe(1);
  });

  it('margin 单独触发（ratio 不够、差值够）', () => {
    // 0.9/0.7≈1.29 < 1.5，但差 0.2 ≥ margin 0.15
    expect(detectCliff([0.9, 0.7, 0.68])).toBe(0);
    expect(detectCliff([0.9, 0.7, 0.68], { margin: 0.15 })).toBe(1);
    expect(detectCliff([0.9, 0.7, 0.68], { margin: 0.25 })).toBe(0);
  });

  it('后项为 0 或负数不除零：正分对零/负分视为 ratio 满足', () => {
    expect(detectCliff([0.5, 0, 0])).toBe(1);
    expect(detectCliff([0.5, -0.1])).toBe(1);
    expect(detectCliff([0.5, 0.45, 0])).toBe(2);
  });

  it('minScore：断点前各条须 ≥ minScore', () => {
    expect(detectCliff([0.85, 0.82, 0.8, 0.5], { minScore: 0.8 })).toBe(3);
    expect(detectCliff([0.85, 0.82, 0.8, 0.5], { minScore: 0.81 })).toBe(0);
    expect(detectCliff([0.42], { minScore: 0.5 })).toBe(0);
  });

  it('不修改入参', () => {
    const arr = [0.9, 0.4, 0.3];
    detectCliff(arr, { margin: 0.1 });
    expect(arr).toEqual([0.9, 0.4, 0.3]);
  });
});

describe('passFloor', () => {
  it('score >= floor', () => {
    expect(passFloor(0.5, 0.5)).toBe(true);
    expect(passFloor(0.51, 0.5)).toBe(true);
    expect(passFloor(0.49, 0.5)).toBe(false);
  });
});
