import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { screenScriptFile, screenTemplateFile } from "@liminalia/lang";

/**
 * 標準の画面のテンプレートを作品に写す、標準との違いを出す、標準に戻す（@liminalia/project/screen-copy。docs/design/screen-templates.md の「写し出し」）。
 * lim screens、MCP の道具、制作画面のテンプレートの欄（@liminalia/studio の server/screen-files.ts）が使う。
 *
 * 標準の画面は、呼ぶ側が渡す（@liminalia/web/screen-rules の STANDARD_SCREENS。画面の名前 → { template: テンプレートの字面 }）。
 * 画面をテンプレートに書き直して一覧に並べれば、ここを直さずに写せる。
 *
 * - 写す先は ui.templates に登録した場所。登録が無ければ ui/screens/<画面>/<画面>.html にして登録する
 * - 写した部品の元の文字を .liminalia/screens/<画面>/<部品>.<版>.html に残す（標準の変わったところを、作品の直しと混ぜずに出すため）
 * - 画面の JS は、テンプレートと同じ場所の同じ名前の .js（登録が無ければ ui/screens/<画面>/<画面>.js）
 * - 作者が書いたものは黙って消さない: あるファイルは force が無ければ上書きせず、標準に戻すときは名前を変えて残す
 */

/** 標準の画面の一つ（StandardScreen のうち、写すのに使うもの）。 */
export interface CopyableScreen {
  template: string;
}

/** テンプレートの一つの部品（一番外の <template>）の字面。 */
export interface TemplatePartText {
  /** data-part（無ければ null）。 */
  name: string | null;
  version: number | undefined;
  /** <template> から </template> までの字面。 */
  text: string;
  start: number;
  end: number;
}

/** 元の文字を残す置き場（作品のフォルダから）。 */
export const SCREEN_ORIGINALS_DIR = ".liminalia/screens";

/** テンプレートの字面を、一番外の <template> ごとに分ける（入れ子の <template> は部品の中。コメントの中は見ない）。 */
export function splitTemplateParts(html: string): TemplatePartText[] {
  const out: TemplatePartText[] = [];
  const token = /<!--[\s\S]*?(?:-->|$)|<template\b((?:[^>"']|"[^"]*"|'[^']*')*)>|<\/template\s*>/gi;
  let depth = 0;
  let open: { start: number; attrs: string } | null = null;
  for (const m of html.matchAll(token)) {
    if (m[0].startsWith("<!--")) continue;
    if (m[0].startsWith("</")) {
      if (depth === 0) continue;
      depth--;
      if (depth === 0 && open) {
        const end = m.index + m[0].length;
        const name = /\bdata-part\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(open.attrs);
        const version = /\bdata-version\s*=\s*(?:"\s*(\d+)\s*"|'\s*(\d+)\s*'|(\d+))/i.exec(open.attrs);
        const part = (name?.[1] ?? name?.[2] ?? name?.[3] ?? "").trim();
        const v = version?.[1] ?? version?.[2] ?? version?.[3];
        out.push({ name: part === "" ? null : part, version: v === undefined ? undefined : Number(v), text: html.slice(open.start, end), start: open.start, end });
        open = null;
      }
      continue;
    }
    if (depth === 0) open = { start: m.index, attrs: m[1] ?? "" };
    depth++;
  }
  return out;
}

// ---- 置き場所 ----

const templatesOf = (ui: unknown): Record<string, unknown> => {
  const t = ui && typeof ui === "object" ? (ui as { templates?: unknown }).templates : undefined;
  return t && typeof t === "object" && !Array.isArray(t) ? (t as Record<string, unknown>) : {};
};

/** その画面のテンプレートの場所（登録した場所。無ければ決まりの ui/screens/<画面>/<画面>.html）。作品のフォルダからの / 区切りのパス。 */
export function screenTemplatePath(ui: unknown, screen: string): string {
  return screenTemplateFile(templatesOf(ui), screen);
}

/** その画面の JS の場所（テンプレートと同じ場所の同じ名前の .js。検査と遊ぶ側と同じ決まり）。 */
export function screenScriptPath(ui: unknown, screen: string): string {
  return screenScriptFile(templatesOf(ui), screen);
}

/** その画面のテンプレートを登録しているか。 */
export function screenRegistered(ui: unknown, screen: string): boolean {
  return typeof templatesOf(ui)[screen] === "string";
}

// ---- liminalia.json ----

function readConfig(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, "liminalia.json"), "utf8")) as Record<string, unknown>;
}

function writeConfig(root: string, raw: Record<string, unknown>): void {
  writeFileSync(join(root, "liminalia.json"), `${JSON.stringify(raw, null, 2)}\n`);
}

/** 作品のフォルダの中の絶対パス（外を指せば断る）。 */
function abs(root: string, file: string): string {
  const path = resolve(root, ...file.split("/"));
  const rel = relative(resolve(root), path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`作品のフォルダの外は書けません: ${file}`);
  return path;
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function standardOf(screens: Readonly<Record<string, CopyableScreen>>, screen: string): CopyableScreen {
  const std = screens[screen];
  if (!std) throw new Error(`${screen} はテンプレートで作れる画面ではありません（テンプレートで作れる画面: ${Object.keys(screens).join("、")}）`);
  return std;
}

// ---- 写す ----

export interface CopyScreenOptions {
  /** 写す部品（省くと画面の全体）。 */
  parts?: readonly string[];
  /** あるファイル（部品だけなら、ある部品）を書き直す。 */
  force?: boolean;
  /** 画面の JS の雛形も置く。 */
  js?: boolean;
  /** 頭のコメントに書くエンジンの版。 */
  engine?: string;
}

export interface CopyScreenResult {
  /** テンプレートのファイル（作品のフォルダから）。 */
  file: string;
  /** 写した部品。 */
  parts: string[];
  /** ui.templates に新しく登録したか。 */
  registered: boolean;
  /** 元の文字を残したファイル。 */
  originals: string[];
  /** 置いた画面の JS（js のとき）。 */
  script?: string;
}

/** 写したファイルの頭のコメント（人が読むためのもの。エンジンは読まない）。 */
function header(screen: string, engine: string | undefined): string {
  return `<!-- 標準の画面 ${screen} のテンプレート${engine ? `（Liminalia ${engine}）` : ""}からコピーしました。部品の data-version はコピー元のバージョンなので、編集しても書き換えないでください。標準との違いは lim screens diff ${screen} で確認できます -->\n`;
}

/**
 * 標準の画面のテンプレート（全体か部品だけ）を作品に写し、ui.templates に登録し、元の文字を .liminalia/screens/ に残す。
 * 全体を写すとき、ファイルがあれば force が無ければ断る。部品だけなら、あるファイルに部品を足す（同じ部品があれば force が無ければ断る）。
 */
export function copyScreen(root: string, screens: Readonly<Record<string, CopyableScreen>>, screen: string, o: CopyScreenOptions = {}): CopyScreenResult {
  const std = standardOf(screens, screen);
  const stdParts = splitTemplateParts(std.template).filter((p): p is TemplatePartText & { name: string } => p.name !== null);
  const wanted = o.parts && o.parts.length > 0 ? [...new Set(o.parts)] : null;
  for (const name of wanted ?? []) {
    if (!stdParts.some((p) => p.name === name)) throw new Error(`部品 ${name} は画面 ${screen} にありません（部品の名前: ${stdParts.map((p) => p.name).join("、")}）`);
  }
  const raw = readConfig(root);
  const file = screenTemplatePath(raw.ui, screen);
  const path = abs(root, file);
  const picked = wanted ? stdParts.filter((p) => wanted.includes(p.name)) : stdParts;
  const scriptFile = screenScriptPath(raw.ui, screen);
  if (o.js && !o.force && existsSync(abs(root, scriptFile))) throw new Error(`${scriptFile} はもうあります（書き直すなら --force を付けます）`);
  if (!wanted || !existsSync(path)) {
    if (existsSync(path) && !o.force) throw new Error(`${file} はもうあります（書き直すなら --force を付けます。部品だけを足すなら --part で選びます）`);
    const body = wanted ? `${picked.map((p) => p.text).join("\n")}\n` : std.template.endsWith("\n") ? std.template : `${std.template}\n`;
    write(path, `${header(screen, o.engine)}<style>\n</style>\n${body}`);
  } else {
    let html = readFileSync(path, "utf8");
    const mine = splitTemplateParts(html);
    const clash = picked.filter((p) => mine.some((m) => m.name === p.name));
    if (clash.length > 0 && !o.force) throw new Error(`部品 ${clash.map((p) => p.name).join("、")} はもう ${file} にあります（書き直すなら --force を付けます）`);
    // 後ろから入れ替える（前の位置がずれないように）。無い部品は終わりに足す
    for (const m of [...mine].reverse()) {
      const p = picked.find((x) => x.name === m.name);
      if (p) html = html.slice(0, m.start) + p.text + html.slice(m.end);
    }
    const added = picked.filter((p) => !mine.some((m) => m.name === p.name));
    if (added.length > 0) html = `${html.replace(/\s*$/, "\n")}${added.map((p) => p.text).join("\n")}\n`;
    write(path, html);
  }
  // 元の文字を残す（同じ版はいつも同じ文字なので、あれば書かない）
  const originals: string[] = [];
  for (const p of picked) {
    const keep = `${SCREEN_ORIGINALS_DIR}/${screen}/${p.name}.${p.version ?? 0}.html`;
    const keepPath = abs(root, keep);
    if (!existsSync(keepPath)) write(keepPath, p.text);
    originals.push(keep);
  }
  const registered = !screenRegistered(raw.ui, screen);
  if (registered) {
    const ui = raw.ui && typeof raw.ui === "object" && !Array.isArray(raw.ui) ? (raw.ui as Record<string, unknown>) : {};
    ui.templates = { ...templatesOf(ui), [screen]: file };
    raw.ui = ui;
    writeConfig(root, raw);
  }
  const script = o.js ? writeScreenScript(root, screens, screen, { force: true }) : undefined;
  return { file, parts: picked.map((p) => p.name), registered, originals, ...(script ? { script } : {}) };
}

/** 画面の JS の雛形。 */
function scriptSkeleton(screen: string, template: string): string {
  const name = template.split("/").pop()!;
  return `// 画面 ${screen} の JavaScript。テンプレート（${name}）から作った画面の要素と、画面の api を受け取る。
// 属性（data-role など）の働き、キー、フォーカス、読み上げは、ここに書かなくてもそのまま効く。属性で書けない動きだけを書く。
// api の中身: values（画面の値）、press(働きの名前)、close()、result(結果)、render(部品, 値)、text(標準の文言の鍵)。
// 書き方は Liminalia の資料 docs/design/screen-templates.md の「画面の JS」。

/**
 * @param {HTMLElement} screen テンプレートから作った画面の要素
 * @param {import("@liminalia/web").ScreenScriptApi} api 画面の api
 */
export default function (screen, api) {
  // 例: 画面の値を印にして、CSS から当てる
  // screen.dataset.kind = String(api.values.kind ?? "");

  // 閉じるときに片付けるもの（足した見張りなど）があれば、関数を返す
  return () => {};
}
`;
}

/** 画面の JS の雛形を置く（あれば force が無ければ断る）。置いたファイルを返す。 */
export function writeScreenScript(root: string, screens: Readonly<Record<string, CopyableScreen>>, screen: string, o: { force?: boolean } = {}): string {
  standardOf(screens, screen);
  const ui = readConfig(root).ui;
  const file = screenScriptPath(ui, screen);
  const path = abs(root, file);
  if (existsSync(path) && !o.force) throw new Error(`${file} はもうあります（書き直すなら --force を付けます）`);
  write(path, scriptSkeleton(screen, screenTemplatePath(ui, screen)));
  return file;
}

// ---- 違いを出す ----

/** 標準が写した元の版から変わったところ。 */
export type StandardChange = { from: number | undefined; now: number; diff: string } | { from: number | undefined; now: number; missingOriginal: true };

export interface ScreenPartDiff {
  part: string;
  /** 作品の部品の data-version（写した元の版）。 */
  version: number | undefined;
  /** 今の標準の版（標準に無い部品なら undefined）。 */
  standardVersion: number | undefined;
  /** 今の標準の部品から作品の部品への差分（同じなら空。標準に無い部品なら空）。 */
  authorDiff: string;
  /** 写した元の版から今の標準で変わったところ（変わっていなければ null）。 */
  standardChange: StandardChange | null;
}

export interface ScreenDiff {
  screen: string;
  file: string;
  parts: ScreenPartDiff[];
}

/** 作品のテンプレートと今の標準の差分と、写した元の版から今の標準で変わったところ（部品ごと）。 */
export function diffScreen(root: string, screens: Readonly<Record<string, CopyableScreen>>, screen: string): ScreenDiff {
  const std = standardOf(screens, screen);
  const ui = readConfig(root).ui;
  if (!screenRegistered(ui, screen)) throw new Error(`${screen} は標準のテンプレートのままです（ui.templates.${screen} がありません。コピーするなら lim screens copy ${screen}）`);
  const file = screenTemplatePath(ui, screen);
  const path = abs(root, file);
  if (!existsSync(path)) throw new Error(`ui.templates.${screen} のファイル ${file} がありません`);
  const stdParts = splitTemplateParts(std.template);
  const out: ScreenPartDiff[] = [];
  for (const mine of splitTemplateParts(readFileSync(path, "utf8"))) {
    if (mine.name === null) continue;
    const now = stdParts.find((p) => p.name === mine.name);
    const authorDiff = now ? unifiedDiff(now.text, mine.text, `標準 ${mine.name}（バージョン ${now.version ?? "なし"}）`, `プロジェクト ${mine.name}（バージョン ${mine.version ?? "なし"}）`) : "";
    let standardChange: StandardChange | null = null;
    if (now?.version !== undefined && (mine.version === undefined || mine.version < now.version)) {
      const keep = join(root, ...SCREEN_ORIGINALS_DIR.split("/"), screen, `${mine.name}.${mine.version ?? 0}.html`);
      standardChange =
        mine.version !== undefined && existsSync(keep)
          ? { from: mine.version, now: now.version, diff: unifiedDiff(readFileSync(keep, "utf8"), now.text, `標準 ${mine.name}（バージョン ${mine.version}）`, `標準 ${mine.name}（バージョン ${now.version}）`) }
          : { from: mine.version, now: now.version, missingOriginal: true };
    }
    out.push({ part: mine.name, version: mine.version, standardVersion: now?.version, authorDiff, standardChange });
  }
  return { screen, file, parts: out };
}

/** 行の差分（unified diff。前後 3 行）。同じなら空の文字。 */
export function unifiedDiff(before: string, after: string, beforeLabel: string, afterLabel: string, context = 3): string {
  // 改行の違い（Windows で取り出した CRLF のファイル）は差分にしない
  const split = (text: string) => text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const a = split(before);
  const b = split(after);
  if (a.join("\n") === b.join("\n")) return "";
  // 共通の部分列（テンプレートは小さいので表で数える）
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const ops: { op: " " | "-" | "+"; line: string; a: number; b: number }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) ops.push({ op: " ", line: a[i++]!, a: i, b: ++j });
    // 消す行を足す行より先に出す
    else if (i < a.length && (j >= b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) ops.push({ op: "-", line: a[i++]!, a: i, b: j });
    else ops.push({ op: "+", line: b[j++]!, a: i, b: j });
  }
  const lines = [`--- ${beforeLabel}`, `+++ ${afterLabel}`];
  let k = 0;
  while (k < ops.length) {
    if (ops[k]!.op === " ") {
      k++;
      continue;
    }
    let start = Math.max(0, k - context);
    let end = k;
    // 次の変わった所が近ければ、一つの塊にする
    for (;;) {
      while (end < ops.length && ops[end]!.op !== " ") end++;
      let next = end;
      while (next < ops.length && ops[next]!.op === " ") next++;
      if (next < ops.length && next - end <= context * 2) end = next;
      else {
        end = Math.min(ops.length, end + context);
        break;
      }
    }
    const hunk = ops.slice(start, end);
    const aStart = hunk.find((o) => o.op !== "+");
    const bStart = hunk.find((o) => o.op !== "-");
    const aCount = hunk.filter((o) => o.op !== "+").length;
    const bCount = hunk.filter((o) => o.op !== "-").length;
    const aFrom = aStart ? aStart.a : (hunk[0]?.a ?? 0);
    const bFrom = bStart ? bStart.b : (hunk[0]?.b ?? 0);
    lines.push(`@@ -${aFrom},${aCount} +${bFrom},${bCount} @@`);
    for (const o of hunk) lines.push(`${o.op}${o.line}`);
    start = end;
    k = end;
  }
  return `${lines.join("\n")}\n`;
}

// ---- 標準に戻す ----

export interface ResetScreenResult {
  /** ui.templates から外したか。 */
  unregistered: boolean;
  /** 名前を変えて残したファイル（作品のフォルダから）。 */
  moved: { from: string; to: string }[];
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * ui.templates からその画面を外して標準に戻す。テンプレートと画面の JS は消さずに、<名前>.reset-<日時>.html（.js）に名前を変えて残す。
 * 登録も JS も無ければ断る。
 */
export function resetScreen(root: string, screen: string, now: Date = new Date()): ResetScreenResult {
  const raw = readConfig(root);
  const registered = screenRegistered(raw.ui, screen);
  const files = [screenTemplatePath(raw.ui, screen), screenScriptPath(raw.ui, screen)];
  const present = files.filter((f) => existsSync(abs(root, f)));
  // 登録が無ければ、決まりの場所の JS だけを戻す（決まりの場所のテンプレートは登録しなければ使われない）
  const targets = registered ? present : present.filter((f) => f.endsWith(".js"));
  if (!registered && targets.length === 0) throw new Error(`${screen} は標準のテンプレートのままです（ui.templates.${screen} も画面の JS もありません）`);
  const time = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  // 同じ秒に前に残したファイルがあれば -2、-3 … を足す（renameSync は行き先があっても上書きする。テンプレートと JS は同じ名前にそろえる）
  const renamed = (stamp: string) => targets.map((from) => ({ from, to: from.replace(/\.(html|js)$/i, `.reset-${stamp}.$1`) }));
  let n = 1;
  while (renamed(n === 1 ? time : `${time}-${n}`).some((m) => existsSync(abs(root, m.to)))) n++;
  const moved = renamed(n === 1 ? time : `${time}-${n}`);
  for (const { from, to } of moved) renameSync(abs(root, from), abs(root, to));
  if (registered) {
    const ui = raw.ui as Record<string, unknown>;
    const templates = { ...templatesOf(ui) };
    delete templates[screen];
    if (Object.keys(templates).length > 0) ui.templates = templates;
    else delete ui.templates;
    writeConfig(root, raw);
  }
  return { unregistered: registered, moved };
}
