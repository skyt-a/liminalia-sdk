import { readBody } from "./request-body.ts";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { containedPath } from "@liminalia/project/contained-path";
import { exportScriptText, exportVoiceScript, loadProject, STD_PLUGIN, type Project } from "@liminalia/project";
import { applyTranslationTable, translationToCsv, translationToXliff, type TranslationFile } from "@liminalia/lang";
import { DEFAULT_COVERAGE_RUNS, type Value } from "@liminalia/runtime";
import type { Plugin, ViteDevServer } from "vite";
import { PLAY_FROM_ROUTE, STUDIO_API, STUDIO_EVENT, STUDIO_LANGUAGE_HEADER, STUDIO_PAGE, STUDIO_PLUGIN_API, STUDIO_WINDOW_HEADER, type DataWriteRequest, type PartFileName, type PartFileWriteRequest, type PluginList, type PluginPart, type ProfileRequest, type ShotRequest, type ReloadResult, type ReviewAction, type SearchRequest, type StudioEvent, type WriteRequest, type CoverageEvent, type UndoJournalApply, type UndoJournalState } from "../protocol.ts";
import { ASSET_LIMIT, DataStore } from "./data-store.ts";
import {
  assetUsage,
  assetFolderToReveal,
  scenarioFileToReveal,
  assetFileToReveal,
  castBackup,
  castBackups,
  castUsage,
  partHistory,
  partHistoryItem,
  readPartFile,
  writePartFile,
  createScenario,
  duplicateScenario,
  listAssets,
  listVariables,
  makeAssetFolder,
  renameAsset,
  renameCast,
  renameScenario,
  renameVariable,
  renameMacro,
  restoreTrash,
  listTrash,
  listPlugins,
  readTranslation,
  setExtra,
  readSettings,
  restartNeeded,
  setSettings,
  setLanguages,
  setPlugins,
  configListHash,
  applyThemeUndoable,
  readUiCss,
  setUiCssRules,
  writeUiCss,
  configPartHash,
  createPlugin,
  catalogPlugins,
  installPlugin,
  localPluginDir,
  updatePlugin,
  setUi,
  setVariable,
  translationContext,
  translationStatus,
  writeTranslation,
  trashAsset,
  trashAssets,
  trashScenario,
} from "./manage.ts";
import { renameLabel } from "./labels.ts";
import { moveScenes } from "./scene-move.ts";
import { addSampleAssets } from "./samples.ts";
import { servePlaceholder } from "./missing-placeholder.ts";
import { assetRequests, assetRequestsCsv, writeAssetRequests } from "./asset-requests.ts";
import { sceneSpeakers } from "../model/map-filter.ts";
import { searchProject } from "./search.ts";
import { macroUses } from "./macros.ts";
import { sweepRange } from "../sweep.ts";
import { isOwnSharedWrite, readStudioState, STUDIO_SHARED_FILE, writeStudioState } from "./studio-state.ts";
import { applyReview, feedbackShot, importFeedback, listReviews, REVIEWS_DIR } from "./reviews.ts";
import { StudioError, StudioWorkspace } from "./workspace.ts";
import { voiceList } from "./voices.ts";
import { listUiThemes } from "@liminalia/project";
import { speakerLines } from "./speaker-lines.ts";
import { saveTheme, trashTheme } from "./themes.ts";
import { addScreenScript, copyScreenUndoable, readScreenFiles, resetScreenUndoable, screenDiff, writeScreenFile } from "./screen-files.ts";
import { screenTable, screenTemplateRules } from "./screens.ts";
import { commandDefaultsHash, readCommandDefaults, setCommandDefaults } from "./command-defaults.ts";
import { catalogDir } from "./catalog.ts";
import { PluginHost } from "./plugin-host.ts";
import { ignoreVariant, textReport, unignoreVariant } from "./stats.ts";
import { readScenes, setCheckSeverity, setSceneInfo } from "./check-config.ts";
import { browserProvider } from "./browser.ts";
import { profileEvents } from "./profile.ts";
import { readShot, takePlayShot, takeShot, type PlayShotRequest } from "./shot.ts";
import { readRegressImage, regressEvents } from "./regress.ts";
import { lockVoices } from "./voice-lock.ts";
import { closeSignal, statusOf, streamLines } from "./stream.ts";
import { resolveShotTarget } from "./target.ts";
import { playFromPage, PlayFromStore } from "./play-from.ts";
import { localizedError, rememberLanguage } from "./errors-en.ts";
import { revealFileCommand } from "./reveal-file.ts";

export { HISTORY_DIR, HISTORY_KEEP, setSweepPause, StudioWorkspace, StudioError, categoryOf, hashText, writeAtomic } from "./workspace.ts";
// MCP の fmt が、制作画面の書き込みの口を通らないパックの台本の前の版を、同じ変更履歴に残すのに使う
export { keepVersion } from "./versions.ts";
// AI の MCP（packages/cli の mcp-studio.ts）が、制作画面と同じ規則と履歴で読み書きするのに使う
export { setScreenTable, setScreenTemplateRules } from "./screens.ts";
export { assetUsage, configPartHash, listVariables, readSettings, readTranslation, renameAsset, renameCast, renameMacro, renameScenario, renameVariable, setSettings, setUiStringTable, setVariable, translationContext, writeTranslation } from "./manage.ts";
export { renameLabel } from "./labels.ts";
export { englishServerText } from "./errors-en.ts";
export { searchProject } from "./search.ts";
export { textReport } from "./stats.ts";

/**
 * 制作画面の、開発サーバー側（lim studio・lim dev のときだけ。書き出しには入らない）。口の形は ../protocol.ts。
 *
 *   GET  STUDIO_PAGE                      画面（packages/web/studio.html）
 *   GET  STUDIO_API/project               ProjectInfo
 *   GET  STUDIO_API/file?file=            FileText
 *   PUT  STUDIO_API/file                  WriteRequest → WriteResult（200。書いたあとの全体の検査つき）・WriteConflict（409）
 *   POST STUDIO_API/search                SearchRequest → SearchResult（全体の検索。本文だけ・正規表現・ひらがなとカタカナ・大文字と小文字。./search.ts）
 *   GET  STUDIO_API/history?file=         HistoryEntry[]（新しい順）
 *   GET  STUDIO_API/history/item?file=&id=  FileText（その版）
 *   POST STUDIO_API/check                 CheckResult
 *   POST STUDIO_API/coverage              CoverageResult（本文 { runs } で流す回数の上限を変えられる。既定 8）
 *   GET  STUDIO_API/sweep?file=[&from=&to=]  Sweep（from・to で行の範囲を絞れる。受け付けるなら gzip で返す）
 *   GET  STUDIO_API/sweep/stage?file=     StageTrack（持続の帯。ファイル全体。受け付けるなら gzip で返す）
 *   GET  STUDIO_API/sweep/reach?file=&line=[&from=&to=]  SweepReach（その行に届く現在地。今の道筋で届かなければ、届く道筋を探して作り直す。
 *                                         ほかの行を頼まれた・.lim が変わった・頼みが切れたら探すのをやめて cancelled）
 *   POST STUDIO_API/reload                ReloadResult（外で変わった作品を読み直す。設定か命令のプラグインが変わっていたら起動し直しを求める）
 *   GET  STUDIO_API/data?name=            DataText（作品のデータの .json。プラグインの画面が使う）
 *   PUT  STUDIO_API/data                  DataWriteRequest → { ok: true, … }（200）・{ ok: false, current }（409）
 *   POST STUDIO_API/asset?kind=&path=[&overwrite=1]  本文はファイルそのもの → AssetUploadResult（同じ名前があれば 409）
 *   GET  STUDIO_API/assets/list           AssetFolderListing[]（素材のフォルダごとのファイルの大きさと、中のフォルダ）
 *   GET  STUDIO_API/assets/usage          AssetUsage（素材を使っている場所）
 *   POST STUDIO_API/assets/rename         AssetRenameRequest → AssetRenameResult（参照している台本の行とキャストも書き換える）
 *   POST STUDIO_API/assets/trash          AssetTrashRequest → AssetTrashResult（.liminalia/trash へ動かす）
 *   POST STUDIO_API/assets/trash-many     AssetTrashManyRequest → AssetTrashResult（ファイルをまとめて一つの id でごみ箱へ）
 *   POST STUDIO_API/assets/restore        { id } → { restored }（ごみ箱から戻す）
 *   GET  STUDIO_API/trash                 TrashEntry[]（ごみ箱の中身。新しい順。何を、いつ入れたか）
 *   GET  STUDIO_API/voices                VoiceList（台詞ごとのボイスのファイルと状態。lim voice-script と同じ決まり）
 *   POST STUDIO_API/assets/folder         { kind, path } → { ok: true }（素材のフォルダの中にフォルダを作る）
 *   POST STUDIO_API/files/create          { file, text? }（シナリオのファイルを作る。あれば 409）
 *   POST STUDIO_API/assets/requests       → AssetRequestsResult（素材の依頼表を exports/asset-requests.csv に書く。./asset-requests.ts）
 *   GET  STUDIO_API/assets/requests.csv   素材の依頼表の CSV（ブラウザの「ダウンロード」。?lang=en で英語の見出し）
 *   POST STUDIO_API/assets/samples        → SampleAssetsResult（ひな形のサンプル素材（CC0）を素材のフォルダへ写す。同じ名前は写さない。./samples.ts）
 *   POST STUDIO_API/files/duplicate       { from, to }（写す）
 *   POST STUDIO_API/files/rename          { from, to } → ScenarioRenameResult（飛び先も書き換える）
 *   POST STUDIO_API/labels/rename         { file, from, to } → LabelRenameResult（シーンの名前と、ラベルを持つ場所を書き換える）
 *   GET  STUDIO_API/map/cast              SceneCast（シーンごとの話者。フローチャートの人物の絞り込み）
 *   GET  STUDIO_API/macro/uses?name=      MacroUse[]（そのマクロを使う行。./macros.ts）
 *   GET  STUDIO_API/coverage              CoverageResult | null（前に実行した全ルートテストの結果。.liminalia/coverage.json）
 *   POST STUDIO_API/coverage/stream       { runs? } → CoverageEvent を一行ずつ（経過と結果）
 *   POST STUDIO_API/scenes/move           { file, labels, to } → SceneMoveResult（シーンを別のファイルへ移す。ジャンプ先も書き換える）
 *   POST STUDIO_API/files/trash           { file } → AssetTrashResult（ごみ箱へ。戻すのは /assets/restore）
 *   GET  STUDIO_API/settings / POST /settings  { settings, hash } / { settings, baseHash } → { ok, hash, restart }（liminalia.json の基本と書き出しの項目）
 *   GET  STUDIO_API/extra / POST /extra     { extra, hash } / { extra, baseHash } → PartWrite（liminalia.json の extra。おまけの一覧）。GET は shown（シナリオが出す画像）も返す
 *   GET  STUDIO_API/i18n                  TranslationStatus（遊べる言語と訳の進み具合）
 *   GET  STUDIO_API/i18n/file?lang=       TranslationView（今の台本に合わせた訳と、ファイルの hash）／PUT { lang, file, baseHash } → PartWrite で書く
 *   POST STUDIO_API/i18n/languages        { languages, baseHash } → PartWrite（liminalia.json の languages。baseHash は GET /i18n の hash）
 *   POST STUDIO_API/i18n/export           { lang, format: csv|xliff } → { path }（exports/translation に書いて開く）
 *   POST STUDIO_API/i18n/import           { lang, text } → { applied, changedSource, unknown }（表か XLIFF の訳を書き戻す）
 *   POST STUDIO_API/voice-script          → { folder, lines, speakers, missing }（収録用の台本を exports/voice-script に書いて開く）
 *   GET  STUDIO_API/plugins / POST /plugins  PluginList／{ plugins, baseHash } → PartWrite（liminalia.json の plugins。起動し直すと効く）
 *   POST STUDIO_API/plugins/create        { name, parts } → { spec }（plugins/<name> に例の入ったプラグインを作って足す）
 *   POST STUDIO_API/plugins/update        { spec, name?, description? }（作品の中のプラグインの package.json）
 *   POST STUDIO_API/plugins/reveal        { spec }（作品の中のプラグインのフォルダを OS のファイルの画面で開く）
 *   GET  STUDIO_API/plugins/catalog       CatalogPluginInfo[]（同梱の公式のプラグインの一覧と、入れてあるか。./catalog.ts）
 *   POST STUDIO_API/plugins/install       { id } → CatalogInstallResult（plugins/<id> に写して足す。入れてあれば入れ直す）
 *   GET  STUDIO_API/ui                    { ui, hash }（liminalia.json の ui。ゲームの見た目と操作の設定）
 *   POST STUDIO_API/ui                    { ui, baseHash } を書く → PartWrite（形が誤っていれば 400。空なら外す）
 *   （settings・extra・ui・i18n/file・i18n/languages・plugins の書き込みは、読んだあとにその部分がほかで変わっていれば書かずに 409 で今の中身を返す）
 *   GET  STUDIO_API/command-defaults      { defaults }（liminalia.json の commandDefaults。作品ごとのコマンドの既定値）
 *   POST STUDIO_API/command-defaults      { defaults } を書く（無いコマンド・パラメータ・型の誤りは 400。空なら外す）
 *   GET  STUDIO_API/ui/themes             UiThemePreset[]（用意したテーマと作品の中のテーマ）
 *   GET  STUDIO_API/screens               ScreenInfo[]（標準の画面の一覧と、ゲームの画面の見本で開けるか。setScreenTable で渡されたもの）
 *   GET  STUDIO_API/screens/rules         ScreenTemplateRules | null（テンプレートで作れる画面の決まり。setScreenTemplateRules で渡されたもの）
 *   GET  STUDIO_API/screens/files?screen= ScreenFiles（作品のテンプレートと画面の JS、登録しているか、先に差し替えるプラグイン。./screen-files.ts）
 *   GET  STUDIO_API/screens/diff?screen=  ScreenDiffInfo（標準との違い。lim screens diff と同じ）
 *   POST STUDIO_API/screens/copy          { screen, parts? } → ScreenCopyResult（標準のテンプレートを写して登録する。lim screens copy と同じ）
 *   POST STUDIO_API/screens/script        { screen } → { file, text }（画面の JS の雛形を置く。lim screens js と同じ）
 *   PUT  STUDIO_API/screens/file          { screen, kind, text, before } テンプレートか画面の JS を丸ごと書く（読んだあとに変わっていれば 409）
 *   POST STUDIO_API/screens/reset         { screen } → ScreenResetResult（標準に戻す。ファイルは名前を変えて残す。lim screens reset と同じ）
 *   POST STUDIO_API/ui/theme              { id } のテーマを当てる（素材を写し ui を書く）。{ ui } を返す
 *   POST STUDIO_API/ui/theme/save         { name, overwrite? } 今の見た目を themes/<id>/theme.json に書く → ThemeSaveResult（同じ名前があり overwrite でなければ 409）
 *   POST STUDIO_API/ui/theme/trash        { id } 作品のテーマを .liminalia/trash/ へ（戻すのは /assets/restore）→ AssetTrashResult
 *   GET  STUDIO_API/ui/css                { file, text, assets? }（部品の欄と CSS の欄が書く作品の CSS のファイル）
 *   PUT  STUDIO_API/ui/css                { text, before, file? } そのファイルを丸ごと書く（無ければ作って ui.css に足す。読んだあとに中身か書く先が変わっていれば 409）
 *   POST STUDIO_API/ui/css-rule           { edits } 「セレクタ { 性質: 値; }」の行を書く → { file, text }
 *   GET  STUDIO_API/variables             VariableInfo[]（台本で使っている変数と初期値）
 *   POST STUDIO_API/variables/set         { path, value, create?: true } か { path, remove: true }（create は追加のみ。liminalia.json の variables）
 *   POST STUDIO_API/variables/rename      { from, to } → { files }（台本の読む・書く場所と初期値の名前を書き換える）
 *   POST STUDIO_API/macros/rename         { from, to, file? } → MacroRenameResult（@define と呼び出し、本文の {@マクロ}、commandDefaults の鍵を書き換える。同じ名前が二つ以上なら file で選ぶ）
 *   GET  STUDIO_API/cast/usage            CastUsage（キャスト名・話者名を使っている場所）
 *   GET  STUDIO_API/cast/lines            ?speaker=&speaker= → SpeakerLine[]（その話者たちの台詞。ファイル順）
 *   POST STUDIO_API/cast/rename           CastRenameRequest → CastRenameResult（台本の参照と cast.json を書き換える）
 *   GET  STUDIO_API/part-file?part=       FileText（設定のファイル。"@config" は liminalia.json、"@lang/<言語>" は訳。無い訳は空の文字）
 *   PUT  STUDIO_API/part-file             PartFileWriteRequest → PartFileWrite（元に戻す・変更履歴から戻す。読んだあとに変わっていれば 409）
 *   GET  STUDIO_API/part-file/history?part=  HistoryEntry[]（その設定のファイルの変更履歴。新しい順）
 *   GET  STUDIO_API/part-file/history/item?part=&id=  FileText（変更履歴の一つの内容。id が current なら今の中身）
 *   GET  STUDIO_API/cast/backups          HistoryEntry[]（cast.json の変更履歴。新しい順）
 *   GET  STUDIO_API/cast/backups/item     ?id= → FileText（変更履歴の一つの内容。id が current なら今の cast.json）
 *   GET  STUDIO_API/studio-state          StudioState（制作画面のデータ。共有するものは .liminalia/shared.json、ほかは .liminalia/studio.json）／PUT { state } で書く
 *   GET  STUDIO_API/reviews               ReviewList（レビューのコメント。reviews/ のスレッドと、書くときの名前）
 *   POST STUDIO_API/reviews               ReviewAction → ReviewList（コメントを足す・返信・解決・削除・付け直し）
 *   POST STUDIO_API/reviews/import        { files: { name, data }[] } → FeedbackImportResult（テスト版の指摘をコメントに取り込む。./reviews.ts）
 *   GET  STUDIO_API/reviews/shot          ?path=shots/… 指摘に付いたスクリーンショット
 *   *    STUDIO_API/plugin/<name>/<path>  作品のプラグインの "./studio-server" の口（../server-plugin.ts。見出し STUDIO_PLUGIN_HEADER が要る）
 *   GET  STUDIO_API/stats                 TextReport（文字数と表記ゆれの候補）
 *   POST STUDIO_API/stats/ignore          { id }（表記ゆれの組を liminalia.json の stats.variants.ignore に足す）
 *   POST STUDIO_API/stats/unignore        { id }（除外を取り消す。stats.variants.ignore から外す）
 *   POST STUDIO_API/shot                  ShotRequest → ShotResult（舞台の画面を作品の大きさで撮り、exports/shots に書く。./shot.ts）
 *   GET  STUDIO_API/shots/file?name=      exports/shots の PNG（ブラウザの「ダウンロード」）
 *   POST STUDIO_API/shot/play             { start?, skip?, title?, lang? } → PNG（lim shot と同じ撮り方。ファイルには書かない。AI の MCP の screenshot）
 *   GET  STUDIO_API/server                { root, pid }（作品の読み込みを待たずに答える。AI の MCP が開いている制作画面を確かめる。./running.ts）
 *   POST STUDIO_API/play-from             PlayFromOffer → { id }（VS Code の拡張機能が組み立てた「ここから遊ぶ」のセーブを預かる。./play-from.ts）
 *   GET  STUDIO_API/play-from?id=&start=[&skip=]  預かったセーブを localStorage に置いてプレイヤーへ移るページ（無ければ ?start=&skip= へ）
 *   POST STUDIO_API/voice-lock            → VoiceLockResult（連番のボイスの番号を固定する。lim voice-lock と同じ。./voice-lock.ts）
 *   POST STUDIO_API/regress               { update?, threshold? } → RegressEvent を一行ずつ（x-ndjson。lim regress と同じ見た目の確かめ。./regress.ts）
 *   GET  STUDIO_API/regress/file?kind=&name=  .liminalia/regress の baseline・current・diff の PNG
 *   POST STUDIO_API/profile               ProfileRequest → ProfileEvent を一行ずつ（x-ndjson。lim profile と同じ計測。./profile.ts）
 *
 * 画面写真と重さの計測は、画面なしのブラウザ（./browser.ts。lim studio は Playwright と Chromium、デスクトップ版はアプリの Electron）で
 * この開発サーバーのプレイヤーを開く。Chromium が見つからなければ CHROMIUM_MISSING_STATUS で断る。
 *
 * シナリオのフォルダと cast.json・データのフォルダを見張り、外の変更を Vite の WebSocket のカスタムイベント STUDIO_EVENT で送る。
 * 素材のフォルダも見張り、ファイルが増えた・減ったら assets-changed を送る。
 * 書き込みは、立ち絵の位置調整画面（packages/web/src/caster/server.ts）と同じく、同じオリジンからの要求だけを受ける。
 */
/**
 * 制作画面のページ（非公開の src/client にある。npm で入れた lim には無い）の場所。無ければ null。
 * スマホ版は Service Worker の中でこのモジュールを動かす（import.meta.url が file: ではない）ので、読み込んだときには求めず、
 * file: でなければ null にする。あれば使うものなので、配る形の組み立て（scripts/npm-pack-public.mjs の packageItems）が
 * たどる new URL("…", import.meta.url) の形にもしない。
 */
function studioHtmlPath(): string | null {
  if (!import.meta.url.startsWith("file:")) return null;
  const path = join(dirname(fileURLToPath(import.meta.url)), "..", "client", "studio.html");
  return existsSync(path) ? path : null;
}

/** 制作画面が入っていないときに返すページ（ブラウザの言語が日本語でなければ英語）。 */
export function studioMissingPage(lang: "ja" | "en"): string {
  const [title, body] =
    lang === "en"
      ? ["Liminalia Studio isn't included", "This lim doesn't include the authoring screen (Liminalia Studio). Use the Liminalia Studio app, or write <code>.lim</code> files in your editor and play them on the game page that <code>lim dev</code> shows."]
      : ["制作画面は入っていません", "この lim には制作画面（Liminalia Studio）が入っていません。制作アプリ（Liminalia Studio）を使うか、エディタで <code>.lim</code> を書いて、<code>lim dev</code> が出すゲームのページで遊んでください。"];
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p><p><a href="https://liminalia.skyta.dev/${lang === "en" ? "en/" : ""}download/">Liminalia Studio</a></p></body></html>`;
}

const languageOf = (req: IncomingMessage): "ja" | "en" => (/^ja\b/i.test(String(req.headers["accept-language"] ?? "ja")) ? "ja" : "en");

// webRoot は前は制作画面のページ（studio.html）を読むのに使っていた（今は studioHtmlPath）。呼ぶ側（packages/web/vite.config.ts）との形のために残す
export function studioServer(project: Project, _webRoot: string): Plugin {
  let workspace: Promise<StudioWorkspace> | null = null;
  /** 命令のプラグインを読んだときのコードの様子（読み直しで、起動し直しが要るかを見る）。 */
  let plugins: string | null = null;
  const data = new DataStore(project);
  const playFrom = new PlayFromStore();
  /** 台本を書いたことを画面へ送る口（configureServer で Vite の WebSocket につなぐ）。 */
  let announce: (e: StudioEvent) => void = () => undefined;
  /**
   * 読んだ作品を覚える。読めなかったら覚えない（cast.json などを直せば、次の頼みで読み直す。マージの途中の衝突の印で読めないときなど）。
   * 前は読めなかったものも覚えていて、直しても開発サーバーを起動し直すまで、読み直し（POST /reload）を含むすべての頼みが失敗していた。
   */
  const remember = (p: Promise<StudioWorkspace>): Promise<StudioWorkspace> => {
    const kept: Promise<StudioWorkspace> = p.catch((e: unknown) => {
      if (workspace === kept) workspace = null;
      throw e;
    });
    workspace = kept;
    return kept;
  };
  /** 記録に出す口（configureServer で Vite の記録につなぐ）。 */
  let note: (text: string) => void = (text) => console.warn(text);
  const open = () => {
    if (workspace) return workspace;
    const started = Date.now();
    return remember(
      StudioWorkspace.open(project).then((ws) => {
        plugins ??= pluginStamp(project);
        ws.announce = (e) => announce(e);
        // 初めて開くときに長くかかったら、どこで待ったかを記録に残す（制作アプリは、答えが届くまで「開いています」で待つ）
        const total = Date.now() - started;
        if (total >= SLOW_OPEN_MS) {
          const own = ws.openTimes.plugins + ws.openTimes.files;
          note(`Studio: プロジェクトを開くのに ${seconds(total)} 秒かかりました（プラグインの読み込み ${seconds(ws.openTimes.plugins)} 秒、ファイルの読み込み ${seconds(ws.openTimes.files)} 秒、ほかの処理を待った時間 ${seconds(Math.max(0, total - own))} 秒）`);
        }
        return ws;
      }),
    );
  };
  let host: PluginHost | null = null;
  /** 重さを計っている間（一度に一つ）。 */
  let profiling = false;
  return {
    name: "liminalia-studio",
    apply: "serve",
    async closeBundle() {
      await host?.dispose();
    },
    configureServer(server) {
      announce = (e) => server.ws.send({ type: "custom", event: STUDIO_EVENT, data: e });
      note = (text) => {
        try {
          server.config.logger.warn(text, { timestamp: true });
        } catch {
          // 記録の口の無い偽の開発サーバー（試験）では標準エラーへ
          console.warn(text);
        }
      };
      // プレイヤーが頼んだ無い画像は、名前の札を返す（プレビューとテストプレイ。書き出しは止める。./missing-placeholder.ts）
      server.middlewares.use((req, res, next) => {
        if (!servePlaceholder(project, req, res)) next();
      });
      watch(server, project, open, data);
      host = new PluginHost({
        project,
        workspace: open,
        data,
        load: (entry) => server.ssrLoadModule(entry),
        send: (e) => server.ws.send({ type: "custom", event: STUDIO_EVENT, data: e }),
        log: (text) => server.config.logger.info(text),
        error: (text) => server.config.logger.error(text),
      });
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.pathname.replace(/\/$/, "");
        rememberLanguage(req, res);
        const handle = async () => {
          if (req.method === "GET" && path === STUDIO_PAGE) {
            // 制作画面の画面（src/client）は非公開で、npm で入れた lim には入っていない。無ければ制作アプリへの案内を返す
            const studioHtml = studioHtmlPath();
            if (!studioHtml) return send(res, 404, studioMissingPage(languageOf(req)), "text/html; charset=utf-8");
            const html = readFileSync(studioHtml, "utf8");
            return send(res, 200, await server.transformIndexHtml(url.pathname, html), "text/html; charset=utf-8");
          }
          if (!path.startsWith(`${STUDIO_API}/`)) return next();
          if (!sameOrigin(req)) return json(res, 403, { error: "別のオリジンからは使えません" });
          if (path.startsWith(`${STUDIO_PLUGIN_API}/`)) return host!.handle(req, res, path.slice(STUDIO_PLUGIN_API.length), url.searchParams);
          // 自分を名乗る（AI の MCP が、作品の .liminalia/studio-server.json に書いた開発サーバーが生きているかを見る。./running.ts）
          if (req.method === "GET" && path === `${STUDIO_API}/server`) return json(res, 200, { root: project.root, pid: typeof process === "undefined" ? null : process.pid });
          // 外で組み立てた「ここから遊ぶ」のセーブ（作品の読み込みを待たない）
          if (path === `${STUDIO_API}${PLAY_FROM_ROUTE}`) {
            if (req.method === "POST") {
              const id = playFrom.put(await readJson<unknown>(req));
              return id === null ? json(res, 400, { error: "save、file、line を送ってください" }) : json(res, 200, { id });
            }
            if (req.method === "GET") return send(res, 200, playFromPage(playFrom.get(url.searchParams.get("id")), url.searchParams.get("start"), url.searchParams.get("skip")), "text/html; charset=utf-8");
          }
          const route = `${req.method ?? "GET"} ${path.slice(STUDIO_API.length)}`;
          const ws = await open();
          // この画面の頼みとして台本を書く（書いた台本を、ほかの画面にだけ読み直させる。STUDIO_WINDOW_HEADER）
          const windowId = req.headers[STUDIO_WINDOW_HEADER];
          const as = <T>(fn: () => T): T => ws.as(typeof windowId === "string" && windowId !== "" ? windowId : undefined, fn);
          const file = () => {
            const f = url.searchParams.get("file");
            if (!f) throw new StudioError(400, "file を指定してください");
            return f;
          };
          switch (route) {
            case "POST /shot": {
              const body = await readJson<Partial<ShotRequest>>(req);
              const show = body.show as Partial<ShotRequest["show"]> | undefined;
              const validShow = (show?.type === "liminalia:stage-show" && !!show.save && typeof show.save === "object") || (show?.type === "liminalia:stage-still" && !!show.stage && typeof show.stage === "object");
              if (typeof body.file !== "string" || !Number.isInteger(body.line) || !validShow) return json(res, 400, { error: "file、line、show（stage-show か stage-still）を送ってください" });
              const shot: ShotRequest = { file: body.file, line: body.line!, show: show as ShotRequest["show"], ...(body.cast && typeof body.cast === "object" ? { cast: body.cast } : {}) };
              return json(res, 200, await takeShot(project, browserProvider(), serverBase(req), shot));
            }
            case "POST /shot/play": {
              // lim shot と同じ撮り方の画面写真（AI の MCP の screenshot）。PNG をそのまま返し、ファイルには書かない
              const body = await readJson<PlayShotRequest>(req, true);
              if ((body.start !== undefined && typeof body.start !== "string") || (body.skip !== undefined && typeof body.skip !== "number") || (body.title !== undefined && typeof body.title !== "boolean") || (body.lang !== undefined && typeof body.lang !== "string")) {
                return json(res, 400, { error: "start（ファイル[#ラベル]）、skip、title、lang を送ってください" });
              }
              if (!body.title && !body.start) return json(res, 400, { error: "start か title を送ってください" });
              const target = body.title ? "" : resolveShotTarget(project, body.start!);
              return send(res, 200, await takePlayShot(project, browserProvider(), serverBase(req), body, target), "image/png");
            }
            case "GET /shots/file":
              return send(res, 200, readShot(project.root, url.searchParams.get("name") ?? ""), "image/png");
            case "POST /profile": {
              const body = await readJson<Partial<ProfileRequest>>(req, true);
              const pages = body.pages === undefined ? 30 : body.pages;
              if (typeof pages !== "number" || !Number.isInteger(pages) || pages < 1 || pages > 200) return json(res, 400, { error: "pages（1〜200）を送ってください" });
              if (body.target !== undefined && typeof body.target !== "string") return json(res, 400, { error: "target（ファイル[#ラベル]）を送ってください" });
              if (profiling) return json(res, 409, { error: "ほかのパフォーマンス計測が終わるまで待ってください" });
              const target = body.target ? resolveShotTarget(project, body.target) : project.config.entry;
              profiling = true;
              try {
                const signal = closeSignal(res);
                const events = profileEvents({ provider: browserProvider(), base: serverBase(req), root: project.root, size: project.screen, target, pages, signal, language: req.headers[STUDIO_LANGUAGE_HEADER] === "en" ? "en" : "ja" });
                return await streamLines(res, events, signal, (e) => server.config.logger.error(`Studio: 重さの計測: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`));
              } finally {
                profiling = false;
              }
            }
            case "POST /voice-lock":
              return json(res, 200, await lockVoices(ws));
            case "POST /regress": {
              const body = await readJson<{ update?: unknown; threshold?: unknown }>(req, true);
              const threshold = body.threshold === undefined ? 0.05 : body.threshold;
              if (typeof threshold !== "number" || !(threshold >= 0 && threshold <= 100) || (body.update !== undefined && typeof body.update !== "boolean")) return json(res, 400, { error: "update（true か false）と threshold（0〜100 の %）を送ってください" });
              if (profiling) return json(res, 409, { error: "ほかの計測が終わるまで待ってください" });
              profiling = true;
              try {
                const signal = closeSignal(res);
                const events = regressEvents({ provider: browserProvider(), base: serverBase(req), project, update: body.update === true, threshold, signal });
                return await streamLines(res, events, signal, (e) => server.config.logger.error(`Studio: 見た目の確かめ: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`));
              } finally {
                profiling = false;
              }
            }
            case "GET /regress/file":
              return send(res, 200, readRegressImage(project, url.searchParams.get("kind") ?? "", url.searchParams.get("name") ?? ""), "image/png");
            case "GET /stats":
              return jsonGzip(req, res, JSON.stringify(textReport(ws)));
            case "POST /check/severity": {
              // 「この種類を出さない」（liminalia.json の check.severity。level が null なら外す）
              const body = await readJson<{ code?: unknown; level?: unknown }>(req);
              setCheckSeverity(ws, body.code, body.level ?? null);
              return json(res, 200, { ok: true });
            }
            case "GET /scenes":
              return json(res, 200, { scenes: readScenes(ws) });
            case "POST /scenes": {
              // シーンの情報（liminalia.json の scenes の pov、date、place）
              const body = await readJson<{ key?: unknown; info?: unknown }>(req);
              setSceneInfo(ws, body.key, body.info);
              return json(res, 200, { ok: true });
            }
            case "POST /stats/ignore": {
              const body = await readJson<{ id?: unknown }>(req);
              if (typeof body.id !== "string") return json(res, 400, { error: "id を送ってください" });
              ignoreVariant(ws, body.id);
              return json(res, 200, { ok: true });
            }
            case "POST /stats/unignore": {
              const body = await readJson<{ id?: unknown }>(req);
              if (typeof body.id !== "string") return json(res, 400, { error: "id を送ってください" });
              unignoreVariant(ws, body.id);
              return json(res, 200, { ok: true });
            }
            case "GET /project":
              return json(res, 200, ws.projectInfo());
            case "GET /file":
              return json(res, 200, ws.fileText(file()));
            case "PUT /file": {
              const body = await readJson<Partial<WriteRequest>>(req);
              if (typeof body.file !== "string" || typeof body.text !== "string" || !(typeof body.baseHash === "string" || body.baseHash === null)) {
                return json(res, 400, { error: "file、text、baseHash（新しいファイルは null）を送ってください" });
              }
              const r = as(() => ws.write(body.file!, body.text!, body.baseHash!, body.check !== false));
              // 全体の検査を添えるので大きくなることがある
              return r.ok ? jsonGzip(req, res, JSON.stringify(r.result)) : json(res, 409, r.conflict);
            }
            case "POST /search": {
              const body = await readJson<Partial<SearchRequest>>(req);
              const flag = (v: unknown) => v === undefined || typeof v === "boolean";
              const open = body.open as { file?: unknown; text?: unknown } | undefined;
              const text = (v: unknown) => v === undefined || typeof v === "string";
              if (typeof body.query !== "string" || !flag(body.regex) || !flag(body.body) || !flag(body.kana) || !flag(body.caseSensitive) || !flag(body.packs) || !text(body.scope) || !text(body.speaker) || (open !== undefined && (typeof open?.file !== "string" || typeof open.text !== "string"))) {
                return json(res, 400, { error: "query（と regex、body、kana、caseSensitive、packs、scope、speaker、open）を送ってください" });
              }
              return jsonGzip(req, res, JSON.stringify(searchProject(ws, body as SearchRequest)));
            }
            case "GET /history":
              return json(res, 200, ws.history(file()));
            case "GET /history/item":
              return json(res, 200, ws.historyItem(file(), url.searchParams.get("id") ?? ""));
            case "POST /check":
              return json(res, 200, ws.check());
            case "GET /coverage":
              return jsonGzip(req, res, JSON.stringify(ws.lastCoverage()));
            case "POST /coverage/stream": {
              const body = await readJson<{ runs?: unknown }>(req, true);
              const runs = typeof body.runs === "number" && Number.isInteger(body.runs) && body.runs > 0 && body.runs <= 32 ? body.runs : DEFAULT_COVERAGE_RUNS;
              const signal = closeSignal(res);
              return await streamLines(res, coverageEvents(ws, runs, signal), signal, (e) => server.config.logger.error(`Studio: 全ルートテスト: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`));
            }
            case "POST /coverage": {
              const body = await readJson<{ runs?: unknown }>(req, true);
              const runs = typeof body.runs === "number" && Number.isInteger(body.runs) && body.runs > 0 && body.runs <= 32 ? body.runs : DEFAULT_COVERAGE_RUNS;
              return json(res, 200, await ws.coverage(runs));
            }
            case "GET /sweep": {
              const range = lineRange(url.searchParams);
              const r = await ws.sweep(file());
              if (range) return jsonGzip(req, res, JSON.stringify(sweepRange(r.sweep, range)));
              return jsonGzip(req, res, r.json, r.gz);
            }
            case "GET /sweep/reach": {
              const line = Number(url.searchParams.get("line"));
              if (!Number.isInteger(line) || line < 1) return json(res, 400, { error: "line（1 から）を送ってください" });
              const range = lineRange(url.searchParams);
              const r = await ws.reach(file(), line, closeSignal(res));
              return jsonGzip(req, res, JSON.stringify(r.sweep && range ? { sweep: sweepRange(r.sweep, range) } : r));
            }
            case "GET /map":
              return jsonGzip(req, res, JSON.stringify(ws.storyMap()));
            case "GET /macro/uses": {
              const name = url.searchParams.get("name") ?? "";
              if (name === "") return json(res, 400, { error: "name を送ってください" });
              return jsonGzip(req, res, JSON.stringify(macroUses(ws, name)));
            }
            case "GET /map/cast":
              return jsonGzip(req, res, JSON.stringify(sceneSpeakers(ws.storyMap(), new Map(ws.files().map((f) => [f, ws.script(f).script] as const)))));
            case "GET /sweep/stage":
              return jsonGzip(req, res, JSON.stringify(await ws.stageTrack(file())));
            case "GET /data":
              return json(res, 200, data.read(url.searchParams.get("name") ?? ""));
            case "PUT /data": {
              const body = await readJson<Partial<DataWriteRequest>>(req);
              if (typeof body.name !== "string" || typeof body.text !== "string" || !(typeof body.baseHash === "string" || body.baseHash === null)) {
                return json(res, 400, { error: "name、text、baseHash（新しいファイルは null）を送ってください" });
              }
              const r = data.write(body.name, body.text, body.baseHash);
              // ほかの画面へ（書いた内容はファイルの見張りが知らせないので）
              if (r.ok) server.ws.send({ type: "custom", event: STUDIO_EVENT, data: { type: "data-changed", name: r.name, ...(typeof windowId === "string" && windowId !== "" ? { by: windowId } : {}) } satisfies StudioEvent });
              return json(res, r.ok ? 200 : 409, r);
            }
            case "POST /asset": {
              const r = data.upload(url.searchParams.get("kind") ?? "", url.searchParams.get("path") ?? "", await readBody(req, ASSET_LIMIT), url.searchParams.get("overwrite") === "1", { journals: ws.journals, after: () => ws.forgetAssets() });
              return json(res, r.ok ? 200 : 409, r);
            }
            case "GET /undo/state": {
              // ⌘Z で戻す前に、操作のあとのままかを確かめる（./file-undo.ts）
              const state: UndoJournalState = ws.journals.state(url.searchParams.get("id") ?? "");
              return json(res, 200, { state });
            }
            case "POST /undo/apply": {
              // 書いた画面にも知らせる（戻した台本を、開いている画面が読み直す）ので、この画面の書き込みとしては扱わない
              const body = await readJson<{ id?: unknown; to?: unknown }>(req);
              if (typeof body.id !== "string" || (body.to !== "undone" && body.to !== "applied")) return json(res, 400, { error: "to（undone か applied）、id を送ってください" });
              const r: UndoJournalApply = ws.journals.apply(body.id, body.to);
              return json(res, r.ok ? 200 : 409, r);
            }
            case "GET /assets/list":
              return jsonGzip(req, res, JSON.stringify(listAssets(ws)));
            case "GET /assets/usage":
              return jsonGzip(req, res, JSON.stringify(assetUsage(ws)));
            case "POST /assets/rename": {
              const body = await readJson<{ kind?: unknown; from?: unknown; to?: unknown }>(req);
              if (typeof body.kind !== "string" || typeof body.from !== "string" || typeof body.to !== "string") return json(res, 400, { error: "kind、from、to を送ってください" });
              return json(res, 200, as(() => renameAsset(ws, body.kind as string, body.from as string, body.to as string)));
            }
            case "POST /assets/trash": {
              const body = await readJson<{ kind?: unknown; path?: unknown }>(req);
              if (typeof body.kind !== "string" || typeof body.path !== "string") return json(res, 400, { error: "kind、path を送ってください" });
              return json(res, 200, trashAsset(ws, body.kind, body.path));
            }
            case "POST /assets/trash-many": {
              const body = await readJson<{ items?: unknown }>(req);
              const items = body.items;
              if (!Array.isArray(items) || items.some((i: { kind?: unknown; path?: unknown } | null) => typeof i?.kind !== "string" || typeof i?.path !== "string")) return json(res, 400, { error: "items を { kind, path } の並びで送ってください" });
              return json(res, 200, trashAssets(ws, items as { kind: string; path: string }[]));
            }
            case "GET /voices":
              return jsonGzip(req, res, JSON.stringify(voiceList(ws)));
            case "GET /trash":
              return json(res, 200, listTrash(ws));
            case "POST /assets/restore": {
              const body = await readJson<{ id?: unknown }>(req);
              if (typeof body.id !== "string") return json(res, 400, { error: "id を送ってください" });
              return json(res, 200, restoreTrash(ws, body.id));
            }
            case "POST /assets/folder": {
              const body = await readJson<{ kind?: unknown; path?: unknown }>(req);
              if (typeof body.kind !== "string" || typeof body.path !== "string") return json(res, 400, { error: "kind、path を送ってください" });
              makeAssetFolder(ws, body.kind, body.path);
              return json(res, 200, { ok: true });
            }
            case "POST /assets/requests":
              // 素材の依頼表（無い素材、差分、ボイス）を exports/asset-requests.csv に書く（./asset-requests.ts）
              return json(res, 200, writeAssetRequests(ws, req.headers[STUDIO_LANGUAGE_HEADER] === "en"));
            case "GET /assets/requests.csv":
              res.setHeader("Content-Disposition", 'attachment; filename="asset-requests.csv"');
              return send(res, 200, assetRequestsCsv(assetRequests(ws), req.headers[STUDIO_LANGUAGE_HEADER] === "en" || url.searchParams.get("lang") === "en"), "text/csv; charset=utf-8");
            case "POST /assets/samples":
              // ひな形のサンプル素材（CC0）を写す（./samples.ts）
              return json(res, 200, addSampleAssets(ws));
            case "POST /assets/reveal": {
              const body = await readJson<{ kind?: unknown; path?: unknown }>(req);
              if (typeof body.kind !== "string" || typeof body.path !== "string") return json(res, 400, { error: "kind、path を送ってください" });
              revealFolder(assetFolderToReveal(ws, body.kind, body.path));
              return json(res, 200, { ok: true });
            }
            case "POST /assets/reveal-file": {
              const body = await readJson<{ kind?: unknown; path?: unknown }>(req);
              if (typeof body.kind !== "string" || typeof body.path !== "string") return json(res, 400, { error: "kind、path を送ってください" });
              revealFile(assetFileToReveal(ws, body.kind, body.path));
              return json(res, 200, { ok: true });
            }
            case "POST /files/reveal": {
              const body = await readJson<{ file?: unknown }>(req);
              if (typeof body.file !== "string") return json(res, 400, { error: "file を指定してください" });
              revealFile(scenarioFileToReveal(ws, body.file));
              return json(res, 200, { ok: true });
            }
            case "POST /files/create": {
              const body = await readJson<{ file?: unknown; text?: unknown }>(req);
              if (typeof body.file !== "string" || (body.text !== undefined && typeof body.text !== "string")) return json(res, 400, { error: "file（と text）を送ってください" });
              as(() => createScenario(ws, body.file as string, body.text as string | undefined));
              return json(res, 200, { ok: true });
            }
            case "POST /files/duplicate":
            case "POST /files/rename": {
              const body = await readJson<{ from?: unknown; to?: unknown }>(req);
              if (typeof body.from !== "string" || typeof body.to !== "string") return json(res, 400, { error: "from、to を送ってください" });
              if (route === "POST /files/duplicate") {
                as(() => duplicateScenario(ws, body.from as string, body.to as string));
                return json(res, 200, { ok: true });
              }
              return json(res, 200, as(() => renameScenario(ws, body.from as string, body.to as string)));
            }
            case "POST /labels/rename": {
              const body = await readJson<{ file?: unknown; from?: unknown; to?: unknown }>(req);
              if (typeof body.file !== "string" || typeof body.from !== "string" || typeof body.to !== "string") return json(res, 400, { error: "file、from、to を送ってください" });
              return json(res, 200, as(() => renameLabel(ws, body.file as string, body.from as string, body.to as string)));
            }
            case "POST /scenes/move": {
              const body = await readJson<{ file?: unknown; labels?: unknown; to?: unknown }>(req);
              if (typeof body.file !== "string" || typeof body.to !== "string" || !Array.isArray(body.labels) || !body.labels.every((l) => typeof l === "string")) return json(res, 400, { error: "file、labels、to を送ってください" });
              return json(res, 200, as(() => moveScenes(ws, body.file as string, body.labels as string[], body.to as string)));
            }
            case "POST /files/trash": {
              const body = await readJson<{ file?: unknown }>(req);
              if (typeof body.file !== "string") return json(res, 400, { error: "file を送ってください" });
              return json(res, 200, as(() => trashScenario(ws, body.file as string)));
            }
            case "GET /icon": {
              // 書き出しのアイコン（build.icon。path があればその画像。設定欄の見本に）
              const icon = projectIcon(project.root, url.searchParams.get("path") ?? ws.readConfig().build?.icon);
              return icon ? send(res, 200, icon.data, icon.type) : json(res, 404, { error: "アイコンが見つかりません" });
            }
            case "GET /settings": {
              const settings = readSettings(ws);
              return json(res, 200, { settings, hash: configPartHash(settings), restart: restartNeeded(ws, ws.readConfig() as unknown as Record<string, unknown>) });
            }
            case "POST /settings": {
              const body = await readJson<{ settings?: unknown; baseHash?: unknown }>(req);
              if (typeof body.baseHash !== "string") return json(res, 400, { error: "settings と baseHash（読んだときの hash）を送ってください" });
              const r = setSettings(ws, body.settings, body.baseHash);
              return json(res, r.ok ? 200 : 409, r);
            }
            case "GET /extra": {
              // shown はシナリオが出す画像（CG の自動の登録 extra.cgAuto を、画面の側で広げるのに使う）
              const extra = ws.readConfig().extra ?? {};
              return json(res, 200, { extra, shown: ws.shownImages(), hash: configPartHash(extra) });
            }
            case "POST /extra": {
              const body = await readJson<{ extra?: unknown; baseHash?: unknown }>(req);
              if (typeof body.baseHash !== "string") return json(res, 400, { error: "extra と baseHash（読んだときの hash）を送ってください" });
              const r = setExtra(ws, body.extra, body.baseHash);
              return json(res, r.ok ? 200 : 409, r);
            }
            case "GET /i18n":
              return json(res, 200, translationStatus(ws));
            case "GET /i18n/file":
              return jsonGzip(req, res, JSON.stringify(readTranslation(ws, url.searchParams.get("lang") ?? "")));
            case "PUT /i18n/file": {
              const body = await readJson<{ lang?: unknown; file?: unknown; baseHash?: unknown }>(req);
              if (typeof body.lang !== "string" || !body.file || typeof body.file !== "object" || !(typeof body.baseHash === "string" || body.baseHash === null)) {
                return json(res, 400, { error: "lang、file、baseHash（読んだときの hash。無かったファイルは null）を送ってください" });
              }
              const r = writeTranslation(ws, body.lang, body.file as TranslationFile, body.baseHash);
              return r.ok ? json(res, 200, r) : jsonGzip(req, res, JSON.stringify(r), undefined, 409);
            }
            case "POST /i18n/export": {
              // 訳の受け渡し: 表（CSV）か XLIFF を exports/translation に書き、フォルダを開く
              const body = await readJson<{ lang?: unknown; format?: unknown }>(req);
              if (typeof body.lang !== "string" || (body.format !== "csv" && body.format !== "xliff")) return json(res, 400, { error: "lang と format（csv か xliff）を送ってください" });
              const file = readTranslation(ws, body.lang).file;
              const folder = join(project.root, "exports", "translation");
              mkdirSync(folder, { recursive: true });
              const path = join(folder, `${body.lang}.${body.format === "csv" ? "csv" : "xlf"}`);
              // \u9805\u76EE\u306E\u5834\u6240\u3068\u524D\u5F8C\u306E\u884C\u3092\u6587\u8108\u306B\u66F8\u304F\uFF08\u82F1\u8A9E\u306E\u8868\u793A\u306A\u3089\u6587\u8108\u306E\u8A00\u8449\u3082\u82F1\u8A9E\uFF09
              const options = { context: translationContext(ws), noteLanguage: req.headers[STUDIO_LANGUAGE_HEADER] === "en" ? ("en" as const) : ("ja" as const) };
              writeFileSync(path, body.format === "csv" ? `\uFEFF${translationToCsv(file, options)}` : translationToXliff(file, project.config.languages?.[0] ?? "ja", options));
              revealFolder(folder);
              return json(res, 200, { path: relative(project.root, path) });
            }
            case "POST /i18n/import": {
              const body = await readJson<{ lang?: unknown; text?: unknown }>(req);
              if (typeof body.lang !== "string" || typeof body.text !== "string") return json(res, 400, { error: "lang と text を送ってください" });
              let back;
              try {
                back = applyTranslationTable(readTranslation(ws, body.lang).file, body.text);
              } catch (e) {
                throw new StudioError(400, e instanceof Error ? e.message : String(e));
              }
              writeTranslation(ws, body.lang, back.file);
              // 書き方が読めない訳は書いていない（rejected。位置と理由）。原文が変わった行は鍵を返す
              return json(res, 200, { applied: back.applied, changedSource: back.changedSource, changedKeys: back.changedKeys, unknown: back.unknown, rejected: back.rejected, warnings: back.warnings });
            }
            case "POST /voice-script": {
              // 英語の表示から書き出すときは、英語の名前のファイル（all.csv、summary.csv）と英語の見出しにする（lim voice-script --lang en と同じ）
              const r = exportVoiceScript(project, undefined, req.headers[STUDIO_LANGUAGE_HEADER] === "en" ? "en" : "ja");
              revealFolder(r.folder);
              return json(res, 200, { ...r, folder: relative(project.root, r.folder) });
            }
            case "POST /script-export": {
              // 校正用の台本（lim script-export と同じ。英語の表示からは選択肢の見出しを英語に）
              const body = await readJson<{ format?: unknown }>(req);
              if (body.format !== undefined && body.format !== "text" && body.format !== "html") return json(res, 400, { error: "format は text か html で送ってください" });
              const r = exportScriptText(project, { format: body.format === "html" ? "html" : "text", lines: true, language: req.headers[STUDIO_LANGUAGE_HEADER] === "en" ? "en" : "ja" });
              revealFolder(r.folder);
              return json(res, 200, { ...r, folder: relative(project.root, r.folder) });
            }
            case "POST /i18n/languages": {
              const body = await readJson<{ languages?: unknown; baseHash?: unknown }>(req);
              if (!Array.isArray(body.languages) || body.languages.some((l) => typeof l !== "string") || (body.baseHash !== undefined && typeof body.baseHash !== "string")) return json(res, 400, { error: "languages を言語の名前の配列で送ってください" });
              const r = setLanguages(ws, body.languages as string[], body.baseHash as string | undefined);
              return json(res, r.ok ? 200 : 409, r);
            }
            case "GET /plugins":
              return json(res, 200, { plugins: listPlugins(ws), hash: configListHash(ws, "plugins") } satisfies PluginList);
            case "POST /plugins": {
              const body = await readJson<{ plugins?: unknown; baseHash?: unknown }>(req);
              if (!Array.isArray(body.plugins) || body.plugins.some((p) => typeof p !== "string") || (body.baseHash !== undefined && typeof body.baseHash !== "string")) return json(res, 400, { error: "plugins をプラグインの指定の配列で送ってください" });
              const r = setPlugins(ws, body.plugins as string[], body.baseHash as string | undefined);
              return json(res, r.ok ? 200 : 409, r);
            }
            case "POST /plugins/create": {
              const body = await readJson<{ name?: unknown; parts?: unknown }>(req);
              const parts = Array.isArray(body.parts) ? body.parts.filter((p): p is PluginPart => p === "commands" || p === "web" || p === "studio") : [];
              if (typeof body.name !== "string") return json(res, 400, { error: "name を送ってください" });
              return json(res, 200, { spec: createPlugin(ws, body.name, parts, req.headers[STUDIO_LANGUAGE_HEADER] === "en" ? "en" : "ja") });
            }
            case "POST /plugins/update": {
              const body = await readJson<{ spec?: unknown; name?: unknown; description?: unknown }>(req);
              if (typeof body.spec !== "string") return json(res, 400, { error: "spec を送ってください" });
              updatePlugin(ws, body.spec, { ...(typeof body.name === "string" ? { name: body.name } : {}), ...(typeof body.description === "string" ? { description: body.description } : {}) });
              return json(res, 200, { ok: true });
            }
            case "POST /plugins/reveal": {
              const body = await readJson<{ spec?: unknown }>(req);
              if (typeof body.spec !== "string") return json(res, 400, { error: "spec を送ってください" });
              revealFolder(localPluginDir(ws, body.spec));
              return json(res, 200, { ok: true });
            }
            case "GET /plugins/catalog":
              return json(res, 200, catalogPlugins(ws, catalogDir()));
            case "POST /plugins/install": {
              const body = await readJson<{ id?: unknown }>(req);
              if (typeof body.id !== "string") return json(res, 400, { error: "id を送ってください" });
              return json(res, 200, installPlugin(ws, catalogDir(), body.id));
            }
            case "GET /ui": {
              const ui = ws.readUi() ?? {};
              return json(res, 200, { ui, hash: configPartHash(ui) });
            }
            case "POST /ui": {
              const body = await readJson<{ ui?: unknown; baseHash?: unknown }>(req);
              if (typeof body.baseHash !== "string") return json(res, 400, { error: "ui と baseHash（読んだときの hash）を送ってください" });
              const r = setUi(ws, body.ui ?? {}, body.baseHash);
              return json(res, r.ok ? 200 : 409, r);
            }
            case "GET /command-defaults":
              return json(res, 200, { defaults: readCommandDefaults(ws), hash: commandDefaultsHash(ws) });
            case "POST /command-defaults": {
              const body = await readJson<{ defaults?: unknown; baseHash?: unknown }>(req);
              if (body.baseHash !== undefined && typeof body.baseHash !== "string") return json(res, 400, { error: "baseHash（読んだときの hash）を送ってください" });
              const r = setCommandDefaults(ws, body.defaults ?? {}, body.baseHash as string | undefined);
              return json(res, r.ok ? 200 : 409, r);
            }
            case "GET /ui/themes":
              return json(res, 200, listUiThemes(ws.project.root));
            case "GET /screens":
              return json(res, 200, screenTable());
            case "GET /screens/rules":
              return json(res, 200, screenTemplateRules());
            case "GET /screens/files":
              return json(res, 200, readScreenFiles(ws, url.searchParams.get("screen")));
            case "GET /screens/diff":
              return json(res, 200, screenDiff(ws, url.searchParams.get("screen")));
            case "POST /screens/copy": {
              const body = await readJson<{ screen?: unknown; parts?: unknown }>(req);
              return json(res, 200, copyScreenUndoable(ws, body.screen, body.parts));
            }
            case "POST /screens/script": {
              const body = await readJson<{ screen?: unknown }>(req);
              return json(res, 200, addScreenScript(ws, body.screen));
            }
            case "PUT /screens/file": {
              const body = await readJson<{ screen?: unknown; kind?: unknown; text?: unknown; before?: unknown }>(req);
              const r = writeScreenFile(ws, body.screen, body.kind, body.text, body.before);
              return json(res, r.ok ? 200 : 409, r);
            }
            case "POST /screens/reset": {
              const body = await readJson<{ screen?: unknown }>(req);
              return json(res, 200, resetScreenUndoable(ws, body.screen));
            }
            case "POST /ui/theme/save": {
              const body = await readJson<{ name?: unknown; overwrite?: unknown }>(req);
              const saved = saveTheme(ws, typeof body.name === "string" ? body.name : "", body.overwrite === true);
              return json(res, saved.ok ? 200 : 409, saved);
            }
            case "POST /ui/theme/trash": {
              const body = await readJson<{ id?: unknown }>(req);
              return json(res, 200, trashTheme(ws, typeof body.id === "string" ? body.id : ""));
            }
            case "GET /ui/css":
              return json(res, 200, readUiCss(ws));
            case "PUT /ui/css": {
              const body = await readJson<{ text?: unknown; before?: unknown; file?: unknown }>(req);
              const r = writeUiCss(ws, body.text, body.before, body.file);
              return json(res, r.ok ? 200 : 409, r);
            }
            case "POST /ui/css-rule": {
              const body = await readJson<{ edits?: unknown }>(req);
              return json(res, 200, setUiCssRules(ws, body.edits));
            }
            case "POST /ui/theme": {
              const body = await readJson<{ id?: unknown }>(req);
              if (typeof body.id !== "string") return json(res, 400, { error: "id を送ってください" });
              return json(res, 200, applyThemeUndoable(ws, body.id));
            }
            case "GET /variables":
              return jsonGzip(req, res, JSON.stringify(listVariables(ws)));
            case "POST /variables/set": {
              const body = await readJson<{ path?: unknown; value?: unknown; remove?: unknown; create?: unknown }>(req);
              if (typeof body.path !== "string" || !("value" in body || body.remove === true)) return json(res, 400, { error: "path と value（外すなら remove: true）を送ってください" });
              setVariable(ws, body.path, (body.value ?? null) as Value, body.remove === true, body.create === true);
              return json(res, 200, { ok: true });
            }
            case "POST /macros/rename": {
              const body = await readJson<{ from?: unknown; to?: unknown; file?: unknown }>(req);
              if (typeof body.from !== "string" || typeof body.to !== "string") return json(res, 400, { error: "from、to を送ってください" });
              const file = typeof body.file === "string" ? body.file : undefined;
              return json(res, 200, as(() => renameMacro(ws, (body.from as string).replace(/^@/, ""), (body.to as string).replace(/^@/, ""), file)));
            }
            case "POST /variables/rename": {
              const body = await readJson<{ from?: unknown; to?: unknown }>(req);
              if (typeof body.from !== "string" || typeof body.to !== "string") return json(res, 400, { error: "from、to を送ってください" });
              return json(res, 200, as(() => renameVariable(ws, body.from as string, body.to as string)));
            }
            case "GET /studio-state":
              return json(res, 200, readStudioState(project));
            case "PUT /studio-state": {
              const body = await readJson<{ state?: unknown }>(req);
              return json(res, 200, writeStudioState(project, body.state));
            }
            case "GET /reviews":
              return json(res, 200, listReviews(project));
            case "POST /reviews": {
              const body = await readJson<ReviewAction>(req);
              return json(res, 200, applyReview(project, body));
            }
            case "POST /reviews/import": {
              // テスト版の指摘（画面はファイルを一つずつ送る）
              const body = await readJson<{ files?: unknown }>(req);
              return json(res, 200, importFeedback(project, body.files));
            }
            case "GET /reviews/shot": {
              const shot = feedbackShot(project, url.searchParams.get("path"));
              return send(res, 200, shot.data, shot.type);
            }
            case "GET /cast/usage":
              return json(res, 200, castUsage(ws));
            case "GET /part-file":
              return json(res, 200, readPartFile(ws, (url.searchParams.get("part") ?? "") as PartFileName));
            case "PUT /part-file": {
              const body = await readJson<Partial<PartFileWriteRequest>>(req);
              if (typeof body.part !== "string" || typeof body.text !== "string" || typeof body.baseHash !== "string") return json(res, 400, { error: "part、text、baseHash（読んだときの hash）を送ってください" });
              const r = writePartFile(ws, body.part, body.text, body.baseHash);
              return json(res, r.ok ? 200 : 409, r);
            }
            case "GET /part-file/history":
              return json(res, 200, partHistory(ws, (url.searchParams.get("part") ?? "") as PartFileName));
            case "GET /part-file/history/item":
              return json(res, 200, partHistoryItem(ws, (url.searchParams.get("part") ?? "") as PartFileName, url.searchParams.get("id") ?? ""));
            case "GET /cast/backups":
              return json(res, 200, castBackups(ws));
            case "GET /cast/backups/item":
              return json(res, 200, castBackup(ws, url.searchParams.get("id") ?? ""));
            case "GET /cast/lines":
              return json(res, 200, speakerLines(ws, new Set(url.searchParams.getAll("speaker"))));
            case "POST /cast/rename": {
              const body = await readJson<{ kind?: unknown; from?: unknown; to?: unknown; speakerToo?: unknown }>(req);
              if ((body.kind !== "cast" && body.kind !== "speaker") || typeof body.from !== "string" || typeof body.to !== "string") return json(res, 400, { error: "kind（cast か speaker）、from、to を送ってください" });
              return json(res, 200, as(() => renameCast(ws, { kind: body.kind as "cast" | "speaker", from: body.from as string, to: body.to as string, ...(body.speakerToo === true ? { speakerToo: true } : {}) })));
            }
            case "POST /reload": {
              let fresh: Project;
              try {
                fresh = loadProject(project.root);
              } catch (e) {
                throw new StudioError(400, e instanceof Error ? e.message : String(e));
              }
              // プラグインは Node が読み込んだまま（取り替えられない）、プレイヤーの作品の設定は起動したときのもの
              // 変数の初期値・見た目と操作の設定・おまけ・言語・コマンドの既定値は起動し直さなくても効く（プレイヤーへは vite.config.ts の projectModule が渡す）
              // 書き出しの設定は書き出すときに読む
              const withoutVariables = (c: typeof project.config) => ({ ...c, variables: undefined, ui: undefined, extra: undefined, languages: undefined, commandDefaults: undefined, build: undefined });
              if (JSON.stringify([withoutVariables(fresh.config), fresh.plugins]) !== JSON.stringify([withoutVariables(project.config), project.plugins])) return json(res, 200, { ok: false, restart: "config" } satisfies ReloadResult);
              if (pluginStamp(project) !== plugins) return json(res, 200, { ok: false, restart: "plugins" } satisfies ReloadResult);
              const next = await remember(
                StudioWorkspace.open(project).then((ws) => {
                  ws.announce = (e) => announce(e);
                  return ws;
                }),
              );
              server.watcher.add(next.assetFolders().map((f) => join(project.paths.assets, f)));
              return json(res, 200, { ok: true, project: next.projectInfo() } satisfies ReloadResult);
            }
          }
          return json(res, 404, { error: `${route} はありません` });
        };
        handle().catch((e: Error) => json(res, e instanceof StudioError ? e.status : statusOf(e), { error: e.message }));
      });
    },
  };
}

/**
 * 見張りはじめに無かったフォルダとファイル（reviews/、lang/、voice-lock.json、データと素材のフォルダなど）は、できたときに見張りに足し、
 * created で中にできたものを知らせる。Vite の見張り（chokidar）は、見張りはじめに無かったフォルダの中にあとからできたファイルを知らせない
 * （外で足したコメントや訳が、開いている画面に届かなかった）。できるまで LATER_POLL_MS ごとに確かめる。
 */
function watchLater(server: ViteDevServer, paths: readonly string[], created: (path: string) => void): void {
  const missing = new Set<string>();
  for (const path of paths) {
    if (existsSync(path)) server.watcher.add(path);
    else missing.add(path);
  }
  if (missing.size === 0) return;
  const timer = setInterval(() => {
    for (const path of missing) {
      if (!existsSync(path)) continue;
      missing.delete(path);
      server.watcher.add(path);
      created(path);
    }
    if (missing.size === 0) clearInterval(timer);
  }, LATER_POLL_MS);
  // 開発サーバーを止めるのを、この確かめで引き止めない
  (timer as { unref?: () => void }).unref?.();
}

/** 見張りはじめに無かったフォルダができたかを確かめる間（ミリ秒）。 */
const LATER_POLL_MS = 1000;

/** シナリオのフォルダと cast.json、素材のフォルダを見張り、外の変更を画面に知らせる。 */
function watch(server: ViteDevServer, project: Project, open: () => Promise<StudioWorkspace>, data: DataStore): void {
  const send = (e: StudioEvent) => server.ws.send({ type: "custom", event: STUDIO_EVENT, data: e });
  server.watcher.add([project.paths.scenario, project.paths.cast]);
  // データのフォルダができたら、中にできたデータを知らせる
  watchLater(server, [project.paths.data], (dir) => {
    for (const name of readdirSync(dir, { recursive: true }) as string[]) {
      const e = data.changed(join(dir, name));
      if (e) send(e);
    }
  });
  void open().then((ws) => watchLater(server, ws.assetFolders().map((f) => join(project.paths.assets, f)), () => send({ type: "assets-changed" })));
  // 検査が読んだ作品の画面のファイル（作品の CSS と @import の先、url() の指すもの、画面のテンプレートと画面の JS）。読んだら見張りに足し、
  // 変わったら検査とゲームの画面のタブを取り直させる。続けて変わればまとめて一度。
  // 無いファイルもそのまま足す（watchLater で待つと、標準に戻して ⌘Z で戻したファイルを足し直す所で、見本が自分のテンプレートを出さなくなった）
  let screensTimer: ReturnType<typeof setTimeout> | null = null;
  const screensChanged = () => {
    if (screensTimer) clearTimeout(screensTimer);
    screensTimer = setTimeout(() => send({ type: "screens-changed" }), 200);
  };
  void open().then((ws) => {
    ws.onCheckedFiles = (files) => server.watcher.add([...files]);
    if (ws.checkedProjectFiles().length > 0) ws.onCheckedFiles(ws.checkedProjectFiles());
  });
  const inScope = (path: string) => path === project.paths.cast || (path.startsWith(project.paths.scenario) && path.endsWith(".lim"));
  /** 素材が続けて増えたとき（フォルダごと写したときなど）は、まとめて一度だけ知らせる。 */
  let assetsTimer: ReturnType<typeof setTimeout> | null = null;
  const configFile = join(project.root, "liminalia.json");
  server.watcher.add(configFile);
  // 検査が読むほかの設定（訳のファイル、ボイスの番号の固定）。変わったら検査を取り直させる。ボイスの番号の固定が変われば、
  // 現在地で鳴る番号も変わるので作り直させる（初めて作られたときも）
  const voiceLockChanged = () => void open().then((ws) => send(ws.variablesChanged() ? { type: "variables-changed" } : { type: "config-changed" }));
  watchLater(server, [project.paths.lang, project.paths.voiceLock], (path) => (path === project.paths.voiceLock ? voiceLockChanged() : send({ type: "config-changed" })));
  const checkInput = (path: string) => path === project.paths.voiceLock || (path.startsWith(`${project.paths.lang}${sep}`) && path.endsWith(".json"));
  // レビューのコメント（画面自身の書き込みも、git で取り込んだものも知らせる。続けて変わればまとめて一度）
  const reviews = join(project.root, REVIEWS_DIR);
  watchLater(server, [reviews], () => send({ type: "reviews-changed" }));
  let reviewsTimer: ReturnType<typeof setTimeout> | null = null;
  // 制作画面の共有するデータ（git で取り込んだ共同作者のシーンの印、顔の切り出しなど）
  const sharedState = join(project.root, STUDIO_SHARED_FILE);
  watchLater(server, [sharedState], () => send({ type: "studio-state-changed" }));
  server.watcher.on("all", (event, path) => {
    if (["add", "change", "unlink"].includes(event) && path.startsWith(`${reviews}${sep}`) && path.endsWith(".json")) {
      if (reviewsTimer) clearTimeout(reviewsTimer);
      reviewsTimer = setTimeout(() => server.ws.send({ type: "custom", event: STUDIO_EVENT, data: { type: "reviews-changed" } satisfies StudioEvent }), 200);
      return;
    }
    if (["add", "change", "unlink"].includes(event) && path === sharedState) {
      if (!isOwnSharedWrite(path)) send({ type: "studio-state-changed" });
      return;
    }
    if (event === "change" && path === configFile) {
      void open().then((ws) => {
        // 変数の初期値などが変われば現在地も作り直させる。ほかの項目（check.severity、languages、extra など）は検査だけを取り直させる
        server.ws.send({ type: "custom", event: STUDIO_EVENT, data: (ws.variablesChanged() ? { type: "variables-changed" } : { type: "config-changed" }) satisfies StudioEvent });
      });
      return;
    }
    // 作品の画面のファイル（素材のフォルダの中のものは、素材の一覧の知らせも続けて見る）
    if (["add", "change", "unlink"].includes(event) && !inScope(path)) void open().then((ws) => ws.screenFileChanged(path) && screensChanged());
    if (["add", "change", "unlink"].includes(event) && checkInput(path)) {
      if (path === project.paths.voiceLock) voiceLockChanged();
      else server.ws.send({ type: "custom", event: STUDIO_EVENT, data: { type: "config-changed" } satisfies StudioEvent });
      return;
    }
    if (["add", "change", "unlink"].includes(event) && path.startsWith(project.paths.data)) {
      const e = data.changed(path);
      if (e) server.ws.send({ type: "custom", event: STUDIO_EVENT, data: e });
      return;
    }
    if ((event === "add" || event === "unlink") && path.startsWith(project.paths.assets) && !inScope(path)) {
      void open().then((ws) => {
        if (!ws.assetsChanged(path)) return;
        if (assetsTimer) clearTimeout(assetsTimer);
        assetsTimer = setTimeout(() => server.ws.send({ type: "custom", event: STUDIO_EVENT, data: { type: "assets-changed" } satisfies StudioEvent }), 300);
      });
      return;
    }
    if (!["add", "change", "unlink"].includes(event) || !inScope(path)) return;
    void open()
      .then((ws) => {
        const e = ws.changed(path);
        if (e) server.ws.send({ type: "custom", event: STUDIO_EVENT, data: e });
      })
      .catch((e: Error) => server.config.logger.error(`Studio: ${path} の変更を読み込めません: ${e.message}`));
  });
}

/** 作品を初めて開くのにこれより長くかかったら、記録に残す（ミリ秒）。 */
const SLOW_OPEN_MS = 3000;
const seconds = (ms: number) => (ms / 1000).toFixed(1);

const CODE = /\.(?:[cm]?[jt]sx?)$/;

/**
 * 独自タグのプラグイン（組み込みの標準の命令は除く）のコードの様子。ファイルの数と、いちばん新しい更新の時刻。
 * プラグインのフォルダが作品のフォルダそのものでもよいように、node_modules・. で始まるもの・作品のシナリオ・素材・データのフォルダは見ない。
 */
function pluginStamp(project: Project): string {
  const skip = new Set([project.paths.scenario, project.paths.assets, project.paths.data, project.paths.out].filter(Boolean).map((p) => p.replace(/[\\/]$/, "")));
  let count = 0;
  let newest = 0;
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // 読めないフォルダは飛ばす
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip.has(p)) walk(p);
      } else if (CODE.test(e.name)) {
        count++;
        newest = Math.max(newest, statSync(p).mtimeMs);
      }
    }
  };
  for (const dir of project.plugins) if (dir !== STD_PLUGIN && !dir.split(sep).includes("node_modules")) walk(dir);
  return `${count}:${newest}`;
}

/** from・to（どちらも行。省けば先頭・末尾）。どちらも無ければ null。 */
function lineRange(params: URLSearchParams): { from: number; to: number } | null {
  const from = params.get("from");
  const to = params.get("to");
  if (from === null && to === null) return null;
  const n = (v: string | null, fallback: number) => {
    if (v === null) return fallback;
    const x = Number(v);
    if (!Number.isInteger(x) || x < 1) throw new StudioError(400, `行番号として使えません: ${v}`);
    return x;
  };
  return { from: n(from, 1), to: n(to, Number.MAX_SAFE_INTEGER) };
}

/** この開発サーバーの URL（画面なしのブラウザで、プレイヤーを開く。画面が開いたのと同じ名前と番号）。 */
function serverBase(req: IncomingMessage): string {
  return `http://${req.headers.host ?? "localhost"}`;
}

/** ブラウザからの要求は同じオリジンに限る。ブラウザ外の CLI はメタデータ無しで呼べる。 */
function sameOrigin(req: IncomingMessage): boolean {
  const site = req.headers["sec-fetch-site"];
  if (site === "cross-site" || site === "same-site") return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    // 読めない Origin は断る
    return false;
  }
}

async function readJson<T>(req: IncomingMessage, optional = false): Promise<T> {
  const body = await readBody(req);
  if (body.length === 0 && optional) return {} as T;
  if (!optional && !(req.headers["content-type"] ?? "").includes("application/json")) throw new StudioError(415, "application/json で送ってください");
  try {
    return JSON.parse(body.toString("utf8")) as T;
  } catch {
    throw new StudioError(400, "JSON として読み込めません");
  }
}

const ICON_TYPES: Record<string, string> = { ".png": "image/png", ".ico": "image/x-icon", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

/** 作品の中の画像（アイコン）を読む。作品の外・画像でないもの・無いものは null。 */
function projectIcon(root: string, path: string | undefined): { data: Buffer; type: string } | null {
  if (!path) return null;
  const full = resolve(root, path);
  const type = ICON_TYPES[extname(full).toLowerCase()];
  if (!type || !containedPath(root, full)) return null;
  try {
    return statSync(full).isFile() ? { data: readFileSync(full), type } : null;
  } catch {
    // 無い・読めないアイコンは返さない（画面は既定の絵を出す）
    return null;
  }
}

function send(res: ServerResponse, status: number, body: string | Buffer, type: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", "no-cache");
  res.end(body);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  // 断りの文は、画面が英語の表示なら英語にする
  const error = body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string" ? { ...(body as object), error: localizedError(res, (body as { error: string }).error) } : body;
  send(res, status, JSON.stringify(error), "application/json; charset=utf-8");
}

const gzipAsync = promisify(gzip);
/** これより小さい応答は gzip しない。 */
const GZIP_MIN = 16 * 1024;

/** JSON を、要求が受け付けて大きければ gzip で返す（gz は gzip したものを覚えている呼び出し側のもの）。 */
async function jsonGzip(req: IncomingMessage, res: ServerResponse, body: string, gz?: () => Promise<Buffer>, status = 200): Promise<void> {
  const type = "application/json; charset=utf-8";
  res.setHeader("Vary", "Accept-Encoding");
  if (body.length < GZIP_MIN || !/\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) return send(res, status, body, type);
  res.setHeader("Content-Encoding", "gzip");
  return send(res, status, gz ? await gz() : await gzipAsync(body, { level: 6 }), type);
}

/** フォルダを OS のファイルの画面（Finder・エクスプローラー）で開く。 */
function revealFolder(dir: string): void {
  const [cmd, args] = process.platform === "darwin" ? ["open", [dir]] : process.platform === "win32" ? ["explorer", [dir]] : ["xdg-open", [dir]];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => undefined);
  child.unref();
}

/** 対象のファイルを Finder・エクスプローラーで選ぶ。 */
function revealFile(file: string): void {
  const { cmd, args } = revealFileCommand(process.platform, file);
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => undefined);
  child.unref();
}

/** 全ルートテストの経過と結果を、出たものから順に返す（POST /coverage/stream）。 */
async function* coverageEvents(ws: StudioWorkspace, runs: number, signal: AbortSignal): AsyncGenerator<CoverageEvent> {
  const queue: CoverageEvent[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  let failure: unknown = null;
  void ws
    .coverage(runs, (p) => {
      queue.push({ kind: "progress", ...p });
      wake?.();
    }, signal)
    .then(
      (result) => void queue.push({ kind: "done", result }),
      (e: unknown) => void (failure = e ?? new Error("全ルートテストに失敗しました")),
    )
    .finally(() => {
      finished = true;
      wake?.();
    });
  for (;;) {
    while (queue.length > 0) yield queue.shift()!;
    if (finished) {
      if (failure) throw failure;
      return;
    }
    await new Promise<void>((r) => (wake = r));
    wake = null;
  }
}
