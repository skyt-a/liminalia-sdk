import { checkData, checkDataFlags, dataCgImages, dataTranslatables, scriptLabels, type DataDeclaration, type DataField, type DataText, type DeclaredData, type Diagnostic } from "@liminalia/lang";
import type { CommandPlugin, PluginCheckProject } from "./plugin.ts";

/**
 * データの形の宣言を短く書く部品。プラグインの data に並べる。
 * ```ts
 * data: [{ file: "stamps.json", title: "スタンプ帳", root: d.map(d.record({ image: d.asset("image", "画像", { cg: true }), memo: d.text("メモ") })) }]
 * ```
 */
type Label = { label?: string; labelEn?: string; doc?: string; docEn?: string; required?: boolean };
const lab = (label?: string | Label): Label => (typeof label === "string" ? { label } : (label ?? {}));

export const d = {
  /** 一行の文字。suggest は候補。translate なら遊ぶ人に見せる文で、lim i18n が訳のファイルに並べる（描画は dataText で訳を引く）。 */
  string: (label?: string | Label, o: { suggest?: readonly string[]; translate?: boolean } = {}): DataField => ({ kind: "string", ...lab(label), ...o }),
  /** 複数行の文字（本文・説明）。translate は string と同じ。 */
  text: (label?: string | Label, o: { translate?: boolean } = {}): DataField => ({ kind: "string", multiline: true, ...lab(label), ...o }),
  number: (label?: string | Label, o: { min?: number; max?: number } = {}): DataField => ({ kind: "number", ...lab(label), ...o }),
  int: (label?: string | Label, o: { min?: number; max?: number } = {}): DataField => ({ kind: "int", ...lab(label), ...o }),
  bool: (label?: string | Label): DataField => ({ kind: "bool", ...lab(label) }),
  enum: (values: readonly string[], label?: string | Label): DataField => ({ kind: "enum", values, ...lab(label) }),
  /**
   * 素材。cg なら、プラグインがこの画像を CG として解放する（どこからも出ない CG の検査がこれを数える）。
   * also は folder に無ければ探すほかのフォルダ（置き場所を替えた欄で、前の場所に置いた素材も読めるように。描画の側も同じ順に探す）。
   */
  asset: (folder: string, label?: string | Label, o: { cg?: boolean; also?: readonly string[] } = {}): DataField => ({ kind: "asset", folder, ...lab(label), ...(o.cg ? { cg: true } : {}), ...(o.also?.length ? { also: o.also } : {}) }),
  /** フラグ。use は、このデータでプラグインが立てる（set）か読む（read）か。 */
  flag: (use: "set" | "read", label?: string | Label): DataField => ({ kind: "flag", use, ...lab(label) }),
  /** 条件の式。 */
  expr: (label?: string | Label): DataField => ({ kind: "expr", ...lab(label) }),
  cast: (label?: string | Label): DataField => ({ kind: "cast", ...lab(label) }),
  /** 飛び先。base は `#ラベル` のファイルを決める、外側の記録の欄の名前。 */
  scene: (label?: string | Label, o: { base?: string; bare?: boolean } = {}): DataField => ({ kind: "scene", ...lab(label), ...o }),
  file: (label?: string | Label): DataField => ({ kind: "file", ...lab(label) }),
  /** 同じデータの中の名前（to は一覧の欄への道。`/entries`）。 */
  ref: (to: string, label?: string | Label): DataField => ({ kind: "ref", to, ...lab(label) }),
  /** 背景の上の矩形。image は背景の素材の欄の名前。 */
  rect: (label?: string | Label, o: { image?: string } = {}): DataField => ({ kind: "rect", ...lab(label), ...o }),
  /**
   * 絵の上の点（{ x, y }。既定は絵の左上からの割合 0〜100、unit が px なら舞台の px）。image は背景の素材の欄の名前（`ref の欄>素材の欄` なら ref が指す項目の欄）。
   * keys を書くと、同じ記録の二つの欄（`["x", "y"]`）に置く（制作画面は絵を出して、押した所と引きずった所に点を置く）。
   */
  point: (label?: string | Label, o: { image?: string; unit?: "percent" | "px"; keys?: readonly [string, string] } = {}): DataField => ({ kind: "point", ...lab(label), ...o }),
  list: (of: DataField, label?: string | Label, o: { sortable?: boolean; key?: string } = {}): DataField => ({ kind: "list", of, ...lab(label), ...o }),
  record: (fields: Record<string, DataField>, label?: string | Label, o: { title?: string } = {}): DataField => ({ kind: "record", fields, ...lab(label), ...o }),
  map: (of: DataField, label?: string | Label): DataField => ({ kind: "map", of, ...lab(label) }),
  json: (label?: string | Label): DataField => ({ kind: "json", ...lab(label) }),
  /** 必須にする。 */
  required: (f: DataField): DataField => ({ ...f, required: true }),
};

/** プラグインのデータの宣言（同じファイルは後のプラグインが勝つ）。 */
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
