import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { importRenpy, importTwine } from "../src/index.ts";
import { importStoryProject } from "../src/node.ts";
import { pyExpr } from "../src/renpy.ts";
import { twineExpr } from "../src/twine.ts";
import { limCheckErrors, play, registry } from "./helpers.ts";

const FIXTURES = resolve(import.meta.dirname, "fixtures");
const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
const read = (f: string) => readFileSync(join(FIXTURES, f), "utf8");
const renpy = () => importRenpy([{ file: "cafe.rpy", text: read("cafe.rpy") }]);

describe("Ren'Py", () => {
  it("ラベル・台詞・menu・if・while・画面と音の文を、lim check のエラーなしに変換する", () => {
    const r = renpy();
    expect(limCheckErrors(r)).toEqual([]);
    expect(r.totals.manual).toBe(0);
    expect(r.speakers).toEqual(["エイル", "店主"]);
    expect(r.variables).toEqual({ "game.narrator_name": "ぼく", "game.coffee": 0, "game.met": false, "system.cleared": false, "game.count": 0 });
    expect(r.cast).toEqual({ eileen: { appearances: { default: { variants: { happy: { image: "eileen happy.png" } } } } } });
    const text = r.files[0]!.text;
    expect(text).toContain("# start\n@chara-hide-all time=1s\n@bg backgrounds/cafe.jpg time=1s\n@bgm morning.ogg time=1s");
    expect(text).toContain("エイル「今日は{b 特別な}豆があるの。{click}飲んでいく？」");
    expect(text).toContain("エイル「いらっしゃい、{= game.narrator_name}さん。」");
    // ローカルラベル .leave は start-leave、call されるラベルの return は @return、ほかは話の終わり
    expect(text).toContain("# start-leave");
    expect(text).toContain("@call #order");
    expect(text).toContain("@while game.count < 2\n  @set game.count += 1\n  時計が鳴った。\n@end");
    expect(text).toContain("エイル「何にする？」{noclick}\n@choice");
    expect(text).toContain("  - もう一杯 -> #start-c2 if=(game.coffee >= 1)");
    expect(text).toContain("@set system.cleared = true");
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["renpy-skip", "renpy-start", "renpy-images"]));
  });

  it("window show と window hide の、with を書かない転換も時間にする（2026-11-19 の疑い）", () => {
    const r = importRenpy([{ file: "w.rpy", text: 'label start:\n    window hide dissolve\n    "a"\n    window show Dissolve(0.3)\n    "b"\n    window hide with fade\n    return\n' }]);
    const text = r.files[0]!.text;
    expect(text).toContain("@window hide time=500ms");
    expect(text).toContain("@window show time=0.3s");
    expect(text).toContain("@window hide time=1s");
  });

  it("Ren'Py と同じに流れる（call から戻り、menu の条件と while が動く）", async () => {
    const p = await play(renpy(), "cafe", [0, 1]);
    expect(p.diagnostics).toEqual([]);
    expect(p.shown).toEqual([
      ["コーヒー", "やめておく"],
      ["コーヒー", "もう一杯", "やめておく"],
    ]);
    expect(p.pages).toEqual([
      "扉を開けると、ベルが鳴った。",
      "エイル「いらっしゃい、ぼくさん。」",
      "エイル「今日は特別な豆があるの。飲んでいく？」",
      "エイル「何にする？」",
      "店主「どうぞ。」",
      "エイル「何にする？」",
      "店主「おかわりです。」",
      "エイル「たくさん飲んだね。」",
      "時計が鳴った。",
      "時計が鳴った。",
      "店を出た。",
    ]);
  });

  it("変換できない文は止めずにコメントにして報告する", () => {
    const r = importRenpy([{ file: "odd.rpy", text: 'label start:\n    python:\n        x = 1\n    jump expression target\n    $ renpy.notify("x")\n    queue music "a.ogg"\n    "おわり。"\n' }]);
    expect([...r.unsupported.keys()].sort()).toEqual(["renpy-audio", "renpy-jump", "renpy-python"]);
    expect(limCheckErrors(r)).toEqual([]);
    expect(r.files[0]!.text).toContain("// jump expression target");
  });

  it("文字列の中の \\t や \\r の書き逃しは消さず、本当の文字にする", () => {
    const r = importRenpy([{ file: "esc.rpy", text: 'label start:\n    e "a\\tb"\n    "x\\ry"\n' }]);
    expect(r.files[0]!.text).toContain('e "a\tb"');
    expect(r.files[0]!.text).toContain("x{br}y");
  });

  it("命令や変数の中の書き逃しも残る（\\r は行を分けない・\\t は t に消えない）", () => {
    const r = importRenpy([{ file: "esc.rpy", text: 'define x = "a\\tb"\nlabel start:\n    $ y = "a\\rb"\n' }], { variables: "set" });
    const text = r.files[0]!.text;
    expect(text).toContain('@set game.y = "a\\nb"');
    const set = text.split("\n").find((l) => l.startsWith("@set game.y"));
    expect(set).not.toContain("\r");
    const v = importRenpy([{ file: "esc.rpy", text: 'define x = "a\\tb"\nlabel start:\n    pass\n' }], { variables: "set" });
    expect(v.files[0]!.text).toContain(`@set game.x = "a\tb"`);
    expect(limCheckErrors(v)).toEqual([]);
  });

  it("Python の式を .lim の式にする", () => {
    const v = (n: string) => `game.${n}`;
    expect(pyExpr("a and not b or c is None", v)).toBe("game.a && !game.b || game.c == null");
    expect(pyExpr("renpy.random.randint(1, 6) >= 3", v)).toBe("randint(1, 6) >= 3");
    expect(pyExpr("'x' if a else 'y'", v)).toMatchObject({ error: expect.any(String) });
    expect(pyExpr("a in [1, 2]", v)).toEqual({ error: "in は変換できません" });
  });
});

describe("英語の作品の台詞", () => {
  it("ひらがなとカタカナの無い作品は、台詞を英語の引用符で囲む（Ren'Py・Ink・Yarn Spinner。Twine は話者を読まない）。日本語の作品は今までどおり「」", async () => {
    const { importInk, importYarn } = await import("../src/index.ts");
    const rpy = importRenpy([{ file: "en.rpy", text: 'define e = Character("Eileen")\nlabel start:\n    e "Hello, {b}you{/b}."\n    e \'She said "hi".\'\n    "It was quiet."\n    return\n' }]);
    expect(limCheckErrors(rpy)).toEqual([]);
    const text = rpy.files[0]!.text;
    expect(text).toContain('Eileen "Hello, {b you}."');
    // 本文に " があれば “” で囲む
    expect(text).toContain('Eileen “She said "hi".”');
    expect(text).toContain("It was quiet.");
    expect(importInk("Yui: Hello.\nYui: “Already quoted.”", { file: "t.ink" }).files[0]!.text).toContain('Yui "Hello."\nYui "Already quoted."');
    expect(importYarn([{ file: "t.yarn", text: "title: Start\n---\nYui: Hello.\n===\n" }]).files[0]!.text).toContain('Yui "Hello."');
    // 日本語の作品
    expect(importInk("ユイ: おはよう\nユイ: OK", { file: "t.ink" }).files[0]!.text).toContain("ユイ「おはよう」\nユイ「OK」");
    // 始まりのファイルが INCLUDE だけでも、INCLUDE したファイルの中身で決める
    const included = (src: string) => importInk("INCLUDE body.ink\n", { file: "main.ink", include: () => src }).files[0]!.text;
    expect(included("ユイ: おはよう\n")).toContain("ユイ「おはよう」");
    expect(included("Yui: Hello.\n")).toContain('Yui "Hello."');
  });
});

describe("Twine（Twee 3）", () => {
  it("Harlowe: パッセージ・リンク・(set:)・(if:)[…](else:)[…]・(print:)・(goto:) を変換する", async () => {
    const r = importTwine(read("forest.twee"), { file: "forest.twee" });
    expect(limCheckErrors(r)).toEqual([]);
    expect(r.totals.manual).toBe(0);
    expect(r.variables).toEqual({ "game.apples": 0, "game.name": "旅人" });
    const text = r.files[0]!.text;
    expect(text).toContain("# 入口\n森の入口に立っている。{b 静か}だ。");
    expect(text).toContain("@choice\n  - 左の道 -> #泉\n  - 右へ行く -> #小屋\n@end");
    // 枝の中のリンクは、その枝を通ったときだけ出す
    expect(text).toContain("  - 拾わずに進む -> #小屋 if=(temp.twine_l1)");
    const p = await play(r, "forest", [0, 0]);
    expect(p.diagnostics).toEqual([]);
    expect(p.pages).toEqual(["森の入口に立っている。静かだ。", "旅人 は二つの道を見た。", "泉の水は澄んでいる。りんごは 2 個。", "りんごを一つ落とした。", "小屋に着いた。10 点。", "りんごが残っている。", "おしまい。"]);
  });

  it("SugarCube: StoryInit・<<set>>・<<if>>・<<print>>・<<link>>・<<goto>> を変換し、script のパッセージは飛ばす", async () => {
    const r = importTwine(read("station.twee"), { file: "station.twee" });
    expect(limCheckErrors(r)).toEqual([]);
    expect(r.totals.manual).toBe(0);
    expect(r.variables).toEqual({ "game.ticket": false, "game.coins": 3 });
    expect(r.files[0]!.text).toContain("@set game.coins -= 2\n@set game.ticket = true");
    expect(r.issues.map((i) => i.code)).toContain("twine-skip");
    const p = await play(r, "station", [0]);
    expect(p.pages).toEqual(["駅のホームにいる。小銭は 3 枚。", "切符が買える。", "切符を買った。残りは 1 枚。", "電車に乗った。"]);
    const q = await play(r, "station", [1, 0, 1]);
    expect(q.pages.slice(0, 3)).toEqual(["駅のホームにいる。小銭は 3 枚。", "切符が買える。", "ベンチに座った。"]);
  });

  it("無いパッセージへのリンクと、知らないマクロは報告する", () => {
    const r = importTwine(":: Start\n[[どこか->Nowhere]]\n(display: \"x\")\n", { file: "t.twee" });
    expect([...r.unsupported.keys()].sort()).toEqual(["twine-link", "twine-macro"]);
    expect(limCheckErrors(r)).toEqual([]);
  });

  it("Harlowe と SugarCube の式を .lim の式にする", () => {
    const v = (n: string) => (n.startsWith("$") ? `game.${n.slice(1)}` : `temp.${n.slice(1)}`);
    expect(twineExpr("$a is not 3 and _b", "harlowe", v)).toBe("game.a != 3 && temp.b");
    expect(twineExpr("it + 1", "harlowe", v, "game.a")).toBe("game.a + 1");
    expect(twineExpr("$a gte 2 or $b eq 'x'", "sugarcube", v)).toBe('game.a >= 2 || game.b == "x"');
    expect(twineExpr("either(1, 2)", "sugarcube", v)).toBe("pick([1, 2])");
    // SugarCube の random(上限) は 0 以上 上限 以下の整数（randint(0, 上限)）。二つなら randint(a, b)
    expect(twineExpr("random(5)", "sugarcube", v)).toBe("randint(0, 5)");
    expect(twineExpr("random(1, 6)", "sugarcube", v)).toBe("randint(1, 6)");
    expect(twineExpr("random($a)", "sugarcube", v)).toBe("randint(min(0, game.a), max(0, game.a))");
    expect(twineExpr("random()", "sugarcube", v)).toEqual({ error: "random() の引数は一つか二つです" });
    expect(twineExpr("random(1, 6)", "harlowe", v)).toBe("randint(1, 6)");
    // SugarCube は小さい方が前でも正しく数える（random(-5) は -5 以上 0 以下）
    expect(twineExpr("random(-5)", "sugarcube", v)).toBe("randint(-5, 0)");
    expect(twineExpr("random(6, 1)", "sugarcube", v)).toBe("randint(1, 6)");
    expect(twineExpr("random($a, 6)", "sugarcube", v)).toBe("randint(min(game.a, 6), max(game.a, 6))");
  });
});

describe("プロジェクトへの取り込み（Ren'Py と Twine）", () => {
  const work = mkdtempSync(join(tmpdir(), "liminalia-renpy-twine-"));
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it("Ren'Py は立ち絵のキャストを cast.json に足し、Twine は一つの .lim にする", () => {
    const dir = join(work, "p");
    cpSync(TEMPLATE, dir, { recursive: true });
    const r = importStoryProject(dir, "renpy", [join(FIXTURES, "cafe.rpy")], { registry });
    expect(r.written).toEqual(["cafe.lim"]);
    expect(r.ok).toBe(true);
    const cast = JSON.parse(readFileSync(join(dir, "cast.json"), "utf8")) as { speakers: string[]; cast: Record<string, unknown> };
    expect(cast.speakers).toEqual(expect.arrayContaining(["エイル", "店主"]));
    expect(cast.cast).toHaveProperty("eileen");
    expect(readFileSync(r.reportPath, "utf8")).toContain("# 取り込みの報告（Ren'Py、1 ファイル）");
    const t = importStoryProject(dir, "twine", [join(FIXTURES, "forest.twee")], { registry });
    expect(t.written).toEqual(["forest.lim"]);
    expect(t.ok).toBe(true);
    expect(t.reportPath.endsWith("twine-import-report.md")).toBe(true);
  });
});
