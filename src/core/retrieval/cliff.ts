// src/core/retrieval/cliff.ts
// 断崖检测：通用"相对领先"判定器，无业务语义（切片精准档与高层桶两档共用）。
// 纯函数：零 IO、不修改入参。

export interface CliffOpts {
  ratio?: number;    // 前项/后项倍数阈值，默认 1.5
  margin?: number;   // 前项-后项差值阈值，默认不启用（只按 ratio 判）
  maxLead?: number;  // 断档位置上限（名额保险），默认 3
  minScore?: number; // 绝对分备用线，默认不启用；启用时断点前各条须 ≥ minScore
}

// 单个间隔的"触发强度"：ratio 与 margin 各自归一化到阈值（≥1 即触发），取较强者。
// 后项 ≤0 而前项 >0 视为无穷倍领先（除零保护）；前项 ≤0 时 ratio 不成立。
function gapStrength(a: number, b: number, ratio: number, margin: number | undefined): number {
  let rs: number;
  if (a <= 0) rs = 0;
  else if (b <= 0) rs = Infinity;
  else rs = a / b / ratio;
  const ms = margin !== undefined && margin > 0 ? (a - b) / margin : 0;
  return Math.max(rs, ms);
}

// 前置条件：sorted 为降序分数。
// 在前 min(maxLead, n-1) 个相邻间隔中找触发强度最大的位置（并列取靠前者），
// 该处满足 ratio 或 margin 任一 → 返回断档位置 k（前 k 条领先，1 ≤ k ≤ maxLead）；否则 0。
// 单元素且分数 >0 视为单条领先返回 1；空数组 / 全 0 返回 0。
export function detectCliff(sorted: number[], opts?: CliffOpts): number {
  const ratio = opts?.ratio ?? 1.5;
  const maxLead = opts?.maxLead ?? 3;
  const margin = opts?.margin;
  const minScore = opts?.minScore;
  const n = sorted.length;
  if (n === 0) return 0;

  let k = 0;
  if (n === 1) {
    k = sorted[0]! > 0 && maxLead >= 1 ? 1 : 0;   // 保持 k ≤ maxLead
  } else {
    const gaps = Math.min(maxLead, n - 1);
    let best = -Infinity;
    let bestIdx = -1;
    for (let i = 0; i < gaps; i++) {
      const s = gapStrength(sorted[i]!, sorted[i + 1]!, ratio, margin);
      if (s > best) { best = s; bestIdx = i; }
    }
    if (bestIdx >= 0 && best >= 1) k = bestIdx + 1;
  }

  if (k > 0 && minScore !== undefined) {
    for (let i = 0; i < k; i++) if (sorted[i]! < minScore) return 0;
  }
  return k;
}

// 桶内最低分门槛：score >= floor 的语义化包装
export function passFloor(score: number, floor: number): boolean {
  return score >= floor;
}
