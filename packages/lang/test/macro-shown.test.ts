import { describe, expect, it } from "vitest";
import { CORE_COMMANDS, createRegistry, parse, projectMacros, type CommandSpec } from "../src/index.ts";

/** マクロの人物の引数が「表示中の人物に効く」か（制作画面の人物の欄が、表示中の人物を上に並べるか）を本文から決める。 */

/** プラグインの命令（表示中の人物に効く引数と、効かない引数）。 */
const NOD: CommandSpec = { name: "nod", summary: "うなずく", positional: ["who"], params: { who: { type: { kind: "cast", shown: true }, required: true, doc: "" } }, example: "" };
const CALL: CommandSpec = { name: "call-out", summary: "呼ぶ", positional: ["who"], params: { who: { type: { kind: "cast" }, required: true, doc: "" } }, example: "" };
const registry = createRegistry(CORE_COMMANDS, [NOD, CALL]);
const specOf = (name: string) => registry.get(name);

const macros = (source: string) => projectMacros(new Map([["common", parse(source, "common", { speakers: ["ユイ"] })]]), specOf);
const shown = (source: string, name: string, param = "who") => {
  const type = macros(source).get(name)!.params[param]!.type;
  return type.kind === "cast" && type.shown === true;
};

describe("マクロの人物の引数（表示中の人物に効くか）", () => {
  it("本文で最初にその引数を渡す先が、表示中の人物に効く引数なら効く", () => {
    expect(shown("@define a(who: cast)\n@chara-hide (who)\n@end", "a")).toBe(true);
    expect(shown("@define a(who: cast)\n@nod who=(who)\n@chara (who) smile\n@end", "a")).toBe(true);
    // 最初に @chara（これから出す人物）や効かない引数へ渡すなら効かない
    expect(shown("@define a(who: cast)\n@chara (who) smile\n@chara-hide (who)\n@end", "a")).toBe(false);
    expect(shown("@define a(who: cast)\n@call-out (who)\n@nod (who)\n@end", "a")).toBe(false);
    // どこへも渡さなければ効かない
    expect(shown("@define a(who: cast)\nユイ「{= who}」\n@end", "a")).toBe(false);
  });

  it("@scene-change の hide-who のように、名前で書いた引数と、名前に - のある引数（式では _）も読む", () => {
    expect(shown("@define a(first-who: cast)\n@scene-change hide-who=(first_who)\n@end", "a", "first-who")).toBe(true);
  });

  it("分岐の中、本文の中の命令（{@…}）、式の一部として渡すものも順に見る", () => {
    expect(shown("@define a(who: cast)\n@if game.x\n  @nod (who)\n@end\n@chara (who)\n@end", "a")).toBe(true);
    expect(shown("@define a(who: cast)\nユイ「はい{@nod (who)}」\n@chara (who)\n@end", "a")).toBe(true);
    // 式の一部（(who + "2") など）は、その人物とは限らないので数えず、次の渡し先で決める
    expect(shown('@define a(who: cast)\n@chara (who + "2")\n@nod (who)\n@end', "a")).toBe(true);
  });

  it("ほかのマクロの人物の引数へ渡すときは、そのマクロの決め方に従う（先に書いたマクロでなくても）", () => {
    const source = ["@define outer(who: cast)", "@inner who=(who)", "@end", "@define inner(who: cast)", "@nod (who)", "@end", "@define loop(who: cast)", "@loop (who)", "@end"].join("\n");
    const specs = macros(source);
    const isShown = (name: string) => {
      const type = specs.get(name)!.params.who!.type;
      return type.kind === "cast" && type.shown === true;
    };
    expect(isShown("inner")).toBe(true);
    expect(isShown("outer")).toBe(true);
    // 自分を呼ぶマクロは決まらないので効かない
    expect(isShown("loop")).toBe(false);
  });

  it("命令の仕様を渡さなければ、前と同じく決めない", () => {
    const type = projectMacros(new Map([["common", parse("@define a(who: cast)\n@chara-hide (who)\n@end", "common")]])).get("a")!.params.who!.type;
    expect(type).toEqual({ kind: "cast" });
  });
});
