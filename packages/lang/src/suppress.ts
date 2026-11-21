import type { Diagnostic, IgnoreDirective, Script, Severity } from "./ast.ts";

/**
 * 診断の重さを code ごとに替える設定（liminalia.json の check.severity）。"off" はその code を出さない。
 * 替えられるのは警告と情報だけ（エラーは実行や書き出しで困るものなので、そのまま出す）。警告を "error" にすれば lim check が失敗する。
 *
 * ```json
 * "check": { "severity": { "single-ellipsis": "off", "unused-label": "warning", "unknown-speaker": "error" } }
 * ```
 */
export type SeverityLevel = Severity | "off";
export type SeverityConfig = Record<string, SeverityLevel>;

export const SEVERITY_LEVELS: readonly SeverityLevel[] = ["error", "warning", "info", "off"];

export interface SuppressOptions {
  /** シナリオ（ファイル名 → 構文木）。// lim-ignore のコメントを読む。 */
  scripts?: ReadonlyMap<string, Pick<Script, "ignores">> | Iterable<readonly [string, Pick<Script, "ignores">]>;
  /** liminalia.json の check.severity（形の崩れたものは読める所だけ使う）。 */
  severity?: unknown;
  /**
   * 何も黙らせなかった lim-ignore を情報（unused-ignore）で知らせる。プロジェクト全体を検査したときだけ付ける
   * （一つのファイルだけの検査では、ほかのファイルとまたぐ診断が無いので、使われていないと見誤る）。
   */
  reportUnused?: boolean;
  /** 別の検査でしか結果が分からない診断（未使用の判定から除く）。 */
  externalCodes?: ReadonlySet<string>;
}

/** check.severity の読める所（code → 重さ）。 */
export function severityConfig(raw: unknown): Map<string, SeverityLevel> {
  const out = new Map<string, SeverityLevel>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [code, level] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof level === "string" && (SEVERITY_LEVELS as readonly string[]).includes(level)) out.set(code, level as SeverityLevel);
  }
  return out;
}

/** check.severity の形の誤り（liminalia.json の 1 行目の bad-config）。 */
export function checkSeverityConfig(raw: unknown): Diagnostic[] {
  if (raw === undefined) return [];
  const out: Diagnostic[] = [];
  const at = { file: "liminalia.json", line: 1 };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    out.push({ severity: "error", code: "bad-config", message: "check.severity は 診断の code → 重さ（error、warning、info、off）の形で書きます", messageEn: "Write check.severity as diagnostic code → level (error, warning, info, off)", hint: '"severity": { "single-ellipsis": "off" }', ...at });
    return out;
  }
  for (const [code, level] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof level === "string" && (SEVERITY_LEVELS as readonly string[]).includes(level)) continue;
    out.push({ severity: "error", code: "bad-config", message: `check.severity の ${code} の重さ ${JSON.stringify(level)} は使えません（error、warning、info、off のどれか）`, messageEn: `The level ${JSON.stringify(level)} for ${code} in check.severity isn't valid (use error, warning, info, or off)`, ...at });
  }
  return out;
}

/**
 * 診断に、台本の // lim-ignore と liminalia.json の check.severity を当てる（lim check、制作画面、VS Code が最後に通す）。
 * - `// lim-ignore コード…` は次のコメントでない行の、`// lim-ignore-file コード…` はそのファイルの、その code の警告と情報を出さない
 *   （code を書かなければすべての警告と情報）
 * - check.severity は code ごとに重さを替える（"off" は出さない）
 * エラーはどちらでも黙らせない（替えない）。
 */
export function suppressDiagnostics<T extends Diagnostic>(diagnostics: readonly T[], o: SuppressOptions = {}): (T | Diagnostic)[] {
  const levels = severityConfig(o.severity);
  const scripts: Iterable<readonly [string, Pick<Script, "ignores">]> = o.scripts ?? [];
  /** ファイル → コメントの一覧（used は何かを黙らせた、error はエラーを黙らせようとした）。 */
  const byFile = new Map<string, (IgnoreDirective & { used: boolean; error: boolean })[]>();
  for (const [file, script] of scripts) {
    if (script.ignores && script.ignores.length > 0) byFile.set(file, script.ignores.map((i: IgnoreDirective) => ({ ...i, used: false, error: false })));
  }
  if (levels.size === 0 && byFile.size === 0) return [...diagnostics];
  const out: (T | Diagnostic)[] = [];
  for (const d of diagnostics) {
    const directives = byFile.get(d.file);
    if (directives) {
      const hits = directives.filter((i) => (i.target === "file" || i.target === d.line) && (i.codes.length === 0 || i.codes.includes(d.code)));
      if (hits.length > 0) {
        if (d.severity === "error") {
          for (const h of hits) if (h.codes.length > 0) h.error = true;
        } else {
          for (const h of hits) h.used = true;
          continue;
        }
      }
    }
    const level = d.severity === "error" ? undefined : levels.get(d.code);
    if (level === "off") continue;
    out.push(level && level !== d.severity ? { ...d, severity: level } : d);
  }
  if (o.reportUnused) {
    for (const [file, directives] of byFile) {
      for (const i of directives) {
        if (i.used) continue;
        if (i.codes.some((code) => o.externalCodes?.has(code))) continue;
        const what = i.codes.length > 0 ? i.codes.join(" ") : "";
        out.push({
          severity: "info",
          code: "unused-ignore",
          message: i.error
            ? `lim-ignore ではエラーを黙らせられません（${what}）`
            : i.target === "file"
              ? what
                ? `この lim-ignore-file（${what}）で黙らせる診断がファイルにありません`
                : "この lim-ignore-file で黙らせる診断がファイルにありません"
              : what
                ? `この lim-ignore（${what}）で黙らせる診断が次の行にありません`
                : "この lim-ignore で黙らせる診断が次の行にありません",
          file,
          line: i.line,
          hint: i.error ? "エラーは直します。このコメントは消します" : "要らなければこのコメントを消します。code の綴りも確かめます（lim explain で一覧）",
          fix: { kind: "delete-line", text: i.text },
        });
      }
    }
  }
  return out;
}

/** `// lim-ignore …`（次の行に効くもの）の行。 */
const LINE_IGNORE = /^(\s*)\/\/\s*lim-ignore(?:\s+(.*))?$/;

/**
 * その行（1 から）に code の診断を出さないようにする書き換え（制作画面の「この行では出さない」）。すぐ上の行が `// lim-ignore` なら
 * そこに code を足し、無ければ同じ字下げで `// lim-ignore code` の行を前に足す。row は書き換える行（1 から）、before はその行の今の中身、
 * text は新しい中身（行を足すときは改行を含む）。もう黙らせていれば null。
 */
export function ignoreLineEdit(rows: readonly string[], line: number, code: string): { row: number; before: string; text: string } | null {
  const target = rows[line - 1];
  if (target === undefined) return null;
  const above = line >= 2 ? rows[line - 2]! : null;
  const m = above === null ? null : LINE_IGNORE.exec(above.replace(/\r$/, ""));
  if (m && above !== null) {
    const codes = (m[2] ?? "").split(/[\s,、]+/).filter((c) => c !== "");
    // code の無い lim-ignore は、もうすべてを黙らせている
    if (codes.length === 0 || codes.includes(code)) return null;
    const cr = above.endsWith("\r") ? "\r" : "";
    return { row: line - 1, before: above, text: `${above.slice(0, above.length - cr.length).replace(/\s+$/, "")} ${code}${cr}` };
  }
  const indent = /^[ \t]*/.exec(target)![0];
  const newline = target.endsWith("\r") ? "\r\n" : "\n";
  return { row: line, before: target, text: `${indent}// lim-ignore ${code}${newline}${target}` };
}
