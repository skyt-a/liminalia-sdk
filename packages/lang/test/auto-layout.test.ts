import { describe, expect, it } from "vitest";
import { assignAutoSlots, autoLayoutName, autoLayoutPosition, autoLayoutRules, autoLayoutSlots, byCountPosition, castSideProblems, checkAutoLayout, shownPositions, type AutoLayoutContext, type AutoSlot } from "../src/index.ts";

interface S {
  at: string;
  autoLayout?: boolean;
  autoSlot?: AutoSlot;
}

/** 実行器の @chara と同じ手順で、人物を出し入れしたあとの並び（左から）を返す。 */
function stage(ctx: AutoLayoutContext) {
  const sprites: Record<string, S> = {};
  const api = {
    enter(who: string, at?: string) {
      sprites[who] = at ? { at } : { at: "center", autoLayout: true };
      if (!at) for (const [name, slot] of assignAutoSlots(Object.entries(sprites), who, ctx)) sprites[name] = { ...sprites[name]!, autoSlot: slot };
      return api;
    },
    leave(who: string) {
      delete sprites[who];
      return api;
    },
    /** 自動配置の人物の枠（"名前@番号/人数"）を左から。 */
    row() {
      const slots = autoLayoutSlots(Object.entries(sprites), ctx);
      return [...slots].sort((a, b) => a[1].index - b[1].index).map(([who, s]) => `${who}@${s.index}/${s.count}`);
    },
  };
  return api;
}

describe("立ち絵の登場順の自動配置の規則", () => {
  it("規則が無ければ、前からの並べ方（登場順に左から、人数で並べ直す）", () => {
    expect(stage({}).enter("A").row()).toEqual(["A@0/1"]);
    expect(stage({}).enter("A").enter("B").enter("C").row()).toEqual(["A@0/3", "B@1/3", "C@2/3"]);
    expect(stage({}).enter("A").enter("B").enter("C").leave("B").row()).toEqual(["A@0/2", "C@1/2"]);
    expect([1, 2, 3].map((count) => Array.from({ length: count }, (_, index) => autoLayoutPosition({ index, count })))).toEqual([["center"], ["left", "right"], ["left", "center", "right"]]);
    expect(autoLayoutPosition({ index: 1, count: 4 })).toBe("auto");
    expect(autoLayoutName({ index: 0, count: 5 })).toBe("left");
    expect(autoLayoutName({ index: 2, count: 5 })).toBe("center");
    expect(autoLayoutName({ index: 1, count: 4 })).toBe("");
  });

  it("人数ごとの立ち位置は、書いた人数だけ替わる", () => {
    const rules = autoLayoutRules({ positions: { "2": ["left", "center"], "4": ["10%", "35%", "65%", "90%"] } })!;
    expect(autoLayoutPosition({ index: 1, count: 2 }, rules)).toBe("center");
    expect(autoLayoutPosition({ index: 2, count: 4 }, rules)).toBe("65%");
    expect(autoLayoutPosition({ index: 2, count: 3 }, rules)).toBe("right");
  });

  it("位置を明示した人物は、規則でその名前の枠を占める", () => {
    const rules = autoLayoutRules({ positions: { "3": ["far-left", "left", "right"] } })!;
    const slots = autoLayoutSlots([["X", { at: "far-left" }], ["A", { at: "center", autoLayout: true }], ["B", { at: "center", autoLayout: true }]], { rules });
    expect([...slots]).toEqual([["A", { index: 1, count: 3 }], ["B", { index: 2, count: 3 }]]);
  });

  it("enter: start は左の端に、middle は真ん中に入れる", () => {
    const start = { rules: autoLayoutRules({ enter: "start" })! };
    expect(stage(start).enter("A").enter("B").enter("C").row()).toEqual(["C@0/3", "B@1/3", "A@2/3"]);
    const middle = { rules: autoLayoutRules({ enter: "middle" })! };
    expect(stage(middle).enter("A").enter("B").enter("C").row()).toEqual(["A@0/3", "C@1/3", "B@2/3"]);
    // 退場で並べ直しても、残った人物の左右の順は変わらない
    expect(stage(start).enter("A").enter("B").enter("C").leave("B").row()).toEqual(["C@0/2", "A@1/2"]);
  });

  it("定位置が left の人物は左に、right の人物は右に寄せる（同じ側どうしは並びの順）", () => {
    const side = (who: string) => (who === "主" ? "left" as const : who === "R" ? "right" as const : undefined);
    expect(stage({ side }).enter("A").enter("主").row()).toEqual(["主@0/2", "A@1/2"]);
    expect(stage({ side }).enter("R").enter("A").enter("主").row()).toEqual(["主@0/3", "A@1/3", "R@2/3"]);
    expect(stage({ side, rules: autoLayoutRules({ enter: "start" })! }).enter("R").enter("A").enter("B").row()).toEqual(["B@0/3", "A@1/3", "R@2/3"]);
  });

  it("exit: keep は退場しても動かさず、空いた枠に次の人物を入れ、空きが無くなってから並べ直す", () => {
    const keep = { rules: autoLayoutRules({ exit: "keep" })! };
    const s = stage(keep).enter("A").enter("B").enter("C").leave("B");
    expect(s.row()).toEqual(["A@0/3", "C@2/3"]);
    expect(s.enter("D").row()).toEqual(["A@0/3", "D@1/3", "C@2/3"]);
    expect(s.enter("E").row()).toEqual(["A@0/4", "D@1/4", "C@2/4", "E@3/4"]);
  });

  it("exit: keep で空きが二つ以上なら、定位置と enter の側に近い空きに入れる", () => {
    const side = (who: string) => (who === "主" ? "left" as const : undefined);
    const rules = autoLayoutRules({ exit: "keep" })!;
    const base = () => stage({ rules, side }).enter("A").enter("B").enter("C").leave("A").leave("C");
    expect(base().enter("主").row()).toEqual(["主@0/3", "B@1/3"]);
    expect(base().enter("D").row()).toEqual(["B@1/3", "D@2/3"]);
    const start = stage({ rules: autoLayoutRules({ exit: "keep", enter: "start" })! }).enter("A").enter("B").enter("C").leave("A").leave("C");
    expect(start.enter("D").row()).toEqual(["D@0/3", "B@1/3"]);
  });

  it("exit: keep でも、位置を明示した人物が来て枠が足りなければ並べ直す", () => {
    const keep = { rules: autoLayoutRules({ exit: "keep" })! };
    const s = stage(keep).enter("A").enter("B").enter("X", "left");
    expect(s.row()).toEqual(["A@1/3", "B@2/3"]);
  });

  it("形の違う規則は読まない（人数と位置の数が合わないもの、知らない値）", () => {
    expect(autoLayoutRules({ positions: { "2": ["left"], x: ["a"] }, enter: "top", exit: "stay" })).toBeUndefined();
    expect(autoLayoutRules([])).toBeUndefined();
  });
});

describe("人数による立ち位置の読み替え（byCount）", () => {
  const rules = autoLayoutRules({ byCount: { "3": { left: "left-wide", right: "right-wide", center: "" }, x: { left: "a" }, "2": "left" } })!;

  it("人数のキーで、空でない名前の読み替えだけを読む", () => {
    expect(rules.byCount).toEqual({ "3": { left: "left-wide", right: "right-wide" } });
  });

  it("ちょうどその人数で、枠に読み替え先があるときだけ読み替える", () => {
    expect(byCountPosition("left", 3, rules)).toBe("left-wide");
    expect(byCountPosition("left", 2, rules)).toBe("left");
    expect(byCountPosition("center", 3, rules)).toBe("center");
    expect(byCountPosition("left", 3, rules, (name) => name !== "left-wide")).toBe("left");
  });

  it("今の立ち位置は、明示した人物を読み替え、自動配置の人物と x を書いた人物は読み替えない", () => {
    const items: [string, { at: string; autoLayout?: boolean; x?: number }][] = [["A", { at: "left" }], ["B", { at: "center", autoLayout: true }], ["C", { at: "right", x: 10 }]];
    expect(Object.fromEntries(shownPositions(items, { rules }))).toEqual({ A: "left-wide", B: "center", C: "right" });
    expect(Object.fromEntries(shownPositions([["A", { at: "left" }], ["C", { at: "right" }], ["D", { at: "center" }]], { rules }, (who) => who !== "C"))).toEqual({ A: "left-wide", C: "right", D: "center" });
  });

  it("形の誤りと、どの枠にも無い読み替え先を知らせる", () => {
    const cast = { A: { appearances: { default: { variants: { normal: { frame: { positions: { "left-wide": {} } } } } } } } };
    const messages = (raw: unknown) => checkAutoLayout(raw, cast).map((d) => d.message);
    expect(messages({ byCount: { "3": { left: "left-wide" } } })).toEqual([]);
    expect(messages({ byCount: ["3"] })).toHaveLength(1);
    expect(messages({ byCount: { three: { left: "left-wide" } } })[0]).toContain("キー three");
    expect(messages({ byCount: { "3": "left-wide" } })[0]).toContain("3 人");
    expect(messages({ byCount: { "3": { left: "" } } })[0]).toContain("left");
    expect(messages({ byCount: { "3": { right: "far-right" } } })[0]).toContain("far-right");
    expect(checkAutoLayout({ byCount: { "3": { "": "left-wide" } } }, cast).every((d) => d.code === "bad-auto-layout")).toBe(true);
  });

  it("書いた側の名前がどの枠にも無い（at= に書けない）読み替えを知らせる（2026-11-19 の L8）", () => {
    const cast = { A: { appearances: { default: { variants: { normal: { frame: { positions: { "left-wide": {} } } } } } } } };
    const [d, ...rest] = checkAutoLayout({ byCount: { "2": { lefft: "center" } } }, cast);
    expect(rest).toEqual([]);
    expect(d).toMatchObject({ code: "bad-auto-layout" });
    expect(d!.message).toContain("書いた立ち位置 lefft");
    expect(d!.hint).toContain("left-wide");
    // 枠に足した名前は書いた側にも使える
    expect(checkAutoLayout({ byCount: { "2": { "left-wide": "left" } } }, cast)).toEqual([]);
  });
});

describe("cast.json の定位置（side）", () => {
  it("left と right のほかは bad-cast にする（黙って登場順に並べない。2026-11-19 の L6）", () => {
    const problems = castSideProblems({ A: { side: "center", appearances: {} }, B: { side: "Left", appearances: {} }, C: { side: "left", appearances: {} }, D: { appearances: {} } });
    expect(problems.map((p) => [p.who, p.message])).toEqual([
      ["A", 'キャラクター A の side は left か right で書きます（"center"）'],
      ["B", 'キャラクター B の side は left か right で書きます（"Left"）'],
    ]);
  });
});
