// src/core/errors.ts
export class EngramError extends Error {
  constructor(public code: string, message: string, public cause?: unknown) {
    super(message);
    this.name = 'EngramError';
  }
}
export async function wrapIO<T>(fn: () => Promise<T>, code: string): Promise<T> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof EngramError) throw e;
    throw new EngramError(code, e instanceof Error ? e.message : String(e), e);
  }
}
