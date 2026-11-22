import { checkData, checkDataFlags, dataCgImages, dataTranslatables, scriptLabels, type DataDeclaration, type DataText, type DeclaredData, type Diagnostic } from "@liminalia/lang";
import type { CommandPlugin, PluginCheckProject } from "./plugin.ts";

/** データの形の宣言を短く書く部品（d）は @liminalia/sdk にある。ここはエンジンの側の検査。 */
export { d } from "@liminalia/sdk";

export function dataDeclarations(plugins: readonly CommandPlugin[]): DataDeclaration[] {
  const byFile = new Map<string, DataDeclaration>();
  for (const p of plugins) for (const decl of p.data ?? []) byFile.set(decl.file, decl);
  return [...byFile.values()];
}

/** 宣言のあるデータのうち、作品にあるもの。 */
export function declaredData(plugins: readonly CommandPlugin[], read: (name: string) => unknown, text?: (name: string) => string | undefined): DeclaredData[] {
  const out: DeclaredData[] = [];
  for (const decl of dataDeclarations(plugins)) {
    const value = read(decl.file);
    if (value === undefined) continue;
    const t = text?.(decl.file);
    out.push({ decl, value, ...(t !== undefined ? { text: t } : {}) });
  }
  return out;
}

/** 作品のデータの訳す文（宣言で translate の印の付いた欄。lim i18n と制作画面の訳の画面が updateTranslation の data に渡す）。 */
export function projectDataTexts(plugins: readonly CommandPlugin[], read: (name: string) => unknown): DataText[] {
  return dataTranslatables(declaredData(plugins, read));
}

/** プラグインが作品のデータから CG として解放する画像（`フォルダ/パス`）。checkExtra に渡す。 */
export function pluginDataCg(plugins: readonly CommandPlugin[], read: (name: string) => unknown): Set<string> {
  return dataCgImages(declaredData(plugins, read));
}

/** データの形の検査とフラグの突き合わせ（runPluginChecks が呼ぶ）。 */
export function checkDeclaredData(plugins: readonly CommandPlugin[], project: PluginCheckProject): Diagnostic[] {
  const data = declaredData(plugins, (name) => project.data(name), project.dataText ? (name) => project.dataText!(name) : undefined);
  if (data.length === 0) return [];
  const folder = project.dataFolder ?? "data";
  const fileName = (decl: DataDeclaration) => `${folder}/${decl.file}`;
  const labels = scriptLabels(project.scripts);
  const cast = new Set(Object.keys(project.cast));
  const owner = new Map<string, string>();
  for (const p of plugins) for (const decl of p.data ?? []) owner.set(decl.file, p.name);
  const out: Diagnostic[] = [];
  for (const x of data) {
    const plugin = owner.get(x.decl.file);
    for (const diag of checkData(x.decl, x.value, { fileName: fileName(x.decl), ...(x.text !== undefined ? { text: x.text } : {}), labels, assetExists: project.assetExists, cast })) out.push({ ...diag, ...(plugin ? { plugin } : {}) });
  }
  const variables = (project.config.variables ?? undefined) as Record<string, unknown> | undefined;
  out.push(...checkDataFlags(data, project.scripts, project.registry, { fileName, ...(variables ? { variables } : {}) }));
  return out;
}
