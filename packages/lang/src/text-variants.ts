import type { TextUnit } from "./text-stats.ts";

/**
 * 表記ゆれの候補を探す（lim stats と Studio のチェックの画面）。
 *
 * 同じ語・同じ記号の別の書き方（形）を組にし、一つのプロジェクトの中で二つ以上の形が使われていれば候補として出す。
 * 組み込みの組は、漢字とかな（出来る／できる、下さい／ください …）、送り仮名（終わる／終る …）、記号（…／・・・／...、！？／!? …）、
 * 全角と半角（！／!、数字、英字、半角カナ）、長音と波ダッシュ（ー／－、〜／～）。あわせて、話者の名前どうしの揺れ
 * （ひらがなとカタカナ、全角と半角、中点や空白の有無が違うだけの名前）と、本文の中の話者の名前の中点や空白の揺れを出す。
 * 作者は辞書（liminalia.json の stats.variants と .liminalia/variants.json）で組を足し、組や種類を外せる。
 */
export type VariantKind = "kana" | "okurigana" | "symbol" | "width" | "name" | "glossary" | "custom";

export const VARIANT_KINDS: readonly VariantKind[] = ["kana", "okurigana", "symbol", "width", "name", "glossary", "custom"];

export interface VariantDictionary {
  /** 足す組（それぞれ、同じ語の別の書き方を並べる。["出来る", "できる"]）。 */
  add?: string[][];
  /** 出さない組（組の id か、組に入っている書き方のどれか）。 */
  ignore?: string[];
  /** 出さない種類（kana・okurigana・symbol・width・name・glossary）。 */
  off?: string[];
}

interface Form {
  /** 表に出す書き方。 */
  label: string;
  /** 一致させる文字列か正規表現（g を付けない）。 */
  match: readonly string[] | RegExp;
}

interface Group {
  id: string;
  kind: VariantKind;
  forms: Form[];
}

export interface VariantOccurrence {
  file: string;
  line: number;
  /** 見つかった文字列。 */
  text: string;
  /** 前後を含めた抜き出し。 */
  excerpt: string;
}

export interface VariantForm {
  label: string;
  count: number;
  occurrences: VariantOccurrence[];
  /**
   * この書き方を多い書き方にそろえる置換（多い書き方には付けない。機械で決められないときも付けない）。
   * query を探して text に置き換える（regex なら JavaScript の正規表現）。
   */
  replace?: VariantReplace;
}

export interface VariantReplace {
  query: string;
  regex: boolean;
  text: string;
}

export interface VariantGroup {
  id: string;
  kind: VariantKind;
  /** 形を ／ でつないだ名前。 */
  label: string;
  /** 使われている形（多い順）。最初のものが多数派。 */
  forms: VariantForm[];
}

const words = (id: string, kind: VariantKind, ...forms: (string | string[])[]): Group => ({
  id,
  kind,
  forms: forms.map((f) => (Array.isArray(f) ? { label: f[0]!, match: f } : { label: f, match: [f] })),
});
const sym = (id: string, kind: VariantKind, ...forms: [string, RegExp | string[]][]): Group => ({ id, kind, forms: forms.map(([label, match]) => ({ label, match })) });

/** 組み込みの組。誤検出の少ない形だけを並べる（「事／こと」のように別の語の一部にもなるものは入れない）。 */
export const BUILTIN_VARIANTS: readonly Group[] = [
  words("kana:できる", "kana", ["出来る", "出来ない", "出来た", "出来ます", "出来て", "出来れ", "出来な"], ["できる", "できない", "できた", "できます", "できて", "できれ", "できな"]),
  words("kana:ください", "kana", "下さい", "ください"),
  words("kana:いただく", "kana", ["頂きます", "頂いた", "頂け", "頂く"], ["いただきます", "いただいた", "いただけ", "いただく"]),
  words("kana:いたします", "kana", ["致します", "致しま"], ["いたします", "いたしま"]),
  words("kana:ありがとう", "kana", ["有難う", "有り難う"], "ありがとう"),
  words("kana:よろしく", "kana", "宜しく", "よろしく"),
  words("kana:なぜ", "kana", "何故", "なぜ"),
  words("kana:たくさん", "kana", "沢山", "たくさん"),
  words("kana:ちょっと", "kana", "一寸", "ちょっと"),
  words("kana:すでに", "kana", "既に", "すでに"),
  words("kana:すべて", "kana", "全て", "すべて"),
  words("kana:さらに", "kana", "更に", "さらに"),
  words("kana:ほとんど", "kana", "殆ど", "ほとんど"),
  words("kana:きれい", "kana", ["綺麗", "奇麗"], "きれい"),
  words("kana:すごい", "kana", ["凄い", "凄く"], ["すごい", "すごく"]),
  words("kana:わかる", "kana", ["分かる", "分から", "分かっ", "分かり"], ["わかる", "わから", "わかっ", "わかり"], ["解る", "解ら", "解っ"], ["判る", "判ら", "判っ"]),
  words("kana:あなた", "kana", ["貴方", "貴女"], "あなた"),
  words("kana:たち", "kana", ["私達", "僕達", "俺達", "君達", "彼女達"], ["私たち", "僕たち", "俺たち", "君たち", "彼女たち"]),
  words("kana:はず", "kana", ["筈だ", "筈が", "筈の", "筈は"], ["はずだ", "はずが", "はずの", "はずは"]),
  words("kana:ため", "kana", "の為", "のため"),
  words("okurigana:終わる", "okurigana", ["終わる", "終わり", "終わっ", "終わら"], ["終る", "終り", "終っ", "終ら"]),
  words("okurigana:変わる", "okurigana", ["変わる", "変わり", "変わっ", "変わら"], ["変る", "変り", "変っ", "変ら"]),
  words("okurigana:行う", "okurigana", ["行う", "行い", "行っている"], ["行なう", "行ない", "行なっている"]),
  words("okurigana:表す", "okurigana", ["表す", "表し"], ["表わす", "表わし"]),
  words("okurigana:当たる", "okurigana", ["当たる", "当たり", "当たっ"], ["当る", "当り", "当っ"]),
  words("okurigana:起こる", "okurigana", ["起こる", "起こり", "起こっ"], ["起る", "起り", "起っ"]),
  words("okurigana:少ない", "okurigana", "少ない", "少い"),
  words("okurigana:引っ越し", "okurigana", "引っ越し", "引越し"),
  sym("symbol:三点リーダー", "symbol", ["…", ["…"]], ["・・・", /[・･]{3,}/], ["...", /\.{3,}/]),
  sym("symbol:ダッシュ", "symbol", ["――", /―{2,}/], ["——", /—{2,}/], ["──", /─{2,}/], ["ーー（長音）", /(?<![ァ-ヶー])ー{2,}(?![ァ-ヶ])/], ["－－", /－{2,}/]),
  sym("symbol:感嘆疑問", "symbol", ["！？", ["！？"]], ["!?", ["!?"]], ["？！", ["？！"]], ["?!", ["?!"]], ["⁉", ["⁉"]]),
  sym("width:！", "width", ["！", /！(?![？?])/], ["!", /(?<![!?？！])!(?![?？])/]),
  sym("width:？", "width", ["？", /(?<![！!])？/], ["?", /(?<![!！?])\?(?![!！])/]),
  sym("width:数字", "width", ["全角の数字", /[０-９]/], ["半角の数字", /[0-9]/]),
  sym("width:英字", "width", ["全角の英字", /[Ａ-Ｚａ-ｚ]/], ["半角の英字", /[A-Za-z]/]),
  sym("width:カタカナ", "width", ["全角のカタカナ", /[ァ-ヶ]/], ["半角のカタカナ", /[ｦ-ﾟ]/]),
  sym("width:長音", "width", ["ー", /[ァ-ヶ]ー/], ["－（全角のマイナス）", /[ァ-ヶ]－(?!－)/], ["-（半角のハイフン）", /[ァ-ヶ]-/]),
  sym("width:波ダッシュ", "width", ["〜", ["〜"]], ["～", ["～"]]),
];

/** 名前の比べ方: ひらがなをカタカナに、全角の英数を半角に、中点・空白を除き、長音に似た記号を長音に。 */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKC")
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .replace(/[・･·\s　]/g, "")
    .replace(/[－-ｰ—―]/g, "ー")
    .toLowerCase();
}

/** 話者の名前の組（normalizeName が同じになる名前）と、本文の中の名前の中点・空白の揺れ。 */
function nameGroups(speakers: readonly string[], units: readonly TextUnit[]): Group[] {
  const out: Group[] = [];
  const byNorm = new Map<string, string[]>();
  for (const s of speakers) {
    const n = normalizeName(s);
    if (n.length === 0) continue;
    byNorm.set(n, [...(byNorm.get(n) ?? []), s]);
  }
  // 本文をまとめて一つの文字列にして、名前ごとに一度だけ探す（ページごとに探すと、話者の数 × ページの数だけ探し始める）。
  // つなぎ目の \0 は下の空白の類（\s）に当たらないので、ページをまたいだ書き方は拾わない
  let all: string | null = null;
  for (const [norm, names] of byNorm) {
    // 本文の中の、中点・空白を入れたり抜いたりした書き方（「アン・ナ」と「アンナ」）
    const spaced = new Set(names);
    if (norm.length >= 2) {
      const chars = [...names[0]!.replace(/[・･·\s　]/g, "")];
      if (chars.length >= 2) {
        const re = new RegExp(chars.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[・･·\\s　]?"), "g");
        all ??= units.map((u) => u.text).join("\0");
        for (const m of all.matchAll(re)) spaced.add(m[0]);
      }
    }
    if (spaced.size < 2) continue;
    out.push({ id: `name:${names[0]}`, kind: "name", forms: [...spaced].map((n) => ({ label: n, match: [n] })) });
  }
  return out;
}

/** 用語集（liminalia.json の extra.glossary）の語と別表記の組。別表記の無い語は組にしない。 */
function glossaryGroups(glossary: readonly { term?: unknown; aliases?: unknown }[]): Group[] {
  const out: Group[] = [];
  for (const g of glossary) {
    if (typeof g?.term !== "string" || g.term === "" || !Array.isArray(g.aliases)) continue;
    const aliases = [...new Set(g.aliases.filter((a): a is string => typeof a === "string" && a !== "" && a !== g.term))];
    if (aliases.length === 0) continue;
    out.push(words(`glossary:${g.term}`, "glossary", g.term, ...aliases));
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 形がそのまま書き方になるときの文字列（表に出す書き方が、その形の一致させるものに丸ごと当たるとき）。 */
function literalOf(f: Form): string | null {
  if (!(f.match instanceof RegExp)) return f.match.includes(f.label) ? f.label : null;
  return new RegExp(`^(?:${f.match.source})$`, f.match.flags.replace("g", "")).test(f.label) ? f.label : null;
}

/** 二つの文字列の、同じ頭と同じ尾を除いた残り（[頭, from の残り, to の残り, 尾]）。 */
function core(from: string, to: string): [string, string, string, string] {
  let head = 0;
  while (head < from.length && head < to.length && from[head] === to[head]) head++;
  let tail = 0;
  while (tail < from.length - head && tail < to.length - head && from[from.length - 1 - tail] === to[to.length - 1 - tail]) tail++;
  return [from.slice(0, head), from.slice(head, from.length - tail), to.slice(head, to.length - tail), from.slice(from.length - tail)];
}

/**
 * from の書き方を to の書き方にそろえる置換。from と to が同じ数の書き方を並べていれば（出来る／できる …）、
 * 並びごとに違う所だけを、前後の字を確かめて置き換える（「出来」を「でき」に。後ろが「る」「ない」… のときだけ）。
 * そうでなければ、to が一つの書き方に決まるときだけ、from のどれでも to にする。決められなければ null。
 */
function variantReplace(from: Form, to: Form): VariantReplace | null {
  const target = literalOf(to);
  if (from.match instanceof RegExp) return target !== null ? { query: from.match.source, regex: true, text: target } : null;
  if (Array.isArray(to.match) && to.match.length === from.match.length && from.match.length > 1) {
    const parts = from.match.map((m, i) => core(m, (to.match as readonly string[])[i]!));
    const [, a, b] = parts[0]!;
    if (a !== "" && parts.every(([, x, y]) => x === a && y === b)) {
      const heads = [...new Set(parts.map(([h]) => h))];
      const tails = [...new Set(parts.map(([, , , t]) => t))];
      const behind = heads.every((x) => x !== "") ? `(?<=${heads.map(escapeRe).join("|")})` : "";
      const ahead = tails.every((x) => x !== "") ? `(?=${tails.map(escapeRe).join("|")})` : "";
      return behind || ahead ? { query: `${behind}${escapeRe(a)}${ahead}`, regex: true, text: b } : { query: a, regex: false, text: b };
    }
  }
  if (target === null) return null;
  if (from.match.length === 1) return { query: from.match[0]!, regex: false, text: target };
  return { query: [...from.match].sort((x, y) => y.length - x.length).map(escapeRe).join("|"), regex: true, text: target };
}

/** 辞書を重ねる（後のものが足す）。 */
export function mergeVariantDictionaries(...dicts: (VariantDictionary | undefined | null)[]): VariantDictionary {
  const out: Required<VariantDictionary> = { add: [], ignore: [], off: [] };
  for (const d of dicts) {
    if (!d) continue;
    if (Array.isArray(d.add))
      for (const g of d.add) {
        if (!Array.isArray(g) || !g.every((x) => typeof x === "string")) continue;
        // 空の書き方はどこにも当たり、探す側の読み進めが進まないので除く
        const forms = g.filter((x) => x !== "");
        if (forms.length >= 2) out.add.push(forms);
      }
    if (Array.isArray(d.ignore)) out.ignore.push(...d.ignore.filter((x) => typeof x === "string"));
    if (Array.isArray(d.off)) out.off.push(...d.off.filter((x) => typeof x === "string"));
  }
  return out;
}

const EXCERPT = 12;

/** 表記ゆれの候補を探す。speakers は話者の名前（cast.json の speakers）、glossary は用語集（extra.glossary。語と別表記を組にする）。 */
export function findVariants(units: readonly TextUnit[], o: { speakers?: readonly string[]; dictionary?: VariantDictionary; glossary?: readonly { term?: unknown; aliases?: unknown }[] } = {}): VariantGroup[] {
  const dict = mergeVariantDictionaries(o.dictionary);
  const off = new Set(dict.off);
  const ignore = new Set(dict.ignore);
  const custom: Group[] = (dict.add ?? []).map((forms) => words(`custom:${forms[0]}`, "custom", ...forms));
  // 足した組に入っている書き方は、組み込みの組からは外す（作者の組を優先する）
  const customForms = new Set(custom.flatMap((g) => g.forms.flatMap((f) => (Array.isArray(f.match) ? f.match : []))));
  const groups = [...BUILTIN_VARIANTS.filter((g) => !g.forms.some((f) => Array.isArray(f.match) && f.match.some((m) => customForms.has(m)))), ...custom, ...glossaryGroups(o.glossary ?? []), ...(off.has("name") ? [] : nameGroups(o.speakers ?? [], units))].filter(
    (g) => !off.has(g.kind) && !ignore.has(g.id) && !ignore.has(g.id.slice(g.id.indexOf(":") + 1)) && !g.forms.some((f) => ignore.has(f.label) || (Array.isArray(f.match) && f.match.some((m) => ignore.has(m)))),
  );
  const out: VariantGroup[] = [];
  for (const g of groups) {
    const forms: (VariantForm & { def: Form })[] = g.forms.map((f) => ({ label: f.label, count: 0, occurrences: [], def: f }));
    // 書き方ごとの探し方は、ページの外で一度だけ作る（長い書き方から探す並びと、g を付けた正規表現）
    const finders = g.forms.map((f) => (f.match instanceof RegExp ? new RegExp(f.match.source, `${f.match.flags.replace("g", "")}g`) : [...f.match].filter((x) => x !== "").sort((a, b) => b.length - a.length)));
    for (const u of units) {
      g.forms.forEach((f, i) => {
        const found: { at: number; text: string }[] = [];
        const finder = finders[i]!;
        if (Array.isArray(finder)) {
          // 長い書き方から探し、重なった短い書き方は数えない
          const taken: [number, number][] = [];
          for (const m of finder) {
            for (let at = u.text.indexOf(m); at >= 0; at = u.text.indexOf(m, at + m.length)) {
              if (taken.some(([s, e]) => at < e && at + m.length > s)) continue;
              taken.push([at, at + m.length]);
              found.push({ at, text: m });
            }
          }
        } else {
          for (const m of u.text.matchAll(finder)) found.push({ at: m.index, text: m[0] });
        }
        // 話者の名前の組は、台詞の話者に使った回数も数える
        if (g.kind === "name" && u.speaker === f.label) found.push({ at: -1, text: f.label });
        for (const x of found) {
          forms[i]!.count++;
          if (forms[i]!.occurrences.length < 50 && x.at < 0) forms[i]!.occurrences.push({ file: u.file, line: u.line, text: x.text, excerpt: `${x.text}「${u.text.slice(0, EXCERPT * 2)}${u.text.length > EXCERPT * 2 ? "…" : ""}」` });
          else if (forms[i]!.occurrences.length < 50) {
            const from = Math.max(0, x.at - EXCERPT);
            const excerpt = `${from > 0 ? "…" : ""}${u.text.slice(from, x.at + x.text.length + EXCERPT).replace(/\n/g, " ")}${x.at + x.text.length + EXCERPT < u.text.length ? "…" : ""}`;
            forms[i]!.occurrences.push({ file: u.file, line: u.line, text: x.text, excerpt });
          }
        }
      });
    }
    const used = forms.filter((f) => f.count > 0);
    if (used.length < 2) continue;
    used.sort((a, b) => b.count - a.count);
    const major = used[0]!.def;
    out.push({
      id: g.id,
      kind: g.kind,
      label: g.forms.map((f) => f.label).join("／"),
      forms: used.map(({ def, ...f }, i) => {
        const replace = i === 0 ? null : variantReplace(def, major);
        return replace ? { ...f, replace } : f;
      }),
    });
  }
  return out.sort((a, b) => VARIANT_KINDS.indexOf(a.kind) - VARIANT_KINDS.indexOf(b.kind) || b.forms[1]!.count - a.forms[1]!.count);
}
