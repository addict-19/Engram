// core barrel：M1 地基全部公开接口的统一出口（打包入口 → dist/core.js）
export { uuidv4 } from './uuid.js';
export { EngramError, wrapIO } from './errors.js';
export { writeFileAtomic } from './atomicWrite.js';
export type { LibKind, Delta, Entity } from './delta.js';
export { applyDeltas, rollbackView, serializeDelta, parseDeltaLine } from './delta.js';
export type { LibraryMeta, LibraryHandle } from './library.js';
export { LIB_KINDS, createLibrary, openLibrary, listLibraries } from './library.js';
export type { VectorFingerprint } from './vectorStore.js';
export { VectorStore, fnv1a32 } from './vectorStore.js';
export { normalize, topK } from './cosine.js';
export type { Tokenizer, BM25Options } from './bm25.js';
export { BM25Index, bigramTokenizer } from './bm25.js';
