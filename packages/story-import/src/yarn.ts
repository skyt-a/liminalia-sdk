import type { VariableInitial } from "@liminalia/project";
import { convertExpr, type ExprEnv } from "./expr.ts";
import { englishStory, escapeText, lower, type ChoiceNode, type Node, type Section, type Target } from "./ir.ts";
import { convertedHeader, labelName, limFileName, Session, splitSpeaker, type StoryFile, type StoryImportOptions, type StoryImportResult } from "./session.ts";

/**
 * Yarn Spinner 2 の .yarn を .lim にする。複数のファイルは一つのプロジェクトとして扱い（ノードの名前は共通）、ファイルごとに .lim を作る。
 *
 * 変換するもの: ノード（`title:` 〜 `---` 〜 `===`）はラベル（Start という名前のノードをファイルの先頭に）、`名前: 台詞` の台詞、
 * 選択肢 `->`（字下げした中身、`<<if 条件>>`）、`<<jump>>` はジャンプ、`<<detour>>` と `<<return>>` は @call と @return、`<<stop>>` は終わり、
 * `<<declare>>` と `<<set>>`（to = += -= *= /=）、`<<if>> <<elseif>> <<else>> <<endif>>`、本文の `{$変数}` と `{式}`、
 * マークアップの [b] [i] [wave] [shake] [pause=… /] [nomarkup]、`#line:` の行の ID（書き出さない）、ほかのコマンドとハッシュタグ（対応表）。
 * `<<once>>`（ブロック・行・選択肢）は一度出したかの変数、行のグループ `=>` は出せる行から乱数で一つ選ぶ形にする。
 * 変換しないもの（報告に出す）: 式のジャンプ、関数の呼び出しの多く、[select] などの置き換えのマークアップ。
 */
export interface YarnSource {
  /** 報告に出すファイル名（.lim のファイル名はここから作る）。 */
  file: string;
  text: string;
}

interface YLine {
  indent: number;
  text: string;
  line: number;
}

interface YNode {
  title: string;
  label: string;
  file: string;
  limFile: string;
  line: number;
  body: YLine[];
}

const COMMAND = /^<<\s*([\s\S]*?)\s*>>$/;

export function importYarn(sources: readonly YarnSource[], o: StoryImportOptions = {}): StoryImportResult {
  const s = new Session(o);
  // 英語の作品なら、括弧の無い台詞を "" で囲む
  const english = englishStory(...sources.map((x) => x.text));

  // ---- ノードに分ける ----
  const nodes: YNode[] = [];
  const fileNames = new Map<string, string>();
  const usedFiles = new Set<string>();
  const usedLabels = new Map<string, Set<string>>();
  for (const src of sources) {
    let lim = sources.length === 1 && o.name ? o.name : limFileName(src.file);
    for (let i = 2; usedFiles.has(lim); i++) lim = `${limFileName(src.file)}_${i}`;
    usedFiles.add(lim);
    fileNames.set(src.file, lim);
    usedLabels.set(lim, new Set());
    s.file = src.file;
    const rows = src.text.replace(/\r\n?/g, "\n").split("\n");
    let header: Record<string, string> | null = {};
    let cur: YNode | null = null;
    let headerLine = 1;
    rows.forEach((raw, i) => {
      const lineNo = i + 1;
      const text = stripComment(raw);
      if (cur === null) {
        const t = text.trim();
        if (t === "---") {
          const title = header?.title;
          if (!title) {
            s.unsupportedSyntax("yarn-no-title", "title: の無いノードは変換できません", lineNo);
            cur = { title: "", label: "", file: src.file, limFile: lim, line: lineNo, body: [] };
            return;
          }
          const labels = usedLabels.get(lim)!;
          let label = labelName(title);
          for (let n = 2; labels.has(label); n++) label = `${labelName(title)}_${n}`;
          labels.add(label);
          cur = { title, label, file: src.file, limFile: lim, line: headerLine, body: [] };
          return;
        }
        if (t === "") return;
        const m = /^([\p{L}\p{N}_-]+)\s*:\s*(.*)$/u.exec(t);
        if (m) {
          if (Object.keys(header ?? {}).length === 0) headerLine = lineNo;
          header = { ...header, [m[1]!.toLowerCase()]: m[2]!.trim() };
        }
        return;
      }
      if (text.trim() === "===") {
        if (cur.title) nodes.push(cur);
        cur = null;
        header = {};
        return;
      }
      const indent = /^[ \t]*/.exec(text)![0].replace(/\t/g, "    ").length;
      cur.body.push({ indent, text: text.trim(), line: lineNo });
    });
    const open = cur as YNode | null;
    if (open !== null) {
      s.issue("warning", "yarn-unclosed-node", `ノード ${open.title} が === で閉じていません（ファイルの終わりまでを中身にします）`, open.line);
      if (open.title) nodes.push(open);
    }
  }
  const byTitle = new Map<string, YNode>();
  for (const n of nodes) {
    if (byTitle.has(n.title)) {
      s.file = n.file;
      s.issue("warning", "yarn-duplicate-node", `ノード ${n.title} が二つあります（先のものを使います）`, n.line);
      continue;
    }
    byTitle.set(n.title, n);
  }

  // ---- 変数（<<declare>> と、宣言の無い <<set>> の値から） ----
  const vars = new Map<string, string>();
  const declared = new Set<string>();
  for (const n of nodes) {
    for (const l of n.body) {
      const m = COMMAND.exec(l.text)?.[1];
      if (!m) continue;
      const d = /^declare\s+\$([\p{L}_][\p{L}\p{N}_]*)\s*(?:=|to)\s*(.+?)(?:\s+as\s+\w+)?$/u.exec(m);
      if (d) {
        s.file = n.file;
        const v = literal(d[2]!);
        if (v === undefined) s.unsupportedSyntax("yarn-declare", `<<declare>> の初期値 ${d[2]} は変換できません（数、文字列、真偽だけ）`, l.line);
        vars.set(d[1]!, s.declare(d[1]!, v ?? 0));
        declared.add(d[1]!);
      }
    }
  }
  for (const n of nodes) {
    for (const l of n.body) {
      const m = COMMAND.exec(l.text)?.[1];
      const st = m ? /^set\s+\$([\p{L}_][\p{L}\p{N}_]*)\s*(?:to|=)\s*(.+)$/u.exec(m) : null;
      if (!st || vars.has(st[1]!)) continue;
      const v = literal(st[2]!);
      const initial: VariableInitial = typeof v === "string" ? "" : typeof v === "boolean" ? false : 0;
      vars.set(st[1]!, s.declare(st[1]!, initial));
      s.file = n.file;
      s.issue("info", "yarn-undeclared", `$${st[1]} は <<declare>> されていないので、初期値を ${JSON.stringify(initial)} にしました`, l.line);
    }
  }

  const counted = new Map<string, string>();
  const visitVar = (title: string): string | null => {
    const n = byTitle.get(title);
    if (!n) return null;
    const key = `${n.limFile}#${n.label}`;
    let v = counted.get(key);
    if (!v) {
      v = s.gameVariable(`seen_${n.label}`, 0);
      counted.set(key, v);
    }
    return v;
  };
  const envFor = (line: number): ExprEnv => ({
    lang: "yarn",
    variable: (name) => {
      const v = vars.get(name);
      if (v) return v;
      const made = s.declare(name, 0);
      vars.set(name, made);
      s.issue("info", "yarn-undeclared", `$${name} は宣言されていないので、初期値を 0 にしました`, line);
      return made;
    },
    visits: visitVar,
    fail: (m) => s.unsupportedSyntax("yarn-expression", m, line),
  });
  const expr = (src: string, line: number) => convertExpr(src, envFor(line));

  // ---- 本文 ----

  const MARKUP: Record<string, (inner: string) => string> = {
    b: (x) => `{b ${x}}`,
    i: (x) => `{i ${x}}`,
    wave: (x) => `{fx wave ${x}}`,
    shake: (x) => `{fx shake ${x}}`,
  };

  /** 本文（マークアップと {式}）を .lim の本文にする。 */
  const text = (raw: string, line: number): string | null => {
    let i = 0;
    let failed = false;
    const seq = (closing: string | null): string => {
      let out = "";
      while (i < raw.length) {
        const c = raw[i]!;
        if (c === "\\" && i + 1 < raw.length) {
          out += escapeText(raw[i + 1]!);
          i += 2;
          continue;
        }
        if (c === "{") {
          const end = raw.indexOf("}", i);
          if (end < 0) {
            s.unsupportedSyntax("yarn-brace", `{ が閉じていません: ${raw}`, line);
            failed = true;
            return out;
          }
          const e = expr(raw.slice(i + 1, end), line);
          if (e === null) failed = true;
          else out += `{= ${e}}`;
          i = end + 1;
          continue;
        }
        if (c === "[") {
          const end = raw.indexOf("]", i);
          const tag = end < 0 ? "" : raw.slice(i + 1, end).trim();
          if (end < 0 || tag === "") {
            out += escapeText(c);
            i++;
            continue;
          }
          i = end + 1;
          if (tag.startsWith("/")) {
            // 閉じるマークアップ（[/] はすべて）
            if (closing !== null) return out;
            continue;
          }
          const selfClosing = tag.endsWith("/");
          const m = /^([\p{L}_][\p{L}\p{N}_-]*)\s*(?:=\s*("[^"]*"|\S+))?/u.exec(tag.replace(/\/$/, "").trim());
          const name = m?.[1]?.toLowerCase() ?? "";
          const value = m?.[2]?.replace(/^"|"$/g, "");
          if (selfClosing) {
            if (name === "pause" && value && /^\d+$/.test(value)) {
              out += `{@wait ${value}ms}`;
              s.count("mapped");
            } else {
              s.unsupportedSyntax("yarn-markup", `マークアップ [${tag}] は変換できません`, line);
            }
            continue;
          }
          if (name === "nomarkup") {
            const close = raw.indexOf("[/nomarkup]", i);
            const lit = close < 0 ? raw.slice(i) : raw.slice(i, close);
            out += escapeText(lit);
            i = close < 0 ? raw.length : close + "[/nomarkup]".length;
            continue;
          }
          const inner = seq(name);
          const f = MARKUP[name];
          if (f) {
            s.count("mapped");
            out += inner === "" ? "" : f(inner);
          } else {
            s.count("dropped");
            s.issue("info", "yarn-markup", `マークアップ [${name}] は変換できないので、中の文字だけを残しました`, line);
            out += inner;
          }
          continue;
        }
        out += escapeText(c);
        i++;
      }
      return out;
    };
    const out = seq(null);
    return failed ? null : out;
  };

  /** 行末の #タグ（# の前が空白のもの）と <<if 条件>>・<<once>>・<<once if 条件>> を分ける。 */
  const splitTail = (raw: string): { body: string; tags: string[]; cond: string | null; once: boolean } => {
    let body = raw;
    let cond: string | null = null;
    let once = false;
    for (;;) {
      const c = /<<\s*(once\s*)?(?:if\s+([\s\S]+?))?\s*>>\s*$/.exec(body);
      if (!c || (!c[1] && !c[2])) break;
      if (c[1]) once = true;
      if (c[2]) cond = cond === null ? c[2] : `(${c[2]}) and (${cond})`;
      body = body.slice(0, c.index);
    }
    const tags: string[] = [];
    for (;;) {
      const m = /(^|\s)#([^\s#]+)\s*$/.exec(body);
      if (!m || body[m.index + m[1]!.length - 1] === "\\") break;
      tags.unshift(m[2]!);
      body = body.slice(0, m.index);
    }
    return { body: body.trim(), tags, cond, once };
  };

  /** 一度だけの印の変数（<<once>>。ノードごとに番号を振る）。 */
  const onceVar = (from: YNode) => s.gameVariable(`once_${from.label}`, false);
  /** 条件（.lim の式か null）に「まだ出していない」を足す。 */
  const notYet = (v: string, cond: string | null) => (cond === null ? `!${v}` : `!${v} && (${cond})`);

  const tagNodes = (tags: readonly string[], line: number): Node[] =>
    tags.flatMap((t) => {
      if (/^line:/.test(t)) {
        s.count("dropped");
        return [];
      }
      return s.command(t, line, "タグ");
    });

  const targetOf = (title: string, from: YNode, line: number): Target | null => {
    const n = byTitle.get(title.trim());
    if (!n) {
      s.unsupportedSyntax("yarn-jump", `ノード ${title} がありません`, line);
      return null;
    }
    return n.limFile === from.limFile ? { label: n.label } : { file: n.limFile, label: n.label };
  };

  const commandNodes = (cmd: string, from: YNode, line: number): Node[] => {
    let m = /^jump\s+(.+)$/.exec(cmd);
    if (m) {
      if (m[1]!.trim().startsWith("{")) {
        s.unsupportedSyntax("yarn-jump", `式のジャンプ <<${cmd}>> は変換できません`, line);
        return [{ k: "comment", text: `<<${cmd}>>` }];
      }
      const t = targetOf(m[1]!, from, line);
      if (!t) return [{ k: "comment", text: `<<${cmd}>>` }];
      s.count("mapped");
      return [{ k: "jump", target: t }];
    }
    m = /^detour\s+(.+)$/.exec(cmd);
    if (m) {
      const t = targetOf(m[1]!, from, line);
      if (!t) return [{ k: "comment", text: `<<${cmd}>>` }];
      s.count("mapped");
      return [{ k: "call", target: t }];
    }
    if (cmd === "stop") {
      s.count("mapped");
      return [{ k: "end" }];
    }
    if (cmd === "return") {
      s.count("mapped");
      return [{ k: "return" }];
    }
    if (/^declare\b/.test(cmd)) {
      s.count("mapped");
      return [];
    }
    m = /^set\s+\$([\p{L}_][\p{L}\p{N}_]*)\s*(to|=|\+=|-=|\*=|\/=)\s*(.+)$/u.exec(cmd);
    if (m) {
      const value = expr(m[3]!, line);
      const target = vars.get(m[1]!) ?? s.declare(m[1]!, 0);
      if (value === null) return [{ k: "comment", text: `<<${cmd}>>` }];
      s.count("mapped");
      const op = (m[2] === "to" ? "=" : m[2]) as "=" | "+=" | "-=" | "*=" | "/=";
      return [{ k: "set", target, op, value }];
    }
    if (/^(endonce|else)\b/.test(cmd)) {
      s.unsupportedSyntax("yarn-once", `<<${cmd}>> に対応する <<once>> がありません`, line);
      return [{ k: "comment", text: `<<${cmd}>>` }];
    }
    return s.command(cmd, line, "コマンド");
  };

  const lineNodes = (raw: string, line: number, from: YNode): Node[] => {
    const { body, tags, cond, once } = splitTail(raw);
    const out = tagNodes(tags, line);
    let speaker: string | null = null;
    let rest = body;
    const sp = splitSpeaker(body);
    if (sp && !/[{[]/.test(sp.name)) {
      speaker = sp.name;
      rest = sp.body;
    }
    const lim = text(rest, line);
    if (lim === null) out.push({ k: "comment", text: raw });
    else if (lim !== "") {
      if (speaker !== null) {
        s.speaker(speaker);
        s.stats.says++;
      } else s.stats.prose++;
      out.push({ k: "text", speaker, text: lim, line });
    }
    const c = cond === null ? null : expr(cond, line);
    if (once) {
      // 行の <<once>>: 一度出したら出さない
      const v = onceVar(from);
      s.count("mapped");
      return [{ k: "if", branches: [{ cond: notYet(v, c), body: [{ k: "set", target: v, op: "=", value: "true" }, ...out] }] }];
    }
    if (c === null) return out;
    return [{ k: "if", branches: [{ cond: c, body: out }] }];
  };

  /**
   * 行のグループ（=> の並び）。出せる行（<<if>> が真で、<<once>> ならまだ出していない）から一つを選んで出す。
   * Yarn Spinner の既定の選び方（条件の多いものを優先し、最近出していないもの）ではなく、出せる行から乱数で選ぶ。
   */
  const lineGroup = (from: YNode, lines: readonly YLine[], pos: { i: number }, ends: ReadonlySet<string>): Node[] => {
    const indent = lines[pos.i]!.indent;
    const entries: { cond: string | null; body: Node[] }[] = [];
    while (pos.i < lines.length) {
      const o = lines[pos.i]!;
      if (o.text === "") {
        pos.i++;
        continue;
      }
      if (!o.text.startsWith("=>") || o.indent !== indent) break;
      pos.i++;
      const children = block(from, lines, pos, indent, ends);
      const t = splitTail(o.text.slice(2).trim());
      let c = t.cond === null ? null : expr(t.cond, o.line);
      const pre: Node[] = [];
      if (t.once) {
        const v = onceVar(from);
        c = notYet(v, c);
        pre.push({ k: "set", target: v, op: "=", value: "true" });
      }
      const line = lineNodes(`${t.body}${t.tags.map((x) => ` #${x}`).join("")}`, o.line, from);
      s.count("mapped");
      entries.push({ cond: c, body: [...pre, ...line, ...children] });
    }
    const pick = "temp.yarn_pick";
    const out: Node[] = [];
    if (entries.every((e) => e.cond === null)) out.push({ k: "set", target: pick, op: "=", value: `random(${entries.length})` });
    else {
      out.push({ k: "set", target: pick, op: "=", value: "[]" });
      entries.forEach((e, i) => {
        const add: Node = { k: "set", target: pick, op: "=", value: `push(${pick}, ${i})` };
        out.push(e.cond === null ? add : { k: "if", branches: [{ cond: e.cond, body: [add] }] });
      });
      out.push({ k: "set", target: pick, op: "=", value: `pick(${pick})` });
    }
    out.push({ k: "if", branches: entries.map((e, i) => ({ cond: `${pick} == ${i}`, body: e.body })) });
    return out;
  };

  /** 字下げで中身を決める。stop より字下げの浅い行と、ends のコマンドで止まる。 */
  const block = (from: YNode, lines: readonly YLine[], pos: { i: number }, stop: number | null, ends: ReadonlySet<string>): Node[] => {
    const out: Node[] = [];
    while (pos.i < lines.length) {
      const l = lines[pos.i]!;
      if (l.text === "") {
        pos.i++;
        continue;
      }
      if (stop !== null && l.indent <= stop) return out;
      const cmd = COMMAND.exec(l.text)?.[1];
      const head = cmd?.split(/\s/)[0] ?? "";
      if (cmd !== undefined && ends.has(head)) return out;
      if (cmd !== undefined && head === "if") {
        pos.i++;
        const branches: { cond: string | null; body: Node[] }[] = [];
        let cond: string | null = expr(cmd.slice(2).trim(), l.line) ?? "false";
        for (;;) {
          const body = block(from, lines, pos, stop, IF_ENDS);
          branches.push({ cond, body });
          const end = lines[pos.i];
          const endCmd = end ? COMMAND.exec(end.text)?.[1] : undefined;
          if (!end || endCmd === undefined) {
            s.issue("warning", "yarn-unclosed-if", "<<if>> が <<endif>> で閉じていません", l.line);
            break;
          }
          pos.i++;
          const h = endCmd.split(/\s/)[0];
          if (h === "endif") break;
          if (h === "else") cond = null;
          else cond = expr(endCmd.slice("elseif".length).trim(), end.line) ?? "false";
        }
        s.count("mapped");
        out.push({ k: "if", branches });
        continue;
      }
      if (cmd !== undefined && head === "once") {
        // <<once>> 〜 <<endonce>>（<<once if 条件>>、<<else>>）: 一度出したら、次からは <<else>> の中身
        pos.i++;
        const m = /^once(?:\s+if\s+([\s\S]+))?$/.exec(cmd);
        const c = m?.[1] ? (expr(m[1], l.line) ?? "false") : null;
        const v = onceVar(from);
        const body = block(from, lines, pos, stop, ONCE_ENDS);
        let otherwise: Node[] | null = null;
        const close = () => {
          const end = lines[pos.i];
          const endCmd = end ? COMMAND.exec(end.text)?.[1] : undefined;
          if (!end || endCmd === undefined) {
            s.issue("warning", "yarn-unclosed-once", "<<once>> が <<endonce>> で閉じていません", l.line);
            return null;
          }
          pos.i++;
          return endCmd.split(/\s/)[0];
        };
        if (close() === "else") {
          otherwise = block(from, lines, pos, stop, ENDONCE);
          close();
        }
        s.count("mapped");
        out.push({ k: "if", branches: [{ cond: notYet(v, c), body: [{ k: "set", target: v, op: "=", value: "true" }, ...body] }, ...(otherwise ? [{ cond: null, body: otherwise }] : [])] });
        continue;
      }
      if (l.text.startsWith("->")) {
        const indent = l.indent;
        const options: ChoiceNode[] = [];
        while (pos.i < lines.length) {
          const o = lines[pos.i]!;
          if (o.text === "") {
            pos.i++;
            continue;
          }
          if (!o.text.startsWith("->") || o.indent !== indent) break;
          pos.i++;
          const body = block(from, lines, pos, indent, ends);
          const { body: optText, tags, cond, once } = splitTail(o.text.slice(2).trim());
          const named = splitSpeaker(optText);
          const shown = text(named && !/[{[]/.test(named.name) ? named.body : optText, o.line);
          let c = cond === null ? null : expr(cond, o.line);
          if (shown === null) continue;
          const pre: Node[] = [];
          if (once) {
            // 選択肢の <<once>>: 一度選んだら出さない
            const v = onceVar(from);
            c = notYet(v, c);
            pre.push({ k: "set", target: v, op: "=", value: "true" });
          }
          s.count("mapped");
          options.push({ text: shown || "…", cond: c, once: false, label: null, body: [...pre, ...tagNodes(tags, o.line), ...body], line: o.line });
        }
        s.stats.choices++;
        out.push({ k: "choice", options, fallback: null, line: l.line });
        continue;
      }
      if (l.text.startsWith("=>")) {
        out.push(...lineGroup(from, lines, pos, ends));
        continue;
      }
      pos.i++;
      if (cmd !== undefined) {
        out.push(...commandNodes(cmd, from, l.line));
        continue;
      }
      out.push(...lineNodes(l.text, l.line, from));
    }
    return out;
  };

  // ---- ファイルごとに組み立てる ----
  const files: StoryFile[] = [];
  // 訪れた回数の変数はどのファイルの式からも作られるので、すべてのファイルを読んでから書き出す
  const perFile = sources.map((src) => {
    s.file = src.file;
    const mine = nodes.filter((n) => n.file === src.file && byTitle.get(n.title) === n);
    const start = mine.findIndex((n) => n.title.toLowerCase() === "start");
    if (start > 0) mine.unshift(...mine.splice(start, 1));
    const sections: Section[] = mine.map((n) => {
      s.file = n.file;
      return { label: n.label, body: block(n, n.body, { i: 0 }, null, NO_ENDS) };
    });
    return { src, sections };
  });
  for (const { src, sections } of perFile) {
    const lim = fileNames.get(src.file)!;
    s.file = src.file;
    const used = new Set(usedLabels.get(lim));
    const fileCounted = new Map([...counted].flatMap(([k, v]) => (k.startsWith(`${lim}#`) ? [[k.slice(lim.length + 1), v] as const] : [])));
    const lines = lower(
      sections,
      { file: lim, end: o.end ?? "title", counted: fileCounted, onceVariable: (l) => s.gameVariable(`once_${l}`, false), issue: (i) => s.issue(i.severity, i.code, i.message, i.line), english },
      used,
    );
    files.push({ name: lim, source: src.file, text: lines.join("\n") });
  }
  s.stats.labels = files.reduce((a, f) => a + f.text.split("\n").filter((l) => l.startsWith("# ")).length, 0);
  // 変数の初期値（set のときは、Start のあるファイルか最初のファイルの先頭に）
  const head = (f: StoryFile, i: number) => {
    const h = [convertedHeader(f.source, "yarn", o.language)];
    const first = files.findIndex((x) => /^# start$/im.test(x.text.split("\n")[0] ?? ""));
    if (s.options.variables === "set" && i === (first < 0 ? 0 : first) && s.variables.size > 0) h.push(...s.variableLines());
    return `${[...h, "", f.text].join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
  };
  return s.result(files.map((f, i) => ({ ...f, text: head(f, i) })));
}

const IF_ENDS = new Set(["elseif", "else", "endif"]);
const ONCE_ENDS = new Set(["else", "endonce"]);
const ENDONCE = new Set(["endonce"]);
const NO_ENDS = new Set<string>();

/** 行のコメント（// から後ろ。"…" の中と \/ は除く）を除く。 */
function stripComment(raw: string): string {
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === '"') quoted = !quoted;
    if (!quoted && raw.startsWith("//", i)) return raw.slice(0, i).replace(/\s+$/, "");
  }
  return raw.replace(/\s+$/, "");
}

function literal(src: string): VariableInitial | undefined {
  const t = src.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === "true" || t === "false") return t === "true";
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(t);
  if (m) return m[1]!.replace(/\\(.)/g, "$1");
  return undefined;
}
