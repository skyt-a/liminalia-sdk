/**
 * 遊ばれ方の統計（任意。liminalia.json の build.analytics.url を書いた作品の、書き出したゲームだけ）。既定は送らない。
 *
 * - はじめて起動したとき、遊ぶ人に送ってよいかを尋ね（system/default.ts）、答えをこの端末に覚える。コンフィグの「遊び方の統計を送る」で変えられる。
 *   答えるまで、「いいえ」と答えたら、何も送らない
 * - 送るのは選んだ選択肢（台本の位置、何番目か、いくつの中か、飛び先）と、遊ぶのをやめた場面（画面を閉じた・裏へ回したときに最後に出したページ）。
 *   名前を入れた本文、セーブ、変数、端末を見分ける番号は送らない。起動ごとに新しく作る印（session）だけでまとめる
 * - 送り先は作者が決める（作者のサーバー。Liminalia の提供者には届かない）。本文は JSON（ブラウザの事前の問い合わせを避けるため Content-Type は text/plain）
 *   受け取る形は docs/distribution.md の「遊ばれ方の統計」
 * このモジュールは build.analytics を書いた作品の書き出しにだけ入る（main.ts の __LIMINALIA_ANALYTICS__）。答えの読み書きは analytics-consent.ts。
 */
export { analyticsAskable, analyticsConsent, setAnalyticsConsent } from "./analytics-consent.ts";

/** 一度に送る記録。 */
export interface AnalyticsBatch {
  /** 作品の ID と版。 */
  project: string;
  version: string;
  /** 起動ごとに作る印（端末や人を見分けない）。 */
  session: string;
  /** browser、desktop、ios、android。 */
  platform: string;
  /** 遊んでいる言語（原文なら空）。 */
  language: string;
  events: AnalyticsEvent[];
}

export type AnalyticsEvent =
  /** 選択肢を選んだ。at は選択肢の行、option は表示した選択肢の何番目か（0 から）、options はいくつ表示したか、target は飛び先（分かれば）。 */
  | { type: "choice"; at: string; option: number; options: number; target?: string; time: number }
  /** 画面を閉じた・裏へ回した。at は最後に出したページ。time は起動してからの秒。 */
  | { type: "leave"; at: string; time: number };

/** 溜めたらまとめて送る数。 */
export const ANALYTICS_BATCH = 20;

export interface AnalyticsOptions {
  url: string;
  projectId: string;
  version: string;
  platform: string;
  language(): string;
  /** 送ってよいか（遊ぶ人の答え）。送るたびに見る（コンフィグで変えたらすぐ止める）。 */
  consent(): boolean;
  /** 送る口（テストで替える）。既定は fetch の keepalive。 */
  send?(url: string, body: string): void;
  now?(): number;
}

function defaultSend(url: string, body: string): void {
  // 統計は送れなくても遊ぶのに関わらないので、黙って捨てる
  void fetch(url, { method: "POST", body, keepalive: true, headers: { "content-type": "text/plain;charset=UTF-8" }, credentials: "omit" }).catch(() => undefined);
}

export class PlayAnalytics {
  private readonly queue: AnalyticsEvent[] = [];
  private readonly session: string;
  private readonly started: number;
  private readonly now: () => number;
  /** 最後に送った「やめた場面」（そのあと何も無ければ、閉じたときの二つ目の知らせでは送らない）。 */
  private lastLeave: string | null = null;

  constructor(private readonly o: AnalyticsOptions) {
    this.now = o.now ?? (() => Date.now());
    this.started = this.now();
    this.session = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${this.started.toString(36)}${Math.random().toString(36).slice(2)}`;
  }

  private time(): number {
    return Math.round((this.now() - this.started) / 1000);
  }

  choice(at: { file: string; line: number }, option: number, options: number, target: string | null): void {
    this.push({ type: "choice", at: `${at.file}:${at.line}`, option, options, ...(target ? { target } : {}), time: this.time() });
  }

  /** 画面を閉じた・裏へ回した（溜めたものと一緒にすぐ送る）。 */
  leave(at: { file: string; line: number } | null): void {
    const key = at ? `${at.file}:${at.line}` : null;
    if (key && !(this.lastLeave === key && this.queue.length === 0)) this.queue.push({ type: "leave", at: key, time: this.time() });
    this.lastLeave = key;
    this.flush();
  }

  private push(e: AnalyticsEvent): void {
    this.lastLeave = null;
    this.queue.push(e);
    if (this.queue.length >= ANALYTICS_BATCH) this.flush();
  }

  /** 溜めたものを送る（送ってよくなければ捨てる）。 */
  flush(): void {
    if (this.queue.length === 0) return;
    const events = this.queue.splice(0);
    if (!this.o.consent()) return;
    const batch: AnalyticsBatch = { project: this.o.projectId, version: this.o.version, session: this.session, platform: this.o.platform, language: this.o.language(), events };
    (this.o.send ?? defaultSend)(this.o.url, JSON.stringify(batch));
  }
}

/**
 * 遊ぶ側に入れる。画面を閉じた・裏へ回したときに、最後に出したページを「やめた場面」として送る。
 * 返すものの choice を、選択肢を選んだときに呼ぶ。
 */
export function installAnalytics(o: AnalyticsOptions & { where(): { file: string; line: number } | null }): PlayAnalytics {
  const a = new PlayAnalytics(o);
  const leave = () => a.leave(o.where());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") leave();
  });
  window.addEventListener("pagehide", leave);
  return a;
}
