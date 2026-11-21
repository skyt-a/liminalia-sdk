import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assetCopyReport, copyAssetFolders, copyAssets } from "../src/asset-copy.ts";

let work: string;
let source: string;
let assets: string;
const put = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "liminalia-asset-copy-"));
  source = join(work, "tyrano");
  assets = join(work, "game", "assets");
  put(join(source, "data/bgimage/room.jpg"), "room");
  put(join(source, "data/bgimage/sub/night.png"), "night");
  put(join(source, "data/bgimage/.DS_Store"), "x");
  put(join(source, "data/bgimage/notes.psd"), "psd");
  put(join(source, "data/bgm/main.ogg"), "music");
  put(join(work, "secret.png"), "outside");
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

describe("ほかのエンジンの作品から素材を写す", () => {
  it("フォルダの中身を同じ形で写し、素材の種類でないものと . で始まるものは写さない", () => {
    const r = copyAssetFolders(source, assets, { "data/bgimage": "bgimage", "data/bgm": "bgm" });
    expect(r.copied.sort()).toEqual(["bgimage/room.jpg", "bgimage/sub/night.png", "bgm/main.ogg"]);
    expect(r.skipped).toEqual(["data/bgimage/notes.psd"]);
    expect(readFileSync(join(assets, "bgimage/sub/night.png"), "utf8")).toBe("night");
    expect(existsSync(join(assets, "bgimage/.DS_Store"))).toBe(false);
  });

  it("写す先にあるものは上書きしない（大きさが同じなら同じもの、違えば残したものに数える）", () => {
    put(join(assets, "bgimage/room.jpg"), "mine, edited");
    put(join(assets, "bgm/main.ogg"), "MUSIC");
    const r = copyAssetFolders(source, assets, { "data/bgimage": "bgimage", "data/bgm": "bgm" });
    expect(r.kept).toEqual(["bgimage/room.jpg"]);
    expect(r.same).toBe(1);
    expect(readFileSync(join(assets, "bgimage/room.jpg"), "utf8")).toBe("mine, edited");
    expect(assetCopyReport(r)).toContain("上書きしなかった素材");
  });

  it("取り込み元の外を指すリンクと、素材のフォルダの外へ出る名前は写さない。無いものは数える", () => {
    symlinkSync(join(work, "secret.png"), join(source, "data/bgimage/link.png"));
    const r = copyAssets(source, assets, [
      { from: "data/bgimage/link.png", to: "bgimage/link.png" },
      { from: "data/bgimage/room.jpg", to: "../escape.jpg" },
      { from: "data/bgimage/none.png", to: "bgimage/none.png" },
    ]);
    expect(r.outside).toEqual(["data/bgimage/link.png", "data/bgimage/room.jpg"]);
    expect(r.missing).toEqual(["data/bgimage/none.png"]);
    expect(existsSync(join(assets, "bgimage/link.png"))).toBe(false);
    expect(existsSync(join(work, "game", "escape.jpg"))).toBe(false);
  });

  it("報告に名前の対応表を出す", () => {
    const r = copyAssets(source, assets, [{ from: "data/bgimage/room.jpg", to: "bgimage/bg room.jpg" }]);
    const md = assetCopyReport(r, [{ name: "bg room", to: "bgimage/bg room.jpg" }]);
    expect(md).toContain("| bg room | bgimage/bg room.jpg |");
    expect(md).toContain("素材 1 件を写しました");
  });
});
