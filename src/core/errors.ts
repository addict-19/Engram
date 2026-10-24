// src/core/errors.ts
// 约定：错误码只活在 .code 字段，message 一律不带 "CODE: " 前缀
export class EngramError extends Error {
  constructor(public code: string, message: string, public cause?: unknown) {
    super(message);
    this.name = 'EngramError';
  }
}

const toMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

// 已是 EngramError 时同对象 rethrow（code 保留）；其他错误包成 code，原错误留在 cause
export async function wrapIO<T>(fn: () => Promise<T>, code: string): Promise<T> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof EngramError) throw e;
    throw new EngramError(code, toMessage(e), e);
  }
}

// 模块边界的 IO 包装：本模块（code 以 modulePrefix 开头）的 EngramError 同对象透传，
// 其余一切（含别模块的 EngramError，如 writeFileAtomic 的 E_ATOMIC_WRITE）统一翻成 code，原错误留在 cause
export async function moduleIO<T>(fn: () => Promise<T>, code: string, modulePrefix: string): Promise<T> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof EngramError && e.code.startsWith(modulePrefix)) throw e;
    throw new EngramError(code, toMessage(e), e);
  }
}
