/**
 * lim — Liminalia のプロジェクトの道具。プロジェクトのフォルダ（liminalia.json のあるところ）を先頭に指定する。
 * 省略すると今のフォルダ。
 *
 *   lim new      <フォルダ> [--title "…"] [--id …] [--size 1920x1080] [--novel] [--no-title-screen] [--blank] [--ci] [--lang en] [--template ひな形のフォルダ]
 *                                                     ひな形から新しいプロジェクトを作る
 *   lim new      <フォルダ> --from <ひな形の URL> [--title "…"] [--id …] [--size 1920x1080] [--novel] [--no-title-screen] [--ci] [--lang en]
 *                                                     人が配るひな形を URL（github:人/リポジトリ#タグ、https のリポジトリか zip）から取って作る（中のコードは信頼するまで動かさない）
 *   lim new      <フォルダ> --from-tyrano <TyranoScript の作品> [--title "…"] [--id …] [--size 1920x1080] [--no-title-screen] [--ci] [--lang en]
 *                                                     TyranoScript／TyranoBuilder の作品のシナリオと素材を取り込んで、新しいプロジェクトを作る
 *   lim import   [プロジェクト] [--assets] [--lang en] TyranoScript のプロジェクトを取り込む（import.tyrano。--assets で素材も写す。--lang en で報告を英語に）
 *   lim import-ink  [プロジェクト] <ファイル.ink> [--name 名前] [--end title|stop|return] [--force]
 *   lim import-yarn [プロジェクト] <ファイル.yarn かフォルダ…> [--name 名前] [--end title|stop|return] [--force]
 *   lim import-renpy [プロジェクト] <ファイル.rpy かフォルダ…> [--name 名前] [--end title|stop|return] [--force]
 *   lim import-twine [プロジェクト] <ファイル.twee かフォルダ…> [--name 名前] [--end title|stop|return] [--force]
 *                                                     Ink、Yarn Spinner、Ren'Py、Twine のシナリオを .lim に変換して取り込む
 *                                                     （Ren'Py は game/images と audio の使う素材を写し、tl/ の translate を lang/<言語>.json にする。--no-assets で写さない）
 *   lim check    [プロジェクト] [--json] [--lang en] [--github] [--strict] [--fix code,…]
 *                                                     全シナリオを検査する（--github は GitHub Actions の注釈も出し、--strict は警告も失敗にする。
 *                                                     --fix はその code の診断の直し方を全ファイルに当ててから検査する）
 *   lim trace    [プロジェクト] <ファイル[#ラベル]> [--choose 1,0] [--set game.x=1 …] [--from-state セーブ.json] [--max-pages N] [--json] [--lang en]
 *   lim test     [プロジェクト] [テストのファイルかフォルダ…] [--json] [--github] [--lang en]
 *                                                     台本の自動テスト（tests/*.limtest）を流し、期待と違えば 1
 *   lim reach    [プロジェクト] <ファイル#ラベル|ファイル:行|--ending 種類か名前|--endings> [--timeout 秒] [--json] [--lang en]
 *                                                     その行やエンディングへ届く選び方と、要る変数を出す
 *   lim coverage [プロジェクト] [--runs 8] [--seeds 1] [--route-runs 8]
 *                                                     全ファイルを画面なしで流し、網羅率と実行時の診断を出す。はじめから変数を引き継いで流し、届いたエンディングを出す
 *   lim fmt      [プロジェクト] [--check] [--indent 2|tab|keep]   命令の行と式を整える（本文は変えない。--indent でブロックの字下げ）
 *   lim migrate  [プロジェクト] [--check] [--keep-behavior [名前,…]] [--json] [--lang en]
 *                                                     台本を今の書式に移す（前の版の命令の名前を今の名前に、liminalia.json の format を今の版に。
 *                                                     --keep-behavior で、既定の見た目や動きが変わったものに前の動きを残す設定を書く）
 *   lim script-export [プロジェクト] [--format text|html] [--out フォルダ] [--lines] [--lang en]
 *                                                     校正用の台本（本文とシーンの見出し、話者名、ルビは《》）をファイルごとに書き出す
 *   lim prose extract [プロジェクト] [ファイル…] [--out ファイル] [--ruby aozora|lim]   本文だけを行の鍵付きで抜き出す
 *   lim prose apply [プロジェクト] <ファイル> [--check]   直した本文を、本文以外が変わっていないことを確かめて書き戻す
 *   lim voice-lock [プロジェクト] [--runs 8]           連番のボイスの番号を台詞ごとに固定する（voice-lock.json）
 *   lim screens  [プロジェクト] copy <画面> [--part 部品,…] [--js] [--force] [--json]
 *                                                     標準の画面のテンプレートを ui/screens/<画面>/ に写して ui.templates に登録する（元の文字は .liminalia/screens/ に残す）
 *   lim screens  [プロジェクト] diff <画面> [--json]   作品のテンプレートと今の標準の違いと、写した元の版から標準が変わったところを出す
 *   lim screens  [プロジェクト] reset <画面>           登録を外して標準の画面に戻す（ファイルは名前を変えて残す）
 *   lim screens  [プロジェクト] js <画面> [--force]    画面の JS の雛形をテンプレートと同じ場所に置く
 *   lim rename   [プロジェクト] <種類> <古い名前> <新しい名前> [--lang en]
 *                                                     名前を変え、参照しているところも書き換える（label・file・variable・character・speaker・asset・macro。制作画面の名前の変更と同じ）
 *   lim dev      [プロジェクト] [--port 5180]          プレイヤーの開発サーバー
 *   lim studio   [プロジェクト] [--port 5180]          制作画面（lim dev と同じ開発サーバーに載せる）
 *   lim shot     [プロジェクト] <ファイル[#ラベル]> [--skip N] [--out shot.png] [--settle] [--wait ms] [--eval JS] [--lang en]
 *                                                     N ページ目のクリック待ちを撮る。--skip が 1 以下なら、最初のページより前の選択肢と操作待ちの画面でも止めて撮る
 *   lim shot     [プロジェクト] --title [--intro] [--out title.png] [--lang en]
 *   lim shot     [プロジェクト] --screen <画面> [--state filled|empty|long] [--portrait | --landscape] [--theme テーマ] [--out screen.png] [--eval JS] [--json]
 *   lim shot     [プロジェクト] --screens [--json]
 *   lim shot     [プロジェクト] <ファイル[#ラベル]> --video [video.mp4] [--skip N] [--pages 20] [--read 1800] [--choose 0,1] [--line]
 *                                                     その位置から実際の速さで送りながら録画する（--line で隅に実行中の行。ffmpeg が要る）
 *   lim reference [プロジェクト] [--json] [--lang en] [--out ファイル]   命令のリファレンス（プロジェクトを省くと組み込みと標準だけ。--lang en で英語）
 *   lim i18n     [プロジェクト] <言語> [--export csv|xliff --out ファイル [--untranslated] [--changed]] [--import ファイル] [--count] [--stamp-ids] [--lang en]
 *                                                     その言語の訳のファイル（lang/<言語>.json）を今のシナリオに合わせる。
 *                                                     翻訳する人とは表（CSV）か XLIFF でやり取りし、文字数（見積もり用）を出す
 *   lim voice-script [プロジェクト] [--out フォルダ] [--lang en]   収録用の台本を CSV で書き出す（全体・話者ごと・集計。--lang en は英語の名前と見出し）
 *   lim patch    [プロジェクト] --base <前の書き出し（フォルダか zip）> [--id 名前] [--out フォルダ] [--variant 版] [--force] [--allow-test]
 *                                                     前の書き出しとの差分から、変わったものだけを入れたパッチ（パック）を作る
 *   lim psd      [プロジェクト] <ファイル.psd> <キャラクター> [--appearance 立ち絵セット] [--folder フォルダ]
 *                                                     PSD・PSB のレイヤーをパーツ合成の立ち絵として取り込む
 *   lim stats    [プロジェクト] [--out フォルダ] [--json] [--lang en]   台詞と地の文の文字数（ファイル別、シーン別、話者別）と表記ゆれの候補
 *   lim profile  [プロジェクト] [ファイル[#ラベル]] [--pages 30] [--wait 500] [--choose 0,1] [--out フォルダ] [--json] [--lang en]
 *                                                     プレイヤーを開いてページを進めながら重さ（フレームレート、メモリ、素材）を計る
 *   lim pack     [プロジェクト] <パックのフォルダ> [--out フォルダ] [--encrypt desktop|browser|off]
 *                                                     追加の中身・修正（パック）を書き出す（build.encrypt の作品は既定で暗号にする）
 *   lim update-manifest [プロジェクト] --base-url <URL> [--pack パック,…] [--app windows=ファイル,mac=ファイル] [--page URL]
 *                [--notes 文 | --notes-file ファイル] [--version 版] [--out フォルダ] [--fresh] [--sign-key 秘密鍵.pem] [--allow-test]
 *                                                     デスクトップ版のアップデートの確認が読むマニフェストと、配るファイルを作る
 *   lim update-key [プロジェクト] [--out 秘密鍵.pem] [--force]   マニフェストに署名する鍵の組（Ed25519）を作る
 *   lim doctor   [プロジェクト] [--target mac,windows,android,ios,steam,update] [--json]
 *                                                     書き出しに要る道具（Node、Chromium、Xcode、Android SDK、JDK、ffmpeg、NSIS、署名の鍵、steamcmd など）を確かめる
 *   lim clean    [プロジェクト] [--keep 1] [--target mac,windows,sourcemaps] [--dry-run]
 *                                                     日時付きで溜まる書き出しとソースマップの控えを、名前ごとに新しいものから --keep 件（既定は build.keep か 1）残して消す
 *   lim playtest [プロジェクト] [書き出したブラウザ版] [--rebuild] [--runs 1] [--choose 0,1] [--max-pages 5000] [--timeout 600] [--stuck 20] [--json] [--lang en]
 *                [--fast] [--log] [--shots] [--avoid-choice 文,…] [--avoid-ending [種類,…]]
 *                                                     書き出したブラウザ版を開いて「はじめから」最後まで流し、エラーと止まった所を出す
 *                                                     （待ち時間を詰める、ページのログ、変わるたびのスクリーンショット、種類 bad のエンディングを避ける選び方）
 *   lim crash    [プロジェクト] <記録.json> [--maps フォルダ] [--json] [--lang en]
 *                                                     止まったときの記録のプログラムの位置を、書き出しのソースマップの控えで元のファイルと行に戻し、台本の位置と並べる
 *   lim size     [プロジェクト] [書き出したもの] [--top 20] [--json]
 *                                                     書き出しの大きさの内訳（種類別、フォルダ別、大きいファイル）。省くと一番新しい書き出し
 *   lim unused   [プロジェクト] [--all] [--json]       どこからも参照されていない素材の候補（--all で声も見る）
 *   lim publish  [プロジェクト] steam [--build os=フォルダ,…] [--app-id N] [--depot os=N,…] [--desc 文] [--branch 名前] [--preview] [--login 名前] [--allow-test] [--dry-run]
 *                                                     書き出したデスクトップ版を steamcmd で Steam へ上げる（VDF を作る。ログインは steamcmd が尋ねる）
 *   lim publish  [プロジェクト] itch [browser,windows,mac,linux] [--target 人/ゲーム] [--build 先=フォルダ,…] [--channel 先=名前,…] [--userversion 版] [--allow-test] [--dry-run]
 *                                                     書き出したゲームを butler で itch.io へ上げる（ログインは butler login か BUTLER_API_KEY）
 *   lim regress  [プロジェクト] [--update] [--threshold 0.05] [--pages 1] [--only 文字] [--dir フォルダ]
 *                                                     全分岐の見た目の確かめ（フローチャートの場面ごとに撮って基準と比べる）
 *   lim backport [プロジェクト] --make-base <基準> --tyrano <TyranoScript のプロジェクト>   書き戻しの基準を作る
 *   lim backport [プロジェクト] --base <基準> [--tyrano …] [--out …] [--write [--force]]    .lim の変更を .ks に書き戻す
 *   lim mcp      [--root 作品の置き場 …]                AI のアシスタント向けの MCP サーバー（標準入出力）。置き場の既定は ~/Liminalia
 *   lim build    [プロジェクト] <browser|mac|windows|linux|android|ios|all> [--no-import] [--no-verify]
 *                [--seed ファイル[#ラベル]] [--seed-slot 0] [--seed-mode successful_route|fresh] [--seed-title 文] [--seed-id ID] [--seed-overwrite]
 *                [--device [端末の名前か ID]]（ios のとき。実機用に署名してビルドし、つないだ端末に入れて起動する）
 *                [--aab]（android のとき。Google Play に上げる App Bundle も作る）
 *                [--archive [--export app-store|ad-hoc|development] [--upload]]（ios のとき。Archive を作って .ipa に書き出す。--upload は App Store Connect へ）
 *                [--zip]（Mac 版とブラウザ版も zip にする。ブラウザ版は index.html が一番上） [--dmg]（Mac 版を dmg にもする）
 *                [--feedback]（テスト版。遊びながらその場面に指摘を残す口を入れる。送り先は liminalia.json の build.feedback）
 *                [--only-used]（使っている素材だけを入れる。lim unused の候補を外す。liminalia.json の build.onlyUsed と同じ）
 *
 * どの命令にも --restricted を付けられる: 作品のプラグインを読まず、書き出しを止める（人から受け取った作品を調べるとき。LIMINALIA_RESTRICTED=1 と同じ）。
 * どの命令にも --lang en を付けられる: 使い方、断り、経過を英語で出す（output-language.ts。無ければ LIMINALIA_LANG、端末の言語の順に決める）。
 */
import { markRestrictedFlag, parseFlags, str, takeProjectDir } from "./context.ts";
import type { BuildTarget } from "./commands/build.ts";
import type { IosExportMethod } from "./mobile/ios.ts";
import { DEFAULT_COVERAGE_RUNS } from "@liminalia/runtime";
import type { StoryKind } from "@liminalia/story-import/node";
import type { ScreenSampleState } from "@liminalia/studio/protocol";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { typoDistance } from "@liminalia/lang";
import { engineVersion } from "./version.ts";
import { commandFlags, maxPositional, USAGE, usageCommands, usageOf } from "./usage.ts";
import { installedFromPackage } from "./engine-paths.ts";
import { installEnglishOutput } from "./english-output.ts";
import { langFlag, outputLanguage, type OutputLanguage } from "./output-language.ts";

/** 綴りの近い名前（命令と旗の打ち間違いの案。無ければ null）。 */
function nearest(word: string, candidates: Iterable<string>): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const c of candidates) {
    const d = typoDistance(word, c);
    if (d < bestDistance) [best, bestDistance] = [c, d];
  }
  return best !== null && bestDistance <= Math.max(1, Math.floor(word.length / 3)) ? best : null;
}

/** lim の版（エンジンの版と、取り出したエンジンの git の commit）。制作アプリの「このアプリについて」と同じ番号。 */
function versionText(): string {
  let commit = "";
  // npm で入れた lim は node_modules の中にあり、git は作品のリポジトリのコミットを返すので見ない
  if (!installedFromPackage()) {
    try {
      commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: new URL("..", import.meta.url), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      // 取り出したリポジトリでないか、その道具が無ければコミットを出さない
      commit = "";
    }
  }
  return `lim ${engineVersion()}${commit ? ` (${commit})` : ""} Node ${process.version}`;
}



/**
 * 出力の言語（output-language.ts。--lang、LIMINALIA_LANG、端末の言語の順）。英語なら、ここから先の console の文を英語の表で読み替える
 * （english-output.ts）。lim mcp は標準出力がアシスタントとのやり取りなので変えない。
 */
function chooseLanguage(argv: string[]): OutputLanguage {
  // lim --lang en check … のように、命令の前に書いてもよい
  if (argv[0] === "--lang" && argv[1] !== undefined) {
    const [, value] = argv.splice(0, 2);
    argv.push("--lang", value!);
  }
  const lang = outputLanguage(langFlag(argv));
  if (lang === "en" && argv[0] !== "mcp") installEnglishOutput();
  return lang;
}

async function main(argv: string[]): Promise<number> {
  const lang = chooseLanguage(argv);
  const [command, ...rest] = argv;
  // どの命令でも受ける --restricted: 作品のコードを動かさない（@liminalia/project の trust.ts。loadProject が環境変数を読む）
  for (let i = rest.indexOf("--restricted"); i >= 0; i = rest.indexOf("--restricted")) {
    rest.splice(i, 1);
    process.env.LIMINALIA_RESTRICTED = "1";
    markRestrictedFlag();
  }
  // 版と使い方は作品の外でも出す
  if (command === "version" || command === "--version" || command === "-v") {
    console.log(versionText());
    return 0;
  }
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return command ? 0 : 2;
  }
  // 知らない命令と旗は、近い名前を示して止める（黙って別の動きをしない）
  const commands = usageCommands();
  if (!commands.includes(command)) {
    const near = nearest(command, commands);
    console.error(near ? `lim: ${command} というコマンドはありません（${near} のことですか？）` : `lim: ${command} というコマンドはありません`);
    console.log(USAGE);
    return 2;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(usageOf(command));
    return 0;
  }
  const flags = commandFlags(command);
  for (const token of rest) {
    if (!token.startsWith("--")) continue;
    // --旗=値 の形は = の前が旗の名前（parseFlags と同じ読み方）
    const name = token.slice(2).split("=", 1)[0]!;
    if (flags.has(name)) continue;
    const near = nearest(name, flags);
    console.error(near ? `lim ${command}: --${name} というオプションはありません（--${near} のことですか？）` : `lim ${command}: --${name} というオプションはありません`);
    console.log(usageOf(command));
    return 2;
  }
  // - 一つの旗（-j など）と、使い方より多い引数も、黙って読み飛ばさずに止める（旗の値は数えない）
  const given = parseFlags(rest, command === "new" ? new Set(["novel", "no-title-screen", "blank", "ci"]) : undefined).positional;
  const short = given.find((a) => /^-[A-Za-z]/.test(a));
  if (short) {
    const near = nearest(short.replace(/^-+/, ""), flags);
    console.error(near ? `lim ${command}: ${short} というオプションはありません（--${near} のことですか？）` : `lim ${command}: ${short} というオプションはありません`);
    console.log(usageOf(command));
    return 2;
  }
  const most = maxPositional(command);
  if (given.length > most) {
    console.error(`lim ${command}: 余分な引数があります: ${given.slice(most).join(" ")}`);
    console.log(usageOf(command));
    return 2;
  }
  if (command === "explain") {
    const { runExplain } = await import("./commands/explain.ts");
    const f = parseFlags(rest);
    return runExplain(f.positional[0], lang) ? 0 : 2;
  }
  if (command === "reference") {
    const { runReference } = await import("./commands/reference.ts");
    const dir = takeProjectDir(rest, { optional: true });
    const f = parseFlags(rest);
    const out = str(f, "out");
    await runReference(dir, { json: f.flags.has("json"), lang, ...(out ? { out } : {}) });
    return 0;
  }
  if (command === "doctor") {
    const { runDoctor } = await import("./commands/doctor.ts");
    const dir = takeProjectDir(rest, { optional: true });
    const f = parseFlags(rest);
    const targets = str(f, "target")?.split(",").map((x) => x.trim()).filter(Boolean);
    return runDoctor(dir, { ...(targets ? { targets } : {}), json: f.flags.has("json"), lang }) ? 0 : 1;
  }
  if (command === "new") {
    const { runNew } = await import("./commands/new.ts");
    const { runNewFrom } = await import("./commands/new-from.ts");
    const f = parseFlags(rest, new Set(["novel", "no-title-screen", "blank", "ci"]));
    const tyrano = str(f, "from-tyrano");
    const target = f.positional[0];
    if (!target) throw new Error("作成するフォルダを指定してください（lim new my-game）");
    const title = str(f, "title");
    const id = str(f, "id");
    const size = str(f, "size");
    // 原文の言語。--lang が無ければ出力の言語（英語の端末なら英語の作品。TyranoScript の作品からは、制作アプリと同じく既定は日本語）
    const language = str(f, "lang") ?? (lang === "en" && tyrano === undefined ? "en" : undefined);
    const template = str(f, "template");
    const from = str(f, "from");
    if (from !== undefined && (template !== undefined || tyrano !== undefined || f.flags.has("blank"))) throw new Error("--from には --template、--from-tyrano、--blank を付けません（URL のひな形から作ります）");
    const m = size === undefined ? null : /^(\d+)[x×](\d+)$/.exec(size);
    if (size !== undefined && !m) throw new Error(`--size は 幅x高さ で指定してください（例: 1920x1080）: ${size}`);
    if (tyrano !== undefined) {
      const { runNewFromTyrano } = await import("./commands/import.ts");
      if (f.flags.has("blank") || f.flags.has("novel") || template !== undefined) throw new Error("--from-tyrano には --blank、--novel、--template を付けません（TyranoScript のプロジェクトのシナリオから作ります）");
      return (await runNewFromTyrano(target, {
        source: tyrano,
        ...(title !== undefined ? { title } : {}),
        ...(id !== undefined ? { id } : {}),
        ...(m ? { screen: { width: Number(m[1]), height: Number(m[2]) } } : {}),
        ...(f.flags.has("no-title-screen") ? { titleScreen: false } : {}),
        // CI のひな形と、はじめから終わりまで流れるテスト（白紙の作品と同じもの。entry は取り込んだシナリオ）
        ...(f.flags.has("ci") ? { ci: true } : {}),
        ...(language !== undefined ? { language } : {}),
      }))
        ? 0
        : 1;
    }
    const options = {
      ...(title !== undefined ? { title } : {}),
      ...(id !== undefined ? { id } : {}),
      ...(m ? { screen: { width: Number(m[1]), height: Number(m[2]) } } : {}),
      ...(f.flags.has("novel") ? { novel: true } : {}),
      ...(f.flags.has("no-title-screen") ? { titleScreen: false } : {}),
      ...(f.flags.has("blank") ? { blank: true } : {}),
      ...(f.flags.has("ci") ? { ci: true } : {}),
      ...(language !== undefined ? { language } : {}),
      // --lang で端末と違う言語を選んだら、案内の命令にも付ける（次の命令も同じ言語で出るように）
      ...(lang !== outputLanguage(undefined) ? { suggestLang: lang } : {}),
    };
    // URL のひな形（リポジトリか zip）は取ってから作る。中のコードは信頼するまで動かさない
    if (from !== undefined) await runNewFrom(target, from, options, lang);
    else runNew(target, { ...options, ...(template !== undefined ? { template } : {}) });
    return 0;
  }
  if (command === "mcp") {
    const { runMcp } = await import("./commands/mcp.ts");
    const roots: string[] = [];
    for (let i = 0; i < rest.length; i++) if (rest[i] === "--root" && rest[i + 1]) roots.push(rest[++i]!); else if (rest[i]!.startsWith("--root=")) roots.push(rest[i]!.slice("--root=".length));
    await runMcp(roots);
    return 0;
  }
  // lim prose extract <プロジェクト> の順でも書ける（作品の外から。プロジェクトを先に探す takeProjectDir の前に、動作の後ろのプロジェクトを前へ出す）
  if (command === "prose" && (rest[0] === "extract" || rest[0] === "apply") && rest[1] !== undefined && !rest[1].startsWith("--") && existsSync(join(rest[1], "liminalia.json"))) {
    rest.splice(0, 2, rest[1], rest[0]);
  }
  const dir = takeProjectDir(rest);
  const f = parseFlags(rest);
  switch (command) {
    case "import": {
      const { runImport } = await import("./commands/import.ts");
      return (await runImport(dir, lang, { assets: f.flags.has("assets") })) ? 0 : 1;
    }
    case "import-ink":
    case "import-yarn":
    case "import-renpy":
    case "import-twine": {
      const { runImportStory } = await import("./commands/import-story.ts");
      const name = str(f, "name");
      const end = str(f, "end");
      return (await runImportStory(dir, command.slice("import-".length) as StoryKind, f.positional, { force: f.flags.has("force"), assets: !f.flags.has("no-assets"), ...(name ? { name } : {}), ...(end ? { end } : {}) })) ? 0 : 1;
    }
    case "check": {
      const { runCheck } = await import("./commands/check.ts");
      // --github は GitHub Actions の注釈（::error 形式）でも出し、--strict は警告も失敗にする
      // --fix は、その code の診断に付いた直し方を全ファイルに当ててから検査する
      const fix = str(f, "fix")?.split(",").map((x) => x.trim()).filter(Boolean);
      if (f.flags.get("fix") === true || (fix && fix.length === 0)) throw new Error("--fix には当てる診断の code を指定してください（--fix chara-solo）");
      return (await runCheck(dir, f.flags.has("json"), lang, { github: f.flags.has("github"), strict: f.flags.has("strict"), ...(fix ? { fix } : {}) })) ? 0 : 1;
    }
    case "query": {
      const { queryKind, runQuery } = await import("./commands/query.ts");
      return (await runQuery(dir, queryKind(f.positional[0] ?? ""), f.positional[1], f.flags.has("json"), lang)) ? 0 : 1;
    }
    case "i18n": {
      const { runI18n } = await import("./commands/i18n.ts");
      const language = f.positional[0] ?? null;
      const stampIds = f.flags.has("stamp-ids");
      if (!language && !stampIds) throw new Error("言語を指定してください（lim i18n en）");
      const format = str(f, "export");
      if (format !== undefined && format !== "csv" && format !== "xliff") throw new Error("--export には csv か xliff を指定してください");
      const out = str(f, "out");
      if (format && !out) throw new Error("--export には --out（出力先のファイル）が必要です");
      if ((f.flags.has("untranslated") || f.flags.has("changed")) && !format) throw new Error("--untranslated と --changed は --export と一緒に使います");
      const back = str(f, "import");
      return (await runI18n(dir, language, {
        ...(format && out ? { export: { format, out } } : {}),
        ...(back ? { import: back } : {}),
        count: f.flags.has("count"),
        untranslated: f.flags.has("untranslated"),
        changed: f.flags.has("changed"),
        stampIds,
        lang,
      }))
        ? 0
        : 1;
    }
    case "backport": {
      const { runBackport, runMakeBackportBase } = await import("./commands/backport.ts");
      const makeBase = str(f, "make-base");
      const tyrano = str(f, "tyrano");
      if (makeBase) {
        if (!tyrano) throw new Error("--make-base には --tyrano（インポート元の TyranoScript のプロジェクト）が必要です");
        return (await runMakeBackportBase(dir, makeBase, tyrano)) ? 0 : 1;
      }
      const base = str(f, "base");
      if (!base) throw new Error("--base（書き戻しの基準のフォルダ）を指定してください");
      const out = str(f, "out");
      return (await runBackport(dir, { base, ...(tyrano ? { tyrano } : {}), ...(out ? { out } : {}), write: f.flags.has("write"), force: f.flags.has("force") })) ? 0 : 1;
    }
    case "trace": {
      const { parseChoose, parseSets, runTrace } = await import("./commands/trace.ts");
      const target = f.positional[0];
      const fromState = str(f, "from-state");
      if (!target && !fromState) throw new Error("開始位置（ファイル または ファイル#ラベル）か --from-state を指定してください");
      const maxPages = str(f, "max-pages");
      // --set は何度でも書ける（game.x=式）
      const sets: string[] = [];
      for (let i = 0; i < rest.length; i++) if (rest[i] === "--set" && rest[i + 1] !== undefined) sets.push(rest[++i]!); else if (rest[i]!.startsWith("--set=")) sets.push(rest[i]!.slice("--set=".length));
      // 実行時のエラーがあれば 1。--choose は番号（0 から）か選択肢の文
      return (await runTrace(dir, target ?? "", {
        choose: parseChoose(str(f, "choose")),
        ...(maxPages ? { maxPages: Number(maxPages) } : {}),
        json: f.flags.has("json"),
        language: lang,
        sets: parseSets(sets),
        ...(fromState ? { fromState } : {}),
      }))
        ? 0
        : 1;
    }
    case "reach": {
      const { runReach } = await import("./commands/reach.ts");
      const target = f.positional[0];
      const ending = str(f, "ending");
      const endings = f.flags.has("endings");
      if (!target && ending === undefined && !endings) throw new Error("届かせたい場所（ファイル#ラベル か ファイル:行）か、--ending 種類か名前、--endings を指定してください");
      const timeout = str(f, "timeout");
      if (timeout !== undefined && !(Number(timeout) > 0)) throw new Error("--timeout には秒（正の数）を指定してください");
      // 届く選び方が見つからなければ 1、行の範囲の外や当たるエンディングが無いなどの誤りは 2
      return await runReach(dir, target ?? "", {
        json: f.flags.has("json"),
        language: lang,
        ...(timeout !== undefined ? { timeoutSeconds: Number(timeout) } : {}),
        ...(ending !== undefined ? { ending } : {}),
        ...(endings ? { endings } : {}),
      });
    }
    case "test": {
      const { runTest } = await import("./commands/test.ts");
      // 失敗したテストか、読めない行があれば 1
      return (await runTest(dir, { paths: f.positional, json: f.flags.has("json"), github: f.flags.has("github"), language: lang })) ? 0 : 1;
    }
    case "rename": {
      const { runRename } = await import("./commands/rename.ts");
      const [kind, from, to] = f.positional;
      if (!kind || from === undefined || to === undefined) {
        console.error(usageOf("rename"));
        return 2;
      }
      return (await runRename(dir, kind, from, to, { lang })) ? 0 : 1;
    }
    case "voice-lock": {
      const { runVoiceLock } = await import("./commands/voice-lock.ts");
      return (await runVoiceLock(dir, Number(str(f, "runs") ?? 8), { clearRerecord: f.flags.has("clear-rerecord") })) ? 0 : 1;
    }
    case "voice-script": {
      const { runVoiceScript } = await import("./commands/voice-script.ts");
      return (await runVoiceScript(dir, str(f, "out"), lang)) ? 0 : 1;
    }
    case "psd": {
      const { runPsd } = await import("./commands/psd.ts");
      const [file, who] = f.positional;
      if (!file || !who) throw new Error("PSD のファイルとキャラクターを指定してください（lim psd yui.psd ユイ）");
      const appearance = str(f, "appearance");
      const folder = str(f, "folder");
      return (await runPsd(dir, file, who, { ...(appearance ? { appearance } : {}), ...(folder ? { folder } : {}) })) ? 0 : 1;
    }
    case "profile": {
      const { runProfile } = await import("./commands/profile.ts");
      const pages = Number(str(f, "pages") ?? 30);
      const wait = Number(str(f, "wait") ?? 500);
      if (!Number.isInteger(pages) || pages < 1) throw new Error("--pages には 1 以上の整数を指定してください");
      if (!Number.isFinite(wait) || wait < 0) throw new Error("--wait には 0 以上のミリ秒を指定してください");
      const target = f.positional[0];
      const out = str(f, "out");
      return (await runProfile(dir, { pages, wait, choose: str(f, "choose")?.split(",").map(Number) ?? [], json: f.flags.has("json"), language: lang, ...(target ? { target } : {}), ...(out ? { out } : {}) })) ? 0 : 1;
    }
    case "stats": {
      const { runStats } = await import("./commands/stats.ts");
      const out = str(f, "out");
      return (await runStats(dir, { json: f.flags.has("json"), language: lang, ...(out ? { out } : {}) })) ? 0 : 1;
    }
    case "update-manifest": {
      const { parseApps, readNotesFile, runUpdateManifest } = await import("./commands/update-manifest.ts");
      const baseUrl = str(f, "base-url");
      if (!baseUrl) throw new Error("--base-url（配るファイルを置く場所の URL）を指定してください");
      const packs = str(f, "pack")?.split(",").map((x) => x.trim()).filter(Boolean);
      const apps = str(f, "app");
      const page = str(f, "page");
      const notes = str(f, "notes");
      const notesFile = str(f, "notes-file");
      const version = str(f, "version");
      const out = str(f, "out");
      return (await runUpdateManifest(dir, {
        baseUrl,
        ...(packs ? { packs } : {}),
        ...(apps ? { apps: parseApps(apps) } : {}),
        ...(page ? { page } : {}),
        ...(notesFile ? { notes: readNotesFile(notesFile) } : notes ? { notes } : {}),
        ...(version ? { version } : {}),
        ...(out ? { out } : {}),
        fresh: f.flags.has("fresh"),
        ...(str(f, "sign-key") ? { signKey: str(f, "sign-key")! } : {}),
        allowTest: f.flags.has("allow-test"),
      }))
        ? 0
        : 1;
    }
    case "update-key": {
      const { runUpdateKey } = await import("./commands/update-key.ts");
      const out = str(f, "out");
      return runUpdateKey(dir, { ...(out ? { out } : {}), force: f.flags.has("force") }) ? 0 : 1;
    }
    case "publish": {
      const { parseOsMap, runPublishSteam } = await import("./commands/publish-steam.ts");
      const { parseItchTargets, parseTargetMap, runPublishItch } = await import("./commands/publish-itch.ts");
      const where = f.positional[0];
      if (where === "itch") {
        const targets = f.positional[1];
        const builds = str(f, "build");
        const channels = str(f, "channel");
        return runPublishItch(dir, {
          ...(targets ? { targets: parseItchTargets(targets) } : {}),
          ...(str(f, "target") ? { target: str(f, "target")! } : {}),
          ...(builds ? { builds: parseTargetMap(builds, "--build") } : {}),
          ...(channels ? { channels: parseTargetMap(channels, "--channel") } : {}),
          ...(str(f, "userversion") ? { userversion: str(f, "userversion")! } : {}),
          allowTest: f.flags.has("allow-test"),
          dryRun: f.flags.has("dry-run"),
        })
          ? 0
          : 1;
      }
      if (where !== "steam") throw new Error("上げる先を指定してください（lim publish steam か lim publish itch。App Store と Google Play は lim build ios --archive・android --aab）");
      const builds = str(f, "build");
      const depots = str(f, "depot");
      const appId = str(f, "app-id");
      if (appId !== undefined && !/^\d+$/.test(appId)) throw new Error("--app-id には数を指定してください");
      const depotIds = depots ? Object.fromEntries(Object.entries(parseOsMap(depots, "--depot")).map(([k, v]) => [k, Number(v)])) : undefined;
      if (depotIds && Object.values(depotIds).some((v) => !Number.isInteger(v) || v <= 0)) throw new Error("--depot のデポ ID は数で書きます");
      return runPublishSteam(dir, {
        ...(builds ? { builds: parseOsMap(builds, "--build") } : {}),
        ...(depotIds ? { depots: depotIds } : {}),
        ...(appId ? { appId: Number(appId) } : {}),
        ...(str(f, "desc") ? { desc: str(f, "desc")! } : {}),
        ...(str(f, "branch") ? { branch: str(f, "branch")! } : {}),
        ...(str(f, "login") ? { login: str(f, "login")! } : {}),
        preview: f.flags.has("preview"),
        allowTest: f.flags.has("allow-test"),
        dryRun: f.flags.has("dry-run"),
      })
        ? 0
        : 1;
    }
    case "patch": {
      const { runPatch } = await import("./commands/patch.ts");
      const base = str(f, "base");
      if (!base) throw new Error("--base（前に書き出したフォルダか zip）を指定してください");
      const id = str(f, "id");
      const out = str(f, "out");
      const variant = str(f, "variant");
      return (await runPatch(dir, { base, force: f.flags.has("force"), allowTest: f.flags.has("allow-test"), ...(id ? { id } : {}), ...(out ? { out } : {}), ...(variant ? { variant } : {}) })) ? 0 : 1;
    }
    case "pack": {
      const { runPack } = await import("./commands/pack.ts");
      const pack = f.positional[0];
      if (!pack) throw new Error("パックのフォルダを指定してください（lim pack packs/dlc1）");
      const encrypt = str(f, "encrypt");
      if (encrypt !== undefined && !["desktop", "browser", "off"].includes(encrypt)) throw new Error("--encrypt には desktop、browser、off のどれかを指定してください");
      return (await runPack(dir, pack, str(f, "out"), encrypt ? { encrypt: encrypt as "desktop" | "browser" | "off" } : {})) ? 0 : 1;
    }
    case "crash": {
      const { runCrash } = await import("./commands/crash.ts");
      const record = f.positional[0];
      if (!record) throw new Error("クラッシュレポートのファイル（JSON）を指定してください");
      const maps = str(f, "maps");
      // 位置を一つも戻せなければ 1（合うソースマップの控えが無いなど）
      return (await runCrash(dir, record, { json: f.flags.has("json"), language: lang, ...(maps !== undefined ? { maps } : {}) })) ? 0 : 1;
    }
    case "clean": {
      const { runClean } = await import("./commands/clean.ts");
      const keep = str(f, "keep");
      if (keep !== undefined && !/^\d+$/.test(keep)) throw new Error("--keep には 0 以上の整数を指定してください");
      const targets = str(f, "target")?.split(",").map((x) => x.trim()).filter(Boolean);
      return runClean(dir, { ...(keep !== undefined ? { keep: Number(keep) } : {}), ...(targets ? { targets } : {}), dryRun: f.flags.has("dry-run") }) ? 0 : 1;
    }
    case "playtest": {
      const { runPlaytest } = await import("./commands/playtest.ts");
      const { playtestWatchFlags } = await import("./playtest-watch.ts");
      const num = (name: string, fallback: number, min: number) => {
        const v = Number(str(f, name) ?? fallback);
        if (!Number.isFinite(v) || v < min) throw new Error(`--${name} には ${min} 以上の数を指定してください`);
        return v;
      };
      return (await runPlaytest(dir, {
        ...(f.positional[0] ? { target: f.positional[0] } : {}),
        build: f.flags.has("rebuild"),
        runs: Math.floor(num("runs", 1, 1)),
        choose: str(f, "choose")?.split(",").map(Number) ?? [],
        maxPages: Math.floor(num("max-pages", 5000, 1)),
        timeoutSeconds: num("timeout", 600, 1),
        stuckSeconds: num("stuck", 20, 1),
        json: f.flags.has("json"),
        language: lang,
        watch: playtestWatchFlags(f),
      }))
        ? 0
        : 1;
    }
    case "size": {
      const { runSize } = await import("./commands/size.ts");
      const top = Number(str(f, "top") ?? 20);
      if (!Number.isInteger(top) || top < 1) throw new Error("--top には 1 以上の整数を指定してください");
      return runSize(dir, { top, json: f.flags.has("json"), ...(f.positional[0] ? { target: f.positional[0] } : {}) }) ? 0 : 1;
    }
    case "unused": {
      const { runUnused } = await import("./commands/unused.ts");
      return (await runUnused(dir, { all: f.flags.has("all"), json: f.flags.has("json") })) ? 0 : 1;
    }
    case "regress": {
      const { runRegress } = await import("./commands/regress.ts");
      const only = str(f, "only");
      const out = str(f, "dir");
      return (await runRegress(dir, { update: f.flags.has("update"), threshold: Number(str(f, "threshold") ?? 0.05), pages: Number(str(f, "pages") ?? 1), ...(only ? { only } : {}), ...(out ? { dir: out } : {}) })) ? 0 : 1;
    }
    case "script-export": {
      const { runScriptExport } = await import("./commands/proofread.ts");
      const format = str(f, "format");
      const out = str(f, "out");
      return (await runScriptExport(dir, { ...(format ? { format } : {}), ...(out ? { out } : {}), lines: f.flags.has("lines"), ...(lang === "en" ? { language: "en" as const } : {}) })) ? 0 : 1;
    }
    case "prose": {
      const { runProseApply, runProseExtract } = await import("./commands/proofread.ts");
      const [action, ...files] = f.positional;
      if (action === "extract") {
        const out = str(f, "out");
        const ruby = str(f, "ruby");
        return (await runProseExtract(dir, files, { ...(out ? { out } : {}), ...(ruby ? { ruby } : {}), ...(lang === "en" ? { language: "en" as const } : {}) })) ? 0 : 1;
      }
      if (action === "apply") return (await runProseApply(dir, files[0] ?? "", { check: f.flags.has("check") })) ? 0 : 1;
      throw new Error("lim prose extract か lim prose apply と書きます");
    }
    case "screens": {
      const { runScreens } = await import("./commands/screens.ts");
      const [action, screen] = f.positional;
      const parts = str(f, "part")?.split(",").map((x) => x.trim()).filter(Boolean);
      return runScreens(dir, action, screen, { ...(parts ? { parts } : {}), force: f.flags.has("force"), js: f.flags.has("js"), json: f.flags.has("json") }) ? 0 : 1;
    }
    case "fmt": {
      const { runFmt } = await import("./commands/fmt.ts");
      return (await runFmt(dir, f.flags.has("check"), str(f, "indent"))) ? 0 : 1;
    }
    case "migrate": {
      const { runMigrate } = await import("./commands/migrate.ts");
      // --check は書き換えずに、移すものがあれば 1。--keep-behavior は値を省くと、戻せるものすべて
      const keep = f.flags.get("keep-behavior");
      const keepBehavior = keep === undefined ? undefined : keep === true ? true : keep.split(",").map((x) => x.trim()).filter(Boolean);
      return (await runMigrate(dir, { check: f.flags.has("check"), json: f.flags.has("json"), language: lang, ...(keepBehavior !== undefined ? { keepBehavior } : {}) })) ? 0 : 1;
    }
    case "coverage": {
      const { runCoverage } = await import("./commands/coverage.ts");
      const minLines = str(f, "min-lines");
      if (minLines !== undefined && !(Number(minLines) >= 0 && Number(minLines) <= 100)) throw new Error("--min-lines には 0 から 100 の割合（%）を指定してください");
      return (await runCoverage(dir, Number(str(f, "runs") ?? DEFAULT_COVERAGE_RUNS), Number(str(f, "seeds") ?? 1), Number(str(f, "route-runs") ?? 8), {
        json: f.flags.has("json"),
        github: f.flags.has("github"),
        requireEndings: f.flags.has("require-endings"),
        ...(minLines !== undefined ? { minLines: Number(minLines) } : {}),
      }))
        ? 0
        : 1;
    }
    case "dev": {
      const { runDev } = await import("./commands/dev.ts");
      await runDev(dir, Number(str(f, "port") ?? process.env.PORT ?? 5180));
      return -1; // 開発サーバーは止めるまで動かし続ける
    }
    case "studio": {
      const { runStudio } = await import("./commands/studio.ts");
      await runStudio(dir, Number(str(f, "port") ?? process.env.PORT ?? 5180));
      return -1;
    }
    case "shot": {
      const { playtestWatchFlags } = await import("./playtest-watch.ts");
      const { runShot } = await import("./commands/shot.ts");
      const { runListScreens, runShotScreen } = await import("./commands/shot-screen.ts");
      const { VIDEO_DEFAULTS } = await import("./commands/shot-video.ts");
      const { parseChoose } = await import("./commands/trace.ts");
      // 標準の画面を作り物の中身で撮る（--screen）、その一覧（--screens）。shot-screen.ts
      const screen = str(f, "screen");
      const portrait = f.flags.has("portrait");
      const landscape = f.flags.has("landscape");
      if (f.flags.has("screens")) return runListScreens(dir, { json: f.flags.has("json"), lang }) ? 0 : 1;
      if (screen !== undefined) {
        if (f.positional.length > 0 || f.flags.has("title") || f.flags.has("video") || f.flags.has("skip")) throw new Error("--screen には開始位置、--title、--video、--skip を付けません（標準の画面を作り物の中身で撮ります）");
        if (portrait && landscape) throw new Error("--portrait と --landscape は一緒に使えません");
        const state = str(f, "state") ?? "filled";
        const theme = str(f, "theme");
        const language = str(f, "lang");
        const evalJs = str(f, "eval");
        return (await runShotScreen(dir, {
          ...(evalJs ? { evalJs } : {}),
          screen,
          state: state as ScreenSampleState,
          ...(portrait ? { orientation: "portrait" as const } : landscape ? { orientation: "landscape" as const } : {}),
          ...(language !== undefined ? { language } : {}),
          ...(theme !== undefined ? { theme } : {}),
          out: str(f, "out") ?? `screen-${screen}.png`,
          json: f.flags.has("json"),
          lang,
        }))
          ? 0
          : 1;
      }
      if (f.flags.has("state") || portrait || landscape || f.flags.has("theme")) throw new Error("--state、--portrait、--landscape、--theme は --screen と一緒に使います");
      const title = f.flags.has("title");
      const target = f.positional[0];
      if (!title && !target) throw new Error("開始位置か --title を指定してください");
      const evalJs = str(f, "eval");
      const language = str(f, "lang");
      const video = f.flags.get("video");
      if (video !== undefined && title) throw new Error("--video はタイトル画面では使えません（開始位置を指定します）");
      const split = str(f, "split");
      const until = str(f, "until");
      const redoText = str(f, "redo");
      if (video === undefined && (split !== undefined || until !== undefined || f.flags.has("resume") || f.flags.has("auto") || redoText !== undefined)) throw new Error("--split、--until、--resume、--redo、--auto は --video と一緒に使います");
      const redo = redoText === undefined ? undefined : Number(redoText);
      if (redo !== undefined && !(Number.isInteger(redo) && redo >= 1)) throw new Error("--redo には録り直す区切りの番号（001 や 2）を指定してください");
      if (split !== undefined && split !== "file" && split !== "chapter") throw new Error("--split には file（ファイルごと）か chapter（章ごと）を指定してください");
      // --split か --until を付けたら、既定は終わりまで録る
      const pagesText = str(f, "pages") ?? (split !== undefined || until !== undefined ? "all" : String(VIDEO_DEFAULTS.pages));
      const pages = pagesText === "all" ? Infinity : Number(pagesText);
      const read = Number(str(f, "read") ?? VIDEO_DEFAULTS.readMs);
      const stuck = Number(str(f, "stuck") ?? VIDEO_DEFAULTS.stuckSeconds);
      if (video !== undefined && pages !== Infinity && (!Number.isInteger(pages) || pages < 1)) throw new Error("--pages には 1 以上の整数か all を指定してください");
      if (video !== undefined && (!Number.isFinite(read) || read < 0)) throw new Error("--read には 0 以上のミリ秒を指定してください");
      if (video !== undefined && (!Number.isFinite(stuck) || stuck <= 0)) throw new Error("--stuck には 0 より大きい秒数を指定してください");
      const avoid = playtestWatchFlags(f);
      return (await runShot(dir, {
        target: target ?? "",
        skip: Number(str(f, "skip") ?? 1),
        out: str(f, "out") ?? (title ? "title.png" : "shot.png"),
        waitMs: Number(str(f, "wait") ?? 0),
        settle: f.flags.has("settle"),
        ...(evalJs ? { evalJs } : {}),
        title,
        intro: f.flags.has("intro"),
        ...(language !== undefined ? { language } : {}),
        // --video は値なしなら video.mp4（--split なら video フォルダ）
        ...(video !== undefined
          ? {
              video: {
                out: video === true ? (split !== undefined ? "video" : "video.mp4") : video,
                pages,
                readMs: read,
                auto: f.flags.has("auto"),
                choose: parseChoose(str(f, "choose")),
                split: split ?? "none",
                ...(until !== undefined ? { until } : {}),
                resume: f.flags.has("resume"),
                ...(redo !== undefined ? { redo } : {}),
                stuckSeconds: stuck,
                audio: !f.flags.has("no-audio"),
                showLine: f.flags.has("line"),
                avoidChoices: avoid.avoidChoices ?? [],
                avoidEndings: avoid.avoidEndings ?? [],
              },
            }
          : {}),
      }))
        ? 0
        : 1;
    }
    case "build": {
      const { runBuild } = await import("./commands/build.ts");
      const what = (f.positional[0] ?? "browser").toLowerCase();
      const aliases: Record<string, BuildTarget> = { browser: "browser", web: "browser", mac: "mac", macos: "mac", darwin: "mac", windows: "windows", win: "windows", linux: "linux", android: "android", ios: "ios", iphone: "ios" };
      // all は Mac・Windows・Linux とブラウザ。「mac,windows」のように , で並べてもよい
      const targets: BuildTarget[] | null = what === "all" ? ["browser", "mac", "windows", "linux"] : what.split(",").every((w) => aliases[w]) ? [...new Set(what.split(",").map((w) => aliases[w]!))] : null;
      if (!targets) throw new Error(`書き出し先 ${what} はありません（browser / mac / windows / linux / android / ios / all。「,」で区切って複数指定できます）`);
      const seed = str(f, "seed");
      const seedTitle = str(f, "seed-title");
      const seedId = str(f, "seed-id");
      const ok = await runBuild(dir, {
        targets: [...targets],
        import: !f.flags.has("no-import"),
        verify: !f.flags.has("no-verify"),
        ...(str(f, "steam") ? { steam: str(f, "steam")! } : {}),
        ...(str(f, "variant") ? { variant: str(f, "variant")! } : {}),
        // テスト版（遊びながらその場面に指摘を残す口を入れる。liminalia.json の build.feedback）
        ...(f.flags.has("feedback") ? { feedback: true } : {}),
        // 使っている素材だけを入れる（liminalia.json の build.onlyUsed と同じ）
        ...(f.flags.has("only-used") ? { onlyUsed: true } : {}),
        ...(f.flags.has("device") ? { device: str(f, "device") ?? (true as const) } : {}),
        ...(f.flags.has("aab") ? { aab: true } : {}),
        ...(f.flags.has("archive") || f.flags.has("upload") ? { iosArchive: { method: iosExportMethod(str(f, "export")), upload: f.flags.has("upload") } } : {}),
        // 配る形: --zip は Mac 版とブラウザ版の zip、--dmg は Mac 版の dmg（書かなければ liminalia.json の build.mac・build.browser）
        ...(f.flags.has("zip") || f.flags.has("dmg") ? { packaging: { ...(f.flags.has("zip") ? { macZip: true, browserZip: true } : {}), ...(f.flags.has("dmg") ? { macDmg: true } : {}) } } : {}),
        ...(seed
          ? {
              seed: {
                target: seed,
                slot: Number(str(f, "seed-slot") ?? 0),
                mode: str(f, "seed-mode") === "fresh" ? ("fresh" as const) : ("successful_route" as const),
                overwrite: f.flags.has("seed-overwrite"),
                ...(seedTitle ? { title: seedTitle } : {}),
                ...(seedId ? { id: seedId } : {}),
              },
            }
          : {}),
      });
      return ok ? 0 : 1;
    }
    default:
      console.error(`lim: ${command} というコマンドはありません`);
      console.log(USAGE);
      return 2;
  }
}

/** --export の書き方（app-store・ad-hoc・development。省くと app-store）。 */
function iosExportMethod(v: string | undefined): IosExportMethod {
  if (v === undefined) return "app-store";
  if (v === "app-store" || v === "ad-hoc" || v === "development") return v;
  throw new Error(`--export には app-store、ad-hoc、development のどれかを指定してください: ${v}`);
}

try {
  const code = await main(process.argv.slice(2));
  // パイプに大きく書いた直後に終了すると末尾が切れる（--json など）ので、書き終わるのを待ってから終える。
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
  if (code >= 0) process.exit(code);
} catch (e) {
  console.error(`lim: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}
