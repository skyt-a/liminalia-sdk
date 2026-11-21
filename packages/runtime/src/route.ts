import type { Diagnostic } from "@liminalia/lang";
import type { ChoiceLook, Host, PresentEvent } from "./host.ts";
import { Runtime, type RunResult, type RuntimeOptions } from "./runtime.ts";
import { clonePlain, type SaveData } from "./state.ts";
import type { Scope, Value } from "./value.ts";

/**
 * 画面なしで流して「道筋」（どの選択肢を選んで来たか）を探す仕組み。ブラウザでも Node でも動く。
 * 書き出しに同梱するテスト用セーブ（lim build --seed）と、制作画面の各行の状態（現在地）が使う。
 *
 * 選び方: plan（何回目の選択で何番を選ぶか）を先に使い、使い切ったら、同じ選択肢（文の並びが同じもの）に
 * 戻ってくるたびに (offset + 戻った回数) 番目を選ぶ。外れを選ぶと同じ選択肢に戻る作りの場面でも、輪から抜けられる。
 */

/** 選んだ選択肢。 */
export interface ChoiceMade {
  file: string;
  line: number;
  /** 選んだ番号（0 始まり）と、選択肢の数・文。 */
  picked: number;
  count: number;
  text: string;
  /** order で試す順を決めたときの、その順の中の位置（picked = order[rank]）。 */
  rank?: number;
}

/** 変数のパス → その値を最後に決めた行。 */
export type Assignments = Record<string, { file: string; line: number }>;

/** 流している途中の様子（手がかりの関数に渡す）。 */
export interface Walk {
  runtime: Runtime;
  /** ここまでに選んだ選択肢（start が save なら、そこから後のもの）。 */
  choices: ChoiceMade[];
  /** ここまでに変数を決めた行（start で渡したものに足していく）。 */
  assigned: Assignments;
}

export interface WalkOptions {
  loadSource(file: string): Promise<string>;
  /** 実行器の設定（話者・作品固有の命令など）。onAssign・onStep は walk が使うので渡さない。 */
  runtime?: Omit<RuntimeOptions, "onAssign" | "onStep">;
  /** 開始位置（ファイル[#ラベル]）か、セーブから再開（temp・system・assigned はその時点のもの）。 */
  start: string | { save: SaveData; temp?: Scope; system?: Scope; assigned?: Assignments };
  /** 何回目の選択で何番を選ぶか（order があれば、order の中の位置）。 */
  plan?: readonly number[];
  offset?: number;
  /**
   * 選択肢を試す順（選択肢の番号の並び）。あれば plan はこの順の中の位置で、plan を使い切ったら、同じ選択肢に戻ってくるたびに
   * この順で次のものを選ぶ（目標に近いものから試す探索に使う）。
   */
  order?(at: { file: string; line: number }, options: string[], walk: Walk, targets?: (string | null)[]): number[];
  /**
   * plan を使い切ったときに選ぶ番号（出した選択肢の中の番号）。無ければ、同じ選択肢に戻ってくるたびに次のものを選ぶ（offset から）。
   * order があれば order を使う。
   */
  pick?(at: { file: string; line: number }, options: string[], walk: Walk, targets?: (string | null)[]): number;
  /** 描画側へ送るものすべて（ページ、本文、改行、命令）を、送るたびに呼ぶ（page・choice より先）。 */
  present?(event: PresentEvent, walk: Walk): void;
  /** ページを出す直前に呼ぶ（runtime.save() はそのページから再開するセーブになる）。true を返すとそこで止める。key はページの鍵（既読を見るため）。 */
  page?(at: { file: string; line: number; key?: string }, walk: Walk): boolean | void;
  /** 選択肢を出す直前（選ぶ前）に呼ぶ（runtime.save() はその選択肢から再開するセーブになる。targets は選択肢の飛び先）。true を返すとそこで止める。 */
  choice?(at: { file: string; line: number }, options: string[], walk: Walk, targets?: (string | null)[]): boolean | void;
  /** 一つの命令を実行する直前に呼ぶ（runtime.save() はその命令から再開するセーブ、つまり前の命令を実行した直後の状態）。 */
  step?(at: { file: string; line: number }, walk: Walk): void;
  /**
   * 描画側へ送るたびと選択肢を選ぶ前に呼び、Promise を返せばそれを待ってから続ける。流している間も、ときどきほかの処理
   * （開発サーバーのほかの要求など）へ手を離すため。
   */
  pause?(): void | Promise<void>;
  onDiagnostic?(d: Diagnostic): void;
}

/** 選択肢の文（画像のボタンで文が無いものは画像の名前）。 */
function optionTexts(texts: string[], looks?: (ChoiceLook | null)[]): string[] {
  return texts.map((t, i) => t || looks?.[i]?.image || t);
}

/** 一回流す。止めた・終わった・上限に達したら返る。 */
export async function walk(o: WalkOptions): Promise<{ result: RunResult; walk: Walk }> {
  const plan = o.plan ?? [];
  const offset = o.offset ?? 0;
  const seen = new Map<string, number>();
  const start = typeof o.start === "string" ? null : o.start;
  const state: Walk = { runtime: null as unknown as Runtime, choices: [], assigned: { ...(start?.assigned ?? {}) } };
  const host: Host = {
    // 人が操作せずに流す（命令の autoplay の答えで進める）
    automated: true,
    loadSource: (file) => o.loadSource(file),
    present: async (event: PresentEvent) => {
      o.present?.(event, state);
      if (event.type === "page" && o.page?.(event.key ? { ...event.at, key: event.key } : event.at, state)) runtime.stop();
      const paused = o.pause?.();
      if (paused) await paused;
    },
    waitClick: async () => {},
    choose: async (texts, _signal, looks, targets) => {
      const paused = o.pause?.();
      if (paused) await paused;
      const at = runtime.at ?? { file: "", line: 0 };
      if (o.choice?.(at, optionTexts(texts, looks), state, targets)) {
        runtime.stop();
        return null;
      }
      const key = texts.join("\u0000");
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      const order = o.order?.(at, optionTexts(texts, looks), state, targets);
      if (order && order.length === texts.length) {
        const rank = Math.min(plan[state.choices.length] ?? n % texts.length, texts.length - 1);
        const picked = order[rank]!;
        state.choices.push({ file: at.file, line: at.line, picked, count: texts.length, text: optionTexts(texts, looks)[picked] ?? "", rank });
        return picked;
      }
      const planned = plan[state.choices.length];
      const picked = Math.min(Math.max(0, planned ?? o.pick?.(at, optionTexts(texts, looks), state, targets) ?? (offset + n) % texts.length), texts.length - 1);
      state.choices.push({ file: at.file, line: at.line, picked, count: texts.length, text: optionTexts(texts, looks)[picked] ?? "" });
      return picked;
    },
    ...(o.onDiagnostic ? { onDiagnostic: (d: Diagnostic) => o.onDiagnostic!(d) } : {}),
  };
  const runtime = new Runtime(host, {
    ...o.runtime,
    onAssign: (path: string, _value: Value, at: { file: string; line: number }) => {
      state.assigned[path] = at;
    },
    ...(o.step ? { onStep: (at: { file: string; line: number }) => o.step!(at, state) } : {}),
  });
  state.runtime = runtime;
  if (start) {
    if (start.temp) runtime.state.temp = structuredClone(start.temp);
    if (start.system) runtime.system = structuredClone(start.system);
    return { result: await runtime.load(start.save), walk: state };
  }
  return { result: await runtime.start(o.start as string), walk: state };
}

/** 着いた時点の様子。 */
export interface Reached {
  /** 着いたページ（選択肢）から再開するセーブ。 */
  save: SaveData;
  temp: Scope;
  system: Scope;
  at: { file: string; line: number };
  /** 着くまでに選んだ選択肢。 */
  choices: ChoiceMade[];
  assigned: Assignments;
}

export interface FindRouteOptions extends Omit<WalkOptions, "page" | "choice" | "plan" | "offset"> {
  /**
   * 着いたと見なすか。ページと選択肢を出す直前ごとに呼ぶ。kind はページか選択肢か（選択肢で着いたと見なさないなら "choice" に false を返す）。
   * walk は途中の様子（着かなかった道筋の途中も、ほかのファイルへの道筋として控えられる）。
   */
  reached(kind: "page" | "choice", at: { file: string; line: number }, walk: Walk): boolean;
  /**
   * この回をあきらめるか（ページと選択肢を出す直前ごとに、reached で着かなかったときに呼ぶ）。true ならその回をそこで打ち切り、
   * 着かなかったものとして次の選び方へ進む（着かないと分かった回を終わりまで流さないため）。
   */
  giveUp?(walk: Walk): boolean;
  /** やり直す回数の上限。既定 400。 */
  attempts?: number;
}

/** その時点の様子を控える。 */
export function capture(walk: Walk, at: { file: string; line: number }): Reached {
  return {
    save: walk.runtime.save(),
    temp: clonePlain(walk.runtime.state.temp),
    system: clonePlain(walk.runtime.system),
    at,
    choices: walk.choices.map((c) => ({ ...c })),
    assigned: { ...walk.assigned },
  };
}

/**
 * 後戻りの探索で、start から reached に着く道筋を探す。着かなければ、最後の選択を次の番号に変えてやり直す
 * （選び尽くしたらその前の選択へ）。外れの選択でバッドエンドに行った道筋は捨て、着けた最初の道筋を使う。
 * 見つからなければ null。
 */
export async function findRoute(o: FindRouteOptions): Promise<Reached | null> {
  let plan: number[] = [];
  for (let attempt = 0; attempt < (o.attempts ?? 400); attempt++) {
    const box: { found: Reached | null } = { found: null };
    const check = (kind: "page" | "choice", at: { file: string; line: number }, w: Walk) => {
      if (box.found) return false;
      if (!o.reached(kind, at, w)) return o.giveUp?.(w) ?? false;
      box.found = capture(w, at);
      return true;
    };
    const { walk: w } = await walk({ ...o, plan, page: (at, w) => check("page", { file: at.file, line: at.line }, w), choice: (at, _options, w) => check("choice", at, w) });
    if (box.found) return box.found;
    // 最後の選択を次のものに変えてやり直す（試す順があれば、その順の次）
    const choices = w.choices;
    const pos = (c: ChoiceMade) => c.rank ?? c.picked;
    let i = choices.length - 1;
    while (i >= 0 && pos(choices[i]!) + 1 >= choices[i]!.count) i--;
    if (i < 0) break;
    plan = [...choices.slice(0, i).map(pos), pos(choices[i]!) + 1];
  }
  return null;
}

// ---- 選び方を広げて流す（全ルートテスト、lim coverage） ----

/** 選び方の木の一つの選択肢（ある選び方で来て出た、ある選択肢）。 */
interface ExploreNode {
  /** ここへ来るまでに選んだ番号の並び。 */
  prefix: number[];
  /** 選択肢の場所（"ファイル:行"）と、出した選択肢の文。 */
  site: string;
  options: string[];
  /** 試した番号。 */
  tried: boolean[];
}

export interface ExploreOptions extends Omit<WalkOptions, "start" | "plan" | "offset" | "order" | "pick" | "choice"> {
  /** 開始位置（ファイル[#ラベル]）。 */
  start: string;
  /** 流す回数の上限。 */
  runs: number;
  /** 止める合図（止めたら、そこまでで返す）。 */
  signal?: AbortSignal;
  /** 選択肢を出す直前（選ぶ前）に呼ぶ（targets は選択肢の飛び先）。true ならその回をそこで止める。 */
  choice?(at: { file: string; line: number }, options: string[], walk: Walk, targets?: (string | null)[]): boolean | void;
  /** 一回流す前に呼ぶ（回ごとの控えを片づける）。index は 0 から数えた回。 */
  begin?(index: number): void;
  /**
   * 一回流し終えるたびに呼ぶ。merged は、前の回で通ったのと同じ状態の選択肢に来たので、その先を流さずに止めた回
   * （その先は前の回の選び方で試すので、終わり方には数えない）。
   */
  ran?(run: { index: number; result: RunResult; walk: Walk; merged: boolean }): void | Promise<void>;
}

export interface Exploration {
  /** 流した回数。 */
  runs: number;
  /** 選び方をすべて試したか（false なら上限か止める合図で打ち切った）。 */
  complete: boolean;
}

/**
 * 選択肢の選び方を、まだ試していないものへ広げながら何回も流す（全ルートテストと lim coverage）。
 *
 * - 流した選び方を木に覚え、次の回は、まだ試していない「選択肢と番号」の組を一つ選び、そこまでの選び方をなぞってからそれを選ぶ。
 *   選ぶ組は、その選択肢（場所と文）がまだ一度も選ばれていないものを先に、次に浅いもの（先に出る選択肢）を先にする。
 *   試していない組が無くなれば、すべての選び方を試し終えたので止める（complete）。小さな作品は上限までにすべての道を通る。
 * - なぞった先の、初めて出る選択肢では、その場所でまだ選ばれた数の少ない選択肢を選ぶ（同じ選択肢へ戻る輪も、いずれ別のものを選んで抜ける）。
 * - 前の回で通ったのと同じ状態（場所、変数、呼び出し、舞台など）の選択肢に別の選び方で来たら、その先は同じ流れになるので、その回をそこで止める
 *   （merged）。ラベルに入った回数と選んだ回数は 2 回以上を同じとみなす（外れを選ぶと戻る輪を何周しても同じ状態にするため）。
 * - random は seed で決まるので、同じ選び方なら同じ流れになる（なぞれる）。
 */
export async function explore(o: ExploreOptions): Promise<Exploration> {
  const { start, runs: limit, signal, choice, begin, ran, ...rest } = o;
  const nodes = new Map<string, ExploreNode>();
  const list: ExploreNode[] = [];
  const states = new Set<string>();
  /** 選択肢（場所と文）→ 選んだ回数（すべての回の合計）。 */
  const taken = new Map<string, number>();
  const takenKey = (site: string, text: string) => `${site}\u0000${text}`;
  const prefixOf = (w: Walk) => w.choices.map((c) => c.picked).join(",");
  let plan: number[] = [];
  let runs = 0;
  while (runs < limit && !signal?.aborted) {
    const index = runs++;
    begin?.(index);
    let merged = false;
    const { result, walk: w } = await walk({
      ...rest,
      start,
      choice: (at, options, w, targets) => {
        if (choice?.(at, options, w, targets)) return true;
        const prefix = prefixOf(w);
        if (nodes.has(prefix)) return false;
        // 初めて出た選択肢。前に通った状態なら、その先は前の回で試すので止める
        const key = stateKey(w.runtime, at, options);
        if (states.has(key)) {
          merged = true;
          return true;
        }
        states.add(key);
        const node: ExploreNode = { prefix: w.choices.map((c) => c.picked), site: `${at.file}:${at.line}`, options, tried: options.map(() => false) };
        nodes.set(prefix, node);
        list.push(node);
        return false;
      },
      pick: (at, options, w) => {
        const i = w.choices.length;
        const site = `${at.file}:${at.line}`;
        let picked = 0;
        if (i < plan.length) picked = Math.min(plan[i]!, options.length - 1);
        else {
          // その場所でまだ選ばれた数の少ないもの（同じなら上のもの）
          let fewest = Infinity;
          options.forEach((text, n) => {
            const count = taken.get(takenKey(site, text)) ?? 0;
            if (count < fewest) [fewest, picked] = [count, n];
          });
        }
        const node = nodes.get(prefixOf(w));
        if (node && picked < node.tried.length) node.tried[picked] = true;
        const key = takenKey(site, options[picked] ?? "");
        taken.set(key, (taken.get(key) ?? 0) + 1);
        return picked;
      },
    });
    await ran?.({ index, result, walk: w, merged });
    // 次に試す組: まだ選ばれていない選択肢を先に、次に浅いものを先に
    let next: { node: ExploreNode; n: number; count: number } | null = null;
    for (const node of list) {
      for (let n = 0; n < node.tried.length; n++) {
        if (node.tried[n]) continue;
        const count = taken.get(takenKey(node.site, node.options[n] ?? "")) ?? 0;
        if (!next || count < next.count || (count === next.count && node.prefix.length < next.node.prefix.length)) next = { node, n, count };
      }
    }
    if (!next) return { runs, complete: true };
    plan = [...next.node.prefix, next.n];
  }
  return { runs, complete: false };
}

/** 状態の比べ合わせで、ラベルに入った回数と選んだ回数をこの回数までで区別する。 */
const COUNT_CAP = 2;

/**
 * 選択肢を出す時点の状態の鍵。同じ鍵なら、その先の流れ（通る行、終わり方、実行時の診断）は同じになる。
 * 場所、出した選択肢、呼び出しの戻り先、変数（game、system、temp、局所変数）、乱数の種、舞台（NVL の読んだ文は除く）、
 * 取っておいた状態、ラベルに入った回数と選んだ回数（COUNT_CAP まで）を見る。本文の出し分けの進み（variants）は流れを変えないので見ない。
 */
function stateKey(runtime: Runtime, at: { file: string; line: number }, options: string[]): string {
  const s = runtime.save();
  const place = (p: { unit: string; index: number }) => [p.unit, p.index];
  const capped = (r: Record<string, number> | undefined) => (r ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.min(v, COUNT_CAP)])) : null);
  const { nvlPages: _pages, noclickPage: _noclick, ...stage } = s.stage;
  return stableJson([
    at.file,
    at.line,
    options,
    place(s.position),
    s.callStack.map((f) => [place(f.return), f.locals, f.result ?? null, f.content ?? null, f.scene ?? false]),
    s.locals,
    s.game,
    s.seed,
    capped(s.visits),
    capped(s.chosen),
    stage,
    s.sleep ?? null,
    s.checkpoints ?? null,
    runtime.state.temp,
    runtime.system,
  ]);
}

/** キーの順によらない JSON（同じ変数を違う順に入れた状態を同じにする）。 */
function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
}
