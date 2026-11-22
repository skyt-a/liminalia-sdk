/**
 * テキスト読み上げ（コンフィグの「テキスト読み上げ」）と、スクリーンリーダーへ本文を渡す場所。
 * - 読み上げ: ページを出し終えたら話者と本文を、端末の声（speechSynthesis）で読む（ルビのある字はルビの読みで）。ボイスのある台詞は読まない。
 *   オートは読み終わるのを待ってから送る（speaking）。
 *   選択肢を出したら選択肢を、画面のボタンを選んだら（キー・パッドで動かしたとき）そのボタンの文字を読む。次へ進んだら止める
 * - スクリーンリーダー: 本文は一字ずつの要素で組むので、ページを出し終えたら一続きの文を見えない場所（aria-live）に置いて読ませる
 */
import { TEXT } from "./strings.ts";

export class Accessibility {
  private readonly live: HTMLElement;
  private voiceOn = false;
  private language = "ja";

  constructor(stage: HTMLElement) {
    this.live = document.createElement("div");
    this.live.className = "lm-sr-only";
    this.live.setAttribute("role", "log");
    this.live.setAttribute("aria-live", "polite");
    stage.append(this.live);
    // 本文の一字ずつの要素は、スクリーンリーダーには読ませない（上の一続きの文を読む）
    stage.querySelector(".message .text")?.setAttribute("aria-hidden", "true");
    // 画面のボタンを選んだら読む（ポインタで押したときは読まない）
    stage.addEventListener("focusin", (e) => {
      if (!this.voiceOn) return;
      const el = e.target as HTMLElement | null;
      if (!el?.matches?.("button, [role=button], input, select") || !el.matches(":focus-visible")) return;
      const label = el.getAttribute("aria-label") || el.textContent || (el as HTMLInputElement).value || "";
      if (label.trim()) this.say(label.trim());
    });
  }

  /** 読み上げを使うか・読む言語。 */
  set(o: { voice: boolean; language: string }): void {
    this.voiceOn = o.voice && typeof speechSynthesis !== "undefined";
    this.language = o.language || "ja";
    if (!this.voiceOn) this.stop();
  }

  /** 次の本文（か選択肢）と一緒に読む説明（@describe と、絵の alt）。 */
  private descriptions: string[] = [];

  /** 読み上げのときだけの文を足す（画面には出さない。次の本文か選択肢の前に読む）。 */
  describe(text: string): void {
    const t = text.trim();
    if (t) this.descriptions.push(t);
  }

  /** たまっている説明を取り出す。 */
  private takeDescriptions(): string[] {
    return this.descriptions.splice(0);
  }

  /** ページを出し終えた。voiced はボイスを鳴らしたか（鳴らしたら本文は読まない）。spoken は読み上げる文（ルビの読みにしたもの。無ければ text）。 */
  page(speaker: string | null, text: string, voiced: boolean, spoken = text): void {
    const notes = this.takeDescriptions();
    // 本文は書いたまま渡す（台詞の括弧は本文にある。ui.text.quotes が strip なら無い）。名前とのつなぎ方は言語ごとの文言
    this.live.textContent = [...notes, speaker ? TEXT.a11y.line(speaker, text) : text].join(" ");
    const read = !voiced && spoken.trim() ? [speaker ? TEXT.a11y.speak(speaker, spoken) : spoken] : [];
    if (this.voiceOn && notes.length + read.length > 0) this.say([...notes, ...read].join(" "), true);
  }

  /** 本文を読み上げている最中か（オートはこれが終わるまで待つ）。 */
  get speaking(): boolean {
    return this.voiceOn && this.reading && typeof speechSynthesis !== "undefined" && (speechSynthesis.speaking || speechSynthesis.pending);
  }

  /** 本文を読んでいる（ボタンの読み上げではない）。 */
  private reading = false;

  /**
   * 本文の外で出したものを、すぐにスクリーンリーダーとテキスト読み上げに渡す（章の扉と章末の題など。RenderSystem.announce）。
   * たまっている説明（@describe）は次の本文に残す。
   */
  announce(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.live.textContent = t;
    if (this.voiceOn) this.say(t);
  }

  /** 選択肢を出した。 */
  choices(options: readonly string[], heading: string): void {
    const notes = this.takeDescriptions();
    this.live.textContent = [...notes, TEXT.a11y.list(heading, options)].join(" ");
    if (this.voiceOn) this.say([...notes, TEXT.a11y.speakList(heading, options)].join(" "));
  }

  stop(): void {
    this.reading = false;
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
  }

  private say(text: string, page = false): void {
    this.stop();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = this.language;
    if (page) {
      this.reading = true;
      // 差し替えた読み上げ（EventTarget でないもの）でも動くように、on のプロパティで受ける
      u.onend = u.onerror = () => (this.reading = false);
    }
    speechSynthesis.speak(u);
  }
}
