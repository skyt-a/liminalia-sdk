/**
 * 音のフィルター（@bgm・@se・@voice の filter、@voice-filter）。こもった音（muffled。壁の向こう・水の中）、電話越し（phone）、
 * 無線・ラジオ（radio）、広間の響き（hall）。強さ（0〜100）で元の音と混ぜ、フェードで切り替える。
 * つなぎ: input → dry → output と input → （フィルターの段）→ wet → output。強さとフェードは dry と wet の音量で決める。
 */

export const SOUND_FILTERS = ["muffled", "phone", "radio", "hall"] as const;
export type SoundFilterType = (typeof SOUND_FILTERS)[number];

/** 掛けるフィルター（strength は 0〜100）。 */
export interface SoundFilter {
  type: SoundFilterType;
  strength: number;
}

/** 状態に残した値（{ type, strength }）を、掛けるフィルターにする（none・知らない種類・強さ 0 は null）。 */
export function soundFilter(v: unknown): SoundFilter | null {
  if (!v || typeof v !== "object") return null;
  const o = v as { type?: unknown; strength?: unknown };
  if (typeof o.type !== "string" || !(SOUND_FILTERS as readonly string[]).includes(o.type)) return null;
  const strength = typeof o.strength === "number" && Number.isFinite(o.strength) ? Math.max(0, Math.min(100, o.strength)) : 100;
  return strength === 0 ? null : { type: o.type as SoundFilterType, strength };
}

/** 広間の響きの残響（AudioContext ごとに一つ作って使い回す）。 */
const halls = new WeakMap<BaseAudioContext, AudioBuffer>();

function hallImpulse(context: BaseAudioContext): AudioBuffer {
  let buffer = halls.get(context);
  if (buffer) return buffer;
  const seconds = 2.4;
  const length = Math.floor(context.sampleRate * seconds);
  buffer = context.createBuffer(2, length, context.sampleRate);
  // 決まった種から作る雑音（毎回同じ響きにする）
  let seed = 0x2f6b1d3;
  const noise = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000 - 0.5;
  };
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) data[i] = noise() * 2 * Math.pow(1 - i / length, 2.6);
  }
  halls.set(context, buffer);
  return buffer;
}

/** 歪み（電話・無線の割れ）。amount は 0〜1。 */
function distortion(context: BaseAudioContext, amount: number): WaveShaperNode {
  const shaper = context.createWaveShaper();
  const n = 1024;
  const curve = new Float32Array(n);
  const k = amount * 40;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  shaper.curve = curve;
  shaper.oversample = "2x";
  return shaper;
}

function biquad(context: BaseAudioContext, type: BiquadFilterType, frequency: number, q = 0.707, gain = 0): BiquadFilterNode {
  const f = context.createBiquadFilter();
  f.type = type;
  f.frequency.value = frequency;
  f.Q.value = q;
  f.gain.value = gain;
  return f;
}

/** フィルターの段（入口と出口）。 */
function buildChain(context: BaseAudioContext, type: SoundFilterType): { first: AudioNode; last: AudioNode } {
  const nodes: AudioNode[] = [];
  switch (type) {
    case "muffled":
      nodes.push(biquad(context, "lowpass", 650, 0.9), biquad(context, "lowpass", 1200, 0.5));
      break;
    case "phone":
      nodes.push(biquad(context, "highpass", 380, 0.9), biquad(context, "lowpass", 3200, 0.9), biquad(context, "peaking", 1600, 1.2, 6), distortion(context, 0.15));
      break;
    case "radio":
      nodes.push(biquad(context, "highpass", 600, 1.1), biquad(context, "lowpass", 2600, 1.1), biquad(context, "peaking", 1300, 1.4, 8), distortion(context, 0.45));
      break;
    case "hall": {
      const convolver = context.createConvolver();
      convolver.buffer = hallImpulse(context);
      nodes.push(biquad(context, "highpass", 180, 0.7), convolver);
      break;
    }
  }
  for (let i = 0; i < nodes.length - 1; i++) nodes[i]!.connect(nodes[i + 1]!);
  return { first: nodes[0]!, last: nodes.at(-1)! };
}

/** 強さから dry（元の音）と wet（フィルターを通した音）の音量。広間は元の音を残して響きを足す。 */
function levels(filter: SoundFilter | null): { dry: number; wet: number } {
  if (!filter) return { dry: 1, wet: 0 };
  const s = filter.strength / 100;
  if (filter.type === "hall") return { dry: 1 - 0.35 * s, wet: 0.9 * s };
  // 電話・無線は帯域を絞るぶん小さく聞こえるので少し持ち上げる
  const boost = filter.type === "muffled" ? 1.15 : 1.3;
  return { dry: 1 - s, wet: s * boost };
}

/** 一つの音（BGM・効果音のチャンネル・ボイス）に掛けるフィルター。 */
export class FilterStage {
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly dry: GainNode;
  private wet: { type: SoundFilterType; gain: GainNode; first: AudioNode } | null = null;
  private current: SoundFilter | null = null;

  constructor(private readonly context: BaseAudioContext) {
    this.input = context.createGain();
    this.output = context.createGain();
    this.dry = context.createGain();
    this.input.connect(this.dry).connect(this.output);
  }

  /** 今掛けているフィルター（無ければ null）。 */
  get filter(): SoundFilter | null {
    return this.current;
  }

  /** フィルターを替える（null は外す）。fadeMs かけて移る。 */
  set(filter: SoundFilter | null, fadeMs: number): void {
    const now = this.context.currentTime;
    const end = now + Math.max(0, fadeMs) / 1000;
    const ramp = (param: AudioParam, to: number) => {
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
      if (fadeMs > 0) param.linearRampToValueAtTime(to, end);
      else param.setValueAtTime(to, now);
    };
    const { dry, wet } = levels(filter);
    // 種類が変わったら新しい段を作り、前の段は消してから外す
    if (this.wet && (!filter || filter.type !== this.wet.type)) {
      const old = this.wet;
      ramp(old.gain.gain, 0);
      this.wet = null;
      setTimeout(() => {
        try {
          this.input.disconnect(old.first);
        } catch {
          // もう外れている
        }
        old.gain.disconnect();
      }, fadeMs + 100);
    }
    if (filter && !this.wet) {
      const { first, last } = buildChain(this.context, filter.type);
      const gain = this.context.createGain();
      gain.gain.setValueAtTime(0, now);
      this.input.connect(first);
      last.connect(gain).connect(this.output);
      this.wet = { type: filter.type, gain, first };
    }
    if (this.wet) ramp(this.wet.gain.gain, wet);
    ramp(this.dry.gain, dry);
    this.current = filter;
  }
}
