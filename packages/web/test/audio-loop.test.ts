import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { playOptions, readLoopTags, stageSound } from "../src/audio.ts";

const fixture = (name: string) => {
  const b = readFileSync(resolve(import.meta.dirname, "fixtures", name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

describe("BGM のループの位置", () => {
  it("OGG に埋め込まれた LOOPSTART・LOOPLENGTH・LOOPEND を秒で読む（Vorbis は識別のヘッダーの速さ、Opus は 48000）", () => {
    // 44100Hz で LOOPSTART=44100（1 秒）、LOOPLENGTH=66150（1.5 秒）→ 1〜2.5 秒
    expect(readLoopTags(fixture("loop-vorbis.ogg"))).toEqual({ start: 1, end: 2.5 });
    // Opus は 48000 で LOOPSTART=24000（0.5 秒）、LOOPEND=96000（2 秒）
    expect(readLoopTags(fixture("loop-opus.ogg"))).toEqual({ start: 0.5, end: 2 });
    expect(readLoopTags(new TextEncoder().encode("no tags here").buffer)).toBeNull();
  });

  it("@bgm のパラメータ（ミリ秒、-100〜100）を鳴らし方（秒、-1〜1）にする。書いていないものは入れない", () => {
    expect(playOptions({ "loop-start": 12500, "loop-end": 60000, pan: -50, rate: 1.5 })).toEqual({ loopStart: 12.5, loopEnd: 60, pan: -0.5, rate: 1.5 });
    expect(playOptions({ pan: 0, rate: 1 })).toEqual({});
    expect(stageSound({ loopStart: 1000 })).toEqual({ loopStart: 1 });
  });
});
