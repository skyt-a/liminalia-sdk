import { walk, type CommandImpl, type PresentEvent, type Runtime, type RuntimeOptions, type SaveData, type Scope, type Value } from "@liminalia/runtime";
import type { ChoicePoint } from "./storage.ts";

/** 「前の選択肢へ」で戻れる選択肢の数（新しいものから）。 */
export const CHOICE_KEEP = 50;
/** 「次の選択肢へ」で先を確かめる上限（ページ数と命令の数）。これより先にしか無ければ「無い」とする。 */
const NEXT_CHOICE_PAGES = 5000;
const NEXT_CHOICE_STEPS = 2_000_000;

/**
 * 「前の選択肢へ」のための、このプレイで出た選択肢の控え（出した時点のセーブと、そのときの履歴の件数）。
 * システム画面（標準のものも作品のものも）は、選択肢を出したとき（setChoosing(true)）に remember を呼び、
 * 戻るときは previous で戻り先を受け取って、そのセーブから新しいプレイを始める（履歴は log 件目より前を残す）。
 */
export class ChoiceHistory {
  private list: ChoicePoint[] = [];

  constructor(private readonly keep = CHOICE_KEEP) {}

  get points(): readonly ChoicePoint[] {
    return this.list;
  }

  /** 選択肢を出した時点を控える。logLength はそのときの履歴の件数。同じ選択肢を出し直したとき（ロード直後など）は控えない。 */
  remember(runtime: Runtime, logLength: number): void {
    const pos = runtime.state.position;
    const at = `${pos.unit}:${pos.index}`;
    const last = this.list.at(-1);
    if (last && last.at === at && last.log === logLength) return;
    this.list.push({ save: runtime.save(), log: logLength, at });
    if (this.list.length > this.keep) this.list.splice(0, this.list.length - this.keep);
  }

  /**
   * 戻り先（選んでいる最中なら、その一つ前の選択肢）と、戻ったあとの控え（戻り先より前のもの）。戻れる選択肢が無ければ null。
   * 戻ると決めたら、新しいプレイを作ってから replace(before) で控えを戻す。
   */
  previous(choosing: boolean): { point: ChoicePoint; before: ChoicePoint[] } | null {
    const i = this.list.length - (choosing ? 2 : 1);
    const point = this.list[i];
    return point ? { point, before: this.list.slice(0, i) } : null;
  }

  /** 控えを入れ替える（戻ったあと・ロードしたとき）。形の崩れたものは捨てる。 */
  replace(points: readonly unknown[]): void {
    this.list = points.filter(isChoicePoint).slice(-this.keep);
  }

  clear(): void {
    this.list = [];
  }

  /**
   * セーブに入れる分（新しい count 個）。dropped は、セーブに入れない古い履歴の件数（履歴の件数をセーブに入れた分から数え直す。
   * 履歴をセーブに入れない作品は、今の履歴の件数を渡す）。
   */
  forSave(dropped: number, count = 10): ChoicePoint[] {
    return this.list.slice(-count).map((p) => ({ ...p, log: Math.max(0, p.log - dropped) }));
  }
}

export function isChoicePoint(p: unknown): p is ChoicePoint {
  const o = p as ChoicePoint | null;
  return !!o && typeof o === "object" && !!o.save && typeof o.save === "object" && typeof o.log === "number" && typeof o.at === "string";
}

/** 「次の選択肢へ」の前に、今の位置から画面なしで流して、この先に選択肢があるかを確かめるのに要るもの。 */
export interface ChoiceAheadOptions {
  /** 遊んでいる実行器。先へ流す実行器は、これを作ったときの設定（runtime.options）と今の言語と訳で作る（AHEAD_RUNTIME_OPTIONS）。 */
  runtime: Runtime;
  loadSource(file: string): Promise<string>;
  /** 話者と作品固有の命令。省けば runtime を作ったときのもの。 */
  speakers?: readonly string[];
  commands?: readonly CommandImpl[];
  /** 変数の初期値。省けば runtime を作ったときのもの。 */
  variables?: Record<string, Value>;
  /**
   * 作品のデータを読む（命令の ctx.data）。画面なしで流すときにも、データを読む命令（調べる画面など）が途中で止まらないように渡す。
   * 渡さず、runtime を作ったときにも無ければ ctx.data が undefined になり、データの無い命令で流れが終わって、先の選択肢を見つけられない。
   */
  loadData?(name: string): unknown;
}

/**
 * 遊んでいる実行器の設定（RuntimeOptions）の一つ一つを、先へ流す実行器にどう渡すか。
 * - copy: 作ったときの値をそのまま写す（台本の流れと状態を、読み進めたときと同じにする）
 * - play: 写さない（遊んでいる実行器だけのもの）
 * - ahead: 先へ流す側が決める（今の言語と訳、上限など）
 * 実行器の設定を足したら、ここで分けるまで型の確かめが通らない。片方の実行器だけに渡して、飛んだ先の状態が読み進めたときと
 * 違う（自動配置が外れる、CG が解放されない、英語でも日本語の道を通る）ことを防ぐため。
 */
export const AHEAD_RUNTIME_OPTIONS: Readonly<Record<keyof RuntimeOptions, "copy" | "play" | "ahead">> = {
  speakers: "copy",
  commands: "copy",
  commandDefaults: "copy",
  seed: "copy",
  variables: "copy",
  chapters: "copy",
  achievementGoals: "copy",
  endingAchievements: "copy",
  endingKinds: "copy",
  cast: "copy",
  autoLayout: "copy",
  voiceLock: "copy",
  cg: "copy",
  chatDialogue: "copy",
  // 本文の流れに出す選択肢を @nvl の本文に残すか。残し方が違うと、飛んだ先の本文が読み進めたときと違う
  inlineChoices: "copy",
  stripQuotes: "copy",
  gameVersion: "copy",
  // 読んだ台本の控え。本文が同じときだけ使うので、先へ流す実行器も同じ控えを使ってよい
  programCache: "copy",
  // 作品の画面が開いている間と、制作画面のブレークポイントで止めるためのもの。先へ流すときは止めない
  beforeStep: "play",
  // 制作画面が値を決めた行を控えるためのもの（walk は自分のものを使う）
  onAssign: "play",
  onStep: "play",
  // ロードの直後に呼ぶ所。先へ流す実行器は今の位置のセーブを読んで始めるので、渡すと、遊んでいるときには起きない afterLoad が
  // 先流しの頭で動く（飛んだ先は、遊ぶ実行器がそのセーブを読むときに afterLoad を呼ぶ）
  afterLoad: "play",
  // 言語と訳は遊んでいる間に替わるので、作ったときの値ではなく今の値
  language: "ahead",
  translator: "ahead",
  platform: "ahead",
  // 画面なしで流す host は作品のデータを読めないので、渡されたものか作ったときのものを使う
  loadData: "ahead",
  onError: "ahead",
  maxSteps: "ahead",
  // 呼ばれていない @return の扱い（網羅のファイルごとの流しだけが continue にする）。読み進めたときと同じにする
  returnWithoutCall: "copy",
};

/** 先へ流す実行器の設定（AHEAD_RUNTIME_OPTIONS のとおりに、遊んでいる実行器から作る）。 */
export function aheadRuntimeOptions(o: ChoiceAheadOptions): Omit<RuntimeOptions, "onAssign" | "onStep"> {
  const live = o.runtime.options ?? {};
  const copied: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(live)) if (AHEAD_RUNTIME_OPTIONS[key as keyof RuntimeOptions] === "copy" && value !== undefined) copied[key] = value;
  const loadData = o.loadData ?? live.loadData;
  const chatDialogue = live.chatDialogue ?? o.runtime.chatDialogue;
  return {
    ...(copied as RuntimeOptions),
    ...(o.speakers ? { speakers: [...o.speakers] } : {}),
    ...(o.commands ? { commands: [...o.commands] } : {}),
    ...(o.variables ? { variables: o.variables } : {}),
    ...(chatDialogue ? { chatDialogue } : {}),
    ...(loadData ? { loadData } : {}),
    language: o.runtime.language,
    translator: o.runtime.translator,
    platform: o.runtime.platform,
    onError: "continue",
    maxSteps: NEXT_CHOICE_STEPS,
  };
}

/**
 * 先へ流す実行器が最初に出したページが、遊んでいる実行器が今出しているページか。遊んでいる実行器がページを出している最中（クリック待ちや
 * 本文の中の待ち）なら、そのセーブはページの頭から再開するので、先へ流す実行器はまず今のページを出し直す。ページの後の @wait などの
 * 間なら、最初に出すのは次のページ（まだ読んでいない）。
 */
function replaysCurrentPage(runtime: Runtime): (at: { file: string; line: number }) => boolean {
  const here = runtime.at;
  let first = true;
  return (at) => {
    const same = first && !!here && here.file === at.file && here.line === at.line;
    first = false;
    return same;
  };
}

/**
 * この先、次の選択肢までに未読のページがあるか。unread（未読のページがある）・choice（選択肢まで既読）・none（終わりまで既読）。
 * 今のページは数えない（もう読んでいる）。上限のページ数・命令の数までに決まらなければ none。
 */
export async function unreadAhead(o: ChoiceAheadOptions & { isRead(at: { file: string; line: number; key?: string }): boolean }): Promise<"unread" | "choice" | "none"> {
  let result: "unread" | "choice" | "none" = "none";
  let pages = 0;
  const current = replaysCurrentPage(o.runtime);
  await walk({
    loadSource: (f) => o.loadSource(f),
    runtime: aheadRuntimeOptions(o),
    start: { save: o.runtime.save(), temp: o.runtime.state.temp, system: o.runtime.system },
    choice: () => {
      result = "choice";
      return true;
    },
    page: (at) => {
      pages++;
      if (!current(at) && !o.isRead(at)) {
        result = "unread";
        return true;
      }
      return pages > NEXT_CHOICE_PAGES;
    },
  }).catch(() => undefined);
  return result;
}

/**
 * この先に選択肢があるか（今の位置から画面なしで流して確かめる。上限のページ数・命令の数までに出なければ false）。
 * あれば、システム画面は未読も飛ばすスキップで選択肢まで進め、選択肢を出したら（setChoosing(true)）スキップをやめる。
 */
export async function hasChoiceAhead(o: ChoiceAheadOptions): Promise<boolean> {
  let found = false;
  let pages = 0;
  await walk({
    loadSource: (f) => o.loadSource(f),
    runtime: aheadRuntimeOptions(o),
    start: { save: o.runtime.save(), temp: o.runtime.state.temp, system: o.runtime.system },
    choice: () => (found = true),
    page: () => ++pages > NEXT_CHOICE_PAGES,
  }).catch(() => undefined);
  return found;
}

/** 「次の選択肢へ」で飛ぶ先（次の選択肢を出す直前の時点か、その手前の未読のページの頭）。 */
export interface ChoiceJump {
  /** choice は選択肢、unread は選択肢の手前の未読のページ（isRead を渡したときだけ）。 */
  kind: "choice" | "unread";
  /** その選択肢から再開するセーブ。 */
  save: SaveData;
  /** その時点の一時変数と、全セーブ共通の変数（途中で変わったものも入る）。 */
  temp: Scope;
  system: Scope;
}

/**
 * 今の位置から画面なしで流して、次の選択肢の時点を返す（上限のページ数・命令の数までに出なければ null）。
 * isRead を渡すと、選択肢より手前の未読のページで止め、そのページの頭を返す（今のページは数えない）。
 * 途中で描画側へ送るものは present に渡す（バックログ、CG の解放など、飛ばしても起きることを起こすため）。止めた未読のページの
 * page の出来事も present に来るので、使う側で除く。今出しているページを頭から出し直す分（page、text、br）は、もう読んでいて
 * 履歴にも入っているので渡さない（命令は渡す）。save はそのとき（ページなら、そのページから再開する）のセーブを作る。
 * runtime は先へ流している実行器（その時点の舞台を読むため。流し終えたあとに読むと最後の状態になる）。
 */
export async function findChoiceAhead(o: ChoiceAheadOptions & { present?(event: PresentEvent, save: () => SaveData, runtime: Runtime): void; isRead?(at: { file: string; line: number; key?: string }): boolean }): Promise<ChoiceJump | null> {
  let found: ChoiceJump | null = null;
  let pages = 0;
  const current = replaysCurrentPage(o.runtime);
  /** 今のページを出し直している間。 */
  let replaying = false;
  await walk({
    loadSource: (f) => o.loadSource(f),
    runtime: aheadRuntimeOptions(o),
    start: { save: o.runtime.save(), temp: o.runtime.state.temp, system: o.runtime.system },
    present: (event, w) => {
      if (event.type === "page") {
        pages++;
        replaying = current(event.at);
      }
      if (replaying && (event.type === "page" || event.type === "text" || event.type === "br")) return;
      o.present?.(event, () => w.runtime.save(), w.runtime);
    },
    choice: (_at, _options, w) => {
      found = { kind: "choice", save: w.runtime.save(), temp: structuredClone(w.runtime.state.temp), system: structuredClone(w.runtime.system) };
      return true;
    },
    page: (at, w) => {
      if (!replaying && o.isRead && !o.isRead(at)) {
        found = { kind: "unread", save: w.runtime.save(), temp: structuredClone(w.runtime.state.temp), system: structuredClone(w.runtime.system) };
        return true;
      }
      return pages > NEXT_CHOICE_PAGES;
    },
  }).catch(() => undefined);
  return found;
}
