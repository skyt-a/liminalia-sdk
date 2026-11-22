/**
 * 長い BGM の流し読み。<audio> で少しずつ読みながら鳴らし、Web Audio に通して（MediaElementAudioSourceNode）定位・音量・フェードを掛ける。
 * 全部を展開して持つ（AudioBuffer。4 分の曲で 90MB ほど）代わりに、ブラウザが読んだ分だけを持つ。
 *
 * AudioBufferSourceNode と同じ口（loop・loopStart・loopEnd・playbackRate・stop(when)・"ended"）を持ち、AudioPlayer は同じに扱う。
 * ループの区間（イントロのあと）は、終わりの位置に来たら頭の位置へ飛ばして繰り返す（10ms ごとに見るので、つなぎ目は展開したものほど正確ではない）。
 * 区間の無いループは <audio> の loop に任せる。
 */
export class StreamSource extends EventTarget {
  readonly buffer = null;
  loop = false;
  loopStart = 0;
  /** 0 なら曲の終わり。 */
  loopEnd = 0;
  readonly el: HTMLAudioElement;
  private readonly node: MediaElementAudioSourceNode;
  private watcher: ReturnType<typeof setInterval> | null = null;
  private released = false;
  private endedSent = false;
  readonly playbackRate: { value: number };

  constructor(
    private readonly context: AudioContext,
    url: string,
  ) {
    super();
    const el = new Audio();
    el.preload = "auto";
    // 再生速度を変えたら音の高さも変える（AudioBufferSourceNode と同じ）
    (el as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = false;
    el.src = url;
    this.el = el;
    this.node = context.createMediaElementSource(el);
    this.playbackRate = {
      get value() {
        return el.playbackRate;
      },
      set value(v: number) {
        el.playbackRate = v;
      },
    };
    el.addEventListener("ended", () => {
      if (this.released) return;
      // 区間の終わりが曲の終わり（LOOPSTART だけ）なら、ここで頭の位置へ戻す
      if (this.loop) void this.play(this.loopStart);
      else this.finish();
    });
  }

  connect(destination: AudioNode): void {
    this.node.connect(destination);
  }

  /** 曲の長さ（秒。読めるまでは 0）。 */
  get duration(): number {
    return Number.isFinite(this.el.duration) ? this.el.duration : 0;
  }

  /** 今の位置（秒）。 */
  get position(): number {
    return this.el.currentTime;
  }

  /** at 秒から鳴らす。鳴らせなければ（読めない・自動再生の制限）例外。 */
  async play(at = 0): Promise<void> {
    const el = this.el;
    if (el.readyState < HTMLMediaElement.HAVE_METADATA) {
      await new Promise<void>((resolve, reject) => {
        const ok = () => (off(), resolve());
        const ng = () => (off(), reject(el.error ?? new Error("音声を読み込めません")));
        const off = () => {
          el.removeEventListener("loadedmetadata", ok);
          el.removeEventListener("error", ng);
        };
        el.addEventListener("loadedmetadata", ok);
        el.addEventListener("error", ng);
      });
    }
    if (this.released) return;
    el.loop = this.loop && this.loopStart <= 0 && this.loopEnd <= 0;
    el.currentTime = Math.max(0, Math.min(at, this.duration || at));
    await el.play();
    this.watch();
  }

  /** 止めて、止めた位置（秒）を返す（続きは play(at)）。 */
  pause(): number {
    this.unwatch();
    this.el.pause();
    return this.el.currentTime;
  }

  /** when（AudioContext の時刻）に止めて手放す。省くと今。止めたら "ended" を出す（AudioBufferSourceNode と同じ）。 */
  stop(when?: number): void {
    const wait = when === undefined ? 0 : (when - this.context.currentTime) * 1000;
    if (wait > 0) setTimeout(() => this.release(), wait);
    else this.release();
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    this.unwatch();
    this.el.pause();
    this.node.disconnect();
    // 読んだものを手放す
    this.el.removeAttribute("src");
    this.el.load();
    this.finish();
  }

  private finish(): void {
    if (this.endedSent) return;
    this.endedSent = true;
    this.dispatchEvent(new Event("ended"));
  }

  /** ループの区間の終わりを見張る（区間があるときだけ）。 */
  private watch(): void {
    this.unwatch();
    if (!this.loop || this.loopEnd <= 0) return;
    this.watcher = setInterval(() => {
      const el = this.el;
      const end = this.loopEnd;
      if (el.paused || end <= this.loopStart) return;
      // 終わりを越えた分は頭の位置から先へ（見る間隔のぶん、少し越えてから飛ぶ）
      if (el.currentTime >= end - 0.005) el.currentTime = this.loopStart + Math.max(0, el.currentTime - end);
    }, 10);
  }

  private unwatch(): void {
    if (this.watcher !== null) clearInterval(this.watcher);
    this.watcher = null;
  }
}
