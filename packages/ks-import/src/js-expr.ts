import { CORE_FUNCTIONS, parseExpr, rootNames, STORY_FUNCTIONS, type Expr } from "@liminalia/lang";

/**
 * ティラノの JS の式・文を .lim の式言語に直す。
 * f / sf / tf を game / system / temp に、=== を == に、'…' を "…" に置き換え、
 * .lim の式として解析できて、変数が game / system / temp だけのときに限り成功とする。
 * マクロの中身では、mp.名前（マクロの引数）を @define の引数の名前に置き換える（params に渡したものだけ）。
 * それ以外（DOM・jQuery・TYRANO・関数定義など）は null を返し、呼び出し側が手作業の対象にする。
 */

/** マクロの引数の .ks での名前 → .lim の式で参照する名前。 */
export type MacroParamNames = ReadonlyMap<string, string>;

const ROOTS: Record<string, string> = { f: "game", sf: "system", tf: "temp" };
const ALLOWED_ROOTS = new Set(["game", "system", "temp"]);

/** JS の文字列の中の書き逃し一つを読む（at は \ の直後の字の位置）。字ごと戻す形を返す（JS と同じ読み方）。 */
function unescapeJs(js: string, at: number): { text: string; next: number } {
  const c = js[at];
  if (c === undefined) return { text: "", next: at + 1 };
  const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v" };
  if (simple[c] !== undefined) return { text: simple[c]!, next: at + 1 };
  if (c === "x") {
    const h = /^[0-9a-fA-F]{2}/.exec(js.slice(at + 1))?.[0];
    // \x の後が二桁の十六進でなければ、JS は x をそのままの字として読む（\u も同じ）
    return h ? { text: String.fromCharCode(parseInt(h, 16)), next: at + 3 } : { text: "x", next: at + 1 };
  }
  if (c === "u") {
    if (js[at + 1] === "{") {
      const m = /^\{([0-9a-fA-F]{1,6})\}/.exec(js.slice(at + 1));
      const cp = m ? parseInt(m![1]!, 16) : NaN;
      return m && cp <= 0x10ffff ? { text: String.fromCodePoint(cp), next: at + 1 + m![0].length } : { text: "u", next: at + 1 };
    }
    const h = /^[0-9a-fA-F]{4}/.exec(js.slice(at + 1))?.[0];
    return h ? { text: String.fromCharCode(parseInt(h, 16)), next: at + 5 } : { text: "u", next: at + 1 };
  }
  if (/[0-7]/.test(c)) {
    // 古い八進数の書き逃し（\0 〜 \377。頭が 4〜7 なら続けて1桁まで、0〜3 なら2桁まで）
    let digits = c;
    const max = c <= "3" ? 3 : 2;
    while (digits.length < max && /[0-7]/.test(js[at + digits.length] ?? "")) digits += js[at + digits.length];
    return { text: String.fromCharCode(parseInt(digits, 8)), next: at + digits.length };
  }
  if (c === "\r" || c === "\n") {
    // 行の継続（\ の直後の改行は無いものとして読む）
    return { text: "", next: c === "\r" && js[at + 1] === "\n" ? at + 2 : at + 1 };
  }
  // ほかの書き逃しはその字をそのまま読む（\' → '、\\ → \、\8 → 8）
  return { text: c, next: at + 1 };
}

/** .lim の文字列に書き直す。.lim は \" ・ \\ ・ \n の書き逃しだけ読めるので、それで表せない制御文字（\t・\r・NUL など）や行を分ける字（\u2028 など）を含む文字列は書けず、null にして手作業に回す。 */
function limString(value: string): string | null {
  let out = '"';
  for (const ch of value) {
    if (ch === '"' || ch === "\\") out += "\\" + ch;
    else if (ch === "\n") out += "\\n";
    else if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(ch)) return null;
    else out += ch;
  }
  return out + '"';
}

function rewrite(js: string, params?: MacroParamNames): string | null {
  let out = "";
  let i = 0;
  while (i < js.length) {
    const c = js[i]!;
    if (c === "'" || c === '"') {
      let value = "";
      let j = i + 1;
      for (; j < js.length && js[j] !== c; j++) {
        if (js[j] === "\\") {
          const u = unescapeJs(js, j + 1);
          value += u.text;
          j = u.next - 1;
        } else {
          value += js[j];
        }
      }
      if (j >= js.length) return null;
      const s = limString(value);
      if (s === null) return null;
      out += s;
      i = j + 1;
      continue;
    }
    if (c === "`") return null;
    const id = /^[A-Za-z_$][\w$]*/.exec(js.slice(i))?.[0];
    if (id) {
      const prev = out.trimEnd().at(-1);
      if (id === "mp" && prev !== "." && params) {
        const key = /^\.([A-Za-z_$][\w$]*)/.exec(js.slice(i + 2))?.[1];
        const local = key === undefined ? undefined : params.get(key);
        if (local === undefined) return null;
        out += local;
        i += 3 + key!.length;
        continue;
      }
      const root = ROOTS[id];
      out += root !== undefined && prev !== "." && js[i + id.length] === "." ? root : id;
      i += id.length;
      continue;
    }
    if (js.startsWith("===", i) || js.startsWith("!==", i)) {
      out += js.slice(i, i + 2);
      i += 3;
      continue;
    }
    out += c;
    i++;
  }
  return out.trim();
}

/**
 * jsExpression が書き出す `String.fromCodePoint(…)` を .lim の文字列に戻す
 * （書き戻しの検証・再取り込みで parseExpr が読めるように）。辞書の見出しの `[…]` も外す
 * — .lim の辞書の見出しは算出できないので、解決した文字列リテラルにする。
 * 文字列の中は触らず、`[…]` は { } の直で三項演算子の中でないときだけ外す
 * （`c ? [String.fromCodePoint(…)] : d` の [ ] は配列なので残す）。
 */
function resolveFromCodePoint(js: string): string {
  const resolveCall = (nums: string): string | null => {
    const codes = nums.split(",").map((n) => parseInt(n.trim(), 10));
    if (codes.some((n) => Number.isNaN(n) || n < 0 || n > 0x10ffff)) return null;
    return limString(codes.map((c) => String.fromCodePoint(c)).join(""));
  };
  // { ( [ の積み重ね。{ では未対応の三項演算子 ? の数を数える（? と同じ段の : はキーの区切りではない）
  const stack: { ch: string; ternary: number }[] = [];
  let out = "";
  let i = 0;
  while (i < js.length) {
    const c = js[i]!;
    // 文字列の中はそのまま（中の String.fromCodePoint は呼び出しではない）
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < js.length && js[j] !== c) j += js[j] === "\\" ? 2 : 1;
      out += js.slice(i, Math.min(j + 1, js.length));
      i = j + 1;
      continue;
    }
    if (c === "[") {
      // {…} の直の見出し [String.fromCodePoint(…)]: なら [ ] を外す（添字・配列の [ ] は残す）
      const m = /^\[\s*String\.fromCodePoint\(([\d\s,]+)\)\s*\]/.exec(js.slice(i));
      const top = stack[stack.length - 1];
      if (m && top?.ch === "{" && top.ternary === 0 && js.slice(i + m[0].length).match(/^\s*:/) !== null) {
        const resolved = resolveCall(m[1]!);
        out += resolved ?? m[0];
        i += m[0].length;
        continue;
      }
      stack.push({ ch: c, ternary: 0 });
      out += c;
      i++;
      continue;
    }
    if (c === "{" || c === "(") {
      stack.push({ ch: c, ternary: 0 });
      out += c;
      i++;
      continue;
    }
    if (c === "}" || c === ")" || c === "]") {
      stack.pop();
      out += c;
      i++;
      continue;
    }
    if (c === "?") {
      const top = stack[stack.length - 1];
      // ?. と ?? は三項演算子ではない
      if (top?.ch === "{" && js[i + 1] !== "." && js[i + 1] !== "?" && js[i - 1] !== "?") top.ternary++;
      out += c;
      i++;
      continue;
    }
    if (c === ":") {
      const top = stack[stack.length - 1];
      if (top?.ch === "{" && top.ternary > 0) top.ternary--;
      out += c;
      i++;
      continue;
    }
    if (c === "S" && js.startsWith("String.fromCodePoint(", i) && !/[\w$.]/.test(js[i - 1] ?? "")) {
      const m = /^String\.fromCodePoint\(([\d\s,]+)\)/.exec(js.slice(i));
      // 数字でない引数（String.fromCodePoint(f.x) など）は解決できないので、そのまま残す
      if (!m) {
        out += c;
        i++;
        continue;
      }
      const resolved = resolveCall(m[1]!);
      out += resolved ?? m[0];
      i += m[0].length;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 式を変換する。変換できなければ null。 */
export function convertJsExpression(js: string, params?: MacroParamNames): string | null {
  const rewritten = rewrite(resolveFromCodePoint(js), params);
  if (rewritten === null || rewritten === "") return null;
  const locals = new Set(params?.values() ?? []);
  try {
    const expr = parseExpr(rewritten);
    for (const root of rootNames(expr)) if (!ALLOWED_ROOTS.has(root) && !locals.has(root)) return null;
    if (!onlyKnownCalls(expr)) return null;
    return rewritten;
  } catch {
    return null;
  }
}

/** `f.a = 1; tf.b += 2` のような代入文の並びを @set の行に変換する。変換できなければ null。 */
export function convertJsAssignments(js: string, params?: MacroParamNames): string[] | null {
  const statements = splitStatements(js);
  if (statements === null || statements.length === 0) return null;
  const lines: string[] = [];
  for (const statement of statements) {
    const inc = /^(.+?)\s*(\+\+|--)$/.exec(statement);
    const m = inc ? null : /^(.+?)\s*(\+=|-=|\*=|\/=|=)(?!=)\s*(.+)$/s.exec(statement);
    const lhs = inc ? inc[1]! : m?.[1];
    if (lhs === undefined) return null;
    const target = convertJsExpression(lhs, params);
    // target の中に = がある（添字の文字列に = の字。"=" や "a=b"）と、.lim の @set の読み取りが
    // そこで代入の区切りと読み違えて構文エラーになるので、手作業の対象に回す
    if (target === null || target.includes("=") || !/^(game|system|temp)(\.[\p{L}\p{N}_$]+|\[[^\]]+\])+$/u.test(target)) return null;
    if (inc) {
      lines.push(`@set ${target} ${inc[2] === "++" ? "+=" : "-="} 1`);
      continue;
    }
    const value = convertJsExpression(m![3]!, params);
    if (value === null) return null;
    lines.push(`@set ${target} ${m![2]} ${value}`);
  }
  return lines;
}

/** 文字列の外にある ; と改行で区切る。 */
function splitStatements(js: string): string[] | null {
  const out: string[] = [];
  let current = "";
  let quote = "";
  for (let i = 0; i < js.length; i++) {
    const c = js[i]!;
    if (quote) {
      current += c;
      if (c === "\\") {
        current += js[i + 1] ?? "";
        i++;
      } else if (c === quote) {
        quote = "";
      }
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    if (c === ";" || c === "\n") {
      if (current.trim() !== "") out.push(current.trim());
      current = "";
      continue;
    }
    current += c;
  }
  if (quote) return null;
  if (current.trim() !== "") out.push(current.trim());
  return out;
}

/** JS の関数（parseInt など）は .lim の関数と意味が違うので、登録済みの関数だけを許す。 */
function onlyKnownCalls(e: Expr): boolean {
  switch (e.kind) {
    case "call":
      // 実行器が答える関数（visits など）は TyranoScript に無い
      return CORE_FUNCTIONS.has(e.callee) && !STORY_FUNCTIONS.has(e.callee) && e.args.every(onlyKnownCalls);
    case "member":
      return onlyKnownCalls(e.object);
    case "index":
      return onlyKnownCalls(e.object) && onlyKnownCalls(e.index);
    case "array":
      return e.items.every(onlyKnownCalls);
    case "object":
      return e.entries.every((x) => onlyKnownCalls(x.value));
    case "unary":
      return onlyKnownCalls(e.operand);
    case "binary":
      return onlyKnownCalls(e.left) && onlyKnownCalls(e.right);
    case "conditional":
      return onlyKnownCalls(e.test) && onlyKnownCalls(e.then) && onlyKnownCalls(e.otherwise);
    case "literal":
    case "name":
      return true;
  }
}
