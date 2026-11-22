import type { CommandSpec, ParamSpec } from "@liminalia/lang";

/**
 * 約束の値の正本（@liminalia/lang はここを読み直す）。プラグインが使う口の版、ルール画像の引数、演出を飛ばせるかの引数、定義に英語を重ねる関数。
 */

/**
 * プラグインの命令と描画の口の版（CommandPlugin・WebPlugin の apiVersion と、プラグインの package.json の liminalia.api・engines.liminalia）。
 * 版ごとの違いは @liminalia/lang の registry.ts の説明にある。
 */
export const PLUGIN_API_VERSION = 8;

/**
 * 組み込みのルール（ルール画像を描かなくても使える切り替えの型）。
 * wipe-* はその向きへ拭う、circle-in は外から中へ・circle-out は中から外へ、blinds は横の帯・blinds-vertical は縦の帯、
 * diamond はひし形が広がる、noise はばらばらのます目。
 */
export const RULE_PATTERNS = ["wipe-left", "wipe-right", "wipe-up", "wipe-down", "circle-in", "circle-out", "blinds", "blinds-vertical", "diamond", "noise"] as const;

/** ルール画像の切り替え（ユニバーサルトランジション）の引数。書けば method より優先する。作品の命令でも同じ書き方で受けられる。 */
export const RULE_PARAMS: Readonly<Record<string, ParamSpec>> = {
  rule: { type: { kind: "asset", folder: "image" }, doc: "ルール画像（白黒）。暗いところから先に切り替わる。method より優先する", docEn: "Rule image (grayscale; darker areas change first; overrides method)" },
  pattern: { type: { kind: "enum", values: [...RULE_PATTERNS] }, doc: "組み込みのルール（rule を書かないとき。wipe-left、circle-out、blinds、noise など）", docEn: "Built-in rule, used when rule isn't given (wipe-left, circle-out, blinds, noise and so on)" },
  vague: { type: { kind: "int", min: 0, max: 255 }, default: "64", doc: "ルールの境目のぼかし（0〜255。大きいほど柔らかい）", docEn: "Softness of the rule's edge (0 to 255; higher is softer)" },
};

/**
 * 時間のかかる演出をクリック（決定キー・タップ）で終わりまで飛ばせるか。演出に時間をかける命令が持つ。
 * 作品全体で飛ばさないなら liminalia.json の ui.input.skipEffects を false にする。
 */
export const SKIP_PARAM: ParamSpec = {
  type: { kind: "bool" },
  default: "true",
  doc: "クリック、決定キー、タップで演出を終わりまで飛ばせる。false なら飛ばせない（スキップ中は書かなくてもすぐ終わる）",
  docEn: "Lets a click, the Enter key or a tap finish the effect at once. false prevents it (while skipping, it ends at once anyway)",
};

/**
 * 一つのコマンドの英語。params はパラメータの名前ごと。keywords はパーツの欄の検索に使う言葉。
 * example は英語の例（人物の名前や見せる文字が日本語の例だけに書く）。
 */
export interface CommandEnglish {
  summary: string;
  params?: Readonly<Record<string, string>>;
  keywords?: readonly string[];
  example?: string;
}

/** withEnglish が読む、コマンドの定義の形（CommandSpec と CommandDefinition の両方）。 */
export interface EnglishTarget {
  name: string;
  summaryEn?: string;
  keywordsEn?: readonly string[];
  exampleEn?: string;
  params: Readonly<Record<string, { docEn?: string }>>;
}

/**
 * コマンドの定義に英語を重ねる（表の英語が先。表に無いものは定義に書いた英語のまま）。
 * 表は名前 → { summary, params, keywords, example }。
 */
export function withEnglish<T extends EnglishTarget>(commands: readonly T[], table: Readonly<Record<string, CommandEnglish>>): T[] {
  return commands.map((c) => withCommandEnglish(c, table[c.name]));
}

/** 一つのコマンドに英語を重ねる（名前の重なる @choice の行と選択肢の行のため）。 */
export function withCommandEnglish<T extends EnglishTarget>(c: T, en: CommandEnglish | undefined): T {
  if (!en) return c;
  const params: Record<string, { docEn?: string }> = {};
  for (const [name, p] of Object.entries(c.params)) {
    const docEn = en.params?.[name] ?? p.docEn;
    params[name] = docEn === undefined ? p : { ...p, docEn };
  }
  const keywordsEn = en.keywords ?? c.keywordsEn;
  const exampleEn = en.example ?? c.exampleEn;
  return { ...c, summaryEn: en.summary, params, ...(keywordsEn ? { keywordsEn } : {}), ...(exampleEn ? { exampleEn } : {}) } as T;
}

/** 型の確認のため（CommandSpec も withEnglish に渡せる）。 */
export type { CommandSpec };
