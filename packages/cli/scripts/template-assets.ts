/**
 * ひな形（templates/default）の音の素材（WAV）を、外部の道具なしでこのスクリプトだけで合成する。
 * 背景と立ち絵は描いた絵（WebP）をリポジトリに置いてあり、このスクリプトでは作らない。
 * 乱数は固定のシードなので、何度動かしても同じファイルになる。
 *
 *   npm run template:assets
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const OUT = resolve(import.meta.dirname, "../../../templates/default/assets");

// ---- 乱数 ----

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- WAV ----

const RATE = 22050;

function encodeWav(samples: Float32Array): Buffer {
  const peak = samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
  const gain = 0.7 / peak;
  const body = Buffer.alloc(samples.length * 2);
  const fade = Math.floor(RATE * 0.005);
  for (let i = 0; i < samples.length; i++) {
    const edge = Math.min(1, i / fade, (samples.length - 1 - i) / fade);
    body.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i]! * gain * edge)) * 32767), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(36 + body.length, 4);
  head.write("WAVEfmt ", 8, "ascii");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36, "ascii");
  head.writeUInt32LE(body.length, 40);
  return Buffer.concat([head, body]);
}

const midi = (n: number) => 440 * 2 ** ((n - 69) / 12);

/** 繰り返したときにつなぎ目が出ないよう、はみ出した分を頭に足し込む。 */
function addLooped(buf: Float32Array, start: number, voice: (t: number) => number, seconds: number): void {
  const n = Math.floor(seconds * RATE);
  for (let i = 0; i < n; i++) buf[(start + i) % buf.length]! += voice(i / RATE);
}

/** 静かな夜の BGM。4 小節の和音を、柔らかい持続音と分散和音で鳴らす（8 秒で一周）。 */
function bgm(): Float32Array {
  const bar = 2;
  const buf = new Float32Array(RATE * bar * 4);
  const chords = [
    [53, 57, 60, 64],
    [52, 55, 59, 62],
    [50, 53, 57, 60],
    [48, 52, 55, 59],
  ];
  chords.forEach((notes, i) => {
    const at = Math.floor(i * bar * RATE);
    for (const n of notes) {
      const f = midi(n);
      addLooped(buf, at, (t) => {
        const env = Math.min(1, t / 0.6) * Math.min(1, Math.max(0, (bar + 0.6 - t) / 0.8));
        return env * 0.05 * (Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(4 * Math.PI * f * t + 0.3));
      }, bar + 0.6);
    }
    const arp = [notes[0]! + 12, notes[1]! + 12, notes[2]! + 12, notes[3]! + 12, notes[2]! + 12, notes[1]! + 12, notes[2]! + 12, notes[3]! + 12];
    arp.forEach((n, k) => {
      const f = midi(n);
      addLooped(buf, at + Math.floor((k * bar * RATE) / arp.length), (t) => Math.min(1, t / 0.004) * Math.exp(-t * 3.2) * 0.07 * (Math.sin(2 * Math.PI * f * t) + 0.15 * Math.sin(6 * Math.PI * f * t)), 1.6);
    });
  });
  return buf;
}

/** 小さな鐘。整数倍でない倍音で金属らしくする。 */
function chime(): Float32Array {
  const buf = new Float32Array(Math.floor(RATE * 1.6));
  const f = midi(84);
  for (let i = 0; i < buf.length; i++) {
    const t = i / RATE;
    buf[i] = Math.min(1, t / 0.002) * (Math.exp(-t * 2.5) * Math.sin(2 * Math.PI * f * t) + 0.5 * Math.exp(-t * 4) * Math.sin(2 * Math.PI * f * 2.76 * t) + 0.25 * Math.exp(-t * 7) * Math.sin(2 * Math.PI * f * 5.4 * t));
  }
  return buf;
}

/** 古いラジオの雑音と、選局で動く音程。 */
function radio(): Float32Array {
  const r = rng(11);
  const buf = new Float32Array(Math.floor(RATE * 1.2));
  let low = 0;
  let phase = 0;
  for (let i = 0; i < buf.length; i++) {
    const t = i / RATE;
    low += 0.25 * (r() * 2 - 1 - low);
    phase += (2 * Math.PI * (600 + 500 * Math.sin(t * 3.1))) / RATE;
    const env = Math.min(1, t / 0.05) * Math.min(1, (1.2 - t) / 0.3);
    buf[i] = env * ((0.6 + 0.4 * Math.sin(t * 37)) * low + 0.12 * Math.sin(phase));
  }
  return buf;
}

/** 突風が戸を鳴らす音。こもった雑音のうねりに、二度の鈍い当たり。 */
function gust(): Float32Array {
  const r = rng(23);
  const buf = new Float32Array(Math.floor(RATE * 1.4));
  let low = 0;
  for (let i = 0; i < buf.length; i++) {
    const t = i / RATE;
    low += 0.06 * (r() * 2 - 1 - low);
    const swell = Math.sin(Math.PI * Math.min(1, t / 1.4)) ** 2;
    let knock = 0;
    for (const at of [0.42, 0.58]) if (t >= at) knock += Math.exp(-(t - at) * 30) * Math.sin(2 * Math.PI * 95 * (t - at));
    buf[i] = swell * low * 2.2 + knock * 0.8;
  }
  return buf;
}

// ---- 書き出し ----

function write(rel: string, data: Buffer): void {
  const file = join(OUT, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  console.log(`${rel}  ${(data.length / 1024).toFixed(1)} KB`);
}

write("bgm/quiet_night.wav", encodeWav(bgm()));
write("sound/chime.wav", encodeWav(chime()));
write("sound/radio.wav", encodeWav(radio()));
write("sound/gust.wav", encodeWav(gust()));
