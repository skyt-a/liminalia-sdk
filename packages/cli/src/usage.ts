/**
 * lim の使い方の表示。命令を足したら、ここにも書く（test/usage.test.ts が main.ts の命令と README の一覧と食い違わないかを見る）。
 * 一行目が命令の書き方、続く行（空白で始まるもの）はその命令の続きの書き方。
 */
export const USAGE_LINES: readonly string[] = [
  "lim new      <フォルダ> [--title \"…\"] [--id …] [--size 1920x1080] [--novel] [--no-title-screen] [--blank] [--ci] [--lang en] [--template ひな形のフォルダ]",
  "lim new      <フォルダ> [--title \"…\"] [--id …] [--size 1920x1080] [--novel] [--no-title-screen] [--ci] [--lang en] --from <ひな形の URL>",
  "lim new      <フォルダ> --from-tyrano <TyranoScript のプロジェクト> [--title \"…\"] [--id …] [--size 1920x1080] [--no-title-screen] [--ci] [--lang en]",
  "lim import   [プロジェクト] [--assets]",
  "lim import-ink  [プロジェクト] <ファイル.ink> [--name 名前] [--end title|stop|return] [--force]",
  "lim import-yarn [プロジェクト] <ファイル.yarn かフォルダ…> [--name 名前] [--end title|stop|return] [--force]",
  "lim import-renpy [プロジェクト] <ファイル.rpy かフォルダ…> [--name 名前] [--end title|stop|return] [--force] [--no-assets]",
  "lim import-twine [プロジェクト] <ファイル.twee かフォルダ…> [--name 名前] [--end title|stop|return] [--force]",
  "lim check    [プロジェクト] [--json] [--lang en] [--github] [--strict] [--fix code,…]",
  "lim explain  [コード] [--lang en]",
  "lim query    [プロジェクト] <label|var|asset> [名前] [--json] [--lang en]",
  "lim trace    [プロジェクト] <ファイル[#ラベル]> [--choose 1,北の道] [--set game.x=1 …] [--from-state セーブ.json] [--max-pages N] [--json] [--lang en]",
  "lim test     [プロジェクト] [テストのファイルかフォルダ…] [--json] [--github] [--lang en]",
  "lim reach    [プロジェクト] <ファイル#ラベル|ファイル:行|--ending 種類か名前|--endings> [--timeout 秒] [--json] [--lang en]",
  "lim coverage [プロジェクト] [--runs 8] [--seeds 1] [--route-runs 8] [--json] [--min-lines 80] [--require-endings] [--github]",
  "lim fmt      [プロジェクト] [--check] [--indent 2|tab|keep]",
  "lim migrate  [プロジェクト] [--check] [--keep-behavior [名前,…]] [--json] [--lang en]",
  "lim script-export [プロジェクト] [--format text|html] [--out フォルダ] [--lines] [--lang en]",
  "lim prose    [プロジェクト] extract [ファイル…] [--out ファイル] [--ruby aozora|lim] [--lang en]",
  "lim prose    [プロジェクト] apply <ファイル> [--check]",
  "lim voice-lock [プロジェクト] [--runs 8] [--clear-rerecord]",
  "lim screens  [プロジェクト] copy <画面> [--part 部品,…] [--js] [--force] [--json]",
  "lim screens  [プロジェクト] diff <画面> [--json]",
  "lim screens  [プロジェクト] reset <画面>",
  "lim screens  [プロジェクト] js <画面> [--force]",
  "lim rename   [プロジェクト] <label|file|variable|character|speaker|asset|macro> <古い名前> <新しい名前> [--lang en]",
  "lim dev      [プロジェクト] [--port 5180]",
  "lim studio   [プロジェクト] [--port 5180]",
  "lim shot     [プロジェクト] <ファイル[#ラベル]> [--skip N] [--out shot.png] [--settle] [--wait ms] [--eval JS]",
  "lim shot     [プロジェクト] --title [--intro] [--out title.png]",
  "lim shot     [プロジェクト] <ファイル[#ラベル]> --video [video.mp4] [--skip N] [--pages 20|all] [--read 1800] [--auto] [--choose 0,1] [--stuck 60] [--no-audio] [--line]",
  "lim shot     [プロジェクト] <ファイル[#ラベル]> --video <フォルダ> --split file|chapter [--until ファイル[#ラベル]] [--resume | --redo 番号] [--avoid-choice 文,…] [--avoid-ending [種類,…]] [--line]",
  "lim shot     [プロジェクト] --screen <画面> [--state filled|empty|long] [--portrait | --landscape] [--theme テーマ] [--out screen.png] [--eval JS] [--json] [--lang en]",
  "lim shot     [プロジェクト] --screens [--json] [--lang en]",
  "lim reference [プロジェクト] [--json] [--lang en] [--out ファイル]",
  "lim i18n     [プロジェクト] <言語> [--export csv|xliff --out ファイル [--untranslated] [--changed]] [--import ファイル] [--count] [--lang en]",
  "lim i18n     [プロジェクト] --stamp-ids [<言語>] [--lang en]",
  "lim voice-script [プロジェクト] [--out フォルダ] [--lang en]",
  "lim psd      [プロジェクト] <ファイル.psd> <キャラクター> [--appearance 立ち絵セット] [--folder フォルダ]",
  "lim stats    [プロジェクト] [--out フォルダ] [--json] [--lang en]",
  "lim profile  [プロジェクト] [ファイル[#ラベル]] [--pages 30] [--wait 500] [--choose 0,1] [--out フォルダ] [--json] [--lang en]",
  "lim regress  [プロジェクト] [--update] [--threshold 0.05] [--pages 1] [--only 文字] [--dir フォルダ]",
  "lim backport [プロジェクト] --make-base <基準> --tyrano <TyranoScript のプロジェクト>",
  "lim backport [プロジェクト] --base <基準> [--tyrano …] [--out …] [--write [--force]]",
  "lim mcp      [--root プロジェクトの保存先 …]",
  "lim build    [プロジェクト] <browser|mac|windows|linux|android|ios|all> [--no-import] [--no-verify] [--zip] [--dmg] [--steam エディション|App ID|off] [--variant エディション] [--feedback] [--only-used] [--seed ファイル[#ラベル] ...]",
  "lim build    [プロジェクト] ios --device [端末の名前か ID]",
  "lim build    [プロジェクト] android --aab",
  "lim build    [プロジェクト] ios --archive [--export app-store|ad-hoc|development] [--upload]",
  "lim pack     [プロジェクト] <パックのフォルダ> [--out フォルダ] [--encrypt desktop|browser|off]",
  "lim patch    [プロジェクト] --base <前の書き出し（フォルダか zip）> [--id 名前] [--out フォルダ] [--variant エディション] [--force] [--allow-test]",
  "lim doctor   [プロジェクト] [--target browser,mac,windows,linux,android,ios,steam,update] [--json]",
  "lim clean    [プロジェクト] [--keep 1] [--target mac,windows,linux,android,ios,sourcemaps] [--dry-run]",
  "lim playtest [プロジェクト] [書き出したブラウザ版] [--rebuild] [--runs 1] [--choose 0,1] [--max-pages 5000] [--timeout 600] [--stuck 20] [--json]",
  "lim playtest [プロジェクト] [書き出したブラウザ版] [--fast] [--log] [--shots] [--avoid-choice 文,…] [--avoid-ending [種類,…]]",
  "lim crash    [プロジェクト] <記録.json> [--maps フォルダ] [--json] [--lang en]",
  "lim size     [プロジェクト] [書き出したもの] [--top 20] [--json]",
  "lim unused   [プロジェクト] [--all] [--json]",
  "lim publish  [プロジェクト] steam [--build os=フォルダ,…] [--app-id N] [--depot os=N,…] [--desc 文] [--branch 名前] [--preview] [--login 名前] [--allow-test] [--dry-run]",
  "lim publish  [プロジェクト] itch [browser,windows,mac,linux] [--target 人/ゲーム] [--build 先=フォルダ,…] [--channel 先=名前,…] [--userversion バージョン] [--allow-test] [--dry-run]",
  "lim update-manifest [プロジェクト] --base-url <URL> [--pack パック,…] [--app windows=ファイル,mac=ファイル,linux=ファイル] [--page URL] [--notes 文 | --notes-file ファイル] [--version バージョン] [--out フォルダ] [--fresh] [--sign-key 秘密鍵.pem] [--allow-test]",
  "lim update-key [プロジェクト] [--out 秘密鍵.pem] [--force]",
  "lim version",
];

/** どの命令にも付けられる旗（--restricted は作品のコードを動かさない。main.ts が先に取り除く。--lang は出力の言語）。 */
export const COMMON_FLAGS_NOTE = [
  "どのコマンドにも --restricted を付けると、プロジェクトのプラグインを読まずに動かす（書き出しは止める）",
  "どのコマンドにも --lang en を付けると、使い方、エラー、経過を英語で出す（無ければ環境変数 LIMINALIA_LANG、端末の言語の順に決める）",
].join("\n");

export const USAGE = `使い方:\n${USAGE_LINES.map((l) => `  ${l}`).join("\n")}\n\n${COMMON_FLAGS_NOTE}`;

/** 使い方の行に書いていない旗（書き方が長くなるもの）。命令ごとに、使い方の行の旗に足す。 */
const EXTRA_FLAGS: Readonly<Record<string, readonly string[]>> = {
  build: ["seed-slot", "seed-mode", "seed-title", "seed-id", "seed-overwrite"],
};

/** その命令が受ける旗の名前（-- を除く）。使い方の行に書いた旗と、EXTRA_FLAGS と、どの命令でも受ける help と lang（出力の言語）。 */
export function commandFlags(command: string, lines: readonly string[] = USAGE_LINES): Set<string> {
  const out = new Set(["help", "lang"]);
  for (const l of lines) {
    if (/^lim\s+([a-z][a-z0-9-]*)/.exec(l)?.[1] !== command) continue;
    for (const m of l.matchAll(/--([a-z][a-z0-9-]*)/g)) out.add(m[1]!);
  }
  for (const f of EXTRA_FLAGS[command] ?? []) out.add(f);
  return out;
}

/** 使い方の行を、括弧（[…] と <…>）の中の空白で分けずに語に分ける。 */
function usageWords(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let word = "";
  for (const c of text) {
    if (c === "[" || c === "<") depth++;
    else if ((c === "]" || c === ">") && depth > 0) depth--;
    if (c === " " && depth === 0) {
      if (word) out.push(word);
      word = "";
    } else word += c;
  }
  if (word) out.push(word);
  return out;
}

/**
 * その命令が受ける、旗でない引数の数のいちばん多いもの（使い方の行から。プロジェクトのフォルダも数える）。
 * 「…」のある引数（ファイルをいくつも書ける）があれば Infinity。旗（--x）とその値は数えない。
 */
export function maxPositional(command: string, lines: readonly string[] = USAGE_LINES): number {
  let max = 0;
  for (const l of lines) {
    const m = /^lim\s+([a-z][a-z0-9-]*)\s*(.*)$/.exec(l);
    if (m?.[1] !== command) continue;
    let count = 0;
    let afterFlag = false;
    for (const w of usageWords(m[2] ?? "")) {
      if (w.startsWith("--") || w.startsWith("[--") || w === "|") {
        afterFlag = w.startsWith("--");
        continue;
      }
      if (afterFlag) {
        afterFlag = false;
        continue;
      }
      if (w.includes("…")) return Infinity;
      count++;
    }
    max = Math.max(max, count);
  }
  return max;
}

/** その命令の使い方の行（無ければ全体）。 */
export function usageOf(command: string): string {
  const lines = USAGE_LINES.filter((l) => /^lim\s+([a-z][a-z0-9-]*)/.exec(l)?.[1] === command);
  return lines.length > 0 ? `使い方:\n${lines.map((l) => `  ${l}`).join("\n")}` : USAGE;
}

/** 使い方に出ている命令の名前（重なりなし）。 */
export function usageCommands(lines: readonly string[] = USAGE_LINES): string[] {
  return [...new Set(lines.map((l) => /^lim\s+([a-z][a-z0-9-]*)/.exec(l)?.[1]).filter((x): x is string => !!x))];
}
