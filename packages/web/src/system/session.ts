import type { Diagnostic } from "@liminalia/lang";
import type { ChoiceLook, Host, PresentEvent, Value, PrefetchItem } from "@liminalia/runtime";
import type { DomHost } from "../dom-host.ts";
import { plainText, voiceSpeakers, type Backlog } from "./backlog.ts";

/** Session から見たシステム側。 */
export interface SessionOwner {
  /** 新しいページを出す直前（スキップの判定・既読の記録・ページ数）。key はページの鍵（既読を覚えるのに使う）。 */
  beforePage(at: { file: string; line: number; key?: string }): void;
  /** ページを履歴に積んだあと（履歴から戻るためのセーブを付ける）。 */
  afterPage?(): void;
  /** クリック待ちに入るとき。オートで送るならその待ち時間（ミリ秒）、送らないなら null。 */
  autoDelay(chars: number): number | null;
  /** 選択肢を出している間 true。 */
  setChoosing(active: boolean): void;
  /** 選択肢でこれしか選べなくする（巻き戻しで戻ってから同じ選択肢に来たとき）。setChoosing(true) の後に聞く。 */
  fixedChoice?(): number | null;
  /** 選択肢で選んだ。 */
  chose?(index: number): void;
  /** @choice の選択肢を選んだ（時間切れで default を選んだときも）。text は選んだ文。履歴に残すのに使う。 */
  chosenText?(text: string): void;
  /** 選択肢ごとに、飛び先を読んだことがあるか（分からないものは false）。 */
  choiceRead?(targets: readonly (string | null)[]): Promise<boolean[]>;
  /** 話者のボイスを鳴らした（設定画面の話者ごとの音量に出すため）。 */
  heardVoice?(speaker: string): void;
  /** 描画側へ命令を送る直前（おまけの CG の解放など、命令を見て記録するため）。 */
  command?(name: string, args: Record<string, Value>): void;
  /** 描画側が命令を描き終えたあと（メッセージ枠の出し入れなど、様子の変化を知らせるため）。 */
  afterCommand?(name: string): void;
  /** クリック待ちに入った・抜けた。 */
  waitingChanged?(waiting: boolean): void;
  /** テキスト読み上げで本文を読んでいる最中か（オートは読み終わるのを待つ）。 */
  speaking?(): boolean;
  /** 選択肢の制限時間を使うか（コンフィグの「選択肢の制限時間」。false なら時間切れにせず、残り時間のバーも出さない）。 */
  choiceTimers?(): boolean;
  onDiagnostic(d: Diagnostic): void;
}

/**
 * 一回のプレイ（Runtime 一つ）と DomHost の間に挟む Host。
 * 描画は DomHost に任せたまま、履歴の記録・オート・スキップの判定・選択肢の状態だけをここで見る。
 * ロードやタイトルへ戻るときは close() し、古い Runtime がまだ流そうとする出来事は描画に届けない。
 */
/** オートで、ボイスが鳴り終わってから次へ送るまでの間（ミリ秒）。テキスト読み上げを読み終えてからも同じ。 */
const VOICE_AUTO_GAP = 600;
/** テキスト読み上げが終わったかを見る間隔（ミリ秒）。 */
const SPEECH_POLL = 200;

export class Session implements Host {
  private alive = true;
  private autoTimer: ReturnType<typeof setTimeout> | undefined;
  /** 今のページの話者。 */
  private speaker: string | null = null;

  constructor(
    private readonly host: DomHost,
    private readonly owner: SessionOwner,
    private readonly log: Backlog,
  ) {}

  close(): void {
    this.alive = false;
    clearTimeout(this.autoTimer);
  }

  /** 自動確認で動いているか（DomHost.automated。命令の autoplay で進める）。 */
  get automated(): boolean {
    return this.host.automated;
  }

  loadSource(file: string): Promise<string> {
    return this.host.loadSource(file);
  }

  loadData(name: string): Promise<unknown> {
    return this.host.loadData ? this.host.loadData(name) : Promise.resolve(undefined);
  }

  chosen(option: { text: string; index: number }): void {
    if (this.alive) this.owner.chosenText?.(option.text);
  }

  countdown(ms: number, signal: AbortSignal): Promise<void> {
    // 制限時間を使わない遊ぶ人には、時間切れにしない（選び終えるか、プレイを捨てたら終わる）
    if (this.owner.choiceTimers?.() === false) return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    return this.host.countdown(ms, signal);
  }

  prefetch(items: PrefetchItem[]): void {
    if (this.alive) this.host.prefetch(items);
  }

  onDiagnostic(d: Diagnostic): void {
    if (this.alive) this.owner.onDiagnostic(d);
  }

  async present(event: PresentEvent): Promise<Value | void> {
    if (!this.alive) return;
    switch (event.type) {
      case "page":
        this.owner.beforePage(event.key ? { ...event.at, key: event.key } : event.at);
        this.speaker = event.speaker;
        this.log.page(event.speaker, event.at, event.voice, event.label, event.with);
        this.owner.afterPage?.();
        // 同時に鳴らした二人目の話者も（コンフィグの話者ごとの音量に出す）
        for (const who of voiceSpeakers(event.voice, event.speaker)) this.owner.heardVoice?.(who);
        break;
      case "command":
        this.owner.command?.(event.name, event.args);
        // 本文の中の @voice（実行器は本文の中でだけ描画側へ送る）
        if (event.name === "voice") {
          this.log.voice({ file: String(event.args.file ?? ""), volume: Number(event.args.volume ?? 100), folder: String(event.args.folder ?? "voice") });
          if (this.speaker !== null) this.owner.heardVoice?.(this.speaker);
        }
        break;
      case "text":
        this.log.text(event.text, event.ruby, event.style);
        break;
      case "br":
        this.log.br();
        break;
    }
    if (event.type !== "command") return this.host.present(event);
    // 制限時間を使わないなら、残り時間のバーも出さない
    if (event.name === "choice-timer" && this.owner.choiceTimers?.() === false) return;
    const result = await this.host.present(event);
    if (this.alive) this.owner.afterCommand?.(event.name);
    return result;
  }

  async waitClick(signal: AbortSignal): Promise<void> {
    if (!this.alive) return;
    this.scheduleAuto(true);
    try {
      // 描画側が待ちに入ってから（host.waiting が true になってから）知らせる
      const waiting = this.host.waitClick(signal);
      this.owner.waitingChanged?.(true);
      await waiting;
    } finally {
      clearTimeout(this.autoTimer);
      if (this.alive) this.owner.waitingChanged?.(false);
    }
  }

  /**
   * オートの送りを（入れ直して）予約する。クリック待ちに入ったときと、
   * オートを入れた・画面を閉じたなど、クリック待ちの最中に送り方が変わったときに呼ぶ。
   */
  scheduleAuto(entering = false): void {
    if (!this.alive || (!entering && !this.host.waiting)) return;
    clearTimeout(this.autoTimer);
    this.waitedSpeech = false;
    const delay = this.owner.autoDelay([...plainText(this.log.current)].length);
    if (delay === null) return;
    this.autoTimer = setTimeout(() => this.autoAdvance(), delay);
  }

  /** オートで送る。ボイスがまだ鳴っていれば、鳴り終わってから少し間を置いて送る。 */
  private autoAdvance(): void {
    // 待っている間に画面を開いた・オートを切ったなら送らない（閉じたときにもう一度呼ばれる）
    if (!this.alive || !this.host.waiting || this.owner.autoDelay(0) === null) return;
    const rest = this.host.audio.voiceRemaining();
    if (rest > 0) {
      this.autoTimer = setTimeout(() => this.autoAdvance(), rest + VOICE_AUTO_GAP);
      return;
    }
    // テキスト読み上げで読んでいる間は待ち、読み終えてから少し間を置いて送る
    if (this.owner.speaking?.()) {
      this.waitedSpeech = true;
      this.autoTimer = setTimeout(() => this.autoAdvance(), SPEECH_POLL);
      return;
    }
    if (this.waitedSpeech) {
      this.waitedSpeech = false;
      this.autoTimer = setTimeout(() => this.autoAdvance(), VOICE_AUTO_GAP);
      return;
    }
    this.host.advance();
  }

  /** テキスト読み上げを待ったか（読み終えたら間を置いてから送る）。 */
  private waitedSpeech = false;

  async choose(options: string[], signal: AbortSignal, looks?: (ChoiceLook | null)[], targets?: (string | null)[]): Promise<number | null> {
    if (!this.alive) return null;
    this.owner.setChoosing(true);
    try {
      // 既読を読めなければ、既読の印なしで選択肢を出す
      const read = targets && this.owner.choiceRead ? await this.owner.choiceRead(targets).catch(() => []) : [];
      if (!this.alive || signal.aborted) return null;
      const selected = await this.host.choose(options, signal, looks, targets, this.owner.fixedChoice?.() ?? null, read);
      if (selected !== null && this.alive) this.owner.chose?.(selected);
      return selected;
    } finally {
      if (this.alive) this.owner.setChoosing(false);
    }
  }
}
