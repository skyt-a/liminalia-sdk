import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProject } from "@liminalia/project";
import { DataStore } from "../src/server/data-store.ts";

/** 制作画面から素材を足す口（POST /asset）。ひな形の写しを作業用フォルダに作って使う。 */

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
let dir: string;
let store: DataStore;
const body = Buffer.from("x");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-upload-"));
  cpSync(TEMPLATE, dir, { recursive: true });
  store = new DataStore(loadProject(dir));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("素材を足す", () => {
  it("種類のフォルダに合うファイルを書き、同じ名前は上書きを頼まれたときだけ書く", () => {
    expect(store.upload("bgimage", "new/sky.png", body, false)).toEqual({ ok: true, kind: "bgimage", path: "new/sky.png" });
    expect(existsSync(join(dir, "assets", "bgimage", "new", "sky.png"))).toBe(true);
    expect(store.upload("bgimage", "new/sky.png", Buffer.from("y"), false)).toEqual({ ok: false, exists: true });
    expect(store.upload("bgimage", "new/sky.png", Buffer.from("y"), true).ok).toBe(true);
    expect(readFileSync(join(dir, "assets", "bgimage", "new", "sky.png"), "utf8")).toBe("y");
  });

  it("素材の画面で音・動画として扱う拡張子（.aac .opus .mov .ogv）も足せる", () => {
    expect(store.upload("bgm", "a.aac", body, false).ok).toBe(true);
    expect(store.upload("voice", "yui_001.opus", body, false).ok).toBe(true);
    expect(store.upload("video", "op.mov", body, false).ok).toBe(true);
    expect(store.upload("video", "op.ogv", body, false).ok).toBe(true);
    expect(store.upload("video", "op.vtt", body, false).ok).toBe(true);
  });

  it("種類のフォルダに合わないファイルは、置ける種類を添えて断る", () => {
    expect(() => store.upload("bgimage", "song.mp3", body, false)).toThrow(/bgimage のフォルダには画像（.png .jpg/);
    expect(() => store.upload("fgimage", "a/clip.mp4", body, false)).toThrow(/画像/);
    expect(() => store.upload("bgm", "sky.png", body, false)).toThrow(/bgm のフォルダには音/);
    expect(() => store.upload("video", "theme.ogg", body, false)).toThrow(/動画と字幕/);
    expect(existsSync(join(dir, "assets", "bgimage", "song.mp3"))).toBe(false);
  });

  it("others と、作品が足したフォルダには、素材として足せるものなら何でも置ける", () => {
    expect(store.upload("others", "fonts/main.otf", body, false).ok).toBe(true);
    expect(store.upload("others", "x.png", body, false).ok).toBe(true);
    expect(store.upload("gallery", "x.ogg", body, false).ok).toBe(true);
  });

  it("素材でないファイル・外を指すパス・空のファイルは断る", () => {
    expect(() => store.upload("others", "notes.txt", body, false)).toThrow(/追加できない種類/);
    expect(() => store.upload("bgimage", "../x.png", body, false)).toThrow();
    expect(() => store.upload("../x", "a.png", body, false)).toThrow();
    expect(() => store.upload("bgimage", "a.png", Buffer.alloc(0), false)).toThrow(/空/);
  });
});
