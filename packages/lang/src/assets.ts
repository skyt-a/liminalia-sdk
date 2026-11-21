import { normalizeBooleanArgs, paramLocalName, parseArgs } from "./args.ts";
import type { Argument, Inline, Script, Statement } from "./ast.ts";
import type { Cast } from "./cast.ts";
import { parseCredits } from "./credits.ts";
import { htmlPosition, scanHtml } from "./html.ts";
import { inlineCommands } from "./line-syntax.ts";
import type { CommandSpec, Registry } from "./registry.ts";

/**
 * 台本の中で素材を指す書き方。lim check・lim build・lim rename asset・lim unused・制作画面が、どれも assetReferences と
 * dynamicAssetReferences で同じに集める。書き方を足したら、packages/cli/test/asset-reference-forms.test.ts の表にも足す（足さないと型で落ちる）。
 * - command: 命令の行の素材の型の引数（folder= で探す場所が替わる）
 * - macro: 作品のマクロ（@define）の素材の型 asset(フォルダ) の引数
 * - with: @with マクロ の行の、素材の型の引数
 * - inline-command: 本文と選択肢の文の中の命令（{@se x.wav}）の素材の型の引数
 * - inline-image: 本文の中の画像（{img …}）
 * - html-image: @html の中の <img src>
 * - staff-roll-image: @staff-roll の中の {img …} の行
 * - choice-image: 画像の選択肢（image= と hover=）
 */
export const SCRIPT_ASSET_FORMS = ["command", "macro", "with", "inline-command", "inline-image", "html-image", "staff-roll-image", "choice-image"] as const;
export type ScriptAssetForm = (typeof SCRIPT_ASSET_FORMS)[number];

/** 参照されている素材。folder は素材の種類のフォルダ（bgimage・fgimage・bgm など）、path はその中のパス。 */
export interface AssetReference {
  folder: string;
  path: string;
  line: number;
  /**
   * 引数の桁（1 始まり。行の頭からの桁。Argument.column）。名前を替えるときに書き換える場所。本文の中のもの（inline-command と inline-image）と
   * @staff-roll の {img …} は、書き換えるときは行の字面から探し直す（inlineAssetSites）。
   */
  column: number;
  form: ScriptAssetForm;
}

/** 命令の素材の型の引数。folder= を式で書いたものは、探すフォルダが実行するまで分からない（dynamicFolder にその字面と、探しうるフォルダ）。 */
interface AssetArgument {
  arg: Argument;
  folder: string;
  dynamicFolder?: { source: string; folders: string[] };
}

/** 命令（行の命令・本文の中の命令・@with）の素材の型の引数。行の命令と本文の中の命令で同じ見方をする。 */
function assetArguments(spec: CommandSpec, args: readonly Argument[]): AssetArgument[] {
  const folderArg = args.find((a) => a.key === "folder");
  const fixed = folderArg?.value.kind === "string" ? folderArg.value.value : null;
  const choices = spec.params.folder?.type.kind === "enum" ? spec.params.folder.type.values : [];
  const out: AssetArgument[] = [];
  let pos = 0;
  for (const a of normalizeBooleanArgs(spec, args)) {
    const key = a.key ?? spec.positional[pos++];
    const type = key ? spec.params[key]?.type : undefined;
    if (type?.kind !== "asset") continue;
    if (folderArg?.value.kind === "expr") out.push({ arg: a, folder: type.folder, dynamicFolder: { source: folderArg.value.source, folders: [...new Set([type.folder, ...choices])] } });
    else out.push({ arg: a, folder: fixed ?? type.folder });
  }
  return out;
}

/** 本文の中の命令（{@…}。飾り・出し分けの中も）。 */
function inlineCommandsIn(nodes: readonly Inline[], out: { name: string; args: Argument[] }[] = []): { name: string; args: Argument[] }[] {
  for (const n of nodes) {
    if (n.kind === "command") out.push(n);
    else if ("children" in n) inlineCommandsIn(n.children, out);
  }
  return out;
}

/**
 * シナリオが参照する素材（書き方は SCRIPT_ASSET_FORMS）。folder= を持つ命令は、その値で探す場所が替わる。式で書いた引数と、
 * folder= を式で書いた命令は見ない（dynamicAssetReferences が拾う）。素材の実在の確認（lim check・lim build・制作画面の点検）と名前の変更に使う。
 * macros は作品の @define の仕様（素材の型 asset(フォルダ) の引数も集める）。
 */
export function assetReferences(script: Script, registry: Registry, macros?: ReadonlyMap<string, CommandSpec>): AssetReference[] {
  const out: AssetReference[] = [];
  const command = (name: string, args: readonly Argument[], line: number, form: "command" | "with" | "inline-command") => {
    // マクロ（@define。素材の型 asset(フォルダ) の引数）は、同じ名前の組み込みの命令より先（実行器と同じ）
    const macro = macros?.get(name);
    const spec = macro ?? registry.get(name);
    if (!spec) return;
    for (const { arg, folder, dynamicFolder } of assetArguments(spec, args)) {
      if (dynamicFolder || arg.value.kind !== "string") continue;
      out.push({ folder, path: arg.value.value, line, column: arg.column, form: form === "command" && macro ? "macro" : form });
    }
  };
  // 本文の中の画像（{img …}）と命令（{@…}）
  const inline = (nodes: readonly Inline[], line: number) => {
    for (const n of nodes) {
      if (n.kind === "image") out.push({ folder: "image", path: n.path, line, column: n.column ?? 1, form: "inline-image" });
      else if (n.kind === "command") command(n.name, n.args, line, "inline-command");
      else if ("children" in n) inline(n.children, line);
    }
  };
  const visit = (body: Statement[]) => {
    for (const s of body) {
      if (s.kind === "command") {
        command(s.name, s.args, s.line, "command");
        // @staff-roll の中身の {img …} の行（image フォルダ）
        if (s.name === "staff-roll" && s.body) {
          s.body.text.split("\n").forEach((row, n) => {
            // 桁はパスの頭（修正案と名前の変更がその字に当てる。中身の行は字下げを外した字面）
            for (const c of parseCredits([row])) if (c.kind === "image") out.push({ folder: "image", path: c.path, line: s.body!.line + n, column: s.body!.indent + 1 + Math.max(0, row.indexOf(c.path)), form: "staff-roll-image" });
          });
        }
        // @html の <img src>（image フォルダ。{img …} と同じ）
        if (s.name === "html" && s.body) {
          const body = s.body;
          for (const src of scanHtml(body.text).sources) {
            const p = htmlPosition(body.text, src.offset);
            out.push({ folder: "image", path: src.path, line: body.line + p.line, column: body.indent + p.column + 1, form: "html-image" });
          }
        }
      }
      if (s.kind === "prose" || s.kind === "say") inline(s.content, s.line);
      if (s.kind === "choice") {
        for (const o of s.options) inline(o.content, o.line);
        for (const o of s.options) for (const a of o.args) if ((a.key === "image" || a.key === "hover") && a.value.kind === "string") out.push({ folder: "image", path: a.value.value, line: o.line, column: a.column, form: "choice-image" });
      }
      if (s.kind === "if") {
        if (s.with) command(s.with.name, s.with.args, s.line, "with");
        for (const b of s.branches) visit(b.body);
      }
      if (s.kind === "define") visit(s.body);
    }
  };
  visit(script.body);
  return out;
}

/** 行の中で、素材の名前の字面がある所（0 始まり。end は含まない。"…" で囲んだものは囲みも含む）。 */
export interface InlineAssetSite {
  folder: string;
  path: string;
  start: number;
  end: number;
  form: "inline-command" | "inline-image";
}

/**
 * 行の中の本文の中の命令（{@…}）の素材の型の引数（文字で書いたもの）と、本文の中の画像（{img …}）の字面の場所。
 * 名前の変更は行の字面からここで探し直して書き換える（引数の読み方は assetReferences と同じ）。
 */
export function inlineAssetSites(line: string, registry: Registry, macros?: ReadonlyMap<string, CommandSpec>): InlineAssetSite[] {
  const out: InlineAssetSite[] = [];
  for (const site of inlineCommands(line)) {
    const spec = macros?.get(site.name) ?? registry.get(site.name);
    if (!spec) continue;
    const { args } = parseArgs(line.slice(site.argsStart, site.end), site.argsStart + 1);
    for (const { arg, folder, dynamicFolder } of assetArguments(spec, args)) {
      if (dynamicFolder || arg.value.kind !== "string") continue;
      const token = site.args.find((t) => t.start === arg.column - 1);
      if (token) out.push({ folder, path: arg.value.value, start: token.valueStart, end: token.end, form: "inline-command" });
    }
  }
  for (const m of line.matchAll(/(?<!\\)\{img ([^\s{}]+)(?: \d+(?:\.\d+)?)?\}/g)) {
    const start = m.index + "{img ".length;
    out.push({ folder: "image", path: m[1]!, start, end: start + m[1]!.length, form: "inline-image" });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** 式で書いた素材の引数（名前を実行時に組み立てるので、どの素材を使うか台本からは分からない）。 */
export interface DynamicAssetReference {
  folder: string;
  line: number;
  column: number;
  /** 書いた式（`("bg_" + n)` の中身）。folder= を式で書いた命令なら、その式。 */
  source: string;
  form: ScriptAssetForm;
}

/**
 * 素材の型の引数を式で書いた命令と、folder= を式で書いた命令を集める（lim build の「使っている素材だけ」が、そのフォルダを外さないために使う）。
 * folder= を式で書いた命令は、folder の候補のフォルダをすべて数える。
 * @define の中で、素材の型（asset(フォルダ)）のパラメータをそのまま渡しているだけ（`(パラメータ名)`）のものは数えない
 * （呼ぶ側の値を、文字なら参照として、式ならここで、呼ぶ所で見る）。ほかの型のパラメータを渡すものは数える。
 * ブロック（@if・@while・@for・@with・選択肢など）の中と、本文と選択肢の文の中の命令（{@…}）もたどる。
 */
export function dynamicAssetReferences(script: Script, registry: Registry, macros?: ReadonlyMap<string, CommandSpec>): DynamicAssetReference[] {
  const out: DynamicAssetReference[] = [];
  const check = (name: string, args: readonly Argument[], line: number, assetParams: ReadonlySet<string>, form: "command" | "with" | "inline-command") => {
    const macro = macros?.get(name);
    const spec = macro ?? registry.get(name);
    if (!spec) return;
    const as: ScriptAssetForm = form === "command" && macro ? "macro" : form;
    for (const { arg: a, folder, dynamicFolder } of assetArguments(spec, args)) {
      const column = a.column;
      if (dynamicFolder) {
        for (const f of dynamicFolder.folders) out.push({ folder: f, line, column, source: dynamicFolder.source, form: as });
        continue;
      }
      if (a.value.kind !== "expr") continue;
      if (a.value.expr.kind === "name" && assetParams.has(a.value.expr.name)) continue;
      out.push({ folder, line, column, source: a.value.source, form: as });
    }
  };
  /** 文の中の入れ子の文（ブロックの中身）をたどる。形を決め打ちせず、kind を持つものの並びを探す。 */
  const walk = (node: unknown, params: ReadonlySet<string>, line: number): void => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n, params, line);
      return;
    }
    if (!node || typeof node !== "object") return;
    const s = node as Record<string, unknown>;
    const here = typeof s.line === "number" ? s.line : line;
    if (s.kind === "command") {
      const c = s as unknown as Extract<Statement, { kind: "command" }>;
      check(c.name, c.args, c.line, params, "command");
    }
    if (s.kind === "if") {
      const w = (s as unknown as Extract<Statement, { kind: "if" }>).with;
      if (w) check(w.name, w.args, here, params, "with");
    }
    // 画像の選択肢（image= / hover=）を式で書いたもの
    if (s.kind === "choice") {
      for (const o of (s as unknown as Extract<Statement, { kind: "choice" }>).options) {
        for (const a of o.args) if ((a.key === "image" || a.key === "hover") && a.value.kind === "expr") out.push({ folder: "image", line: o.line, column: a.column, source: a.value.source, form: "choice-image" });
      }
    }
    // 素材の型のパラメータ（asset(フォルダ)）だけ。呼ぶ側の値は assetReferences と、式ならここで、呼ぶ所で見る
    const inner = s.kind === "define" ? new Set([...params, ...(s as unknown as Extract<Statement, { kind: "define" }>).params.filter((p) => p.type.startsWith("asset")).map((p) => paramLocalName(p.name))]) : params;
    for (const [k, v] of Object.entries(s)) {
      // 本文と選択肢の文の中の命令（{@se ("a_" + n + ".wav")}）
      if (k === "content" && Array.isArray(v)) {
        for (const c of inlineCommandsIn(v as Inline[])) check(c.name, c.args, here, inner, "inline-command");
        continue;
      }
      // 引数と式の中には文が無い
      if (k === "args" || k === "value" || k === "expr" || k === "with") continue;
      if (v && typeof v === "object") walk(v, inner, here);
    }
  };
  walk(script.body, new Set(), 0);
  return out;
}

/**
 * キャストの定義（立ち絵セット → 差分 → image・lip・blink）が参照する立ち絵（fgimage）と、名前の欄と枠の画像（nameImage・windowImage。image）。
 * folder を省いたものは fgimage。形の崩れたキャストは飛ばす。
 */
export function castAssetReferences(cast: Readonly<Record<string, unknown>>): { who: string; path: string; folder?: "image" }[] {
  const out: { who: string; path: string; folder?: "image" }[] = [];
  for (const [who, c] of Object.entries(cast as Cast)) {
    for (const k of ["nameImage", "windowImage"] as const) {
      const path = (c as Partial<Cast[string]> | null)?.[k];
      if (typeof path === "string" && path !== "") out.push({ who, path, folder: "image" });
    }
    const appearances = (c as Partial<Cast[string]> | null)?.appearances ?? {};
    for (const a of Object.values(appearances)) {
      // パーツ合成の層の絵
      for (const l of Array.isArray(a?.layers) ? a.layers : []) for (const p of Object.values(l?.options ?? {})) if (typeof p === "string" && p !== "") out.push({ who, path: p });
      for (const v of Object.values(a?.variants ?? {})) {
        if (v?.image) out.push({ who, path: v.image });
        if (typeof v?.face === "string" && v.face !== "") out.push({ who, path: v.face });
        // 口パク・まばたきの重ね画像
        for (const part of [...(Array.isArray(v?.lip) ? v.lip : []), ...(Array.isArray(v?.blink) ? v.blink : [])]) if (typeof part === "string" && part !== "") out.push({ who, path: part });
      }
    }
  }
  return out;
}
