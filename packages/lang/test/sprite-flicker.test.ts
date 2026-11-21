import { describe, expect, it } from "vitest";
import { applyFix, applyLinesFix, check, CORE_COMMANDS, createRegistry, englishDiagnostic, parse, withCommandDefaults, type Diagnostic, type ReplaceLinesFix } from "../src/index.ts";

const JAPANESE = /[぀-ヿ㐀-鿿]/;
const CODES = ["chara-reshow", "chara-hide-per-line"];
const flicker = (lines: string[], registry = createRegistry(CORE_COMMANDS)): Diagnostic[] =>
  check(parse(lines.join("\n"), "start", { speakers: ["さくら", "ゆう", "はると"] }), { registry }).filter((d) => CODES.includes(d.code));
const brief = (ds: Diagnostic[]) => ds.map((d) => `${d.line} ${d.code}`);

describe("立ち絵のちらつき", () => {
  it("消した直後に同じ人物を出し直すと、消した行に警告し、その行を削除する修正案を付ける", () => {
    const lines = ["@chara さくら normal", "さくら「おはよう」", "@chara-hide さくら time=100ms", "@chara さくら smile", "さくら「うん」"];
    const [d, ...rest] = flicker(lines);
    expect(rest).toEqual([]);
    expect(d).toMatchObject({ severity: "warning", code: "chara-reshow", line: 3, fix: { kind: "delete-line" } });
    expect(d!.message).toContain("さくら をここで消して、すぐ後（4 行目）で出し直しています");
    expect(d!.hint).toContain("@chara さくら 差分");
    expect(d!.fixes).toEqual([d!.fix]);
    expect(applyFix(lines[2]!, d!.fix!)).toEqual({ remove: true });
  });

  it("本文をはさまずに出し直したときだけ知らせ、本文を一行でもはさめば知らせない（消えて地の文に続くのは演出）", () => {
    const base = ["@chara さくら", "@chara-hide さくら"];
    expect(brief(flicker([...base, "@chara さくら"]))).toEqual(["2 chara-reshow"]);
    expect(flicker([...base, "一行目。", "@chara さくら"])).toEqual([]);
    expect(flicker([...base, "さくら「a」", "@chara さくら"])).toEqual([]);
  });

  it("全消しと直後の表示は、ほかの人物も含めて演出を保つ clear にまとめる", () => {
    // 前の全消しで舞台が空だと分かっている
    const alone = flicker(["@chara-hide-all", "@chara さくら", "さくら「a」", "@chara-hide-all", "@chara さくら smile", "さくら「b」"]);
    expect(alone).toMatchObject([{ line: 4, code: "chara-reshow", fix: { kind: "replace-lines", with: "@chara さくら smile clear=0ms" } }]);
    const two = flicker(["@chara-hide-all", "@chara さくら at=left", "@chara ゆう at=right", "さくら「a」", "@chara-hide-all time=100ms", "@chara さくら smile at=left", "さくら「b」"]);
    expect(two).toMatchObject([{ line: 5, code: "chara-reshow", fix: { kind: "replace-lines", with: "@chara さくら smile at=left clear=100ms" } }]);
  });

  it("消さずに残すと立ち位置が変わる（出し直しの行に at= が無く、前は中央以外にいた）なら、隣り合う二行だけを at= を書き足した一行にまとめ、ほかは直し方だけを書く", () => {
    // 全消しのあと at= の無い @chara は中央に出る。全消しをほかの人だけを消す行に替えると、さくらは左に立ったままになる
    const [all] = flicker(["@chara-hide-all", "@chara さくら at=left", "@chara ゆう at=right", "さくら「a」", "@chara-hide-all", "@chara さくら smile", "さくら「b」"]);
    expect(all).toMatchObject({ line: 5, code: "chara-reshow" });
    expect(all!.fix).toMatchObject({ kind: "replace-lines", with: "@chara さくら smile clear=0ms" });
    // 一人だけを消す行のすぐ次で出し直すなら、出し直しの行に at=center を書き足して二行を一行にまとめる（今と同じ中央に出る）
    const lines = ["@chara さくら normal at=left", "さくら「a」", "@chara-hide さくら time=300ms", "@chara さくら smile", "さくら「b」"];
    const [one] = flicker(lines);
    expect(one).toMatchObject({ line: 3, code: "chara-reshow" });
    expect(one).not.toHaveProperty("fix");
    // 間にほかの命令があると二行が隣り合わないので、直し方だけを書く
    expect(flicker(["@chara さくら normal at=left", "さくら「a」", "@chara-hide さくら", "@bgm-stop", "@chara さくら smile"])[0]).not.toHaveProperty("fix");
    // x、y で置いた立ち絵は立ち位置の名前で書けないので、直し方だけを書く
    expect(flicker(["@chara さくら normal x=100", "さくら「a」", "@chara-hide さくら", "@chara さくら smile"])[0]).not.toHaveProperty("fix");
    // 出し直しの行が前と同じ立ち位置を書いていれば、残しても同じ画面なので直す
    expect(flicker(["@chara さくら normal at=left", "さくら「a」", "@chara-hide さくら", "@chara さくら smile at=left"])).toMatchObject([{ fix: { kind: "delete-line" } }]);
  });

  it("全消しを残る一人だけを消す行に替える直し方は、名前なしの時間を time= にして書く（@chara-hide に名前なしの時間は無い）", () => {
    for (const [hide, now] of [
      ["@chara-hide-all 100ms", "@chara-hide ゆう time=100ms"],
      ["@chara-hide-all time=100ms wait", "@chara-hide ゆう time=100ms wait=true"],
      ["@chara-hide-all", "@chara-hide ゆう"],
    ] as const) {
      const lines = ["@chara-hide-all", "@chara さくら normal at=left", "@chara ゆう normal at=right", "さくら「a」", hide, "@se chime.wav", "@chara さくら normal at=left", "さくら「b」"];
      const [d] = flicker(lines);
      expect(d).toMatchObject({ line: 5, code: "chara-reshow", fix: { kind: "replace-lines", with: now } });
      // 当てた行を検査し直しても誤りが無い
      const fixed = applyLinesFix(lines, 4, d!.fix as ReplaceLinesFix)!;
      const after = [...lines.slice(0, 4), fixed.text, ...lines.slice(5)];
      expect(check(parse(after.join("\n"), "start", { speakers: ["さくら", "ゆう"] }), { registry: createRegistry(CORE_COMMANDS) }).filter((x) => x.severity === "error")).toEqual([]);
    }
  });

  it("中央から左右に出し直すとき、消去と表示の時間を保つ修正案を付ける", () => {
    const lines = ["@chara-hide-all", "@chara さくら at=center", "本文。", "@chara-hide-all time=300ms", "@chara さくら normal at=left time=500ms", "@chara ゆう normal at=right time=500ms"];
    const [d] = flicker(lines);
    expect(d).toMatchObject({ line: 4, code: "chara-reshow" });
    expect(d!.fix).toEqual({ kind: "replace-lines", lines: [lines[3], lines[4]], with: "@chara さくら normal at=left time=500ms clear=300ms" });
    const applied = applyLinesFix(lines, 3, d!.fix as ReplaceLinesFix)!;
    expect(applied).toEqual({ count: 2, text: "@chara さくら normal at=left time=500ms clear=300ms" });
    expect(flicker([...lines.slice(0, 3), applied.text, ...lines.slice(5)])).toEqual([]);
  });

  it("消去時間の既定値と式を保ち、待機・退場方向・スキップが異なるときは clear にまとめない", () => {
    const source = (hide: string, show = "@chara さくら at=left") => ["@chara さくら at=center", "本文。", hide, show];
    const registry = withCommandDefaults(createRegistry(CORE_COMMANDS), { "chara-hide-all": { fade: "700ms" } });
    expect(flicker(source("@chara-hide-all"), registry)[0]!.fix).toMatchObject({ with: "@chara さくら at=left clear=700ms" });
    expect(flicker(source("@chara-hide-all time=(game.time)"))[0]!.fix).toMatchObject({ with: "@chara さくら at=left clear=(game.time)" });
    for (const lines of [source("@chara-hide-all wait=true"), source("@chara-hide-all exit=left"), source("@chara-hide-all", "@chara さくら at=left skip=false")]) {
      expect(flicker(lines).every((d) => d.fix?.kind !== "replace-lines")).toBe(true);
    }
  });

  it("clear で全消しして出す場面は消して出し直す警告にしない", () => {
    expect(flicker(["@chara さくら at=center", "本文。", "@chara さくら at=left clear=300ms time=500ms", "@chara ゆう at=right time=500ms"])).toEqual([]);
  });

  it("消さずに残すと差分や反転が変わる（出し直しの行が省いている）なら、修正案は付けない", () => {
    // 消してから差分を書かずに出すと標準の差分に戻る。残すと smile のまま（標準の差分は名前で書けないので直し方だけ）
    expect(flicker(["@chara さくら smile", "さくら「a」", "@chara-hide さくら", "@chara さくら", "さくら「b」"])[0]).not.toHaveProperty("fix");
    // 反転は flip=false を書き足せる
    expect(flicker(["@chara さくら normal flip=true", "さくら「a」", "@chara-hide さくら", "@chara さくら smile", "さくら「b」"])[0]).toMatchObject({ fix: { kind: "replace-lines", with: "@chara さくら smile flip=false" } });
    // 出し直しの行が書いていれば残しても同じ
    expect(flicker(["@chara さくら smile flip=true", "さくら「a」", "@chara-hide さくら", "@chara さくら normal flip=true"])[0]).toHaveProperty("fix");
  });

  it("消してから出し直すまでの間にほかの人物を出す（一人ずつ見せる）なら、修正案は付けずに solo=true を案内する", () => {
    // 全消し → ゆうだけ → 全消し → さくら。最初の全消しを削除すると、さくらとゆうが同時に立つ
    const ds = flicker(["@chara-hide-all", "a", "b", "c", "@chara さくら", "さくら「a」", "@chara-hide-all", "@chara ゆう", "@chara-hide-all", "@chara さくら", "さくら「c」"]);
    expect(brief(ds)).toEqual(["7 chara-reshow"]);
    expect(ds[0]).not.toHaveProperty("fix");
    expect(ds[0]!.hint).toContain("solo=true");
    // 一緒に消した二人を同じ立ち位置で出し直すのは、一人ずつ見せる型ではない（全消しの行を削除する）
    const both = flicker(["@chara-hide-all", "@chara さくら at=left", "@chara ゆう at=right", "さくら「a」", "@chara-hide-all", "@chara さくら smile at=left", "@chara ゆう smile at=right", "さくら「b」"]);
    expect(both).toMatchObject([{ line: 5, code: "chara-reshow", fix: { kind: "replace-lines", with: "@chara さくら smile at=left clear=0ms" } }]);
  });

  it("舞台にほかに誰がいるか分からなければ、修正案は付けずに直し方だけを書く", () => {
    const [d] = flicker(["@chara さくら", "さくら「a」", "@chara-hide-all", "@chara さくら smile"]);
    expect(d).toMatchObject({ line: 3, code: "chara-reshow" });
    expect(d!.fix).toMatchObject({ kind: "replace-lines", with: "@chara さくら smile clear=0ms" });
  });

  it("場面の替わり目、流れの分かれ目、わざとの出入り、衣装替えは知らせない", () => {
    expect(flicker(["@chara さくら", "@chara-hide さくら", "@bg room.webp", "@chara さくら"])).toEqual([]);
    expect(flicker(["@chara さくら", "@chara-hide さくら", "@wait 1s", "@chara さくら"])).toEqual([]);
    expect(flicker(["@chara さくら", "@chara-hide さくら", "# next", "@chara さくら"])).toEqual([]);
    expect(flicker(["@chara さくら", "@chara-hide さくら", "@if (game.a)", "@chara さくら", "@end"])).toEqual([]);
    expect(flicker(["@chara さくら", "@chara-hide さくら exit=left", "@chara さくら"])).toEqual([]);
    expect(flicker(["@chara さくら", "@chara-hide さくら", "@chara さくら enter=right"])).toEqual([]);
    expect(flicker(["@chara さくら", "@chara-hide さくら", "@chara さくら appearance=casual"])).toEqual([]);
    expect(flicker(["@chara さくら appearance=casual", "@chara-hide さくら", "@chara さくら appearance=school"])).toEqual([]);
    // 毎回同じ立ち絵セットを書いているだけなら出し直し
    expect(brief(flicker(["@chara さくら appearance=casual", "@chara-hide さくら", "@chara さくら smile appearance=casual"]))).toEqual(["2 chara-reshow"]);
    // ほかの人物を出すのは入れ替え（出し直しではない）
    expect(flicker(["@chara さくら", "@chara-hide さくら", "@chara ゆう"])).toEqual([]);
  });

  it("台詞の一、二行ごとの全消しが三回続けば、最初の全消しに一つだけ警告する（中の出し直しは重ねない）", () => {
    const lines = ["@chara-hide-all", "@chara さくら", "さくら「a」", "@chara-hide-all", "@chara ゆう", "ゆう「b」", "ゆう「c」", "@chara-hide-all", "@chara さくら", "さくら「d」"];
    const ds = flicker(lines);
    expect(brief(ds)).toEqual(["1 chara-hide-per-line"]);
    expect(ds[0]!.message).toContain("（3 回、8 行目まで）");
    expect(ds[0]!.hint).toContain("ui.chara.focus");
    expect(ds[0]!.hint).toContain("solo=true");
    // 二回なら全消しの続きとはみなさない
    expect(brief(flicker(lines.slice(0, 7)))).toEqual([]);
    // 間の本文が三行あれば切れる（6 行目で消したさくらは、本文をはさんで出し直すので知らせない）
    expect(brief(flicker(["@chara-hide-all", "@chara さくら", "a", "b", "c", "@chara-hide-all", "@chara ゆう", "d", "@chara-hide-all", "@chara さくら", "e"]))).toEqual([]);
  });

  it("solo=true で一人ずつ出す書き方は知らせない（commandDefaults で既定にしたものも）", () => {
    expect(flicker(["@chara さくら solo=true", "さくら「a」", "@chara ゆう solo=true", "ゆう「b」", "@chara さくら solo=true", "さくら「c」"])).toEqual([]);
    const registry = withCommandDefaults(createRegistry(CORE_COMMANDS), { chara: { solo: "true" } });
    expect(flicker(["@chara さくら", "さくら「a」", "@chara ゆう", "ゆう「b」", "@chara さくら", "さくら「c」"], registry)).toEqual([]);
  });

  it("英語でも読める（文と直し方に日本語が残らない）", () => {
    const ds = [
      ...flicker(["@chara さくら", "@chara-hide さくら", "@chara さくら"]),
      ...flicker(["@chara-hide-all", "@chara さくら", "@chara ゆう", "@chara-hide-all", "@chara さくら"]),
      ...flicker(["@chara さくら", "@chara-hide-all", "@chara さくら"]),
      ...flicker(["@chara-hide-all", "@chara さくら", "a", "@chara-hide-all", "@chara ゆう", "b", "@chara-hide-all", "@chara さくら"]),
      ...flicker(["@chara さくら normal at=left", "a", "@chara-hide さくら", "@chara さくら smile"]),
      ...flicker(["@chara-hide-all", "a", "b", "c", "@chara さくら", "d", "@chara-hide-all", "@chara ゆう", "@chara-hide-all", "@chara さくら"]),
    ];
    expect(ds.map((d) => d.code)).toEqual(["chara-reshow", "chara-reshow", "chara-reshow", "chara-hide-per-line", "chara-reshow", "chara-reshow"]);
    for (const d of ds) {
      const en = englishDiagnostic(d);
      expect(en.message.replace(/さくら|ゆう/g, ""), d.message).not.toMatch(JAPANESE);
      expect(en.hint!.replace(/さくら|ゆう/g, ""), d.hint).not.toMatch(JAPANESE);
    }
  });

  it("全員を消してすぐ一人を出す行は、solo=true の一行にまとめる修正案を情報で付ける（一人ずつ見せる型をまとめて直す）", () => {
    const lines = ["@chara-hide-all", "@chara さくら", "さくら「a」", "@chara-hide-all", "@chara ゆう smile", "ゆう「b」", "@chara-hide-all time=300ms", "@chara さくら", "さくら「c」"];
    const solo = check(parse(lines.join("\n"), "start", { speakers: ["さくら", "ゆう"] }), { registry: createRegistry(CORE_COMMANDS) }).filter((d) => d.code === "chara-solo");
    // 舞台に誰かいた全消しだけ（最初の全消しは舞台が空と分からない）
    expect(solo.map((d) => [d.line, d.severity, d.fix])).toEqual([
      [4, "info", { kind: "replace-lines", lines: ["@chara-hide-all", "@chara ゆう smile"], with: "@chara ゆう smile solo=true" }],
      [7, "info", { kind: "replace-lines", lines: ["@chara-hide-all time=300ms", "@chara さくら"], with: "@chara さくら solo=true" }],
    ]);
    expect(applyLinesFix(lines, 3, solo[0]!.fix as ReplaceLinesFix)).toEqual({ count: 2, text: "@chara ゆう smile solo=true" });
    expect(englishDiagnostic(solo[0]!).message.replace(/さくら|ゆう/g, "")).not.toMatch(JAPANESE);
    // 当てたあとは知らせない（ちらつきの警告も消える）
    const fixed = ["@chara-hide-all", "@chara さくら", "さくら「a」", "@chara ゆう smile solo=true", "ゆう「b」", "@chara さくら solo=true", "さくら「c」"];
    expect(check(parse(fixed.join("\n"), "start", { speakers: ["さくら", "ゆう"] }), { registry: createRegistry(CORE_COMMANDS) }).filter((d) => ["chara-solo", ...CODES].includes(d.code))).toEqual([]);
  });

  it("まとめると画面が変わるもの（間に本文、動いて出入りする、消した人物を前の見た目のまま出し直す）は知らせない", () => {
    const solo = (lines: string[]) => check(parse(lines.join("\n"), "start", { speakers: ["さくら", "ゆう"] }), { registry: createRegistry(CORE_COMMANDS) }).filter((d) => d.code === "chara-solo").map((d) => d.line);
    // 間に本文や空行がある
    expect(solo(["@chara-hide-all", "@chara さくら", "a", "@chara-hide-all", "b", "@chara ゆう"])).toEqual([]);
    expect(solo(["@chara-hide-all", "@chara さくら", "a", "@chara-hide-all", "", "@chara ゆう"])).toEqual([]);
    // 動いて消える、動いて入る、すでに solo
    expect(solo(["@chara-hide-all", "@chara さくら", "a", "@chara-hide-all exit=left", "@chara ゆう"])).toEqual([]);
    expect(solo(["@chara-hide-all", "@chara さくら", "a", "@chara-hide-all", "@chara ゆう enter=right"])).toEqual([]);
    // 左にいたさくらを at= なしで出し直す（全消しのあとは中央、solo なら左のまま）
    expect(solo(["@chara-hide-all", "@chara さくら at=left", "a", "@chara-hide-all", "@chara さくら smile"])).toEqual([]);
    expect(solo(["@chara-hide-all", "@chara さくら at=left", "a", "@chara-hide-all", "@chara さくら smile at=center"])).toEqual([]);
    expect(solo(["@chara-hide-all", "@chara さくら at=center", "a", "@chara-hide-all time=300ms", "@chara さくら at=left time=500ms", "@chara ゆう at=right time=500ms"])).toEqual([]);
  });
});
