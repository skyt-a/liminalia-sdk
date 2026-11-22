import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { projectExtra, readVoiceLock, type Project } from "@liminalia/project";

/**
 * プレイヤーに渡す作品の情報（virtual:liminalia/project の project）。開発サーバーと書き出し（vite.config.ts）と、
 * ブラウザの中で動くスマホ版の制作画面（@liminalia/studio-mobile）が使う。
 */
/** 連番のボイスの番号の固定（voice-lock.json。読めなければ入れない）。 */
function voiceLockOf(p: Project): { voiceLock?: unknown } {
  try {
    const lock = readVoiceLock(p);
    return lock ? { voiceLock: lock } : {};
  } catch {
    return {};
  }
}

/**
 * 作品の画面の型のファイル（liminalia.json の ui.templates。画面の名前 → 作品のフォルダの中の絶対パス）。
 * 作品のフォルダの外を指すもの、.html でないものは入れない（lim check が知らせる）。
 */
export function templateFiles(root: string, ui: unknown): Record<string, string> {
  const map = ui && typeof ui === "object" ? (ui as { templates?: unknown }).templates : undefined;
  const out: Record<string, string> = {};
  if (!map || typeof map !== "object" || Array.isArray(map)) return out;
  for (const [screen, file] of Object.entries(map as Record<string, unknown>)) {
    if (typeof file !== "string" || !/\.html$/i.test(file)) continue;
    const abs = resolve(root, file);
    const rel = relative(resolve(root), abs);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    out[screen] = abs;
  }
  return out;
}

/** 作品の画面の型の中身（画面の名前 → HTML の文字）。読めないファイルは入れない。毎回ファイルから読む。 */
function templatesOf(root: string, ui: unknown): { templates?: Record<string, string> } {
  const out: Record<string, string> = {};
  for (const [screen, file] of Object.entries(templateFiles(root, ui))) {
    try {
      out[screen] = readFileSync(file, "utf8");
    } catch (e) {
      console.warn(`画面の型 ${file} を読めません`, e);
    }
  }
  return Object.keys(out).length > 0 ? { templates: out } : {};
}

/**
 * liminalia.json のうち、開発中に書き換えても起動し直さずに効くもの（変数の初期値・見た目と操作の設定・おまけ・遊べる言語・コマンドの既定値）。
 * 毎回ファイルから読む。dev（開発サーバーと、スマホ版の制作画面のテストプレイ）なら作品の版（version）も入れる。
 */
export function liveConfig(p: Project, o: { dev?: boolean } = {}): { variables?: unknown; ui?: unknown; templates?: Record<string, string>; extra?: unknown; items?: unknown; languages?: string[]; commandDefaults?: unknown; chapters?: unknown; endingKinds?: unknown; autoLayout?: unknown; version?: string } {
  let raw: { variables?: unknown; ui?: unknown; extra?: unknown; items?: unknown; languages?: string[]; commandDefaults?: unknown; chapters?: unknown; endingKinds?: unknown; autoLayout?: unknown; version?: unknown } = p.config;
  try {
    raw = JSON.parse(readFileSync(join(p.root, "liminalia.json"), "utf8")) as typeof raw;
  } catch {
    // 書きかけで読めなければ、起動したときのもの
  }
  return {
    ...(raw.variables ? { variables: raw.variables } : {}),
    ...(raw.ui ? { ui: raw.ui } : {}),
    // 作品の画面の型（ui.templates に書いたファイルの中身。型を書き換えたときもすぐ効く）
    ...templatesOf(p.root, raw.ui),
    ...(raw.items ? { items: raw.items } : {}),
    // CG の自動の登録（extra.cgAuto）は、シナリオが出す画像から広げて渡す
    // 章の情報（chapters）で CG の見出しと章選択の題を補う
    ...(raw.extra ? { extra: projectExtra(p, raw.extra as Project["config"]["extra"], Array.isArray(raw.chapters) ? (raw.chapters as Project["config"]["chapters"]) : undefined) } : {}),
    ...(Array.isArray(raw.chapters) ? { chapters: raw.chapters } : {}),
    // 原文の言語だけ（英語だけの作品など）でも渡す（システム画面をその言語で出す）。書いていない作品は日本語
    ...(Array.isArray(raw.languages) && raw.languages.length > 0 ? { languages: raw.languages } : {}),
    ...(raw.commandDefaults && typeof raw.commandDefaults === "object" ? { commandDefaults: raw.commandDefaults } : {}),
    // 作品が足したエンディングの種類と文言（ending= を種類として読み、画面の文言を引く）
    ...(raw.endingKinds && typeof raw.endingKinds === "object" && !Array.isArray(raw.endingKinds) ? { endingKinds: raw.endingKinds } : {}),
    // 立ち絵の登場順の自動配置の並べ方（起動したときに読む）
    ...(raw.autoLayout && typeof raw.autoLayout === "object" && !Array.isArray(raw.autoLayout) ? { autoLayout: raw.autoLayout } : {}),
    // 作品の版（開発中だけ。書き出しはプログラムに埋めず project/build.json から読む。版を上げただけでプログラムが変わらないように。lim patch）。
    // 開発中は build.json が無いので、ここで渡す（セーブの版と式の save.version を、書き出したゲームと同じにする。書き換えたら次の「はじめから」とロードから効く）
    ...(o.dev && typeof raw.version === "string" && raw.version !== "" ? { version: raw.version } : {}),
  };
}

/**
 * 言語ごとの素材（assets/<種類>/@<言語>/ の下のファイル）。言語 → "種類/パス"（@<言語>/ を除いたもの）。
 * 起動したときに数える（開発中に足したものは、開き直すと効く）。
 */
function localizedAssetsOf(p: Project): { localizedAssets?: Record<string, string[]> } {
  const out: Record<string, string[]> = {};
  if (!existsSync(p.paths.assets)) return {};
  for (const kind of readdirSync(p.paths.assets, { withFileTypes: true })) {
    if (!kind.isDirectory()) continue;
    for (const lang of readdirSync(join(p.paths.assets, kind.name), { withFileTypes: true })) {
      if (!lang.isDirectory() || !lang.name.startsWith("@")) continue;
      const root = join(p.paths.assets, kind.name, lang.name);
      const walk = (dir: string, rel: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (e.name.startsWith(".")) continue;
          if (e.isDirectory()) walk(join(dir, e.name), `${rel}${e.name}/`);
          else (out[lang.name.slice(1)] ??= []).push(`${kind.name}/${rel}${e.name}`);
        }
      };
      walk(root, "");
    }
  }
  return Object.keys(out).length > 0 ? { localizedAssets: out } : {};
}

/**
 * 作品のデータ（paths.data の .json）の一覧。プレイヤーは、無いデータを取りに行かない（標準の図鑑などが、データの有無を見るのに使う。
 * 無いファイルを取りに行くと、書き出しの確かめが 404 で止まる）。起動したときに数える。
 */
function dataFilesOf(p: Project): { dataFiles: string[] } {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) walk(join(dir, e.name), `${rel}${e.name}/`);
      else if (e.name.endsWith(".json")) out.push(`${rel}${e.name}`);
    }
  };
  walk(p.paths.data, "");
  return { dataFiles: out.sort() };
}

/**
 * 訳のファイル（paths.lang の <言語>.json）がある言語。プレイヤーは書き出したゲームでは、ここに無い言語の訳を取りに行かない
 * （languages に書いたが訳がまだ無い言語を選ぶと、無いファイルを取りに行き、書き出しの確かめが 404 で止まっていた。lim check は警告で通す）。
 */
function translationsOf(p: Project): { translations: string[] } {
  if (!existsSync(p.paths.lang)) return { translations: [] };
  return { translations: readdirSync(p.paths.lang).filter((n) => n.endsWith(".json") && !n.startsWith(".")).map((n) => n.slice(0, -".json".length)).sort() };
}

/** 作品の情報。dev は開発サーバーと、スマホ版の制作画面のテストプレイ（どちらも project/build.json が無い）。 */
export function playerInfo(p: Project, o: { dev?: boolean } = {}): Record<string, unknown> {
  return {
    id: p.config.id,
    title: p.config.title,
    entry: p.config.entry,
    titleScreen: p.config.titleScreen ?? true,
    screen: p.screen,
    ...(p.config.saves?.protect || p.config.saves?.carryFrom ? { saves: { ...(p.config.saves.protect ? { protect: true } : {}), ...(p.config.saves.carryFrom ? { carryFrom: p.config.saves.carryFrom } : {}) } } : {}),
    ...(p.config.afterLoad ? { afterLoad: p.config.afterLoad } : {}),
    ...(p.config.build?.crashReport?.url ? { crashReport: { url: p.config.build.crashReport.url } } : {}),
    // 遊ばれ方の統計（任意。遊ぶ人に尋ねて、送ると答えたときだけ）
    ...(p.config.build?.analytics?.url ? { analytics: { url: p.config.build.analytics.url } } : {}),
    // テスト版の指摘（lim build --feedback のときだけ。送り先が無ければファイルに保存してもらう）
    ...(process.env.LIMINALIA_FEEDBACK === "1" ? { feedback: p.config.build?.feedback?.url ? { url: p.config.build.feedback.url } : {} } : {}),
    // 店で買える商品（build.store.products。system.purchases）
    ...(p.config.build?.store?.products ? { store: { products: p.config.build.store.products } } : {}),
    // 書き出しの版（lim build --variant）
    ...(process.env.LIMINALIA_VARIANT ? { variant: { name: process.env.LIMINALIA_VARIANT, ...(p.config.build?.variants?.[process.env.LIMINALIA_VARIANT]?.contentFilter ? { contentFilter: true } : {}) } } : {}),
    ...voiceLockOf(p),
    ...localizedAssetsOf(p),
    ...dataFilesOf(p),
    ...translationsOf(p),
    // 版（version）は開発中だけ入る（liveConfig）
    ...liveConfig(p, o),
  };
}
