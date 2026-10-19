// src/core/atomicWrite.ts
import { writeFile, rename } from 'node:fs/promises';
import { wrapIO } from './errors.js';

// 临时文件+rename：进程崩在半路也不会留下截断的正式文件
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  return wrapIO(async () => {
    const tmp = `${path}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, data, 'utf8');
    await rename(tmp, path);
  }, 'E_ATOMIC_WRITE');
}
