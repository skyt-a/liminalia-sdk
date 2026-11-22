import { parseExpr } from "@liminalia/lang";
import type { VariableInitial } from "@liminalia/project";
import { englishStory, escapeText, lower, quote, type ChoiceNode, type Node, type Section } from "./ir.ts";
import { convertedHeader, labelName, limFileName, Session, type StoryImportOptions, type StoryImportResult } from "./session.ts";

/**
 * Twine の Twee 3（.twee・.tw）を .lim にする。物語の書式は Harlowe と SugarCube の基本。
 *
 * 変換するもの: パッセージ（`:: 名前`）はラベル（始まりのパッセージを先頭に）、本文の行は地の文、リンク（`[[文]]`・`[[文->先]]`・
 * `[[先<-文]]`・`[[文|先]]`）はパッセージの終わりの選択肢、変数（`$x` は game.x、`_x` は temp.x）、
 * Harlowe の `(set:)`・`(put:)`・`(if:)[…]`・`(else-if:)`・`(else:)`・`(unless:)`・`(print:)`・`(goto:)`・`(link-goto:)`・`(either:)`・`(random:)`、
 * SugarCube の `<<set>>`・`<<if>>`・`<<elseif>>`・`<<else>>`・`<<print>>`・`<<=>>`・`<<goto>>`・`<<link>>`、`''太字''`・`//斜体//`・`<br>`。
 * StoryInit（SugarCube）と startup のタグ（Harlowe）のパッセージは、始まりのパッセージの前で実行する。
 * 変換しないもの（報告に出す）: ほかのマクロ、JavaScript、スタイル、widget、(display:)・<<include>>。
 */
export interface TwineImportOptions extends StoryImportOptions {
  /** 報告に出す元のファイル名。 */
  file?: string;
}

type Format = "harlowe" | "sugarcube";

interface Passage {
  name: string;
  tags: string[];
  line: number;
  body: string;
  label: string;
}

/** 本文の部品。 */
type Seg =
  | { k: "text"; s: string }
  | { k: "br" }
  | { k: "node"; node: Node }
  | { k: "nodes"; nodes: Node[] }
  | { k: "link"; text: string; target: string }
  | { k: "if"; branches: { cond: string | null; body: Seg[] }[] };

const SKIP_TAGS = ["script", "stylesheet", "widget", "Twine.private", "annotation"];
const SKIP_PASSAGES = ["StoryTitle", "StoryData", "StoryCaption", "StoryMenu", "StoryBanner", "StorySubtitle", "StoryAuthor", "StoryShare", "PassageReady", "PassageDone", "PassageHeader", "PassageFooter", "Story JavaScript", "Story Stylesheet"];

export function importTwine(source: string, o: TwineImportOptions = {}): StoryImportResult {
  const s = new Session(o);
  // 英語の作品なら、括弧の無い台詞を "" で囲む
  const english = englishStory(source);
  const file = o.file ?? "story.twee";
  s.file = file;
  const name = o.name ?? limFileName(file);

  // ---- パッセージに分ける ----
  const rows = source.replace(/\r\n?/g, "\n").split("\n");
  const passages: Passage[] = [];
  const used = new Set<string>();
  let cur: Passage | null = null;
  let data: { format?: string; start?: string } = {};
  rows.forEach((row, i) => {
    const h = /^::\s*((?:\\.|[^[{\\])+?)\s*(?:\[([^\]]*)\])?\s*(?:\{.*\})?\s*$/.exec(row);
    if (h) {
      const pname = h[1]!.replace(/\\(.)/g, "$1").trim();
      let label = labelName(pname);
      for (let n = 2; used.has(label); n++) label = `${labelName(pname)}_${n}`;
      used.add(label);
      cur = { name: pname, tags: (h[2] ?? "").split(/\s+/).filter((t) => t !== ""), line: i + 1, body: "", label };
      passages.push(cur);
      return;
    }
    if (cur) cur.body += `${(cur as Passage).body === "" && row.trim() === "" ? "" : row}\n`;
  });
  const storyData = passages.find((p) => p.name === "StoryData");
  if (storyData) {
    try {
      data = JSON.parse(storyData.body) as typeof data;
    } catch {
      s.issue("warning", "twine-story-data", "StoryData の JSON を読めません", storyData.line);
    }
  }
  const all = passages.map((p) => p.body).join("\n");
  const format: Format = /sugarcube/i.test(data.format ?? "") ? "sugarcube" : /harlowe/i.test(data.format ?? "") ? "harlowe" : /<<\s*(set|if|print|goto|link)\b/.test(all) ? "sugarcube" : "harlowe";
  const byName = new Map(passages.map((p) => [p.name, p]));
  const skipped = (p: Passage) => SKIP_PASSAGES.includes(p.name) || p.tags.some((t) => SKIP_TAGS.includes(t));
  for (const p of passages) {
    if (!skipped(p)) continue;
    s.count("dropped");
    if (!["StoryTitle", "StoryData"].includes(p.name)) s.issue("info", "twine-skip", `パッセージ ${p.name} は変換しません（JavaScript・スタイル・画面の部品）`, p.line);
  }

  // ---- 変数と式 ----
  const vars = new Map<string, string>();
  const variable = (raw: string, line: number): string => {
    if (raw.startsWith("_")) return `temp.${raw.slice(1)}`;
    const n = raw.slice(1);
    const known = vars.get(n);
    if (known) return known;
    const made = s.declare(n, 0);
    vars.set(n, made);
    s.issue("info", "twine-undeclared", `$${n} は初期値が分からないので 0 にしました（StoryInit か startup で値を入れると、その値になります）`, line);
    return made;
  };
  // 初期値: StoryInit と startup の set の値
  for (const p of passages) {
    if (p.name !== "StoryInit" && !p.tags.includes("startup")) continue;
    const re = format === "sugarcube" ? /<<\s*set\s+\$([\p{L}_][\p{L}\p{N}_]*)\s*(?:to|=)\s*([^>]+?)\s*>>/gu : /\(set:\s*\$([\p{L}_][\p{L}\p{N}_]*)\s+to\s+([^)]+?)\s*\)/gu;
    for (const m of p.body.matchAll(re)) {
      const v = literal(m[2]!);
      if (v !== undefined && !vars.has(m[1]!)) vars.set(m[1]!, s.declare(m[1]!, v));
    }
  }
  const expr = (src: string, line: number, it?: string): string | null => {
    const r = twineExpr(src, format, (v) => variable(v, line), it);
    if (typeof r === "string") return r;
    s.unsupportedSyntax("twine-expression", `式 ${src} は変換できません（${r.error}）`, line);
    return null;
  };

  // ---- 本文 ----
  /** 本文の文字列を部品にする。line は行番号を数えるための先頭の行。 */
  const segments = (text: string, line0: number): Seg[] => {
    const out: Seg[] = [];
    let i = 0;
    let line = line0;
    let buf = "";
    const flush = () => {
      if (buf) out.push({ k: "text", s: buf });
      buf = "";
    };
    /** text[at] の開きに対応する閉じ（open・close の入れ子を数える）。 */
    const matchClose = (at: number, open: string, close: string): number => {
      let d = 0;
      for (let j = at; j < text.length; j++) {
        if (text.startsWith(open, j)) {
          d++;
          j += open.length - 1;
        } else if (text.startsWith(close, j)) {
          d--;
          if (d === 0) return j;
          j += close.length - 1;
        }
      }
      return -1;
    };
    /** ( の後ろの Harlowe のマクロ（名前: 引数）と、続くフック [ … ]。 */
    const harloweIf = (): Seg | null => {
      const branches: { cond: string | null; body: Seg[] }[] = [];
      const negs: string[] = [];
      for (;;) {
        const m = /^\((if|else-if|elseif|unless|else):\s*([^)]*)\)\s*\[/.exec(text.slice(i));
        if (!m || (branches.length === 0 && !["if", "unless"].includes(m[1]!)) || (branches.length > 0 && ["if", "unless"].includes(m[1]!))) break;
        const hookAt = i + m[0].length - 1;
        const end = matchClose(hookAt, "[", "]");
        if (end < 0) break;
        let cond: string | null = null;
        if (m[1] !== "else") {
          const c = expr(m[2]!, line);
          cond = c === null ? "false" : m[1] === "unless" ? `!(${c})` : c;
        }
        branches.push({ cond, body: segments(text.slice(hookAt + 1, end), line) });
        negs.push(cond ?? "");
        line += countLines(text.slice(i, end + 1));
        i = end + 1;
        if (m[1] === "else") break;
        // (else:) などは空白か改行を挟んでも続く
        const ws = /^\s*/.exec(text.slice(i))![0];
        if (/^\((else-if|elseif|else):/.test(text.slice(i + ws.length))) {
          line += countLines(ws);
          i += ws.length;
        } else break;
      }
      return branches.length > 0 ? { k: "if", branches } : null;
    };
    /** SugarCube の <<if>> 〜 <</if>>。 */
    const sugarIf = (): Seg | null => {
      const end = matchClose(i, "<<if", "<</if>>");
      if (end < 0) return null;
      const inner = text.slice(i, end);
      // 深さ 0 の <<elseif>> <<else>> で分ける
      const parts: { cond: string | null; at: number; head: number }[] = [];
      const head = /^<<if\s+([\s\S]*?)>>/.exec(inner);
      if (!head) return null;
      parts.push({ cond: head[1]!, at: head[0].length, head: 0 });
      let d = 0;
      for (let j = head[0].length; j < inner.length; j++) {
        if (inner.startsWith("<<if", j)) d++;
        else if (inner.startsWith("<</if>>", j)) d--;
        else if (d === 0) {
          const m = /^<<(elseif\s+([\s\S]*?)|else)>>/.exec(inner.slice(j));
          if (m) {
            parts.push({ cond: m[1] === "else" ? null : m[2]!, at: j + m[0].length, head: j });
            j += m[0].length - 1;
          }
        }
      }
      const branches = parts.map((p, k) => {
        const bodyEnd = k + 1 < parts.length ? parts[k + 1]!.head : inner.length;
        const c = p.cond === null ? null : (expr(p.cond, line) ?? "false");
        return { cond: c, body: segments(inner.slice(p.at, bodyEnd), line) };
      });
      line += countLines(text.slice(i, end + "<</if>>".length));
      i = end + "<</if>>".length;
      return { k: "if", branches };
    };
    const goto = (target: string): Seg => {
      const p = byName.get(target);
      if (!p) {
        s.unsupportedSyntax("twine-link", `パッセージ ${target} がありません`, line);
        return { k: "node", node: { k: "comment", text: `goto ${target}` } };
      }
      s.count("mapped");
      return { k: "node", node: { k: "jump", target: { label: p.label } } };
    };
    while (i < text.length) {
      const rest = text.slice(i);
      const c = text[i]!;
      if (c === "\n") {
        flush();
        out.push({ k: "br" });
        line++;
        i++;
        continue;
      }
      // リンク
      if (rest.startsWith("[[")) {
        const end = text.indexOf("]]", i);
        if (end > 0) {
          flush();
          const inner = text.slice(i + 2, end);
          const l = parseLink(inner);
          out.push({ k: "link", text: l.text, target: l.target });
          i = end + 2;
          continue;
        }
      }
      if (rest.startsWith("''") || rest.startsWith("//")) {
        const mark = rest.slice(0, 2);
        const end = text.indexOf(mark, i + 2);
        if (end > i + 2 && !text.slice(i + 2, end).includes("\n") && !(mark === "//" && /:$/.test(text.slice(0, i)))) {
          buf += `{${mark === "''" ? "b" : "i"} ${escapeText(text.slice(i + 2, end))}}`;
          s.count("mapped");
          i = end + 2;
          continue;
        }
      }
      if (/^<br\s*\/?>/i.test(rest)) {
        buf += "{br}";
        i += /^<br\s*\/?>/i.exec(rest)![0].length;
        continue;
      }
      if (/^<\/?[a-z][^>]*>/i.test(rest) && !rest.startsWith("<<")) {
        const m = /^<\/?[a-z][^>]*>/i.exec(rest)![0];
        s.count("dropped");
        s.issue("info", "twine-html", `HTML のタグ ${m} は変換しません（中の文字は残します）`, line);
        i += m.length;
        continue;
      }
      // 変数をそのまま本文に（$x・_x。Harlowe と SugarCube の「裸の変数」）
      const nv = /^[$_][\p{L}_][\p{L}\p{N}_]*/u.exec(rest);
      if (nv && (c === "$" || /(^|[\s(（「])$/.test(text.slice(0, i)))) {
        if (c === "$" || vars.has(nv[0].slice(1))) {
          buf += `{= ${variable(nv[0], line)}}`;
          s.count("mapped");
          i += nv[0].length;
          continue;
        }
      }
      if (format === "harlowe" && c === "(") {
        const m = /^\(([a-z][a-z0-9-]*):/i.exec(rest);
        if (m) {
          const macro = m[1]!.toLowerCase();
          if (macro === "if" || macro === "unless") {
            const seg = harloweIf();
            if (seg) {
              flush();
              out.push(seg);
              s.count("mapped");
              continue;
            }
          }
          const end = matchClose(i, "(", ")");
          if (end > 0) {
            const args = text.slice(i + m[0].length, end).trim();
            const seg = harloweMacro(macro, args, line);
            if (seg !== null) {
              if (seg.k !== "text") flush();
              if (seg.k === "text") buf += seg.s;
              else out.push(seg);
              i = end + 1;
              continue;
            }
          }
        }
      }
      if (format === "sugarcube" && rest.startsWith("<<")) {
        if (/^<<if\s/.test(rest)) {
          const seg = sugarIf();
          if (seg) {
            flush();
            out.push(seg);
            s.count("mapped");
            continue;
          }
        }
        const lk = /^<<link\s+([\s\S]*?)>>([\s\S]*?)<<\/link>>/.exec(rest);
        if (lk) {
          flush();
          const args = macroArgs(lk[1]!);
          const l = args.length === 1 && /^\[\[/.test(lk[1]!.trim()) ? parseLink(lk[1]!.trim().slice(2, -2)) : { text: args[0] ?? "", target: args[1] ?? "" };
          if (lk[2]!.trim()) s.issue("info", "twine-link", `<<link>> の中身（${lk[2]!.trim()}）は変換しません`, line);
          if (l.target) out.push({ k: "link", text: l.text, target: l.target });
          else s.unsupportedSyntax("twine-link", "行き先の無い <<link>> は変換できません", line);
          i += lk[0].length;
          continue;
        }
        const end = text.indexOf(">>", i);
        if (end > 0) {
          const seg = sugarMacro(text.slice(i + 2, end).trim(), line);
          if (seg.k === "text") buf += seg.s;
          else {
            flush();
            out.push(seg);
          }
          i = end + 2;
          continue;
        }
      }
      buf += escapeText(c);
      i++;
    }
    flush();
    return out;

    function harloweMacro(macro: string, args: string, line: number): Seg | null {
      if (macro === "set" || macro === "put") {
        const m = macro === "set" ? /^([$_][\p{L}_][\p{L}\p{N}_]*)\s+to\s+([\s\S]+)$/u.exec(args) : /^([\s\S]+?)\s+into\s+([$_][\p{L}_][\p{L}\p{N}_]*)$/u.exec(args);
        if (!m) {
          s.unsupportedSyntax("twine-macro", `(${macro}: ${args}) は変換できません`, line);
          return { k: "node", node: { k: "comment", text: `(${macro}: ${args})` } };
        }
        const target = macro === "set" ? m[1]! : m[2]!;
        const valueSrc = macro === "set" ? m[2]! : m[1]!;
        const v = variable(target, line);
        const value = expr(valueSrc, line, v);
        if (value === null) return { k: "node", node: { k: "comment", text: `(${macro}: ${args})` } };
        s.count("mapped");
        return { k: "node", node: { k: "set", target: v, op: "=", value } };
      }
      if (macro === "print") {
        const e = expr(args, line);
        if (e === null) return { k: "text", s: "" };
        s.count("mapped");
        return { k: "text", s: `{= ${e}}` };
      }
      if (macro === "goto") return goto(unquoteArg(args));
      if (macro === "link-goto") {
        const a = macroArgs(args);
        s.count("mapped");
        return { k: "link", text: a[0] ?? "", target: a[1] ?? a[0] ?? "" };
      }
      if (macro === "either" || macro === "random") {
        const e = expr(`${macro}(${args})`, line);
        if (e === null) return { k: "text", s: "" };
        s.count("mapped");
        return { k: "text", s: `{= ${e}}` };
      }
      s.unsupportedSyntax("twine-macro", `Harlowe のマクロ (${macro}:) は変換できません`, line);
      return { k: "node", node: { k: "comment", text: `(${macro}: ${args})` } };
    }

    function sugarMacro(body: string, line: number): Seg {
      const m = /^(\/?[=\w-]+)\s*([\s\S]*)$/.exec(body);
      const name = m?.[1] ?? "";
      const args = m?.[2] ?? "";
      if (name === "set") {
        const nodes: Node[] = [];
        for (const part of args.split(/[;,](?=\s*[$_])/)) {
          const a = /^\s*([$_][\p{L}_][\p{L}\p{N}_]*)\s*(to|=|\+=|-=|\*=|\/=)\s*([\s\S]+?)\s*$/u.exec(part);
          const v = a ? variable(a[1]!, line) : null;
          const value = a ? expr(a[3]!, line) : null;
          if (!a || v === null || value === null) {
            if (!a) s.unsupportedSyntax("twine-macro", `<<set ${args}>> は変換できません`, line);
            return { k: "node", node: { k: "comment", text: `<<${body}>>` } };
          }
          nodes.push({ k: "set", target: v, op: (a[2] === "to" ? "=" : a[2]) as "=", value });
        }
        s.count("mapped");
        return { k: "nodes", nodes };
      }
      if (name === "print" || name === "=") {
        const e = expr(args, line);
        if (e === null) return { k: "text", s: "" };
        s.count("mapped");
        return { k: "text", s: `{= ${e}}` };
      }
      if (name === "goto") {
        const a = args.trim();
        return goto(/^\[\[/.test(a) ? parseLink(a.slice(2, -2)).target : unquoteArg(a));
      }
      if (["nobr", "/nobr", "silently", "/silently"].includes(name)) {
        s.count("dropped");
        return { k: "text", s: "" };
      }
      s.unsupportedSyntax("twine-macro", `SugarCube のマクロ <<${name}>> は変換できません`, line);
      return { k: "node", node: { k: "comment", text: `<<${body}>>` } };
    }
  };

  let flagCount = 0;
  /** 部品を Node の並びに。リンクは options に（条件分岐の中なら、その枝を通ったかの印を条件にして）集める。 */
  const toNodes = (segs: readonly Seg[], options: ChoiceNode[], cond: string | null, line: number): Node[] => {
    const out: Node[] = [];
    let buf = "";
    const flush = () => {
      const t = buf.trim();
      if (t) {
        s.stats.prose++;
        out.push({ k: "text", speaker: null, text: t, line });
      }
      buf = "";
    };
    for (const seg of segs) {
      switch (seg.k) {
        case "text":
          buf += seg.s;
          break;
        case "br":
          flush();
          break;
        case "link": {
          // リンクの文は本文に残し（地の文の中のリンク）、選択肢にする
          const p = byName.get(seg.target);
          if (!p) {
            s.unsupportedSyntax("twine-link", `リンク先のパッセージ ${seg.target} がありません`, line);
            break;
          }
          options.push({ text: escapeText(seg.text) || "…", cond, once: false, label: null, body: [{ k: "jump", target: { label: p.label } }], line });
          s.count("mapped");
          break;
        }
        case "node":
          flush();
          out.push(seg.node);
          break;
        case "nodes":
          flush();
          out.push(...seg.nodes);
          break;
        case "if": {
          flush();
          // 枝の中のリンクは、その枝を通ったかの印（temp.twine_l…）で出し分ける（枝の中で条件の変数が変わっても、通った枝のリンクを出す）
          const flags: string[] = [];
          const branches = seg.branches.map((b) => {
            const flag = `temp.twine_l${++flagCount}`;
            const before = options.length;
            const body = toNodes(b.body, options, flag, line);
            if (options.length > before) {
              flags.push(flag);
              body.unshift({ k: "set", target: flag, op: "=", value: "true" });
            }
            return { cond: b.cond, body };
          });
          for (const f of flags) out.push({ k: "set", target: f, op: "=", value: "false" });
          if (branches.some((b) => b.body.length > 0)) out.push({ k: "if", branches });
          break;
        }
      }
    }
    flush();
    return out;
  };

  // ---- 組み立て ----
  const story = passages.filter((p) => !skipped(p));
  const startName = data.start ?? (byName.has("Start") ? "Start" : story.find((p) => p.name !== "StoryInit" && !p.tags.includes("startup"))?.name);
  const start = startName ? byName.get(startName) : undefined;
  const init = story.filter((p) => p.name === "StoryInit" || p.tags.includes("startup"));
  const ordered = [...(start ? [start] : []), ...story.filter((p) => p !== start && !init.includes(p))];
  const sections: Section[] = [];
  // 初期化のパッセージは、始まりのパッセージの前（ファイルの先頭）で実行する
  if (init.length > 0) {
    const body = init.flatMap((p) => {
      s.file = file;
      return toNodes(segments(p.body, p.line + 1), [], null, p.line).filter((n) => n.k !== "text");
    });
    sections.push({ label: null, body: start ? [...body, { k: "jump", target: { label: start.label } }] : body });
  }
  for (const p of ordered) {
    const options: ChoiceNode[] = [];
    const body = toNodes(segments(p.body, p.line + 1), options, null, p.line);
    if (options.length > 0) {
      s.stats.choices++;
      body.push({ k: "choice", options, fallback: null, line: p.line });
    }
    sections.push({ label: p.label, body });
  }
  const lines = lower(sections, { file: name, end: o.end ?? "title", counted: new Map(), onceVariable: (l) => s.gameVariable(`once_${l}`, false), issue: (i) => s.issue(i.severity, i.code, i.message, i.line), english }, new Set(used));
  s.stats.labels = lines.filter((l) => l.startsWith("# ")).length;
  s.issue("info", "twine-format", `物語の書式は ${format === "harlowe" ? "Harlowe" : "SugarCube"} として読みました`, 0);
  const head = [convertedHeader(file, "twine", o.language)];
  if (s.options.variables === "set" && s.variables.size > 0) head.push(...s.variableLines());
  return s.result([{ name, source: file, text: [...head, "", ...lines].join("\n").replace(/\n{3,}/g, "\n\n") + "\n" }]);
}

// ---- 道具 ----

function countLines(text: string): number {
  return (text.match(/\n/g) ?? []).length;
}

/** [[…]] の中身（文->先、先<-文、文|先、先）。 */
function parseLink(inner: string): { text: string; target: string } {
  let m = /^(.*)->(.*)$/s.exec(inner);
  if (m) return { text: m[1]!.trim(), target: m[2]!.trim() };
  m = /^(.*?)<-(.*)$/s.exec(inner);
  if (m) return { text: m[2]!.trim(), target: m[1]!.trim() };
  m = /^(.*)\|(.*)$/s.exec(inner);
  if (m) return { text: m[1]!.trim(), target: m[2]!.trim() };
  return { text: inner.trim(), target: inner.trim() };
}

/** マクロの引数（"…" '…' を一つとして、, か空白で分ける）。 */
function macroArgs(src: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|\[\[(.*?)\]\]|([^\s,]+)/g;
  for (let m = re.exec(src); m; m = re.exec(src)) out.push(m[1] ?? m[2] ?? m[3] ?? m[4]!);
  return out;
}

function unquoteArg(src: string): string {
  return macroArgs(src)[0] ?? "";
}

function literal(src: string): VariableInitial | undefined {
  const t = src.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === "true" || t === "false") return t === "true";
  const m = /^"((?:[^"\\]|\\.)*)"$|^'((?:[^'\\]|\\.)*)'$/.exec(t);
  if (m) return (m[1] ?? m[2]!).replace(/\\(.)/g, "$1");
  return undefined;
}

const TOKEN = /\s+|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\d+(?:\.\d+)?|[$_]?[\p{L}_][\p{L}\p{N}_]*|===|!==|==|!=|<=|>=|&&|\|\||[-+*/%<>()[\],!]|[\s\S]/gu;
const WORDS: Record<Format, Record<string, string>> = {
  harlowe: { and: "&&", or: "||", not: "!", is: "==", true: "true", false: "false" },
  sugarcube: { and: "&&", or: "||", not: "!", is: "==", isnot: "!=", eq: "==", neq: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=", to: "=", true: "true", false: "false", null: "null", undefined: "null" },
};

/** Harlowe・SugarCube の式を .lim の式に。it は Harlowe の (set:) の it（代入する変数）。 */
export function twineExpr(src: string, format: Format, variable: (raw: string) => string, it?: string): string | { error: string } {
  const toks = (src.match(TOKEN) ?? []).filter((x) => !/^\s+$/.test(x));
  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    const next = toks[i + 1];
    if (/^["']/.test(t)) {
      out.push(quote(t.slice(1, -1).replace(/\\(.)/g, "$1")));
      continue;
    }
    if (/^\d/.test(t)) {
      out.push(t);
      continue;
    }
    if (t === "===" || t === "!==") {
      out.push(t.slice(0, 2));
      continue;
    }
    if (/^[$_]/.test(t) && t.length > 1) {
      out.push(variable(t));
      continue;
    }
    if (/^[\p{L}_]/u.test(t)) {
      const w = WORDS[format][t];
      if (format === "harlowe" && t === "is" && next === "not") {
        out.push("!=");
        i++;
        continue;
      }
      if (format === "harlowe" && t === "it" && it) {
        out.push(it);
        continue;
      }
      if (t === "contains" || t === "in") return { error: `${t} は変換できません` };
      if (w !== undefined) {
        if (w === "=") return { error: "式の中の代入は変換できません" };
        out.push(w);
        continue;
      }
      if (next === "(") {
        const f = t.toLowerCase();
        if (f === "random") {
          // SugarCube の random(上限) は 0 以上 上限 以下、random(下限, 上限) は 下限 以上 上限 以下（randint(a, b)）。
          // どちらも小さい方が前でも正しく数えるので（例: random(-5) は -5 以上 0 以下）、式なら min・max で挟む。
          const close = findClose(toks, i + 1);
          if (close < 0) return { error: "括弧が閉じていません" };
          const args = splitArgs(toks.slice(i + 2, close));
          if (format === "harlowe" && args.length !== 2) return { error: "(random:) の引数は二つです" };
          if (format === "sugarcube" && (args.length === 0 || args.length > 2)) return { error: "random() の引数は一つか二つです" };
          const converted = args.map((a) => twineExpr(a.join(" "), format, variable, it));
          const bad = converted.find((a) => typeof a !== "string");
          if (bad) return bad;
          const bounds = (converted as string[]).map((a) => {
            const t = a.replace(/\s+/g, "");
            return /^-?\d+$/.test(t) ? Number(t) : null;
          });
          if (format === "sugarcube" && args.length === 1) {
            const a = converted[0]!;
            const bound = bounds[0];
            out.push(bound != null ? `randint(${Math.min(0, bound)}, ${Math.max(0, bound)})` : `randint(min(0, ${a}), max(0, ${a}))`);
            i = close;
            continue;
          }
          const [a, b] = converted as [string, string];
          const [b0, b1] = bounds;
          const [lo, hi] = b0 != null && b1 != null ? [Math.min(b0, b1), Math.max(b0, b1)] : [a, b];
          out.push(b0 != null && b1 != null ? `randint(${lo}, ${hi})` : `randint(min(${a}, ${b}), max(${a}, ${b}))`);
          i = close;
          continue;
        }
        if (f === "either") {
          // either(a, b) は pick([a, b])
          const close = findClose(toks, i + 1);
          if (close < 0) return { error: "括弧が閉じていません" };
          const inner = twineExpr(`[${toks.slice(i + 2, close).join(" ")}]`, format, variable, it);
          if (typeof inner !== "string") return inner;
          out.push(`pick(${inner})`);
          i = close;
          continue;
        }
        if (["min", "max", "round", "floor", "ceil", "abs"].includes(f)) {
          out.push(f);
          continue;
        }
        return { error: `関数 ${t}() は変換できません` };
      }
      return { error: `${t} は読めません（変数は $ か _ で始めます）` };
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

function findClose(toks: readonly string[], open: number): number {
  let d = 0;
  for (let j = open; j < toks.length; j++) {
    if (toks[j] === "(") d++;
    else if (toks[j] === ")" && --d === 0) return j;
  }
  return -1;
}

/** 引数ごとに分ける（深さ 0 の , で分ける。空なら一つも無い）。 */
function splitArgs(toks: readonly string[]): string[][] {
  const out: string[][] = [[]];
  let d = 0;
  for (const t of toks) {
    if (t === "(" || t === "[" || t === "{") d++;
    else if (t === ")" || t === "]" || t === "}") d--;
    if (t === "," && d === 0) out.push([]);
    else out.at(-1)!.push(t);
  }
  return out.filter((a) => a.length > 0);
}
