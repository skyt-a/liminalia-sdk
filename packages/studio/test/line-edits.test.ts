import { describe, expect, it } from "vitest";
import { planLineEdits, type LineEdit } from "../src/model/line-edits.ts";

/** プラグインの ctx.script.apply の行の書き換えを、文書の位置の変更にする。 */

const DOC = "一\n二\n三\n四";

/** 位置の変更を当てた結果（変更はどれも書き換える前の位置で、重ならない）。 */
function run(doc: string, edits: LineEdit[]): string | { reason: string; index: number } {
  const plan = planLineEdits(doc, edits);
  if (!plan.ok) return { reason: plan.reason, index: plan.index };
  let out = doc;
  for (const c of [...plan.changes].reverse()) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return out;
}

const edit = (from: number, to: number, expect: string, text: string | null): LineEdit => ({ from, to, expect, text });

describe("行の書き換え", () => {
  it("行を置き換える（改行を含めて増やせる）", () => {
    expect(run(DOC, [edit(2, 3, "二\n三", "2\n2.5\n3")])).toBe("一\n2\n2.5\n3\n四");
  });

  it("行ごと消す（途中・最後・全部）", () => {
    expect(run(DOC, [edit(2, 2, "二", null)])).toBe("一\n三\n四");
    expect(run(DOC, [edit(4, 4, "四", null)])).toBe("一\n二\n三");
    expect(run(DOC, [edit(1, 4, DOC, null)])).toBe("");
  });

  it("前に足す・末尾に足す", () => {
    expect(run(DOC, [edit(1, 0, "", "零")])).toBe("零\n一\n二\n三\n四");
    expect(run(DOC, [edit(3, 2, "", "二半")])).toBe("一\n二\n二半\n三\n四");
    expect(run(DOC, [edit(5, 4, "", "五")])).toBe("一\n二\n三\n四\n五");
  });

  it("いくつかをまとめて（渡した順によらない）", () => {
    expect(run(DOC, [edit(4, 4, "四", "4"), edit(1, 1, "一", "1"), edit(3, 2, "", "足した")])).toBe("1\n二\n足した\n三\n4");
  });

  it("行が expect と違えば何も変えず changed（どの書き換えか）", () => {
    expect(run(DOC, [edit(1, 1, "一", "1"), edit(2, 2, "に", "2")])).toEqual({ reason: "changed", index: 1 });
    expect(run(DOC, [edit(2, 1, "x", "足す")])).toEqual({ reason: "changed", index: 0 });
  });

  it("基準の行（guard）が違えば、足すときも何も変えず changed", () => {
    expect(run(DOC, [{ ...edit(3, 2, "", "足す"), guard: { line: 3, text: "三" } }])).toBe("一\n二\n足す\n三\n四");
    expect(run(DOC, [{ ...edit(3, 2, "", "足す"), guard: { line: 3, text: "さん" } }])).toEqual({ reason: "changed", index: 0 });
    expect(run(DOC, [{ ...edit(3, 2, "", "足す"), guard: { line: 9, text: "三" } }])).toEqual({ reason: "changed", index: 0 });
  });

  it("文書の外・重なり・逆向き・足すのに null は invalid", () => {
    expect(run(DOC, [edit(4, 5, "四", "x")])).toMatchObject({ reason: "invalid" });
    expect(run(DOC, [edit(6, 5, "", "x")])).toMatchObject({ reason: "invalid" });
    expect(run(DOC, [edit(3, 1, "", "x")])).toMatchObject({ reason: "invalid" });
    expect(run(DOC, [edit(1, 2, "一\n二", "x"), edit(2, 3, "二\n三", "y")])).toEqual({ reason: "invalid", index: 1 });
    expect(run(DOC, [edit(1, 2, "一\n二", "x"), edit(2, 1, "", "y")])).toEqual({ reason: "invalid", index: 1 });
    expect(run(DOC, [edit(2, 1, "", null)])).toMatchObject({ reason: "invalid" });
  });
});
