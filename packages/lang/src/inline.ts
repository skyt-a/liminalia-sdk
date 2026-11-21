import { TEXT_EFFECTS, TEXT_VARIANTS, type DiagnosticFix, type Inline, type TextEffect, type TextVariantMode } from "./ast.ts";
import { parseArgs, printLiteral } from "./args.ts";
import { ExprError, parseExpr } from "./expr.ts";

export interface InlineError {
  code: string;
  message: string;
  /** 本文の先頭からの位置（0 始まり、UTF-16）。 */
  offset: number;
  hint?: string;
  /** 省くとエラー。読み方は分かるが直したほうがよいもの（全角の記号など）は警告。 */
  severity?: "warning";
  /** 行に当てられる直し方。 */
  fix?: DiagnosticFix;
}

/**
 * 本文を解析する。特殊なのは `{` `}` `\` だけで、`{` は必ず書き方の始まりになる。
 * 本文に `{` `}` `\` を出したいときは `\{` `\}` `\\` と書く。
 *
 * - `{r 漢字|かんじ}` ルビ
 * - `{= 式}` 値の埋め込み
 * - `{click}` 行の途中のクリック待ち
 * - `{noclick}` 行の終わりでクリックを待たずに次へ進む（行の最後にだけ書ける。構文解析が確かめる）
 * - `{br}` 同じページの中での改行
 * - `{speed 600ms ……}` 囲んだ部分だけ文字を出す速さを変える
 * - `{@chara ユイカ smile}` 本文がその位置まで出たときに命令を実行する
 * - `{b …}` `{i …}` 太字・斜体、`{c #rrggbb …}` 色（中に他の書き方を入れられる）
 * - `{size 32 …}` 文字の大きさ（px）、`{mark #rrggbb …}` 蛍光ペンのような背景色
 * - `{fx wave …}` 文字の動き（shake 震え・wave 波打つ・pop 弾んで出る・fade じわりと出る・glow 光る）。
 *   名前のあとに strength=（動きの大きさの倍率）と speed=（速さの倍率）を書ける（`{fx wave strength=2 speed=0.5 …}`）
 * - `{seq a|b|c}` `{cycle …}` `{once …}` `{shuffle …}` 本文の出し分け（通るたびに | で区切ったどれかを出す）。| を文字で出すなら \|
 *
 * column は src の頭の字の、行の中の桁（1 から）。本文の中の命令の桁と引数の桁（Argument.column）を行の桁にする（診断と直し方が指す所）。
 */
export function parseInline(src: string, column = 1): { content: Inline[]; errors: InlineError[] } {
  const errors: InlineError[] = [];
  let i = 0;

  /** closing のときは対応する } を読んで止まる。閉じられたかどうかも返す。bar なら | でも止まる（出し分けの区切り）。 */
  const parseSeq = (closing: boolean, bar = false): { nodes: Inline[]; closed: boolean; bar?: true } => {
    const out: Inline[] = [];
    let text = "";
    const flush = () => {
      if (text !== "") out.push({ kind: "text", text });
      text = "";
    };
    while (i < src.length) {
      const c = src[i]!;
      if (c === "\\") {
        const e = src[i + 1];
        if (e === undefined) {
          errors.push({ code: "dangling-escape", message: "行末の \\ は何もエスケープしていません", offset: i, hint: "\\ を表示するなら \\\\ と書きます" });
          i++;
          continue;
        }
        text += e;
        i += 2;
        continue;
      }
      if (bar && c === "|") {
        flush();
        i++;
        return { nodes: out, closed: false, bar: true };
      }
      if (c === "}") {
        if (closing) {
          flush();
          i++;
          return { nodes: out, closed: true };
        }
        errors.push({ code: "stray-brace", message: "対応する { のない } です", offset: i, hint: "} を本文に表示するなら \\} と書きます" });
        i++;
        continue;
      }
      if (c === "{") {
        flush();
        const element = parseElement();
        if (element) out.push(element);
        continue;
      }
      text += c;
      i++;
    }
    flush();
    return { nodes: out, closed: false };
  };

  /** i は `{` を指している。 */
  const parseElement = (): Inline | null => {
    const start = i;
    i++;
    if (src[i] === "=") {
      i++;
      const exprStart = i;
      let quoted = false;
      // 式の中の辞書のリテラル {…} の } では閉じない
      let depth = 0;
      while (i < src.length && (quoted || depth > 0 || src[i] !== "}")) {
        if (src[i] === "\\" && quoted) i++;
        else if (src[i] === '"') quoted = !quoted;
        else if (!quoted && src[i] === "{") depth++;
        else if (!quoted && src[i] === "}") depth--;
        i++;
      }
      if (i >= src.length) return unclosed(start);
      const source = src.slice(exprStart, i).trim();
      i++;
      try {
        return { kind: "value", expr: parseExpr(source), source };
      } catch (e) {
        const offset = e instanceof ExprError ? exprStart + e.offset : exprStart;
        errors.push({ code: "bad-expression", message: e instanceof Error ? e.message : String(e), offset });
        return null;
      }
    }

    if (src[i] === "@") {
      // 命令。"…" と (…) の中の } では閉じない。
      const bodyStart = i + 1;
      let quoted = false;
      let depth = 0;
      while (i < src.length && (quoted || depth > 0 || src[i] !== "}")) {
        if (quoted && src[i] === "\\") i++;
        else if (src[i] === '"') quoted = !quoted;
        else if (!quoted && src[i] === "(") depth++;
        else if (!quoted && src[i] === ")") depth--;
        i++;
      }
      if (i >= src.length) return unclosed(start);
      const body = src.slice(bodyStart, i);
      i++;
      const m = /^([a-z][a-z0-9-]*)(?: (.*))?$/s.exec(body);
      if (!m) {
        errors.push({ code: "bad-command-name", message: `コマンド名に使えるのは英小文字、数字、- だけです: {@${body}}`, offset: start });
        return null;
      }
      const argsText = m[2] ?? "";
      const argsOffset = bodyStart + m[1]!.length + 1;
      const parsed = parseArgs(argsText, column + argsOffset);
      for (const e of parsed.errors) errors.push({ code: e.code, message: e.message, offset: argsOffset + e.offset, ...(e.severity ? { severity: e.severity } : {}), ...(e.fix ? { fix: e.fix } : {}) });
      return { kind: "command", name: m[1]!, args: parsed.args, column: column + bodyStart - 1 };
    }

    const keyword = /^[a-z]+/.exec(src.slice(i))?.[0] ?? "";
    const after = src[i + keyword.length];
    if (keyword === "click" && after === "}") {
      i += keyword.length + 1;
      return { kind: "click" };
    }
    if (keyword === "noclick" && after === "}") {
      i += keyword.length + 1;
      return { kind: "noclick" };
    }
    if (keyword === "br" && after === "}") {
      i += keyword.length + 1;
      return { kind: "br" };
    }
    if ((keyword === "b" || keyword === "i") && after === " ") {
      i += 2;
      const { nodes, closed } = parseSeq(true);
      if (!closed) return unclosed(start);
      return { kind: "style", style: keyword === "b" ? "bold" : "italic", children: nodes };
    }
    if (keyword === "speed" && after === " ") {
      i += keyword.length + 1;
      const d = /^(\d+(?:\.\d+)?)(ms|s)(?= )/.exec(src.slice(i));
      if (!d) {
        errors.push({ code: "bad-speed", message: "{speed の直後には一文字あたりの時間が必要です", offset: i, hint: "{speed 600ms ……}" });
        skipTo("}");
        return null;
      }
      i += d[0].length + 1;
      const { nodes, closed } = parseSeq(true);
      if (!closed) return unclosed(start);
      return { kind: "speed", perChar: Number(d[1]) * (d[2] === "s" ? 1000 : 1), source: d[0], children: nodes };
    }
    if (keyword === "c" && after === " ") {
      i += 2;
      const color = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?= )/.exec(src.slice(i))?.[0];
      if (!color) {
        errors.push({ code: "bad-color", message: "{c の直後には #rgb / #rrggbb / #rrggbbaa の色が必要です", offset: i, hint: "{c #cc3333 本文}" });
        skipTo("}");
        return null;
      }
      i += color.length + 1;
      const { nodes, closed } = parseSeq(true);
      if (!closed) return unclosed(start);
      return { kind: "color", color: color.toLowerCase(), children: nodes };
    }
    if (keyword === "size" && after === " ") {
      i += keyword.length + 1;
      const n = /^\d+(?:\.\d+)?(?= )/.exec(src.slice(i))?.[0];
      if (!n || Number(n) <= 0) {
        errors.push({ code: "bad-size", message: "{size の直後には文字サイズ（px の正の数）が必要です", offset: i, hint: "{size 32 本文}" });
        skipTo("}");
        return null;
      }
      i += n.length + 1;
      const { nodes, closed } = parseSeq(true);
      if (!closed) return unclosed(start);
      return { kind: "size", size: Number(n), children: nodes };
    }
    if (keyword === "mark" && after === " ") {
      i += keyword.length + 1;
      const color = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?= )/.exec(src.slice(i))?.[0];
      if (!color) {
        errors.push({ code: "bad-color", message: "{mark の直後には #rgb / #rrggbb / #rrggbbaa の色が必要です", offset: i, hint: "{mark #ffff00 本文}" });
        skipTo("}");
        return null;
      }
      i += color.length + 1;
      const { nodes, closed } = parseSeq(true);
      if (!closed) return unclosed(start);
      return { kind: "mark", color: color.toLowerCase(), children: nodes };
    }
    if (keyword === "dot" && after === " ") {
      i += keyword.length + 1;
      const { nodes, closed } = parseSeq(true);
      if (!closed) return unclosed(start);
      return { kind: "emphasis", children: nodes };
    }
    if (keyword === "img" && after === " ") {
      i += keyword.length + 1;
      const m = /^([^\s{}]+)(?: (\d+(?:\.\d+)?))?\}/.exec(src.slice(i));
      if (!m || (m[2] !== undefined && Number(m[2]) <= 0)) {
        errors.push({ code: "bad-image", message: "{img の直後には画像（image フォルダからのパス）と、省けば高さ（px）を書きます", offset: i, hint: "{img icons/heart.png} か {img icons/heart.png 32}" });
        skipTo("}");
        return null;
      }
      const at = column + i;
      i += m[0].length;
      return { kind: "image", path: m[1]!, ...(m[2] !== undefined ? { height: Number(m[2]) } : {}), column: at };
    }
    if (keyword === "fx" && after === " ") {
      i += keyword.length + 1;
      const name = /^[a-z]+(?= )/.exec(src.slice(i))?.[0];
      if (!name || !(TEXT_EFFECTS as readonly string[]).includes(name)) {
        errors.push({ code: "bad-fx", message: `{fx の直後には文字の動き（${TEXT_EFFECTS.join("、")}）が必要です`, offset: i, hint: "{fx wave 本文}" });
        skipTo("}");
        return null;
      }
      i += name.length + 1;
      // 動きの大きさ（strength=）と速さ（speed=）。この順に、どちらも省ける
      const tune: { strength?: number; speed?: number } = {};
      for (const key of ["strength", "speed"] as const) {
        const m = new RegExp(`^${key}=([^ }]*) `).exec(src.slice(i));
        if (!m) continue;
        const value = Number(m[1]);
        if (!/^\d+(?:\.\d+)?$/.test(m[1]!) || !(value > 0)) {
          errors.push({ code: "bad-fx", message: `{fx の ${key}= には正の数（1 で標準）を書きます`, offset: i, hint: "{fx wave strength=2 speed=0.5 本文}" });
          skipTo("}");
          return null;
        }
        tune[key] = value;
        i += m[0].length;
      }
      const { nodes, closed } = parseSeq(true);
      if (!closed) return unclosed(start);
      return { kind: "fx", effect: name as TextEffect, ...tune, children: nodes };
    }
    if ((TEXT_VARIANTS as readonly string[]).includes(keyword) && after === " ") {
      // 本文の出し分け。| で区切った一つずつが本文（中にルビや {= 式} を書ける）
      i += keyword.length + 1;
      const items: Inline[][] = [];
      for (;;) {
        const part = parseSeq(true, true);
        if (!part.closed && !part.bar) return unclosed(start);
        items.push(part.nodes);
        if (part.closed) break;
      }
      return { kind: "variants", mode: keyword as TextVariantMode, items, children: items.flat() };
    }
    if (keyword === "r" && after === " ") {
      i += 2;
      // 親文字は読みの区切り | まで。全角の ｜ と、区切りを書かずに閉じた } も読み、分かる文で知らせる
      const base = readPlain("|", ["｜", "}"]);
      if (base === null) return unclosed(start);
      if (base.end === "}") {
        errors.push({ code: "bad-ruby", message: "ルビの読みの区切り | がありません", offset: start, hint: `{r ${base.text}|よみ} のように、親文字と読みを | で区切ります` });
        return null;
      }
      const separator = i - 1;
      const reading = readPlain("}");
      if (reading === null) return unclosed(start);
      if (base.end === "｜") {
        // 日本語入力のまま打った全角の ｜。読みは分かるのでルビにし、直し方を付ける
        const head = src.slice(start, separator);
        errors.push({ code: "bad-ruby", message: "ルビの読みの区切りが全角の ｜ です（半角の | で区切ります）", offset: start, hint: `${head}|${reading.text}}`, fix: { kind: "replace", find: `${head}｜`, with: `${head}|` } });
      }
      if (base.text === "" || reading.text === "") {
        errors.push({ code: "empty-ruby", message: "ルビの親文字と読みは空にできません", offset: start, hint: "{r 漢字|かんじ}" });
        return null;
      }
      return { kind: "ruby", base: base.text, reading: reading.text };
    }

    errors.push({
      code: "unknown-inline",
      message: `{ のあとを解釈できません: {${src.slice(i, i + 8)}`,
      offset: start,
      hint: "ルビは {r 漢字|かんじ}、値は {= 式}、クリック待ちは {click}、行末でクリックを待たないなら {noclick}、改行は {br}、装飾は {b …} {i …} {c #色 …} {size 32 …} {mark #色 …} {dot …}（傍点）、画像は {img パス}、動きは {fx wave …}、出し分けは {seq a|b} {cycle …} {once …} {shuffle …}。{ を本文に表示するなら \\{ と書きます",
    });
    skipTo("}");
    return null;
  };

  /**
   * 入れ子を持たない部分（ルビ）を end（か also のどれか）まで読む。\ でエスケープできる。読み終えた字を end に返す。
   * 閉じずに { か } が来るか、行が終われば null。
   */
  const readPlain = (end: string, also: readonly string[] = []): { text: string; end: string } | null => {
    let out = "";
    while (i < src.length) {
      const c = src[i]!;
      if (c === "\\" && i + 1 < src.length) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (c === end || also.includes(c)) {
        i++;
        return { text: out, end: c };
      }
      if (c === "{" || c === "}") return null;
      out += c;
      i++;
    }
    return null;
  };

  const skipTo = (c: string) => {
    while (i < src.length && src[i] !== c) i++;
    if (i < src.length) i++;
  };

  const unclosed = (start: number): null => {
    errors.push({ code: "unclosed-inline", message: "{ が閉じていません", offset: start, hint: "} で閉じます。{ を本文に表示するなら \\{ と書きます" });
    i = src.length;
    return null;
  };

  const { nodes } = parseSeq(false);
  return { content: nodes, errors };
}

/** 本文の書き方を、そのまま元の記法に戻す（整形と変換で使う）。bar なら文字の | も \\| にする（出し分けの中）。 */
export function printInline(content: Inline[], bar = false): string {
  return content.map((n) => printOne(n, bar)).join("");
}

function escapeText(text: string, bar = false): string {
  return text.replace(bar ? /[\\{}|]/g : /[\\{}]/g, (c) => `\\${c}`);
}

function printOne(node: Inline, bar: boolean): string {
  switch (node.kind) {
    case "text":
      return escapeText(node.text, bar);
    case "variants":
      return `{${node.mode} ${node.items.map((item) => printInline(item, true)).join("|")}}`;
    case "ruby":
      return `{r ${escapeText(node.base).replace(/\|/g, "\\|")}|${escapeText(node.reading)}}`;
    case "value":
      return `{= ${node.source}}`;
    case "click":
      return "{click}";
    case "noclick":
      return "{noclick}";
    case "br":
      return "{br}";
    case "speed":
      return `{speed ${node.source} ${printInline(node.children)}}`;
    case "command":
      return `{@${[node.name, ...node.args.map((a) => (a.key === null ? "" : `${a.key}=`) + printLiteral(a.value))].join(" ")}}`;
    case "style":
      return `{${node.style === "bold" ? "b" : "i"} ${printInline(node.children)}}`;
    case "color":
      return `{c ${node.color} ${printInline(node.children)}}`;
    case "size":
      return `{size ${node.size} ${printInline(node.children)}}`;
    case "mark":
      return `{mark ${node.color} ${printInline(node.children)}}`;
    case "fx":
      return `{fx ${node.effect}${node.strength !== undefined ? ` strength=${node.strength}` : ""}${node.speed !== undefined ? ` speed=${node.speed}` : ""} ${printInline(node.children)}}`;
    case "emphasis":
      return `{dot ${printInline(node.children)}}`;
    case "image":
      return `{img ${node.path}${node.height !== undefined ? ` ${node.height}` : ""}}`;
  }
}

/** 表示される文字だけを取り出す（文字数の数え上げや本文の抽出に使う）。 */
export function plainText(content: Inline[]): string {
  return content
    .map((n) => {
      switch (n.kind) {
        case "text":
          return n.text;
        case "ruby":
          return n.base;
        case "value":
          return "";
        case "click":
        case "noclick":
          return "";
        case "br":
          return "\n";
        case "command":
          return "";
        case "speed":
        case "style":
        case "color":
        case "size":
        case "mark":
        case "fx":
        case "emphasis":
          return plainText(n.children);
        case "image":
          return "";
        case "variants":
          // どれが出るかは通った回数で決まるので、すべてを / でつなぐ（数え上げと検索のため）
          return n.items.map((item) => plainText(item)).join("/");
      }
    })
    .join("");
}
