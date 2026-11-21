import { describe, expect, it } from "vitest";
import { checkProjectRules, CORE_COMMANDS, createRegistry, parse, type Cast } from "../src/index.ts";

const registry = createRegistry(CORE_COMMANDS);
const cast: Cast = {
  ハル: { appearances: { default: { variants: {} } } } as never,
  ユイカ: { appearances: { default: { variants: {} } } } as never,
  ミナ: { appearances: { default: { variants: {} }, young: { variants: {} }, mourning: { variants: {} } } } as never,
};
const extra = { cg: [{ id: "scene", title: "部屋", images: ["stills/scene.png"] }] };
const run = (files: Record<string, string>, rules: unknown[], scenes?: unknown) =>
  checkProjectRules({ rules, scenes, scripts: new Map(Object.entries(files).map(([f, s]) => [f, parse(s, f)])), registry, cast, extra }).map((d) => `${d.code}:${d.file}:${d.line}`);

describe("作品の演出の決まり", () => {
  it("CG を出すときに立ち絵が残っている", () => {
    const src = "@chara ユイカ normal\n本文。\n@bg stills/scene.png\n@chara-hide-all\n@bg stills/scene.png\n@chara ミナ normal\n@bg room.png";
    expect(run({ a: src }, [{ rule: "cg-without-sprites" }])).toEqual(["rule-cg-with-sprites:a:3"]);
  });

  it("@if の枝ごとに追い、飛び込まれるラベルは空から始める", () => {
    const src = "@chara ユイカ normal\n@if game.x\n@chara-hide-all\n@end\n@bg stills/scene.png\n@jump #b\n# b\n@bg stills/scene.png";
    expect(run({ a: src }, [{ rule: "cg-without-sprites" }])).toEqual(["rule-cg-with-sprites:a:5"]);
  });

  it("別のファイルへ飛ぶ前の暗転", () => {
    expect(run({ a: "本文。\n@jump b\n# c\n本文。\n@mask time=1s\n@stop-bgm\n@jump b", b: "本文。\n@jump #x\n# x\n終わり。" }, [{ rule: "fade-before-file-jump" }])).toEqual(["rule-fade-before-jump:a:2"]);
  });

  it("視点の人物の立ち絵（ラベルごとに視点が替わる）", () => {
    const src = "@chara ユイカ normal\n@chara ハル normal\n# yuika_view\n@chara ユイカ normal\n@chara ハル normal";
    expect(run({ a: src }, [{ rule: "no-pov-sprite" }], { a: { pov: "ハル" }, "a#yuika_view": { pov: "ユイカ" } })).toEqual(["rule-pov-sprite:a:2", "rule-pov-sprite:a:4"]);
  });

  it("時代の立ち絵セットを混ぜない・出したまま衣装を替えない", () => {
    const rules = [{ rule: "appearance-era", eras: { past: ["young*", "mourning"] } }, { rule: "appearance-change-while-shown" }];
    // 過去の場面で現在の衣装 → 警告。時代の無い場面で過去と現在（default は時代なし）は数えないが、過去どうしは同じ
    const src = "# p\n@chara ミナ normal\n@chara-hide-all\n@chara ミナ normal appearance=young\n@chara ミナ normal appearance=mourning\n# q\n@chara-hide-all\n@chara ミナ normal appearance=young";
    expect(run({ a: src }, rules, { "a#p": { era: "past" } })).toEqual(["rule-appearance-era:a:2", "rule-appearance-change:a:5"]);
  });

  it("決まりと場面の情報の形の誤り", () => {
    expect(run({ a: "本文。" }, [{ rule: "nope" }], { "a#none": { pov: "ハル" } })).toEqual(["bad-rules:liminalia.json:1", "bad-scenes:liminalia.json:1"]);
  });
});
