import type { Diagnostic } from "@liminalia/lang";
import type { ChoiceLook, Host, PresentEvent } from "./host.ts";
import type { Value } from "./value.ts";

export type TraceEntry =
  /** label は名前欄に出す名前（訳か表示名の上書き。話者と同じなら無い）。 */
  | { type: "page"; file: string; line: number; speaker: string | null; label?: string; text: string; voice?: string }
  | { type: "command"; name: string; args: Record<string, Value> }
  | { type: "choice"; options: string[]; selected: number | null }
  | { type: "diagnostic"; diagnostic: Diagnostic };

export interface HeadlessOptions {
  loadSource(file: string): Promise<string>;
  /** 作品のデータ（paths.data の .json）を読む（命令の ctx.data）。無ければ命令はデータを読めない。 */
  loadData?(name: string): Promise<unknown>;
  /**
   * 選択肢で選ぶものを順に。数は番号（0 始まり）、文字は選択肢の文（同じ文か、その文を含む選択肢）。使い切ったら policy に従う。
   * 文に当たる選択肢が無ければ診断（unknown-option）を残して policy に従う。
   */
  choices?: (number | string)[];
  /** 選ぶ番号を使い切ったとき。既定は "first"（最初の選択肢）。 */
  /**
   * 選ぶ番号を使い切ったとき。既定は "rotate"（同じ選択肢に戻ってくるたびに次の選択肢を選ぶ。
   * 外れを選ぶと選択肢に戻る作りでも、いずれ全部を試して先へ進める）。
   */
  whenChoicesRunOut?: "rotate" | "first" | "stop";
  /** このページ数に達したら止める。 */
  maxPages?: number;
}

/**
 * 画面なしで実行する Host。待ちはすべて即座に終わり、出来事を trace に記録する。
 * テスト・CLI の trace・AI による動作確認に使う。
 */
export class HeadlessHost implements Host {
  /**
   * 人が操作せずに流すので、命令の autoplay の答えで進める（Host.automated）。描画側の代わりに答えを返すテスト
   * （present を差し替えて、遊ぶ人の操作を真似る）は false にする。
   */
  automated = true;
  readonly trace: TraceEntry[] = [];
  private page: Extract<TraceEntry, { type: "page" }> | null = null;
  private pages = 0;
  private readonly choices: (number | string)[];
  private readonly seenChoices = new Map<string, number>();
  /** 選択肢（場所と文）ごとの、前に出たときのページの数と、ページを挟まずに続けて出た回数（選択肢だけの輪を見つける）。 */
  private readonly choiceLoops = new Map<string, { pages: number; repeats: number }>();
  onLimit: (() => void) | null = null;
  /** 今の場所（実行器の at）。選択肢の輪と、選ぶ選択肢が無いときの診断に、選択肢のある行を入れる（無ければ場所なし）。 */
  where: (() => { file: string; line: number } | null) | null = null;

  constructor(private readonly options: HeadlessOptions) {
    this.choices = [...(options.choices ?? [])];
  }

  loadSource(file: string): Promise<string> {
    return this.options.loadSource(file);
  }

  loadData(name: string): Promise<unknown> {
    return this.options.loadData ? this.options.loadData(name) : Promise.resolve(undefined);
  }

  async present(event: PresentEvent): Promise<Value | void> {
    switch (event.type) {
      case "page":
        this.page = { type: "page", file: event.at.file, line: event.at.line, speaker: event.speaker, ...(event.label ? { label: event.label } : {}), text: "", ...(event.voice ? { voice: `${event.voice.folder}/${event.voice.file}` } : {}) };
        this.trace.push(this.page);
        if (++this.pages >= (this.options.maxPages ?? Infinity)) this.onLimit?.();
        break;
      case "text":
        if (this.page) this.page.text += event.text;
        break;
      case "br":
        if (this.page) this.page.text += "\n";
        break;
      case "command":
        this.trace.push({ type: "command", name: event.name, args: event.args });
        break;
    }
  }

  async waitClick(): Promise<void> {}

  /** 診断の場所（where が無ければ場所なし）。 */
  private place(): { file: string; line: number } {
    const at = this.where?.() ?? null;
    return at ? { file: at.file, line: at.line } : { file: "", line: 0 };
  }

  async choose(texts: string[], _signal?: AbortSignal, looks?: (ChoiceLook | null)[]): Promise<number | null> {
    // 画像のボタン・押せる範囲で文のないものは、画像の名前で記録する。
    const options = texts.map((t, i) => t || looks?.[i]?.image || t);
    const key = options.join("\u0000");
    // 本文を出さずに同じ選択肢へ戻り続ける輪（どれを選んでも本文の無い選択肢へ戻る）。選び方を一巡しても抜けなければ止める
    // （止めないと実行器の手数の上限まで記録が膨らむ）
    // 同じ文でも台本の別の場所の選択肢は別に数える（「次へ」だけのメニューを続けて並べた作りを輪と見ない）
    const at = this.where?.();
    const loopKey = at ? `${at.file}:${at.line}\u0000${key}` : key;
    const loop = this.choiceLoops.get(loopKey);
    const repeats = loop && loop.pages === this.pages ? loop.repeats + 1 : 0;
    this.choiceLoops.set(loopKey, { pages: this.pages, repeats });
    if (repeats > Math.max(2, options.length * 2)) {
      this.trace.push({ type: "choice", options, selected: null });
      this.trace.push({
        type: "diagnostic",
        diagnostic: { severity: "warning", code: "choice-loop", message: `選択肢「${options.join(" / ")}」に、本文を挟まずに ${repeats} 回続けて戻ったため止めました（どれを選んでも本文の無い選択肢へ戻ります）`, ...this.place(), hint: "抜ける選択肢を足すか、--choose で選ぶものを決めます" },
      });
      this.onLimit?.();
      return null;
    }
    let next = this.choices.shift();
    if (typeof next === "string") {
      const text = next;
      const exact = options.indexOf(text);
      next = exact >= 0 ? exact : options.findIndex((o) => o.includes(text));
      if (next < 0) {
        this.trace.push({ type: "diagnostic", diagnostic: { severity: "warning", code: "unknown-option", message: `選ぶ選択肢「${text}」がありません（${options.join(" / ")}）`, ...this.place() } });
        next = undefined;
      }
    }
    const policy = this.options.whenChoicesRunOut ?? "rotate";
    let selected: number | null;
    if (next !== undefined) selected = next;
    else if (policy === "stop") selected = null;
    else if (policy === "first") selected = 0;
    else {
      const seen = this.seenChoices.get(key) ?? 0;
      this.seenChoices.set(key, seen + 1);
      selected = seen % options.length;
    }
    this.trace.push({ type: "choice", options, selected });
    return selected;
  }

  onDiagnostic(diagnostic: Diagnostic): void {
    this.trace.push({ type: "diagnostic", diagnostic });
  }
}
