import type { Diagnostic } from "./ast.ts";
import { typoDistance } from "./check.ts";

/**
 * 作品が登録した画面のテンプレート（liminalia.json の ui.templates）の検査（docs/design/screen-templates.md）。
 * lim check、制作画面のチェック、VS Code、MCP が @liminalia/sdk の projectDiagnostics から呼ぶ。
 *
 * 画面ごとの決まり（知っている部品、data-role と data-field の値、要る data-role、差し替えるプラグインの口）は、ここに書かない。
 * 標準のテンプレートの持ち主（@liminalia/web の system/screens/）が StandardScreen で持ち、呼ぶ側が渡す（lang は描画側を読まない）。
 * 画面をテンプレートに書き直したら、その定義を足すだけで検査も効く。部品の名前と版は、標準のテンプレートの字面から読む。
 *
 * ブラウザの DOM を使わずに読む（Node でも、スマホ版の Service Worker でも動く）。読み方は遊ぶ側（@liminalia/web の system/template.ts）と
 * 同じ決まりに合わせる: 一番外の <template data-part> が部品、<template> の外は <style> だけを使う、遊ぶ側が外すものも同じ一覧。
 */

/** 標準の画面の一つの決まり（@liminalia/web の system/screens/<画面>.ts が持つ）。 */
export interface StandardScreen {
  /** 標準のテンプレートの字面（部品の名前と版はここから読む）。 */
  template: string;
  /** 押すと起きること（data-role）として働く値。 */
  roles: readonly string[];
  /** 画面の値（data-field）の名前。一覧の一行の値も入れる。 */
  fields: readonly string[];
  /** 要る data-role（組ごとに、どれか一つがあればよい）。閉じる手段（close、cancel、ok）もここに書く。 */
  required: readonly (readonly string[])[];
  /** この画面を差し替えるプラグインの口（"screens.confirm"、"system"、"title" など。WebPlugin の項目の名前）。 */
  replacedBy: readonly string[];
  /** 欄と結ぶ設定の名前（data-setting。コンフィグだけ）。custom. で始まる名前（作品独自の設定）はいつも書ける。 */
  settings?: readonly string[];
}

/** テンプレートの検査に使う、エンジンの決まり（@liminalia/web の screenTemplateRules が作る）。 */
export interface ScreenTemplateRules {
  /** 画面の名前（ui.templates の鍵）→ 決まり。テンプレートで作れる画面だけ。 */
  screens: Readonly<Record<string, StandardScreen>>;
  /** data-text に書ける鍵（標準の文言の文字の鍵。"confirm.yes" など）。 */
  textKeys: readonly string[];
}

/** プラグインの "./web" の宣言から読んだ、差し替える画面（@liminalia/project の pluginScreens）。 */
export interface PluginScreens {
  /** 知らせに出す名前（liminalia.json の plugins に書いた形）。 */
  plugin: string;
  /** プラグインの項目のうち、画面を差し替えるもの（"screens.confirm"、"system"、"title"）。 */
  replaces: readonly string[];
  /** テーマの名前 → そのテーマの項目（ui.system.preset で選んだときだけ効く）。 */
  themes?: Readonly<Record<string, readonly string[]>>;
}

export interface ScreenTemplateCheckInput {
  /** liminalia.json の ui.templates（形の誤りは checkUi の bad-ui が知らせる。ここでは使えるものだけを見る）。 */
  templates: unknown;
  rules: ScreenTemplateRules;
  /** 作品のフォルダからのパスでファイルを読む（無い、読めないなら null）。 */
  read: (file: string) => string | null;
  plugins?: readonly PluginScreens[];
  /** liminalia.json の ui.system.preset（選んだテーマ）。 */
  preset?: string;
}

// ---- 読む（DOM なし） ----

/** 中身を持たない要素。 */
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
/** 中身をタグとして読まない要素。 */
const RAW = new Set(["script", "style", "textarea", "title", "xmp", "noscript", "noembed", "noframes"]);

interface Attr {
  name: string;
  value: string;
}

interface Tag {
  name: string;
  attrs: Attr[];
  line: number;
  /** <style> と <script> の中身。 */
  text?: string;
  /** 中身の始まりの行。 */
  textLine?: number;
}

/** テンプレートの一つの部品（一番外の <template>）。 */
interface Part {
  /** data-part（無ければ null）。 */
  name: string | null;
  version: number | undefined;
  line: number;
  /** 部品の中の要素（入れ子の <template> の中も）。 */
  tags: Tag[];
}

interface ParsedTemplate {
  parts: Part[];
  /** <template> の外の <style>。 */
  styles: Tag[];
}

function lineAt(text: string, offset: number, from: { offset: number; line: number }): number {
  let line = from.line;
  for (let i = from.offset; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
  from.offset = offset;
  from.line = line;
  return line;
}

const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function parseAttrs(source: string): Attr[] {
  const out: Attr[] = [];
  for (const m of source.matchAll(ATTR)) out.push({ name: m[1]!.toLowerCase(), value: m[2] ?? m[3] ?? m[4] ?? "" });
  return out;
}

/** テンプレートの字面を読む（ブラウザの読み方の細かいところまでは合わせない。検査に要る、要素と属性と行だけ）。 */
export function readScreenTemplate(html: string): ParsedTemplate {
  const parts: Part[] = [];
  const styles: Tag[] = [];
  const at = { offset: 0, line: 1 };
  let depth = 0;
  let current: Part | null = null;
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const close = /^<\/([a-zA-Z][\w-]*)[^>]*>/.exec(html.slice(lt));
    if (close) {
      if (close[1]!.toLowerCase() === "template" && depth > 0) {
        depth--;
        if (depth === 0) current = null;
      }
      i = lt + close[0].length;
      continue;
    }
    const open = /^<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(html.slice(lt));
    if (!open) {
      i = lt + 1;
      continue;
    }
    const name = open[1]!.toLowerCase();
    const tag: Tag = { name, attrs: parseAttrs(open[2]!), line: lineAt(html, lt, at) };
    i = lt + open[0].length;
    if (RAW.has(name)) {
      const end = html.toLowerCase().indexOf(`</${name}`, i);
      const stop = end < 0 ? html.length : end;
      tag.text = html.slice(i, stop);
      tag.textLine = lineAt(html, i, at);
      const gt = end < 0 ? -1 : html.indexOf(">", end);
      i = gt < 0 ? html.length : gt + 1;
    }
    if (name === "template") {
      if (depth === 0) {
        const part = tag.attrs.find((a) => a.name === "data-part")?.value.trim();
        const v = tag.attrs.find((a) => a.name === "data-version")?.value;
        const version = v !== undefined && /^\s*\d+\s*$/.test(v) ? Number(v) : undefined;
        current = { name: part ? part : null, version, line: tag.line, tags: [] };
        parts.push(current);
      } else current?.tags.push(tag);
      depth++;
      continue;
    }
    if (current) current.tags.push(tag);
    else if (name === "style") styles.push(tag);
    if (VOID.has(name) || open[0].endsWith("/>")) continue;
  }
  return { parts, styles };
}

// ---- 遊ぶ側が外すもの（@liminalia/web の system/template.ts の sanitize と同じ一覧） ----

const BLOCKED = new Set(["script", "iframe", "frame", "frameset", "object", "embed", "applet", "link", "meta", "base", "portal", "noscript"]);
const URL_ATTRS = new Set(["href", "xlink:href", "src", "srcset", "action", "formaction", "poster", "background", "ping", "data", "lowsrc", "dynsrc"]);
const LINK_ATTRS = new Set(["href", "xlink:href"]);
const DROPPED_ATTRS = new Set(["srcdoc", "target", "formtarget", "action", "formaction"]);

/** URL を、ブラウザが解くときと同じ形にする（先頭と末尾の制御文字と空白、途中のタブと改行を捨てる。web の urlForm と同じ）。 */
function urlForm(value: string): string {
  return value.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "").replace(/[\t\n\r]/g, "");
}

/** 許す URL（web の safeUrl と同じ）: 相対のパスと #、data: の絵（SVG を除く）と blob:。スキームつき、// や \\ で始まるものは外れる。 */
function safeUrl(value: string): boolean {
  const url = urlForm(value);
  if (/^[^/?#]*:/.test(url)) return /^data:image\/(?!svg)/i.test(url) || /^blob:/i.test(url);
  return !/^[/\\]{2}/.test(url);
}

/** 属性の値の文字参照を解く（数値と、URL を組むのに使える名前つき。名前の大文字と小文字はブラウザと同じに区別する）。遊ぶ側はブラウザが解いた値で判定するので、そろえる。 */
const NAMED: Readonly<Record<string, string>> = { Tab: "\t", NewLine: "\n", colon: ":", sol: "/", bsol: "\\", num: "#", quest: "?", period: ".", amp: "&", AMP: "&", quot: '"', QUOT: '"', apos: "'", lt: "<", LT: "<", gt: ">", GT: ">", nbsp: "\u00a0" };
function decodeRefs(value: string): string {
  return value.replace(/&(?:#[xX]([0-9a-fA-F]+)|#(\d+)|([a-zA-Z]+));?/g, (whole, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
    if (name !== undefined) return whole.endsWith(";") ? (NAMED[name] ?? whole) : whole;
    const code = hex !== undefined ? Number.parseInt(hex, 16) : Number(dec);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "\ufffd";
  });
}

/** CSS の中で外すもの（@import、外の URL の url()、expression と -moz-binding）と、CSS の中の行（0 始まり）。 */
function unsafeCss(css: string): { what: string; line: number }[] {
  const out: { what: string; index: number }[] = [];
  const imports: [number, number][] = [];
  for (const m of css.matchAll(/@import[^;]*;?/gi)) {
    out.push({ what: "@import", index: m.index });
    imports.push([m.index, m.index + m[0].length]);
  }
  for (const m of css.matchAll(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi)) {
    // @import の中の url() は @import と一緒に外れる
    if (!safeUrl(m[2]!) && !imports.some(([a, b]) => m.index >= a && m.index < b)) out.push({ what: `url(${m[2]!.trim()})`, index: m.index });
  }
  for (const m of css.matchAll(/expression\s*\(|-moz-binding/gi)) out.push({ what: /binding/i.test(m[0]) ? "-moz-binding" : "expression()", index: m.index });
  return out.sort((a, b) => a.index - b.index).map(({ what, index }) => ({ what, line: (css.slice(0, index).match(/\n/g) ?? []).length }));
}

/** 要素から遊ぶ側が外すもの（知らせる文の頭）。 */
function unsafeOf(tag: Tag): string[] {
  if (BLOCKED.has(tag.name)) return [`<${tag.name}>`];
  const out: string[] = [];
  for (const { name, value } of tag.attrs) {
    if (name.startsWith("on") || DROPPED_ATTRS.has(name)) out.push(`${tag.name} の ${name} 属性`);
    else if (LINK_ATTRS.has(name)) {
      // リンクはどの要素でもページの中の # だけ
      if (!urlForm(decodeRefs(value)).startsWith("#")) out.push(`${tag.name} の ${name} 属性（${value.trim()}）`);
    } else if (URL_ATTRS.has(name) && !(name === "srcset" ? decodeRefs(value).split(",").every((s) => safeUrl(s.trim())) : safeUrl(decodeRefs(value)))) out.push(`${tag.name} の ${name} 属性（${value.trim()}）`);
    else if (name === "style") for (const u of unsafeCss(value)) out.push(`${tag.name} の style 属性の ${u.what}`);
  }
  if (/^(animate|set)$/i.test(tag.name) && /href/i.test(tag.attrs.find((a) => a.name === "attributename")?.value ?? "")) out.push(`<${tag.name}>`);
  return out;
}

// ---- 検査 ----

/** 近い名前（打ち間違い）。 */
function nearest(word: string, names: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const n of names) {
    const d = typoDistance(word.toLowerCase(), n.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best !== undefined && bestD <= Math.max(1, Math.floor(word.length / 3)) ? best : undefined;
}

const quoteList = (names: readonly string[]) => names.map((n) => `"${n}"`).join("、");

// ---- 画面の JS（docs/design/screen-templates.md の「画面の JS」） ----

/**
 * 画面の JS が受け取る api の口の名前（@liminalia/web の system/screen-script.ts の ScreenScriptApi と同じ。web のテストがそろうことを確かめる）。
 * 口を足したら、ここと ScreenScriptApi と資料を一緒に直す。
 */
export const SCREEN_SCRIPT_API = ["version", "screen", "values", "press", "close", "result", "render", "text"] as const;

/** 登録したテンプレートのファイル（作品のフォルダからのパス。.html で、フォルダの中を指すものだけ）。 */
function registeredTemplate(templates: unknown, screen: string): string | null {
  const file = templates && typeof templates === "object" && !Array.isArray(templates) ? (templates as Record<string, unknown>)[screen] : undefined;
  return typeof file === "string" && /\.html$/i.test(file) && !/^([\\/]|[a-z]:)/i.test(file) && !file.split(/[\\/]/).includes("..") ? file.replace(/\\/g, "/") : null;
}

/** その画面のテンプレートの場所（ui.templates に登録した場所。無ければ決まりの ui/screens/<画面>/<画面>.html）。 */
export function screenTemplateFile(templates: unknown, screen: string): string {
  return registeredTemplate(templates, screen) ?? `ui/screens/${screen}/${screen}.html`;
}

/** その画面の JS の場所（テンプレートと同じ場所の同じ名前の .js）。 */
export function screenScriptFile(templates: unknown, screen: string): string {
  return screenTemplateFile(templates, screen).replace(/\.html$/i, ".js");
}

/** JS のコメントを、行を保ったまま空白にする（文字列の中の // は見分けない。検査の手がかりに使うだけ）。 */
function blankComments(js: string): string {
  return js.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

function checkScriptFile(screen: string, file: string, js: string, std: StandardScreen): Diagnostic[] {
  const out: Diagnostic[] = [];
  const code = blankComments(js);
  const lineOf = (index: number) => (code.slice(0, index).match(/\n/g) ?? []).length + 1;
  if (!/\bexport\s+default\b|\bas\s+default\b/.test(code)) {
    out.push({ severity: "warning", code: "template-script-export", message: `画面 ${screen} の JS に export default がありません（読んでも動きません）`, file, line: 1, hint: "export default function (screen, api) { … } と書きます" });
  }
  const known: readonly string[] = SCREEN_SCRIPT_API;
  for (const m of code.matchAll(/\bapi\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
    const name = m[1]!;
    if (known.includes(name)) continue;
    const near = nearest(name, known);
    out.push({ severity: "warning", code: "template-script-unknown", message: `api.${name} は画面の api にありません`, file, line: lineOf(m.index), hint: near ? `${near} のことですか？` : `利用可能な api: ${known.join("、")}` });
  }
  for (const m of code.matchAll(/\bapi\s*\.\s*press\s*\(\s*(["'`])([^"'`]*)\1/g)) {
    const role = m[2]!;
    if (std.roles.includes(role)) continue;
    const near = nearest(role, std.roles);
    out.push({ severity: "warning", code: "template-script-unknown", message: `api.press("${role}") は画面 ${screen} では働きません`, file, line: lineOf(m.index), hint: near ? `${near} のことですか？` : `使える値: ${std.roles.join("、")}` });
  }
  return out.sort((a, b) => a.line - b.line);
}

/** 作品の画面のテンプレートの診断（liminalia.json の ui.templates と、画面の JS）。 */
export function checkScreenTemplates(input: ScreenTemplateCheckInput): Diagnostic[] {
  const out: Diagnostic[] = [];
  // 画面の JS（登録が無くても、決まりの場所にあれば見る）
  for (const [screen, std] of Object.entries(input.rules.screens)) {
    const file = screenScriptFile(input.templates, screen);
    const js = input.read(file);
    if (js !== null) out.push(...checkScriptFile(screen, file, js, std));
  }
  const { templates, rules } = input;
  if (!templates || typeof templates !== "object" || Array.isArray(templates)) return out;
  const config = (code: string, severity: Diagnostic["severity"], message: string, hint?: string) => out.push({ severity, code, message, file: "liminalia.json", line: 1, ...(hint ? { hint } : {}) });
  const textKeys = new Set(rules.textKeys);
  for (const [screen, file] of Object.entries(templates as Record<string, unknown>)) {
    // 形の誤り（.html でない、作品のフォルダの外）は bad-ui が知らせる
    if (typeof file !== "string" || !/\.html$/i.test(file) || /^([\\/]|[a-z]:)/i.test(file) || file.split(/[\\/]/).includes("..")) continue;
    const std = rules.screens[screen];
    if (!std) {
      const near = nearest(screen, Object.keys(rules.screens));
      config("template-unknown-screen", "warning", `ui.templates.${screen} は、テンプレートで作れる画面ではありません（使われません）`, near ? `${near} のことですか？` : `テンプレートで作れる画面: ${Object.keys(rules.screens).join("、")}`);
      continue;
    }
    // プラグインの screens.* が先に立つ（docs/design/screen-templates.md の「どちらが勝つか」。後のプラグインが勝つ）
    let by: string | undefined;
    for (const p of input.plugins ?? []) {
      const theme = input.preset !== undefined ? p.themes?.[input.preset] : undefined;
      const hit = std.replacedBy.find((k) => p.replaces.includes(k));
      const themed = std.replacedBy.find((k) => theme?.includes(k));
      if (themed) by = `プラグイン ${p.plugin} のテーマ ${input.preset} の ${themed}`;
      else if (hit) by = `プラグイン ${p.plugin} の ${hit}`;
    }
    if (by) config("template-overridden", "warning", `ui.templates.${screen} は使われません。${by} が先です`, "テンプレートを使うなら、プラグインからその画面を外します");
    const path = file.replace(/\\/g, "/");
    const html = input.read(path);
    if (html === null) {
      config("template-missing", "error", `ui.templates.${screen} のファイル ${path} がありません`);
      continue;
    }
    out.push(...checkTemplateFile(screen, path, html, std, textKeys));
  }
  return out;
}

function checkTemplateFile(screen: string, file: string, html: string, std: StandardScreen, textKeys: ReadonlySet<string>): Diagnostic[] {
  const out: Diagnostic[] = [];
  const at = (line: number, code: string, severity: Diagnostic["severity"], message: string, hint?: string) => out.push({ severity, code, message, file, line, ...(hint ? { hint } : {}) });
  const standard = readScreenTemplate(std.template);
  const stdParts = new Map(standard.parts.filter((p) => p.name !== null).map((p) => [p.name!, p]));
  const mine = readScreenTemplate(html);
  const roles = new Set(std.roles);
  const fields = new Set(std.fields);
  // 部品ごとに重ねたもの（作品の部品が勝つ。遊ぶ側の mergeTemplates と同じ）
  const merged = new Map(stdParts);
  for (const p of mine.parts) if (p.name !== null && stdParts.has(p.name)) merged.set(p.name, p);
  // <style> の中は、その行に出す（部品の中の <style> も）
  const styleIssues = (tag: Tag) => {
    if (tag.name === "style" && tag.text !== undefined) for (const u of unsafeCss(tag.text)) at((tag.textLine ?? tag.line) + u.line, "template-unsafe", "warning", `<style> の ${u.what} は外されます（動きません）`, UNSAFE_HINT);
  };
  for (const style of mine.styles) styleIssues(style);
  // 部品も <style> も無いファイルは、遊ぶ側が何も使わない（標準の部品のまま動く）。書き誤りか、別の画面のファイルを指している
  if (mine.parts.length === 0 && mine.styles.length === 0) {
    at(1, "template-unknown-part", "warning", `部品（<template data-part>）も <style> も無いため、このファイルは使われません（画面 ${screen} は標準のまま動きます）`, `部品の名前: ${[...stdParts.keys()].join("、")}`);
  }
  for (const part of mine.parts) {
    if (part.name === null) {
      at(part.line, "template-unknown-part", "warning", "data-part の無い <template> は使われません", `部品の名前: ${[...stdParts.keys()].join("、")}`);
      continue;
    }
    const known = stdParts.get(part.name);
    if (!known) {
      const near = nearest(part.name, stdParts.keys());
      at(part.line, "template-unknown-part", "warning", `部品 ${part.name} は画面 ${screen} にありません（使われません）`, near ? `${near} のことですか？` : `部品の名前: ${[...stdParts.keys()].join("、")}`);
      continue;
    }
    // 写した元の版が標準より古い（標準のテンプレートが変わった）
    if (known.version !== undefined && (part.version === undefined || part.version < known.version)) {
      at(
        part.line,
        "template-outdated",
        "warning",
        part.version === undefined ? `部品 ${part.name} に data-version がありません（標準の現在のバージョンは ${known.version} です）` : `部品 ${part.name} は標準のバージョン ${part.version} からコピーしたもので、標準の現在のバージョンは ${known.version} です`,
        `lim screens diff ${screen} で標準テンプレートの変更点を確認して反映し、data-version を現在のバージョンにします`,
      );
    }
    for (const tag of part.tags) {
      for (const u of unsafeOf(tag)) at(tag.line, "template-unsafe", "warning", `${u} は外されます（動きません）`, UNSAFE_HINT);
      styleIssues(tag);
      const attr = (name: string) => tag.attrs.find((a) => a.name === name)?.value;
      const role = attr("data-role");
      if (role !== undefined && !roles.has(role)) unknown(tag.line, "data-role", role, std.roles);
      const field = attr("data-field");
      if (field !== undefined && !fields.has(field)) unknown(tag.line, "data-field", field, std.fields);
      const text = attr("data-text");
      if (text !== undefined && !textKeys.has(text)) unknown(tag.line, "data-text", text, [...textKeys]);
      const setting = attr("data-setting");
      if (setting !== undefined && !setting.startsWith("custom.") && !std.settings?.includes(setting)) unknown(tag.line, "data-setting", setting, [...(std.settings ?? []), "custom.*"]);
      const list = attr("data-list");
      if (list !== undefined) {
        const item = attr("data-item");
        if (item === undefined || item.trim() === "") at(tag.line, "template-list-item", "error", `data-list="${list}" に data-item がありません（一覧の一行を作れません）`, "一行にする部品の名前を data-item に書きます");
        else if (!merged.has(item)) at(tag.line, "template-list-item", "error", `data-item の部品 ${item} がありません（一覧の一行を作れません）`, `部品の名前: ${[...merged.keys()].join("、")}`);
      }
    }
  }
  // その画面に要る data-role（作品の部品を標準に重ねたもの全体で見る）
  const has = new Set([...merged.values()].flatMap((p) => p.tags.flatMap((t) => t.attrs.filter((a) => a.name === "data-role").map((a) => a.value))));
  const screenPart = mine.parts.find((p) => p.name !== null && stdParts.has(p.name));
  if (screenPart) {
    const line = (mine.parts.find((p) => p.name === "screen") ?? screenPart).line;
    for (const group of std.required) {
      if (group.some((r) => has.has(r))) continue;
      if (group.length === 1) at(line, "template-missing-role", "error", `画面 ${screen} のテンプレートに data-role="${group[0]}" の要素がありません`, `押す要素に data-role="${group[0]}" を付けます`);
      else at(line, "template-missing-role", "error", `画面 ${screen} のテンプレートに閉じる手段（data-role の ${quoteList(group)} のどれか）がありません`, "閉じるボタンに data-role=\"close\" を付けます");
    }
  }
  return out.sort((a, b) => a.line - b.line);

  function unknown(line: number, attr: string, value: string, names: readonly string[]): void {
    const near = nearest(value, names);
    at(line, "template-unknown-value", "warning", `${attr}="${value}" は画面 ${screen} では働きません`, near ? `${near} のことですか？` : attr === "data-text" ? "標準の文言キー（confirm.yes など）を書きます" : `使える値: ${names.join("、")}`);
  }
}

const UNSAFE_HINT = "テンプレートの中ではスクリプトと外の読み込みを使えません。動きは画面の JS（テンプレートと同じ名前の .js）かプラグインの screens.* で、絵は素材のパスで書きます";
