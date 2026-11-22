import { autoLayoutRules, COMMAND_META, mergePackExtra, previewLine, parseExpr, sortPacks, type CommandDefaults, type ExtraConfig, type ItemsConfig, type PackManifest, type UiConfig } from "@liminalia/lang";
import { CrashTrail, installCrashRecorder, playPlatform } from "./crash.ts";
// プラグインの約束（@liminalia/sdk/web）が呼ぶ描画の実装を登録する
import "./sdk-host.ts";
import type { Runtime, SaveData, StageState, Value } from "@liminalia/runtime";
import { combinePlugins } from "@liminalia/plugin-host";
import type { LayoutMessage, Origin, RouteStep, StageMessage, StagePlayed, StageReply, UiReport } from "@liminalia/studio/protocol";
import { commandPlugins, project, webPlugins as installedPlugins } from "virtual:liminalia/project";
import { DomHost, type AssetKind, type CastEntry, type DomHostOptions, type Extensions } from "./dom-host.ts";
import { newerWebPlugins, PLUGIN_API_VERSION, renderSystem, themeRootClasses, withActiveTheme, type SeedSave, type SystemController, type Transitions } from "./plugin.ts";
import { blockInputWhilePaused, StageFreeze, StageMute, TimerGate, windowTimers } from "./studio-stage.ts";
import { readPlayFrom } from "./studio-play-from.ts";
import { StageVariables } from "./studio-vars.ts";
import { createDefaultSystem } from "./system/default.ts";
import { TEXT } from "./system/strings.ts";
import { devText } from "./dev-language.ts";
import { installAssetScale, registerScaledAsset, type AssetScaleTable } from "./asset-scale.ts";
import { flushSaveStore, prepareSaveStore, saveStoreTools } from "./system/storage.ts";
import { storeRequest, watchPurchases } from "./store.ts";
import { achievementSink } from "./achievements.ts";
import { bindStoreInput } from "./store-input.ts";
import { probeUi, replacedScreens } from "./ui-probe.ts";
import { installHistoryBack, runBackHandler } from "./back.ts";
import { watchBuild } from "./build-watch.ts";
import { detectPlatform } from "./platform.ts";
import { installWorkCss } from "./work-css.ts";
import { installScreenScripts } from "./screen-scripts.ts";

/**
 * プレイヤー。どの作品でも同じで、作品ごとの違いは liminalia.json とプラグインから受け取る
 * （開発サーバー・書き出しが virtual:liminalia/project として渡す）。
 *
 * シナリオ・データは project/、素材は assets/ から、ページからの相対パスで読む。
 * デスクトップ版（preload が window.liminaliaDesktop を置く）は音の自動再生が許されるので「クリックで開始」を挟まない。
 *
 * 開発用（撮影・自動確認が使う）:
 * - ?start=ファイル[#ラベル] でタイトルを通さずそこから始める。?skip=N で N ページ目（そこから 1 で数える。lim trace の [N]）まで瞬時に進めて止まる
 * - ?autostart=1 なら「クリックで開始」を出さない（音は鳴らない）。?start がなければタイトルを開始の演出なしで出す
 * - ?autoplay=1 は自動確認（lim shot）。遊ぶ人の操作を待つ画面と動画は描かずに、命令の autoplay で進める（host.automated）
 * - ?play=1&from=<id> は Studio の「ここから遊ぶ」。Studio が localStorage に置いた、その行から始めるセーブを読んで始める
 *   （studio-play-from.ts。読めなければ ?start= から）
 * - ?studio=1 は Studio のプレビュー（iframe）。「クリックで開始」もタイトルも出さず、親の画面から受けたセーブ（StageMessage）を出す。
 *   命令の行では、受けた舞台の様子から本文の無い画面だけを組み立てる（stage-still）。
 *   書き手が舞台を押すまでは入力（focus）を取らない（選択肢のボタンなどへ移すと、制作画面で打った文字が舞台に吸われるため）。
 *   親の画面の頼みで、舞台を止める（音・演出・文字送り・オートを止める）・音を消す（studio-stage.ts）
 * キー操作（送り・スキップ・クイックセーブ／ロード・メニュー）はシステム画面が受ける（既定は system/default.ts）。
 */

/** JSON を読む。無い・JSON でない（開発サーバーが index.html を返す場合など）ときは fallback。 */
async function fetchJson<T>(url: string, fallback: T): Promise<T> {
  try {
    const r = await fetch(url);
    if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json")) return fallback;
    return (await r.json()) as T;
  } catch {
    // 読めない・無い表は無いものとして続ける（書き出しや開発サーバーによっては置かない表がある）
    return fallback;
  }
}


/** 書き出したゲーム（lim build が Vite の define で true にする。開発サーバーでは無い）。 */
declare const __LIMINALIA_EXPORT__: boolean | undefined;
const params = new URLSearchParams(location.search);
// 位置調整画面ではプレイヤーのメッセージ画面だけを透明な iframe に描く。
if (import.meta.hot && params.get("ui-preview") === "page" && params.get("cast-overlay") === "1") document.documentElement.classList.add("lm-cast-overlay");
/**
 * 制作画面の舞台として開かれた（開発サーバーのときだけ）。立ち絵の位置調整画面と同じく import.meta.hot で見る
 * （import.meta.env.DEV は NODE_ENV が production でない書き出しでも true になるため）。
 */
const studio = !!import.meta.hot && params.get("studio") === "1";
/**
 * スマホの見え方を真似る（?device=phone。Studio のプレビューの「端末」から。開発サーバーのときだけ）。
 * 指で触れる端末の UI（メニューのボタン・帯を隠す・縦向きの知らせ）と、ノッチの安全な表示領域を出す。
 */
if (import.meta.hot && params.get("device") === "phone") {
  const root = document.documentElement;
  root.classList.add("lm-emulate-touch");
  const insets = () => {
    // iPhone の横持ち（ノッチは左右）と縦持ち（ノッチは上、ホームバーは下）のおおよその余白
    root.dataset.safeArea = window.innerWidth >= window.innerHeight ? "0 47 21 47" : "47 0 34 0";
  };
  insets();
  window.addEventListener("resize", insets);
}
/** 本番と同じ見た目で遊ぶ（?play=1。Studio の「テストプレイ」）。開発時の位置表示や入口を重ねない。 */
const play = params.get("play") === "1";
/**
 * 制作画面の舞台では、止める頼み（stage-pause）に備えて、ほかより先に window のタイマーを止められるものに包む。
 * プレイヤー自身の待ち（頼みの順番・出し始めを待つ）は包む前のタイマーで数える（止めている間も頼みが詰まらないように）。
 */
const gate = import.meta.hot && studio ? new TimerGate(windowTimers(window)) : null;
if (gate) {
  gate.install(window);
  blockInputWhilePaused(window, gate);
}
const wait = (ms: number) => new Promise<void>((r) => (gate?.real ?? window).setTimeout(() => r(), ms));
const viewport = document.getElementById("viewport")!;
/**
 * 制作画面の「ゲームの画面」の見本（?ui-preview=screen&screen=<画面>。開発サーバーのときだけ。引数は screen-preview/samples.ts）。
 * セーブの置き場所を開く前に作り物の記憶の場所へ替え、読み込んだ作品の情報に見本の上書き（作り物のおまけ、テーマ、言語、向き）を重ねる。
 * import.meta.hot を条件に書くので、書き出しには入らない。
 */
const screenPreview = import.meta.hot && params.get("ui-preview") === "screen" ? await (await import("./screen-preview/run.ts")).prepareScreenPreview(params, project) : null;
// 「ゲームの設定」の見本（?ui-preview=page、save など）も、遊ぶ人のセーブ、既読、設定を読まず、書かない（作り物の記憶の場所にする）
if (import.meta.hot && params.get("ui-preview") && !screenPreview) (await import("./screen-preview/run.ts")).useSampleSaveStore(params, project);
// ページの題名（ブラウザのタブ）は作品の題名にする
if (project.title) document.title = project.title;
/** セーブの置き場所（ブラウザ版・iOS 版のアプリは IndexedDB）を開いて、作品と引き継げる作品の分を読んでおく（ほかの読み込みと並べる）。 */
const savesReady = prepareSaveStore([project.id, ...Object.keys(project.saves?.carryFrom ?? {})]);
/**
 * 起動したときに読む小さなものは、一度に取りに行く（一つずつ待つと、遠い配信元ほど始まるのが遅くなる）:
 * - 書き出しが作る素材の中身の鍵（"fgimage/a.png" → 短いハッシュ）。URL に付けて、差し替えた素材を古いキャッシュで出さない。開発中は無い
 * - スマホ版で縮めて名前（拡張子）が変わった素材（"voice/a.ogg" → "voice/a.m4a"。build.mobile）
 * - 解像度を下げて書き出した画像（"fgimage/a.png" → [元の幅, 元の高さ, 縮めた幅, 縮めた高さ]。images.scale）。元の大きさで出す
 * - スマホ版で縮めた音の、元の音に埋め込まれていたループの位置（"bgm/a.ogg" → 秒。縮めるとタグが消えるかずれるため、書き出しが読んでおく）
 * - 書き出したときの作品の版（project/build.json。版を上げただけでプログラムが変わらないよう、プログラムには埋めない）
 * - 追加の中身・修正（パック）の一覧と、作品のキャスト
 */
/** 起動のどこまで進んだか（制作画面の撮影が待ちきれなかったときの説明に出す。studio の describePage が読む）。 */
const boot = (stage: string) => {
  (globalThis as { __liminaliaBoot?: string }).__liminaliaBoot = stage;
};
boot("project");
const [assetHashes, assetRenamed, assetScale, audioLoops, buildInfo, packIds, projectCast] = await Promise.all([
  import.meta.hot ? ({} as Record<string, string>) : fetchJson<Record<string, string>>("project/assets.json", {}),
  import.meta.hot ? ({} as Record<string, string>) : fetchJson<Record<string, string>>("project/assets-renamed.json", {}),
  import.meta.hot ? ({} as AssetScaleTable) : fetchJson<AssetScaleTable>("project/assets-scale.json", {}),
  import.meta.hot ? ({} as Record<string, { start?: number; end?: number }>) : fetchJson<Record<string, { start?: number; end?: number }>>("project/audio-loops.json", {}),
  import.meta.hot ? null : fetchJson<{ version?: string; date?: string } | null>("project/build.json", null),
  import.meta.hot ? ([] as string[]) : window.liminaliaDesktop?.packs ? window.liminaliaDesktop.packs().catch((e: unknown): string[] => {
        // パックの一覧を読めなければ、パックなしで遊ぶ（開発者ツールに残す）
        console.warn("パックの一覧を読めません", e);
        return [];
      }) : fetchJson<string[]>("packs/index.json", []),
  fetchJson<{ speakers: string[]; cast: Record<string, CastEntry> }>("project/cast.json", { speakers: [], cast: {} }),
]);
if (Object.keys(assetScale).length > 0) installAssetScale();
/** 言語ごとの素材（言語 → "種類/パス" の集まり）と、今遊んでいる言語（原文なら ""。システム画面が setAssetLanguage で伝える）。 */
const localizedAssets = new Map(Object.entries(project.localizedAssets ?? {}).map(([language, keys]) => [language, new Set(keys)]));
let assetLanguage = "";

/**
 * 追加の中身・修正（パック。packs/<id>/）。デスクトップ版は入っているフォルダを、ほかは packs/index.json を見る（開発中は読まない）。
 * 本体の版（liminalia.json の version）が requires と違うものは読み込まずに知らせる。後に読むものが同じ名前を差し替える。
 */
if (buildInfo?.version) (project as { version?: string }).version = buildInfo.version;
const packs: PackManifest[] = [];
// パックの中身の一覧も一度に取りに行く（並びは一覧の順のまま）
boot("packs");
const manifests = await Promise.all(packIds.map((id) => fetchJson<PackManifest | null>(`packs/${encodeURIComponent(id)}/pack.json`, null)));
packIds.forEach((id, i) => {
  const m = manifests[i];
  if (!m) return;
  if (m.requires && project.version && m.requires !== project.version) {
    console.warn(`パック ${m.id} はバージョン ${m.requires} 用です（現在は ${project.version}）。読み込みません`);
    return;
  }
  packs.push({ ...m, id });
});
const sortedPacks = sortPacks(packs);
/** 名前 → それを差し替えるパックの id（後に読むものが勝つ）。 */
const packOwner = (kind: "scenario" | "data" | "assets") => new Map(sortedPacks.flatMap((p) => (p.files?.[kind] ?? []).map((f) => [f, p.id] as const)));
const packScenario = packOwner("scenario");
const packData = packOwner("data");
const packAssets = packOwner("assets");
const packUrl = (id: string, path: string) => `packs/${encodeURIComponent(id)}/${path.split("/").map(encodeURIComponent).join("/")}`;
/** キャストを差し替える最後のパック（パッチなど）。 */
const castPack = sortedPacks.findLast((p) => p.files?.cast);
const cast = castPack ? await fetchJson<{ speakers: string[]; cast: Record<string, CastEntry> }>(packUrl(castPack.id, "cast.json"), { speakers: [], cast: {} }) : projectCast;
// ゲームの画面の見本の話者（作品の cast.json には書かない）
screenPreview?.addSpeakers(cast.speakers);
if (sortedPacks.some((p) => p.extra)) (project as { extra?: ExtraConfig | undefined }).extra = mergePackExtra(project.extra, sortedPacks);

// 選んでいるテーマ（ui.system.preset）の画面と演出を、プラグインの項目に重ねる
const themePreset = project.ui?.system?.preset;
const webPlugins = installedPlugins.map((p) => withActiveTheme(p, themePreset));
// エンジンより新しい口を使うプラグイン（動かない口があるかもしれない）
for (const p of newerWebPlugins(installedPlugins)) console.warn(`プラグイン ${p.name} はプラグイン API バージョン ${p.apiVersion} 向けで、このエンジン（バージョン ${PLUGIN_API_VERSION}）より新しい API を使います`);

// プラグインの描画をまとめる（同じ命令名は後のプラグインが勝つ）
const extensions: Extensions = { renderers: {}, restorers: [], relocalizers: [] };
for (const p of webPlugins) {
  Object.assign(extensions.renderers, p.extensions?.renderers ?? {});
  extensions.restorers!.push(...(p.extensions?.restorers ?? []));
  extensions.relocalizers!.push(...(p.extensions?.relocalizers ?? []));
  if (p.extensions?.text) extensions.text = p.extensions.text;
  if (p.extensions?.dialogue) extensions.dialogue = p.extensions.dialogue;
  if (p.extensions?.sprites) extensions.sprites = { ...extensions.sprites, ...p.extensions.sprites };
  if (p.extensions?.spriteParts) extensions.spriteParts = { ...extensions.spriteParts, ...p.extensions.spriteParts };
}

const status = document.createElement("div");
status.className = "status";
let diagnostics = 0;
/** テストプレイの開発用の道具（開発サーバーだけ。play-dev.ts）。読み終えるまでに出た問題は early に貯めて渡す。 */
let playDev: import("./play-dev.ts").PlayDev | null = null;
const early: Parameters<NonNullable<DomHostOptions["onDiagnostic"]>>[0][] = [];
/** 最後に出したページ（制作画面への返事に使う）。 */
let lastPage: { file: string; line: number } | null = null;
/** 止まったときの記録に添える、直前に出したページと実行時の診断（crash.ts）。 */
const crashTrail = new CrashTrail();
/** 最後に出したページの鍵（テスト版の指摘が、行を足しても同じページを指すのに使う）。 */
let lastPageKey: string | undefined;
/** 制作画面の舞台のとき、ページを出し始めるたびに呼ぶ（舞台が自分で進んだことを知らせる）。 */
let onStudioPage: ((at: { file: string; line: number }) => void) | null = null;
/** 制作画面の舞台のとき、実行器が変数に値を入れるたびに呼ぶ（舞台で決まった値の出どころを控える）。 */
let onStudioAssign: ((path: string, at: { file: string; line: number }) => void) | null = null;
/** 制作画面の舞台のブレークポイント（connectStudio が置く）。 */
let studioBeforeStep: ((at: { file: string; line: number }) => Promise<void> | void) | null = null;

/**
 * 制作画面の「ゲームの設定」の見本（?ui-preview=page・choice・title・menu・save・load・config・log・ending・nvl）。開発サーバーのときだけ。
 * nvl は NVL の段落を二つ出す（?nvl-style= で ui.nvlStyles の名前を付けた見た目にする）。
 * 見本の台本（PREVIEW_FILE）を流すか、その画面を開く。?bg= で見本の背景（bgimage からのパス）を決める。
 * ?ui-preview=command&cmd=<命令名> はパーツの欄の動く見本（command-meta.ts の preview を繰り返し流す。
 * ?bg2=・?who=・?speaker=・?bgm=・?se=・?voice= も使う）。?sample-lang=en なら見本の文を英語にする（制作画面が自分の言語を渡す）。
 */
const uiPreview = import.meta.hot ? params.get("ui-preview") : null;
const systemPreview = !!uiPreview && ["menu", "save", "load", "config", "log"].includes(uiPreview);
/**
 * 配置の編集（?ui-preview=page・choice に layout=1）。?sprites= の [キャラクター ID, 立ち位置] の並びの立ち絵も出し、
 * 制作画面の頼み（liminalia:layout-probe・layout-draft）に今の配置を返す（layout-probe.ts）。
 */
const layoutMode = (uiPreview === "page" || uiPreview === "choice") && params.get("layout") === "1";
const PREVIEW_FILE = "__ui_preview__";
const sampleEnglish = params.get("sample-lang") === "en";

/** 配置の編集の見本に出す常駐の表示（?hud= の @hud-button・@hud-text の行。ほかの命令と、改行を含む行は外す）。 */
function layoutHud(): string[] {
  try {
    const list = JSON.parse(params.get("hud") ?? "[]") as unknown;
    return Array.isArray(list) ? list.filter((l): l is string => typeof l === "string" && /^@hud-(button|text)\s/.test(l) && !/[\r\n]/.test(l)) : [];
  } catch {
    // 制作画面が渡す見本の指定が読めなければ、見本を出さない
    return [];
  }
}

/** 配置の編集の見本に出す立ち絵（?sprites=。キャストに無い人物と、名前に使えない立ち位置は外す）。 */
function layoutSprites(): [string, string][] {
  try {
    const list = JSON.parse(params.get("sprites") ?? "[]") as unknown;
    if (!Array.isArray(list)) return [];
    return list.filter((p): p is [string, string] => Array.isArray(p) && typeof p[0] === "string" && typeof p[1] === "string" && Object.hasOwn(cast.cast, p[0]) && /^[\p{L}\p{N}_-]+$/u.test(p[1]));
  } catch {
    // 制作画面が渡す見本の指定が読めなければ、見本を出さない
    return [];
  }
}

function previewScript(): string {
  // 部品の見本（制作画面のパーツの欄）は書き出したゲームには入れない（__LIMINALIA_EXPORT__ は lim build が true にする）
  if (!(typeof __LIMINALIA_EXPORT__ !== "undefined" && __LIMINALIA_EXPORT__) && uiPreview === "command") return commandPreviewScript();
  // エンディングの名前の見本（ui.ending）: すぐにプレイを終えて、エンディングの名前を出したまま待つ
  if (uiPreview === "ending") return `@title-screen ending=good title=${JSON.stringify(sampleEnglish ? "Sample ending" : "見本のエンディング")}`;
  const bg = params.get("bg");
  const speaker = cast.speakers[0];
  if (uiPreview === "nvl") {
    const style = params.get("nvl-style") ?? "";
    return [
      "@text-speed 0ms",
      ...(bg ? [`@bg ${JSON.stringify(bg)} time=0ms`] : []),
      `@nvl on${/^[\p{L}\p{N}_-]+$/u.test(style) ? ` style=${style}` : ""}`,
      sampleEnglish
        ? speaker
          ? `${speaker} "This is a sample of NVL. Check the background, margins, text size and color here."`
          : "This is a sample of NVL. Check the background, margins, text size and color here."
        : speaker
          ? `${speaker}「NVL の見本です。背景、余白、文字サイズや色を、ここで確認できます。」`
          : "　NVL の見本です。背景、余白、文字サイズや色を、ここで確認できます。",
      sampleEnglish ? "The second paragraph is narration. Paragraphs stack on the screen." : "　二つ目の段落は地の文です。段落は画面に積み重なります。",
      "@stop",
    ].join("\n");
  }
  // 本文から始めても選択肢から始めても、背景とメッセージ枠を出す
  const instant = systemPreview || layoutMode;
  const setup = [
    ...(instant ? ["@text-speed 0ms"] : []),
    ...(bg ? [`@bg ${JSON.stringify(bg)}${instant ? " time=0ms" : ""}`] : []),
    ...(layoutMode ? layoutSprites().map(([who, at]) => `@chara ${JSON.stringify(who)} at=${at} time=0ms`) : []),
    ...(layoutMode ? layoutHud() : []),
    "@window show",
  ];
  return [
    ...setup,
    sampleEnglish
      ? speaker
        ? `${speaker} "This is a sample of the game settings. Check the text size and color, and the shape of the message window and name box here."`
        : "This is a sample of the game settings. Check the text size and color, and the shape of the message window here."
      : speaker
        ? `${speaker}「ゲームの設定の見本です。文字サイズや色、メッセージウィンドウと名前欄の形を、ここで確認できます。」`
        : "　ゲームの設定の見本です。文字サイズや色、メッセージウィンドウの形を、ここで確認できます。",
    sampleEnglish ? "The second page is narration. Pages already read are shown in the read color." : "　二ページ目は地の文です。既読のページは、既読の色で表示されます。",
    "@jump #ask",
    "# choice",
    ...setup,
    "# ask",
    "@choice",
    sampleEnglish ? "  - First choice -> #end" : "  - 一つ目の選択肢 -> #end",
    sampleEnglish ? "  - Second choice -> #end" : "  - 二つ目の選択肢 -> #end",
    "@end",
    "# end",
    "@stop",
  ].join("\n");
}

function commandPreviewScript(): string {
  const preview = COMMAND_META[params.get("cmd") ?? ""]?.preview;
  const bg = params.get("bg");
  // 人物と話者の名前は台本にそのまま入るので、空白、改行、引用符、@、{} を含むものは使わない（URL から行を足させない）
  const name = (v: string | null) => (v !== null && /^[^\s"@{}]+$/u.test(v) ? v : null);
  const who = name(params.get("who"));
  const quoted = (key: string, fallback: string | null = null) => JSON.stringify(params.get(key) ?? fallback ?? "");
  const fill = (line: string) =>
    line
      .replaceAll("{bg}", quoted("bg"))
      .replaceAll("{bg2}", quoted("bg2", bg))
      .replaceAll("{bgm}", quoted("bgm"))
      .replaceAll("{se}", quoted("se"))
      .replaceAll("{voice}", quoted("voice"))
      .replaceAll("{speaker}", name(params.get("speaker")) ?? who ?? "")
      .replaceAll("{who}", who ?? "");
  // 本文の見本はクリックを待たずに進める（オート）
  const setup = ["@auto start", ...(bg ? [`@bg ${JSON.stringify(bg)} time=0ms`] : []), ...(who ? [`@chara ${who} at=center time=0ms`] : [])];
  if (!preview) return [...setup, "@stop"].join("\n");
  const language = sampleEnglish ? "en" : "ja";
  return [...setup, "# loop", "@wait 600ms", ...preview.lines.map((l) => fill(previewLine(l, language))), "@wait 1200ms", ...(preview.reset ?? []).map(fill), "@jump #loop"].join("\n");
}

/** 素材の鍵（"bgm/a.ogg"）。遊んでいる言語の素材があれば、そちら（assets/<種類>/@<言語>/<パス>）。 */
function assetKey(kind: AssetKind, rawPath: string): string {
  const path = assetLanguage && localizedAssets.get(assetLanguage)?.has(`${kind}/${rawPath}`) ? `@${assetLanguage}/${rawPath}` : rawPath;
  return `${kind}/${path}`;
}

const hostOptions: DomHostOptions = {
  screen: project.screen,
  root: viewport,
  cast: cast.cast,
  ...(autoLayoutRules(project.autoLayout) ? { autoLayout: autoLayoutRules(project.autoLayout)! } : {}),
  extensions,
  studio,
  loadSource: async (file) => {
    if (uiPreview && file === PREVIEW_FILE) return screenPreview ? screenPreview.script() : previewScript();
    const pack = packScenario.get(file);
    const r = await fetch(pack ? packUrl(pack, `scenario/${file}.lim`) : `project/scenario/${file.split("/").map(encodeURIComponent).join("/")}.lim`);
    if (!r.ok) throw new Error(`${file}.lim を読み込めません（${r.status}）`);
    return r.text();
  },
  loadData: async (name) => {
    // ゲームの画面の見本の作り物のデータ（図鑑、調べる場所）
    const sample = screenPreview?.data(name);
    if (sample !== undefined) return structuredClone(sample);
    // .json を省いたら足す（データは .json だけ。名前に点があってもよい: code.en → code.en.json）
    const file = name.endsWith(".json") ? name : `${name}.json`;
    const pack = packData.get(file);
    // 作品に無いデータは取りに行かない（標準の図鑑などが有無を見る。404 を出さない）。開発サーバーでは、一覧は起動したときのままで
    // あとから足したデータが載らないので、一覧で止めずに取りに行く
    if (!pack && !import.meta.hot && project.dataFiles && !project.dataFiles.includes(file)) throw new Error(`data/${name} がありません`);
    const r = await fetch(pack ? packUrl(pack, `data/${file}`) : `project/data/${file.split("/").map(encodeURIComponent).join("/")}`);
    if (!r.ok) throw new Error(`data/${name} を読み込めません（${r.status}）`);
    return r.json();
  },
  asset: (kind: AssetKind, rawPath: string) => {
    // ゲームの画面の見本の作り物の絵と音、見本で当てたテーマの素材
    const sample = screenPreview?.asset(kind, rawPath);
    if (sample) return sample;
    const key = assetKey(kind, rawPath);
    const pack = packAssets.get(key);
    if (pack) return packUrl(pack, `assets/${key}`);
    const url = `assets/${(assetRenamed[key] ?? key).split("/").map(encodeURIComponent).join("/")}`;
    const hash = assetHashes[key];
    const full = hash ? `${url}?v=${hash}` : url;
    const scaled = assetScale[key];
    if (scaled) registerScaledAsset(full, scaled);
    return full;
  },
  // パックが差し替えた音は、書き出しの表のものではない
  audioLoop: (kind: AssetKind, rawPath: string) => {
    const key = assetKey(kind, rawPath);
    return packAssets.has(key) ? undefined : audioLoops[key];
  },
  onDiagnostic: (d) => {
    if (d.code === "unsupported-command" || d.code === "unknown-command" || d.code === "script-skipped") {
      console.info(`${d.file}:${d.line} ${d.message}`);
      return;
    }
    diagnostics++;
    crashTrail.diagnostic(d);
    console.warn(`${d.file}:${d.line} [${d.code}] ${d.message}`);
    // テストプレイの隅と制作画面のチェックにも知らせる（開発サーバーだけ）
    if (import.meta.hot) {
      if (playDev) playDev.diagnostic(d);
      else if (early.length < 200) early.push(d);
    }
  },
  onPage: (at, key) => {
    lastPage = at;
    lastPageKey = key;
    crashTrail.page(at);
    onStudioPage?.(at);
    status.textContent = `${at.file}:${at.line}${diagnostics ? `\n${devText(`エラーと警告 ${diagnostics} 件`, `${diagnostics} ${diagnostics === 1 ? "error or warning" : "errors and warnings"}`)}` : ""}`;
  },
};
const host = new DomHost(hostOptions);
// 自動確認（lim playtest は流す道具が host.automated を入れる）: 遊ぶ人の操作を待つ画面と動画は、命令の autoplay で進める
if (params.get("autoplay") === "1") host.automated = true;
// 撮影（lim shot。?autoplay=shot）: 撮る所（shotState）に着くまでだけ autoplay で進め、着いたら操作待ちの画面も描く
const shotSkip = Number(params.get("skip") ?? 0);
if (params.get("autoplay") === "shot") host.automateWhile(() => !shotArrived(shotSkip));
/** 撮る所に着いたか。skip が 1 以下なら開始位置から（最初のページより前の選択肢と操作待ちの画面も撮る）、2 以上なら skip ページ目を出してから。 */
function shotArrived(skip: number): boolean {
  return skip <= 1 || system.pages >= skip;
}
/** 操作待ちの画面（autoplay を持つ命令）を、この長さ描き続けたら撮る（開発用の早送りで飛ばす動画は、これより早く終わる）。 */
const SHOT_INPUT_SETTLE_MS = 500;
// システム画面の見本は、履歴などを用意するための本文を描き終えるまで隠す。
// visibility なら配置やセーブの縮小画像の計算は通常どおり行える。
if (systemPreview) host.stage.style.visibility = "hidden";
host.setUi(project.ui);
host.stage.classList.add(...themeRootClasses(installedPlugins, themePreset));
// 通知（@notify）の見た目の差し替え（後のプラグインが勝つ）
host.noticeLook = [...webPlugins].reverse().find((p) => p.screens?.toast)?.screens?.toast;
// 選択肢、名前欄、確かめと入力の枠の見た目の差し替え（同じ部品は後のプラグインが勝つ）
host.screens = Object.assign({}, ...webPlugins.map((p) => p.screens ?? {}));
// 作品の画面の型（ui.templates。開発サーバーでは書き換えると project.templates が替わる）。選択肢の層が読む
host.templateSource = () => project.templates;
for (const p of webPlugins) {
  boot(`setup ${p.name ?? ""}`);
  await p.setup?.(host);
}
// 作品の CSS（ui.css）は、テーマとプラグインの CSS（setup で足したものも）のあとに置く
installWorkCss();
// 作品の画面の JS（ui/screens/<画面>/<画面>.js。作品のプラグインと同じく、制限付きでは読まない）
installScreenScripts();

const { implementations } = combinePlugins(commandPlugins);
let ended = false;
boot("saves");
await savesReady;
const factory = [...webPlugins].reverse().find((p) => p.system)?.system ?? createDefaultSystem;
const title = [...webPlugins].reverse().find((p) => p.title)?.title;
const system: SystemController = factory({
  host,
  project,
  // URL で決めた言語（?lang=…。制作画面のプレビューで選んだ言語と、サイトの英語のページから開くときなど）。
  // 作品の languages にあればその回だけ使い、コンフィグに覚えた言語は書き換えない
  ...(params.get("lang") ? { language: params.get("lang")! } : {}),
  ...(title ? { title } : {}),
  // 標準の画面の見た目の差し替え（同じ画面は後のプラグインが勝つ）
  ...(webPlugins.some((p) => p.screens) ? { screens: Object.assign({}, ...webPlugins.map((p) => p.screens ?? {})) } : {}),
  // 起動の演出（後のプラグインが勝つ）
  ...(() => {
    const splash = [...webPlugins].reverse().find((p) => p.splash)?.splash;
    return splash ? { splash } : {};
  })(),
  ...(() => {
    const endSplash = [...webPlugins].reverse().find((p) => p.endSplash)?.endSplash;
    return endSplash ? { endSplash } : {};
  })(),
  // 画面の切り替えの幕（同じ項目は後のプラグインが勝つ）。ゲームの画面の見本では、作り物の状態を入れるロードで幕を下ろさない
  ...(() => {
    if (!webPlugins.some((p) => p.transitions)) return {};
    const transitions: Transitions = Object.assign({}, ...webPlugins.map((p) => p.transitions ?? {}));
    return { transitions: screenPreview ? screenPreview.transitions(transitions) : transitions };
  })(),
  // 標準のシステム画面の文言（同じ鍵は後のプラグインが勝つ）
  ...(webPlugins.some((p) => p.texts) ? { texts: Object.assign({}, ...webPlugins.map((p) => p.texts ?? {})) as Record<string, string> } : {}),
  // セーブに付ける作品のメタ情報（プラグインが返したものを重ねる）
  ...(webPlugins.some((p) => p.slotMeta)
    ? { slotMeta: (runtime: Runtime) => Object.assign({}, ...webPlugins.map((p) => p.slotMeta?.({ runtime, host }) ?? {})) as Record<string, Value> }
    : {}),
  // セーブの一覧に出す章の名前（名前を返した最後のプラグインのもの）
  ...(webPlugins.some((p) => p.slotChapter)
    ? {
        slotChapter: (runtime: Runtime, label: { file: string; label: string | null } | null) => {
          let name: string | null = null;
          for (const p of webPlugins) {
            const n = p.slotChapter?.({ runtime, host, label });
            if (typeof n === "string") name = n;
          }
          return name;
        },
      }
    : {}),
  extensions,
  commands: implementations,
  speakers: cast.speakers,
  onDiagnostic: (d) => host.onDiagnostic(d),
  setTextSpeed: (ms) => {
    hostOptions.defaultPerChar = ms;
  },
  setAssetLanguage: (language) => {
    assetLanguage = language;
  },
  onAssign: (path, _value, at) => onStudioAssign?.(path, at),
  ...(studio ? { beforeStep: (at: { file: string; line: number }) => studioBeforeStep?.(at) } : {}),
  // 訳を差し替える最後のパック（パッチなど）があればそちら
  loadTranslation: (language) => {
    const pack = sortedPacks.findLast((p) => p.files?.lang?.includes(language));
    // 書き出したゲームは訳のファイルが増えないので、無い言語の訳は取りに行かない（開発中は訳を足すことがあるので取りに行く）
    if (!pack && !import.meta.hot && project.translations && !project.translations.includes(language)) return Promise.resolve(null);
    return fetchJson(pack ? packUrl(pack.id, `lang/${language}.json`) : `project/lang/${encodeURIComponent(language)}.json`, null);
  },
  // パックが分岐を足したら、後に読むパックの重ねたフローチャートを使う
  loadFlow: () => {
    // ゲームの画面の見本の作り物のフローチャート
    const sample = screenPreview?.flow();
    if (sample) return Promise.resolve(sample);
    return sortedPacks.length > 0 ? fetchJson(packUrl(sortedPacks.at(-1)!.id, "flow.json"), null) : fetchJson("project/flow.json", null);
  },
  // 店の実績へ送る（デスクトップ版は Steam など。achievements.ts）
  ...achievementSink(),
  onEnd: (result) => {
    ended = true;
    window.__liminalia!.ended = true;
    // 最後に動かした行（result.at は次に動かす命令の番号で、行ではない）
    const at = system.runtime?.at;
    console.info(`終了: ${result.reason} (${at ? `${at.file}:${at.line}` : result.at.unit})`);
  },
});

// 描画側（命令の描画・restorer・作品の画面）からシステム画面へ届く口（RenderContext.system）
host.system = renderSystem(system);
// シナリオからの要求（@auto・@open-screen など）はシステム画面へ。扱わなければ描画側の既定の動きになる。
// 購入（@purchase・@restore-purchases）はシステム画面が扱わなければ店の口へ（store.ts）
const storeProducts = project.store?.products ?? {};
host.systemRequest = async (req) => (await system.request?.(req)) || (await storeRequest(req, { products: storeProducts, system, layer: host.stage }));
// 買ったもの（system.purchases）を店に確かめる（スマホ版とデスクトップ版の店があるときだけ）
if (!import.meta.hot) watchPurchases(storeProducts, system);
// Steam Input のアクション（デスクトップ版で build.steam.input があるとき）
bindStoreInput(system);
// 入っているパック（台本から system.packs.<id> で見る。値は版）
if (system.systemVariables) system.systemVariables.packs = Object.fromEntries(sortedPacks.map((p) => [p.id, p.version ?? true]));
for (const p of webPlugins) {
  boot(`ready ${p.name ?? ""}`);
  await p.ready?.({ host, system });
}

// 書き出し時に同梱したテスト用セーブ
boot("seeds");
const seeds = await fetchJson<SeedSave[]>("project/seed-saves.json", []);
if (seeds.length > 0) system.installSeedSaves(seeds);

// 右上の位置表示は開発時だけ（撮影スクリプトもこれを読む）。制作画面の舞台は本番と同じ見た目にするので出さない
if (import.meta.env.DEV && !studio && !play && !uiPreview) host.stage.append(status);
// 止まったときの記録（書き出したゲームだけ）
if (!import.meta.hot) {
  installCrashRecorder({
    projectId: project.id,
    version: project.version ?? "",
    where: () => (lastPage ? `${lastPage.file}:${lastPage.line}` : ""),
    context: () => {
      const step = system.runtime?.at;
      // 書き出したエンジンの版は project/build.json の engine（無い書き出しもある）
      const engine = (buildInfo as { engine?: unknown } | null)?.engine;
      return { step: step ? `${step.file}:${step.line}` : null, trail: crashTrail, language: assetLanguage, ...(buildInfo?.date ? { build: buildInfo.date } : {}), ...(typeof engine === "string" && engine ? { engine } : {}) };
    },
  });
}
// 遊ばれ方の統計（書き出したゲームで、作品が build.analytics を書いたときだけ。遊ぶ人が送ると答えるまで送らない。analytics.ts）。
// 書かない作品の書き出しでは __LIMINALIA_ANALYTICS__ が false になり、送る部品は束に入らない
if (typeof __LIMINALIA_ANALYTICS__ !== "undefined" && __LIMINALIA_ANALYTICS__ && !import.meta.hot && project.analytics && !uiPreview) {
  const target = project.analytics;
  void import("./analytics.ts").then((m) => {
    if (!m.analyticsAskable(host)) return;
    const analytics = m.installAnalytics({
      url: target.url,
      projectId: project.id,
      version: project.version ?? "",
      platform: playPlatform(),
      language: () => assetLanguage,
      // 自動の確かめ（lim playtest など）が始まったら送らない
      consent: () => m.analyticsConsent(project.id) === true && !host.automated,
      where: () => lastPage,
    });
    const choose = host.choose.bind(host);
    host.choose = async (...args) => {
      const at = system.runtime?.at ?? null;
      const picked = await choose(...args);
      if (at && picked !== null) analytics.choice(at, picked, args[0].length, args[3]?.[picked] ?? null);
      return picked;
    };
  });
}
// テスト版の指摘の口（lim build --feedback。製品の書き出しでは __LIMINALIA_FEEDBACK__ が false になり、この部品は束に入らない）
if (typeof __LIMINALIA_FEEDBACK__ !== "undefined" && __LIMINALIA_FEEDBACK__ && project.feedback && !studio && !uiPreview) {
  void import("./feedback.ts").then((m) => m.installFeedback({ stage: host.stage, project, build: buildInfo, where: () => (lastPage ? { ...lastPage, ...(lastPageKey ? { key: lastPageKey } : {}) } : null) }));
}
// 変数の監視（開発サーバーだけ。F9）。書き出しには入れない
if (import.meta.hot && !studio && !uiPreview) void import("./var-watch.ts").then((m) => m.installVarWatch(host.stage, system));
// 重さの計測（開発サーバーだけ。F10。lim profile も読む）。書き出しには入れない
if (import.meta.hot && !studio && !uiPreview) void import("./perf-watch.ts").then((m) => m.installPerfWatch(host.stage));
// テストプレイの道具（開発サーバーだけ）: シナリオが変わったら「この場所から読み直す」（⇧R）、このページをシナリオで開く（⇧E）、実行時の問題を隅に。
// 書き出しには入れない
if (import.meta.hot && !studio && !uiPreview) {
  const hot = import.meta.hot;
  void import("./play-dev.ts").then((m) => {
    playDev = m.installPlayDev({
      stage: host.stage,
      system,
      // 選択肢を出している間はその選択肢の行、ほかは最後に出したページ
      page: () => (host.choosing ? (system.runtime?.at ?? null) : null) ?? lastPage,
      hot,
      corner: params.get("autostart") !== "1",
      belowStatus: !play,
    });
    for (const d of early.splice(0)) playDev.diagnostic(d);
  });
}

// 開発時: 立ち絵の位置調整画面への入口（撮影・自動確認の ?autostart=1 では出さない）と、そこで保存したときの描き直し
if (import.meta.hot) {
  if (params.get("autostart") !== "1" && !studio && !play && !uiPreview) {
    const link = document.createElement("a");
    link.className = "dev-link";
    link.href = "/__liminalia/cast";
    link.target = "_blank";
    link.textContent = devText("立ち絵の位置調整", "Sprite positions");
    link.addEventListener("click", (e) => {
      e.stopPropagation();
      // 表示中の最初の立ち絵を開く
      const [who, sprite] = Object.entries(system.runtime?.state.stage.sprites ?? {})[0] ?? [];
      const q = who && sprite ? `?${new URLSearchParams({ who, appearance: sprite.appearance, variant: sprite.variant, position: sprite.at })}` : "";
      link.href = `/__liminalia/cast${q}`;
    });
    host.stage.append(link);
  }
  // 作品のデータやプラグインのコードが変わった（vite.config.ts の playerOnlyReload）。プレイヤーだけ読み直す
  import.meta.hot.on("liminalia:player-reload", () => location.reload());
  // 変数の初期値とコマンドの既定値（次の「はじめから」・ロードから効く）と見た目と操作の設定（すぐ効く）が変わった
  import.meta.hot.on("liminalia:live-config", (sent: { variables?: Record<string, Value>; ui?: UiConfig; templates?: Record<string, string>; extra?: ExtraConfig; items?: ItemsConfig; languages?: string[]; commandDefaults?: CommandDefaults; autoLayout?: unknown; version?: string }) => {
    // ゲームの画面の見本は、見本の上書き（テーマ、言語、作り物のおまけと持ち物）を重ね直す
    const next = screenPreview ? screenPreview.live(sent) : sent;
    const p = project as { variables?: Record<string, Value> | undefined; ui?: UiConfig | undefined; templates?: Record<string, string> | undefined; extra?: ExtraConfig | undefined; items?: ItemsConfig | undefined; languages?: string[] | undefined; commandDefaults?: CommandDefaults | undefined };
    p.variables = next.variables;
    p.commandDefaults = next.commandDefaults;
    p.ui = next.ui;
    // 作品の画面の型（次に開いた画面から効く）
    p.templates = next.templates;
    p.extra = next.extra;
    p.items = next.items;
    p.languages = next.languages;
    // 作品の版（次の「はじめから」とロードから効く。実行器を作るときに読み、セーブの版と式の save.version になる）
    (project as { version?: string | undefined }).version = sent.version;
    // 自動配置の並べ方（すぐ効く。次に出す人物から新しい規則で並べ、表示中の立ち絵も置き直す）
    (project as { autoLayout?: unknown }).autoLayout = sent.autoLayout;
    const rules = autoLayoutRules(sent.autoLayout);
    if (system.runtime) system.runtime.autoLayout = rules;
    void host.replaceAutoLayout(rules, system.runtime?.state.stage ?? null);
    // テーマが替わると画面の差し替えも替わるので、読み込み直す
    if (next.ui?.system?.preset !== themePreset && installedPlugins.some((p) => p.themes)) {
      location.reload();
      return;
    }
    host.setUi(next.ui);
    system.uiChanged?.();
    if (screenPreview) screenPreview.changed();
    else if (uiPreview) reportUi();
  });
  import.meta.hot.on("liminalia:cast", async () => {
    const next = await fetchJson<{ cast: Record<string, CastEntry> } | null>("project/cast.json", null);
    if (next && system.runtime) system.runtime.cast = next.cast ?? {};
    if (next) await host.replaceCast(next.cast ?? {}, system.runtime?.state.stage ?? null);
    // 配置の編集: 引いている間のずらしを外し（新しい枠の位置に置き直した）、今の配置を知らせる
    if (layoutMode) {
      (await layoutProbe()).nudgeSprites(host.context, {});
      reportLayout();
    }
  });
}

/**
 * 遊んでいる途中に新しい版が置かれたら知らせる（書き出したブラウザ版だけ。版は project/build.json の date。
 * デスクトップ版とスマホ版のアプリは中身が手元にあり、アップデートは別の仕組み）。
 */
const buildWatch = !import.meta.hot && buildInfo?.date && !detectPlatform().app ? watchBuild({ stamp: buildInfo.date, parent: host.stage }) : null;

boot("ready");
window.__liminalia = {
  host,
  system,
  runtime: () => system.runtime,
  pages: () => system.pages,
  screen: () => ({ mode: system.mode, screen: system.screen }),
  shotReady: () => host.shotReady,
  shotState: (skip) => {
    const pages = system.pages;
    if (window.__liminalia?.ended) return { ready: "end", pages };
    if (pages >= skip && host.waiting) return { ready: "page", pages };
    const arrived = shotArrived(skip);
    // 撮る所より前の選択肢は、撮影では選ばないので先へ進めない
    if (host.choosing) return arrived ? { ready: "choice", pages } : { blocked: "choice", pages };
    if (arrived && (host.interactiveFor() ?? 0) >= SHOT_INPUT_SETTLE_MS) return { ready: "input", pages };
    return null;
  },
  ended: false,
  // スマホ版のアプリは裏へ回る前にこれを呼ぶ（オートセーブと保存。packages/cli/src/mobile）。保存先に入るまで待てる Promise を返す
  leave: () => {
    system.leave?.();
    return flushSaveStore();
  },
  flushSaves: flushSaveStore,
  saves: saveStoreTools(),
  // 戻る（Android のアプリの戻るボタンとなぞり、スマホのブラウザの戻る）。扱ったら true（扱わなければアプリは裏へ回り、ブラウザは前のページへ戻る）。
  // 入力の枠が扱わなかったとき（上にメニューなどを開いている）は、システム画面に渡す
  back: () => runBackHandler() === true || (system.back?.() ?? false),
  checkBuild: () => buildWatch?.check() ?? Promise.resolve(false),
};
// スマホのブラウザとホーム画面に置いた PWA は、戻るでゲームから出ていかないように履歴に一つ積む（アプリと制作画面の舞台では積まない）
if (!studio && !uiPreview && window.parent === window && !detectPlatform().app) installHistoryBack(() => window.__liminalia!.back!());
// デスクトップ版はウィンドウを閉じる前に（終了・閉じるボタン・Cmd+Q・更新のあとの再起動）。セーブのファイルを書き終えてから閉じる
window.liminaliaDesktop?.onBeforeClose?.(() => {
  system.leave?.();
  return flushSaveStore();
});

/**
 * 制作画面の舞台では、舞台が入力を持っていない（書き手が制作画面で打っている）間は focus を移さない。
 * 選択肢のボタン・入力の枠・システム画面・プラグインの画面がそれぞれ focus() を呼ぶので、要素の focus() そのものを止める。
 * 書き手が舞台を押せば舞台が入力を持ち、ふだんどおり移る。
 */
function keepFocusInStudio(): void {
  const focus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
    if (document.hasFocus()) focus.call(this, options);
  };
}

/** 舞台がページ（か選択肢）を出し始めるのを待つ上限。 */
const SHOWN_TIMEOUT = 3000;

/**
 * loadSave のあと、出し始めたページ（選択肢ならその選択肢）の位置。着く前に終わったら null。
 * システム画面によっては loadSave がページを出す前に解決する（ロードの幕を下ろしてから組み立て直すものなど）ので、
 * ページが出るか、実行器が選択肢で止まるまで待つ（上限 SHOWN_TIMEOUT。過ぎたら実行器の今の位置）。
 */
async function shownAt(): Promise<{ file: string; line: number } | null> {
  const deadline = performance.now() + SHOWN_TIMEOUT;
  for (;;) {
    if (lastPage) return lastPage;
    if (ended) return null;
    const at = system.runtime?.at ?? null;
    if ((at && host.choosing) || performance.now() > deadline) return at;
    // 隠れた iframe では requestAnimationFrame が止まるので、時間で待つ
    await wait(16);
  }
}

/**
 * 前の頼み（ロードして組み立て直す・画面だけ組み立てる）が終わるのを待つ上限。
 * 組み立て直しの途中で次を始めると、二つの組み立てが混ざる（前の実行器がまだ動き出す前に捨てると止まらないことも）ので、順に行う。
 */
const STAGE_TURN_TIMEOUT = 5000;

/**
 * 制作画面の舞台: 親の画面（同じオリジン）から StageMessage を受けて出し、StageReply を返す。
 * 舞台を別ウィンドウに出したとき（window.open で開かれたとき）は、開いた制作画面（opener）が親の画面になる。
 */
let shows = 0;
let stageTurn: Promise<unknown> = Promise.resolve();
function connectStudio(timers: TimerGate): void {
  const studioWindow: Window = window.parent !== window ? window.parent : (window.opener ?? window.parent);
  const reply = (m: StageReply) => studioWindow.postMessage(m, location.origin);
  const freeze = new StageFreeze(timers, host.audio);
  const mute = new StageMute(host.audio);
  const controlled = () => reply({ type: "liminalia:stage-controlled", paused: freeze.paused, muted: mute.isMuted });
  // 頼まれたページを出し終えてから先は、舞台が自分で進んだ分（押す・オート・スキップ・選ぶ）として知らせる
  let progressing = false;
  // 頼まれたページから先で値を入れた行と選んだ選択肢（頼みを始めるたびに空にする）
  let assigned: Record<string, Origin> = {};
  let choices: RouteStep[] = [];
  onStudioAssign = (path, at) => {
    // 入れ直したものを後ろへ（画面は入れ子のパスの最後に入れた行を使う）
    delete assigned[path];
    assigned[path] = { file: at.file, line: at.line };
  };
  // 値を変えて試す（stage-set-var）と、プレビューが今出している行と、実行器が動いているか（命令の行の画面や終わったプレイには実行器が無い）
  const stageVars = new StageVariables();
  let stageAt: { file: string; line: number } | null = null;
  let live = false;
  let stillNext: SaveData | null = null;
  const played = (): StagePlayed | null => {
    const rt = system.runtime;
    // ページ（選択肢）を出し始めた時点の save() は、そのページから再開するセーブ（現在地の行の状態と同じ時点）
    return rt ? { save: stageVars.patch(rt, rt.save()), temp: rt.state.temp, assigned, choices, system: rt.system } : null;
  };
  // ブレークポイント（"ファイル:行" → 条件の式。無ければ null）と、止めて待っている実行器を進める関数。stepping なら次の命令でも止める（一つずつ進める）
  let breakpoints = new Map<string, string | null>();
  let held: (() => void) | null = null;
  let stepping = false;
  /** 条件の式が真か（読めない・評価できない式は、書き手が気づけるよう止める）。 */
  const holds = (cond: string): boolean => {
    try {
      const v = system.runtime?.eval(parseExpr(cond));
      return v !== false && v !== null && v !== undefined && v !== 0 && v !== "";
    } catch {
      // 式の誤りは実行時の診断で知らせている。メニューの項目は出したままにする
      return true;
    }
  };
  studioBeforeStep = (at) => {
    // 頼まれたページを出すまで（組み立て直し）は止めない。舞台が自分で進んだ分だけ
    if (!progressing) return;
    if (!stepping) {
      const key = `${at.file}:${at.line}`;
      if (!breakpoints.has(key)) return;
      const cond = breakpoints.get(key);
      if (cond && !holds(cond)) return;
    }
    stepping = false;
    return new Promise<void>((resolve) => {
      held = resolve;
      stageAt = at;
      freeze.pause();
      controlled();
      reply({ type: "liminalia:stage-break", at, played: played() });
    });
  };
  const progress = (at: { file: string; line: number } | null) => {
    if (progressing && at) {
      stageAt = at;
      reply({ type: "liminalia:stage-progress", at, played: played() });
    }
  };
  onStudioPage = progress;
  const choose = host.choose.bind(host);
  host.choose = async (...args) => {
    const at = system.runtime?.at ?? null;
    progress(at);
    const picked = await choose(...args);
    const [texts, , looks] = args;
    if (at && picked !== null) choices.push({ file: at.file, line: at.line, option: picked, text: texts[picked] || looks?.[picked]?.image || "" });
    return picked;
  };
  /** 頼みを順に行う。待っているあいだに次の頼みが来たら、古いものは飛ばす。 */
  const enqueue = (seq: number, work: () => Promise<void>) => {
    const turn = stageTurn.then(() => (seq === shows ? work() : undefined));
    stageTurn = Promise.race([turn, wait(STAGE_TURN_TIMEOUT)]).catch((e: unknown) => console.warn(e));
  };
  const showSave = (save: SaveData) => {
    if (!system.loadSave) return;
    const loadSave = system.loadSave.bind(system);
    const seq = ++shows;
    progressing = false;
    enqueue(seq, async () => {
      lastPage = null;
      ended = false;
      assigned = {};
      choices = [];
      await loadSave(save);
      const at = await shownAt();
      if (seq === shows) {
        stageAt = at;
        live = at !== null;
        const rt = system.runtime;
        reply({ type: "liminalia:stage-shown", at, ...(rt ? { system: rt.system } : {}) });
        progressing = true;
      }
    });
  };
  host.stage.addEventListener("click", (event) => {
    if (!stillNext || freeze.paused || (event.target instanceof Element && event.target.closest("button, a, input, select, textarea"))) return;
    const next = stillNext;
    stillNext = null;
    showSave(next);
  }, { capture: true });
  window.addEventListener("message", (e: MessageEvent<StageMessage>) => {
    if (e.origin !== location.origin || e.source !== studioWindow) return;
    const m = e.data;
    if (m?.type === "liminalia:stage-show" || m?.type === "liminalia:stage-still") {
      // 止めて待っていた実行器は、新しい頼みで捨てる（進めない）
      held = null;
      // 変えて試した値は組み立て直すと元に戻す
      live = false;
      stillNext = null;
      stageVars.restore();
    }
    if (m?.type === "liminalia:stage-show") {
      if (!system.loadSave) {
        console.warn("このシステム画面は loadSave を持たないため、Studio のプレビューに使えません");
        return;
      }
      showSave(m.save);
    } else if (m?.type === "liminalia:stage-still") {
      const seq = ++shows;
      progressing = false;
      enqueue(seq, async () => {
        await showStill(m.stage);
        if (seq === shows) {
          stillNext = m.next ?? null;
          reply({ type: "liminalia:stage-still-shown" });
        }
      });
    } else if (m?.type === "liminalia:stage-cast") {
      void host.replaceCast(m.cast, system.runtime?.state.stage ?? null);
    } else if (m?.type === "liminalia:stage-pause") {
      // 頼みの順番を待たずにすぐ止める（組み立て直しの途中なら、そこで止まる）
      freeze.pause();
      controlled();
    } else if (m?.type === "liminalia:stage-resume") {
      freeze.resume();
      controlled();
      // ブレークポイントで止めていたら、その命令から続ける
      const go = held;
      held = null;
      go?.();
    } else if (m?.type === "liminalia:stage-measure") {
      // 書体が読めてから計る（頼みの順番は待たない。見えない写しで計るので、出している画面は変えない）
      const { id, pages } = m;
      void document.fonts.ready.then(() => reply({ type: "liminalia:stage-measured", id, results: host.measurePages(pages as never) }));
    } else if (m?.type === "liminalia:stage-step") {
      // 止めている命令を実行して、次の命令の前でまた止める
      if (held) {
        stepping = true;
        freeze.resume();
        controlled();
        const go = held;
        held = null;
        go();
      }
    } else if (m?.type === "liminalia:stage-breakpoints") {
      breakpoints = new Map(m.points.map((p) => [`${p.file}:${p.line}`, p.cond?.trim() ? p.cond.trim() : null]));
    } else if (m?.type === "liminalia:stage-mute") {
      mute.set(m.muted);
      controlled();
    } else if (m?.type === "liminalia:stage-set-var") {
      // 頼みの順番の後ろで行う（組み立て直しの途中の実行器に入れない）。止めていても効く
      const { path, value } = m;
      void stageTurn.then(() => {
        const rt = system.runtime;
        const error = rt && live && !ended ? stageVars.set(rt, path, value) : "no-play";
        reply({ type: "liminalia:stage-var-set", path, value, at: stageAt, played: played(), ...(error ? { error } : {}) });
      });
    }
  });
  // 閉じるときも、変えて試した system の変数を残さない（システム画面が書き残す前に戻す）
  window.addEventListener("pagehide", () => stageVars.restore(), { capture: true });
  reply({ type: "liminalia:stage-ready" });
}

/**
 * 命令の行を実行した直後の画面（本文の前）を組み立てる。今のプレイ（実行器）は止めて進めず、
 * 描画側の組み立て直し（ロードと同じ restore。プラグインの restorers も呼ぶ）だけで出す。restore はメッセージ枠の本文と名前も空にする。
 * システム画面には触れないので、プラグインがシステム画面を差し替えた作品でも同じように動く。
 */
async function showStill(stage: StageState): Promise<void> {
  system.runtime?.dispose();
  lastPage = null;
  await host.present({ type: "command", name: "restore", args: {}, wait: false, stage });
}

const start = params.get("start") ?? (project.titleScreen ? null : project.entry);
const autostart = params.get("autostart") === "1";
/** 制作画面の「ここから遊ぶ」が置いたセーブ（?play=1&from=。開発サーバーのときだけ。読めなければ一緒に付いてくる ?start= から始める）。 */
const playFrom = import.meta.hot && play ? readPlayFrom(params.get("from")) : null;

/** 開発用の開始位置から始める。?autostart=1 でなければ「クリックで開始」を挟む（音を鳴らすには押す操作が要るため）。 */
function startOnClick(run: () => void): void {
  if (autostart) {
    run();
    return;
  }
  const gate = document.createElement("div");
  gate.className = "layer start";
  // 遊んでいる言語の文言（システム画面を作ったときに決まる。指で触る端末は「タップで開始」）
  const touch = typeof matchMedia === "function" && matchMedia("(any-pointer: coarse)").matches;
  gate.textContent = touch ? TEXT.gateTouch : TEXT.gate;
  host.stage.append(gate);
  gate.addEventListener(
    "click",
    async (e) => {
      e.stopPropagation();
      gate.remove();
      await host.audio.unlock();
      run();
    },
    { once: true },
  );
}
// import.meta.hot を条件に直接書くと、書き出しでは connectStudio ごと消える
if (screenPreview) {
  // ゲームの画面の見本: 作り物の中身で画面を開き、開き終えたら制作画面へ知らせる
  void screenPreview.run({ host, system, plugins: webPlugins });
} else if (uiPreview) {
  if (layoutMode) {
    // 配置の編集: 舞台の大きさが変わったら（制作画面の欄の大きさを変えた）測り直して知らせる
    window.addEventListener("resize", () => reportLayout());
    // 制作画面の頼みで今の配置を知らせ、引いている間の見た目を当てる（保存はしない。保存したら live-config と cast で当て直す）
    window.addEventListener("message", (e: MessageEvent<LayoutMessage>) => {
      if (e.source !== window.parent || e.origin !== location.origin) return;
      const msg = e.data;
      if (msg?.type === "liminalia:layout-probe") reportLayout();
      else if (msg?.type === "liminalia:layout-draft") {
        if (msg.ui) {
          (project as { ui?: UiConfig }).ui = msg.ui;
          host.setUi(msg.ui);
          system.uiChanged?.();
        }
        if (msg.sprites) void layoutProbe().then((probe) => probe.nudgeSprites(host.context, msg.sprites!));
        if (msg.hud) void layoutProbe().then((probe) => probe.placeHud(host.context, msg.hud!));
      }
    });
  }
  // NVL の見本: 一つ目の段落を出したら次へ進めて、二つの段落を並べる
  if (uiPreview === "nvl") {
    const next = () => (host.waiting ? host.advance() : void setTimeout(next, 50));
    next();
  }
  // 本文か選択肢が出たら、ゲームの設定が効いているかを制作画面へ知らせる
  const ready = () => {
    if (!(uiPreview === "page" ? host.waiting : uiPreview === "choice" ? host.choosing : true)) return void setTimeout(ready, 100);
    reportUi();
  };
  ready();
  if (uiPreview === "title") void system.showTitle(true);
  else {
    system.startAt(uiPreview === "choice" ? `${PREVIEW_FILE}#choice` : PREVIEW_FILE);
    if (systemPreview) {
      // 見本のページを出してから画面を開く（セーブの縮小画像と履歴に、そのページが入る）
      const open = () => {
        if (!host.waiting) return void setTimeout(open, 50);
        void system.request?.({ name: "open-screen", args: { screen: uiPreview } });
        host.stage.style.visibility = "";
      };
      open();
    }
  }
} else if (import.meta.hot && studio && gate) {
  keepFocusInStudio();
  connectStudio(gate);
} else if (playFrom && system.loadSave) {
  // 制作画面の「ここから遊ぶ」: その行を実行する直前の背景・立ち絵・BGM・変数のセーブから始める
  const loadSave = system.loadSave.bind(system);
  startOnClick(() => void loadSave(playFrom));
} else if (params.get("resume") === "1" && system.resumeLeft) {
  // スマホのアプリが、落ちた描画のプロセスを作り直して読み直した。裏へ回したときのオートセーブから続ける（無ければふつうに起動する）
  const resume = system.resumeLeft.bind(system);
  startOnClick(() => void resume().then((ok) => (ok ? undefined : system.boot())));
} else if (start !== null) {
  system.devSkipUntil = Number(params.get("skip") ?? 0);
  startOnClick(() => system.startAt(start));
} else if (autostart) {
  void system.showTitle(true);
} else if (window.liminaliaDesktop) {
  void system.boot();
} else {
  system.showGate();
}
// 読み込みの表示（index.html）を外す（ここからはゲームの画面が出る）
document.getElementById("lm-boot")?.remove();

/** 見本で、プラグインが差し替えた画面と、効かない項目を制作画面（ゲームの設定）へ知らせる（ui-probe.ts）。 */
function reportUi(): void {
  // 描き終えてから測る（設定を当てた直後の配置も入るように）
  requestAnimationFrame(() => {
    const probe = uiPreview === "page" || uiPreview === "choice" ? probeUi(host.context) : { probed: [], ignored: [] };
    const report: UiReport = { type: "liminalia:ui-report", replaced: replacedScreens(webPlugins), ...probe };
    window.parent.postMessage(report, location.origin);
    reportLayout();
  });
}

/** 配置の編集の測り方（layout-probe.ts。配置の編集のときだけ読み込む）。 */
function layoutProbe(): Promise<typeof import("./layout-probe.ts")> {
  return import("./layout-probe.ts");
}

/** 配置の編集: 立ち絵を置き終えて描いてから、今の配置を制作画面へ知らせる。 */
function reportLayout(): void {
  if (!layoutMode) return;
  void Promise.all([layoutProbe(), host.context.spriteReady()]).then(([probe]) =>
    requestAnimationFrame(() => window.parent.postMessage(probe.layoutReport(host.context, system.runtime?.state.stage, host.context.cast), location.origin)),
  );
}
