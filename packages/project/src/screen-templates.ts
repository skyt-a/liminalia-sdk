import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { PluginScreens } from "@liminalia/lang";

/**
 * 作品の画面のテンプレート（liminalia.json の ui.templates）の検査に、作品の側から渡すもの（@liminalia/project/screen-templates）。
 * プラグインが差し替える画面（pluginScreens）。テンプレートのファイルは、作品の CSS と同じく projectFileReader で読む。
 *
 * プラグインの "./web"（@liminalia/web の WebPlugin）が差し替える画面は、ソースの字面から読む。
 * lim check、制作画面のチェック、VS Code の拡張が、作品の画面のテンプレート（ui.templates）がプラグインの screens.* に隠れていないかを
 * 知らせるのに使う（@liminalia/lang の checkScreenTemplates）。描画側のコードは Node では動かせないので、読み込まずに字面だけを見る。
 *
 * 見方は遊ぶ側の replacedScreens（@liminalia/web の ui-probe.ts）と同じ: system、title、screens の項目。テーマ（themes.<名前>）の
 * title と screens は、そのテーマを選んだときだけ効くので分けて返す。
 * 分かるのは、項目をそのまま書いたオブジェクト（{ name: "x", screens: { confirm(api) { … } } }）だけ。別の変数に置いた screens の中身や、
 * 作ってから足した項目は読めない（知らせないほうに倒す）。
 */

/** オブジェクトの書き方の一つ（{ … } の一つ）。 */
interface Frame {
  /** このオブジェクトを値に持つ項目の名前（関数の中身などは null）。 */
  name: string | null;
  keys: Set<string>;
  children: Frame[];
  parent: Frame | null;
}

/** 字面の中の、文字列、テンプレート文字列、コメントを空白にする（括弧を数えるため）。 */
function blank(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end < 0 ? source.length : end;
      out += " ".repeat(stop - i);
      i = stop;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end < 0 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      // 文字列は名前として読めるように中身を残す（"confirm": のような項目）。テンプレート文字列は中身ごと空白にする
      let j = i + 1;
      while (j < source.length && source[j] !== c) j += source[j] === "\\" ? 2 : 1;
      const body = source.slice(i + 1, j);
      out += c === "`" ? ` ${body.replace(/[^\n]/g, " ")} ` : `"${body.replace(/[{}()[\]"'`]/g, " ")}"`;
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const TOKEN = /"[^"\n]*"|[A-Za-z_$][\w$]*|\.\.\.|=>|[{}()[\],:;?=]/g;

/** オブジェクトの書き方を木にする。項目の名前は、{ か , の直後にあり、: ( , } が続くもの。 */
function frames(source: string): Frame {
  const root: Frame = { name: null, keys: new Set(), children: [], parent: null };
  const tokens = [...blank(source).matchAll(TOKEN)].map((m) => m[0]);
  // 括弧の積み重ね（{ は Frame、( と [ は名前を数えない）
  const stack: ({ kind: "{"; frame: Frame } | { kind: "(" | "[" })[] = [{ kind: "{", frame: root }];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const top = stack.at(-1)!;
    if (t === "{") {
      // 項目の値のオブジェクト（name: { … }）。関数の中身（) { や => {）は名前なし
      const prev = tokens[i - 1];
      const owner = prev === ":" ? tokens[i - 2] : undefined;
      const parent = [...stack].reverse().find((s): s is { kind: "{"; frame: Frame } => s.kind === "{")!.frame;
      const frame: Frame = { name: owner ? owner.replace(/^"|"$/g, "") : null, keys: new Set(), children: [], parent };
      parent.children.push(frame);
      stack.push({ kind: "{", frame });
      continue;
    }
    if (t === "(" || t === "[") {
      stack.push({ kind: t });
      continue;
    }
    if (t === "}" || t === ")" || t === "]") {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (top.kind !== "{") continue;
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    if ((prev === "{" || prev === ",") && /^("|[A-Za-z_$])/.test(t) && (next === ":" || next === "(" || next === "," || next === "}")) top.frame.keys.add(t.replace(/^"|"$/g, ""));
  }
  return root;
}

/** WebPlugin だけが持つ項目（name と title だけのオブジェクトは、プラグインと見なさない。データの { name, title } などと分ける）。 */
const WEB_PLUGIN_KEYS: ReadonlySet<string> = new Set(["screens", "system", "themes", "extensions", "splash", "endSplash", "setup", "ready", "transitions", "slotMeta", "slotChapter"]);

/** 差し替える項目（system、title、screens.<画面>）。 */
function replacesOf(frame: Frame): string[] {
  const out: string[] = [];
  for (const k of ["system", "title", "splash"]) if (frame.keys.has(k)) out.push(k);
  for (const child of frame.children) if (child.name === "screens" && frame.keys.has("screens")) for (const k of child.keys) out.push(`screens.${k}`);
  return out;
}

/** プラグインの "./web" のソースから、差し替える画面を読む。 */
export function webPluginScreens(source: string): { replaces: string[]; themes: Record<string, string[]> } {
  const replaces = new Set<string>();
  const themes: Record<string, string[]> = {};
  const walk = (frame: Frame, inTheme: boolean) => {
    // プラグインの項目を書いたオブジェクト（name と、WebPlugin だけの項目を直に持つもの。テーマの中は別に読む）
    if (!inTheme && frame.keys.has("name") && [...WEB_PLUGIN_KEYS].some((k) => frame.keys.has(k))) for (const r of replacesOf(frame)) replaces.add(r);
    for (const child of frame.children) {
      if (!inTheme && child.name === "themes" && frame.keys.has("themes")) {
        for (const theme of child.children) if (theme.name !== null && child.keys.has(theme.name)) (themes[theme.name] ??= []).push(...replacesOf(theme).filter((r) => r !== "system"));
        continue;
      }
      walk(child, inTheme);
    }
  };
  walk(frames(source), false);
  return { replaces: [...replaces], themes };
}

/** プラグインのパッケージの "./web" の入口のファイル（無ければ null）。 */
function webEntry(dir: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")) as { exports?: Record<string, string | { import?: string; default?: string }> };
    const target = pkg.exports?.["./web"];
    const path = typeof target === "string" ? target : (target?.import ?? target?.default);
    return path ? resolve(dir, path) : null;
  } catch {
    // package.json が無い、読めないプラグインは plugin-load が知らせる
    return null;
  }
}

/** "./plugins/x" なら作品からの相対、それ以外は作品から見たパッケージ名として探す（index.ts の resolvePackageDir と同じ。見つからなければ null）。 */
function pluginDir(root: string, spec: string): string | null {
  if (spec.startsWith(".") || isAbsolute(spec)) return resolve(root, spec);
  try {
    return dirname(createRequire(join(root, "package.json")).resolve(`${spec}/package.json`));
  } catch {
    // 見つからないプラグインは plugin-load が知らせる
    return null;
  }
}

/**
 * 作品のプラグイン（liminalia.json の plugins）が差し替える画面。読めないものは飛ばす。
 * lim check、制作画面、VS Code で同じに読むため、読み込んだプラグインの一覧でなく liminalia.json に書いたものから探す（字面を読むだけで動かさない）。
 */
export function pluginScreens(root: string, specs: readonly unknown[] | undefined): PluginScreens[] {
  const out: PluginScreens[] = [];
  for (const spec of specs ?? []) {
    if (typeof spec !== "string") continue;
    const dir = pluginDir(root, spec);
    if (dir === null) continue;
    const entry = webEntry(dir);
    if (entry === null || !existsSync(entry)) continue;
    let source: string;
    try {
      source = readFileSync(entry, "utf8");
    } catch {
      // 読めない入口は、差し替えが分からないものとして知らせない（読み込めないプラグインは plugin-load が知らせる）
      continue;
    }
    const { replaces, themes } = webPluginScreens(source);
    if (replaces.length > 0 || Object.keys(themes).length > 0) out.push({ plugin: spec, replaces, ...(Object.keys(themes).length > 0 ? { themes } : {}) });
  }
  return out;
}