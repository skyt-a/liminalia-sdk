/**
 * lim shot --video の、時刻の合わせ方と選び方（ページもファイルも触らない部分。テストで確かめる）。
 * - FrameFeeder: 画面が変わったときにだけ届くコマを、一定の速さの動画のコマにして順に出す
 * - AudioAligner: ページから届く音（時刻つき）を、区切りの始まりからの位置に並べる（足りなければ無音、重なれば捨てる）
 * - VideoChooser: 選択肢と、画面が知らせた選べるもの（RenderContext.offer）の選び方（--choose、避ける選択肢とエンディング、
 *   同じ選択肢に戻るたびに次のもの。lim playtest の 1 通り目と同じ）
 */

/** 動画のコマの速さ。 */
export const VIDEO_FPS = 30;

/** 一つの撮ったコマ（t は時刻のミリ秒。Date.now と同じ時計）。 */
interface Shot {
  t: number;
  data: Buffer;
}

/**
 * 撮ったコマ（画面が変わったときにだけ届く）を、一定の速さの動画のコマにする。動画のコマの時刻までに届いた最後のものを見せる
 * （それより前に一つも無ければ、最初に届いたもの）。区切りが替わっても同じものを使い続ける（区切りごとに始まりと出した数を持つ）。
 */
export class FrameFeeder {
  private shots: Shot[] = [];

  constructor(private readonly fps = VIDEO_FPS) {}

  /** 届いたコマ。 */
  push(t: number, data: Buffer): void {
    const last = this.shots.at(-1);
    // まれに前後して届いたら、時刻の順に入れる
    if (last && t < last.t) {
      const i = this.shots.findIndex((s) => s.t > t);
      this.shots.splice(i, 0, { t, data });
      return;
    }
    this.shots.push({ t, data });
  }

  /** 一つでも届いたか。 */
  get ready(): boolean {
    return this.shots.length > 0;
  }

  /** start（ミリ秒）から数えて written 枚出したあと、until（ミリ秒）の時刻までに出す動画のコマ。 */
  take(start: number, written: number, until: number): Buffer[] {
    const out: Buffer[] = [];
    if (this.shots.length === 0) return out;
    let j = 0;
    for (let k = written; ; k++) {
      const at = start + (k * 1000) / this.fps;
      if (at > until) break;
      while (j + 1 < this.shots.length && this.shots[j + 1]!.t <= at) j++;
      out.push(this.shots[j]!.data);
    }
    // 見せ終えたコマは捨てる（今見せている最後のものは残す）
    if (j > 0) this.shots = this.shots.slice(j);
    return out;
  }
}

/** 一つの標本（全チャンネル）のバイト数。 */
const bytesPerFrame = (channels: number) => channels * 2;

/**
 * ページから届く音（16 ビットの符号つき、チャンネルを交互に並べたもの）を、区切りの始まり（start、ミリ秒）からの位置に並べる。
 * 届いた音の位置が、書いた所から tolerance（標本の数）より先なら間を無音で埋め、手前なら重なった所を捨てる。その内側のずれは
 * そのまま続ける（届く時刻の揺れで音を切らない）。音の時計と壁の時計のずれも、tolerance を超えたところで合わせ直す。
 */
export class AudioAligner {
  /** 書いた標本の数（一つのチャンネルあたり）。 */
  written = 0;
  /** 区切りの終わりの位置（limit で入る。そこより後の音は書かない）。 */
  private end = Infinity;

  constructor(
    private readonly rate: number,
    private readonly channels: number,
    private readonly start: number,
    private readonly tolerance = Math.round(rate * 0.06),
  ) {}

  /** その時刻（ミリ秒）の、区切りの始まりからの標本の位置。 */
  position(t: number): number {
    return Math.round(((t - this.start) / 1000) * this.rate);
  }

  private silence(frames: number): Buffer {
    return Buffer.alloc(frames * bytesPerFrame(this.channels));
  }

  /** 区切りの終わり（ミリ秒）。そこより後に届く音は書かない。 */
  limit(end: number): void {
    this.end = this.position(end);
  }

  /** 届いた音（end はその最後の標本の時刻、ミリ秒）。書くものを返す。 */
  chunk(end: number, pcm: Buffer): Buffer[] {
    const size = bytesPerFrame(this.channels);
    let data = pcm.subarray(0, pcm.length - (pcm.length % size));
    let frames = data.length / size;
    if (frames === 0) return [];
    let at = this.position(end) - frames;
    // 区切りの終わりより後の所は捨てる
    if (at + frames > this.end) {
      const keep = this.end - at;
      if (keep <= 0) return [];
      data = data.subarray(0, keep * size);
      frames = keep;
    }
    // 区切りの始まりより前の所は捨てる
    if (at < 0) {
      if (at + frames <= 0) return [];
      data = data.subarray(-at * size);
      frames += at;
      at = 0;
    }
    const gap = at - this.written;
    const out: Buffer[] = [];
    if (gap > this.tolerance) out.push(this.silence(gap));
    else if (gap < -this.tolerance) {
      const drop = -gap;
      if (drop >= frames) return [];
      data = data.subarray(drop * size);
    }
    out.push(data);
    for (const b of out) this.written += b.length / size;
    return out;
  }

  /** until（ミリ秒）の時刻まで音が届いていなければ、無音で埋める（音の鳴っていない間と、音の時計が止まっている間）。 */
  fill(until: number): Buffer | null {
    const target = Math.min(this.position(until), this.end);
    if (target <= this.written) return null;
    const frames = target - this.written;
    this.written = target;
    return this.silence(frames);
  }
}

/** 選び方の進み具合（続きから録るときに引き継ぐ）。 */
export interface ChooserState {
  /** --choose を使った数。 */
  used: number;
  /** 同じ選択肢（文の並び）を出した回数。 */
  seen: Record<string, number>;
  /** 避けた数。 */
  avoided: number;
}

/** 一つ選んだ結果。 */
export interface ChoicePick {
  index: number;
  /** 避ける選択肢を避けて、ほかのものにした。 */
  avoided: boolean;
}

/**
 * 選択肢（と画面が知らせた選べるもの）の選び方。
 * - --choose の番号（0 から）か、その文を含むものを順に使う（避けるものでも変えない）。当たらなければ下の選び方
 * - 使い切ったら、同じ選択肢（文の並び）に戻るたびに次のもの（初めては押せる最初のもの、二度目は二番目…）。戻ってくる選択肢で同じものを選び続けない
 * - そのうえで、避ける文を含むものと、避けるエンディングにしか行かない飛び先（traps）のものは、ほかに選べるものがあれば選ばない
 */
export class VideoChooser {
  private readonly state: ChooserState;

  constructor(
    private readonly choose: readonly (number | string)[],
    private readonly avoid: { choices: readonly string[]; traps: ReadonlySet<string> } = { choices: [], traps: new Set() },
    state?: ChooserState,
  ) {
    this.state = state ? structuredClone(state) : { used: 0, seen: {}, avoided: 0 };
  }

  /** 引き継ぐ進み具合。 */
  snapshot(): ChooserState {
    return structuredClone(this.state);
  }

  get avoided(): number {
    return this.state.avoided;
  }

  /** options は押せないものが null。targets は飛び先（わからなければ null）。 */
  pick(options: readonly (string | null)[], targets: readonly (string | null)[] | null = null): ChoicePick {
    const enabled = options.flatMap((t, i) => (t === null ? [] : [i]));
    if (enabled.length === 0) return { index: 0, avoided: false };
    const key = options.map((t) => t ?? "").join("\u0000");
    const n = this.state.seen[key] ?? 0;
    this.state.seen[key] = n + 1;
    if (this.state.used < this.choose.length) {
      const want = this.choose[this.state.used++];
      if (typeof want === "number" && enabled.includes(want)) return { index: want, avoided: false };
      if (typeof want === "string") {
        const hit = enabled.find((i) => options[i]!.includes(want));
        if (hit !== undefined) return { index: hit, avoided: false };
      }
    }
    const first = enabled[n % enabled.length]!;
    // 飛び先の分かるものがどれも避けるシーンなら、この選択肢では避けない（避けると、飛び先の分からないものだけを選び続けることがある）
    const known = enabled.filter((i) => typeof targets?.[i] === "string");
    const allTrapped = known.length > 0 && known.every((i) => this.avoid.traps.has(targets![i]!));
    const bad = (i: number) => this.avoid.choices.some((a) => a !== "" && options[i]!.includes(a)) || (!allTrapped && typeof targets?.[i] === "string" && this.avoid.traps.has(targets[i]!));
    if (!bad(first)) return { index: first, avoided: false };
    const at = enabled.indexOf(first);
    for (let k = 1; k < enabled.length; k++) {
      const i = enabled[(at + k) % enabled.length]!;
      if (!bad(i)) {
        this.state.avoided++;
        return { index: i, avoided: true };
      }
    }
    return { index: first, avoided: false };
  }
}
