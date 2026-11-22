import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { imageSize, readLoopTags } from "@liminalia/lang";
import { compressAssets } from "../src/compress.ts";

const has = (cmd: string) => {
  try {
    execFileSync(cmd, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default/assets");
/** ひな形の絵はもう WebP なので、縮める対象の PNG を一枚足す。 */
const addPng = (assets: string) =>
  execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x6e56cf:s=640x360", "-frames:v", "1", join(assets, "bgimage/plain.png")]);

describe.skipIf(!has("ffmpeg") || !has("cwebp"))("スマホ版の素材を縮める（build.mobile）", () => {
  const work = mkdtempSync(join(tmpdir(), "liminalia-compress-"));
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it("音は AAC、画像は WebP にして名前の表を返し、二度目は控えを使う", async () => {
    const assets = join(work, "assets");
    cpSync(TEMPLATE, assets, { recursive: true });
    addPng(assets);
    const cache = join(work, "cache");
    const r = await compressAssets(assets, { audio: { bitrate: "48k" }, images: { quality: 60 } }, cache);
    expect(r.audio.files).toBeGreaterThan(0);
    expect(r.images.files).toBeGreaterThan(0);
    expect(r.audio.after).toBeLessThan(r.audio.before);
    expect(r.renamed["bgm/quiet_night.wav"]).toBe("bgm/quiet_night.m4a");
    expect(existsSync(join(assets, "bgm/quiet_night.m4a"))).toBe(true);
    expect(existsSync(join(assets, "bgm/quiet_night.wav"))).toBe(false);
    for (const [from, to] of Object.entries(r.renamed)) {
      expect(existsSync(join(assets, to)), to).toBe(true);
      expect(existsSync(join(assets, from)), from).toBe(false);
    }
    // 控えから作り直す（同じ結果）
    const again = join(work, "again");
    cpSync(TEMPLATE, again, { recursive: true });
    addPng(again);
    const started = Date.now();
    const r2 = await compressAssets(again, { audio: { bitrate: "48k" }, images: { quality: 60 } }, cache);
    expect(r2.renamed).toEqual(r.renamed);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 120_000);

  it("images.scale は背景と立ち絵（WebP も）の縦横を縮め、元の大きさを返す。部品の画像は既定では縮めない", async () => {
    const assets = join(work, "scaled");
    cpSync(TEMPLATE, assets, { recursive: true });
    addPng(assets);
    mkdirSync(join(assets, "image"), { recursive: true });
    execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x123456:s=200x100", "-frames:v", "1", join(assets, "image/frame.png")]);
    const r = await compressAssets(assets, { images: { quality: 80, scale: 0.5 } }, join(work, "cache-scaled"));
    expect(r.scaled["bgimage/hill_dusk.webp"]).toEqual([1280, 720, 640, 360]);
    expect(r.scaled["fgimage/akari/normal.webp"]).toEqual([600, 900, 300, 450]);
    expect(r.scaled["bgimage/plain.png"]).toEqual([640, 360, 320, 180]);
    expect(r.renamed["bgimage/plain.png"]).toBe("bgimage/plain.webp");
    expect(imageSize(readFileSync(join(assets, "fgimage/akari/normal.webp")))).toEqual({ width: 300, height: 450 });
    // 部品の画像は WebP にするが、解像度はそのまま
    expect(r.scaled["image/frame.png"]).toBeUndefined();
    expect(imageSize(readFileSync(join(assets, "image/frame.webp")))).toEqual({ width: 200, height: 100 });
    await expect(compressAssets(assets, { images: { scale: 2 } }, join(work, "cache-scaled"))).rejects.toThrow("images.scale");
  }, 120_000);
});

/** 44100Hz の OGG（Vorbis）に LOOPSTART=44100（1 秒）・LOOPLENGTH=66150（1.5 秒）を埋め込んだ BGM を作る（縮めると小さくなるよう雑音で）。 */
const loopOgg = (path: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "anoisesrc=d=4:c=pink:r=44100:a=0.3", "-ac", "2", "-c:a", "vorbis", "-strict", "-2", "-q:a", "8", "-metadata", "LOOPSTART=44100", "-metadata", "LOOPLENGTH=66150", path]);
};
const tagsOf = (path: string) => {
  const b = readFileSync(path);
  return readLoopTags(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};

describe.skipIf(!has("ffmpeg"))("縮めてもループの位置を保つ", () => {
  const work = mkdtempSync(join(tmpdir(), "liminalia-compress-loop-"));
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it("AAC（.m4a）ではタグが消えるので、元の音から読んだ秒を loops に返す", async () => {
    const assets = join(work, "m4a");
    loopOgg(join(assets, "bgm/theme.ogg"));
    expect(tagsOf(join(assets, "bgm/theme.ogg"))).toEqual({ start: 1, end: 2.5 });
    const r = await compressAssets(assets, { audio: { bitrate: "32k" } }, join(work, "cache"));
    expect(r.renamed).toEqual({ "bgm/theme.ogg": "bgm/theme.m4a" });
    expect(tagsOf(join(assets, "bgm/theme.m4a"))).toBeNull();
    expect(r.loops).toEqual({ "bgm/theme.ogg": { start: 1, end: 2.5 } });
  }, 60_000);

  it("Opus では 48000 の標本の数に数え直したタグを書く（そのままだと 44100 の数を 48000 で読んでずれる）", async () => {
    const assets = join(work, "opus");
    loopOgg(join(assets, "bgm/theme.ogg"));
    const r = await compressAssets(assets, { audio: { format: "opus", bitrate: "24k" } }, join(work, "cache"));
    expect(r.renamed).toEqual({});
    expect(r.loops).toEqual({ "bgm/theme.ogg": { start: 1, end: 2.5 } });
    expect(tagsOf(join(assets, "bgm/theme.ogg"))).toEqual({ start: 1, end: 2.5 });
  }, 60_000);
});
