/**
 * 展開した音（AudioBuffer）の控え。合わせた大きさが上限を超えたら、長く使っていないものから捨てる。
 * 展開した音は 1 分で約 20MB（44.1kHz・二つの声部）あるので、ボイスの多い作品を通して遊ぶと、捨てなければ数 GB になる。
 * 鳴っている音は鳴らしている側が持っているので、控えから捨てても鳴り続ける（次に使うときに読み直す）。
 * 読めなかったものは控えない（次に使うときにもう一度読む）。
 * 捨てたものでも、まだどこかが持っていれば（鳴っている BGM など）、次に頼まれたときに読み直さずにそれを控えに戻す
 * （メモリは減らないのに、長い BGM を展開し直すと時間がかかるため）。
 */
export class AudioCache<T> {
  private readonly entries = new Map<string, { value: Promise<T>; bytes: number }>();
  private bytes = 0;
  /** 読んだもの（オブジェクトのとき）。捨てたあとも、ほかが持っている間は取り出せる。 */
  private readonly alive = new Map<string, WeakRef<T & object>>();

  constructor(
    private readonly limit: number,
    private readonly sizeOf: (value: T) => number,
  ) {}

  /** 控えにあればそれを（使ったことにする）、なければ load で読んで控える。 */
  get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.value;
    }
    const kept = this.alive.get(key)?.deref();
    const entry = { value: kept ? Promise.resolve(kept as T) : load(), bytes: 0 };
    this.entries.set(key, entry);
    entry.value.then(
      (v) => {
        if (this.entries.get(key) !== entry) return;
        entry.bytes = this.sizeOf(v);
        this.bytes += entry.bytes;
        if (typeof v === "object" && v !== null) this.alive.set(key, new WeakRef(v));
        this.trim(key);
      },
      () => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
    );
    return entry.value;
  }

  /** 控えている大きさの合計。 */
  get size(): number {
    return this.bytes;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** 上限まで、古いものから捨てる（今読んだもの keep と、読んでいる途中のものは残す）。 */
  private trim(keep: string): void {
    // 誰も持たなくなったものの覚えを、控えの数の数倍に増えたら片付ける
    if (this.alive.size > this.entries.size * 4 + 64) for (const [key, ref] of this.alive) if (!ref.deref()) this.alive.delete(key);
    for (const [key, e] of this.entries) {
      if (this.bytes <= this.limit) return;
      if (key === keep || e.bytes === 0) continue;
      this.entries.delete(key);
      this.bytes -= e.bytes;
    }
  }
}

/**
 * 展開した音の控えの上限（系統ごと。合わせて 104MB）。前は全部で 192MB を一つの控えで持ち、長い BGM が数曲あると効果音とボイスを押し出した。
 * - bgm: 流し読みにしない短い BGM（1MB 以下。展開して 20MB ほどまで）と、流し読みできない所（範囲の指定に答えない）の BGM。数曲分
 * - sound: 効果音。数百本分
 * - voice: ボイス（先読みは先の 8 本ほど）。1 本 5 秒で 2MB ほどなので 10 本ほど
 */
export const AUDIO_CACHE_LIMITS = { bgm: 48 * 1024 * 1024, sound: 32 * 1024 * 1024, voice: 24 * 1024 * 1024 } as const;
