import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { linkedAllowDirs } from "../dev-allow.ts";

describe("開発サーバーが配ってよい場所（素材のリンクの行き先）", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  });
  const temp = () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "liminalia-dev-allow-")));
    temps.push(dir);
    return dir;
  };

  it("素材のフォルダそのものが作品の外へのリンクなら、その本当の場所を足す", () => {
    const outside = temp();
    mkdirSync(join(outside, "bgimage"), { recursive: true });
    const root = temp();
    symlinkSync(outside, join(root, "assets"));
    expect(linkedAllowDirs({ root, assets: join(root, "assets") })).toEqual([outside]);
  });

  it("素材のフォルダの中のリンクの行き先（フォルダとファイル）を足し、ほかの場所は足さない", () => {
    const outside = temp();
    mkdirSync(join(outside, "stills"));
    writeFileSync(join(outside, "logo.png"), "");
    mkdirSync(join(outside, "secret"));
    const root = temp();
    mkdirSync(join(root, "assets", "image"), { recursive: true });
    symlinkSync(join(outside, "stills"), join(root, "assets", "image", "stills"));
    symlinkSync(join(outside, "logo.png"), join(root, "assets", "image", "logo.png"));
    // 壊れたリンクは飛ばす
    symlinkSync(join(outside, "nothing"), join(root, "assets", "image", "gone"));
    // 素材のフォルダの外のリンクは見ない
    symlinkSync(join(outside, "secret"), join(root, "secret"));
    const allowed = linkedAllowDirs({ root, assets: join(root, "assets") }).sort();
    expect(allowed).toEqual([join(outside, "logo.png"), join(outside, "stills")].sort());
  });

  it("リンクの無い作品では何も足さない", () => {
    const root = temp();
    mkdirSync(join(root, "assets", "bgimage"), { recursive: true });
    expect(linkedAllowDirs({ root, assets: join(root, "assets") })).toEqual([]);
  });
});
