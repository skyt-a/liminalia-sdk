import { describe, expect, it } from "vitest";
import { definition, documentSymbols, hover } from "../src/features.ts";
import { blockAt, optionSite, tokenize } from "@liminalia/lang/line-syntax";
import { fixture, start } from "./helpers.ts";

const markdown = (h: Awaited<ReturnType<typeof hover>>) => (h && typeof h.contents === "object" && "value" in h.contents ? h.contents.value : "");

describe("説明", () => {
  it("命令の名前に要約・例・引数の表", async () => {
    const { project, pos } = await start("@b‸g room_night.jpg");
    const h = hover(project, "start", pos);
    expect(markdown(h)).toContain("**@bg** — 背景を切り替える");
    expect(markdown(h)).toContain("| image（名前なし 1） | 素材（bgimage） | color が無ければ必須 | 背景画像（単色にするなら代わりに color を書く） |");
    expect(h?.range).toEqual({ start: { line: 0, character: 0 }, end: { line: 0, character: 3 } });
  });

  it("key= に引数の説明", async () => {
    const { project, pos } = await start("@bg room_night.jpg ti‸me=1s");
    expect(markdown(hover(project, "start", pos))).toBe("**time**= — 時間\n\n切り替えにかける時間\n\n既定値 `0ms`");
  });

  it("前の名前の fade= と名前なしの時間にも、今の名前（time）の説明を出す（2026-11-19 の L12）", async () => {
    for (const text of ["@bg room_night.jpg fa‸de=1s", "@mask 60‸0ms", "@stop-se 1‸s"]) {
      const { project, pos } = await start(text);
      expect(markdown(hover(project, "start", pos)), text).toMatch(/^\*\*time\*\*/);
    }
  });

  it("位置引数にも", async () => {
    const { project, pos } = await start("@chara ユイカ sm‸ile");
    expect(markdown(hover(project, "start", pos))).toContain("**variant**（名前なしのパラメータ 2） — 差分名");
  });

  it("制御の命令・部品・プラグインの命令・選択肢の引数", async () => {
    const cases: [string, string][] = [
      ["@ju‸mp common", "**@jump** — ジャンプする"],
      ["@use common\n@title-ca‸rd text=始まり", "@define title-card(text: string, time: duration)"],
      ["@gli‸nt", "**@glint** — 画面を一瞬光らせる"],
      ["@choice\n- 行く -> #a i‸f=(game.trust > 1)\n@end", "**if**= — 条件（式）"],
      ["ユイ「待って{@ch‸ara ユイカ smile}」", "**@chara** — 立ち絵を表示する、または差し替える"],
    ];
    for (const [text, expected] of cases) {
      const { project, pos } = await start(text);
      expect(markdown(hover(project, "start", pos))).toContain(expected);
    }
  });

  it("英語の表示（VS Code の表示言語が日本語でないとき）は英語の説明。英語の無いプラグインのコマンドは日本語", async () => {
    const at = async (text: string) => {
      const { project, pos } = await start(text);
      return markdown(hover(project, "start", pos, "en"));
    };
    const bg = await at("@b‸g room_night.jpg");
    expect(bg).toContain("**@bg** — Change the background");
    expect(bg).toContain("| image (unnamed 1) | Asset (bgimage) | Required unless color | Background image (write color instead for a solid color) |");
    expect(await at("@bg room_night.jpg ti‸me=1s")).toBe("**time**= — Duration\n\nTransition time\n\nDefault `0ms`");
    expect(await at("@chara ユイカ sm‸ile")).toContain("**variant** (unnamed parameter 2) — Variant name");
    expect(await at("@ju‸mp common")).toContain("**@jump** — Jump (`#label`, `file` or `file#label`)");
    expect(await at("@choice\n- 行く -> #a i‸f=(game.trust > 1)\n@end")).toContain("**if**= — Condition (expression)\n\nCondition for showing it");
    expect(await at("@gli‸nt")).toContain("**@glint** — 画面を一瞬光らせる");
    // 例は英語の例（exampleEn）。英語の例が無いコマンドは例のまま
    expect(await at("@chara-hi‸de ユイカ")).toContain("```lim\n@chara-hide Akari time=300ms\n```");
    expect(bg).toContain("```lim\n@bg room_night.jpg time=1s pattern=wipe-right\n```");
    const { project, pos } = await start("@chara-hi‸de ユイカ");
    expect(markdown(hover(project, "start", pos))).toContain("```lim\n@chara-hide ユイカ time=300ms\n```");
  });

  it("本文には出さない", async () => {
    const { project, pos } = await start("ユイ「おは‸よう」");
    expect(hover(project, "start", pos)).toBeNull();
  });
});

describe("定義へ移動", () => {
  it("同じファイルのラベル", async () => {
    const { project, pos } = await start("# start\n\n# north_road\n@jump #nor‸th_road");
    const loc = definition(project, "start", pos);
    expect(loc?.uri).toMatch(/scenario\/start\.lim$/);
    expect(loc?.range.start.line).toBe(2);
  });

  it("別のファイルのラベルとファイル", async () => {
    const a = await start("@call common#inter‸lude");
    const loc = definition(a.project, "start", a.pos);
    expect(loc?.uri).toMatch(/scenario\/common\.lim$/);
    expect(loc?.range.start.line).toBe(6);
    const b = await start("@jump chap‸ter2");
    expect(definition(b.project, "start", b.pos)?.uri).toMatch(/scenario\/chapter2\.lim$/);
    expect(definition(b.project, "start", b.pos)?.range.start.line).toBe(0);
  });

  it("選択肢の飛び先", async () => {
    const { project, pos } = await start("@choice\n- 南へ -> chapter2#so‸uth\n@end");
    expect(definition(project, "start", pos)?.uri).toMatch(/chapter2\.lim$/);
  });

  it("@use のファイルと、@use したファイルの部品", async () => {
    const a = await start("@use com‸mon");
    expect(definition(a.project, "start", a.pos)?.uri).toMatch(/common\.lim$/);
    const b = await start("@use common\n@title-c‸ard text=始まり");
    const loc = definition(b.project, "start", b.pos);
    expect(loc?.uri).toMatch(/common\.lim$/);
    expect(loc?.range).toEqual({ start: { line: 1, character: 8 }, end: { line: 1, character: 18 } });
  });

  it("無いラベルは null", async () => {
    const { project, pos } = await start("@jump #nowh‸ere");
    expect(definition(project, "start", pos)).toBeNull();
  });
});

describe("目次", () => {
  it("ラベル（次のラベルまで）と @define", async () => {
    const { project } = await fixture();
    expect(documentSymbols(project, "start").map((s) => [s.name, s.range.start.line, s.range.end.line])).toEqual([
      ["# start", 3, 16],
      ["# north_road", 17, 24],
    ]);
    expect(documentSymbols(project, "common").map((s) => [s.name, s.kind, s.range.start.line, s.range.end.line])).toEqual([
      ["@title-card", 12, 1, 4],
      ["# interlude", 20, 6, 8],
    ]);
  });
});

describe("書きかけの行を読む", () => {
  it("ブロック", () => {
    const lines = ["@choice", "- 行く -> #a", "@end", "@if game.x", "@script", "@if", "@end", "", "@end"];
    expect(blockAt(lines, 1)).toBe("choice");
    expect(blockAt(lines, 3)).toBe("root");
    expect(blockAt(lines, 5)).toBe("script");
    expect(blockAt(lines, 7)).toBe("root");
  });

  it("引数の区切り（\"…\" と (…) の中の空白では区切らない）", () => {
    const line = '@x a "b c" k=(1 + 2) d';
    expect(tokenize(line, 3).map((t) => [t.text, t.key])).toEqual([
      ["a", null],
      ['"b c"', null],
      ["k=(1 + 2)", "k"],
      ["d", null],
    ]);
  });

  it("選択肢の行（文の中の -> は飛び先にしない）", () => {
    const o = optionSite("- A -> B -> #c x=1");
    expect(o?.target.text).toBe("#c");
    expect(o?.args.map((t) => t.text)).toEqual(["x=1"]);
  });
});
