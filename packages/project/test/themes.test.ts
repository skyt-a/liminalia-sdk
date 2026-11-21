import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UI_THEMES } from "@liminalia/lang";
import { copyUiThemeAssets, listUiThemes } from "../src/index.ts";

describe("作品のテーマ", () => {
  const dirs: string[] = [];
  const project = () => {
    const dir = mkdtempSync(join(tmpdir(), "liminalia-themes-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("themes/<id>/theme.json を一覧に足し、同じ名前なら作品のものを使う", () => {
    const dir = project();
    expect(listUiThemes(dir).map((t) => t.id)).toEqual(UI_THEMES.map((t) => t.id));
    for (const [id, name] of [["mine", "自作"], ["washi", "作品の和紙"]] as const) {
      mkdirSync(join(dir, "themes", id), { recursive: true });
      writeFileSync(join(dir, "themes", id, "theme.json"), JSON.stringify({ name, ui: { message: { background: "#123456" } } }));
    }
    const themes = listUiThemes(dir);
    expect(themes.filter((t) => t.id === "washi").map((t) => t.name)).toEqual(["作品の和紙"]);
    expect(themes.find((t) => t.id === "mine")).toMatchObject({ name: "自作", nameEn: "自作", local: true, ui: { message: { background: "#123456" } } });
  });

  it("素材を assets/image/themes/<id>/ へ写す（用意したものも作品のものも）", () => {
    const dir = project();
    const mansion = UI_THEMES.find((t) => t.id === "mansion")!;
    copyUiThemeAssets(dir, mansion);
    expect(readFileSync(join(dir, "assets/image/themes/mansion/frame.svg"), "utf8")).toContain("<svg");
    mkdirSync(join(dir, "themes/mine/assets"), { recursive: true });
    writeFileSync(join(dir, "themes/mine/assets/a.svg"), "<svg/>");
    writeFileSync(join(dir, "themes/mine/theme.json"), "{}");
    copyUiThemeAssets(dir, listUiThemes(dir).find((t) => t.id === "mine")!);
    expect(existsSync(join(dir, "assets/image/themes/mine/a.svg"))).toBe(true);
  });
});
