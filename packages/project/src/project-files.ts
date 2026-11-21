/**
 * 作品のファイルの種類（と、liminalia.json の中でシナリオやラベル、変数の名前を持つ所）を一か所に並べたもの。
 *
 * 作品を書き換える命令（lim rename と Studio の名前の変更、lim migrate、lim fmt、lim i18n --stamp-ids、lim new --template など）は、
 * ここに並べた種類をどれも扱う: 名前を書き換えるか、関わらないか、扱えないもの（UTF-8 で読めないシナリオ）を知らせて何も書かずに止めるか。
 * 種類を足したら、packages/cli/test/project-files.test.ts の表に、命令ごとの扱いを書き足す（書き足さないと型の確認とテストが落ちる）。
 * 読み書きの口: シナリオは scenario-files.ts の readScenarioFile と assertScenariosUtf8、テストは listScenarioTestFiles。
 */
export const PROJECT_FILE_KINDS = {
  /** シナリオ（paths.scenario の下の .lim。サブフォルダも）。 */
  script: "scenario/**/*.lim",
  /** UTF-8 で読めないシナリオ（Shift_JIS など。TyranoScript から移した作品に残りやすい）。書き換える命令は何も書かずに止める。 */
  "script-not-utf8": "scenario/**/*.lim（Shift_JIS など）",
  /** 台本のテスト（lim test。from と expect reach の場所、set と expect の式、話者名と比べる expect text）。 */
  test: "tests/**/*.limtest",
  /** 「はじめから」とロード直後の位置。 */
  "config-entry": "liminalia.json の entry、afterLoad",
  /** 章のシナリオファイル（ワイルドカードの名前は書き換えられないので知らせる）。 */
  "config-chapters": "liminalia.json の chapters の files",
  /** おまけの回想と章の位置、フローチャートの題。 */
  "config-extra": "liminalia.json の extra.replay と extra.chapters の target、extra.flowchart.titles の鍵",
  /** 場面ごとの情報と、わざと無音にした場面。 */
  "config-scenes": "liminalia.json の scenes の鍵、check.sound.quiet",
  /** 変数の初期値（名前と、ジャンプ先に使う変数の値）。 */
  "config-variables": "liminalia.json の variables",
  /** 台本の書式の版と整形の設定（0.1.17 までは format の中に整形の設定を書いた）。 */
  "config-format": "liminalia.json の format、fmt",
  /** キャラクターと話者。 */
  cast: "cast.json",
  /** 訳（鍵はファイルと原文から作る。話者名の表もある）。 */
  translation: "lang/*.json",
  /** 作品のデータ（プラグインが形を宣言したものだけ、名前の変更が中の名前を書き換える）。 */
  data: "data/**/*.json",
  /** 連番のボイスの番号の固定（鍵はファイルと話者と原文から作る）。 */
  "voice-lock": "voice-lock.json",
} as const;

export type ProjectFileKind = keyof typeof PROJECT_FILE_KINDS;
