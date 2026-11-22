import { resolve } from "node:path";
import { themeFitsScreen } from "@liminalia/lang";
import { listUiThemes, loadProject, type Project } from "@liminalia/project";
import type { ScreenInfo, ScreenSampleState } from "@liminalia/studio/protocol";
import { screenPreviewTable, SYSTEM_SCREEN_VARS } from "@liminalia/web/screen-table";
import type { OutputLanguage } from "../output-language.ts";

/**
 * lim shot --screen と lim shot --screens: 標準の画面（セーブ、コンフィグ、結末など）を、作り物の中身の入った状態で撮る。
 * 制作画面の「ゲームの画面」と同じ見本（プレイヤーの ?ui-preview=screen。@liminalia/web の screen-preview/）を、
 * 中で立てた開発サーバーと画面なしの Chromium で開き、開き終えたら（html の data-lm-screen-preview が ready）撮る。
 *
 * 撮る直前に、画面が見えているか、覆うもの（ロードの幕、全画面の演出の層など）が残っていないかを確かめ直し（見本の inspect.ts）、
 * 見つけたことがあれば画像は残しつつ ok を false にして problems に出す（JSON を読んで「確かめた」とするアシスタントに黙って通さない）。
 *
 * 作品のファイルとセーブには書かない: 見本は記憶の場所を作り物（ページを閉じれば消える）に替え、テーマ、言語、向きは読み込んだ作品の情報にだけ重ねる。
 * lim mcp の screen_shot と list_screens（mcp-screens.ts）もここを使う。
 */

export type ScreenOrientation = "portrait" | "landscape";

export interface ScreenShotOptions {
  /** 画面の id（ScreenInfo の id。lim shot --screens で並ぶもの）。 */
  screen: string;
  /** 中身（filled は入った状態、empty は空、long は長い文と長い名前）。 */
  state: ScreenSampleState;
  /** 画面の向き（省くと作品のまま）。作品と違う向きなら幅と高さを入れ替えて撮る。 */
  orientation?: ScreenOrientation;
  /** 遊ぶ言語（en なら標準の画面の文言と作り物の中身を英語に。作品の languages に無くても見本の中だけ足す）。 */
  language?: string;
  /** 当てるテーマ（ui.system.preset の名前か、作品の themes/<id>）。作品の liminalia.json は書き換えない。 */
  theme?: string;
}

/** 撮る前に決めたこと。 */
export interface ScreenShotPlan {
  info: ScreenInfo;
  state: ScreenSampleState;
  orientation: ScreenOrientation;
  width: number;
  height: number;
  /** プレイヤーの URL の引数（? の後ろ）。 */
  query: string;
}

/** 撮った結果（--json で出すもの。lim mcp の screen_shot が読む）。 */
export interface ScreenShotResult {
  /** 開けて、撮る直前の確かめ（画面が見える、覆うものが無い、中身がある）も通った。 */
  ok: boolean;
  screen: string;
  name: { ja: string; en: string };
  state: ScreenSampleState;
  orientation: ScreenOrientation;
  width: number;
  height: number;
  lang?: string;
  theme?: string;
  /** 書いた画像（開けなければ無い。確かめで問題が見つかっても、開けたなら書く）。 */
  out?: string;
  /** プラグインが差し替えた画面なら、そのプラグインの名前（標準の部品の表とテーマの値が効かないことがある）。 */
  replacedBy?: string;
  /** 開けなかった理由、撮る直前の確かめで見つけたこと、ページで出た例外とエラー。 */
  problems: string[];
  /** --eval の値。 */
  eval?: unknown;
}

export const SCREEN_STATES: readonly ScreenSampleState[] = ["filled", "empty", "long"];

/** 標準の画面の一覧（作品によらない）。 */
export function screenTable(): ScreenInfo[] {
  return screenPreviewTable();
}

/** 撮る前の確かめ（画面の名前、開けるか、状態、テーマと向き）。合わなければ、選べるものを挙げて止める。 */
export function planScreenShot(project: Project, o: ScreenShotOptions, lang: OutputLanguage = "ja"): ScreenShotPlan {
  const table = screenTable();
  const info = table.find((s) => s.id === o.screen);
  if (!info) throw new Error(`${o.screen} という標準の画面はありません（あるもの: ${table.map((s) => s.id).join("、")}）`);
  if (!info.opens) throw new Error(`${info.id} は見本で開けません: ${(lang === "en" ? info.why?.en : info.why?.ja) ?? ""}`);
  if (!SCREEN_STATES.includes(o.state)) throw new Error(`--state は filled、empty、long のどれかです: ${o.state}`);
  if (o.state !== "filled" && !info.states.includes(o.state)) throw new Error(`${info.id} には ${o.state} の見本がありません（選べるもの: ${["filled", ...info.states].join("、")}）`);
  const { width, height } = project.screen;
  const own: ScreenOrientation = height > width ? "portrait" : "landscape";
  const orientation = o.orientation ?? own;
  // 縦長と横長を入れ替えるなら、撮る大きさも入れ替える（見本が作品の画面の大きさを入れ替える）
  const size = orientation === own ? { width, height } : { width: height, height: width };
  if (o.theme !== undefined) {
    const themes = listUiThemes(project.root);
    const theme = themes.find((t) => t.id === o.theme);
    if (!theme) throw new Error(`テーマ ${o.theme} がありません（あるもの: ${themes.map((t) => t.id).join("、")}）`);
    if (!themeFitsScreen(theme, size)) throw new Error(`テーマ ${theme.id} は縦長の画面だけで使えます（--portrait を付けてください）`);
  }
  const params = new URLSearchParams({ "ui-preview": "screen", screen: info.id });
  if (o.state !== "filled") params.set("state", o.state);
  if (o.orientation !== undefined && o.orientation !== own) params.set("orientation", o.orientation);
  if (o.language !== undefined) params.set("lang", o.language);
  if (o.theme !== undefined) params.set("theme", o.theme);
  params.set("still", "1");
  return { info, state: o.state, orientation, ...size, query: params.toString() };
}

/**
 * 一つの画面を撮る（開発サーバーと Chromium を中で立てて止める）。開けなければ out を書かず、ok を false にする。
 * evalJs は開き終えてから撮る前にそのページで評価し、値を eval に入れる（lim shot の --eval と同じ。確かめのテストが DOM を見る）。
 */
export async function shootScreen(project: Project, o: ScreenShotOptions & { evalJs?: string }, out: string, lang: OutputLanguage = "ja"): Promise<ScreenShotResult> {
  const plan = planScreenShot(project, o, lang);
  const { chromium } = await import("playwright-core");
  const { findChromium } = await import("../chromium.ts");
  const { startPlayerServer } = await import("../web.ts");
  const { server, url } = await startPlayerServer(project, 0, true);
  const browser = await chromium.launch({ executablePath: findChromium(), args: ["--mute-audio"] });
  try {
    const page = await browser.newPage({ viewport: { width: plan.width, height: plan.height } });
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${url}?${plan.query}`);
    await page.waitForFunction(() => ["ready", "failed"].includes(document.documentElement.dataset.lmScreenPreview ?? ""), null, { timeout: 90_000 });
    const view = await page.evaluate(() => window.__liminaliaScreenPreview ?? null);
    const opened = view?.status === "ready";
    // 撮る直前に確かめ直す（見本は ready の前に覆うものが消えるのを待つが、そのあとに出たものも拾う）
    const checks = opened ? await page.evaluate(() => window.__liminaliaScreenCheck?.() ?? []) : [];
    const ok = opened && checks.length === 0;
    const problems = [...new Set([...(view?.problems ?? []), ...checks, ...errors])];
    const replacedBy = view?.replaced[plan.info.id];
    const evaluated: unknown = opened && o.evalJs ? await page.evaluate(o.evalJs) : undefined;
    if (opened) await page.screenshot({ path: out });
    return {
      ok,
      screen: plan.info.id,
      name: plan.info.name,
      state: plan.state,
      orientation: plan.orientation,
      width: plan.width,
      height: plan.height,
      ...(o.language !== undefined ? { lang: o.language } : {}),
      ...(o.theme !== undefined ? { theme: o.theme } : {}),
      ...(opened ? { out } : {}),
      ...(replacedBy ? { replacedBy } : {}),
      problems,
      ...(evaluated !== undefined ? { eval: evaluated } : {}),
    };
  } finally {
    await browser.close();
    await server.close();
  }
}

/** lim shot --screen <id>。撮れたら true。 */
export async function runShotScreen(dir: string, o: ScreenShotOptions & { out: string; json: boolean; lang: OutputLanguage; evalJs?: string }): Promise<boolean> {
  const project = loadProject(dir);
  const r = await shootScreen(project, o, resolve(o.out), o.lang);
  if (o.json) {
    console.log(JSON.stringify(r, null, 2));
    return r.ok;
  }
  const name = o.lang === "en" ? r.name.en : r.name.ja;
  if (!r.out) {
    console.error(`${name}（${r.screen}）を開けませんでした: ${r.problems.join(" / ")}`);
    return false;
  }
  if (!r.ok) {
    console.error(`${name}（${r.screen}）を撮りましたが、画面がそのまま写っていません: ${r.problems.join(" / ")}`);
    console.error(`撮った画像: ${r.out}`);
    return false;
  }
  console.log(`撮影: ${r.out}（${[name, r.state, r.orientation, r.lang, r.theme, `${r.width}x${r.height}`].filter(Boolean).join(", ")}）`);
  if (r.eval !== undefined) console.log("eval:", JSON.stringify(r.eval));
  if (r.replacedBy) console.log(`この画面はプラグイン ${r.replacedBy} が差し替えたものです（標準の部品の表とテーマの値が効かないことがあります）`);
  for (const p of r.problems) console.log(`見本で出た問題: ${p}`);
  return true;
}

/** 一覧（--json と list_screens）。themes は作品で選べるテーマ、systemVars はシステム画面の共通の CSS の変数。 */
export function screenList(project: Project | null): { screens: ScreenInfo[]; systemVars: readonly string[]; themes?: { id: string; name: string; nameEn: string; portraitOnly?: true }[] } {
  return {
    screens: screenTable(),
    systemVars: SYSTEM_SCREEN_VARS,
    ...(project ? { themes: listUiThemes(project.root).map((t) => ({ id: t.id, name: t.name, nameEn: t.nameEn, ...(t.orientation === "portrait" ? { portraitOnly: true as const } : {}) })) } : {}),
  };
}

/** lim shot --screens。標準の画面と、見本で開けるか、選べる状態を並べる（--json なら部品の表なども）。 */
export function runListScreens(dir: string, o: { json: boolean; lang: OutputLanguage }): boolean {
  const list = screenList(loadProject(dir));
  if (o.json) {
    console.log(JSON.stringify(list, null, 2));
    return true;
  }
  const width = Math.max(...list.screens.map((s) => s.id.length));
  for (const s of list.screens) {
    const name = o.lang === "en" ? s.name.en : s.name.ja;
    const states = ["filled", ...s.states].join(", ");
    if (s.opens) console.log(`  ${s.id.padEnd(width)}  ${name}（${states}）`);
    else console.log(`  ${s.id.padEnd(width)}  ${name}（開けません: ${o.lang === "en" ? s.why?.en : s.why?.ja}）`);
  }
  console.log(`テーマ: ${list.themes!.map((t) => t.id).join(", ")}`);
  return true;
}
