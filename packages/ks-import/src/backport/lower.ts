import {
  applyCommandDefaults,
  cgMatcher,
  cgShown,
  normalizeBooleanArgs,
  parse,
  parseArgs,
  parseLiteral,
  printInline,
  printLiteral,
  redundantCgUnlocks,
  unlockOf,
  type Argument,
  type CgMatcher,
  type CommandDefaults,
  type CommandSpec,
  type ExtraConfig,
  type Inline,
  type ParamType,
  type Registry,
  type Statement,
} from "@liminalia/lang";
import type { BackportRule } from "./inverse.ts";
import { readLimLines } from "./lim-line.ts";

/**
 * 書き戻しの前に、.lim を TyranoScript で同じ動きになる形に直す（行の対応つき）。.ks の側に無い Liminalia の決まりを、
 * 行として書き出しておく。
 * - コマンドの既定値（liminalia.json の commandDefaults）: 省いたパラメータを書く（今の .lim だけ。基準の .lim は取り込んだときの
 *   標準の既定値のままの意味なので、既定値を替えた分は書き換えとして .ks に書き戻る）
 * - 一人ずつ出す @chara（solo=true）: @chara-hide-all と solo を外した @chara の二行にする
 * - 場面転換（@scene-change）: TyranoScript に一つのタグは無いので、同じ並びの @mask・@chara-hide-all・@bg・@mask-off（背景を省けば @bg の代わりに
 *   暗転したまま置く時間の @wait）に開く。暗転したまま置く時間（hold）は、覆っている間の @bg の fade にする
 * - CG として出した画像の解放: @bg などで一覧の CG を出すと Liminalia は解放するが、TyranoScript の [bg] は解放しないので、
 *   同じ並びに @cg-unlock が無ければ、出した行のすぐ後ろに @cg-unlock の行を足す（基準と今の .lim の両方に。[tb_cg] になる）。
 *   足すのは liminalia.json の extra.cg に書いた画像だけ（extra.cgAuto で足した CG は TyranoBuilder の CG の登録に無いので、解放しても見られない）
 */
export interface LowerOptions {
  registry: Registry;
  speakers: Iterable<string>;
  /** おまけの一覧（liminalia.json の extra）。CG の一覧が無ければ解放の行は足さない。 */
  extra?: ExtraConfig | undefined;
  /** コマンドの既定値（liminalia.json の commandDefaults）。 */
  commandDefaults?: CommandDefaults | undefined;
  /** @define のマクロの仕様（@liminalia/lang の projectMacros）。マクロの呼び出しにも既定値を書く。 */
  macros?: ReadonlyMap<string, CommandSpec> | undefined;
  /** コマンドの既定値を書くか（今の .lim だけ）。 */
  defaults?: boolean;
  /** CG として出した画像の解放を @cg-unlock の行にするか。 */
  cgUnlocks?: boolean;
}

export interface Lowered {
  text: string;
  /** 直した各行（添字 = 行番号 - 1）の、元の行番号。足した行は、足すもとになった行。 */
  origin: number[];
  /** 直した各行が足した行か。 */
  added: boolean[];
}

/** 文字列の値の .lim の書き方（空白や " を含むもの、ほかの型に読めるものは "…"）。 */
export function printValue(value: string): string {
  const plain = parseLiteral(value);
  return plain.kind === "string" && value !== "" && !/[\s"\\]/.test(value) && !value.startsWith("(") ? value : JSON.stringify(value);
}

/** 既定値の .lim の書き方。文字列の型のパラメータはほかの型に読めないように、ほかは書いたまま（空白を含めば "…"）。 */
function printDefault(value: string, type: ParamType): string {
  const text = ["string", "asset", "cast", "appearance", "variant", "position", "enum", "target", "variable"].includes(type.kind);
  return text ? printValue(value) : /[\s"]/.test(value) ? JSON.stringify(value) : value;
}

export function lowerLim(text: string, file: string, o: LowerOptions): Lowered {
  let doc: Lowered = { text, origin: text.split("\n").map((_, i) => i + 1), added: text.split("\n").map(() => false) };
  if (o.defaults && o.commandDefaults) doc = withDefaults(doc, o.registry, o.speakers, o.commandDefaults, o.macros);
  doc = expandScenes(doc, o.registry, o.speakers);
  doc = expandLines(doc, o.speakers, "chara", (args) => expandSolo(args, o.registry));
  const match = o.cgUnlocks ? cgMatcher({ cg: o.extra?.cg ?? [] }) : null;
  if (match) {
    const script = parse(doc.text, file, { speakers: o.speakers });
    doc = insertAfter(doc, implicitUnlocks(script.body, match, o.registry));
    doc = inlineUnlocks(doc, match, o.registry);
  }
  return doc;
}

/**
 * 本文の中のコマンド（{@bg …}）で一覧の CG を出したのに、同じ行に同じ画像の {@cg-unlock …} が無ければ、その直後に足す
 * （行の数は変えない。基準と今の .lim の両方に同じく足すので、要らない {@cg-unlock} を消しても .ks の [tb_cg] は残る）。
 */
function inlineUnlocks(doc: Lowered, match: CgMatcher, registry: Registry): Lowered {
  const rows = doc.text.split("\n").map((row) => {
    const head = row.trimStart();
    if (head === "" || head.startsWith("@") || head.startsWith("#") || head.startsWith("//") || !row.includes("{@")) return row;
    let next = row;
    for (const m of row.matchAll(/\{@([\w-]+)([^{}]*)\}/g)) {
      if (m[1] === "cg-unlock") continue;
      for (const shown of cgShown(registry.get(m[1]!), parseArgs(m[2]!.trim(), 1).args).shown) {
        if (!match(shown.folder, shown.image)) continue;
        const image = printValue(shown.image);
        if (next.includes(`{@cg-unlock ${image}`)) continue;
        next = next.replace(m[0], `${m[0]}{@cg-unlock ${image}${shown.folder === "bgimage" ? "" : ` folder=${shown.folder}`}}`);
      }
    }
    return next;
  });
  return { ...doc, text: rows.join("\n") };
}

/** 行の後ろに行を足す（行番号 → 足す行。字下げはその行に合わせる）。 */
function insertAfter(doc: Lowered, after: ReadonlyMap<number, readonly string[]>): Lowered {
  if (after.size === 0) return doc;
  const out: Lowered = { text: "", origin: [], added: [] };
  const rows: string[] = [];
  doc.text.split("\n").forEach((row, i) => {
    rows.push(row);
    out.origin.push(doc.origin[i]!);
    out.added.push(doc.added[i]!);
    const extra = after.get(i + 1);
    if (!extra) return;
    const indent = /^[ \t]*/.exec(row)![0];
    for (const line of extra) {
      rows.push(`${indent}${line}`);
      out.origin.push(doc.origin[i]!);
      out.added.push(true);
    }
  });
  out.text = rows.join("\n");
  return out;
}

/** 書いていないパラメータの名前（名前なしで書いたものも数える）。 */
function missing(args: readonly Argument[], positional: readonly string[], names: readonly string[]): string[] {
  const given = new Set<string>();
  let pos = 0;
  for (const a of args) {
    const key = a.key ?? positional[pos++];
    if (key) given.add(key);
  }
  return names.filter((n) => !given.has(n));
}

/** コマンドの行と本文の中のコマンドに、作品の既定値を書く（行の数は変えない）。 */
function withDefaults(doc: Lowered, registry: Registry, speakers: Iterable<string>, defaults: CommandDefaults, macros?: ReadonlyMap<string, CommandSpec>): Lowered {
  const specOf = (name: string) => registry.get(name) ?? macros?.get(name);
  /** コマンドの、作品の既定値で決めたパラメータ（名前 → .lim の値）。 */
  const own = new Map<string, [string, string][]>();
  const ownOf = (name: string): [string, string][] => {
    let hit = own.get(name);
    if (hit) return hit;
    const spec = specOf(name);
    const applied = spec ? applyCommandDefaults(spec, defaults) : null;
    hit = applied ? Object.entries(applied.params).flatMap(([n, p]) => (p.projectDefault && p.default !== undefined ? [[n, p.default] as [string, string]] : [])) : [];
    own.set(name, hit);
    return hit;
  };
  /** 書き足すパラメータ（名前と .lim の字面）。 */
  const extra = (name: string, args: readonly Argument[]): [string, string][] => {
    const values = ownOf(name);
    if (values.length === 0) return [];
    const spec = specOf(name)!;
    const lacking = new Set(missing(normalizeBooleanArgs(spec, args), spec.positional, values.map(([n]) => n)));
    return values.filter(([n]) => lacking.has(n) && !(name === "scene-change" && n === "hide-at" && args.some((a) => a.key === "hide-chara-at"))).map(([n, v]) => [n, printDefault(v, spec.params[n]!.type)]);
  };
  const rows = doc.text.split("\n");
  const lines = readLimLines(doc.text, speakers);
  lines.forEach((line, i) => {
    if (line.kind === "command") {
      const add = extra(line.name, line.args);
      if (add.length > 0) rows[i] = `${rows[i]!.replace(/[ \t]+$/, "")}${add.map(([n, v]) => ` ${n}=${v}`).join("")}`;
      return;
    }
    if (line.kind !== "text") return;
    let changed = false;
    const visit = (nodes: Inline[]) => {
      for (const n of nodes) {
        if (n.kind === "command") {
          const add = extra(n.name, n.args);
          if (add.length > 0) {
            n.args = [...n.args, ...add.map(([key, v]): Argument => ({ key, value: parseArgs(v, 1).args[0]!.value, column: 0 }))];
            changed = true;
          }
        } else if ("children" in n) visit(n.children);
      }
    };
    visit(line.content);
    if (changed) rows[i] = `${/^[ \t]*/.exec(rows[i]!)![0]}${line.speaker}${printInline(line.content)}`;
  });
  return { text: rows.join("\n"), origin: doc.origin, added: doc.added };
}

/** 名前で引ける引数（名前なしのものも仕様の名前で）。 */
function named(args: readonly Argument[], positional: readonly string[]): Map<string, Argument> {
  const out = new Map<string, Argument>();
  let pos = 0;
  for (const a of args) {
    const key = a.key ?? positional[pos++];
    if (key) out.set(key, a);
  }
  return out;
}

/**
 * @scene-change を同じ動きのコマンドの並びにする（書いていないパラメータは @scene-change の仕様の既定値。作品の既定値は先に書いてある）。
 * 返すのは、コマンドの名前と引数の字面の並び。
 */
export function expandScene(args: readonly Argument[], registry: Registry): { name: string; args: string }[] | null {
  const spec = registry.get("scene-change");
  const given = named(spec ? normalizeBooleanArgs(spec, args) : args, spec?.positional ?? ["image"]);
  /** 値の字面（書いていなければ仕様の既定値）。 */
  const text = (name: string): string | null => {
    const a = given.get(name);
    if (a) return printLiteral(a.value);
    return spec?.params[name]?.default ?? null;
  };
  const isZero = (v: string | null) => v === null || /^0+(\.0+)?(ms|s)$/.test(v);
  const time = text("time") ?? "1s";
  const out = text("fade-out") ?? time;
  const into = text("fade-in") ?? time;
  const hold = text("hold");
  const color = text("color");
  const image = given.get("image");
  const hideChara = text("hide-chara") ?? "true";
  const hideWindow = text("hide-window") ?? "true";
  const windowAt = text("hide-window-at") ?? "start";
  if ((hideChara !== "true" && hideChara !== "false") || (hideWindow !== "true" && hideWindow !== "false")) return null;
  if (hideWindow === "true" && windowAt !== "covered" && given.has("hide-window-at")) return null;
  const hideAt = text("hide-at") ?? text("hide-chara-at") ?? "covered";
  if (hideAt !== "start" && hideAt !== "covered") return null;
  const hideWho = text("hide-who");
  const hideFade = text("hide-fade");
  const hide = { name: hideWho === null ? "chara-hide-all" : "chara-hide", args: `${hideWho ?? ""}${isZero(hideFade) ? "" : ` time=${hideFade}`}`.trim() };
  const lines: { name: string; args: string }[] = [];
  if (hideChara === "true" && hideAt === "start") lines.push(hide);
  lines.push({ name: "mask", args: `time=${out}${color && color.toLowerCase() !== "#000000" && color.toLowerCase() !== "#000" ? ` color=${color}` : ""}` });
  // 暗転の後ろの BGM（bgm を書けば替える。stop-bgm=true なら止める）
  const bgm = given.get("bgm");
  const bgmFade = text("bgm-fade");
  const withFade = isZero(bgmFade) ? "" : ` time=${bgmFade}`;
  const bgmVolume = text("bgm-volume");
  const withVolume = bgmVolume === null || bgmVolume === "100" ? "" : ` volume=${bgmVolume}`;
  if (bgm) lines.push({ name: "bgm", args: `${printLiteral(bgm.value)}${withVolume}${withFade}` });
  else if (text("stop-bgm") === "true") lines.push({ name: "stop-bgm", args: withFade.trim() });
  if (hideChara === "true" && hideAt === "covered") lines.push(hide);
  if (image) lines.push({ name: "bg", args: `${printLiteral(image.value)}${isZero(hold) ? "" : ` time=${hold}`}` });
  else if (!isZero(hold)) lines.push({ name: "wait", args: hold! });
  lines.push({ name: "mask-off", args: `time=${into}` });
  return lines;
}

/**
 * solo=true の @chara を、@chara-hide-all と solo を外した @chara の二つにする（TyranoScript で同じく、ほかの立ち絵を消してから出す）。
 * .ks では本人も一度消えてから出し直す（表示中の人物の表情を替えるだけの行でも）。solo=false か書いていなければ null。
 */
export function expandSolo(args: readonly Argument[], registry: Registry): { name: string; args: string }[] | null {
  const spec = registry.get("chara");
  const resolved = spec ? normalizeBooleanArgs(spec, args) : args;
  const solo = resolved.find((a) => a.key === "solo");
  const clear = resolved.find((a) => a.key === "clear");
  if (!clear && (!solo || solo.value.kind !== "bool" || !solo.value.value)) return null;
  const rest = resolved.filter((a) => a !== solo && a !== clear);
  const time = named(rest, spec?.positional ?? ["who", "variant"]).get("time");
  return [
    { name: "chara-hide-all", args: clear ? `time=${printLiteral(clear.value)}` : time ? `time=${printLiteral(time.value)}` : "" },
    { name: "chara", args: rest.map((a) => `${a.key === null ? "" : `${a.key}=`}${printLiteral(a.value)}`).join(" ") },
  ];
}

/** @scene-change の行（と本文の中の @scene-change）を、同じ動きのコマンドの並びに開く。開いた行の元の行は @scene-change の行。 */
function expandScenes(doc: Lowered, registry: Registry, speakers: Iterable<string>): Lowered {
  return expandLines(doc, speakers, "scene-change", (args) => expandScene(args, registry));
}

/** 行のコマンド（と本文の中のコマンド）name を、expand が返すコマンドの並びに開く（null ならそのまま）。開いた行の元の行はその行。 */
function expandLines(doc: Lowered, speakers: Iterable<string>, name: string, expand: (args: readonly Argument[]) => { name: string; args: string }[] | null): Lowered {
  if (!new RegExp(`@${name}\\b`).test(doc.text)) return doc;
  const rows = doc.text.split("\n");
  const lines = readLimLines(doc.text, speakers);
  const out: Lowered = { text: "", origin: [], added: [] };
  const result: string[] = [];
  rows.forEach((row, i) => {
    const line = lines[i];
    const push = (text: string) => {
      result.push(text);
      out.origin.push(doc.origin[i]!);
      out.added.push(doc.added[i]!);
    };
    const indent = /^[ \t]*/.exec(row)![0];
    const expanded = line?.kind === "command" && line.name === name ? expand(line.args) : null;
    if (expanded) {
      // 行の if=(式) は、開いたどの行にも付ける（.ks ではそれぞれの cond= になる）
      const cond = line?.kind === "command" && line.cond !== undefined ? ` if=(${line.cond})` : "";
      for (const c of expanded) push(`${indent}@${c.name}${c.args ? ` ${c.args}` : ""}${cond}`);
      return;
    }
    if (line?.kind === "text" && row.includes(`@${name}`)) {
      let changed = false;
      const visit = (nodes: Inline[]): Inline[] =>
        nodes.flatMap((n): Inline[] => {
          const parts = n.kind === "command" && n.name === name ? expand(n.args) : null;
          if (parts) {
            changed = true;
            return parts.map((c) => ({ kind: "command", name: c.name, args: parseArgs(c.args, 1).args }));
          }
          if ("children" in n) return [{ ...n, children: visit(n.children) } as Inline];
          return [n];
        });
      const content = visit(line.content);
      if (changed) return push(`${indent}${line.speaker}${printInline(content)}`);
    }
    push(row);
  });
  out.text = result.join("\n");
  return out;
}

/**
 * CG として出したのに、同じ並び（あいだにコマンドしか無い行の続き）に同じ画像の @cg-unlock が無いもの。
 * 出した行の番号 → その後ろに足す @cg-unlock の行。
 */
function implicitUnlocks(body: readonly Statement[], match: CgMatcher, registry: Registry): Map<number, string[]> {
  const out = new Map<number, string[]>();
  const visit = (list: readonly Statement[]) => {
    let run: Extract<Statement, { kind: "command" }>[] = [];
    const flush = () => {
      const present = new Set<string>();
      for (const s of run) {
        if (s.name !== "cg-unlock") continue;
        const u = unlockOf(s.args);
        if (u && u !== "dynamic") present.add(`${u.folder}/${u.image}`);
      }
      for (const s of run) {
        for (const shown of cgShown(registry.get(s.name), s.args).shown) {
          const key = `${shown.folder}/${shown.image}`;
          if (present.has(key) || !match(shown.folder, shown.image)) continue;
          present.add(key);
          const line = `@cg-unlock ${printValue(shown.image)}${shown.folder === "bgimage" ? "" : ` folder=${shown.folder}`}`;
          out.set(s.line, [...(out.get(s.line) ?? []), line]);
        }
      }
      run = [];
    };
    for (const s of list) {
      if (s.kind === "command") {
        run.push(s);
        continue;
      }
      flush();
      if (s.kind === "if") for (const b of s.branches) visit(b.body);
      if (s.kind === "define") visit(s.body);
    }
    flush();
  };
  visit(body);
  return out;
}

/**
 * 比べるときに見ない行（行番号）。表示したときに解放されるので要らない @cg-unlock（取り込みは書き出さないので、
 * 今の .lim に残っていても、取り込み直したものと同じとみなす）。
 */
export function ignoredLines(text: string, file: string, o: Pick<LowerOptions, "registry" | "speakers" | "extra">): Set<number> {
  if (!cgMatcher(o.extra)) return new Set();
  const script = parse(text, file, { speakers: o.speakers });
  // 本文の中の {@cg-unlock …}（直し方を持たないもの）は行ごと見ないわけにいかないので外す
  return new Set(redundantCgUnlocks([[file, script]], o.extra, o.registry).flatMap((d) => (d.fix ? [d.line] : [])));
}

/**
 * 足した @cg-unlock を [tb_cg] に戻すときの手本。id は extra.cg のその画像の id（TyranoBuilder の CG の登録の名前。取り込みは id を見ないので、
 * 手本のタグの id を引き継ぐと別の CG を解放してしまう）。今あるタグの書き換えと、id の分からない画像は手本に任せる（null）。
 */
export function tbCgRule(extra: ExtraConfig | undefined): BackportRule {
  return (line, original) => {
    if (original !== null) return null;
    const u = unlockOf(parseArgs(line.replace(/^@cg-unlock\s*/, ""), 1).args);
    if (!u || u === "dynamic") return null;
    const entry = (extra?.cg ?? []).find((c) => (c.folder ?? "bgimage") === u.folder && Array.isArray(c.images) && c.images.includes(u.image));
    return entry ? `[tb_cg  id="${entry.id}"  storage="${u.image}"  ]` : null;
  };
}
