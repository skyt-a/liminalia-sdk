import { normalizeBooleanArgs } from "./args.ts";
import type { Argument, Diagnostic, Inline, Script, Statement } from "./ast.ts";
import type { ExtraConfig } from "./extra.ts";
import { printLiteral } from "./args.ts";
import { CORE_COMMANDS, createRegistry, type CommandSpec, type Registry } from "./registry.ts";

/**
 * おまけの CG の解放。CG の画像は @cg-unlock で解放するほか、CG として解放する印（ParamType の asset の cg）の付いたパラメータで
 * 出したとき（@bg・@bg-place と、印を付けたプラグインのコマンド）にも、実行器が解放する（Runtime の options.cg）。
 * ここには、その判定と、要らない @cg-unlock・どこからも出ない CG の検査を置く。
 */

/** CG として解放する画像か（folder は素材のフォルダ、image はそこからのパス）。 */
export type CgMatcher = (folder: string, image: string) => boolean;

/** CG の画像のパスの頭（extra.cgAuto のフォルダ。bgimage の中）。無ければ null。 */
function autoPrefix(extra: ExtraConfig | undefined): string | null {
  const folder = extra?.cgAuto?.folder;
  return typeof folder === "string" && folder !== "" ? `${folder.replace(/\/+$/, "")}/` : null;
}

/**
 * CG として解放する画像を決める関数。liminalia.json の extra.cg の images（folder ごと）と、extra.cgAuto のフォルダの下の背景（bgimage）。
 * CG が一つも無ければ null（何も解放しない）。
 */
export function cgMatcher(extra: ExtraConfig | undefined): CgMatcher | null {
  const images = new Set<string>();
  for (const c of Array.isArray(extra?.cg) ? extra.cg : []) {
    for (const image of Array.isArray(c?.images) ? c.images : []) if (typeof image === "string") images.add(`${c.folder ?? "bgimage"}/${image}`);
  }
  const prefix = autoPrefix(extra);
  if (images.size === 0 && prefix === null) return null;
  return (folder, image) => images.has(`${folder}/${image}`) || (prefix !== null && folder === "bgimage" && image.startsWith(prefix));
}

/** コマンドの、CG として解放する素材のパラメータの名前（asset 型で cg の印があるもの）。 */
export function cgParams(spec: CommandSpec): string[] {
  return Object.keys(spec.params).filter((name) => {
    const type = spec.params[name]!.type;
    return type.kind === "asset" && type.cg === true;
  });
}

/** 出した素材（フォルダとパス）。 */
export interface CgImage {
  folder: string;
  image: string;
}

/**
 * コマンドが CG として出す素材（cg の印のパラメータに文字列で書いたもの。folder= があればそのフォルダ）と、式で書いていて分からないものがあるか。
 * @cg-unlock は出す素材ではなく解放する素材なので、unlockOf で読む。
 */
export function cgShown(spec: CommandSpec | undefined, args: readonly Argument[]): { shown: CgImage[]; dynamic: boolean } {
  const out: { shown: CgImage[]; dynamic: boolean } = { shown: [], dynamic: false };
  if (!spec) return out;
  const names = new Set(cgParams(spec));
  if (names.size === 0) return out;
  const folderArg = args.find((a) => a.key === "folder");
  const override = folderArg?.value.kind === "string" ? folderArg.value.value : null;
  let pos = 0;
  for (const a of normalizeBooleanArgs(spec, args)) {
    const key = a.key ?? spec.positional[pos++];
    if (key === undefined || !names.has(key)) continue;
    const type = spec.params[key]!.type as { kind: "asset"; folder: string };
    if (a.value.kind === "string" && a.value.value !== "") out.shown.push({ folder: override ?? type.folder, image: a.value.value });
    else if (a.value.kind === "expr") out.dynamic = true;
  }
  return out;
}

/** @cg-unlock の解放する画像（文字列で書いたもの）。式なら "dynamic"、書いていなければ null。 */
export function unlockOf(args: readonly Argument[]): CgImage | "dynamic" | null {
  const image = args.find((a) => a.key === "image") ?? args.find((a) => a.key === null);
  if (!image) return null;
  if (image.value.kind === "expr") return "dynamic";
  if (image.value.kind !== "string" || image.value.value === "") return null;
  const folder = args.find((a) => a.key === "folder");
  return { folder: folder?.value.kind === "string" ? folder.value.value : "bgimage", image: image.value.value };
}

const keyOf = (c: CgImage) => `${c.folder}/${c.image}`;

/** コマンドの行の中身（空白を一つにそろえた形。DiagnosticFix の text）。 */
export function commandText(name: string, args: readonly Argument[]): string {
  return `@${name}${args.map((a) => ` ${a.key === null ? "" : `${a.key}=`}${printLiteral(a.value)}`).join("")}`;
}

/** 台本の命令（行のコマンドと、本文・選択肢の中のコマンド）を行番号つきで。@if・@define の中も。 */
function* allCommands(body: readonly Statement[]): Generator<{ name: string; args: Argument[]; line: number }> {
  const inline = function* (nodes: readonly Inline[], line: number): Generator<{ name: string; args: Argument[]; line: number }> {
    for (const n of nodes) {
      if (n.kind === "command") yield { name: n.name, args: n.args, line };
      else if ("children" in n) yield* inline(n.children, line);
    }
  };
  for (const s of body) {
    if (s.kind === "command") yield { name: s.name, args: s.args, line: s.line };
    if (s.kind === "say" || s.kind === "prose") yield* inline(s.content, s.line);
    if (s.kind === "choice") for (const o of s.options) yield* inline(o.content, o.line);
    if (s.kind === "if") for (const b of s.branches) yield* allCommands(b.body);
    if (s.kind === "define") yield* allCommands(s.body);
  }
}

/**
 * シナリオが CG として出す・解放する画像（cg の印のパラメータと @cg-unlock に文字列で書いたもの）。
 * dynamic は、式で書いていて分からないものがあるか。
 */
export function cgReferences(scripts: Iterable<readonly [string, Script]>, registry: Registry = createRegistry(CORE_COMMANDS)): { images: Set<string>; dynamic: boolean } {
  const images = new Set<string>();
  let dynamic = false;
  for (const [, script] of scripts) {
    for (const c of allCommands(script.body)) {
      if (c.name === "cg-unlock") {
        const u = unlockOf(c.args);
        if (u === "dynamic") dynamic = true;
        else if (u) images.add(keyOf(u));
        continue;
      }
      const r = cgShown(registry.get(c.name), c.args);
      if (r.dynamic) dynamic = true;
      for (const s of r.shown) images.add(keyOf(s));
    }
  }
  return { images, dynamic };
}

/** 並びの一つ（行のコマンドか、本文・選択肢の中のコマンド）。 */
interface RunItem {
  name: string;
  args: Argument[];
  line: number;
  /** 本文の中のコマンド（{@…}）なら true。 */
  inline: boolean;
}

/** 本文の中のコマンドを書いた順に（飾りの中も）。 */
function inlineCommands(nodes: readonly Inline[], line: number, out: RunItem[] = []): RunItem[] {
  for (const n of nodes) {
    if (n.kind === "command") out.push({ name: n.name, args: n.args, line, inline: true });
    else if ("children" in n) inlineCommands(n.children, line, out);
  }
  return out;
}

/**
 * 要らない @cg-unlock（行のコマンドと、本文の中の {@cg-unlock …}）。同じ画像を CG として出すコマンド（@bg など）と、あいだにコマンドしか無い並びの中にあるもの。
 * - 前に出しているなら、@cg-unlock に着いたときにはもう解放してある（ラベル・選択肢・@if などで並びが切れていれば見ない）
 * - 後ろで出すなら、あいだが組み込みのコマンド（ゲームを終える・止めるもの以外）だけのとき、必ずそこまで進んで解放する
 * 本文の行は、その前の行のコマンドの並びに本文の中のコマンドを続け、行の終わりで並びを切る（行のコマンドから後ろの本文の中は見ない）。
 * 行のコマンドの診断だけが行を消す直し方（fix）を持つ。本文の中のものは、その書き方だけを消す。
 * CG の一覧（extra.cg・extra.cgAuto）に無い画像は、出しても解放されないので知らせない。
 */
export function redundantCgUnlocks(scripts: Iterable<readonly [string, Script]>, extra: ExtraConfig | undefined, registry: Registry = createRegistry(CORE_COMMANDS)): Diagnostic[] {
  const match = cgMatcher(extra);
  if (!match) return [];
  const core = new Set(CORE_COMMANDS.filter((c) => !c.ends && c.name !== "stop").map((c) => c.name));
  const out: Diagnostic[] = [];
  for (const [file, script] of scripts) {
    const runs: RunItem[][] = [];
    const collect = (body: readonly Statement[]) => {
      let run: RunItem[] = [];
      for (const s of body) {
        if (s.kind === "command") {
          run.push({ name: s.name, args: s.args, line: s.line, inline: false });
          continue;
        }
        if (s.kind === "say" || s.kind === "prose") run.push(...inlineCommands(s.content, s.line));
        if (run.length > 0) runs.push(run);
        run = [];
        if (s.kind === "if") for (const b of s.branches) collect(b.body);
        if (s.kind === "define") collect(s.body);
      }
      if (run.length > 0) runs.push(run);
    };
    collect(script.body);
    for (const run of runs) {
      const shown = run.map((s) => (s.name === "cg-unlock" ? [] : cgShown(registry.get(s.name), s.args).shown.map(keyOf)));
      run.forEach((s, i) => {
        if (s.name !== "cg-unlock") return;
        const u = unlockOf(s.args);
        if (!u || u === "dynamic" || !match(u.folder, u.image)) return;
        const key = keyOf(u);
        let by = -1;
        for (let j = i - 1; j >= 0 && by < 0; j--) if (shown[j]!.includes(key)) by = j;
        for (let j = i + 1; j < run.length && by < 0; j++) {
          // 行のコマンドから、後ろの本文の中のコマンドへは見ない（本文を出すところで止まることがある）
          if (run[j]!.inline && !s.inline) break;
          if (shown[j]!.includes(key)) by = j;
          else if (!core.has(run[j]!.name)) break;
        }
        if (by < 0) return;
        const shower = run[by]!;
        const where = shower.line === s.line ? "同じ行" : `${shower.line} 行目`;
        const shownBy = shower.inline ? `{@${shower.name}}` : `@${shower.name}`;
        out.push({
          severity: "info",
          code: "redundant-cg-unlock",
          message: s.inline
            ? `CG ${u.image} は ${where}の ${shownBy} で表示したときに解放されるため、本文の中のこの {@cg-unlock} は要りません`
            : `CG ${u.image} は ${shower.line} 行目の @${shower.name} で表示したときに解放されるため、この @cg-unlock は要りません`,
          file,
          line: s.line,
          ...(s.inline
            ? { hint: `本文から {${commandText(s.name, s.args)}} を削除します` }
            : { hint: "この行を削除します", fix: { kind: "delete-line" as const, text: commandText(s.name, s.args) } }),
        });
      });
    }
  }
  return out;
}

/**
 * どこからも出ない CG（liminalia.json の extra.cg に書いた画像のうち、どのシナリオも CG として出さず、@cg-unlock もしないもの）。
 * おまけで見られないので警告にする。式で出す画像があるときは、分からないので情報にとどめる。cgAuto で足したものは出しているので見ない。
 * dataCg（`フォルダ/パス`）は、プラグインが作品のデータから解放する画像（データの形の宣言で CG の印を付けた素材の欄）で、出しているものとして数える。
 */
export function unshownCg(extra: ExtraConfig | undefined, scripts: Iterable<readonly [string, Script]>, registry: Registry = createRegistry(CORE_COMMANDS), dataCg?: ReadonlySet<string>): Diagnostic[] {
  const list = Array.isArray(extra?.cg) ? extra.cg : [];
  if (list.length === 0) return [];
  const { images, dynamic } = cgReferences(scripts, registry);
  const out: Diagnostic[] = [];
  for (const c of list) {
    if (c?.auto || !Array.isArray(c?.images)) continue;
    for (const image of c.images) {
      const key = `${c.folder ?? "bgimage"}/${image}`;
      if (typeof image !== "string" || images.has(key) || dataCg?.has(key)) continue;
      out.push({
        severity: dynamic ? "info" : "warning",
        code: "unshown-cg",
        message: `CG ${c.id} の画像 ${image} は、どのシナリオでも表示も解放もしないため、おまけで見られません`,
        file: "liminalia.json",
        line: 1,
        hint: "その画像を @bg で表示するか @cg-unlock で解放します。使わない画像なら extra.cg から外します",
      });
    }
  }
  return out;
}
