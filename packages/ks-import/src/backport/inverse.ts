import { normalizeBooleanArgs, parseArgs, type Argument, type Registry } from "@liminalia/lang";
import { convert, type ConvertOptions } from "../convert.ts";
import type { TagMapping } from "../mapping.ts";
import { parseTag } from "../lexer.ts";
import { editTagBody, tagBody, tagName, wrapTag } from "./ks-line.ts";
import { commandKey, literalKey, normalizeLimLine, readLimLines, type LimLine } from "./lim-line.ts";

/**
 * .lim の命令の行を .ks のタグに戻す（書き戻しの命令の部分）。
 *
 * 取り込みの変換（組み込みの変換・変換表・作品の取り込み設定）は関数なので、式で逆に解くのではなく、
 * 手本のタグ（元のタグ、無ければ同じ命令になった近くのタグ）の引数を一つずつ書き換えて取り込みの変換に通し、
 * 目当ての .lim の行に近づく書き換えを選ぶことを繰り返す。最後に変換し直した結果が目当ての行と意味で同じなら成功。
 * 書き換えの候補（.ks の引数名と値）は、変換表（mappings の params）・組み込みの変換の引数名（BUILTIN_KEYS）・
 * 手本のタグにある引数から作る。逆に解けない作品固有の変換は、取り込み設定の backport（逆向きの変換）で手本を渡せる。
 */

/**
 * 取り込み設定（TyranoImportProfile）の逆向きの変換。.lim の命令の行（字下げなし）と、元のタグ（書き換えのときだけ。
 * `[…]` の字面）を受け取り、書き戻す .ks のタグの字面を返す。当てはまらなければ null。返したタグは取り込みの変換に通して確かめ、
 * 違っていれば手本として引数の書き換えを続ける。
 */
export type BackportRule = (line: string, original: string | null) => string | null;

export interface InverterContext {
  /** 書き戻す .ks（data/scenario からのパス）。 */
  file: string;
  convertOptions: ConvertOptions;
  registry: Registry;
  mappings: readonly TagMapping[];
  speakers: Iterable<string>;
  /** 命令名 → 逆向きの変換。 */
  rules?: Readonly<Record<string, BackportRule>>;
}

/** 組み込みの変換（convert.ts の switch）の、.lim の命令 → それになる .ks のタグ。 */
export const BUILTIN_TAGS: Readonly<Record<string, readonly string[]>> = {
  bg: ["bg"],
  chara: ["chara_show", "chara_mod"],
  "chara-hide": ["chara_hide"],
  "chara-hide-all": ["chara_hide_all"],
  clear: ["cm"],
  mask: ["mask"],
  "mask-off": ["mask_off"],
  window: ["tb_show_message_window", "tb_hide_message_window"],
  bgm: ["playbgm"],
  se: ["playse"],
  "stop-bgm": ["stopbgm"],
  "stop-se": ["stopse"],
  wait: ["wait"],
  quake: ["quake"],
  camera: ["camera"],
  "reset-camera": ["reset_camera"],
  "cg-unlock": ["tb_cg"],
  "wait-click": ["p"],
  "text-speed": ["delay"],
  "text-speed-reset": ["resetdelay"],
  stop: ["s"],
  return: ["return"],
  "open-screen": ["showsave", "showload", "showlog", "showmenu"],
  "menu-button": ["showmenubutton", "hidemenubutton"],
  skip: ["skipstart", "skipstop"],
  auto: ["autostart", "autostop"],
  backlog: ["nolog", "endnolog"],
  autosave: ["autosave"],
  autoload: ["autoload"],
  "pause-bgm": ["pausebgm"],
  "resume-bgm": ["resumebgm"],
  "wait-bgm": ["wbgm"],
  "wait-se": ["wse"],
  peek: ["hidemessage"],
};

/** 組み込みの変換で、.lim の引数の値を出すのに .ks の別の引数も要るもの（.lim の命令 → 引数 → 一緒に書く .ks の引数）。 */
export const BUILTIN_FLAGS: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>> = {
  bgm: { time: { fadein: "true" } },
  se: { time: { fadein: "true" } },
  "stop-bgm": { time: { fadeout: "true" } },
  "stop-se": { time: { fadeout: "true" } },
};

/** 組み込みの変換の、.lim の引数名 → .ks の引数名（名前の - を _ にしただけでは届かないもの）。 */
export const BUILTIN_KEYS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  bg: { image: ["storage"], time: ["time"] },
  chara: { who: ["name"], variant: ["face", "storage", "variant"], at: ["position"], time: ["time"], flip: ["reflect"], x: ["left"], y: ["top"], z: ["zindex"] },
  "chara-hide": { who: ["name"], time: ["time"] },
  "chara-hide-all": { time: ["time"] },
  mask: { time: ["time"], method: ["effect"] },
  "mask-off": { time: ["time"], method: ["effect"] },
  bgm: { file: ["storage"], time: ["time"] },
  se: { file: ["storage"], channel: ["buf"], time: ["time"] },
  "stop-bgm": { time: ["time"] },
  "stop-se": { channel: ["buf"], time: ["time"] },
  wait: { time: ["time"] },
  quake: { horizontal: ["hmax"], vertical: ["vmax"] },
  camera: { ease: ["ease_type"] },
  "reset-camera": { ease: ["ease_type"] },
  "cg-unlock": { image: ["storage"] },
  "text-speed": { "per-char": ["speed"] },
};

type Edits = Record<string, string | null>;
interface Proposal {
  edits: Edits;
  /** タグ名を替える（同じ命令になる別のタグ）。 */
  rename?: string;
}

export class TagInverter {
  private cache = new Map<string, LimLine[]>();
  private speakers: string[];

  constructor(private ctx: InverterContext) {
    this.speakers = [...ctx.speakers];
  }

  /** タグの字面（`[…]` か `@…`）一つを、取り込みと同じ設定で変換した .lim の行。 */
  convertPiece(piece: string): LimLine[] {
    const hit = this.cache.get(piece);
    if (hit) return hit;
    let lines: LimLine[];
    try {
      const text = convert(`${piece}\n`, this.ctx.file, this.ctx.convertOptions).text;
      lines = readLimLines(text, this.speakers).filter((l) => l.kind !== "blank" && l.kind !== "use");
    } catch {
      lines = [{ kind: "comment", text: "変換できないタグ" }];
    }
    this.cache.set(piece, lines);
    return lines;
  }

  /**
   * target（.lim の行の並び。多くは一行）になるタグを探す。templates は手本のタグの字面（先にあるものほど優先）。
   * 見つからなければ null。
   */
  invert(templates: readonly string[], target: readonly LimLine[], original: string | null = null): string | null {
    const first = target.find((l) => l.kind !== "blank" && l.kind !== "comment" && l.kind !== "choice" && l.kind !== "if");
    const tried = new Set<string>();
    const queue: string[] = [];
    const name = first?.kind === "command" ? first.name : first?.kind === "jump" ? first.name : first?.kind === "set" ? "set" : null;
    const rule = name ? this.ctx.rules?.[name] : undefined;
    if (rule && first) {
      const made = rule(lineText(first), original);
      if (made) queue.push(made);
    }
    queue.push(...templates);
    // 手本が無ければ、その命令になるタグを空の引数から
    if (name) for (const tag of this.tagsFor(name)) queue.push(`[${tag}]`);
    for (const t of queue) {
      if (tried.has(t)) continue;
      tried.add(t);
      if (tried.size > 8) break;
      const found = this.search(t, target);
      if (found !== null) return found;
    }
    return null;
  }

  /** 命令 command になる .ks のタグ（変換表と組み込みの変換）。 */
  tagsFor(command: string): string[] {
    const fromMappings = this.ctx.mappings.filter((m) => m.command === command && !m.defer).flatMap((m) => m.tags);
    return [...new Set([...fromMappings, ...(BUILTIN_TAGS[command] ?? []), ...(command === "set" ? ["eval"] : [])])];
  }

  private distance(piece: string, target: readonly LimLine[]): number {
    return linesDistance(this.convertPiece(piece), target, this.ctx.registry);
  }

  private search(template: string, target: readonly LimLine[]): string | null {
    let current = template;
    let d = this.distance(current, target);
    for (let round = 0; round < 12 && d > 0; round++) {
      let best: string | null = null;
      let bestD = d;
      for (const p of this.proposals(current, target)) {
        const cand = applyProposal(current, p);
        if (cand === current) continue;
        const dc = this.distance(cand, target);
        if (dc < bestD) {
          best = cand;
          bestD = dc;
        }
      }
      // 一つずつでは近づかないとき（二つの引数を一緒に変えないと値が出ないもの）は、二つを組み合わせて試す
      if (best === null) {
        const props = this.proposals(current, target).slice(0, 80);
        for (let i = 0; i < props.length && bestD > 0; i++) {
          for (let j = i + 1; j < props.length; j++) {
            const a = props[i]!;
            const b = props[j]!;
            if (Object.keys(a.edits).some((k) => k in b.edits) || (a.rename && b.rename)) continue;
            const cand = applyProposal(applyProposal(current, a), b);
            if (cand === current) continue;
            const dc = this.distance(cand, target);
            if (dc < bestD) {
              best = cand;
              bestD = dc;
            }
          }
        }
      }
      if (best === null) break;
      current = best;
      d = bestD;
    }
    return d === 0 ? current : null;
  }

  /** 今の変換結果と目当ての行の違いから、引数の書き換えの候補を作る。 */
  private proposals(piece: string, target: readonly LimLine[]): Proposal[] {
    const body = tagBody(piece);
    const tag = tagName(body);
    const pm = parseTag(body, 0).pm;
    const out = this.convertPiece(piece);
    const props: Proposal[] = [];
    const add = (edits: Edits, rename?: string) => props.push(rename ? { edits, rename } : { edits });
    const templateKeys = Object.keys(pm).filter((k) => k !== "cond");
    const frame = (l: LimLine) => l.kind === "if" || l.kind === "end" || l.kind === "choice" || l.kind === "blank" || l.kind === "comment";
    const targetBody = target.filter((l) => !frame(l));
    const outBody = out.filter((l) => !frame(l));

    // cond（タグの前に @if、後に @end が出る）
    const wrap = target[0]?.kind === "if" ? target[0] : null;
    if (wrap?.kind === "if") add({ cond: jsExpression(wrap.expr) });
    else if (out[0]?.kind === "if") add({ cond: null });

    // 命令の名前が違えば、同じ命令になる別のタグ
    const t0 = targetBody[0];
    const o0 = outBody[0];
    const commandName = (l: LimLine | undefined) => (l?.kind === "command" ? l.name : l?.kind === "jump" ? l.name : l?.kind === "set" ? "set" : l?.kind ?? "");
    if (t0 && commandName(t0) !== commandName(o0)) {
      for (const other of this.tagsFor(commandName(t0))) if (other !== tag) add({}, other);
    }

    if (t0?.kind === "set") {
      const sets = targetBody.filter((l): l is Extract<LimLine, { kind: "set" }> => l.kind === "set");
      const js = sets.map((s) => jsAssignment(s.rest)).filter((s): s is string => s !== null);
      if (js.length === sets.length) {
        // TyranoBuilder の [tb_eval] は、編集画面の欄（name・val）も同じ値にしておく（先に試す）
        const simple = sets.length === 1 ? /^f\.([\p{L}\p{N}_$]+)=(?:'((?:[^'\\]|\\.)*)'|(-?\d+(?:\.\d+)?|true|false))$/u.exec(js[0]!) : null;
        if (simple && pm.name !== undefined && pm.val !== undefined) {
          const val = simple[2] ?? simple[3]!;
          // val は編集画面の欄の値（引用符で囲まない中身）。\ を含むものは引数に書けない（書き逃しが閉じる " を食べる）ので、
          // 書けないときは古い val を残さず消す（exp と食い違う欄を残さない）
          add({ exp: js[0]!, name: simple[1]!, val: val.includes("\\") ? null : val });
        } else if (sets.length === 1 && pm.name !== undefined && pm.val !== undefined) {
          // 欄に書ける形（'…' や数）でない代入（"…" や String.fromCodePoint）も、古い name・val を残さない
          const name = /^f\.([\p{L}\p{N}_$]+)=/u.exec(js[0]!)?.[1];
          if (name !== undefined) add({ exp: js[0]!, name, val: null });
        }
        add({ exp: js.join(";") });
      }
    }
    if (t0?.kind === "jump") for (const edits of targetEdits(t0.target, pm, this.ctx.file)) add(edits);
    if (t0?.kind === "option") {
      const plain = optionText(t0);
      if (plain !== null) for (const key of ["text", "hint"]) if (key in pm || key === "text") add({ [key]: plain });
      for (const edits of targetEdits(t0.target, pm, this.ctx.file)) add(edits);
      const o = o0?.kind === "option" ? o0 : null;
      // 出す条件（if=）はタグの cond
      const cond = optionCond(t0);
      if (cond !== undefined) add({ cond });
      else if (o && optionCond(o) !== undefined) add({ cond: null });
      const optionKeys: Record<string, string[]> = { image: ["graphic"], hover: ["enterimg"], x: ["x"], y: ["y"], width: ["width"], height: ["height"] };
      const look = (args: readonly Argument[]) => args.filter((a) => a.key !== "if");
      this.argProposals(add, look(t0.args), look(o?.args ?? []), undefined, (k) => optionKeys[k] ?? [k], templateKeys);
    }
    if (t0?.kind === "command") {
      const spec = this.ctx.registry.get(t0.name);
      const mapping = this.ctx.mappings.findLast((m) => m.command === t0.name && m.tags.includes(tag));
      const keysFor = (limKey: string) => {
        const mapped = mapping?.params?.[limKey];
        return [...(mapped ? [mapped] : []), ...(BUILTIN_KEYS[t0.name]?.[limKey] ?? []), limKey.replace(/-/g, "_")];
      };
      const o = o0?.kind === "command" && o0.name === t0.name ? o0 : null;
      const targetArgs = spec ? normalizeBooleanArgs(spec, t0.args) : t0.args;
      const originalArgs = spec ? normalizeBooleanArgs(spec, o?.args ?? []) : (o?.args ?? []);
      this.argProposals(add, targetArgs, originalArgs, spec?.positional, keysFor, templateKeys, spec ? (k) => spec.params[k]?.default : undefined);
      for (const [limKey, flags] of Object.entries(BUILTIN_FLAGS[t0.name] ?? {})) {
        const given = targetArgs.some((a) => a.key === limKey);
        for (const [k, v] of Object.entries(flags)) add({ [k]: given ? v : null });
      }
    }
    return props;
  }

  private argProposals(
    add: (edits: Edits) => void,
    target: readonly Argument[],
    out: readonly Argument[],
    positionalNames: readonly string[] | undefined,
    keysFor: (limKey: string) => string[],
    templateKeys: readonly string[],
    defaultOf?: (limKey: string) => string | undefined,
  ): void {
    const tPos = target.filter((a) => a.key === null);
    const oPos = out.filter((a) => a.key === null);
    const keyOf = (i: number) => positionalNames?.[i];
    const candidates = (limKey: string | undefined) => [...new Set([...(limKey ? keysFor(limKey) : []), ...templateKeys])];
    for (let i = 0; i < Math.max(tPos.length, oPos.length); i++) {
      const t = tPos[i];
      const o = oPos[i];
      if (t && o && literalKey(t.value) === literalKey(o.value)) continue;
      for (const key of candidates(keyOf(i))) {
        if (t) for (const v of ksValues(printValue(t))) add({ [key]: v });
        else {
          add({ [key]: null });
          add({ [key]: "" });
        }
      }
    }
    const tNamed = new Map(target.filter((a) => a.key !== null).map((a) => [a.key!, a]));
    const oNamed = new Map(out.filter((a) => a.key !== null).map((a) => [a.key!, a]));
    for (const key of new Set([...tNamed.keys(), ...oNamed.keys()])) {
      const t = tNamed.get(key);
      const o = oNamed.get(key);
      if (t && o && literalKey(t.value) === literalKey(o.value)) continue;
      for (const ks of candidates(key)) {
        if (t) {
          for (const v of ksValues(printValue(t))) add({ [ks]: v });
        } else {
          add({ [ks]: null });
          const def = defaultOf?.(key);
          if (def !== undefined) for (const v of ksValues(def)) add({ [ks]: v });
          add({ [ks]: "" });
        }
      }
    }
  }
}

function printValue(a: Argument): string {
  const v = a.value;
  switch (v.kind) {
    case "string":
      return v.quoted ? JSON.stringify(v.value) : v.value;
    case "number":
      return String(v.value);
    case "duration":
      return v.source;
    case "bool":
      return String(v.value);
    case "color":
      return v.value;
    case "expr":
      return `(${v.source})`;
  }
}

function applyProposal(piece: string, p: Proposal): string {
  const at = piece.trim().startsWith("@");
  let body = tagBody(piece);
  if (p.rename) body = body.replace(/^(\s*)\S+/, `$1${p.rename}`);
  return wrapTag(editTagBody(body, p.edits), at);
}

/** .lim の値の字面から、.ks の値の候補。 */
export function ksValues(text: string): string[] {
  const out: string[] = [];
  if (text.startsWith("(") && text.endsWith(")")) {
    out.push(`&${jsExpression(text.slice(1, -1))}`);
    return out;
  }
  const lit = parseArgs(text, 1).args[0]?.value;
  if (lit?.kind === "string") out.push(lit.value);
  if (lit?.kind === "duration") out.push(String(lit.ms));
  if (lit?.kind === "color") out.push(`0x${lit.value.slice(1)}`, lit.value);
  const layer = /^fg(\d+)$/.exec(text);
  if (layer) out.push(layer[1]!);
  out.push(text);
  return [...new Set(out)];
}

/** .lim の飛び先（`ファイル#ラベル`）を .ks の storage・target にする候補。元のタグの書き方（.ks を付けるか）に合わせる。 */
export function targetEdits(target: string, pm: Record<string, string>, file: string): Edits[] {
  const m = /^([^#]*)(?:#(.*))?$/.exec(target.trim());
  if (!m) return [];
  const f = m[1]!;
  const label = m[2];
  const withKs = pm.storage === undefined || pm.storage === "" || pm.storage.endsWith(".ks");
  // 手本のタグにある引数は、空にしても残す（TyranoBuilder は storage・target を必ず書く）
  const storage = f === "" ? (pm.storage !== undefined ? "" : null) : withKs ? `${f}.ks` : f;
  const t = label === undefined ? (pm.target !== undefined ? "" : null) : `*${label}`;
  const self = file.replace(/\.ks$/, "");
  const out: Edits[] = [{ storage, target: t }];
  if (f === self && !pm.storage) out.push({ storage: null, target: t });
  return out;
}

/** 選択肢の行の出す条件（if=(式)）を .ks の cond の式にしたもの。条件が無ければ undefined。 */
export function optionCond(line: Extract<LimLine, { kind: "option" }>): string | undefined {
  const cond = line.args.find((a) => a.key === "if");
  if (!cond) return undefined;
  return cond.value.kind === "expr" ? jsExpression(cond.value.source) : printValue(cond);
}

/** 選択肢の文（ルビや命令を含まないものだけ .ks の text に戻せる）。 */
function optionText(line: Extract<LimLine, { kind: "option" }>): string | null {
  if (!line.content.every((n) => n.kind === "text")) return null;
  return line.content.map((n) => (n.kind === "text" ? n.text : "")).join("");
}

const ROOTS: Record<string, string> = { game: "f", system: "sf", temp: "tf" };

/**
 * .lim の式を TyranoScript の JS の式にする（convertJsExpression の逆）。game / system / temp を f / sf / tf に、
 * 文字列を '…' にする（.ks の引数は "…" で囲むので）。
 */
export function jsExpression(expr: string): string {
  let out = "";
  let i = 0;
  while (i < expr.length) {
    const c = expr[i]!;
    if (c === '"') {
      let value = "";
      let j = i + 1;
      for (; j < expr.length && expr[j] !== '"'; j++) {
        if (expr[j] === "\\") {
          const e = expr[j + 1] ?? "";
          value += e === "n" ? "\n" : e; // .lim の文字列の書き逃し（\n は改行、ほかはその字）と同じに読む
          j++;
        } else value += expr[j];
      }
      // ' " ` [ ] と、書き逃しの要る ' " \ 改行 を両方含む文字列は String.fromCodePoint にする。タグの外側の読み取り
      // （lex）は書き逃しを知らず " ' ` をただの開閉として数えるので、"…" の文字列の中の ' や ] でタグがずれ、
      // 中の \" で " の数がずれて引用符が閉じたままになる。fromCodePoint は引用符も \ も出ないので、どの読み方でも壊れない。
      if (/['"`\[\]]/.test(value) && /[\\'"\n]/.test(value)) {
        const call = `String.fromCodePoint(${[...value].map((ch) => ch.codePointAt(0)).join(",")})`;
        // 辞書の見出し（{ 'x': 1 } や , 'x': 1）は裸の呼び出しでは書けないので […] にする（JS の算出した見出し）
        const prev = out.trimEnd().at(-1);
        const isKey = (prev === "{" || prev === ",") && /^\s*:/.test(expr.slice(j + 1));
        out += isKey ? `[${call}]` : call;
      } else if (/[\\'"\n]/.test(value)) {
        // 書き逃しの要る文字は "…" の文字列にする（'…' だと \' が .ks の引数の書き逃しとぶつかって、引数が閉じられない）
        const js = value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
        out += `"${js}"`;
      } else out += `'${value}'`;
      i = j + 1;
      continue;
    }
    const id = /^[A-Za-z_$][\w$]*/.exec(expr.slice(i))?.[0];
    if (id) {
      const prev = out.trimEnd().at(-1);
      out += ROOTS[id] !== undefined && prev !== "." && expr[i + id.length] === "." ? ROOTS[id] : id;
      i += id.length;
      continue;
    }
    out += c;
    i++;
  }
  return attrEscape(out.trim());
}

/**
 * タグの引数（"…" の中）に書く形にする（戻り値を key="…" の中に置く）。TyranoScript の字句解析は \ があった所から
 * 引用符の " が来るまでの文字をそのまま読む（" は読んで、そこで書き逃しを終わる）ので、\ は \\ と、" は \" と書くと
 * そのとおりに読まれる。値が escaped で終わる（\ で終わる、または " が無い '…' の文字列で終わる）ときは、閉じる " が
 * 値に吸い込まれるので書けない — jsExpression は '…' ではなく "…" の文字列で終わる形にする。
 */
export function attrEscape(v: string): string {
  let t = "";
  let escaped = false;
  for (const c of v) {
    if (escaped) {
      t += c;
      if (c === '"') escaped = false;
    } else if (c === "\\") {
      t += "\\\\";
      escaped = true;
    } else if (c === '"') {
      t += '\\"';
    } else {
      t += c;
    }
  }
  return t;
}

/** `@set` の引数（`game.x = "a"`）を TyranoScript の代入文（`f.x='a'`）にする。 */
export function jsAssignment(rest: string): string | null {
  const s = /^(.+?)\s*(\+=|-=|\*=|\/=|=)\s*(.*)$/.exec(rest);
  if (!s) return null;
  return `${jsExpression(s[1]!)}${s[2]}${jsExpression(s[3]!)}`;
}

/** .lim の命令の行の字面（字下げなし）。 */
export function lineText(l: LimLine): string {
  switch (l.kind) {
    case "command":
      return `@${l.name}${l.rest ? ` ${l.rest}` : ""}`;
    case "set":
      return `@set ${l.rest}`;
    case "jump":
      return `@${l.name} ${l.target}`;
    default:
      return "";
  }
}

/** 二つの行の並びの、意味の上での違いの大きさ（0 なら同じ）。 */
export function linesDistance(a: readonly LimLine[], b: readonly LimLine[], registry?: Registry): number {
  let d = Math.abs(a.length - b.length) * 100;
  for (let i = 0; i < Math.min(a.length, b.length); i++) d += lineDistance(a[i]!, b[i]!, registry);
  return d;
}

function lineDistance(a: LimLine, b: LimLine, registry?: Registry): number {
  if (a.kind === "command" && b.kind === "command") {
    if (a.name !== b.name) return 20;
    return argsDistance(commandKey(a.name, a.args, registry), commandKey(b.name, b.args, registry));
  }
  if (a.kind === "option" && b.kind === "option") {
    return (
      (normalizeLimLine({ ...a, target: "", args: [] }) === normalizeLimLine({ ...b, target: "", args: [] }) ? 0 : 1) +
      (a.target === b.target ? 0 : 1) +
      argsDistance(commandKey("", a.args), commandKey("", b.args))
    );
  }
  const na = normalizeLimLine(a, registry);
  const nb = normalizeLimLine(b, registry);
  if (na === nb) return 0;
  return a.kind === b.kind ? 5 : 20;
}

function argsDistance(a: ReturnType<typeof commandKey>, b: ReturnType<typeof commandKey>): number {
  let d = Math.abs(a.positional.length - b.positional.length);
  for (let i = 0; i < Math.min(a.positional.length, b.positional.length); i++) if (a.positional[i] !== b.positional[i]) d++;
  for (const key of new Set([...a.named.keys(), ...b.named.keys()])) if (a.named.get(key) !== b.named.get(key)) d++;
  return d;
}
