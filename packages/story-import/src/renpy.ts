import { parseExpr } from "@liminalia/lang";
import type { VariableInitial } from "@liminalia/project";
import { englishStory, escapeText, lower, quote, renderFlat, textLine, type ChoiceNode, type Node, type Section, type Target } from "./ir.ts";
import { convertedHeader, labelName, limFileName, Session, type StoryFile, type StoryImportOptions, type StoryImportResult } from "./session.ts";

/**
 * Ren'Py（.rpy）を .lim にする。複数のファイルは一つの作品として扱い（ラベルの名前は共通）、ファイルごとに .lim を作る。
 *
 * 変換するもの: label（ローカルラベル .名前 も）、台詞（`e "…"`・`"名前" "…"`）と地の文、jump と call と return、menu（問いかけ・if）、
 * if・elif・else、while（中身に選択肢やジャンプが無いもの）、`$` の代入、define の Character と変数、default、image の画像の名前、
 * scene・show・hide（at の位置）、with の転換、play・stop（music・sound・voice）、voice、pause、window、本文のタグと [変数]。
 * 変換しないもの（報告に出す）: python のブロック、screen・transform・style、ATL、jump expression、queue、ほかの関数。
 * 立ち絵（show のタグと属性）はキャストにし、画像は Ren'Py の名前（"eileen happy.png"、image の文で決めたものはそのファイル）にする。
 */
export interface RenpySource {
  /** 報告に出すファイル名（.lim のファイル名はここから作る）。 */
  file: string;
  text: string;
}

interface RLine {
  indent: number;
  text: string;
  line: number;
  children: RLine[];
}

/** 変換したキャスト（cast.json の cast に足す。名前 → 立ち絵）。 */
export type RenpyCast = Record<string, { appearances: { default: { variants: Record<string, { image: string }> } } }>;

export interface RenpyOptions extends StoryImportOptions {
  /**
   * game/images の画像（Ren'Py が自動で決める画像の名前 → images からのパス）。名前は拡張子とフォルダを除いたファイル名を小文字にしたもの
   * （"bg room"）。渡すと、scene と show の画像をそのファイルの名前にする（無ければ "bg room.png" の形）。
   */
  imageFiles?: ReadonlyMap<string, string>;
  /** game/audio の音（Ren'Py の audio. の名前 → audio からのパス）。`play music main_theme` のように引用符なしで書いた音に使う。 */
  audioFiles?: ReadonlyMap<string, string>;
}

/** 台本が使う素材（node.ts が game/ から作品の素材のフォルダへ写す）。 */
export interface RenpyAsset {
  folder: "bgimage" | "fgimage" | "bgm" | "sound" | "voice";
  /** .lim に書いた名前（素材のフォルダからのパス）。 */
  path: string;
  /** game/ からのパス（image の文で決めた画像は game/ か game/images/ からのパス）。分からなければ null。 */
  from: string | null;
  /** Ren'Py の名前（画像の名前か、書いたファイルの名前）。 */
  name: string;
}

/** translate のブロック（tl/<言語>/ の訳）。行と文字は .lim に変換したもの。 */
export interface RenpyTranslation {
  /** Ren'Py の言語の名前（"english" など）。 */
  language: string;
  /** 台詞と地の文。source は原文の .lim の行、text は訳の .lim の行（どちらも話者の名前から）。 */
  lines: { speaker: string | null; source: string; text: string }[];
  /** translate … strings: の old と new（選択肢と、Character の名前など）。.lim の本文の書き方にしたもの。 */
  strings: { source: string; text: string }[];
}

export type RenpyResult = StoryImportResult & { cast: RenpyCast; assets: RenpyAsset[]; translations: RenpyTranslation[] };

const ID = /^[\p{L}_][\p{L}\p{N}_]*/u;

/** 訳だけのファイル（tl/ の中か、字下げの無い文がすべて translate のもの）。台本としては変換しない。 */
function translationOnly(src: RenpySource): boolean {
  if (/(^|[\\/])tl[\\/]/.test(src.file)) return true;
  const top = src.text.split(/\r?\n/).filter((l) => /^\S/.test(l) && !l.startsWith("#"));
  return top.length > 0 && top.every((l) => /^translate\s/.test(l));
}

export function importRenpy(all: readonly RenpySource[], o: RenpyOptions = {}): RenpyResult {
  const s = new Session(o);
  const sources = all.filter((x) => !translationOnly(x));
  // 英語の作品なら、台詞（e "…"）を "" で囲む（Ren'Py の台詞の引用符は区切りで、本文には入らない）
  const english = englishStory(...sources.map((x) => x.text));
  const assets: RenpyAsset[] = [];
  const files = sources.map((src, i) => {
    let lim = sources.length === 1 && o.name ? o.name : limFileName(src.file);
    for (let n = 2; sources.slice(0, i).some((x) => limFileName(x.file) === lim); n++) lim = `${limFileName(src.file)}_${n}`;
    s.file = src.file;
    return { src, lim, tree: tree(src.text) };
  });

  // ---- 定義（define・default・image）と、ラベルの場所 ----
  const characters = new Map<string, string | null>();
  const vars = new Map<string, string>();
  const images = new Map<string, string>();
  const labels = new Map<string, { file: string; label: string }>();
  const called = new Set<string>();
  const usedLabels = new Map<string, Set<string>>();
  const fullLabel = (name: string, parent: string | null) => (name.startsWith(".") ? `${parent ?? ""}${name}` : name);

  const definitions = (lines: readonly RLine[], file: string) => {
    for (const l of lines) {
      s.file = file;
      const t = l.text;
      if (/^init\b[^:]*:$/.test(t) && !/^init\s.*python/.test(t)) {
        definitions(l.children, file);
        continue;
      }
      const ch = /^define\s+([\p{L}_][\p{L}\p{N}_]*)\s*=\s*Character\s*\((.*)\)\s*$/su.exec(t);
      if (ch) {
        const first = /^\s*(?:_\(\s*)?("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|None)/.exec(ch[2]!);
        characters.set(ch[1]!, first && first[1] !== "None" ? unquote(first[1]!) : null);
        s.count("mapped");
        if (/\bcolor\s*=/.test(ch[2]!)) s.issue("info", "renpy-character", `Character の color などの見た目は変換しません（${ch[1]}）`, l.line);
        continue;
      }
      const dv = /^(define|default)\s+([\p{L}_][\p{L}\p{N}_.]*)\s*=\s*(.+)$/su.exec(t);
      if (dv) {
        const name = dv[2]!;
        if (/^(config|gui|build|style|preferences)\./.test(name)) {
          s.count("dropped");
          continue;
        }
        const v = pyLiteral(dv[3]!);
        if (v === undefined) {
          s.unsupportedSyntax("renpy-define", `${dv[1]} ${name} の値 ${dv[3]} は変換できません（数・文字列・真偽・None・リストだけ）`, l.line);
          continue;
        }
        const target = name.startsWith("persistent.") ? `system.${name.slice("persistent.".length)}` : `game.${name}`;
        if (target.startsWith("system.")) s.variables.set(target, v);
        else s.declare(name, v);
        vars.set(name, target);
        s.count("mapped");
        continue;
      }
      const im = /^image\s+([^=:]+?)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*$/.exec(t);
      if (im) {
        images.set(im[1]!.trim().replace(/\s+/g, " "), unquote(im[2]!));
        s.count("mapped");
        continue;
      }
      if (/^(image|transform|screen|style|init\s+python|python|translate|layeredimage)\b/.test(t)) {
        s.count("dropped");
        s.issue("info", "renpy-skip", `${t.replace(/:$/, "")} は変換しません（画面・見た目の定義と python は .lim にしない）`, l.line);
      }
    }
  };
  let parent: string | null = null;
  const findLabels = (lines: readonly RLine[], file: string, lim: string, top: boolean) => {
    for (const l of lines) {
      const m = /^label\s+([.\p{L}_][\p{L}\p{N}_.]*)\s*(\(.*\))?\s*:$/u.exec(l.text);
      if (m) {
        const full = fullLabel(m[1]!, parent);
        if (top && !m[1]!.startsWith(".")) parent = full;
        const used = usedLabels.get(lim)!;
        let label = labelName(full.replace(/\./g, "-"));
        for (let n = 2; used.has(label); n++) label = `${labelName(full.replace(/\./g, "-"))}_${n}`;
        used.add(label);
        if (labels.has(full)) {
          s.file = file;
          s.issue("warning", "renpy-duplicate-label", `ラベル ${full} が二つあります（先のものを使います）`, l.line);
        } else labels.set(full, { file: lim, label });
      }
      const c = /^call\s+([.\p{L}_][\p{L}\p{N}_.]*)/u.exec(l.text);
      if (c && c[1] !== "screen" && c[1] !== "expression") called.add(fullLabel(c[1]!, parent));
      findLabels(l.children, file, lim, false);
    }
  };
  for (const f of files) {
    usedLabels.set(f.lim, new Set());
    definitions(f.tree, f.src.file);
    parent = null;
    findLabels(f.tree, f.src.file, f.lim, true);
  }

  // ---- 式・本文 ----
  const variable = (name: string, line: number): string => {
    const known = vars.get(name);
    if (known) return known;
    const target = name.startsWith("persistent.") ? `system.${name.slice("persistent.".length)}` : null;
    if (target) {
      vars.set(name, target);
      return target;
    }
    const made = s.declare(name, 0);
    vars.set(name, made);
    s.issue("info", "renpy-undeclared", `${name} は default で宣言されていないので、初期値を 0 にしました`, line);
    return made;
  };
  const expr = (src: string, line: number): string | null => {
    const r = pyExpr(src, (n) => variable(n, line));
    if (typeof r === "string") return r;
    s.unsupportedSyntax("renpy-expression", `式 ${src} は変換できません（${r.error}）`, line);
    return null;
  };

  /** Ren'Py の文字列の中身を .lim の本文に（タグと [変数]）。 */
  const text = (raw: string, line: number): string => {
    let out = "";
    const open: string[] = [];
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i]!;
      if (c === "{" && raw[i + 1] === "{") {
        out += "\\{";
        i++;
        continue;
      }
      if (c === "[" && raw[i + 1] === "[") {
        out += "[";
        i++;
        continue;
      }
      if (c === "\n") {
        out += "{br}";
        continue;
      }
      if (c === "[") {
        const end = raw.indexOf("]", i);
        if (end > i) {
          const inner = raw.slice(i + 1, end).replace(/![a-z]+$/, "");
          const e = expr(inner, line);
          out += e === null ? escapeText(raw.slice(i, end + 1)) : `{= ${e}}`;
          if (e !== null) s.count("mapped");
          i = end;
          continue;
        }
      }
      if (c === "{") {
        const end = raw.indexOf("}", i);
        if (end > i) {
          const tag = raw.slice(i + 1, end);
          i = end;
          const [name, value] = tag.split("=", 2) as [string, string | undefined];
          if (name.startsWith("/")) {
            const k = name.slice(1);
            const at = open.lastIndexOf(k);
            if (at >= 0) {
              out += "}".repeat(open.length - at);
              open.splice(at);
            }
            continue;
          }
          const opened = name === "b" ? "{b " : name === "i" ? "{i " : name === "color" && value && /^#[0-9a-fA-F]{3,8}$/.test(value) ? `{c ${value} ` : name === "size" && value && /^\d+$/.test(value) ? `{size ${value} ` : null;
          if (opened !== null) {
            out += opened;
            open.push(name);
            s.count("mapped");
            continue;
          }
          if (name === "w" || name === "p") {
            out += value ? `{@wait ${Number(value)}s}` : "{click}";
            if (name === "p") out += "{br}";
            s.count("mapped");
            continue;
          }
          if (name === "nw") {
            out += "{noclick}";
            s.count("mapped");
            continue;
          }
          // {u} {s} {a=} {alpha=} {cps=} {fast} {image=} などは書き出さない（開きと閉じが対になるものは中の文字を残す）
          s.count("dropped");
          s.issue("info", "renpy-text-tag", `本文のタグ {${tag}} は変換しません（中の文字は残します）`, line);
          continue;
        }
      }
      out += escapeText(c);
    }
    return out + "}".repeat(open.length);
  };

  // ---- 文 ----
  const cast: RenpyCast = {};
  /**
   * Ren'Py の画像の名前を、素材のフォルダの中の名前にする（image の文で決めたファイル、game/images のファイル、無ければ "名前.png"）。
   * 使った画像は assets に入れる（同じものは一度）。
   */
  const imageFile = (name: string, folder: "bgimage" | "fgimage"): string => {
    const defined = images.get(name);
    const auto = defined === undefined ? o.imageFiles?.get(name.toLowerCase()) : undefined;
    const path = defined ?? (auto !== undefined ? auto.replace(/^.*\//, "") : `${name}.png`);
    if (!assets.some((a) => a.folder === folder && a.path === path)) assets.push({ folder, path, from: defined ?? (auto !== undefined ? `images/${auto}` : null), name });
    return path;
  };
  const castImage = (tag: string, attrs: readonly string[]) => {
    const variant = attrs.length > 0 ? attrs.join("_") : "default";
    const name = [tag, ...attrs].join(" ");
    const entry = (cast[tag] ??= { appearances: { default: { variants: {} } } });
    entry.appearances.default.variants[variant] ??= { image: imageFile(name, "fgimage") };
    return variant;
  };
  const bgImage = (name: string) => imageFile(name, "bgimage");
  /** 音のファイル（書いたパスか、引用符なしの audio. の名前）を素材の名前にし、assets に入れる。 */
  const soundFile = (written: string, folder: "bgm" | "sound" | "voice", name = written): string => {
    const path = written.replace(/^(audio|music|sound|voice)\//, "");
    if (!assets.some((a) => a.folder === folder && a.path === path)) assets.push({ folder, path, from: written, name });
    return path;
  };
  /** 引用符なしの名前（audio.main_theme か main_theme）を game/audio のファイルに。無ければ null。 */
  const audioName = (word: string): string | null => {
    const rel = o.audioFiles?.get(word.replace(/^audio\./, "").toLowerCase());
    return rel === undefined ? null : `audio/${rel}`;
  };
  const arg = (v: string) => (/[\s"]/.test(v) ? quote(v) : v);

  let currentLabel: string | null = null;
  /** 今いるラベル（ローカルラベルも）。call されるラベルかを見る。 */
  let inLabel: string | null = null;
  let masked = false;

  const targetOf = (name: string, from: string, line: number): Target | null => {
    const full = fullLabel(name, currentLabel);
    const l = labels.get(full);
    if (!l) {
      s.unsupportedSyntax("renpy-jump", `ラベル ${full} がありません`, line);
      return null;
    }
    return l.file === from ? { label: l.label } : { file: l.file, label: l.label };
  };

  /** 転換（with の後ろ）を time の時間に。 */
  const transition = (src: string, line: number): string | null => {
    const t = src.trim();
    if (t === "None") return null;
    let m = /^(Dissolve|dissolve)\(\s*([\d.]+)/.exec(t);
    if (m) return `${Number(m[2])}s`;
    m = /^Fade\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(t);
    if (m) return `${Number(m[1]) + Number(m[3])}s`;
    const known: Record<string, string> = { dissolve: "500ms", fade: "1s", pixellate: "1s", move: "500ms", ease: "500ms", irisin: "1s", irisout: "1s", wipeleft: "1s", wiperight: "1s", slideleft: "1s", slideright: "1s", vpunch: "", hpunch: "" };
    if (t in known) {
      if (!["dissolve", "fade"].includes(t)) s.issue("info", "renpy-transition", `転換 ${t} は時間だけを変換します（動き方は crossfade）`, line);
      return known[t] === "" ? null : known[t]!;
    }
    s.issue("info", "renpy-transition", `転換 ${t} は変換しません`, line);
    return null;
  };

  /** 文の並び（字下げした中身）を Node の並びに。 */
  const statements = (lines: readonly RLine[], from: string, top: boolean): Node[] => {
    const out: Node[] = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      const t = l.text;
      const line = l.line;
      let m: RegExpExecArray | null;
      // ラベル
      if ((m = /^label\s+([.\p{L}_][\p{L}\p{N}_.]*)\s*(\(.*\))?\s*:$/u.exec(t))) {
        const full = fullLabel(m[1]!, currentLabel);
        if (!m[1]!.startsWith(".")) currentLabel = full;
        inLabel = full;
        if (m[2]) s.unsupportedSyntax("renpy-label-params", `ラベル ${full} の引数は変換できません`, line);
        const l2 = labels.get(full);
        if (top && l2) out.push({ k: "label", name: l2.label });
        else s.unsupportedSyntax("renpy-label", `ブロックの中のラベル ${full} は変換できません`, line);
        out.push(...statements(l.children, from, top));
        continue;
      }
      if (/^(define|default|image|init|transform|screen|style|translate|layeredimage)\b/.test(t)) continue;
      if (t === "pass") continue;
      // 条件分岐
      if ((m = /^if\s+(.+):$/s.exec(t))) {
        const branches: { cond: string | null; body: Node[] }[] = [{ cond: expr(m[1]!, line) ?? "false", body: statements(l.children, from, false) }];
        while (i + 1 < lines.length) {
          const n = lines[i + 1]!;
          const e = /^elif\s+(.+):$/s.exec(n.text);
          if (e) branches.push({ cond: expr(e[1]!, n.line) ?? "false", body: statements(n.children, from, false) });
          else if (n.text === "else:") branches.push({ cond: null, body: statements(n.children, from, false) });
          else break;
          i++;
          if (n.text === "else:") break;
        }
        s.count("mapped");
        out.push({ k: "if", branches });
        continue;
      }
      if ((m = /^while\s+(.+):$/s.exec(t))) {
        const body = statements(l.children, from, false);
        const cond = expr(m[1]!, line);
        if (cond === null) continue;
        const flat = (ns: readonly Node[]): boolean => ns.every((n) => (n.k === "if" ? n.branches.every((b) => flat(b.body)) : ["text", "raw", "comment", "set", "let"].includes(n.k)));
        if (!flat(body)) {
          s.unsupportedSyntax("renpy-while", "選択肢・ジャンプ・ラベルを中に持つ while は変換できません", line);
          out.push({ k: "comment", text: t });
          continue;
        }
        // 繰り返しはエンジンの @while
        s.count("mapped");
        out.push({ k: "raw", text: `@while ${cond}` }, ...renderFlat(body, "  ", () => {}, english).map((x): Node => ({ k: "raw", text: x })), { k: "raw", text: "@end" });
        continue;
      }
      if ((m = /^menu(?:\s+([.\p{L}_][\p{L}\p{N}_.]*))?\s*:$/u.exec(t))) {
        out.push(...menu(l, from, m[1] ?? null, top));
        continue;
      }
      // ジャンプ
      if ((m = /^(jump|call)\s+(expression\s+)?(.+)$/.exec(t))) {
        if (m[2] || m[3]!.startsWith("screen")) {
          s.unsupportedSyntax("renpy-jump", `${t} は変換できません`, line);
          out.push({ k: "comment", text: t });
          continue;
        }
        const name = m[3]!.replace(/\s+from\s+\S+$/, "").replace(/\(.*\)$/, "").trim();
        if (/\(.*\)/.test(m[3]!)) s.unsupportedSyntax("renpy-label-params", `ラベルへの引数 ${m[3]} は変換できません`, line);
        const target = targetOf(name, from, line);
        if (!target) {
          out.push({ k: "comment", text: t });
          continue;
        }
        s.count("mapped");
        out.push({ k: m[1] === "jump" ? "jump" : "call", target });
        continue;
      }
      if (/^return\b/.test(t)) {
        s.count("mapped");
        // call されるラベルからは @return。ほかは Ren'Py ではメインメニューへ戻る（話の終わり）
        out.push(inLabel !== null && called.has(inLabel) ? { k: "return" } : { k: "end" });
        continue;
      }
      // 代入
      if ((m = /^\$\s*(.+)$/s.exec(t))) {
        out.push(...python(m[1]!, line));
        continue;
      }
      if (t === "python:" || /^python\b.*:$/.test(t)) {
        s.unsupportedSyntax("renpy-python", "python のブロックは変換できません", line);
        out.push({ k: "comment", text: t });
        continue;
      }
      // with だけの行: 前の画面の命令に時間を付ける
      if ((m = /^with\s+(.+)$/.exec(t))) {
        const fade = transition(m[1]!, line);
        const last = out.at(-1);
        if (fade && last?.k === "raw" && /^@(bg|chara|chara-hide|chara-hide-all|mask|mask-off)\b/.test(last.text) && !/\btime=/.test(last.text)) {
          last.text += ` time=${fade}`;
          s.count("mapped");
        } else s.count("dropped");
        continue;
      }
      // 画面
      const stage = stageNodes(t, line);
      if (stage !== null) {
        out.push(...stage);
        continue;
      }
      // 台詞・地の文
      const say = sayNode(t, line);
      if (say !== null) {
        out.push(...say);
        continue;
      }
      s.unsupportedSyntax("renpy-statement", `${t} は変換できません`, line);
      out.push({ k: "comment", text: t });
    }
    return out;
  };

  /** `$` の一行。代入と renpy.pause だけ。 */
  const python = (code: string, line: number): Node[] => {
    const t = code.trim();
    const p = /^renpy\.pause\(\s*([\d.]*)\s*\)$/.exec(t);
    if (p) {
      s.count("mapped");
      return [{ k: "raw", text: p[1] ? `@wait ${Number(p[1])}s` : "@wait-click" }];
    }
    const a = /^([\p{L}_][\p{L}\p{N}_.]*)\s*(=|\+=|-=|\*=|\/=)\s*(.+)$/su.exec(t);
    if (a && !a[3]!.startsWith("=")) {
      if (!vars.has(a[1]!) && !a[1]!.startsWith("persistent.")) {
        const v = pyLiteral(a[3]!);
        const initial: VariableInitial = typeof v === "string" ? "" : typeof v === "boolean" ? false : Array.isArray(v) ? [] : 0;
        vars.set(a[1]!, s.declare(a[1]!, initial));
        s.issue("info", "renpy-undeclared", `${a[1]} は default で宣言されていないので、初期値を ${JSON.stringify(initial)} にしました`, line);
      }
      const value = expr(a[3]!, line);
      if (value === null) return [{ k: "comment", text: `$ ${t}` }];
      s.count("mapped");
      return [{ k: "set", target: variable(a[1]!, line), op: a[2] as "=", value }];
    }
    s.unsupportedSyntax("renpy-python", `$ ${t} は変換できません（代入と renpy.pause だけ）`, line);
    return [{ k: "comment", text: `$ ${t}` }];
  };

  /** scene・show・hide・with・play・stop・voice・pause・window。当てはまらなければ null。 */
  const stageNodes = (t: string, line: number): Node[] | null => {
    const words = t.split(/\s+/);
    const head = words[0]!;
    const withAt = words.indexOf("with");
    const fade = withAt >= 0 ? transition(words.slice(withAt + 1).join(" "), line) : null;
    const fadeArg = fade ? ` time=${fade}` : "";
    const unmask = (): Node[] => {
      if (!masked) return [];
      masked = false;
      return [{ k: "raw", text: `@mask-off${fadeArg}` }];
    };
    if (head === "scene" || head === "show" || head === "hide") {
      const body = (withAt >= 0 ? words.slice(1, withAt) : words.slice(1)).join(" ");
      if (/^(screen|expression|text|layer)\b/.test(body) || /\b(onlayer|zorder|behind|as)\b/.test(body) || body.endsWith(":")) {
        s.unsupportedSyntax("renpy-show", `${t} は変換できません`, line);
        return [{ k: "comment", text: t }];
      }
      const atM = /\s+at\s+(.+)$/.exec(body);
      const name = (atM ? body.slice(0, atM.index) : body).trim();
      const parts = name.split(/\s+/).filter((x) => x !== "");
      s.count("mapped");
      if (head === "scene") {
        const out: Node[] = [{ k: "raw", text: `@chara-hide-all${fadeArg}` }];
        if (name === "") return out;
        if (name === "black") {
          masked = true;
          return [...out, { k: "raw", text: `@mask color=#000000${fadeArg}` }];
        }
        return [...out, { k: "raw", text: `@bg ${arg(bgImage(name))}${fadeArg}` }, ...unmask()];
      }
      const tag = parts[0];
      if (!tag) return [{ k: "comment", text: t }];
      if (head === "hide") return [{ k: "raw", text: `@chara-hide ${tag}${fadeArg}` }];
      const variant = castImage(tag, parts.slice(1));
      let at = "";
      if (atM) {
        // 作ったキャストの差分には立ち位置（frame の positions）が無いので、left・right は auto（並べる）、center は書かない
        const pos = atM[1]!.trim();
        if (pos === "left" || pos === "right") {
          at = " at=auto";
          s.issue("info", "renpy-position", `位置 ${pos} は at=auto（出ている立ち絵を並べる）にしました。cast.json の立ち位置を決めたら at=${pos} に直せます`, line);
        } else if (pos !== "center" && pos !== "truecenter") s.issue("info", "renpy-position", `位置 ${pos} は変換しません（立ち絵は今の位置か中央に出ます）`, line);
      }
      return [...unmask(), { k: "raw", text: `@chara ${tag}${parts.length > 1 ? ` ${variant}` : ""}${at}${fadeArg}` }];
    }
    if (head === "play" || head === "queue" || head === "stop") {
      const channel = words[1] ?? "";
      if (head === "queue") {
        s.unsupportedSyntax("renpy-audio", `${t} は変換できません（queue は次の曲の予約）`, line);
        return [{ k: "comment", text: t }];
      }
      const time = (key: string) => {
        const k = words.indexOf(key);
        return k >= 0 && words[k + 1] && /^[\d.]+$/.test(words[k + 1]!) ? ` time=${Number(words[k + 1])}s` : "";
      };
      if (head === "stop") {
        s.count("mapped");
        if (channel === "music") return [{ k: "raw", text: `@stop-bgm${time("fadeout")}` }];
        if (channel === "sound" || channel === "audio") return [{ k: "raw", text: `@stop-se${time("fadeout")}` }];
        s.issue("info", "renpy-audio", `${t} は変換しません`, line);
        return [];
      }
      const file = /^\S+\s+\S+\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/.exec(t);
      // 引用符なしの名前は game/audio のファイル（Ren'Py の audio. の名前）
      const named = file ? null : audioName(words[2] ?? "");
      if (!file && !named) {
        s.unsupportedSyntax("renpy-audio", `${t} は変換できません（ファイルは "…" で書きます）`, line);
        return [{ k: "comment", text: t }];
      }
      const written = file ? unquote(file[1]!) : named!;
      s.count("mapped");
      if (channel === "music") return [{ k: "raw", text: `@bgm ${arg(soundFile(written, "bgm", file ? written : words[2]!))}${time("fadein")}${/\bnoloop\b/.test(t) ? " loop=false" : ""}` }];
      if (channel === "sound" || channel === "audio") return [{ k: "raw", text: `@se ${arg(soundFile(written, "sound", file ? written : words[2]!))}` }];
      if (channel === "voice") return [{ k: "raw", text: `@voice ${arg(soundFile(written, "voice", file ? written : words[2]!))}` }];
      s.count("dropped");
      s.issue("info", "renpy-audio", `チャンネル ${channel} は変換しません`, line);
      return [];
    }
    if (head === "voice") {
      const file = /^voice\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/.exec(t);
      if (!file) return null;
      s.count("mapped");
      const written = unquote(file[1]!);
      // voice の文はファイル名をそのまま使う（play voice のような audio/ などの頭は外さない）
      if (!assets.some((a) => a.folder === "voice" && a.path === written)) assets.push({ folder: "voice", path: written, from: written, name: written });
      return [{ k: "raw", text: `@voice ${arg(written)}` }];
    }
    if (head === "pause") {
      s.count("mapped");
      return [{ k: "raw", text: words[1] ? `@wait ${Number(words[1])}s` : "@wait-click" }];
    }
    if (head === "window" && (words[1] === "show" || words[1] === "hide")) {
      s.count("mapped");
      // window show と window hide は、with を書かずに転換を続けても書ける（window hide dissolve）
      const own = withAt < 0 && words.length > 2 ? transition(words.slice(2).join(" "), line) : null;
      return [{ k: "raw", text: `@window ${words[1]}${own ? ` time=${own}` : fadeArg}` }];
    }
    if (head === "window" || head === "nvl") {
      s.count("dropped");
      return [];
    }
    return null;
  };

  /** 台詞・地の文。`"…"`、`e "…"`、`e happy "…"`、`"名前" "…"`、centered と extend。当てはまらなければ null。 */
  const sayNode = (t: string, line: number): Node[] | null => {
    const say = sayParts(t, line);
    if (say === null) return null;
    const { speaker, body } = say;
    const lim = text(body, line);
    if (speaker !== null) {
      s.speaker(speaker);
      s.stats.says++;
    } else s.stats.prose++;
    s.count("mapped");
    return [{ k: "text", speaker, text: lim, line }];
  };

  /** 台詞の行の話者（Character の名前）と、本文（Ren'Py の文字列のまま）。台詞の形でなければ null。 */
  const sayParts = (t: string, line: number): { speaker: string | null; body: string } | null => {
    const toks = sayTokens(t);
    if (toks === null) return null;
    const strings = toks.filter((x) => x.s !== undefined);
    if (strings.length === 0) return null;
    const firstString = toks.findIndex((x) => x.s !== undefined);
    const lead = toks.slice(0, firstString).map((x) => x.w!);
    let speaker: string | null = null;
    let body: string;
    if (lead.length === 0 && strings.length >= 2 && toks[1]?.s !== undefined) {
      speaker = strings[0]!.s!;
      body = strings[1]!.s!;
    } else {
      body = toks[firstString]!.s!;
      if (lead.length > 0) {
        const who = lead[0]!;
        if (who === "centered" || who === "narrator" || who === "extend") {
          if (who === "extend") s.issue("info", "renpy-extend", "extend は前の台詞に続けず、別の行にします", line);
        } else if (characters.has(who)) speaker = characters.get(who) ?? null;
        else {
          speaker = who;
          s.issue("info", "renpy-speaker", `${who} は Character で定義されていないので、そのまま話者の名前にしました`, line);
        }
        if (lead.length > 1) s.issue("info", "renpy-say-attributes", `台詞の属性（${lead.slice(1).join(" ")}）は変換しません`, line);
      }
    }
    return { speaker, body };
  };

  const menu = (l: RLine, from: string, name: string | null, top: boolean): Node[] => {
    const out: Node[] = [];
    if (name) {
      const target = labels.get(fullLabel(name, currentLabel));
      if (top && target) out.push({ k: "label", name: target.label });
    }
    const options: ChoiceNode[] = [];
    for (const c of l.children) {
      const opt = /^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')(?:\s+if\s+(.+))?\s*:$/s.exec(c.text);
      if (opt) {
        const cond = opt[2] ? expr(opt[2], c.line) : null;
        options.push({ text: text(unquote(opt[1]!), c.line) || "…", cond, once: false, label: null, body: statements(c.children, from, false), line: c.line });
        s.count("mapped");
        continue;
      }
      if (/^set\s/.test(c.text)) {
        s.unsupportedSyntax("renpy-menu", "menu の set は変換できません（選んだ選択肢を隠しません）", c.line);
        continue;
      }
      const say = sayNode(c.text, c.line);
      if (say) {
        // 問いかけは出したまま選択肢を出す
        for (const n of say) if (n.k === "text") n.text += "{noclick}";
        out.push(...say);
        continue;
      }
      s.unsupportedSyntax("renpy-menu", `menu の中の ${c.text} は変換できません`, c.line);
    }
    s.stats.choices++;
    out.push({ k: "choice", options, fallback: null, line: l.line });
    return out;
  };

  // ---- ファイルごとに組み立てる ----
  const built = files.map((f) => {
    s.file = f.src.file;
    currentLabel = null;
    inLabel = null;
    masked = false;
    const body = statements(f.tree, f.lim, true);
    // ファイルの先頭のラベルを最初のまとまりの名前にする（Ren'Py はラベルの終わりから次のラベルへ続く）
    const first = body[0]?.k === "label" ? (body.shift() as Extract<Node, { k: "label" }>).name : null;
    const sections: Section[] = body.length > 0 || first ? [{ label: first, body }] : [];
    const lines = lower(sections, { file: f.lim, end: o.end ?? "title", counted: new Map(), onceVariable: (label) => s.gameVariable(`once_${label}`, false), issue: (i) => s.issue(i.severity, i.code, i.message, i.line), english }, new Set(usedLabels.get(f.lim)));
    return { f, lines };
  });
  const out: StoryFile[] = built.map(({ f, lines }, i) => {
    const head = [convertedHeader(f.src.file, "renpy", o.language)];
    if (s.options.variables === "set" && i === 0 && s.variables.size > 0) head.push(...s.variableLines());
    return { name: f.lim, source: f.src.file, text: `${[...head, "", ...lines].join("\n").replace(/\n{3,}/g, "\n\n")}\n` };
  });
  s.stats.labels = out.reduce((a, f) => a + f.text.split("\n").filter((l) => l.startsWith("# ")).length, 0);
  const start = labels.get("start");
  s.file = sources[0]?.file ?? "";
  if (start) s.issue("info", "renpy-start", `Ren'Py の始まり（label start）は ${start.file}#${start.label} です。liminalia.json の entry をこのファイルにします`, 0);
  if (Object.keys(cast).length > 0 && !o.imageFiles) s.issue("info", "renpy-images", `立ち絵 ${Object.keys(cast).join("、")} の画像は Ren'Py の名前（"eileen happy.png" の形）にしました。画像をアセットのフォルダに置いてください`, 0);

  // ---- 訳（translate のブロック。tl/<言語>/ のファイル） ----
  // 訳の文も本文と同じ変換（タグと [変数]）にする。数と診断は本文の変換のものだけにするため、訳の変換のあいだのものは戻す
  const quietly = <T>(fn: () => T): T => {
    const totals = { ...s.totals };
    const issues = s.issues.length;
    const unsupported = new Map(s.unsupported);
    try {
      return fn();
    } finally {
      Object.assign(s.totals, totals);
      s.issues.length = issues;
      s.unsupported.clear();
      for (const [k, v] of unsupported) s.unsupported.set(k, v);
    }
  };
  const translations = new Map<string, RenpyTranslation>();
  for (const src of all) {
    const rows = src.text.replace(/\r\n?/g, "\n").split("\n");
    for (let i = 0; i < rows.length; i++) {
      const head = /^translate\s+([\p{L}\p{N}_]+)\s+([\p{L}\p{N}_.]+)\s*:\s*$/u.exec(stripComment(rows[i]!));
      if (!head || head[1] === "None" || head[2] === "python") continue;
      const block: { text: string; line: number }[] = [];
      for (let j = i + 1; j < rows.length && (rows[j]!.trim() === "" || /^\s/.test(rows[j]!)); j++) if (rows[j]!.trim() !== "") block.push({ text: rows[j]!.trim(), line: j + 1 });
      const language = head[1]!;
      const target = !/^(ja|zh)/.test(renpyLanguageCode(language) ?? "");
      let t = translations.get(language);
      if (!t) translations.set(language, (t = { language, lines: [], strings: [] }));
      const into = t;
      s.file = src.file;
      quietly(() => {
        if (head[2] === "strings") {
          let old: string | null = null;
          for (const b of block) {
            const m = /^(old|new)\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*$/.exec(b.text);
            if (!m) continue;
            if (m[1] === "old") old = unquote(m[2]!);
            else if (old !== null) {
              into.strings.push({ source: text(old, b.line), text: text(unquote(m[2]!), b.line) });
              old = null;
            }
          }
          return;
        }
        // 原文は「# e "…"」のコメント、訳はその後の台詞（並びの順に組にする）
        const originals = block.filter((b) => b.text.startsWith("#")).flatMap((b) => sayParts(b.text.replace(/^#\s?/, ""), b.line) ?? []);
        const translated = block.filter((b) => !b.text.startsWith("#")).flatMap((b) => sayParts(b.text, b.line) ?? []);
        originals.forEach((orig, k) => {
          const tr = translated[k];
          if (!tr) return;
          into.lines.push({ speaker: orig.speaker, source: textLine(orig.speaker, text(orig.body, 0), english), text: textLine(orig.speaker, text(tr.body, 0), target) });
        });
      });
    }
  }
  return { ...s.result(out), cast, assets, translations: [...translations.values()].filter((t) => t.lines.length > 0 || t.strings.length > 0) };
}

/** Ren'Py の言語の名前（translate english の english）→ 訳のファイルの言語（lang/<言語>.json）。 */
const RENPY_LANGUAGES: Readonly<Record<string, string>> = {
  english: "en",
  japanese: "ja",
  korean: "ko",
  french: "fr",
  german: "de",
  spanish: "es",
  italian: "it",
  russian: "ru",
  portuguese: "pt",
  brazilian: "pt-BR",
  polish: "pl",
  ukrainian: "uk",
  turkish: "tr",
  vietnamese: "vi",
  indonesian: "id",
  thai: "th",
  schinese: "zh-Hans",
  chinese: "zh-Hans",
  simplified_chinese: "zh-Hans",
  tchinese: "zh-Hant",
  traditional_chinese: "zh-Hant",
};

/** Ren'Py の言語の名前を言語のコードに（分からなければ null。"en" のようにコードで書いたものはそのまま）。 */
export function renpyLanguageCode(name: string): string | null {
  const known = RENPY_LANGUAGES[name.toLowerCase()];
  if (known) return known;
  return /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(name) ? name : null;
}

// ---- 字句 ----

/** 行に分け、字下げで木にする。# のコメントと、括弧の中の改行（続きの行）をまとめる。 */
function tree(source: string): RLine[] {
  const rows = source.replace(/\r\n?/g, "\n").split("\n");
  const logical: Omit<RLine, "children">[] = [];
  for (let i = 0; i < rows.length; i++) {
    let text = stripComment(rows[i]!);
    const start = i;
    while (depth(text) > 0 && i + 1 < rows.length) text += `\n${stripComment(rows[++i]!).trim()}`;
    if (text.trim() === "") continue;
    const indent = /^[ \t]*/.exec(text)![0].replace(/\t/g, "    ").length;
    logical.push({ indent, text: text.trim(), line: start + 1 });
  }
  const root: RLine[] = [];
  const stack: RLine[] = [];
  for (const l of logical) {
    const node: RLine = { ...l, children: [] };
    while (stack.length > 0 && stack.at(-1)!.indent >= l.indent) stack.pop();
    (stack.length > 0 ? stack.at(-1)!.children : root).push(node);
    stack.push(node);
  }
  return root;
}

function stripComment(raw: string): string {
  let q: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === "\\") {
      i++;
      continue;
    }
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === "#") return raw.slice(0, i).replace(/\s+$/, "");
  }
  return raw.replace(/\s+$/, "");
}

function depth(text: string): number {
  let d = 0;
  let q: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\") {
      i++;
      continue;
    }
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if ("([{".includes(c)) d++;
    else if (")]}".includes(c)) d--;
  }
  return d;
}

/** Python の文字列の字面の中身（\" \' \\ \n \t \r）。 */
function unquote(lit: string): string {
  const body = lit.slice(1, -1);
  return body.replace(/\\(.)/g, (_, c: string) => ({ n: "\n", t: "\t", r: "\n" })[c] ?? c);
}

/** 台詞の行を、言葉と文字列に分ける。台詞の形でなければ null。 */
function sayTokens(t: string): { w?: string; s?: string }[] | null {
  const out: { w?: string; s?: string }[] = [];
  let i = 0;
  while (i < t.length) {
    if (/\s/.test(t[i]!)) {
      i++;
      continue;
    }
    const c = t[i]!;
    if (c === '"' || c === "'") {
      // """ の三重の引用符も一つの文字列
      const triple = t.startsWith(c.repeat(3), i);
      const close = triple ? c.repeat(3) : c;
      let j = i + close.length;
      while (j < t.length && !t.startsWith(close, j)) j += t[j] === "\\" ? 2 : 1;
      if (j >= t.length) return null;
      out.push({ s: unquote(`${c}${t.slice(i + close.length, j)}${c}`) });
      i = j + close.length;
      continue;
    }
    const w = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(t.slice(i));
    if (!w) {
      // with の転換や (multiple=2) などの後ろ
      if (out.some((x) => x.s !== undefined)) break;
      return null;
    }
    if (out.some((x) => x.s !== undefined)) break;
    out.push({ w: w[0] });
    i += w[0].length;
  }
  return out;
}

/** define・default の値（数・文字列・真偽・None・それらのリスト）。読めなければ undefined。 */
function pyLiteral(src: string): VariableInitial | undefined {
  const t = src.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === "True" || t === "False") return t === "True";
  if (t === "None") return null;
  if (/^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/.test(t)) return unquote(t);
  const list = /^\[(.*)\]$/s.exec(t);
  if (list) {
    if (list[1]!.trim() === "") return [];
    const items = list[1]!.split(",").map(pyLiteral);
    return items.every((x) => x !== undefined) ? (items as VariableInitial[]) : undefined;
  }
  return undefined;
}

const PY_TOKEN = /\s+|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\d+(?:\.\d+)?|[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*|\*\*|\/\/|==|!=|<=|>=|[-+*/%<>()[\],]|[\s\S]/gu;
const PY_FUNCTIONS: Record<string, string> = {
  len: "len",
  int: "floor",
  str: "str",
  abs: "abs",
  min: "min",
  max: "max",
  round: "round",
  "renpy.random.randint": "randint",
  "renpy.random.choice": "pick",
  "renpy.random.random": "random",
};

/** Python の式（Ren'Py の条件と代入の右辺）を .lim の式に。variable は変数の名前を .lim の変数に。 */
export function pyExpr(src: string, variable: (name: string) => string): string | { error: string } {
  const toks = (src.match(PY_TOKEN) ?? []).filter((x) => !/^\s+$/.test(x));
  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    const next = toks[i + 1];
    if (t === "**" || t === "//") return { error: `${t} は変換できません` };
    if (t === "in" || (t === "not" && next === "in")) return { error: "in は変換できません" };
    if (/^["']/.test(t)) {
      out.push(quote(unquote(t)));
      continue;
    }
    if (/^\d/.test(t)) {
      out.push(t);
      continue;
    }
    if (ID.test(t)) {
      if (t === "and") out.push("&&");
      else if (t === "or") out.push("||");
      else if (t === "not") out.push("!");
      else if (t === "is") {
        if (next === "not") {
          i++;
          out.push("!=");
        } else out.push("==");
      } else if (t === "True" || t === "False") out.push(t.toLowerCase());
      else if (t === "None") out.push("null");
      else if (next === "(") {
        const f = PY_FUNCTIONS[t];
        if (!f) return { error: `関数 ${t}() は変換できません` };
        out.push(f);
      } else out.push(variable(t));
      continue;
    }
    out.push(t);
  }
  let s = "";
  out.forEach((p, k) => {
    const prev = out[k - 1];
    s += k === 0 || prev === "(" || prev === "[" || prev === "!" || p === ")" || p === "]" || p === "," || (p === "(" && prev !== undefined && /[\p{L}\p{N}_]$/u.test(prev)) ? p : ` ${p}`;
  });
  try {
    parseExpr(s);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  return s;
}
