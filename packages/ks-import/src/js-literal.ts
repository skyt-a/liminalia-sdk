/**
 * `window.名前 = { … };` の形だけを書いた JavaScript のファイル（立ち絵プラグインの settings.js など）を、
 * 実行せずに読む。右辺はリテラル（文字列・数・真偽・null・配列・オブジェクト）だけを受け付ける。
 * コメント、末尾のカンマ、引用符のないキー、単一引用符の文字列は JavaScript と同じに読む。
 * 関数の呼び出し・変数の参照・計算など、それ以外のものがあれば読めないとしてエラーにする（評価はしない）。
 */

export class LiteralError extends Error {}

/** 代入した変数の名前 → 値。同じ名前に二度代入していれば後のもの。 */
export function readWindowAssignments(source: string): Map<string, unknown> {
  return new LiteralParser(source).assignments();
}

const ID_START = /[\p{ID_Start}$_]/u;
const ID_CONTINUE = /[\p{ID_Continue}$_\u200c\u200d]/u;
/** オブジェクトのキーにすると、値ではなくプロトタイプを書き換えてしまうもの。 */
const FORBIDDEN_KEYS = new Set(["__proto__"]);

class LiteralParser {
  private at = 0;
  constructor(private readonly src: string) {
    if (src.startsWith("\uFEFF")) this.at = 1;
  }

  assignments(): Map<string, unknown> {
    const out = new Map<string, unknown>();
    for (;;) {
      this.skip();
      if (this.at >= this.src.length) return out;
      if (this.eat(";")) continue;
      const word = this.identifier();
      if (word !== "window") this.fail(word === "" ? "window.名前 = … の形の代入だけを書けます" : `${word} は読めません（window.名前 = … の形の代入だけを書けます）`);
      this.skip();
      let name: string;
      if (this.eat(".")) {
        this.skip();
        name = this.identifier();
        if (name === "") this.fail("window. のあとに名前が必要です");
      } else if (this.eat("[")) {
        this.skip();
        const key = this.value();
        if (typeof key !== "string") this.fail("window[…] の中は文字列にします");
        name = key;
        this.skip();
        this.expect("]");
      } else {
        this.fail("window.名前 = … の形の代入だけを書けます");
      }
      this.skip();
      this.expect("=");
      if (this.src[this.at] === "=") this.fail("= のあとに値が必要です");
      out.set(name, this.value());
      const end = this.at;
      this.skip();
      // 文の区切りは ; か改行（JavaScript と同じく、値のあとに改行があれば次の文として読む）
      if (!this.eat(";") && this.at < this.src.length && !/[\n\r\u2028\u2029]/.test(this.src.slice(end, this.at))) this.fail("値のあとに読めないものがあります");
    }
  }

  private value(): unknown {
    this.skip();
    const c = this.src[this.at];
    if (c === undefined) this.fail("値が必要です");
    if (c === "{") return this.object();
    if (c === "[") return this.array();
    if (c === '"' || c === "'") return this.string();
    if (c === "-" || c === "+" || c === "." || /[0-9]/.test(c)) return this.number();
    const word = this.identifier();
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    if (word === "") this.fail(`${c} は読めません`);
    this.fail(`${word} は読めません（文字列、数、true、false、null、配列、オブジェクトだけを書けます）`);
  }

  private object(): Record<string, unknown> {
    this.expect("{");
    const out: Record<string, unknown> = {};
    for (;;) {
      this.skip();
      if (this.eat("}")) return out;
      const c = this.src[this.at];
      let key: string;
      if (c === '"' || c === "'") key = this.string();
      else if (c !== undefined && /[0-9.]/.test(c)) key = String(this.number());
      else {
        key = this.identifier();
        if (key === "") this.fail(c === undefined ? "} が必要です" : `${c} は読めません（オブジェクトのキーが必要です）`);
      }
      if (FORBIDDEN_KEYS.has(key)) this.fail(`キー ${key} は使えません`);
      this.skip();
      this.expect(":");
      out[key] = this.value();
      this.skip();
      if (this.eat("}")) return out;
      this.expect(",");
    }
  }

  private array(): unknown[] {
    this.expect("[");
    const out: unknown[] = [];
    for (;;) {
      this.skip();
      if (this.eat("]")) return out;
      if (this.src[this.at] === ",") this.fail("配列の中の空きは読めません");
      out.push(this.value());
      this.skip();
      if (this.eat("]")) return out;
      this.expect(",");
    }
  }

  private string(): string {
    const quote = this.src[this.at++]!;
    let out = "";
    for (;;) {
      const c = this.src[this.at++];
      if (c === undefined || c === "\n" || c === "\r") this.fail("文字列が閉じていません");
      if (c === quote) return out;
      if (c !== "\\") {
        out += c;
        continue;
      }
      const e = this.src[this.at++];
      if (e === undefined) this.fail("文字列が閉じていません");
      const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" };
      if (e === "0" && /[0-9]/.test(this.src[this.at] ?? "")) this.fail("8 進数のエスケープは読めません");
      if (e in simple) out += simple[e];
      else if (e === "x") out += String.fromCharCode(this.hex(2));
      else if (e === "u") {
        if (this.eat("{")) {
          const end = this.src.indexOf("}", this.at);
          const digits = end < 0 ? "" : this.src.slice(this.at, end);
          if (!/^[0-9a-fA-F]{1,6}$/.test(digits) || parseInt(digits, 16) > 0x10ffff) this.fail("\\u{…} のエスケープが正しくありません");
          out += String.fromCodePoint(parseInt(digits, 16));
          this.at = end + 1;
        } else out += String.fromCharCode(this.hex(4));
      } else if (e === "\r") this.eat("\n");
      else if (e === "\n" || e === "\u2028" || e === "\u2029") continue;
      else if (/[1-9]/.test(e)) this.fail("8 進数のエスケープは読めません");
      else out += e;
    }
  }

  private hex(n: number): number {
    const digits = this.src.slice(this.at, this.at + n);
    if (!new RegExp(`^[0-9a-fA-F]{${n}}$`).test(digits)) this.fail("エスケープが正しくありません");
    this.at += n;
    return parseInt(digits, 16);
  }

  private number(): number {
    let sign = 1;
    if (this.src[this.at] === "-" || this.src[this.at] === "+") {
      if (this.src[this.at] === "-") sign = -1;
      this.at++;
      this.skip();
    }
    const rest = this.src.slice(this.at);
    const m = /^(?:0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*|0[bB][01](?:_?[01])*|0[oO][0-7](?:_?[0-7])*|(?:(?:[0-9](?:_?[0-9])*)?\.[0-9](?:_?[0-9])*|[0-9](?:_?[0-9])*\.?)(?:[eE][+-]?[0-9](?:_?[0-9])*)?)/.exec(rest);
    if (!m || m[0] === "" || m[0] === ".") this.fail("数が正しくありません");
    const text = m[0].replace(/_/g, "");
    this.at += m[0].length;
    if (ID_CONTINUE.test(this.src[this.at] ?? "")) this.fail("数が正しくありません");
    // 0x・0b・0o は Number がそのまま読む。先頭が 0 の 10 進数（08 など）は JavaScript でも紛らわしいので読まない
    if (/^0[0-9]/.test(text)) this.fail("先頭が 0 の数は読めません");
    return sign * Number(text);
  }

  private identifier(): string {
    const start = this.at;
    if (!ID_START.test(this.charAt(this.at))) return "";
    this.at += this.charAt(this.at).length;
    while (ID_CONTINUE.test(this.charAt(this.at))) this.at += this.charAt(this.at).length;
    return this.src.slice(start, this.at);
  }

  /** at の位置の一文字（サロゲートペアは二つで一文字）。 */
  private charAt(at: number): string {
    const cp = this.src.codePointAt(at);
    return cp === undefined ? "" : String.fromCodePoint(cp);
  }

  /** 空白とコメントを飛ばす。 */
  private skip(): void {
    for (;;) {
      const c = this.src[this.at];
      if (c === undefined) return;
      if (/\s/.test(c) || c === "\uFEFF") this.at++;
      else if (this.src.startsWith("//", this.at)) {
        const end = this.src.slice(this.at).search(/[\n\r\u2028\u2029]/);
        this.at = end < 0 ? this.src.length : this.at + end;
      } else if (this.src.startsWith("/*", this.at)) {
        const end = this.src.indexOf("*/", this.at + 2);
        if (end < 0) this.fail("コメントが閉じていません");
        this.at = end + 2;
      } else return;
    }
  }

  private eat(s: string): boolean {
    if (!this.src.startsWith(s, this.at)) return false;
    this.at += s.length;
    return true;
  }

  private expect(s: string): void {
    if (!this.eat(s)) this.fail(this.at >= this.src.length ? `${s} が必要です（ファイルが途中で終わっています）` : `${s} が必要です`);
  }

  private fail(message: string): never {
    const line = this.src.slice(0, this.at).split(/\r\n|\r|\n/).length;
    throw new LiteralError(`${line} 行目: ${message}`);
  }
}
