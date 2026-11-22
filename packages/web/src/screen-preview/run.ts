import { applyUiTheme, UI_THEMES, type Flow, type UiConfig, type UiThemePreset } from "@liminalia/lang";
import type { ScreenPreviewMessage, ScreenPreviewReport } from "@liminalia/studio/protocol";
import type { AssetKind, DomHost } from "../dom-host.ts";
import type { PlayerProject, SystemController, Transitions, WebPlugin } from "../plugin.ts";
import { SCREEN_CATALOG } from "../system/screen-catalog.ts";
import { playSplash } from "../system/splash.ts";
import { loadScreenTemplates } from "../system/standard-templates.ts";
import { Storage, useMemorySaveStore, type KeyValueStore } from "../system/storage.ts";
import { TEXT } from "../system/strings.ts";
import { toast } from "../system/ui.ts";
import { setWorkCssDraft, setWorkCssFileDraft } from "../work-css.ts";
import { inspectScreen } from "./inspect.ts";
import { SAMPLE_ASSET, SCREEN_SAMPLES, sampleContent, sampleFlow, sampleImage, sampleSave, sampleScript, sampleSpeakers, sampleSplash, sampleWarning, type SampleContent, type SampleContext, type SampleState } from "./samples.ts";

/**
 * 制作画面の「ゲームの画面」の見本（プレイヤーの ?ui-preview=screen。開発サーバーのときだけ main.ts が読む）。
 * 標準の画面を、作り物の中身（samples.ts）の入った状態で開く。開き方と URL の引数は samples.ts の頭に書いた。
 *
 * - 遊ぶ人のセーブ、既読、設定は読まず、書かない: 起動の前に記憶の場所を作り物（MemoryStore。ページを閉じれば消える）に替える
 * - 作品のファイルは変えない: テーマ、言語、向き、作り物のおまけなどは、読み込んだ作品の情報（virtual:liminalia/project）にだけ重ねる
 * - プラグインが差し替えた画面は、その画面のまま出す（システム画面がふだんどおり差し替えを使う）。どのプラグインのものかを知らせる
 * - liminalia.json が変わったら（live-config）見た目をすぐ当て、少し待ってから同じ画面を開き直す。テーマが変わったら読み込み直す
 * - 制作画面の欄を引いている間は、送られた設定（liminalia:screen-draft）の見た目をその場で当てる（開き直さない）。
 *   作品の CSS の行（css）は、作品の CSS のあとに置く（work-css.ts の setWorkCssDraft）。テンプレートの欄で保存する前のテンプレート（template）は、
 *   その画面の作品のテンプレートの代わりに使い、同じ画面を開き直す（保存したあとの liminalia.json の知らせでも、保存する前のものを重ね続ける）
 * - 作り物の状態はロード（loadFrom）で入れるが、ロードの幕（WebPlugin.transitions.load）は通さない（transitions()。幕を待つより、
 *   そもそも下ろさない方が、幕の長さやプラグインの作りによらず画面だけを出せる）
 * - 開き終えたら、画面が見えているか、覆うものが残っていないかを確かめ（inspect.ts）、見つけたことを problems に出す
 * - 制作画面の中で開いたときは、制作画面の欄からフォーカスを奪わない（keepParentFocus）
 */

/** ページを閉じれば消える記憶の場所（localStorage と同じ形）。 */
class MemoryStore implements KeyValueStore {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
}

/**
 * 制作画面の「ゲームの設定」の見本（?ui-preview=page、save、config、log など）の記憶の場所を作り物にする（プレイヤーが記憶の場所を開く前に呼ぶ）。
 * 遊ぶ人のセーブ、既読、設定は読まず、書かない。セーブとロードの見本には、ゲームの画面の見本と同じ作り物のセーブを入れる。
 */
export function useSampleSaveStore(params: URLSearchParams, project: PlayerProject): void {
  const store = new MemoryStore();
  useMemorySaveStore(store);
  const preview = params.get("ui-preview");
  if (preview !== "save" && preview !== "load") return;
  const c: SampleContext = { lang: sampleLanguage(params, project.languages), state: "filled", bg: params.get("bg") || `${SAMPLE_ASSET}bg` };
  const storage = new Storage(project.id, store, { protect: project.saves?.protect ?? false });
  for (const [slot, record] of sampleContent("saveload", c).slots) storage.saveSlot(slot, record);
}

/** 見本のシナリオの頭から始めるセーブを置く枠（一覧に出ない番号）。 */
const BASE_SLOT = "auto:999" as const;
/** 開くのを待つ上限。 */
const OPEN_TIMEOUT = 15_000;
/** 開き直すまで待つ時間（続けて保存したときにまとめる）。 */
const RESHOW_DELAY = 200;
/** 開き終えたあと、覆うもの（プラグインが自分で出した幕など）が消えるのを待つ上限。 */
const CLEAR_TIMEOUT = 4000;

/** 見本の様子（window.__liminaliaScreenPreview。撮影の道具と確かめのテストが読む）。 */
export interface ScreenPreviewState {
  screen: string;
  state: SampleState;
  status: ScreenPreviewReport["status"];
  replaced: Record<string, string>;
  /** 開けなかった理由、ページの例外、開き終えたときの確かめ（checks）で見つけたこと。 */
  problems: string[];
  /** 開き終えたときの確かめ（inspect.ts。画面が見えない、覆うものが残っている、中身が無い）で見つけたこと。開き直すたびに入れ替える。 */
  checks: string[];
}

declare global {
  interface Window {
    __liminaliaScreenPreview?: ScreenPreviewState;
    /** 今の画面を確かめ直す（inspect.ts。lim shot --screen が撮る直前に呼ぶ）。 */
    __liminaliaScreenCheck?: () => string[];
  }
}

/** 見本の実行に渡すもの（main.ts がプレイヤーを組み立てたあと）。 */
export interface ScreenPreviewEnv {
  host: DomHost;
  system: SystemController;
  /** テーマを重ねたプラグインの見た目の側（後のものが勝つ）。 */
  plugins: readonly WebPlugin[];
}

/** 開発中に変わる作品の設定（main.ts の liminalia:live-config）。 */
export interface LiveConfig {
  ui?: UiConfig;
  extra?: PlayerProject["extra"];
  items?: PlayerProject["items"];
  languages?: string[];
  templates?: PlayerProject["templates"];
}

export interface ScreenPreview {
  readonly id: string;
  readonly context: SampleContext;
  /** 変わった作品の設定に、見本の上書き（テーマ、言語、作り物のおまけと持ち物、注意書き）を重ねる。 */
  live<T extends LiveConfig>(next: T): T;
  /** 見本で使う画面の切り替えの幕（ロードの幕 load を外す。作り物の状態を入れるロードで幕を下ろさない）。 */
  transitions(all: Transitions): Transitions;
  /** 見本の話者を足す（作品の cast.json の speakers に、見本の中だけ）。 */
  addSpeakers(speakers: string[]): void;
  /** 見本のシナリオ。 */
  script(): string;
  /** 作品のデータ（data/<名前>.json）の作り物。無ければ undefined（作品のものを読む）。 */
  data(file: string): unknown;
  /** 作り物の絵と音、見本のテーマの素材の URL。無ければ null（作品の素材）。 */
  asset(kind: AssetKind, path: string): string | null;
  /** 作り物のフローチャート。フローチャートの画面でなければ null（作品のものを読む）。 */
  flow(): Flow | null;
  /** 画面を開く。 */
  run(env: ScreenPreviewEnv): Promise<void>;
  /** liminalia.json が変わった（見た目を当てたあと）。同じ画面を開き直す。 */
  changed(): void;
}

/** 作り物の中身の言語（sample-lang。省くと遊ぶ言語。lang か作品の原文の言語、どちらも無ければ標準の画面と同じ日本語）。 */
function sampleLanguage(params: URLSearchParams, languages: readonly string[] | undefined): SampleContext["lang"] {
  const lang = params.get("sample-lang") ?? params.get("lang") ?? languages?.[0] ?? "ja";
  return lang.startsWith("ja") ? "ja" : "en";
}

/** 制作画面の口（@liminalia/studio の protocol.ts の STUDIO_API と同じ。ゲーム本体は studio を値として読まない）。 */
const STUDIO_API = "/__liminalia/studio/api";

/** テーマの一覧（制作画面の口から、作品の中のテーマも。読めなければ用意したものだけ）。 */
async function listThemes(): Promise<readonly UiThemePreset[]> {
  try {
    const r = await fetch(`${STUDIO_API}/ui/themes`);
    if (r.ok) return (await r.json()) as UiThemePreset[];
  } catch (e) {
    // 制作画面の口の無い開発サーバー（lim dev）では、用意したテーマだけを選べる
    console.info("テーマの一覧を読めません。用意したテーマから選びます", e);
  }
  return UI_THEMES;
}

/** 無音の短い WAV（作り物の音。字幕の効果音とバックログのボイスに使う）。 */
function silentWav(): string {
  const samples = 800;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const text = (at: number, s: string) => [...s].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, "data");
  view.setUint32(40, samples, true);
  bytes.fill(128, 44);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `data:audio/wav;base64,${btoa(bin)}`;
}

/**
 * プラグインが差し替えた画面（画面の id → プラグインの名前）。screen-catalog の差し替えの口（screens.ending、title、
 * extensions.renderers.codex など）をプラグインが持てば差し替えたものとし、後のプラグインが勝つ。標準の命令（std）の描画は標準のもの。
 * システム画面を丸ごと差し替えたプラグイン（system）は、システム画面が作る画面をすべて作る。
 */
export function replacedScreens(plugins: readonly WebPlugin[]): Record<string, string> {
  const out: Record<string, string> = {};
  /** システム画面が作る画面（DomHost が作るメッセージウィンドウ、名前欄、選択肢などと、標準の命令の画面のほか）。 */
  const bySystem = (id: string) => !["message", "name", "glyph", "choice", "dialog", "notice", "captions", "gate", "rotate", "feedback"].includes(id);
  const has = (p: WebPlugin, hook: string): boolean => {
    let o: unknown = p;
    for (const k of hook.split(".")) o = o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined;
    return o !== undefined && o !== null;
  };
  for (const p of plugins) {
    // 標準の命令（std）の描画と本文の見た目は標準のもの（後のプラグインが同じ口を持てば、そのプラグインの差し替え）
    if (p.name === "std") continue;
    for (const e of SCREEN_CATALOG) if (e.replace.some((hook) => has(p, hook)) || (!!p.system && e.owner === "web" && bySystem(e.id))) out[e.id] = p.name;
  }
  return out;
}

/**
 * 制作画面の中で開いた見本は、制作画面の欄（CSS の欄など）からフォーカスを奪わない。保存のたびに開き直した画面が最初のボタンへ
 * フォーカスを置くと、書いている途中の欄から見本へフォーカスが移るため、見本にフォーカスが無いときの focus() は効かせない
 * （見本の中を押せば見本にフォーカスが移り、そのあとはふだんどおり）。撮影の道具のように単独で開いたときは何もしない。
 */
function keepParentFocus(): void {
  if (window.parent === window) return;
  for (const proto of [HTMLElement.prototype, SVGElement.prototype]) {
    const focus = proto.focus;
    proto.focus = function (this: HTMLElement | SVGElement, options?: FocusOptions) {
      if (document.hasFocus()) focus.call(this, options);
    };
  }
}

/**
 * 見本を用意する（プレイヤーが記憶の場所を開き、作品の情報を読む前に呼ぶ）。記憶の場所を作り物に替え、作品の情報に見本の上書きを重ねる。
 * 知らない画面と開けない画面は、開くときに開けない理由を知らせる。
 */
export async function prepareScreenPreview(params: URLSearchParams, project: PlayerProject): Promise<ScreenPreview> {
  keepParentFocus();
  const id = params.get("screen") ?? "";
  const sample = SCREEN_SAMPLES[id] ?? { why: { ja: `${id} という画面はありません`, en: `There is no screen named ${id}` } };
  const asked = params.get("state");
  const state: SampleState = asked === "empty" || asked === "long" ? asked : "filled";
  const lang = params.get("lang");
  const c: SampleContext = { lang: sampleLanguage(params, project.languages), state: sample.states?.includes(state as never) ? state : "filled", bg: params.get("bg") || `${SAMPLE_ASSET}bg` };
  const content: SampleContent = sampleContent(id, c);

  // 作り物の記憶の場所（遊ぶ人のセーブ、既読、設定の置き場所は開かない）。見本のシナリオの頭から始めるセーブと、画面ごとの作り物を入れる
  const store = new MemoryStore();
  useMemorySaveStore(store);
  const storage = new Storage(project.id, store, { protect: project.saves?.protect ?? false });
  storage.saveSlot(BASE_SLOT, { version: 1, save: sampleSave(), date: new Date(0).toISOString(), title: "", log: content.log });
  for (const [slot, record] of content.slots) storage.saveSlot(slot, record);
  for (const [key, value] of Object.entries(content.store)) storage.write(key, value);

  // 作品の情報に重ねる（見本の中だけ）
  const p = project as { -readonly [K in keyof PlayerProject]: PlayerProject[K] };
  // ロードのたびに呼ぶ作品の場面、引き継ぎ、止まったときの記録は、見本では動かさない
  delete p.afterLoad;
  delete p.crashReport;
  if (p.saves?.carryFrom) p.saves = { ...p.saves, carryFrom: {} };
  if (content.project.extra) p.extra = content.project.extra;
  if (content.project.items) p.items = content.project.items;
  if (id === "title" && c.state === "long") p.title = c.lang === "en" ? "A sample title that runs long enough to wrap across the title screen" : "タイトル画面で折り返すほど長い、見本の作品の題名";
  // 画面の向き（縦長と横長を入れ替える）
  const orientation = params.get("orientation");
  const portrait = p.screen.height > p.screen.width;
  if ((orientation === "portrait" && !portrait) || (orientation === "landscape" && portrait)) p.screen = { width: p.screen.height, height: p.screen.width };
  // 遊ぶ言語（作品の languages に無ければ、見本の中だけ足す。一つだけならその言語の作品として遊ぶ）
  const withLanguage = (languages: string[] | undefined): string[] | undefined => (lang && !(languages ?? []).includes(lang) ? ((languages?.length ?? 0) >= 2 ? [...languages!, lang] : [lang]) : languages);
  const languages = withLanguage(p.languages);
  if (languages) p.languages = languages;
  // テーマ（作品の ui に、選んだテーマの値を重ねる。テーマの素材は見本の中だけ data URL で渡す）
  const themeId = params.get("theme");
  const themes = themeId ? await listThemes() : [];
  const theme = themeId ? (themes.find((t) => t.id === themeId) ?? null) : null;
  if (themeId && !theme) console.warn(`ゲームの画面の見本: テーマ ${themeId} がありません`);
  const themeAssets = new Map(Object.entries(theme?.assets ?? {}).map(([file, body]) => [`themes/${theme!.id}/${file}`, `data:image/svg+xml,${encodeURIComponent(body)}`]));

  const withOverrides = (ui: UiConfig | undefined): UiConfig | undefined => {
    let next: UiConfig = theme ? applyUiTheme(ui ?? {}, theme, themes) : (ui ?? {});
    if (id === "warning" && (!next.contentWarning?.text || c.state === "long")) next = { ...next, contentWarning: { ...next.contentWarning, ...sampleWarning(c) } };
    if (id === "warning") next = { ...next, contentWarning: { ...next.contentWarning!, always: true } };
    return next;
  };
  const ui = withOverrides(p.ui);
  if (ui) p.ui = ui;
  const sound = silentWav();

  let env: ScreenPreviewEnv | null = null;
  let reshowTimer: ReturnType<typeof setTimeout> | null = null;
  /** 作品の保存してあるテンプレート（ui.templates）と、制作画面のテンプレートの欄で保存する前のテンプレート（その画面の分だけ差し替える）。 */
  let savedTemplates = p.templates;
  let templateDraft: { screen: string; html: string } | null = null;
  const withTemplateDraft = (t: PlayerProject["templates"]): PlayerProject["templates"] => (templateDraft ? { ...t, [templateDraft.screen]: templateDraft.html } : t);
  /** 少し待って同じ画面を開き直す（続けて変わった分をまとめる）。 */
  const reshow = () => {
    if (reshowTimer) clearTimeout(reshowTimer);
    reshowTimer = setTimeout(() => {
      reshowTimer = null;
      if (env) void open(env, true);
    }, RESHOW_DELAY);
  };
  const view: ScreenPreviewState = { screen: id, state: c.state, status: "loading", replaced: {}, problems: [], checks: [] };
  window.__liminaliaScreenPreview = view;
  /** 開けなかった理由とページの例外（開き直しても残す）。 */
  const errors: string[] = [];
  const refresh = () => (view.problems = [...new Set([...errors, ...view.checks])]);
  const report = (status: ScreenPreviewReport["status"], problem?: string) => {
    view.status = status;
    if (problem) errors.push(problem);
    refresh();
    document.documentElement.dataset.lmScreenPreview = status;
    const message: ScreenPreviewReport = { type: "liminalia:screen-preview", screen: id, state: c.state, status, replaced: view.replaced, problems: [...view.problems] };
    if (window.parent !== window) window.parent.postMessage(message, location.origin);
  };
  // ページの例外は知らせる（見本の確かめと撮影が読む）
  window.addEventListener("error", (e) => {
    errors.push(String(e.message));
    refresh();
  });
  window.addEventListener("unhandledrejection", (e) => {
    errors.push(String((e.reason as Error | undefined)?.message ?? e.reason));
    refresh();
  });

  /** 条件が整うまで待つ（隠れた iframe では requestAnimationFrame が止まるので、時間で待つ）。 */
  const until = async (ok: () => boolean, what: string, timeout = OPEN_TIMEOUT): Promise<void> => {
    const deadline = performance.now() + timeout;
    while (!ok()) {
      if (performance.now() > deadline) throw new Error(`${what}を待ちきれませんでした`);
      await new Promise((r) => setTimeout(r, 30));
    }
  };
  /** 条件が整うまで、長くても ms だけ待つ（整わなくても続ける）。 */
  const atMost = async (ok: () => boolean, ms: number): Promise<void> => {
    const deadline = performance.now() + ms;
    while (!ok() && performance.now() < deadline) await new Promise((r) => setTimeout(r, 30));
  };
  /**
   * 画面の中身が描き終わるまで（書体と、開く演出。繰り返す動きは待たない。長くても 3 秒）。
   * quick なら開く演出を待たずに終わりの姿にする（?still=1 の撮影と、設定が変わって開き直すとき）。
   */
  const settle = async (quick: boolean) => {
    await document.fonts.ready;
    await new Promise((r) => setTimeout(r, 60));
    const finite = document.getAnimations().filter((a) => a.playState === "running" && a.effect?.getComputedTiming().iterations !== Infinity);
    if (quick) for (const a of finite) a.finish();
    else await Promise.race([Promise.allSettled(finite.map((a) => a.finished)), new Promise((r) => setTimeout(r, 3000))]);
  };
  const still = params.get("still") === "1";

  /** 起動の演出を繰り返し流す（押すと次の段へ。終わったら頭から）。作品の WebPlugin.splash があればそれ。 */
  let splashing = false;
  const loopSplash = (e: ScreenPreviewEnv) => {
    if (splashing) return;
    splashing = true;
    const plugin = [...e.plugins].reverse().find((x) => x.splash)?.splash;
    const own = p.ui?.splash;
    const config = own ? { ...own, ...(own.logos ? { logos: own.logos.map((l) => ({ ...l, time: 3_600_000 })) } : {}), ...(own.notice ? { notice: { ...own.notice, auto: false } } : {}), skip: true } : sampleSplash(c);
    const layer = e.host.stage.querySelector<HTMLElement>(".lm-sys") ?? e.host.stage;
    void (async () => {
      for (;;) {
        try {
          if (plugin) await plugin(e.host.context);
          else await playSplash(layer, config, { asset: (path) => e.host.context.asset("image", path) });
        } catch (err) {
          report("failed", String((err as Error).message ?? err));
          return;
        }
        // 終わったら少し置いて頭から
        await new Promise((r) => setTimeout(r, 400));
      }
    })();
  };

  /** 見本のページから画面を開く（開き直すときも同じ）。 */
  const show = async (e: ScreenPreviewEnv): Promise<void> => {
    const { host, system } = e;
    const how = sample.how!;
    // 開き直すときは、前の確認を閉じてから出し直す（重ねると前の確認の背景が新しい確認を覆う）
    if (how === "confirm" && system.screen === "confirm") {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      await until(() => system.screen !== "confirm", "前の確認が閉じるの");
    }
    if (how === "title") {
      // 標準のタイトル画面は型を読み終えてから出すので、先に読んでおく（読めなければタイトルの側が読み直す）
      await loadScreenTemplates().catch(() => undefined);
      await system.showTitle(true);
      await until(() => system.mode === "title", "タイトル画面");
      return;
    }
    if (how === "warning") {
      // 注意書きは起動の流れの中で出す（boot は止まったときの記録を読むので通さない）
      const warn = (system as unknown as { showContentWarning?: () => Promise<boolean> }).showContentWarning;
      if (!warn) throw new Error("このシステム画面は注意書きを出せません");
      void warn.call(system);
      await until(() => !!host.stage.querySelector(".lm-warning"), "注意書き");
      return;
    }
    if (how === "splash") {
      loopSplash(e);
      await until(() => !!host.stage.querySelector(".lm-splash, .lm-splash-screen") || !!e.plugins.some((x) => x.splash), "起動の演出");
      return;
    }
    if (!system.loadFrom) throw new Error("このシステム画面はセーブを読み込めないため、見本を出せません");
    await system.loadFrom(BASE_SLOT);
    if (how === "script") {
      // 画面ごとの行を流し、画面が出るまで待つ。プラグインが差し替えた画面は、クリック待ちか選択肢か画面が開くまで
      const shows = sample.shows ?? SCREEN_CATALOG.find((x) => x.id === id)?.classes[0] ?? "";
      const blocked = () => host.waiting || host.choosing || system.screen !== null;
      await until(() => (view.replaced[id] ? blocked() : shows !== "" && !!document.querySelector(shows)), "画面");
      // 画面と一緒に出すページ（通知、カットイン、常駐の表示）を出し終えるまで（出さない画面もあるので、待ちきれなくても続ける）
      await atMost(blocked, 1500);
      return;
    }
    await until(() => host.waiting, "見本のページ");
    if (how === "open" || how === "backlog") {
      const name = how === "backlog" ? "backlog" : sample.screen!;
      void system.request?.({ name: "open-screen", args: { screen: name } });
      await until(() => system.screen !== null, `画面（${name}）`);
    } else if (how === "confirm") {
      void system.perform?.("title");
      await until(() => system.screen === "confirm", "確認");
    } else if (how === "toast") {
      toast(host.stage.querySelector<HTMLElement>(".lm-sys") ?? host.stage, TEXT.toast.saved, 3_600_000);
    } else if (how === "term") {
      const term = await (async () => {
        await until(() => !!host.stage.querySelector(".lm-term"), "用語");
        return host.stage.querySelector<HTMLElement>(".lm-term")!;
      })();
      term.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await until(() => !!host.stage.querySelector(".lm-term-pop"), "用語の説明");
    }
  };

  /**
   * 開いた画面の確かめ（inspect.ts）。画面の要素は、標準の画面なら見本の shows か一覧の CSS の部品の一つ目、
   * プラグインが差し替えた画面なら開いた画面の印（data-lm-screen）。どちらも無ければ確かめない。
   */
  const check = (e: ScreenPreviewEnv): string[] => {
    const name = e.system.screen;
    const selector = view.replaced[id] ? (name !== null ? `[data-lm-screen="${CSS.escape(name)}"]` : null) : (sample.shows ?? SCREEN_CATALOG.find((x) => x.id === id)?.classes[0] ?? null);
    return inspectScreen(e.host.stage, { selector, filled: c.state !== "empty" });
  };

  const open = async (e: ScreenPreviewEnv, quick: boolean) => {
    report("loading");
    view.checks = [];
    try {
      await show(e);
      await settle(quick);
      e.host.stage.style.visibility = "";
      // 覆うもの（プラグインが自分で出した幕など）が消えるまで少し待ち、残っていれば problems に出す
      await atMost(() => check(e).length === 0, CLEAR_TIMEOUT);
      view.checks = check(e);
      report("ready");
    } catch (err) {
      e.host.stage.style.visibility = "";
      report("failed", String((err as Error).message ?? err));
    }
  };

  return {
    id,
    context: c,
    live: (next) => {
      savedTemplates = next.templates;
      const out = { ...next, ui: withOverrides(next.ui), languages: withLanguage(next.languages), templates: withTemplateDraft(next.templates) };
      if (content.project.extra) out.extra = content.project.extra;
      if (content.project.items) out.items = content.project.items;
      return out;
    },
    addSpeakers: (speakers) => {
      const { guide, traveler } = sampleSpeakers(c);
      for (const s of [guide, traveler]) if (!speakers.includes(s)) speakers.push(s);
    },
    transitions: (all) => {
      const rest = { ...all };
      delete rest.load;
      return rest;
    },
    script: () => sampleScript(id, c),
    data: (file) => content.data[file.endsWith(".json") ? file : `${file}.json`],
    asset: (kind, path) => {
      if (path.startsWith(SAMPLE_ASSET)) return kind === "bgm" || kind === "sound" || kind === "voice" ? sound : sampleImage(path.slice(SAMPLE_ASSET.length));
      return (kind === "image" && themeAssets.get(path)) || null;
    },
    flow: () => (id === "flowchart" ? sampleFlow(c) : null),
    async run(next) {
      env = next;
      view.replaced = replacedScreens(next.plugins);
      window.__liminaliaScreenCheck = () => (env ? check(env) : []);
      // 制作画面の欄を引いている間の見た目（保存はしない。保存したら live-config で当て直す）
      window.addEventListener("message", (e: MessageEvent<ScreenPreviewMessage>) => {
        if (e.source !== window.parent || e.origin !== location.origin || e.data?.type !== "liminalia:screen-draft") return;
        const ui = withOverrides(e.data.ui) ?? {};
        p.ui = ui;
        next.host.setUi(ui);
        next.system.uiChanged?.();
        // 部品の欄で保存する前の作品の CSS の行（作品の CSS のさらにあと）
        if (typeof e.data.css === "string") setWorkCssDraft(e.data.css);
        // CSS の欄で保存する前のファイルの中身（そのファイルの代わりに当てる）
        if (e.data.cssFile !== undefined) setWorkCssFileDraft(e.data.cssFile);
        // テンプレートの欄で保存する前のテンプレート（その画面のテンプレートの代わりに使い、開き直す）
        if (e.data.template !== undefined) {
          const before = JSON.stringify(p.templates ?? null);
          templateDraft = e.data.template;
          const next = withTemplateDraft(savedTemplates);
          if (next) p.templates = next;
          else delete p.templates;
          if (JSON.stringify(p.templates ?? null) !== before) reshow();
        }
      });
      if (!sample.how) {
        report("failed", c.lang === "en" ? sample.why!.en : sample.why!.ja);
        return;
      }
      // 開き終えるまで舞台を隠す（見本のページを出してから画面を開くので、途中を見せない）
      next.host.stage.style.visibility = "hidden";
      await open(next, still);
    },
    changed() {
      if (!env) return;
      // 注意書きと起動の演出は起動の流れの中にあるので、読み込み直す
      if (sample.how === "warning" || sample.how === "splash") return location.reload();
      reshow();
    },
  };
}
