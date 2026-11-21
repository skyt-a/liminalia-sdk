import type { Diagnostic, DiagnosticFix, Inline, Script, Statement } from "./ast.ts";
import { plainText } from "./inline.ts";

/**
 * 約物の検査（台詞・地の文・選択肢の文。構文チェックの一部で、作品ごとに外せる）。
 *
 * - bracket-mismatch（警告）: 「」『』（）【】の閉じ忘れ・開き忘れ・入れ子の食い違い。一行（一つの台詞・地の文・選択肢）の中で数える
 * - doubled-punctuation（警告）: 同じ句読点の重なり（。。、、、）
 * - space-after-exclamation（情報）: 文の途中の！？の後に全角の空白が無い（閉じ括弧・！？・…・―・行の終わりの前と、
 *   「と」「って」などで受けるとき（「都会！ってこと」「危ない！と叫ぶ」）は要らない）。半角の空白は全角にそろえる。一行の中の一つずつを知らせる
 * - single-ellipsis（情報）: 三点リーダー（…）とダッシュ（―）を一つだけ書いている（二つ重ねて「……」「――」にする）
 *
 * liminalia.json の check.punctuation で外す: false ならすべて、{ "off": ["single-ellipsis", …] } なら書いたものだけ。
 *
 * space-after-exclamation と single-ellipsis は日本語の組版の決まり（書き方の好み）なので、原文の言語（liminalia.json の languages の先頭。
 * 無ければ日本語）が日本語の作品だけにかける。英語の "Wait…" や "Hmm—" を直させない。行ごとに日本語の字があるかでは決めない
 * （日本語の作品の「…」だけの行は日本語の字を持たないが、直したい行そのもの）。括弧の食い違いと句読点の重なりは誤りなので、どの言語でも見る。
 */
export const PUNCTUATION_CODES = ["bracket-mismatch", "doubled-punctuation", "space-after-exclamation", "single-ellipsis"] as const;
export type PunctuationCode = (typeof PUNCTUATION_CODES)[number];

/** liminalia.json の check.punctuation（false ですべて外す。off で一つずつ外す）。 */
export type PunctuationConfig = boolean | { off?: string[] };

const PAIRS: Record<string, string> = { "「": "」", "『": "』", "（": "）", "【": "】" };
const CLOSERS = new Set(Object.values(PAIRS));
/** ！？の後に空白が要らない字（閉じ括弧・続く！？・三点リーダー・ダッシュ・空白）。 */
const NO_SPACE_BEFORE = /[」』）】〉》\])！？!?…‥―─ー〜～\s　]/;
/** ！？を「と」「って」などで受けて文が続くとき（「都会！ってこと」「危ない！と叫ぶ」）。空白を入れない。 */
const QUOTED_AFTER = /^(?:って|っと|と|など|なんて|とか)/;

/** 日本語の組版の決まり（原文の言語が日本語の作品だけにかける）。 */
export const JAPANESE_STYLE_CODES: ReadonlySet<PunctuationCode> = new Set(["space-after-exclamation", "single-ellipsis"]);

/** 外していない検査の名前（config が false なら空）。language は原文の言語（省略は日本語）で、日本語でなければ日本語の組版の決まりを外す。 */
export function punctuationCodes(config: PunctuationConfig | undefined, language?: string): Set<PunctuationCode> {
  if (config === false) return new Set();
  const off = new Set(typeof config === "object" && config && Array.isArray(config.off) ? config.off : []);
  const japanese = language === undefined || language === "" || language === "ja";
  return new Set(PUNCTUATION_CODES.filter((c) => !off.has(c) && (japanese || !JAPANESE_STYLE_CODES.has(c))));
}

/** 一つの文の約物を検査する（text は表示される文字。ルビは親文字、本文の中のコマンドは除いたもの）。 */
export function punctuationProblems(text: string, codes: ReadonlySet<PunctuationCode>): { code: PunctuationCode; severity: "warning" | "info"; message: string; hint?: string; fix?: DiagnosticFix }[] {
  const out: ReturnType<typeof punctuationProblems> = [];
  if (codes.has("bracket-mismatch")) {
    const stack: string[] = [];
    let bad: string | null = null;
    for (const c of text) {
      if (PAIRS[c]) stack.push(c);
      else if (CLOSERS.has(c)) {
        const open = stack.pop();
        if (open === undefined) {
          bad = `閉じ括弧 ${c} に対応する開き括弧がありません`;
          break;
        }
        if (PAIRS[open] !== c) {
          bad = `${open} を ${c} で閉じています（${PAIRS[open]} で閉じます）`;
          break;
        }
      }
    }
    if (bad === null && stack.length > 0) bad = `${stack.at(-1)} の閉じ括弧 ${PAIRS[stack.at(-1)!]} がありません`;
    if (bad !== null) out.push({ code: "bracket-mismatch", severity: "warning", message: bad, hint: "括弧の組をそろえます" });
  }
  if (codes.has("doubled-punctuation")) {
    const m = /([、。，．])\1+/.exec(text);
    if (m) out.push({ code: "doubled-punctuation", severity: "warning", message: `句読点 ${m[1]} が重なっています`, hint: `${m[0]} を ${m[1]} にします`, fix: { kind: "replace", find: m[0], with: m[1]! } });
  }
  if (codes.has("space-after-exclamation")) {
    for (let at = text.search(/[！？]/); at >= 0; ) {
      const next = text[at + 1];
      // 半角の空白で区切っているものは全角にそろえる（文の途中のときだけ）
      const after = text[at + 2];
      if (next === " " && after !== undefined && !NO_SPACE_BEFORE.test(after)) {
        const mark = text[at]!;
        out.push({ code: "space-after-exclamation", severity: "info", message: `文の途中の ${mark} の後の空白が半角です`, hint: `${mark} の後の空白を全角にします`, fix: { kind: "replace", find: `${mark} ${after}`, with: `${mark}　${after}` } });
      } else if (next !== undefined && !NO_SPACE_BEFORE.test(next) && !QUOTED_AFTER.test(text.slice(at + 1))) {
        const mark = text[at]!;
        const pair = mark + next;
        const spaced = `${mark}　${next}`;
        // 一行に二つ以上あれば一つずつ知らせる（まとめて直すときは同じ行に順に当てる）
        out.push({ code: "space-after-exclamation", severity: "info", message: `文の途中の ${mark} の後に全角の空白がありません`, hint: `${pair} を ${spaced} にします`, fix: { kind: "replace", find: pair, with: spaced } });
      }
      const rest = text.slice(at + 1).search(/[！？]/);
      at = rest < 0 ? -1 : at + 1 + rest;
    }
  }
  if (codes.has("single-ellipsis")) {
    const m = /(?<!…)…(?!…)|(?<!―)―(?!―)/.exec(text);
    if (m) {
      const c = m[0];
      const two = c + c;
      // 置き換える所は前後の字ごと探す（同じ行の「……」の片方を三つにしない）
      const before = text.slice(Math.max(0, m.index - 1), m.index);
      const after = text.slice(m.index + 1, m.index + 2);
      out.push({ code: "single-ellipsis", severity: "info", message: c === "―" ? "ダッシュ ― が一つだけです" : "三点リーダー … が一つだけです", hint: `${two} と二つ重ねます`, fix: { kind: "replace", find: before + c + after, with: before + two + after } });
    }
  }
  return out;
}

/**
 * 読み解いた台本ごとの、前の検査の結果（見る約物の組 → 診断）。結果は台本と見る約物だけで決まるので、制作画面が保存のたびに
 * 作品全体を検査し直しても、書き換えていない台本（同じ Script のまま）は数え直さない。返すのは写し（呼ぶ側が並べ替えても控えは変わらない）。
 */
const punctuationMemo = new WeakMap<Script, { key: string; out: Diagnostic[] }>();

/** シナリオの台詞・地の文・選択肢の約物を検査する。language は原文の言語（省略は日本語）。 */
export function checkPunctuation(script: Script, config: PunctuationConfig | undefined, language?: string): Diagnostic[] {
  const codes = punctuationCodes(config, language);
  if (codes.size === 0) return [];
  const key = [...codes].sort().join(",");
  const memo = punctuationMemo.get(script);
  if (memo?.key === key) return memo.out.map((d) => ({ ...d }));
  const out: Diagnostic[] = [];
  // 本文の解析に失敗した行（{r 漢字} の閉じ忘れなど）は、読めた所までの文字で括弧を数えると誤って知らせるので見ない
  const broken = new Set(script.diagnostics.filter((d) => d.severity === "error").map((d) => d.line));
  const add = (content: Inline[], line: number) => {
    if (broken.has(line)) return;
    for (const p of punctuationProblems(plainText(content), codes)) out.push({ severity: p.severity, code: p.code, message: p.message, file: script.file, line, ...(p.hint ? { hint: p.hint } : {}), ...(p.fix ? { fix: p.fix } : {}) });
  };
  const visit = (body: readonly Statement[]) => {
    for (const s of body) {
      if (s.kind === "say" || s.kind === "prose") add(s.content, s.line);
      else if (s.kind === "choice") for (const o of s.options) add(o.content, o.line);
      else if (s.kind === "if") for (const b of s.branches) visit(b.body);
      else if (s.kind === "define") visit(s.body);
    }
  };
  visit(script.body);
  punctuationMemo.set(script, { key, out: out.map((d) => ({ ...d })) });
  return out;
}
