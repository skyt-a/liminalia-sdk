import type { Diagnostic, Expr } from "./ast.ts";
import { parseTargetText } from "./args.ts";
import { ExprError, parseExpr } from "./expr.ts";
import { TARGET_FUNCTIONS } from "./registry.ts";
import { isVariablePath, renameVariableInLine } from "./variables.ts";

/**
 * 台本の自動テスト（lim test の tests/*.limtest）。一つのファイルに、`# 名前` で始まるテストをいくつでも書く。
 *
 * ```
 * // ユイと北の道で会うと信頼が上がる
 * # 北の道
 * from start#intro
 * set game.trust = 1
 * choose 北の道を行く
 * choose 2
 * expect game.trust == 2
 * expect reach ending#good
 * expect text "星が見える"
 * expect no-errors
 * ```
 *
 * 行（字下げは見た目だけ。`//` はコメント）:
 * - `from 場所`: 始める位置（`ファイル` か `ファイル#ラベル`。省くと liminalia.json の entry）
 * - `from-state ファイル.json`: セーブ（lim trace --json の save か、セーブデータそのもの）から始める（テストのファイルからの相対パス）
 * - `set 変数 = 式`: 始める前に入れる値（game.・system.・temp.）
 * - `seed 数`: 乱数の種（既定 1）
 * - `choose 文` / `choose 番号`: 選択肢で選ぶもの（書いた順に使う）。番号は上から 1 で数える。文は同じ文か、その文を含む選択肢
 * - `rest stop|first|rotate`: choose を使い切ったあと（既定 stop: 次の選択肢で止める。first: いつも一つ目。rotate: 戻るたびに次）
 * - `limit 数`: これだけページを出したら止める（既定 5000）
 * - `expect 式`: 終わったときに式が真
 * - `expect reach 場所` / `expect not reach 場所`: 通った（通らなかった）。場所は `ファイル`、`ファイル#ラベル`、`ファイル:行`
 * - `expect text "文"` / `expect not text "文"`: どれかのページの本文にその文がある（無い）
 * - `expect ending 種類`: その種類のエンディング（プレイを終えるコマンドの ending=。bad など）で終わった。種類でない文字を書けば、
 *   エンディングの名前（title=）にその文字を含むもの
 * - `expect end`: 台本の終わりか、プレイを終えるコマンド（@title-screen など）まで流れた（選択肢を使い切ったり、ページの上限で止まったりしたのではない）
 * - `expect no-errors` / `expect no-warnings`: 実行時のエラー（警告も）が無い。エラーは書かなくても失敗にする
 */
export interface ScenarioTest {
  name: string;
  /** `# 名前` の行（1 始まり）。 */
  line: number;
  from?: string;
  fromState?: string;
  sets: { path: string; value: Expr; source: string; line: number }[];
  seed?: number;
  choices: { pick: number | string; line: number }[];
  rest: "stop" | "first" | "rotate";
  limit?: number;
  expects: TestExpectation[];
}

export type TestExpectation = { line: number; source: string } & (
  | { kind: "expr"; expr: Expr }
  | { kind: "reach"; place: string; not: boolean }
  | { kind: "text"; text: string; not: boolean }
  | { kind: "ending"; name: string }
  | { kind: "end" }
  | { kind: "no-errors" }
  | { kind: "no-warnings" }
);

/** テストのファイルの拡張子。 */
export const SCENARIO_TEST_EXTENSION = ".limtest";

/** .limtest を読む。読めない行は診断にする（code は bad-test。file はテストのファイルの名前。entry は作品の entry で、直し方の例に使う）。 */
export function parseScenarioTests(source: string, file: string, options: { entry?: string } = {}): { tests: ScenarioTest[]; diagnostics: Diagnostic[] } {
  const tests: ScenarioTest[] = [];
  const diagnostics: Diagnostic[] = [];
  const bad = (line: number, message: string, hint?: string) => diagnostics.push({ severity: "error", code: "bad-test", message, file, line, ...(hint ? { hint } : {}) });
  const expr = (text: string, line: number): Expr | null => {
    try {
      return parseExpr(text);
    } catch (e) {
      bad(line, `式を読めません: ${e instanceof ExprError || e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };
  let current: ScenarioTest | null = null;
  const rows = source.split("\n");
  for (let i = 0; i < rows.length; i++) {
    const line = i + 1;
    const text = rows[i]!.replace(/\r$/, "").trim();
    if (text === "" || text.startsWith("//")) continue;
    if (text.startsWith("#")) {
      const name = text.replace(/^#+/, "").trim();
      if (name === "") {
        bad(line, "テストの名前がありません", "# 北の道でユイと会う");
        continue;
      }
      current = { name, line, sets: [], choices: [], rest: "stop", expects: [] };
      tests.push(current);
      continue;
    }
    if (!current) {
      bad(line, "テストは `# 名前` の行から書きます", "# 北の道でユイと会う");
      continue;
    }
    const m = /^([a-z][a-z-]*)(?:\s+(.*))?$/.exec(text);
    const word = m?.[1] ?? "";
    const rest = (m?.[2] ?? "").trim();
    switch (word) {
      case "from": {
        const target = parseTargetText(rest);
        if (!target || target.file === null) bad(line, "from には `ファイル` か `ファイル#ラベル` を書きます", "from start#intro");
        else current.from = rest;
        break;
      }
      case "from-state":
        if (rest === "") bad(line, "from-state にはセーブの JSON のファイルを書きます", "from-state saves/chapter2.json");
        else current.fromState = rest;
        break;
      case "set": {
        const s = /^(\S+?)\s*=\s*(.+)$/.exec(rest);
        if (!s || !isVariablePath(s[1]!)) {
          bad(line, "set は `set 変数 = 式` の形で書きます（変数は game.・system.・temp.）", "set game.trust = 2");
          break;
        }
        const value = expr(s[2]!, line);
        if (value) current.sets.push({ path: s[1]!, value, source: s[2]!, line });
        break;
      }
      case "seed":
        if (!/^\d+$/.test(rest)) bad(line, "seed には整数を書きます", "seed 3");
        else current.seed = Number(rest);
        break;
      case "choose":
        if (rest === "") bad(line, "choose には選択肢の文か番号（上から 1 で数える）を書きます", "choose 北の道を行く");
        else if (/^\d+$/.test(rest)) {
          if (Number(rest) < 1) bad(line, "choose の番号は上から 1 で数えます", "choose 1");
          else current.choices.push({ pick: Number(rest) - 1, line });
        } else current.choices.push({ pick: unquote(rest), line });
        break;
      case "rest":
        if (rest !== "stop" && rest !== "first" && rest !== "rotate") bad(line, "rest には stop、first、rotate のどれかを書きます", "rest first");
        else current.rest = rest;
        break;
      case "limit":
        if (!/^\d+$/.test(rest) || Number(rest) < 1) bad(line, "limit には 1 以上の整数（ページの数）を書きます", "limit 20000");
        else current.limit = Number(rest);
        break;
      case "expect": {
        const e = expectation(rest, line);
        if (e) current.expects.push(e);
        break;
      }
      default:
        bad(line, `この行を読めません: ${text}`, "from、from-state、set、seed、choose、rest、limit、expect のどれかで始めます");
    }
  }
  return { tests, diagnostics };

  function expectation(text: string, line: number): TestExpectation | null {
    const base = { line, source: text };
    if (text === "no-errors" || text === "no-warnings" || text === "end") return { ...base, kind: text };
    const m = /^(not\s+)?(reach|text)\s+(.+)$/.exec(text);
    if (m) {
      const not = m[1] !== undefined;
      if (m[2] === "reach") {
        const place = m[3]!.trim();
        if (/^#[\p{L}\p{N}_-]+$/u.test(place)) {
          // 台本の @jump #ラベル と同じ書き方。テストはファイルをまたいで流れるので、どのファイルのラベルかを書いてもらう
          const start = current?.from ? parseTargetText(current.from)?.file : undefined;
          bad(line, "reach の場所には、ラベルのあるファイルの名前も書きます（`ファイル#ラベル`）", `expect ${not ? "not " : ""}reach ${start ?? options.entry ?? "start"}${place}`);
          return null;
        }
        if (!/^[\w./-]+(?:#[\p{L}\p{N}_-]+|:\d+)?$/u.test(place)) {
          bad(line, "reach には `ファイル`、`ファイル#ラベル`、`ファイル:行` を書きます", "expect reach ending#good");
          return null;
        }
        return { ...base, kind: "reach", place, not };
      }
      return { ...base, kind: "text", text: unquote(m[3]!.trim()), not };
    }
    const ending = /^ending\s+(.+)$/.exec(text);
    if (ending) return { ...base, kind: "ending", name: unquote(ending[1]!.trim()) };
    if (text === "") {
      bad(line, "expect には確かめることを書きます", "expect game.trust == 2");
      return null;
    }
    const e = expr(text, line);
    return e ? { ...base, kind: "expr", expr: e } : null;
  }
}

/**
 * 名前の変更（lim rename と制作画面）で、テストのファイルの中を書き換える種類。label の file はラベルのあるファイル（toFile は
 * シーンを別のファイルへ移すときの移した先）、speaker は話者名（ページの話者と比べる `expect text`）。
 */
export type ScenarioTestRename =
  | { kind: "file"; from: string; to: string }
  | { kind: "label"; file: string; from: string; to: string; toFile?: string }
  | { kind: "variable"; from: string; to: string }
  | { kind: "speaker"; from: string; to: string };

/** 式の中の飛び先を受け取る関数（visits、read）と、その最初の引数の "…"。 */
const TARGET_CALL = new RegExp(`(\\b(?:${[...TARGET_FUNCTIONS].join("|")})\\(\\s*)("(?:\\\\.|[^"\\\\])*")`, "g");

/**
 * テストのファイル（.limtest）の字面のうち、名前の変わったものを書き換える（行の数、字下げ、コメントはそのまま）。
 * - file: `from` と `expect reach` の場所（`ファイル`、`ファイル#ラベル`、`ファイル:行`）、`set` と `expect` の式の visits("…")・read("…")
 * - label: 同じ所の `ファイル#ラベル`
 * - variable: `set` の変数と式、`expect` の式
 * - speaker: `expect text` の文が話者名そのもののとき（ページの話者と比べるため）
 * left は書き換えられなかった行（式の中の `#ラベル` だけの飛び先。テストにはどのファイルから見るかが無い）。changed と left は 1 始まりの行。
 */
export function renameInScenarioTests(source: string, change: ScenarioTestRename): { text: string; changed: number[]; left: number[] } {
  const rows = source.split("\n");
  const changed: number[] = [];
  const left = new Set<number>();
  /** 場所（`ファイル`、`ファイル#ラベル`、`ファイル:行`）の新しい字面。変わらなければ null。 */
  const place = (p: string): string | null => {
    if (change.kind === "file") {
      const m = /^([^#:]+)([#:].*)?$/.exec(p);
      return m && m[1] === change.from ? `${change.to}${m[2] ?? ""}` : null;
    }
    if (change.kind === "label") return p === `${change.file}#${change.from}` ? `${change.toFile ?? change.file}#${change.to}` : null;
    return null;
  };
  /** 式の新しい字面（i は行の番号。書き換えられない飛び先があれば left に入れる）。 */
  const expr = (e: string, i: number): string => {
    if (change.kind === "variable") return renameVariableInLine(e, change.from, change.to);
    if (change.kind !== "file" && change.kind !== "label") return e;
    return e.replace(TARGET_CALL, (whole, head: string, literal: string) => {
      let value: unknown;
      try {
        value = JSON.parse(literal);
      } catch {
        // 文字の値として読めないものは書き換えない
        return whole;
      }
      if (typeof value !== "string") return whole;
      if (change.kind === "label" && value === `#${change.from}`) left.add(i + 1);
      const next = place(value);
      return next === null ? whole : `${head}${JSON.stringify(next)}`;
    });
  };
  const quoted = (t: string) => t.length >= 2 && t.startsWith('"') && t.endsWith('"');
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i]!;
    const cr = raw.endsWith("\r") ? "\r" : "";
    const line = cr ? raw.slice(0, -1) : raw;
    let next = line;
    let m: RegExpExecArray | null;
    if ((m = /^(\s*from\s+)(\S+)(\s*)$/.exec(line))) {
      const p = place(m[2]!);
      if (p !== null) next = `${m[1]}${p}${m[3]}`;
    } else if ((m = /^(\s*expect\s+(?:not\s+)?reach\s+)(\S+)(\s*)$/.exec(line))) {
      const p = place(m[2]!);
      if (p !== null) next = `${m[1]}${p}${m[3]}`;
    } else if ((m = /^(\s*expect\s+(?:not\s+)?text\s+)(.+?)(\s*)$/.exec(line))) {
      if (change.kind === "speaker" && unquote(m[2]!) === change.from) next = `${m[1]}${quoted(m[2]!) ? JSON.stringify(change.to) : change.to}${m[3]}`;
    } else if ((m = /^(\s*set\s+)(\S+?)(\s*=\s*)(.+?)(\s*)$/.exec(line))) {
      const path = change.kind === "variable" && m[2] === change.from ? change.to : m[2]!;
      next = `${m[1]}${path}${m[3]}${expr(m[4]!, i)}${m[5]}`;
    } else if ((m = /^(\s*expect\s+)(.+?)(\s*)$/.exec(line)) && !/^(?:(?:not\s+)?(?:reach|text)\s|ending\s|end$|no-errors$|no-warnings$)/.test(m[2]!)) {
      next = `${m[1]}${expr(m[2]!, i)}${m[3]}`;
    }
    if (next !== line) {
      rows[i] = next + cr;
      changed.push(i + 1);
    }
  }
  return { text: rows.join("\n"), changed, left: [...left].sort((a, b) => a - b) };
}

/** "…" で囲んだ文字列なら中身（\" と \\ を戻す）。囲んでいなければそのまま。 */
function unquote(text: string): string {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1).replace(/\\(.)/g, "$1");
  return text;
}
