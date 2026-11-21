import { describe, expect, it } from "vitest";
import { checkProject, CORE_COMMANDS, createRegistry, defineSpec, missingAssets, paramTypeFromName, parse, type CastEntry, type Script } from "../src/index.ts";

const registry = createRegistry(CORE_COMMANDS);
const cast: Record<string, CastEntry> = {
  ユイ: { appearances: { default: { variants: { normal: { image: "yui/normal.png" } } } } } as unknown as CastEntry,
};
const scripts = (files: Record<string, string>) => new Map<string, Script>(Object.entries(files).map(([name, text]) => [name, parse(text, name, { speakers: ["ユイ"] })]));
const run = (files: Record<string, string>) =>
  checkProject(scripts(files), { registry, cast: new Set(Object.keys(cast)), castEntries: cast, speakers: ["ユイ"] })
    // 流れの検査の情報（使われないマクロなど）は flow-check.test.ts で見る
    .filter((d) => d.severity !== "info" && d.code !== "unreachable-line")
    .map((d) => `${d.file}:${d.line} ${d.severity} ${d.code}`);

describe("マクロの引数の型", () => {
  it("asset(フォルダ)、cast、appearance、variant、position、target、enum(a|b) を読む", () => {
    expect(paramTypeFromName("asset(bgimage)")).toEqual({ kind: "asset", folder: "bgimage" });
    expect(paramTypeFromName("enum(calm|angry)")).toEqual({ kind: "enum", values: ["calm", "angry"] });
    for (const k of ["cast", "appearance", "variant", "position", "target"]) expect(paramTypeFromName(k)).toEqual({ kind: k });
    expect(paramTypeFromName("enum()")).toBeNull();
    expect(paramTypeFromName("asset")).toBeNull();
  });

  it("呼ぶ側の値を、組み込みのコマンドと同じに確かめる", () => {
    const src = [
      "@define show(who: cast, face: variant = normal, at: position = center, mood: enum(calm|angry) = calm, to: target = #start)",
      "@chara (who) (face)",
      "@end",
      "# start",
      "@show who=ユイ face=normal at=center",
      "@show who=ユキ",
      "@show who=ユイ face=smile",
      "@show who=ユイ at=right",
      "@show who=ユイ mood=happy",
      "@show who=ユイ to=#nowhere",
      "@show who=ユイ to=b#nowhere",
    ].join("\n");
    expect(run({ a: src, b: "# here" })).toEqual([
      "a:6 error bad-value",
      "a:7 error unknown-variant",
      "a:8 error unknown-position",
      "a:9 error bad-value",
      "a:10 error unknown-label",
      "a:11 error unknown-label",
    ]);
  });

  it("asset(フォルダ) の値は素材の実在を確かめる（ひな形の @scene image=nofile.webp を見逃さない）", () => {
    const s = scripts({ a: "@define scene(image: asset(bgimage), time: duration = 800ms)\n@bg (image)\n@end\n@scene image=hill.webp\n@scene image=nofile.webp\n" });
    const d = missingAssets({ scripts: s, registry, cast: {}, castFile: "cast.json", exists: (folder, path) => `${folder}/${path}` === "bgimage/hill.webp" });
    expect(d.map((x) => `${x.line} ${x.code} ${x.message}`)).toEqual(["5 missing-asset 素材 bgimage/nofile.webp がありません"]);
  });

  it("無い型は、近い型の名前を修正案にする", () => {
    const d = checkProject(scripts({ a: "@define x(a: strng)\n@end\n" })).filter((x) => x.severity !== "info");
    expect(d.map((x) => [x.code, x.hint])).toEqual([["unknown-type", "string のことですか？"]]);
  });
});

describe("マクロの中の飛び先", () => {
  it("パラメータの値へ飛ぶ @jump (to) はマクロの中では判断せず、呼ぶ側の値を確かめる", () => {
    const src = ["@define go(to: target)", "@jump (to)", "@end", "# start", "@go to=#start", "@go to=#nowhere"].join("\n");
    expect(run({ a: src })).toEqual(["a:6 error unknown-label"]);
  });

  it("行き先を判断できない式の飛び先は警告（資料のとおり。マクロの外）", () => {
    expect(run({ a: '# start\n@jump ("ch" + game.n)' })).toEqual(["a:2 warning unknown-targets"]);
  });
});

describe("マクロの要約", () => {
  it("@define のすぐ上に続く // の行を要約にする（空行を挟めば要約にしない）", () => {
    const s = parse("// 場面転換の部品。\n// 暗転して背景を替える。\n@define scene(image: asset(bgimage))\n@end\n// 離れたコメント\n\n@define other()\n@end\n", "a");
    const defines = s.body.filter((x) => x.kind === "define");
    expect(defines.map((d) => defineSpec(d)!.summary)).toEqual(["場面転換の部品。 暗転して背景を替える。", ""]);
  });
});

describe("組み込みのコマンドと同じ名前のマクロ", () => {
  it("作品のマクロを使う警告にし、呼び出しはマクロの引数で確かめる。書き方の言葉はエラー", () => {
    const src = ["@define wait(seconds: number)", "@end", "@wait seconds=2", "@define jump(to: target)", "@end"].join("\n");
    expect(run({ a: src })).toEqual(["a:1 warning define-shadows-command", "a:4 error define-shadows-command"]);
  });
});
