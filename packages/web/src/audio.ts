import { readLoopTags } from "@liminalia/lang";
import type { SoundOptions, Value } from "@liminalia/runtime";
import { AUDIO_CACHE_LIMITS, AudioCache } from "./audio-cache.ts";
import { FilterStage, soundFilter, type SoundFilter } from "./audio-filter.ts";
import { StreamSource } from "./audio-stream.ts";

export { readLoopTags };
export { SOUND_FILTERS, soundFilter, type SoundFilter, type SoundFilterType } from "./audio-filter.ts";

/** 音を読むフォルダ。 */
export type AudioFolder = "bgm" | "sound" | "voice";
/** 音量をまとめて掛ける系統（設定画面の音量の単位）。 */
export type AudioBus = "bgm" | "sound" | "voice";
type Bus = AudioBus;

/** この環境で <video>・<audio> の volume を変えられるか（iOS の Safari・WKWebView は変えられず、いつも 1）。 */
let mediaVolumeWorks: boolean | undefined;
function canSetMediaVolume(): boolean {
  if (mediaVolumeWorks === undefined) {
    try {
      const probe = document.createElement("audio");
      probe.volume = 0.5;
      mediaVolumeWorks = Math.abs(probe.volume - 0.5) < 0.01;
    } catch {
      mediaVolumeWorks = true;
    }
  }
  return mediaVolumeWorks;
}

/** 鳴らし方。ループの位置は秒（省くと曲に埋め込まれた LOOPSTART・LOOPLENGTH、無ければ頭と最後）、pan は -1（左）〜1（右）、rate は再生速度。 */
export interface PlayOptions {
  loopStart?: number;
  loopEnd?: number;
  pan?: number;
  rate?: number;
  /** 鳴らし始める位置（秒。一時停止したところから続けるとき）。 */
  offset?: number;
  /** 音のフィルター（こもり・電話・無線・広間）。null・省略は掛けない。 */
  filter?: SoundFilter | null;
  /** フィルターを掛け始めるまでのフェード（ミリ秒。同じ BGM に掛け直すときに使う）。 */
  filterFadeMs?: number;
}

/** 音の元（展開した音か、流し読みの BGM）。 */
type Source = AudioBufferSourceNode | StreamSource;

/**
 * 鳴っている音のつなぎ（source → input（定位があれば StereoPanner、無ければ gain）→ gain → （ボイスは口パクの音の大きさを測る meter）→
 * （フィルターがあれば filter）→ 系統）。tail は系統の手前の最後のもの（フィルターを後から入れるときにつなぎ直す）。
 */
interface Voice {
  source: Source;
  input: AudioNode;
  gain: GainNode;
  bus: Bus;
  tail: AudioNode;
  filter?: FilterStage;
  meter?: AnalyserNode;
}

/** 鳴っているボイス（speaker は話者。地の文は null）。 */
type VoiceEntry = Voice & { speaker: string | null; endsAt: number; channel: number };

/**
 * この大きさ（バイト）より大きい BGM は、展開せずに流し読みする（StreamSource）。1MB の Vorbis はおよそ 1 分で、展開すると 20MB を超える。
 * 置いてある所が範囲の指定（Range）に答えるときだけ（答えなければ今までどおり展開する）。
 */
export const STREAM_BGM_BYTES = 1024 * 1024;
/** 流し読みにするかを見るために読む頭の大きさ（ループの位置のタグもここから読む）。 */
const PROBE_BYTES = 256 * 1024;

/**
 * 頭を読んだ結果。ranged は置いてある所が範囲の指定に答えたか、total は全体の大きさ、tags は埋め込みのループの位置。
 * data は範囲の指定に答えず全部が届いたときの中身（展開に使ったら手放す）。
 */
interface Probe {
  ranged: boolean;
  total: number;
  tags: { start?: number; end?: number } | null;
  data?: ArrayBuffer;
}

/**
 * 展開する音の標本化の速さの上限。Web Audio は音を出力の速さで展開するので、出力が 96kHz の端末（Mac など）では
 * 44.1kHz・48kHz の素材も 96kHz に引き伸ばされ、展開した大きさが倍になる（4 分半の BGM で約 200MB）。
 * 素材より細かくしても音は良くならないので、48kHz より速い端末では 48kHz で動かす（出力への変換はブラウザがする）。
 */
const MAX_SAMPLE_RATE = 48_000;

function createContext(): AudioContext {
  const context = new AudioContext();
  if (context.sampleRate <= MAX_SAMPLE_RATE) return context;
  try {
    const capped = new AudioContext({ sampleRate: MAX_SAMPLE_RATE });
    void context.close();
    return capped;
  } catch {
    return context;
  }
}

/**
 * Web Audio による再生。BGM は一本、効果音はチャンネルごとに一本、ボイスは一本。
 * 音量は 0〜100、時間はミリ秒。
 */
export class AudioPlayer {
  readonly context = createContext();
  /** 展開した音の控え（系統ごとに上限を持ち、超えたら長く使っていないものから捨てる）。 */
  private readonly buffers: Record<Bus, AudioCache<AudioBuffer>> = {
    bgm: new AudioCache<AudioBuffer>(AUDIO_CACHE_LIMITS.bgm, bufferBytes),
    sound: new AudioCache<AudioBuffer>(AUDIO_CACHE_LIMITS.sound, bufferBytes),
    voice: new AudioCache<AudioBuffer>(AUDIO_CACHE_LIMITS.voice, bufferBytes),
  };
  /** 長い BGM を流し読みするか（ui.sound.streamBgm。既定 true）。 */
  private streaming = true;
  /** この大きさ（バイト）より大きい BGM を流し読みする（確かめのために小さくできる）。 */
  streamBytes = STREAM_BGM_BYTES;
  /** URL → 流し読みにするか（一度見たら覚える）。 */
  private readonly probes = new Map<string, Promise<Probe>>();
  private bgm: ({ file: string } & Voice) | null = null;
  private readonly se = new Map<string, Voice>();
  /** 鳴っているボイス（ボイスのチャンネル → ボイス。二人が同時に話すときは二つ）。 */
  private readonly voices = new Map<number, VoiceEntry>();
  /** 話者ごとのボイスの音量（0〜100。無い話者は 100）。 */
  private speakerVolumes: Record<string, number> = {};
  /** ボイスの音の大きさを測る（口パク）。 */
  private readonly voiceMeter = this.context.createAnalyser();
  private readonly meterData = new Float32Array(1024);
  /** 設定画面の音量（BGM・効果音・ボイスそれぞれ全体に掛かる）。 */
  private readonly master = { bgm: this.context.createGain(), sound: this.context.createGain(), voice: this.context.createGain() };
  /** 全体の出口。音を消す（setMuted）ときはここを 0 にする（設定画面の音量とは別に持つ。制作画面のプレビューのミュート）。 */
  private readonly output = this.context.createGain();
  /** 遊ぶ人の全体の音量とミュート（設定画面の「全体の音量」「ミュート」。setVolume）。 */
  private readonly overall = this.context.createGain();
  private overallVolume = 100;
  private overallMuted = false;
  /** 設定画面の系統ごとの音量（0〜100。動画の音量の計算に使う）。 */
  private readonly levels: Record<Bus, number> = { bgm: 100, sound: 100, voice: 100 };
  /** 動画の音を掛ける系統（ui.sound.movie。null なら全体の音量だけ）。 */
  private mediaBus: Bus | null = "bgm";
  /** 音量を合わせている動画・音声の要素（bindMedia）。 */
  private readonly media = new Map<HTMLMediaElement, { volume: number; bus: Bus | null; muted: boolean; gain: GainNode | null }>();
  /** ボイスの間だけ BGM を下げる段（設定画面の「ボイスの間 BGM を下げる」）。duckLevel は下げたときの倍率（1 は下げない）。 */
  private readonly duck = this.context.createGain();
  private duckLevel = 1;
  private muted = false;

  constructor(
    private readonly url: (kind: AudioFolder, file: string) => string,
    /** 書き出しが元の音から読んだループの位置（スマホ版で縮めた音。埋め込みのタグより先に使う）。 */
    private readonly knownLoop?: (kind: AudioFolder, file: string) => { start?: number; end?: number } | undefined,
  ) {
    this.output.connect(this.overall);
    this.overall.connect(this.context.destination);
    this.master.bgm.connect(this.duck);
    this.duck.connect(this.output);
    this.master.sound.connect(this.output);
    this.voiceMeter.fftSize = 1024;
    this.master.voice.connect(this.voiceMeter);
    this.voiceMeter.connect(this.output);
  }

  /** 音を消す・戻す。鳴っている音は止めずに、聞こえなくするだけ（設定画面の音量はそのまま）。 */
  setMuted(muted: boolean): void {
    this.muted = muted;
    this.output.gain.setValueAtTime(muted ? 0 : 1, this.context.currentTime);
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** 設定画面の音量（0〜100）。再生中の音にもすぐ効く。 */
  setMasterVolume(kind: Bus, volume: number): void {
    this.levels[kind] = Math.max(0, Math.min(100, volume));
    this.master[kind].gain.setValueAtTime(this.levels[kind] / 100, this.context.currentTime);
    this.syncMedia();
  }

  /** 全体の音量（0〜100）とミュート（設定画面）。すべての音と、bindMedia した動画に掛ける。 */
  setVolume(volume: number, muted: boolean): void {
    this.overallVolume = Math.max(0, Math.min(100, volume));
    this.overallMuted = muted;
    this.overall.gain.setValueAtTime(muted ? 0 : this.overallVolume / 100, this.context.currentTime);
    this.syncMedia();
  }

  /** 全体の音量とミュート。 */
  get volume(): { volume: number; muted: boolean } {
    return { volume: this.overallVolume, muted: this.overallMuted };
  }

  /** 長い BGM を流し読みするか（ui.sound.streamBgm）。次に鳴らす曲から効く。 */
  setStreaming(enabled: boolean): void {
    this.streaming = enabled;
  }

  /** 展開して控えている音の大きさ（バイト。系統ごと）と、流し読みで鳴っている BGM があるか。 */
  memory(): { bgm: number; sound: number; voice: number; streaming: boolean } {
    return { bgm: this.buffers.bgm.size, sound: this.buffers.sound.size, voice: this.buffers.voice.size, streaming: this.bgm?.source instanceof StreamSource };
  }

  /** 動画の音を掛ける系統（ui.sound.movie。"none" は全体の音量だけ）。次に bindMedia するものから効く。 */
  setMediaBus(bus: Bus | "none"): void {
    this.mediaBus = bus === "none" ? null : bus;
  }

  /**
   * 動画・音声の要素の音量を、volume（0〜100。命令の引数）× 系統の音量（既定は BGM）× 全体の音量にし、ミュートを効かせる。
   * 設定が変わったら合わせ直す。要素の volume を変えられない環境（iOS）では、Web Audio に通して音量を掛ける
   * （通せなければ、音量が 0 のときだけ muted にする）。要素の muted（@movie の mute=true など）はそのまま残す。
   * 舞台から外した要素は、次に合わせるときに手放す。
   */
  bindMedia(el: HTMLMediaElement, volume = 100, bus: Bus | null = this.mediaBus): void {
    const entry = this.media.get(el) ?? { volume, bus, muted: el.muted, gain: null as GainNode | null };
    entry.volume = Math.max(0, Math.min(100, volume));
    entry.bus = bus;
    if (!this.media.has(el) && (!canSetMediaVolume() || this.captures.size > 0)) this.routeMedia(el, entry);
    this.media.set(el, entry);
    this.syncMedia();
  }

  /** 動画・音声の要素の音を Web Audio に通す（系統と全体の音量はつなぎ先で掛かる）。通せなければ gain は null のまま。 */
  private routeMedia(el: HTMLMediaElement, entry: { bus: Bus | null; gain: GainNode | null }): void {
    try {
      const source = this.context.createMediaElementSource(el);
      entry.gain = this.context.createGain();
      source.connect(entry.gain).connect(entry.bus ? this.master[entry.bus] : this.output);
      // 要素の音量は 1 のまま（掛けるのはつなぎ先）
      el.volume = 1;
    } catch {
      entry.gain = null;
    }
  }

  /** 鳴っている音を写している先（capture）。 */
  private readonly captures = new Set<AudioNode>();

  /**
   * 鳴っている音をすべて（BGM、効果音、ボイス、動画の音。全体の音量とミュートの後）node にも流す（録画の lim shot --video が使う）。
   * 写している間は、動画・音声の要素（bindMedia）の音も Web Audio に通す（すでに鳴っているものも）。返す関数で外す。
   */
  capture(node: AudioNode): () => void {
    this.overall.connect(node);
    this.captures.add(node);
    for (const [el, entry] of this.media) if (!entry.gain) this.routeMedia(el, entry);
    this.syncMedia();
    return () => {
      if (!this.captures.delete(node)) return;
      try {
        this.overall.disconnect(node);
      } catch {
        // もう外れている
      }
    };
  }

  /** bindMedia した要素の音量を今の設定に合わせる（外した要素は手放す）。 */
  private syncMedia(): void {
    for (const [el, m] of this.media) {
      if (!el.isConnected && el.readyState > 0) {
        this.media.delete(el);
        continue;
      }
      const own = m.volume / 100;
      if (m.gain) {
        // Web Audio に通した音は、系統と全体の音量がつなぎ先で掛かる
        m.gain.gain.setValueAtTime(own, this.context.currentTime);
        continue;
      }
      const level = (m.bus ? this.levels[m.bus] / 100 : 1) * (this.overallMuted ? 0 : this.overallVolume / 100) * own;
      if (canSetMediaVolume()) el.volume = Math.max(0, Math.min(1, level));
      else el.muted = m.muted || level === 0;
    }
  }

  /** ボイスを鳴らしている間の BGM の倍率（0〜1。1 なら下げない）。 */
  setDucking(level: number): void {
    this.duckLevel = Math.max(0, Math.min(1, level));
    this.rampDuck(this.voices.size > 0 ? this.duckLevel : 1, 0.1);
  }

  private rampDuck(to: number, seconds: number): void {
    const g = this.duck.gain;
    const now = this.context.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(to, now + seconds);
  }

  /** ブラウザの自動再生制限を解く。ユーザー操作の中で呼ぶ。 */
  unlock(): Promise<void> {
    return this.context.resume();
  }

  /**
   * BGM を鳴らす。crossfadeMs があれば、新しい曲を読み込んでから、今の曲を消しつつ新しい曲を入れる（読み込みの間も今の曲は鳴り続ける）。
   * 無ければ今の曲を fadeMs で消し、新しい曲を fadeMs で入れる。
   */
  async playBgm(file: string, volume: number, loop: boolean, fadeMs: number, o: PlayOptions & { crossfadeMs?: number } = {}): Promise<void> {
    if ((this.bgm?.file ?? this.loadingBgm) === file) {
      // 同じ曲は鳴らし直さず、フィルターだけ掛け直す（@bgm 同じ曲 filter=… で、曲を止めずにこもらせる・戻す）
      if (this.bgm) this.applyFilter(this.bgm, o.filter ?? null, o.filterFadeMs ?? 0);
      return;
    }
    const crossfade = o.crossfadeMs ?? 0;
    const previous = crossfade > 0 ? this.bgm : null;
    if (previous) {
      // 今の曲は新しい曲が鳴るまで残す（stopBgm と同じく、ほかの指示は取り消す）
      this.pausedBgm = null;
      this.bgmToken++;
      this.bgm = null;
    } else this.stopBgm(fadeMs);
    const token = this.bgmToken;
    this.loadingBgm = file;
    const node = await this.start("bgm", "bgm", file, volume, loop, crossfade > 0 ? crossfade : fadeMs, o);
    if (token !== this.bgmToken) {
      // 読み込んでいる間に次の BGM や止める指示が来ていたら鳴らさない（鳴らすと誰も止められない）
      node?.source.stop();
      if (previous) this.fadeOutAndStop(previous, crossfade);
      return;
    }
    this.loadingBgm = null;
    if (previous) this.fadeOutAndStop(previous, crossfade);
    if (node) this.bgm = { file, ...node };
  }

  /** 読み込んでいる BGM（同じ BGM をもう一度頼まれたら読み直さない）と、playBgm・stopBgm のたびに進む番号。 */
  private loadingBgm: string | null = null;
  private bgmToken = 0;

  stopBgm(fadeMs: number): void {
    this.pausedBgm = null;
    this.bgmToken++;
    this.loadingBgm = null;
    if (!this.bgm) return;
    this.fadeOutAndStop(this.bgm, fadeMs);
    this.bgm = null;
  }

  async playSe(channel: string, file: string, volume: number, loop: boolean, fadeMs: number, o: PlayOptions = {}): Promise<void> {
    this.stopSe(channel, 0);
    const token = this.seTokens.get(channel) ?? 0;
    const node = await this.start("sound", "sound", file, volume, loop, fadeMs, o);
    // 読み込んでいる間に同じチャンネルの次の音や止める指示が来ていたら鳴らさない
    if (node && token !== (this.seTokens.get(channel) ?? 0)) {
      node.source.stop();
      return;
    }
    if (node) {
      this.se.set(channel, node);
      node.source.addEventListener("ended", () => {
        if (this.se.get(channel) === node) this.se.delete(channel);
      });
    }
  }

  /**
   * 文字を出すときの短い音（@text-sound）を一回鳴らす。効果音の音量で鳴らし、チャンネルを持たない（止めない・重ねてよい）。
   * 読み込み中なら鳴らさない（最初の数文字が鳴らなくても、文字の表示を待たせない）。
   */
  playBlip(file: string, volume: number): void {
    const url = this.url("sound", file);
    const loaded = this.blips.get(url);
    if (!loaded) {
      if (this.blips.has(url)) return;
      // 文字の音は数種類のはず。増えすぎたら古いものから手放す
      while (this.blips.size >= 16) this.blips.delete(this.blips.keys().next().value!);
      this.blips.set(url, null);
      void this.load(url, "sound").then(
        (b) => this.blips.set(url, b),
        () => console.warn(`音声を読み込めません: ${file}`),
      );
      return;
    }
    const source = this.context.createBufferSource();
    source.buffer = loaded;
    const gain = this.context.createGain();
    gain.gain.value = Math.max(0, Math.min(1, volume / 100));
    source.connect(gain).connect(this.master.sound);
    source.start();
  }

  /** 読み終えた文字の音（読み込み中は null）。 */
  private readonly blips = new Map<string, AudioBuffer | null>();

  /** チャンネルごとの、playSe・stopSe のたびに進む番号。 */
  private readonly seTokens = new Map<string, number>();

  stopSe(channel: string, fadeMs: number): void {
    this.seTokens.set(channel, (this.seTokens.get(channel) ?? 0) + 1);
    this.pausedSe.delete(channel);
    const node = this.se.get(channel);
    if (!node) return;
    this.fadeOutAndStop(node, fadeMs);
    this.se.delete(channel);
  }

  /** keepBgm と同じ BGM が鳴っていれば、それは止めない（ロードで同じ BGM を鳴らし直さないため）。 */
  stopAll(keepBgm?: string): void {
    if (keepBgm === undefined || (this.bgm?.file ?? this.loadingBgm) !== keepBgm) this.stopBgm(0);
    // 読み込んでいる途中のチャンネルも止める
    for (const channel of new Set([...this.se.keys(), ...this.seTokens.keys()])) this.stopSe(channel, 0);
    this.stopVoice(0);
  }

  // ---- ボイス ----

  /**
   * ボイスを鳴らす（同じボイスのチャンネルで鳴っているボイスは止める。チャンネルの既定は 1）。speaker は話者ごとの音量と口パクを引くための名前。
   * 二人が同時に話すときは、二つ目を別のチャンネル（2 など）で鳴らす。filter は音のフィルター（電話越しなど）。
   */
  async playVoice(folder: "voice" | "sound", file: string, volume: number, speaker: string | null, o: { channel?: number; filter?: SoundFilter | null } = {}): Promise<void> {
    const channel = o.channel ?? 1;
    this.stopVoiceChannel(channel, 0);
    const token = (this.voiceTokens.get(channel) ?? 0) + 1;
    this.voiceTokens.set(channel, token);
    const scale = speaker === null ? 1 : (this.speakerVolumes[speaker] ?? 100) / 100;
    const node = await this.start("voice", folder, file, volume * scale, false, 0, { ...(o.filter ? { filter: o.filter } : {}) });
    if (!node) return;
    // 読み込んでいる間に同じチャンネルの次のボイスや止める指示が来ていたら鳴らさない
    if (token !== this.voiceTokens.get(channel)) {
      node.source.stop();
      return;
    }
    const entry: VoiceEntry = { ...node, speaker, channel, endsAt: this.context.currentTime + durationOf(node.source) };
    this.voices.set(channel, entry);
    if (this.duckLevel < 1) this.rampDuck(this.duckLevel, 0.15);
    node.source.addEventListener("ended", () => {
      if (this.voices.get(channel) !== entry) return;
      this.voices.delete(channel);
      if (this.voices.size === 0) this.rampDuck(1, 0.4);
    });
  }

  /** ボイスのチャンネルごとの、playVoice・stopVoice のたびに進む番号。 */
  private readonly voiceTokens = new Map<number, number>();

  /** ボイスを止める（channel を省くとすべてのチャンネル）。 */
  stopVoice(fadeMs: number, channel?: number): void {
    if (channel !== undefined) return this.stopVoiceChannel(channel, fadeMs);
    for (const c of new Set([...this.voices.keys(), ...this.voiceTokens.keys()])) this.stopVoiceChannel(c, fadeMs);
  }

  private stopVoiceChannel(channel: number, fadeMs: number): void {
    this.voiceTokens.set(channel, (this.voiceTokens.get(channel) ?? 0) + 1);
    const entry = this.voices.get(channel);
    if (!entry) return;
    this.fadeOutAndStop(entry, fadeMs);
    this.voices.delete(channel);
    if (this.voices.size === 0) this.rampDuck(1, 0.4);
  }

  /** ボイスが鳴り終わるまで待つ（すべてのチャンネル）。鳴っていなければすぐ終わる。 */
  waitVoice(): Promise<void> {
    return this.ended([...this.voices.values()].map((v) => v.source));
  }

  /** 鳴っているボイスの残りのミリ秒（いちばん長く残るもの。鳴っていなければ 0）。オートの待ちに使う。 */
  voiceRemaining(): number {
    let ms = 0;
    for (const v of this.voices.values()) ms = Math.max(ms, (v.endsAt - this.context.currentTime) * 1000);
    return Math.max(0, ms);
  }

  /** 鳴っているボイスの話者（チャンネルのいちばん小さいもの。鳴っていなければ undefined、地の文のボイスは null）。 */
  get voiceSpeaker(): string | null | undefined {
    const first = [...this.voices.values()].sort((a, b) => a.channel - b.channel)[0];
    return first ? first.speaker : undefined;
  }

  /** 鳴っているボイスの話者（同時に話していれば二人とも）。 */
  get voiceSpeakers(): (string | null)[] {
    return [...this.voices.values()].sort((a, b) => a.channel - b.channel).map((v) => v.speaker);
  }

  /** 今のボイスの音の大きさ（すべてのボイスを合わせて 0〜1 のおおよその値）。 */
  voiceLevel(): number {
    if (this.voices.size === 0) return 0;
    return this.measure(this.voiceMeter);
  }

  /**
   * その話者のボイスの音の大きさ（0〜1。口パクに使う）。names のどれかが話者のボイスが鳴っていればその大きさ、ほかの人のボイスだけが鳴っていれば 0、
   * どのボイスも鳴っていなければ undefined。
   */
  speakerLevel(names: readonly string[]): number | undefined {
    if (this.voices.size === 0) return undefined;
    let level = 0;
    for (const v of this.voices.values()) if (v.speaker !== null && names.includes(v.speaker) && v.meter) level = Math.max(level, this.measure(v.meter));
    return level;
  }

  private measure(meter: AnalyserNode): number {
    meter.getFloatTimeDomainData(this.meterData);
    let sum = 0;
    for (const v of this.meterData) sum += v * v;
    return Math.min(1, Math.sqrt(sum / this.meterData.length) * 4);
  }

  /**
   * 鳴っているボイスに音のフィルターを掛ける・外す（@voice-filter）。speaker を書くと、その話者のボイスだけ。
   * これから鳴らすボイスには、実行器が台詞ごとに渡す（playVoice の filter）。
   */
  setVoiceFilter(filter: SoundFilter | null, fadeMs: number, speaker?: string): void {
    for (const v of this.voices.values()) if (speaker === undefined || v.speaker === speaker) this.applyFilter(v, filter, fadeMs);
  }

  /** 鳴っている BGM のフィルターを替える（null は外す）。 */
  setBgmFilter(filter: SoundFilter | null, fadeMs: number): void {
    const node = this.bgm ?? this.pausedBgm?.node;
    if (node) this.applyFilter(node, filter, fadeMs);
  }

  /** 鳴っている効果音のフィルターを替える（channel を省くとすべて）。 */
  setSeFilter(channel: string | undefined, filter: SoundFilter | null, fadeMs: number): void {
    for (const [c, node] of this.se) if (channel === undefined || c === channel) this.applyFilter(node, filter, fadeMs);
  }

  /** 今掛けているフィルター（確かめと開発の道具。BGM か効果音のチャンネルか、ボイスのチャンネル）。 */
  filterOf(kind: "bgm" | "se" | "voice", channel?: string | number): SoundFilter | null {
    const node = kind === "bgm" ? (this.bgm ?? this.pausedBgm?.node) : kind === "se" ? this.se.get(String(channel ?? 0)) : this.voices.get(Number(channel ?? 1));
    return node?.filter?.filter ?? null;
  }

  /** 音にフィルターを掛ける（まだフィルターの段が無ければ、系統の手前に入れる）。 */
  private applyFilter(node: Voice, filter: SoundFilter | null, fadeMs: number): void {
    if (!node.filter) {
      if (!filter) return;
      const stage = new FilterStage(this.context);
      node.tail.disconnect();
      node.tail.connect(stage.input);
      stage.output.connect(this.master[node.bus]);
      node.filter = stage;
    }
    node.filter.set(filter, fadeMs);
  }

  private systemVoice: Voice | null = null;

  /** システムボイスを鳴らす（ボイスの音量に従う。前のシステムボイスは止める。シナリオのボイスは止めない）。 */
  async playSystemVoice(file: string, volume: number): Promise<void> {
    if (this.systemVoice) this.fadeOutAndStop(this.systemVoice, 0);
    const token = ++this.systemVoiceToken;
    const node = await this.start("voice", "voice", file, volume, false, 0);
    if (!node) return;
    if (token !== this.systemVoiceToken) return void node.source.stop();
    this.systemVoice = node;
  }

  private systemVoiceToken = 0;

  /** 鳴らしている試聴の音（コンフィグの音量の欄。playSample）。 */
  private sample: Voice | null = null;
  private sampleToken = 0;

  /**
   * コンフィグの音量の欄の試聴を鳴らす（ui.settings.samples）。その系統の音量で一度だけ鳴らし、前の試聴は止める。
   * シナリオの BGM・効果音・ボイスの状態には触れない。BGM の試聴は、BGM が鳴っていないとき（タイトルなど）だけ鳴らす。
   */
  async playSample(kind: "bgm" | "se" | "voice", file: string): Promise<void> {
    if (kind === "bgm" && (this.bgm || this.loadingBgm)) return;
    this.stopSample(0);
    const token = this.sampleToken;
    const bus: Bus = kind === "bgm" ? "bgm" : kind === "se" ? "sound" : "voice";
    const node = await this.start(bus, kind === "se" ? "sound" : kind, file, 100, false, 0);
    if (!node) return;
    if (token !== this.sampleToken) return void node.source.stop();
    this.sample = node;
  }

  /** 試聴を止める（コンフィグを閉じたとき）。 */
  stopSample(fadeMs = 300): void {
    this.sampleToken++;
    if (!this.sample) return;
    this.fadeOutAndStop(this.sample, fadeMs);
    this.sample = null;
  }

  /** 話者ごとのボイスの音量（0〜100）。次に鳴らすボイスから効く。 */
  setSpeakerVolumes(volumes: Record<string, number>): void {
    this.speakerVolumes = { ...volumes };
  }

  private async start(bus: Bus, folder: AudioFolder, file: string, volume: number, loop: boolean, fadeMs: number, o: PlayOptions = {}): Promise<Voice | null> {
    const url = this.url(folder, file);
    // 長い BGM は流し読み（鳴らせなければ展開して鳴らす）
    if (bus === "bgm" && folder === "bgm") {
      const streamed = await this.startStream(url, folder, file, volume, loop, fadeMs, o);
      if (streamed) return streamed;
    }
    let buffer: AudioBuffer;
    try {
      buffer = await this.load(url, bus);
    } catch (e) {
      console.warn(`音声を読み込めません: ${file}`, e);
      return null;
    }
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    // ループの位置（指定が無ければ、書き出しが元の音から読んだもの、曲に埋め込まれたもの の順）
    const tags = this.knownLoop?.(folder, file) ?? this.loopTags.get(url);
    const loopStart = o.loopStart ?? tags?.start;
    const loopEnd = o.loopEnd ?? tags?.end;
    if (loop && loopStart !== undefined && loopStart < buffer.duration) source.loopStart = loopStart;
    if (loop && loopEnd !== undefined && loopEnd > (loopStart ?? 0)) source.loopEnd = Math.min(loopEnd, buffer.duration);
    if (o.rate !== undefined && o.rate > 0) source.playbackRate.value = o.rate;
    const { input, gain } = this.chain(volume, fadeMs, o);
    source.connect(input);
    const node = this.connectOut({ source, input, gain, bus, tail: gain }, o);
    const offset = Math.max(0, Math.min(o.offset ?? 0, buffer.duration - 0.05));
    source.start(0, offset);
    this.playing.set(source, { buffer, startedAt: this.context.currentTime, offset, loop, rate: source.playbackRate.value });
    return node;
  }

  /** 系統へつなぐ（ボイスは口パクの音の大きさを測る meter を通し、フィルターがあれば段を入れる）。 */
  private connectOut(node: Voice, o: PlayOptions): Voice {
    if (node.bus === "voice") {
      const meter = this.context.createAnalyser();
      meter.fftSize = 1024;
      node.gain.connect(meter);
      node.meter = meter;
      node.tail = meter;
    }
    if (o.filter) {
      const stage = new FilterStage(this.context);
      node.tail.connect(stage.input);
      stage.output.connect(this.master[node.bus]);
      stage.set(o.filter, 0);
      node.filter = stage;
    } else node.tail.connect(this.master[node.bus]);
    return node;
  }

  /**
   * 流し読みで鳴らす（流し読みにしない曲・鳴らせなかったときは null）。ループの位置は start と同じ順に決める
   * （埋め込みのタグは頭を読んだときに読む）。
   */
  private async startStream(url: string, folder: AudioFolder, file: string, volume: number, loop: boolean, fadeMs: number, o: PlayOptions): Promise<Voice | null> {
    if (!this.streaming) return null;
    let probe: Probe;
    try {
      probe = await this.probe(url);
    } catch {
      return null;
    }
    if (!this.streams(probe)) return null;
    let source: StreamSource;
    try {
      source = new StreamSource(this.context, url);
    } catch {
      return null;
    }
    const tags = this.knownLoop?.(folder, file) ?? probe.tags ?? undefined;
    source.loop = loop;
    const loopStart = o.loopStart ?? tags?.start;
    const loopEnd = o.loopEnd ?? tags?.end;
    if (loop && loopStart !== undefined) source.loopStart = loopStart;
    if (loop && loopEnd !== undefined && loopEnd > (loopStart ?? 0)) source.loopEnd = loopEnd;
    if (o.rate !== undefined && o.rate > 0) source.playbackRate.value = o.rate;
    const { input, gain } = this.chain(volume, fadeMs, o);
    source.connect(input);
    const node = this.connectOut({ source, input, gain, bus: "bgm", tail: gain }, o);
    try {
      await source.play(Math.max(0, o.offset ?? 0));
    } catch (e) {
      // 鳴らせない（自動再生の制限、形式など）。この曲は次から展開して鳴らす
      console.info(`BGM をストリーミング再生できないため、デコードして再生します: ${file}`, e);
      source.stop();
      node.tail.disconnect();
      node.filter?.output.disconnect();
      this.probes.set(url, Promise.resolve({ ranged: false, total: probe.total, tags: probe.tags }));
      return null;
    }
    // ループの区間の頭は、曲の長さが分かってから確かめる
    if (source.loopStart >= source.duration && source.duration > 0) source.loopStart = 0;
    if (fadeMs > 0) {
      // 読み込みを待った分、フェードを今から掛け直す
      const now = this.context.currentTime;
      const target = Math.max(0, Math.min(1, volume / 100));
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(target, now + fadeMs / 1000);
    }
    return node;
  }

  /** 流し読みにするか（頭だけ範囲を指定して読み、全体の大きさを見る）。範囲の指定に答えなければ、届いた全部を展開に回す。 */
  private probe(url: string): Promise<Probe> {
    let p = this.probes.get(url);
    if (!p) {
      p = fetch(url, { headers: { Range: `bytes=0-${PROBE_BYTES - 1}` } }).then(async (r): Promise<Probe> => {
        if (r.status === 206) {
          const total = Number(/\/(\d+)\s*$/.exec(r.headers.get("content-range") ?? "")?.[1] ?? 0);
          return { ranged: true, total, tags: readLoopTags(await r.arrayBuffer()) };
        }
        if (!r.ok) throw new Error(`${r.status} ${r.url}`);
        const data = await r.arrayBuffer();
        return { ranged: false, total: data.byteLength, tags: null, data };
      });
      this.probes.set(url, p);
      p.catch(() => this.probes.delete(url));
    }
    return p;
  }

  /** 流し読みにするか（範囲の指定に答える所にあり、streamBytes より大きい）。 */
  private streams(p: Probe): boolean {
    return this.streaming && p.ranged && p.total > this.streamBytes;
  }

  /** 鳴らすときのつなぎ（定位と音量・フェード）。 */
  private chain(volume: number, fadeMs: number, o: PlayOptions): { input: AudioNode; gain: GainNode } {
    const gain = this.context.createGain();
    const target = Math.max(0, Math.min(1, volume / 100));
    const now = this.context.currentTime;
    if (fadeMs > 0) {
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(target, now + fadeMs / 1000);
    } else {
      gain.gain.setValueAtTime(target, now);
    }
    let input: AudioNode = gain;
    if (o.pan) {
      const panner = this.context.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, o.pan));
      panner.connect(gain);
      input = panner;
    }
    return { input, gain };
  }

  private fadeOutAndStop(node: Voice, fadeMs: number): void {
    const now = this.context.currentTime;
    if (fadeMs > 0) {
      node.gain.gain.cancelScheduledValues(now);
      node.gain.gain.setValueAtTime(node.gain.gain.value, now);
      node.gain.gain.linearRampToValueAtTime(0, now + fadeMs / 1000);
      node.source.stop(now + fadeMs / 1000);
    } else {
      node.source.stop();
    }
  }

  /** 先に読んで復号しておく（失敗は鳴らすときに分かればよいので、ここでは黙る）。流し読みにする BGM は頭だけ読む。 */
  preload(kind: AudioFolder, file: string): void {
    const url = this.url(kind, file);
    if (kind === "bgm" && this.streaming) {
      void this.probe(url).then(
        (p) => (this.streams(p) ? undefined : this.load(url, "bgm")),
        () => undefined,
      ).catch(() => undefined);
      return;
    }
    this.load(url, kind === "bgm" ? "bgm" : kind === "voice" ? "voice" : "sound").catch(() => undefined);
  }

  // ---- 一時停止・音量・終わりを待つ ----

  /** 再生中の音の素性（一時停止した位置を求めるため）。 */
  private readonly playing = new WeakMap<Source, { buffer: AudioBuffer; startedAt: number; offset: number; loop: boolean; rate: number }>();
  private pausedBgm: { file: string; node: Voice; at: number } | null = null;
  private readonly pausedSe = new Map<string, { node: Voice; at: number }>();

  pauseBgm(): void {
    if (!this.bgm) {
      // 読み込んでいる途中なら鳴らさない（戻すときは resumeBgm が false を返し、呼んだ側が鳴らし直す）
      this.bgmToken++;
      this.loadingBgm = null;
      return;
    }
    this.pausedBgm = { file: this.bgm.file, node: this.bgm, at: this.pause(this.bgm.source) };
    this.bgm = null;
  }

  /** 一時停止した BGM の位置（秒）。一時停止していなければ null。 */
  get pausedBgmAt(): number | null {
    return this.pausedBgm?.at ?? null;
  }

  /** 一時停止した BGM がなければ false。 */
  resumeBgm(): boolean {
    const p = this.pausedBgm;
    if (!p) return false;
    this.stopBgm(0);
    this.bgm = { ...p.node, file: p.file, source: this.resume(p.node, p.at) };
    return true;
  }

  /** channel を省くと、鳴っている効果音すべて。 */
  pauseSe(channel?: string): void {
    for (const c of channel === undefined ? [...this.se.keys()] : [channel]) {
      const node = this.se.get(c);
      if (!node) continue;
      this.se.delete(c);
      this.pausedSe.set(c, { node, at: this.pause(node.source) });
    }
  }

  /** 一時停止した効果音を続きから鳴らし、鳴らし直したチャンネルを返す。 */
  resumeSe(channel?: string): string[] {
    const resumed: string[] = [];
    for (const c of channel === undefined ? [...this.pausedSe.keys()] : [channel]) {
      const p = this.pausedSe.get(c);
      if (!p) continue;
      this.stopSe(c, 0);
      resumed.push(c);
      const node: Voice = { ...p.node, source: this.resume(p.node, p.at) };
      this.se.set(c, node);
      node.source.addEventListener("ended", () => {
        if (this.se.get(c) === node) this.se.delete(c);
      });
    }
    return resumed;
  }

  setBgmVolume(volume: number, fadeMs: number): void {
    const node = this.bgm ?? this.pausedBgm?.node;
    if (node) this.ramp(node.gain, volume, fadeMs);
  }

  setSeVolume(channel: string | undefined, volume: number, fadeMs: number): void {
    for (const [c, node] of this.se) if (channel === undefined || c === channel) this.ramp(node.gain, volume, fadeMs);
  }

  /** BGM が鳴り終わるまで待つ。繰り返す BGM と、鳴っていないときはすぐ終わる。 */
  waitBgm(): Promise<void> {
    return this.ended(this.bgm ? [this.bgm.source] : []);
  }

  /** 効果音が鳴り終わるまで待つ。channel を省くと、鳴っているものすべて。 */
  waitSe(channel?: string): Promise<void> {
    return this.ended([...this.se].filter(([c]) => channel === undefined || c === channel).map(([, n]) => n.source));
  }

  private ended(sources: Source[]): Promise<void> {
    const once = sources.filter((s) => !s.loop);
    return Promise.all(once.map((s) => new Promise<void>((resolve) => s.addEventListener("ended", () => resolve(), { once: true })))).then(() => undefined);
  }

  private ramp(gain: GainNode, volume: number, fadeMs: number): void {
    const now = this.context.currentTime;
    const target = Math.max(0, Math.min(1, volume / 100));
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    if (fadeMs > 0) gain.gain.linearRampToValueAtTime(target, now + fadeMs / 1000);
    else gain.gain.setValueAtTime(target, now);
  }

  /** 鳴っている BGM の位置と長さ（秒）。鳴っていなければ null。繰り返さない曲は、鳴り終えると position が duration になる。 */
  bgmProgress(): { position: number; duration: number } | null {
    const node = this.bgm;
    if (node?.source instanceof StreamSource) return { position: node.source.position, duration: node.source.duration };
    const meta = node ? this.playing.get(node.source) : undefined;
    return node && meta ? { position: this.positionOf(node.source), duration: meta.buffer.duration } : null;
  }

  /** 鳴っている BGM を at 秒から鳴らし直す（音楽室のシークバー）。 */
  seekBgm(at: number): void {
    const node = this.bgm;
    if (node?.source instanceof StreamSource) {
      const s = node.source;
      void s.play(Math.max(0, Math.min(at, s.duration - 0.05))).catch((e: unknown) => console.warn("BGM の位置を移せません", e));
      return;
    }
    const meta = node ? this.playing.get(node.source) : undefined;
    if (!node || !meta) return;
    node.source.stop();
    this.bgm = { ...node, source: this.resume(node, Math.max(0, Math.min(at, meta.buffer.duration - 0.05))) };
  }

  /** 止めて、止めた位置（秒）を返す。 */
  private pause(source: Source): number {
    if (source instanceof StreamSource) return source.pause();
    const at = this.positionOf(source);
    source.stop();
    return at;
  }

  /** 今の位置（秒）。ループの区間（loopStart〜loopEnd。0 なら頭と最後）を回った分は戻す。 */
  private positionOf(source: Source): number {
    if (source instanceof StreamSource) return source.position;
    const meta = this.playing.get(source);
    if (!meta) return 0;
    const at = meta.offset + (this.context.currentTime - meta.startedAt) * meta.rate;
    if (!meta.loop) return Math.min(at, meta.buffer.duration);
    const start = source.loopStart;
    const end = source.loopEnd > start ? source.loopEnd : meta.buffer.duration;
    return at < end ? at : start + ((at - start) % (end - start));
  }

  /** 止めた位置から鳴らし直す。音量（gain）は止めたときのまま。 */
  private resume(node: Voice, at: number): Source {
    if (node.source instanceof StreamSource) {
      // 流し読みは同じ <audio> を続きから
      void node.source.play(at).catch(() => undefined);
      return node.source;
    }
    const meta = this.playing.get(node.source)!;
    const source = this.context.createBufferSource();
    source.buffer = meta.buffer;
    source.loop = meta.loop;
    source.loopStart = node.source.loopStart;
    source.loopEnd = node.source.loopEnd;
    source.playbackRate.value = meta.rate;
    source.connect(node.input);
    source.start(0, at);
    this.playing.set(source, { ...meta, startedAt: this.context.currentTime, offset: at });
    return source;
  }

  /** 音の中身を読む（流し読みにするかを見たときに全部届いていれば、それを使って手放す）。 */
  private async fetchWhole(url: string): Promise<ArrayBuffer> {
    const probed = await this.probes.get(url)?.catch(() => null);
    if (probed?.data) {
      const data = probed.data;
      this.probes.set(url, Promise.resolve({ ranged: false, total: probed.total, tags: probed.tags }));
      return data;
    }
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status} ${r.url}`);
    return r.arrayBuffer();
  }

  /** 曲に埋め込まれたループの位置（URL → 秒）。 */
  private readonly loopTags = new Map<string, { start?: number; end?: number }>();

  private load(url: string, bus: Bus): Promise<AudioBuffer> {
    return this.buffers[bus].get(url, () =>
      this.fetchWhole(url)
        .then((data) => {
          // 復号すると元のデータは使えなくなるので、先にループの位置を読む
          const tags = readLoopTags(data);
          if (tags) this.loopTags.set(url, tags);
          return this.context.decodeAudioData(data);
        }),
    );
  }
}

/** 展開した音の大きさ（バイト。標本の数 × 声部 × 4）。 */
function bufferBytes(b: AudioBuffer): number {
  return b.length * b.numberOfChannels * 4;
}

/** 音の長さ（秒。流し読みは読めた長さ）。 */
function durationOf(source: Source): number {
  return source instanceof StreamSource ? source.duration : (source.buffer?.duration ?? 0);
}

/** @bgm・@se のパラメータ（ループの位置はミリ秒、pan は -100〜100）を、AudioPlayer の鳴らし方（秒、-1〜1）にする。 */
export function playOptions(a: Record<string, Value>): PlayOptions {
  const filter = argFilter(a);
  return {
    ...stageSound({
      ...(typeof a["loop-start"] === "number" ? { loopStart: a["loop-start"] } : {}),
      ...(typeof a["loop-end"] === "number" ? { loopEnd: a["loop-end"] } : {}),
      ...(typeof a.pan === "number" ? { pan: a.pan } : {}),
      ...(typeof a.rate === "number" ? { rate: a.rate } : {}),
    }),
    ...(filter ? { filter } : {}),
    ...(typeof a["filter-fade"] === "number" ? { filterFadeMs: a["filter-fade"] } : {}),
  };
}

/** 命令の filter・filter-strength を、掛けるフィルターにする（none・書いていないなら null）。 */
export function argFilter(a: Record<string, Value>): SoundFilter | null {
  return typeof a.filter === "string" ? soundFilter({ type: a.filter, strength: typeof a["filter-strength"] === "number" ? a["filter-strength"] : 100 }) : null;
}

/** 状態に残した鳴らし方（SoundOptions）を、AudioPlayer の鳴らし方にする。 */
export function stageSound(o: SoundOptions): PlayOptions {
  const out: PlayOptions = {};
  if (o.loopStart !== undefined) out.loopStart = o.loopStart / 1000;
  if (o.loopEnd !== undefined) out.loopEnd = o.loopEnd / 1000;
  if (o.pan) out.pan = o.pan / 100;
  if (o.rate !== undefined && o.rate !== 1) out.rate = o.rate;
  const filter = soundFilter(o.filter);
  if (filter) out.filter = filter;
  return out;
}
