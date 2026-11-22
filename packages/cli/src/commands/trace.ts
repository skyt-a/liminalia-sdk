import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isVariablePath, parseExpr, parseLiteral, type CommandSpec, type ParamType, type Registry } from "@liminalia/lang";
import { loadScenarioSource } from "@liminalia/project";
import { evaluate, HeadlessHost, Runtime, type RunResult, type SaveData, type TraceEntry, type Value } from "@liminalia/runtime";
import { loadContext, runtimeOptionsOf } from "../context.ts";
import { formatDiagnostic, inEnglish } from "./check.ts";

/** 始める前に入れる値（--set game.x=式。system. と temp. も）。 */
export interface TraceSet {
  path: string;
  value: Value;
}

/**
 * lim trace [プロジェクト] <ファイル[#ラベル]> [--choose 1,0,2] [--set game.x=1 …] [--from-state セーブ.json] [--max-pages N] [--json] [--lang en] — 画面なしで流す。
 * ページには、開始位置から 1 で数えた番号を付ける（文字は行の頭の [N]、JSON は page）。プレイヤーの ?start=開始位置&skip=N
 * と lim shot --skip N は、この N 番目のページで止まる（tracePages）。
 * --set は始める前に変数を入れ（初期値より優先）、--from-state はセーブ（lim trace --json の save か、セーブデータそのもの）から始める。
 * --json の save は、流し終えた時点から続けるセーブ（--from-state に渡せる）。
 */
export async function runTrace(dir: string, target: string, opts: { choose: (number | string)[]; maxPages?: number; json: boolean; language?: "ja" | "en"; sets?: TraceSet[]; fromState?: string }): Promise<boolean> {
  const { result, trace: raw, runtime } = await traceProject(dir, target, opts);
  const en = opts.language === "en";
  // --lang en は診断の文と直し方を英語にする（lim check --lang en と同じ）。本文と命令はそのまま
  const trace = en ? raw.map((t) => (t.type === "diagnostic" ? { ...t, diagnostic: inEnglish(t.diagnostic) } : t)) : raw;
  // 実行時のエラー（式の型の違い、無いファイルなど）があれば失敗にする（CI で止める）
  const ok = result.reason !== "error" && !trace.some((t) => t.type === "diagnostic" && t.diagnostic.severity === "error");
  // 流し終えた所は最後に動かした命令の行（@title-screen で終われば、その行）。result.at は次に動かす命令の番号で、行ではない
  const ended = runtime.at;
  if (opts.json) {
    console.log(JSON.stringify({ ok, result, endedAt: ended, trace, game: runtime.state.game, stage: runtime.state.stage, save: runtime.save() }, null, 2));
    return ok;
  }
  for (const t of trace) console.log(formatTrace(t, runtime.registry, opts.language));
  console.log(`\n${en ? "End" : "終了"}: ${result.reason} (${ended ? `${ended.file}:${ended.line}` : target})`);
  return ok;
}

/** --set の値（"game.trust=2"、"game.name=\"ユイ\""）。右辺は .lim の式（変数は読めない）。 */
export function parseSets(list: readonly string[]): TraceSet[] {
  return list.map((text) => {
    const m = /^([^=\s]+)\s*=\s*(.+)$/.exec(text.trim());
    if (!m || !isVariablePath(m[1]!)) throw new Error(`--set は 変数=式 の形で書きます（game.trust=2、game.name="ユイ"）: ${text}`);
    try {
      return { path: m[1]!, value: evaluate(parseExpr(m[2]!), { lookup: () => null, random: () => 0 }) };
    } catch (e) {
      throw new Error(`--set ${text} の式を求められません: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
}

/** --from-state のファイル（lim trace --json の出力なら save、セーブデータならそのもの）。 */
export function readState(path: string): SaveData {
  const raw = JSON.parse(readFileSync(resolve(path), "utf8")) as { save?: SaveData } & Partial<SaveData>;
  const save = (raw && typeof raw === "object" && raw.save ? raw.save : raw) as SaveData;
  if (!save || typeof save !== "object" || !save.position || !save.game) throw new Error(`${path} はセーブの形ではありません（lim trace --json の出力か、セーブデータを渡します）`);
  return save;
}

/** --choose の値（"1,北の道,0"）。数は番号（0 始まり）、ほかは選択肢の文。 */
export function parseChoose(text: string | undefined): (number | string)[] {
  if (text === undefined) return [];
  return text
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x !== "")
    .map((x) => (/^\d+$/.test(x) ? Number(x) : x));
}

/** 作品を target から画面なしで流す（lim trace の中身）。trace のページには番号が付く（tracePages）。 */
export async function traceProject(dir: string, target: string, opts: { choose?: (number | string)[]; maxPages?: number; sets?: TraceSet[]; fromState?: string } = {}): Promise<{ result: RunResult; trace: NumberedTrace[]; runtime: Runtime }> {
  const ctx = await loadContext(dir);
  const host = new HeadlessHost({
    // UTF-8 でない台本（Shift_JIS など）は化けたまま流さない
    loadSource: async (file) => loadScenarioSource(ctx.project.paths.scenario, file),
    choices: opts.choose ?? [],
    ...(opts.maxPages !== undefined ? { maxPages: opts.maxPages } : {}),
  });
  const runtime = new Runtime(host, { ...runtimeOptionsOf(ctx), onError: "continue" });
  host.onLimit = () => runtime.stop();
  host.where = () => runtime.at;
  // 始める前の値。system は実行器に、temp はロードしても残るので実行器に、game は始めるとき（セーブならセーブ）に入れる
  const start: Record<string, Value> = {};
  for (const s of opts.sets ?? []) {
    if (s.path.startsWith("system.") || (opts.fromState && s.path.startsWith("temp."))) runtime.setVariable(s.path, s.value);
    else start[s.path] = s.value;
  }
  let result: RunResult;
  if (opts.fromState) {
    const save = structuredClone(readState(opts.fromState));
    for (const [path, value] of Object.entries(start)) save.game[path.slice("game.".length)] = value;
    result = await runtime.load(save);
  } else result = await runtime.start(target, { variables: start });
  return { result, trace: tracePages(host.trace), runtime };
}

/** ページに番号を付けたもの（page は開始位置から 1 で数えたページの番号）。 */
export type NumberedTrace = Exclude<TraceEntry, { type: "page" }> | (Extract<TraceEntry, { type: "page" }> & { page?: number });

/**
 * ページに、開始位置から 1 で数えた番号を付ける。プレイヤーの ?skip=N（lim shot --skip N、VS Code と制作画面の
 * 「ここからテストプレイ」の早送り）は N 番目のページで止まるので、止めたいページの番号をそのまま渡せる。
 */
export function tracePages(trace: readonly TraceEntry[]): NumberedTrace[] {
  let n = 0;
  return trace.map((t) => (t.type === "page" ? { ...t, page: ++n } : t));
}

export function formatTrace(t: NumberedTrace, registry?: Registry, language: "ja" | "en" = "ja"): string {
  switch (t.type) {
    case "page": {
      // 名前欄の名前が話者と違えば（表示名の上書き・訳）、話者のあとに［名前欄の名前］を添える。頭の [N] は ?skip=N で止まるページの番号。
      // 英語では半角の括弧で添え、話者と本文の間を空ける。日本語でも、台詞が括弧で始まらなければ（ui.text.quotes の strip で外したもの）
      // 全角のコロンで分ける
      const label = t.label ? (language === "en" ? ` (${t.label})` : `［${t.label}］`) : "";
      const sep = !t.speaker ? "" : language === "en" ? ": " : /^[「『（(“"]/.test(t.text) ? "" : "：";
      return `${t.page !== undefined ? `[${t.page}] ` : ""}${t.file}:${t.line}  ${t.speaker ?? ""}${label}${sep}${t.text.replace(/\n/g, "⏎")}`;
    }
    case "command":
      return `    ${commandLine(t.name, shownArgs(registry?.get(t.name), t.args), registry?.get(t.name))}`;
    case "choice":
      return `    ? ${t.options.map((o, i) => (i === t.selected ? `[${o}]` : o)).join(" / ")}`;
    case "diagnostic":
      return `    ! ${formatDiagnostic(t.diagnostic)}`;
  }
}

/**
 * 文字の出力に並べる引数。コマンドの仕様の既定値と同じものは出さない（書いた引数と、作品の既定値 commandDefaults で変わったものだけが残る）。
 * 仕様に無い引数（命令が描画側へ渡す値など）はそのまま出す。
 */
export function shownArgs(spec: CommandSpec | undefined, args: Record<string, Value>): Record<string, Value> {
  if (!spec) return args;
  const out: Record<string, Value> = {};
  for (const [k, v] of Object.entries(args)) {
    const p = spec.params[k];
    const standard = p ? (p.projectDefault ? p.standardDefault : p.default) : undefined;
    if (standard !== undefined && JSON.stringify(literalOf(standard)) === JSON.stringify(v)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * 命令を .lim の書き方の一行にする（名前なしのパラメータは名前を付けずに先に、時間は単位つき、文字は要るときだけ "…"）。
 * 仕様の無い命令（描画側へ渡す値など）は名前つきで並べる。
 */
export function commandLine(name: string, args: Record<string, Value>, spec?: CommandSpec): string {
  const parts: string[] = [`@${name}`];
  const rest = { ...args };
  // 名前なしのパラメータは、前から続いているあいだだけ名前を外す（途中が抜けたら、後ろは名前つき）
  for (const p of spec?.positional ?? []) {
    if (!(p in rest)) break;
    parts.push(valueText(rest[p]!, spec?.params[p]?.type));
    delete rest[p];
  }
  for (const [k, v] of Object.entries(rest)) parts.push(`${k}=${valueText(v, spec?.params[k]?.type)}`);
  return parts.join(" ");
}

/** 値を .lim の書き方にする（時間の型はミリ秒から 300ms・1.5s、文字は空白や記号を含むときだけ "…"）。 */
function valueText(v: Value, type: ParamType | undefined): string {
  if (typeof v === "number" && type?.kind === "duration") return v !== 0 && v % 100 === 0 && v >= 1000 ? `${v / 1000}s` : `${v}ms`;
  if (typeof v === "string") {
    const plain = v !== "" && !/[\s"\\(){}]/.test(v) && parseLiteral(v).kind === "string";
    return plain ? v : JSON.stringify(v);
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/** 既定値（.lim の書き方）を実行時の値にする（時間はミリ秒）。 */
function literalOf(text: string): Value {
  const l = parseLiteral(text);
  return l.kind === "duration" ? l.ms : l.kind === "expr" ? null : l.value;
}
