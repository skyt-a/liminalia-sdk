import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkAssetReferences } from "../src/commands/build.ts";
import { imageInfoOf } from "../src/image-info.ts";
import { placeholderPng, silentWav } from "../src/placeholder-assets.ts";
import { loadContext } from "../src/context.ts";

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-build-assets-"));
  cpSync(TEMPLATE, dir, { recursive: true });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const addLine = (line: string) => {
  const start = join(dir, "scenario", "start.lim");
  writeFileSync(start, `${readFileSync(start, "utf8")}\n${line}\n`);
};

describe("lim build の素材の参照", () => {
  it("ひな形の素材はすべて揃っている", async () => {
    const ctx = await loadContext(dir);
    expect(() => checkAssetReferences(ctx)).not.toThrow();
  });

  it("大文字と小文字だけが違う素材の名前で止める（Mac と Windows でファイルが開けても）", async () => {
    addLine("@bg Hill_Dusk.webp");
    const ctx = await loadContext(dir);
    expect(() => checkAssetReferences(ctx)).toThrow(/ファイルの名前と大文字と小文字が違う素材が 1 件あります[\s\S]*hill_dusk\.webp/);
  });

  it("無い素材があれば、無い素材の件数で止め、大文字と小文字の違いも並べる", async () => {
    addLine("@bg Hill_Dusk.webp");
    addLine("@bg no_such_picture.webp");
    const ctx = await loadContext(dir);
    expect(() => checkAssetReferences(ctx)).toThrow(/参照されているのに見つからない素材が 1 件あります[\s\S]*no_such_picture[\s\S]*Hill_Dusk/);
  });

  it("テスト版（placeholders）は、無い画像と音を札と無音にして書き出しに入れ、ほかの種類の無い素材と大文字と小文字の違いでは止める", async () => {
    addLine("@bg no_such_picture.webp");
    addLine("@se missing_sound.ogg");
    const ctx = await loadContext(dir);
    const out = mkdtempSync(join(tmpdir(), "liminalia-placeholders-"));
    try {
      const made = checkAssetReferences(ctx, { placeholders: out });
      expect(made.map((f) => f.rel).sort()).toEqual(["bgimage/no_such_picture.webp", "sound/missing_sound.ogg"]);
      const bg = imageInfoOf(readFileSync(made.find((f) => f.rel.startsWith("bgimage/"))!.file));
      expect(bg).toMatchObject({ width: 1280, height: 720 });
      expect(readFileSync(made.find((f) => f.rel.startsWith("sound/"))!.file).subarray(0, 4).toString()).toBe("RIFF");
      // 札でない種類（動画）が無ければ、テスト版でも止める
      addLine("@movie no_such_movie.mp4");
      const again = await loadContext(dir);
      expect(() => checkAssetReferences(again, { placeholders: out })).toThrow(/no_such_movie/);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("札の画像は PNG（背景は画面の大きさ、立ち絵は人の高さ、画像は 16:9）、無音は短い WAV", () => {
    for (const [folder, w, h] of [["bgimage", 1920, 1080], ["fgimage", 486, 972], ["image", 480, 270]] as const) {
      const png = placeholderPng(folder, "a/b.webp", { width: 1920, height: 1080 });
      expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(imageInfoOf(png)).toMatchObject({ width: w, height: h });
    }
    const wav = silentWav();
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.subarray(8, 12).toString()).toBe("WAVE");
  });
});
