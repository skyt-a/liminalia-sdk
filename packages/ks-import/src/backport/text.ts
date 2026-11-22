import type { Inline } from "@liminalia/lang";
import { escapeKsText } from "./ks-line.ts";
import { jsExpression } from "./inverse.ts";

/**
 * .lim の本文（インラインの並び）を .ks の地の文に戻す（書き戻しの本文の部分）。
 *
 * - ルビは基準の .ks の書き方に合わせる: `auto`（auto_ruby の ｜親《ルビ》）・`srb`（[srb text=ルビ]親[erb]）・`ruby`（[ruby text=ルビ]字）
 * - {click} は [l]、{br} は [r]、{noclick} は何も書かない（行の終わりの [p] を付けないのは書き戻しの側）、{= 式} は [emb exp=…]、{speed 0ms …} は [nowait]…[endnowait]、{speed …} は [delay speed=…]…[resetdelay]
 * - {b} {i} {c} {size} は [font …]…[resetfont]、{mark} は [mark color=…]…[endmark]
 * - {@命令} は命令の書き戻し（inlineCommand）に任せる
 */
export interface RubyStyle {
  kind: "auto" | "srb" | "ruby";
  /** auto のときの縦棒（｜ か |）。 */
  bar: string;
}

export interface TextOptions {
  ruby: RubyStyle;
  /** {@命令} を .ks のタグに戻す。戻せなければ null。 */
  inlineCommand(node: Extract<Inline, { kind: "command" }>): string | null;
  /** 戻せなかったものを知らせる。 */
  problem(message: string): void;
}

interface Font {
  bold?: boolean;
  italic?: boolean;
  color?: string;
  size?: number;
}

export function inlineToKs(content: readonly Inline[], o: TextOptions): string {
  let out = "";
  const fonts: Font[] = [{}];
  /** 書いた [font] の状態。文字を書く前に、その文字の装飾に合わせる（[font] は足すだけなので、減らすときは [resetfont] から）。 */
  let written: Font = {};
  const fontTag = (f: Font) => {
    const attrs: string[] = [];
    if (f.size !== undefined) attrs.push(`size="${f.size}"`);
    if (f.color !== undefined) attrs.push(`color="${ksColor(f.color)}"`);
    if (f.bold) attrs.push(`bold="true"`);
    if (f.italic) attrs.push(`italic="true"`);
    return attrs.length > 0 ? `[font ${attrs.join(" ")}]` : "";
  };
  const setFont = (f: Font) => {
    if (fontTag(f) === fontTag(written)) return;
    if (fontTag(written) !== "") out += "[resetfont]";
    out += fontTag(f);
    written = f;
  };
  const visit = (nodes: readonly Inline[]) => {
    for (const n of nodes) {
      if (n.kind === "text" || n.kind === "ruby" || n.kind === "value") setFont(fonts.at(-1)!);
      switch (n.kind) {
        case "text":
          out += escapeRuby(escapeKsText(n.text));
          break;
        case "ruby":
          out += ruby(n.base, n.reading, o.ruby);
          break;
        case "click":
          out += "[l]";
          break;
        case "noclick":
          break;
        case "br":
          out += "[r]";
          break;
        case "value":
          out += `[emb exp="${jsExpression(n.source)}"]`;
          break;
        case "speed":
          if (n.perChar === 0) {
            out += "[nowait]";
            visit(n.children);
            out += "[endnowait]";
          } else {
            out += `[delay speed="${n.perChar}"]`;
            visit(n.children);
            out += "[resetdelay]";
          }
          break;
        case "command": {
          const tag = o.inlineCommand(n);
          if (tag === null) o.problem(`本文の中の命令 {@${n.name} …} を .ks のタグに戻せません`);
          else out += tag;
          break;
        }
        case "fx":
          // TyranoScript に文字の動きは無いので、動きを外して中身だけ戻す
          o.problem(`本文の文字の動き {fx ${n.effect} …} は .ks に戻せないため、動きを外します`);
          visit(n.children);
          break;
        case "variants":
          // TyranoScript に本文の出し分けは無いので、一つ目だけを戻す
          o.problem(`本文の出し分け {${n.mode} …} は .ks に戻せないため、一つ目だけを戻します`);
          visit(n.items[0] ?? []);
          break;
        case "mark":
          setFont(fonts.at(-1)!);
          out += `[mark color="${ksColor(n.color)}"]`;
          visit(n.children);
          out += "[endmark]";
          break;
        case "style":
        case "color":
        case "size": {
          const inner: Font = { ...fonts.at(-1)! };
          if (n.kind === "style") inner[n.style] = true;
          else if (n.kind === "color") inner.color = n.color;
          else inner.size = n.size;
          fonts.push(inner);
          visit(n.children);
          fonts.pop();
          break;
        }
      }
    }
  };
  visit(content);
  setFont({});
  return out;
}

/** 本文の行の最後が {noclick}（クリックを待たずに次へ進む）か。 */
export function endsWithNoclick(content: readonly Inline[]): boolean {
  return content.at(-1)?.kind === "noclick";
}

function ksColor(color: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? `0x${color.slice(1).toLowerCase()}` : color;
}

function ruby(base: string, reading: string, style: RubyStyle): string {
  const b = escapeKsText(base);
  if (style.kind === "auto" && !/[《》｜|]/.test(base + reading)) return `${style.bar}${b}《${escapeKsText(reading)}》`;
  if (style.kind === "ruby" && [...base].length === 1) return `[ruby text="${attr(reading)}"]${b}`;
  return `[srb text="${attr(reading)}"]${b}[erb]`;
}

function attr(value: string): string {
  return value.replace(/"/g, "&quot;");
}

/**
 * 地の文の中の ｜ | 《 》 が auto_ruby のルビの記法と読まれないようにする。
 * 字句解析は `\x` を x にするので、記法の文字の前には `\\` を置く（地の文に `\` が残り、ルビの切り分けがそれを外す）。
 */
function escapeRuby(text: string): string {
  if (!((text.includes("｜") || text.includes("|")) && text.includes("《") && text.includes("》"))) return text;
  return text.replace(/[｜|《》]/g, (c) => `\\\\${c}`);
}
