import { parse, type Diagnostic, type Statement } from "@liminalia/lang";
import type { RunResult, RuntimeOptions } from "./runtime.ts";
import { explore } from "./route.ts";

/** ファイルごとに流す回数の上限の既定（lim coverage --runs、制作画面の全ルートテスト）。選び方を試し終えれば、上限より前に止める。 */
export const DEFAULT_COVERAGE_RUNS = 8;

export interface CoverageOptions {
  /** 流すファイル（拡張子なし）。 */
  files: readonly string[];
  loadSource(file: string): Promise<string>;
  /** 実行器の設定。onAssign は使わない（流し方が使う）。onStep は通った命令ごとに呼ぶ。 */
  runtime?: RuntimeOptions;
  /** ファイルごとに流す回数の上限。既定 DEFAULT_COVERAGE_RUNS。選び方をすべて試し終えたら、上限より前に止める。 */
  runs?: number;
  /** 乱数の種（random の結果）。種ごとに runs 回まで流す。既定 [1]。 */
  seeds?: readonly number[];
  /**
   * プラグインの命令が教えた行き先（"ファイル:行" → 飛び先。@liminalia/lang の promisedTargets）。
   * 通った命令の行き先のうち、画面なしで一度も選択肢（ctx.choose・ctx.pick）に出なかったものを警告にする。
   */
  promised?: ReadonlyMap<string, readonly string[]>;
  /** 一回流し終えるたびに呼ぶ（done は流し終えた回数、total は全部の回数、file はいま流したファイル）。制作画面の経過の表示。 */
  onProgress?(p: { done: number; total: number; file: string }): void;
  /** 止める合図（止めたら、そこまでの分を返す）。 */
  signal?: AbortSignal;
}

export interface CoverageReport {
  /** complete は、そのファイルの選び方をすべて試したか（false なら runs の上限か止める合図で打ち切った）。 */
  files: { file: string; /** 本文の行。 */ lines: number[]; /** 通った本文の行。 */ reached: Set<number>; complete: boolean }[];
  /** 実行時の診断（同じものはまとめて、出た回数を数える）。 */
  diagnostics: { diagnostic: Diagnostic; count: number }[];
  /** 実行の終わり方（"end"・"error"・"別ファイルへ" など）→ 回数。前に通った状態に合流して止めた回は数えない。 */
  endings: Map<string, number>;
}

/** 実行器の設定から、流し方が使うもの（onStep・onAssign）を外す。 */
function runtimeFor(o: RuntimeOptions | undefined, seed: number, defaults: Partial<RuntimeOptions>): Omit<RuntimeOptions, "onAssign" | "onStep"> {
  const { onStep: _onStep, onAssign: _onAssign, ...rest } = o ?? {};
  return { onError: "continue", ...defaults, ...rest, seed };
}

/** 一回分の診断を、同じものをまとめて数える控えに足す。 */
function addDiagnostics(into: Map<string, { diagnostic: Diagnostic; count: number }>, found: readonly Diagnostic[]): void {
  for (const d of found) {
    const key = `${d.code} ${d.file}:${d.line} ${d.message}`;
    const seen = into.get(key);
    if (seen) seen.count++;
    else into.set(key, { diagnostic: d, count: 1 });
  }
}

/**
 * 全ファイルを画面なしで、選択肢の選び方を変えながら何通りか流し、本文の網羅と実行時の診断を集める（lim coverage・制作画面の全ルートテスト）。
 * ファイルごとに先頭から、まだ試していない選び方へ広げながら（route.ts の explore）runs 回まで流す。選び方をすべて試し終えたら、そこで止める。
 * 別のファイルへ移ったら、そのファイルの網羅はそのファイル自身の実行に任せて打ち切る。
 * random は種で決まるので、種を変えないと同じ分かれ方しか通らない。seeds を複数渡すと種ごとに流し直す。
 * promised があれば、通った命令が教えた行き先のうち選択肢に一度も出なかったものを "target-never-offered" の警告にする
 * （画面なしの選び方に入れ忘れた行き先は、網羅でも道筋の探索でも通れないため）。
 */
export async function coverage(o: CoverageOptions): Promise<CoverageReport> {
  const runs = o.runs ?? DEFAULT_COVERAGE_RUNS;
  const seeds = o.seeds?.length ? o.seeds : [1];
  const speakers = o.runtime?.speakers ?? [];
  const files: CoverageReport["files"] = [];
  for (const f of o.files) {
    const lines = new Set<number>();
    const walk = (body: Statement[]) => {
      for (const s of body) {
        if (s.kind === "say" || s.kind === "prose") lines.add(s.line);
        if (s.kind === "if") for (const b of s.branches) walk(b.body);
        if (s.kind === "define") walk(s.body);
      }
    };
    const script = parse(await o.loadSource(f), f, { speakers });
    // 下書き（// lim: draft）は遊ぶ人に届かないので、流さず、網羅率にも数えない
    if (script.draft) continue;
    walk(script.body);
    files.push({ file: f, lines: [...lines].sort((a, b) => a - b), reached: new Set(), complete: true });
  }

  const diagnostics = new Map<string, { diagnostic: Diagnostic; count: number }>();
  const endings = new Map<string, number>();
  /** 通った命令の行（"ファイル:行"）と、そこで選択肢に出た飛び先。 */
  const visited = new Set<string>();
  const offered = new Map<string, Set<string>>();
  const total = files.length * seeds.length * runs;
  let done = 0;
  const onStep = o.runtime?.onStep;
  for (const entry of files) {
    const f = entry.file;
    for (const seed of seeds) {
      if (o.signal?.aborted) break;
      let left = false;
      let found: Diagnostic[] = [];
      const explored = await explore({
        start: f,
        runs,
        ...(o.signal ? { signal: o.signal } : {}),
        loadSource: (file) => o.loadSource(file),
        // @call で呼ぶだけのファイルも先頭から流すので、呼ばれていない @return は誤りにせずに次の行へ進む（ラベルごとの続きも網羅に数える）
        runtime: { ...runtimeFor(o.runtime, seed, { maxSteps: 200_000 }), returnWithoutCall: "continue" },
        ...(o.promised || onStep
          ? {
              step: (at: { file: string; line: number }) => {
                visited.add(`${at.file}:${at.line}`);
                onStep?.(at);
              },
            }
          : {}),
        present: (e, w) => {
          if (e.type !== "page") return;
          if (e.at.file !== f) {
            left = true;
            w.runtime.stop();
            return;
          }
          entry.reached.add(e.at.line);
        },
        choice: (at, _options, _w, targets) => {
          const site = `${at.file}:${at.line}`;
          if (!o.promised?.has(site)) return;
          const seen = offered.get(site) ?? new Set<string>();
          for (const t of targets ?? []) if (t) seen.add(t);
          offered.set(site, seen);
        },
        onDiagnostic: (d) => found.push(d),
        begin: () => {
          left = false;
          found = [];
        },
        ran: async ({ result, merged }: { result: RunResult; merged: boolean }) => {
          if (!merged) {
            const ending = left ? "別ファイルへ" : result.reason;
            endings.set(ending, (endings.get(ending) ?? 0) + 1);
          }
          addDiagnostics(diagnostics, found);
          if (o.onProgress) {
            o.onProgress({ done: ++done, total, file: f });
            // 経過を画面へ流し、ほかの頼みにも答えられるよう、一回ごとに手を離す
            await new Promise((r) => setTimeout(r, 0));
          }
        },
      });
      if (!explored.complete) entry.complete = false;
      // 早く試し終えた分も、経過は上限の回数まで進める
      done += runs - explored.runs;
    }
  }
  for (const [site, targets] of o.promised ?? []) {
    if (!visited.has(site)) continue;
    const seen = offered.get(site);
    const missing = targets.filter((t) => !seen?.has(t));
    if (missing.length === 0) continue;
    const at = site.lastIndexOf(":");
    const diagnostic: Diagnostic = {
      severity: "warning",
      code: "target-never-offered",
      message: `命令が教えた行き先 ${missing.join("・")} が、画面なしで流したとき一度も選択肢に出ませんでした（全ルートテストでもルートの探索でも通れません）`,
      file: site.slice(0, at),
      line: Number(site.slice(at + 1)),
      hint: "この命令の run で、描画側が答えを返さないときに選ぶ一覧（ctx.pick か ctx.choose）にこの行き先を入れてください。targets と同じ一覧から作ると漏れません",
    };
    diagnostics.set(`${diagnostic.code} ${site}`, { diagnostic, count: 1 });
  }
  return { files, diagnostics: [...diagnostics.values()], endings };
}

export interface RouteCoverageOptions {
  /** 「はじめから」の位置（`ファイル` か `ファイル#ラベル`。liminalia.json の entry）。 */
  entry: string;
  loadSource(file: string): Promise<string>;
  /** 実行器の設定。onAssign は使わない（流し方が使う）。onStep は通った命令ごとに呼ぶ。 */
  runtime?: RuntimeOptions;
  /** 流す回数の上限。既定 8。選び方をすべて試し終えたら、上限より前に止める。 */
  runs?: number;
  seeds?: readonly number[];
  /**
   * プレイを終える命令の行（"ファイル:行" → エンディングの名前。@title-screen ending= など）。そこに来たら、その実行はそのエンディングに届いたとして止める。
   */
  endings?: ReadonlyMap<string, string>;
}

export interface RouteCoverageReport {
  /** ファイル → 通った本文の行（ファイルをまたいで流したもの）。 */
  reached: Map<string, Set<number>>;
  /** 届いた終わり方（名前 → 回数）。プレイを終える命令で止まらなかったものは "ファイルの終わり（file:行）" などの名前。 */
  endings: Map<string, number>;
  /**
   * 実行ごとの終わり方と、選んだ選択肢の数。merged は、前に通ったのと同じ状態の選択肢に来たので、その先を流さずに止めた回
   * （ending は止めた場所の名前で、endings には数えない）。
   */
  runs: { seed: number; run: number; ending: string; choices: number; at: { file: string; line: number } | null; merged?: true }[];
  /** 選び方をすべて試したか（false なら runs の上限で打ち切った。種のどれかで打ち切れば false）。 */
  complete: boolean;
  diagnostics: { diagnostic: Diagnostic; count: number }[];
}

/**
 * 「はじめから」の位置から、ファイルをまたいで最後まで流す（lim coverage のルートの網羅）。ほかのファイルで決めた変数を引き継いだまま進むので、
 * 前の章の選択で分かれる先も通る。選び方は、まだ試していないものへ広げていく（coverage と同じ。route.ts の explore）。
 * プレイを終える命令（endings）に来たら、そのエンディングに届いたとして止める。
 */
export async function routeCoverage(o: RouteCoverageOptions): Promise<RouteCoverageReport> {
  const runs = o.runs ?? 8;
  const seeds = o.seeds?.length ? o.seeds : [1];
  const reached = new Map<string, Set<number>>();
  const endings = new Map<string, number>();
  const diagnostics = new Map<string, { diagnostic: Diagnostic; count: number }>();
  const out: RouteCoverageReport["runs"] = [];
  let complete = true;
  const onStep = o.runtime?.onStep;
  for (const seed of seeds) {
    let ending: string | null = null;
    let last: { file: string; line: number } | null = null;
    let found: Diagnostic[] = [];
    const explored = await explore({
      start: o.entry,
      runs,
      loadSource: (file) => o.loadSource(file),
      runtime: runtimeFor(o.runtime, seed, { maxSteps: 400_000 }),
      step: (at, w) => {
        last = at;
        const name = o.endings?.get(`${at.file}:${at.line}`);
        if (name !== undefined && ending === null) {
          ending = name;
          w.runtime.stop();
        }
        onStep?.(at);
      },
      present: (e) => {
        if (e.type !== "page") return;
        const set = reached.get(e.at.file) ?? new Set<number>();
        set.add(e.at.line);
        reached.set(e.at.file, set);
      },
      onDiagnostic: (d) => found.push(d),
      begin: () => {
        ending = null;
        last = null;
        found = [];
      },
      ran: ({ index, result, walk, merged }) => {
        const at = last as { file: string; line: number } | null;
        const where = at ? `${at.file}:${at.line}` : o.entry;
        const reason = ending as string | null;
        const name = reason ?? (result.reason === "end" ? `ファイルの終わり（${where}）` : result.reason === "max-steps" ? `終わらない（${where} で手数の上限）` : result.reason === "error" ? `エラーで止まった（${where}）` : `止まった（${where}）`);
        if (!merged) endings.set(name, (endings.get(name) ?? 0) + 1);
        out.push({ seed, run: index, ending: name, choices: walk.choices.length, at, ...(merged ? { merged: true as const } : {}) });
        addDiagnostics(diagnostics, found);
      },
    });
    if (!explored.complete) complete = false;
  }
  return { reached, endings, runs: out, complete, diagnostics: [...diagnostics.values()] };
}
