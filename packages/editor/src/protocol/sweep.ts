import type { SaveData, StageState, Value } from "@liminalia/runtime";

// ---- GET /sweep?file=…[&from=N][&to=M] （現在地） ----
// from・to（行。どちらも含む）を付けると、lines・after をその範囲だけに絞る（大きなファイルでは全体が数 MB になるため）。
// 絞ったときの stages は、範囲の after が指すものだけ（番号は付け直す）。
// 応答は、要求が受け付けるなら gzip で返す。

/**
 * ファイルの各行の「本番どおりの状態」。サーバーは「道筋」（はじめから、そのファイルに入るまでの選択）を探し、
 * その状態からファイルの中を流して、通った行ごとに状態を控える。分岐の両側を通るよう選び方を変えて何度か流す。
 * 本文と選択肢の行はそのページから再開するセーブ（lines）、命令の行はその行を実行した直後の状態（after）を持つ。
 * 画面はカーソルの行（か、それより前の状態を持つ一番近い行）をここから引くだけで、舞台と事実を描く（持続の帯は GET /sweep/stage で全体を引く）。
 */
export interface Sweep {
  file: string;
  /** 作った時点の、このファイルの hash（古くなったら作り直す）。 */
  hash: string;
  /** ファイルに入るまで（そのファイルの最初の命令を実行するまで）の道筋。entry のファイルなら空。 */
  route: RouteStep[];
  /**
   * 道筋がどう決まったか。
   * "entry": はじめからこのファイルに入れた。"file-start": 入る道が見つからず、ファイルの頭から空の状態で流した。
   */
  how: "entry" | "file-start";
  /**
   * ふつうの道筋（はじめから最初にこのファイルに入る道筋）では届かない行を選んだので、その行を通る道筋で作ったもの（その行）。
   * route はその道筋。
   */
  target?: number;
  /**
   * 行の状態に共通のもの（ファイルに入った時点＝最初の命令を実行する前の変数と、その値を決めた行）。大きな作品では変数が数百あり、
   * 毎行に全部を持つと数十 MB になるので、行の状態はここから変わったものだけを持つ。lineSave・lineAssigned で元に戻す。
   */
  base: {
    game: Record<string, Value>;
    assigned: Record<string, Origin>;
    /** ファイルに入った時点の舞台の様子（「ここから遊ぶ」でファイルの頭から始めるときに使う）。空の状態から流したときは無い。 */
    stage?: StageState;
  };
  /**
   * 流した回ごとの、ファイルの中で選んだ選択肢（その回の終わりまで）。行の状態はこの先頭の何個かを指す
   * （選択肢の多いファイルでは、毎行に全部を持つと大きくなるため）。lineChoices で引く。
   */
  runs: RouteStep[][];
  /** 行 → その行の状態。本文の行と選択肢の行だけが持つ。通らなかった行は無い。 */
  lines: Record<number, LineState>;
  /**
   * 行 → その命令の行を実行した直後の状態。本文と選択肢のほかの行（演出の命令・@set・@if・ラベルなど）で、通ったものだけが持つ
   * （@call・@define の呼び出しは、呼んだ先から戻ってきた時点）。行が同じなら最初に通ったとき。
   * 舞台の様子は stages の番号で指す（命令の行は多く、毎行に StageState を持つと重いので、同じ様子は一つにまとめる）。
   */
  after: Record<number, AfterState>;
  /** after が指す舞台の様子（同じものは一つ）。 */
  stages: StageState[];
}

/** GET /sweep/reach の答え。sweep が null なら、その行へ届く道筋が無い（unreachable）か、時間内に見つからなかった（timeout）。 */
/** その行に届く現在地。cancelled は、探している間にほかの行を探し始めた・ファイルが変わった・頼みが切れたのでやめたもの。 */
export type SweepReach = { sweep: Sweep } | { sweep: null; reason: "unreachable" | "timeout" | "cancelled" };

export interface RouteStep {
  file: string;
  line: number;
  /** 選んだ選択肢（0 始まり）と、その文。 */
  option: number;
  text: string;
}

/** 変数の値を決めた行。 */
export interface Origin {
  file: string;
  line: number;
}

export interface LineState {
  /**
   * その行を表示する直前から再開するセーブ（プレイヤーに渡すと、その行のページが本番どおりに出る）。
   * ただし game は Sweep.base.game から値の変わった変数だけ。プレイヤーに渡すときは lineSave で全体にする。
   * 舞台の様子は save.stage、ゲーム変数は lineSave(…).game を見る。
   */
  save: SaveData;
  /** Sweep.base.game にあって、この行では無くなった変数（@clear-vars など）。 */
  unset?: string[];
  temp: Record<string, Value>;
  /** 変数のパス（"game.trust"）→ その値を最後に決めた行。Sweep.base.assigned と違うものだけ（lineAssigned で全体にする）。 */
  assigned: Record<string, Origin>;
  /** この行に来るまでに、このファイルの中で選んだ選択肢（道筋の続き）は、Sweep.runs[run] の先頭 count 個。 */
  choices: { run: number; count: number };
}

/**
 * 命令の行を実行した直後の状態。変数とその出どころ・選んだ選択肢は LineState と同じく Sweep.base・Sweep.runs からの差分で持つ
 * （afterGame・lineAssigned・lineChoices で全体にする）。ページではないので、再開するセーブは持たない（舞台は stage-still で組み立てる）。
 */
export interface AfterState {
  /** Sweep.stages の番号。 */
  stage: number;
  /** Sweep.base.game から値の変わった変数。 */
  game: Record<string, Value>;
  unset?: string[];
  temp: Record<string, Value>;
  assigned: Record<string, Origin>;
  choices: { run: number; count: number };
}

/** 命令の行の直後のゲーム変数（全体）。 */
export function afterGame(sweep: Pick<Sweep, "base">, state: AfterState): Record<string, Value> {
  const game: Record<string, Value> = { ...sweep.base.game, ...state.game };
  for (const name of state.unset ?? []) delete game[name];
  return game;
}

/** 行の状態のセーブを、プレイヤーに渡せる全体に戻す。 */
export function lineSave(sweep: Pick<Sweep, "base">, state: LineState): SaveData {
  const game: Record<string, Value> = { ...sweep.base.game, ...state.save.game };
  for (const name of state.unset ?? []) delete game[name];
  return { ...state.save, game };
}

/** この行に来るまでに、このファイルの中で選んだ選択肢。 */
export function lineChoices(sweep: Pick<Sweep, "runs">, state: Pick<LineState, "choices">): RouteStep[] {
  return (sweep.runs[state.choices.run] ?? []).slice(0, state.choices.count);
}

/** 行の状態の「変数の値を決めた行」を全体に戻す。 */
export function lineAssigned(sweep: Pick<Sweep, "base">, state: Pick<LineState, "assigned">): Record<string, Origin> {
  return { ...sweep.base.assigned, ...state.assigned };
}

// ---- GET /sweep/stage?file= （持続の帯） ----
// 現在地と同じ流し方で、行ごとの舞台の持続するもの（背景・BGM・ループの効果音・立ち絵）だけを、ファイル全体について返す。
// 同じ様子は一つにまとめる（states）。応答は、要求が受け付けるなら gzip で返す。

export interface StageTrack {
  file: string;
  /** 作った時点の、このファイルの hash。 */
  hash: string;
  how: Sweep["how"];
  /** 出てくる様子（同じものは一つ）。 */
  states: StageMarks[];
  /** 行 → states の番号。Sweep.lines と同じ行だけが持つ。 */
  lines: Record<number, number>;
}

/** 一行の、舞台の持続するもの。 */
export interface StageMarks {
  /** 背景の画像（bgimage からのパス）。 */
  background: string | null;
  bgm: { file: string; volume: number; loop: boolean } | null;
  /** チャンネル → ループで鳴っている効果音。 */
  loopingSe: Record<string, { file: string; volume: number }>;
  /** キャスト名 → 立ち絵（出ている順）。 */
  sprites: Record<string, { variant: string; appearance: string; at: string; flip: boolean }>;
}
