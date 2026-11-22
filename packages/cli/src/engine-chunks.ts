import type { Plugin } from "vite";

/** Rollup の ModuleInfo のうち、ここで使うもの。 */
interface ModuleInfo {
  isEntry: boolean;
  isExternal: boolean;
  importedIds: readonly string[];
  ast: unknown;
}

interface ChunkMeta {
  getModuleIds(): IterableIterator<string>;
  getModuleInfo(id: string): ModuleInfo | null;
}

/**
 * 書き出すエンジンの束の分け方。入口（index.html と、始めに await する遊ぶ側の main.ts）のほかの、入口から import でたどれるものを
 * 一つの束（engine/core-<鍵>.js と core-<鍵>.css）にまとめる。標準の命令の描画の部品（@liminalia/std の web/index.ts が import() で読むもの）は、
 * それぞれ別の束のまま残る。
 * まとめないと、Rollup は「入口が await している間に部品を読むと、部品が入口を待って止まる」のを避けるため、入口と部品が共に使うものを
 * 細かい束に分ける（数十のファイルになり、CSS も部品の数だけ分かれて並びが変わる）。入口のほかには始めに await するものが無いので、
 * 部品の束が core を読んでも止まらず、CSS は前と同じ一つのファイルに同じ並びで入る。
 */
export function engineChunks(): Plugin {
  return {
    name: "liminalia-engine-chunks",
    apply: "build",
    config: () => ({ build: { rollupOptions: { output: { manualChunks: coreChunk() } } } }),
  };
}

function coreChunk(): (id: string, meta: ChunkMeta) => string | undefined {
  let core: Set<string> | null = null;
  return (id, meta) => {
    core ??= coreModules(meta);
    return core.has(id) ? "core" : undefined;
  };
}

/** 入口から import でたどれるもの（入口と、始めに await するものを除く）。 */
function coreModules(meta: ChunkMeta): Set<string> {
  const out = new Set<string>();
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const id of meta.getModuleIds()) if (meta.getModuleInfo(id)?.isEntry) queue.push(id);
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const info = meta.getModuleInfo(id);
    if (!info || info.isExternal) continue;
    if (!info.isEntry && !hasTopLevelAwait(info.ast)) out.add(id);
    queue.push(...info.importedIds);
  }
  return out;
}

/** 関数の外に await があるか（構文木。関数とクラスのメソッドの中は見ない）。構文木が無ければ、あるものとして core に入れない。 */
export function hasTopLevelAwait(node: unknown): boolean {
  if (node === null || node === undefined) return true;
  const visit = (n: unknown): boolean => {
    if (!n || typeof n !== "object") return false;
    if (Array.isArray(n)) return n.some(visit);
    const type = (n as { type?: unknown }).type;
    if (type === "FunctionDeclaration" || type === "FunctionExpression" || type === "ArrowFunctionExpression") return false;
    if (type === "AwaitExpression") return true;
    if (type === "ForOfStatement" && (n as { await?: unknown }).await === true) return true;
    for (const [key, value] of Object.entries(n)) if (key !== "parent" && value && typeof value === "object" && visit(value)) return true;
    return false;
  };
  return visit(node);
}
