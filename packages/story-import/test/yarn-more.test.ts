import { describe, expect, it } from "vitest";
import { importYarn } from "../src/index.ts";
import { limCheckErrors, play } from "./helpers.ts";

const src = [
  "title: Start",
  "---",
  "<<declare $gold = 5>>",
  "<<once>>",
  "    店主: はじめまして。",
  "<<else>>",
  "    店主: また来たね。",
  "<<endonce>>",
  "<<once if $gold > 3>>",
  "    店主: お金持ちだね。",
  "<<endonce>>",
  "店主: 今日のおすすめは……",
  "=> 店主: りんごだよ。 <<if $gold < 3>>",
  "=> 店主: みかんだよ。 <<once>>",
  "    店主: 甘いよ。",
  "=> 店主: ぶどうだよ。 <<if $gold > 3>>",
  "ひとりごと。 <<once>>",
  "-> 買う <<once>>",
  "    <<set $gold -= 1>>",
  "    <<jump Start>>",
  "-> 帰る",
  "    帰った。",
  "===",
].join("\n");

describe("Yarn Spinner の <<once>> と行のグループ", () => {
  it("<<once>> は一度出したかの変数で、行のグループは出せる行から一つ選ぶ形にする", () => {
    const r = importYarn([{ file: "shop.yarn", text: src }]);
    expect(limCheckErrors(r)).toEqual([]);
    expect(r.totals.manual).toBe(0);
    const text = r.files[0]!.text;
    expect(text).toContain("@if !game.once_Start\n  @set game.once_Start = true\n  店主「はじめまして。」\n@else\n  店主「また来たね。」\n@end");
    expect(text).toContain("@if !game.once_Start_2 && (game.gold > 3)");
    expect(text).toContain("@set temp.yarn_pick = pick(temp.yarn_pick)");
    expect(text).toContain("  - 買う -> #Start-c1 if=(!game.once_Start_5)");
  });

  it("一度目と二度目で出るものが変わり、条件の合わない行は選ばない", async () => {
    const r = importYarn([{ file: "shop.yarn", text: src }]);
    const p = await play(r, "shop", [0, 0]);
    expect(p.diagnostics).toEqual([]);
    // gold 5: りんご（gold < 3）は出ない。一度目はみかんかぶどう
    expect(["店主「みかんだよ。」", "店主「ぶどうだよ。」"]).toContain(p.pages[3]);
    expect(p.pages.slice(0, 3)).toEqual(["店主「はじめまして。」", "店主「お金持ちだね。」", "店主「今日のおすすめは……」"]);
    // 二度目: 挨拶が変わり、ひとりごとと「買う」は出ない
    const again = p.pages.indexOf("店主「また来たね。」");
    expect(again).toBeGreaterThan(0);
    expect(p.pages.filter((x) => x === "ひとりごと。")).toHaveLength(1);
    expect(p.shown).toEqual([["買う", "帰る"], ["帰る"]]);
    expect(p.pages.at(-1)).toBe("帰った。");
  });

  it("条件の無い行のグループは乱数で一つ選ぶ", async () => {
    const r = importYarn([{ file: "g.yarn", text: "title: Start\n---\n=> A\n=> B\n=> C\n===" }]);
    expect(limCheckErrors(r)).toEqual([]);
    expect(r.files[0]!.text).toContain("@set temp.yarn_pick = random(3)");
    const p = await play(r, "g", []);
    expect(p.pages).toHaveLength(1);
    expect(["A", "B", "C"]).toContain(p.pages[0]);
  });
});
