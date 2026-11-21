import { parseExpr, type AutoLayoutContext, type Cast, variablePaths, type Expr, type Script, type Statement } from "@liminalia/lang";
import { capture, evaluate, findRoute, walk, type ChoiceMade, type Reached, type RuntimeOptions, type StageState, type Value, type Walk } from "@liminalia/runtime";
import type { AfterState, LineState, Origin, RouteStep, StageMarks, StageTrack, StoryMap, Sweep } from "./protocol.ts";
import { stagePositions } from "./stage-positions.ts";

/**
 * 現在地（各行の本番どおりの状態）を作る。ブラウザでも Node でも動く（開発サーバーは server/ から使う）。
 *
 * 1. 道筋: はじめから画面なしで流し、@liminalia/runtime の findRoute（後戻りの探索。lim build --seed と同じ）で
 *    そのファイルに最初に入る（そのファイルの命令を最初に実行する）道筋を探す。探す途中で通ったファイルも、最初に入った時点を控える。
 *    控えたものは、どれかの .lim が変わるまで使い回す（reset）。
 * 2. ファイルの中: 着いた時点から、選び方をずらして（offset）何回か流し、本文の行と選択肢の行を初めて通ったときの状態を控える。
 *    それ以外の行（命令・@set・@if・ラベルなど）は、その行を実行し終えた直後の状態（after）を控える。実行し終えたことは、
 *    次の命令を実行する直前（呼び出しの深さがその行と同じか浅い命令。@call・@define の呼び出しなら、呼んだ先から戻ってきたとき）で知る。
 *    そのファイルから出たら（@call で戻ってくる途中を除く）その回を打ち切る。
 *    変数とその出どころは、着いた時点（base）から変わったものだけを行に持ち、選んだ選択肢は回ごとの並び（runs）を指す
 *    （protocol.ts の lineSave・lineAssigned・lineChoices）。
 * 持続の帯（stageTrack）は、できた現在地から舞台の持続するものだけを抜き出す。
 *
 * 3. 届かない行: 1 の道筋ではファイルの中の行に届かないことがある（ほかのファイルで決めた変数で分かれる @if の先など。
 *    2 はファイルの中の選択肢の選び方しか変えないため）。entryReaching で、その行を通る道筋を同じ後戻りの探索で探し、
 *    その道筋でファイルに入った時点から 2 をやり直す（sweep の entry）。
 */

export interface SweepSource {
  loadSource(file: string): Promise<string>;
  /** 実行器の設定（話者・作品固有の命令）。 */
  runtime: Omit<RuntimeOptions, "onAssign">;
  /** 「はじめから」の開始位置（ファイル または ファイル#ラベル）。 */
  entry: string;
  /** 流している間にときどき呼ぶ（Promise を返せば待つ）。ほかの要求（保存など）へ手を離すため。 */
  pause?(): void | Promise<void>;
}

/** 届かない行の探索を途中でやめる合図（aborted になったら、次に止まれるところで「やめた」として返す）。 */
export interface SweepSignal {
  readonly aborted: boolean;
}

/** ファイルの中を流す回数の上限（選択肢の数がこれより多くても、ここで止める）。 */
const MAX_RUNS = 8;
/** 道筋の探索にかける時間の上限（ミリ秒）。見つからなければファイルの頭から空の状態で流す。 */
const ROUTE_BUDGET_MS = 2000;
/** 届かない行へ届く道筋の探索にかける時間の上限（ミリ秒）。 */
const LINE_ROUTE_BUDGET_MS = 15_000;

/** 届かない行へ届く道筋の探索の手がかり（entryReaching）。 */
export interface RouteGuide {
  /** 分岐の地図（選択肢の行き先の場面と、場面どうしのつながり）。 */
  map: StoryMap;
  /** その行へ入る条件の変数を、条件に合う値に決める行の候補（どれか一つを先に通れば入れる見込み）。 */
  waypoints: { file: string; line: number }[];
}
/** 一回の流しの命令数の上限。 */
const MAX_STEPS = 500_000;

export class Sweeper {
  /** ファイル → そのファイルに着いた時点（探して見つからなければ null）。 */
  private readonly entries = new Map<string, Reached | null>();
  /** 道筋を探し尽くした（時間切れでなく探索が終わった）。控えに無いファイルには着かない。 */
  private exhausted = false;
  /** ファイル:行 → その行を通る道筋でファイルに入った時点と、その行に着いた時点（entryReaching）。 */
  private readonly lineEntries = new Map<string, { entry: Reached; at?: Reached } | { entry: null; reason: "unreachable" | "timeout" }>();

  constructor(private readonly source: SweepSource) {}

  /** 覚えた道筋を捨てる（どれかの .lim が変わったとき）。 */
  reset(): void {
    this.entries.clear();
    this.lineEntries.clear();
    this.exhausted = false;
  }

  /**
   * そのファイルに入るまでの道筋と、着いた時点の様子。見つからなければ null。
   * 探す途中で通ったほかのファイルも、最初に着いた時点を控える。後戻りの探索の順は探す先によらないので、
   * 控えたものは、そのファイルを探したときに見つかるものと同じになる（時間切れで打ち切った場合を除く）。
   */
  async entryOf(file: string): Promise<Reached | null> {
    if (this.entries.has(file)) return this.entries.get(file)!;
    if (this.exhausted) return null;
    const deadline = Date.now() + ROUTE_BUDGET_MS;
    let timedOut = false;
    await findRoute({
      ...this.base(),
      start: this.source.entry,
      // ファイルに入った時点（そのファイルの最初の命令を実行する直前）を控える。ファイルの頭の命令の行も流せるように。
      // @define の中は除く（ほかのファイルから部品として呼ばれただけで、そのファイルに入ったのではない）
      step: (at, w) => {
        if (!this.entries.has(at.file) && !w.runtime.state.position.unit.includes("::")) this.entries.set(at.file, capture(w, at));
      },
      reached: () => {
        if (this.entries.has(file)) return true;
        if (Date.now() > deadline) timedOut = true;
        return timedOut;
      },
    });
    if (!this.entries.has(file)) {
      this.entries.set(file, null);
      if (!timedOut) this.exhausted = true;
    }
    return this.entries.get(file)!;
  }

  /**
   * そのファイルのその行を通る道筋で、最後にそのファイルに入った時点（その行に着く前の、ファイルに入った直後）。
   * 見つからなければ reason（unreachable: 探し尽くしても通らない、timeout: 時間内に見つからなかった）。
   *
   * 後戻りの探索だけでは、大きな作品（調べ物の画面のように何度も戻ってくる選択肢がある作品）では時間内に届かないので、
   * guide があれば次のように探す:
   * - 選択肢では、地図の上で今の目標に近い場面へ移るものから試す
   * - waypoints（その行へ入る条件の変数を決める行の候補）があれば、候補ごとに「その行を先に通り、それから目標の行へ」の順に探す
   * どれも見つからなければ、地図の試す順だけで探す。
   * 見つかれば at に、その行に着いた時点（そこまでに選んだ選択肢と変数。lim reach が出す）も添える。budgetMs は探す時間の上限（既定 15 秒）。
   */
  async entryReaching(file: string, line: number, guide?: RouteGuide, signal?: SweepSignal, budgetMs = LINE_ROUTE_BUDGET_MS): Promise<{ entry: Reached; at?: Reached } | { entry: null; reason: "unreachable" | "timeout" | "cancelled" }> {
    const key = `${file}:${line}`;
    const known = this.lineEntries.get(key);
    if (known) return known;
    const deadline = Date.now() + budgetMs;
    const plans: { file: string; line: number }[][] = [...(guide?.waypoints ?? []).map((w) => [w]), []];
    let timedOut = false;
    let exhausted = true;
    for (const waypoints of plans) {
      const r = await this.searchLine(file, line, waypoints, guide?.map ?? null, deadline, signal);
      // やめた（ほかの行を探し始めた・ファイルが変わった・頼みが切れた）。覚えない
      if (signal?.aborted && !r.entry) return { entry: null, reason: "cancelled" };
      if (r.entry) {
        const result = { entry: r.entry, ...(r.at ? { at: r.at } : {}) };
        this.lineEntries.set(key, result);
        return result;
      }
      if (r.timedOut) {
        timedOut = true;
        exhausted = false;
        break;
      }
      // 中継点を通る道が無いだけかもしれないので、ほかの候補も試す（中継点なしで探し尽くしたときだけ「届かない」）
      if (waypoints.length > 0) exhausted = false;
      else exhausted = true;
    }
    const result = { entry: null, reason: timedOut || !exhausted ? ("timeout" as const) : ("unreachable" as const) };
    // 時間切れは覚えない（次に頼まれたらもう一度探す）
    if (result.reason === "unreachable") this.lineEntries.set(key, result);
    return result;
  }

  /** waypoints を順に通ってから、そのファイルのその行に届く道筋を探す（entryReaching の一回分）。 */
  private async searchLine(file: string, line: number, waypoints: { file: string; line: number }[], map: StoryMap | null, deadline: number, signal?: SweepSignal): Promise<{ entry: Reached | null; at: Reached | null; timedOut: boolean }> {
    const goals = [...waypoints, { file, line }];
    const distances = map ? goals.map((g) => distancesTo(map, nodeAt(map, g.file, g.line)?.id ?? null)) : null;
    let current: Walk | null = null;
    let goal = 0;
    let entry: Reached | null = null;
    let inside = false;
    /** この回は中継点をすべて通ったあとでそのファイルに入り、その行を通らずに出た（この回はもう届かないので打ち切る）。 */
    let passed = false;
    let hit: Reached | null = null;
    let hitAt: Reached | null = null;
    let timedOut = false;
    await findRoute({
      ...this.base(),
      start: this.source.entry,
      attempts: 5000,
      step: (at, w) => {
        if (w !== current) {
          current = w;
          goal = 0;
          entry = null;
          inside = false;
          passed = false;
        }
        if (hit) return;
        if (goal < waypoints.length && at.file === waypoints[goal]!.file && at.line === waypoints[goal]!.line) goal++;
        // @define の中は除く（ほかのファイルから部品として呼ばれただけで、そのファイルに入ったのではない）
        const here = at.file === file && !w.runtime.state.position.unit.includes("::");
        if (here && !inside) entry = capture(w, at);
        // 出た（@call・@define の呼び出しから戻ってくる途中を除く）
        if (inside && !here && goal === waypoints.length && !w.runtime.state.callStack.some((f) => unitFile(f.return.unit) === file)) passed = true;
        inside = here;
        if (here && at.line === line && goal === waypoints.length) {
          hit = entry;
          hitAt = capture(w, at);
        }
      },
      // 選択肢は、地図の上で今の目標に近い場面へ移るものから試す
      ...(map && distances
        ? {
            order: (at: { file: string; line: number }, options: string[], _w: Walk, targets?: (string | null)[]) => {
              const from = nodeAt(map, at.file, at.line)?.id;
              const dist = distances[Math.min(goal, distances.length - 1)]!;
              const edges = map.edges.filter((e) => e.from === from && e.kind === "choice");
              // 飛び先が分かればその場面、分からなければ地図の選択肢の矢印を文で引く
              return options
                .map((text, i) => {
                  const to = targets?.[i] ?? edges.find((x) => x.label === text)?.to;
                  return { i, d: to ? (dist.get(to) ?? Infinity) : Infinity };
                })
                .sort((a, b) => a.d - b.d || a.i - b.i)
                .map((x) => x.i);
            },
          }
        : {}),
      // 中継点を通ったあとで一度入ったファイルを、その行を通らずに出た回は、そこで打ち切って次の選び方へ（ゲームの終わりまで流さない）
      giveUp: () => passed || !!signal?.aborted,
      reached: () => {
        if (hit) return true;
        if (Date.now() > deadline || signal?.aborted) timedOut = true;
        return timedOut;
      },
    });
    return { entry: hit, at: hitAt, timedOut: !hit && timedOut };
  }

  /** ファイルの各行の状態（hash は呼ぶ側が足す）。entry を渡せば、その時点からファイルの中を流す（届かない行へ届く道筋）。 */
  async sweep(file: string, from?: Reached): Promise<Omit<Sweep, "hash">> {
    const entry = from ?? (await this.entryOf(file));
    const base: Sweep["base"] = entry ? { game: entry.save.game, assigned: entry.assigned, stage: entry.save.stage } : { game: {}, assigned: {} };
    const lines: Record<number, LineState> = {};
    const after: Record<number, AfterState> = {};
    const stages: StageState[] = [];
    const stageIndex = new Map<string, number>();
    const runs: RouteStep[][] = [];
    let options = 1;
    let run = 0;
    const visit = (at: { file: string; line: number }, w: Walk): boolean => {
      // ほかのファイルに出たら打ち切る（@call・@define の呼び出しから戻ってくる途中は続ける）
      if (at.file !== file) return !w.runtime.state.callStack.some((f) => unitFile(f.return.unit) === file);
      if (!(at.line in lines)) lines[at.line] = lineState(capture(w, at), base, run);
      return false;
    };
    /** 実行し終えるのを待っている、このファイルの行（呼び出しの浅い順）。 */
    let pending: { line: number; depth: number }[] = [];
    const settle = (w: Walk, depth: number, keep: { line: number; depth: number } | null) => {
      while (pending.length > 0 && pending.at(-1)!.depth >= depth) {
        const p = pending.at(-1)!;
        if (keep && p.line === keep.line && p.depth === keep.depth) break;
        pending.pop();
        // 本文と選択肢の行は、ページ（選択肢）を出したときの状態を持つ
        if (p.line in lines || p.line in after) continue;
        after[p.line] = afterState(capture(w, { file, line: p.line }), base, run, (stage) => {
          const key = JSON.stringify(stage);
          let i = stageIndex.get(key);
          if (i === undefined) {
            i = stages.push(stage) - 1;
            stageIndex.set(key, i);
          }
          return i;
        });
      }
    };
    const step = (at: { file: string; line: number }, w: Walk) => {
      const depth = w.runtime.state.callStack.length;
      const here = at.file === file ? { line: at.line, depth } : null;
      // 同じ行の続きの命令（一行が複数の命令になるもの）は、その行の終わりまで待つ
      settle(w, depth, here);
      if (here && !(here.line in lines) && !(here.line in after) && pending.at(-1)?.line !== here.line) pending.push(here);
    };
    for (let k = 0; k < Math.min(MAX_RUNS, options); k++) {
      run = k;
      pending = [];
      const done = await walk({
        ...this.base(),
        start: entry ? { save: entry.save, temp: entry.temp, system: entry.system, assigned: entry.assigned } : file,
        offset: k,
        page: visit,
        choice: (at, texts, w) => {
          if (at.file === file) options = Math.max(options, texts.length);
          return visit(at, w);
        },
        step,
      });
      // 終わり（ファイルの終わり・打ち切り）まで来た行も、その時点の状態で控える
      settle(done.walk, 0, null);
      // 選んだ選択肢は足していくだけなので、行の状態はこの回の終わりの並びの先頭を指せばよい
      runs.push(done.walk.choices.map(routeStep));
    }
    return { file, route: entry ? entry.choices.map(routeStep) : [], how: entry ? "entry" : "file-start", base, runs, lines, after, stages };
  }

  private base() {
    return { loadSource: this.source.loadSource, runtime: { onError: "continue" as const, maxSteps: MAX_STEPS, ...this.source.runtime }, ...(this.source.pause ? { pause: this.source.pause } : {}) };
  }
}

function lineState(r: Reached, base: Sweep["base"], run: number): LineState {
  const game: Record<string, Value> = {};
  for (const [name, value] of Object.entries(r.save.game)) if (!sameValue(base.game[name], value)) game[name] = value;
  const unset = Object.keys(base.game).filter((name) => !(name in r.save.game));
  const assigned: Record<string, Origin> = {};
  for (const [path, o] of Object.entries(r.assigned)) {
    const b = base.assigned[path];
    if (!b || b.file !== o.file || b.line !== o.line) assigned[path] = o;
  }
  return { save: { ...r.save, game }, ...(unset.length > 0 ? { unset } : {}), temp: r.temp, assigned, choices: { run, count: r.choices.length } };
}

function afterState(r: Reached, base: Sweep["base"], run: number, stageIndex: (stage: StageState) => number): AfterState {
  const { save, unset, temp, assigned, choices } = lineState(r, base, run);
  return { stage: stageIndex(save.stage), game: save.game, ...(unset ? { unset } : {}), temp, assigned, choices };
}

function sameValue(a: Value | undefined, b: Value): boolean {
  if (a === b) return true;
  if (a === undefined || typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 現在地を行の範囲（両端を含む）に絞る（GET /sweep の from・to）。stages は範囲の after が指すものだけにして、番号を付け直す。 */
export function sweepRange(sweep: Sweep, range: { from: number; to: number }): Sweep {
  const inRange = (line: string) => Number(line) >= range.from && Number(line) <= range.to;
  const lines: Record<number, LineState> = {};
  for (const [line, state] of Object.entries(sweep.lines)) if (inRange(line)) lines[Number(line)] = state;
  const after: Record<number, AfterState> = {};
  const stages: StageState[] = [];
  const renumber = new Map<number, number>();
  for (const [line, state] of Object.entries(sweep.after)) {
    if (!inRange(line)) continue;
    let i = renumber.get(state.stage);
    if (i === undefined) {
      i = stages.push(sweep.stages[state.stage]!) - 1;
      renumber.set(state.stage, i);
    }
    after[Number(line)] = { ...state, stage: i };
  }
  return { ...sweep, lines, after, stages };
}

/** 現在地から持続の帯の材料（行ごとの舞台の持続するもの）を抜き出す。同じ様子は一つにまとめる。cast は立ち位置を描画と同じに読むのに使う。 */
export function stageTrack(sweep: Sweep, layout?: AutoLayoutContext, cast?: Readonly<Cast>): StageTrack {
  const states: StageMarks[] = [];
  const index = new Map<string, number>();
  const lines: Record<number, number> = {};
  for (const [line, state] of Object.entries(sweep.lines)) {
    const marks = stageMarks(state.save.stage, layout, cast);
    const key = JSON.stringify(marks);
    let i = index.get(key);
    if (i === undefined) {
      i = states.push(marks) - 1;
      index.set(key, i);
    }
    lines[Number(line)] = i;
  }
  return { file: sweep.file, hash: sweep.hash, how: sweep.how, states, lines };
}

/** 舞台の持続するもの。自動配置の人物の立ち位置は、作品の規則（layout）で決めた位置にする（描画と同じ見方。stage-positions.ts）。 */
export function stageMarks(stage: StageState, layout?: AutoLayoutContext, cast?: Readonly<Cast>): StageMarks {
  const loopingSe: StageMarks["loopingSe"] = {};
  for (const [ch, se] of Object.entries(stage.loopingSe)) loopingSe[ch] = { file: se.file, volume: se.volume };
  const sprites: StageMarks["sprites"] = {};
  const at = stagePositions(stage.sprites, layout, cast);
  for (const [who, sp] of Object.entries(stage.sprites)) sprites[who] = { variant: sp.variant, appearance: sp.appearance, at: at.get(who)!, flip: sp.flip };
  return {
    background: stage.background,
    bgm: stage.bgm ? { file: stage.bgm.file, volume: stage.bgm.volume, loop: stage.bgm.loop } : null,
    loopingSe,
    sprites,
  };
}

function routeStep(c: ChoiceMade): RouteStep {
  return { file: c.file, line: c.line, option: c.picked, text: c.text };
}

function unitFile(unit: string): string {
  const i = unit.indexOf("::");
  return i < 0 ? unit : unit.slice(0, i);
}

/** その行を含む場面（ラベルから次のラベルまで。ファイルの頭の場面も）。 */
function nodeAt(map: StoryMap, file: string, line: number) {
  let best: StoryMap["nodes"][number] | null = null;
  for (const n of map.nodes) if (n.file === file && n.line <= line && (!best || n.line > best.line)) best = n;
  return best ?? map.nodes.find((n) => n.file === file) ?? null;
}

/** 地図の上で、各場面から goal までの移り方の数（矢印を逆にたどる。条件は見ない）。 */
function distancesTo(map: StoryMap, goal: string | null): Map<string, number> {
  const dist = new Map<string, number>();
  if (goal === null) return dist;
  const into = new Map<string, string[]>();
  for (const e of map.edges) if (!e.missing) (into.get(e.to) ?? into.set(e.to, []).get(e.to)!).push(e.from);
  dist.set(goal, 0);
  const queue = [goal];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    for (const from of into.get(id) ?? []) {
      if (dist.has(from)) continue;
      dist.set(from, dist.get(id)! + 1);
      queue.push(from);
    }
  }
  return dist;
}

/** `a && b && c` を a、b、c に分ける（`&&` でなければそのまま一つ）。 */
function conjuncts(e: Expr): Expr[] {
  return e.kind === "binary" && e.op === "&&" ? [...conjuncts(e.left), ...conjuncts(e.right)] : [e];
}

/**
 * 届かない行へ届く道筋の探索の手がかり（Sweeper.entryReaching）。分岐の地図と、その行へ入る条件（その行を囲む @if と、
 * その行の場面へ移る矢印の条件）に出てくる game・system の変数を、条件に合う値に決める @set の行の候補。
 */
export function routeGuide(map: StoryMap, scripts: ReadonlyMap<string, Script>, file: string, line: number): RouteGuide {
  const node = [...map.nodes].filter((n) => n.file === file && n.line <= line).sort((a, b) => b.line - a.line)[0];
  const conds: Expr[] = [];
  for (const e of map.edges) {
    if (e.to !== node?.id || !e.cond || e.cond === "else") continue;
    try {
      conds.push(parseExpr(e.cond));
    } catch {
      // 読めない条件は手がかりにしない
    }
  }
  // その行を囲む @if・@elif の条件
  const enclosing = (body: Statement[]): boolean => {
    for (const st of body) {
      if (st.kind !== "if") continue;
      for (const b of st.branches) {
        const lines = b.body.map((x) => x.line);
        if (lines.length === 0 || line < Math.min(...lines) || line > Math.max(...lines)) continue;
        if (b.condition) conds.push(b.condition);
        enclosing(b.body);
        return true;
      }
    }
    return false;
  };
  const own = scripts.get(file);
  if (own) enclosing(own.body);
  const wanted = new Set(conds.flatMap((c) => variablePaths(c)).filter((p) => p.startsWith("game.") || p.startsWith("system.")));
  const waypoints: { file: string; line: number }[] = [];
  if (wanted.size === 0) return { map, waypoints };
  // 条件を `&&` で分けた一つずつを、その変数だけをその値にして確かめる。ほかの game・system の変数も要る一つは、
  // その変数だけでは決まらないので確かめない（`a && b` を a だけ入れて確かめると、b が無くて必ず偽になる）
  const parts = conds.flatMap(conjuncts);
  const fits = (path: string, value: Value) =>
    parts.every((c) => {
      const paths = variablePaths(c);
      if (!paths.includes(path) || paths.some((p) => p !== path && (p.startsWith("game.") || p.startsWith("system.")))) return true;
      const [scope, name] = path.split(".") as [string, string];
      try {
        return Boolean(evaluate(c, { lookup: (n) => (n === scope ? { [name]: value } : n === "game" || n === "system" || n === "temp" ? {} : null), random: () => 0 }));
      } catch {
        return true;
      }
    });
  const visit = (f: string, body: Statement[]) => {
    for (const st of body) {
      if (st.kind === "set" && st.op === "=") {
        const path = variablePaths(st.target)[0];
        if (path && wanted.has(path) && (st.value.kind !== "literal" || fits(path, st.value.value as Value))) waypoints.push({ file: f, line: st.line });
      } else if (st.kind === "if") for (const b of st.branches) visit(f, b.body);
      else if (st.kind === "define") visit(f, st.body);
    }
  };
  for (const [f, script] of scripts) visit(f, script.body);
  return { map, waypoints };
}
