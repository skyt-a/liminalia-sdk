import { describe, expect, it } from "vitest";
import { achievementGoals, checkExtra, expandExtra, extraAssetReferences, parse, shownImages, type Script } from "../src/index.ts";

const scripts = (files: Record<string, string>) => new Map<string, Script>(Object.entries(files).map(([name, src]) => [name, parse(src, name)]));

describe("おまけの一覧", () => {
  it("書かなければ何も言わない", () => {
    expect(checkExtra(undefined, scripts({}))).toEqual([]);
  });

  it("形の崩れ・id の重なり・回想の始まりの位置が無いことはエラー", () => {
    const extra = {
      cg: [{ id: "a", images: ["x.png"] }, { id: "a", images: [] }],
      replay: [{ id: "r1", target: "ending#nope" }, { id: "r2", target: "missing" }, { id: "r3" }],
      music: [{}],
      achievements: [{ id: "x" }],
    };
    const messages = checkExtra(extra, scripts({ ending: "# a\n本文" })).map((d) => d.message);
    expect(messages).toEqual([
      "extra.cg の id a が重複しています",
      "extra.cg a に images（画像のパスの配列）がありません",
      "extra.replay r1 の target のラベル #nope が ending にありません",
      "extra.replay r2 の target のファイル missing がありません",
      "extra.replay r3 に target（再生を始める位置）がありません",
      "extra.music に file のないものがあります",
      "extra.achievements x に title がありません",
    ]);
  });

  it("シナリオの解放の命令が一覧に無い名前を指していたら警告", () => {
    const extra = { cg: [{ id: "a", images: ["a.png"] }], replay: [{ id: "r", target: "s#start" }], achievements: [{ id: "ok", title: "OK" }] };
    const src = "# start\n@cg-unlock a.png\n@cg-unlock b.png\n@replay-unlock r\n@replay-unlock q\n@achieve ok\n@achieve ng";
    const warnings = checkExtra(extra, scripts({ s: src })).map((d) => `${d.severity} ${d.line} ${d.code}`);
    expect(warnings).toEqual(["warning 3 not-in-extra", "warning 5 not-in-extra", "warning 7 not-in-extra"]);
  });

  it("参照する素材（CG と縮小画像は bgimage、音楽は bgm、実績の画像は image）", () => {
    const refs = extraAssetReferences({ cg: [{ id: "a", images: ["a.png", "a2.png"], thumb: "a_t.png" }], replay: [{ id: "r", target: "s", thumb: "r.png" }], music: [{ file: "m.ogg" }], achievements: [{ id: "x", title: "X", icon: "x.png" }] });
    expect(refs.map((r) => `${r.folder}/${r.path}`)).toEqual(["bgimage/a.png", "bgimage/a2.png", "bgimage/a_t.png", "bgimage/r.png", "bgm/m.ogg", "image/x.png"]);
  });

  it("シナリオが出す画像を物語の順に集める（ファイルは数字を数として並べ、@if・@define の中も見る。重なりは最初だけ）", () => {
    const files = scripts({
      ep_10: "@bg s/c.png",
      ep_2: "@bg s/a.png\n@if (game.x)\n  @bg image=s/b.png\n@end\n@cg-unlock s/z.png\n@bg s/a.png",
      ep_9: "@define m()\n@bg s/d.png\n@end\n@bg (game.img)",
    });
    expect(shownImages(files)).toEqual(["s/a.png", "s/b.png", "s/z.png", "s/d.png", "s/c.png"]);
  });

  it("cgAuto: フォルダの画像のうち一覧に無いものを一枚ずつ足す。置き場所は物語で前に出した CG の後ろ、見出しは直下のフォルダ", () => {
    const extra = {
      cgAuto: { folder: "stills", groups: { ep1: "第一章" } },
      cg: [
        { id: "a", group: "第一章", images: ["stills/ep1/a.png", "stills/ep1/a2.png"] },
        { id: "c", group: "ep2", images: ["stills/ep2/c.png"] },
      ],
    };
    const shown = ["bg/room.png", "stills/ep1/a.png", "stills/ep1/b.png", "stills/ep1/b2.png", "stills/ep2/c.png", "stills/ep2/d.png", "stills/top.png"];
    const cg = expandExtra(extra, shown)!.cg!;
    expect(cg.map((c) => `${c.id}:${c.group ?? ""}`)).toEqual(["a:第一章", "auto:stills/ep1/b.png:第一章", "auto:stills/ep1/b2.png:第一章", "c:ep2", "auto:stills/ep2/d.png:ep2", "auto:stills/top.png:"]);
    expect(cg[1]).toMatchObject({ images: ["stills/ep1/b.png"], auto: true });
    // 書いたものはそのまま（同じもの）
    expect(cg[0]).toBe(extra.cg[0]);
    // cgAuto が無ければそのまま
    const plain = { cg: extra.cg };
    expect(expandExtra(plain, shown)).toBe(plain);
  });

  it("cgAuto: 前に出した CG の見出しが違えば、同じ見出しの並びに入れる", () => {
    const extra = {
      cgAuto: { folder: "stills" },
      cg: [
        { id: "a", group: "ep1", images: ["stills/ep1/a.png"] },
        { id: "b", group: "ep2", images: ["stills/ep2/b.png"] },
        { id: "c", group: "ep2", images: ["stills/ep2/c.png"] },
      ],
    };
    // ep2 の途中で ep1 の CG を回想として出し、その後に ep2 の新しい画像
    const cg = expandExtra(extra, ["stills/ep2/b.png", "stills/ep1/a.png", "stills/ep2/new.png", "stills/ep2/c.png"])!.cg!;
    expect(cg.map((c) => c.id)).toEqual(["a", "b", "auto:stills/ep2/new.png", "c"]);
    // 同じ見出しが前に無ければ、その見出しの最初の前
    const first = expandExtra(extra, ["stills/ep1/a.png", "stills/ep2/new.png", "stills/ep2/b.png"])!.cg!;
    expect(first.map((c) => c.id)).toEqual(["a", "auto:stills/ep2/new.png", "b", "c"]);
  });

  it("cgAuto の形の崩れはエラー。cgAuto のフォルダの画像の @cg-unlock は警告しない", () => {
    expect(checkExtra({ cgAuto: { groups: {} } }, scripts({})).map((d) => d.code)).toEqual(["bad-extra"]);
    expect(checkExtra({ cgAuto: { folder: "s", groups: { a: 1 } } }, scripts({})).map((d) => d.code)).toEqual(["bad-extra"]);
    const warnings = checkExtra({ cg: [], cgAuto: { folder: "stills" } }, scripts({ s: "@cg-unlock stills/a.png\n@cg-unlock other/b.png" }));
    expect(warnings.map((d) => d.line)).toEqual([2]);
  });

  it("用語集と章の形の誤り・章の始まりが無いこと・一覧に無い用語の @glossary-unlock", () => {
    const extra = {
      glossary: [{ id: "a", term: "", description: "説明" }, { id: "b", term: "語", description: "説明", aliases: [""] }],
      chapters: [{ id: "c", title: "章", target: "s#nope" }, { id: "d", title: "", target: "missing" }],
    };
    const messages = checkExtra(extra, scripts({ s: "# start\n@glossary-unlock a\n@glossary-unlock zz" })).map((d) => d.message);
    expect(messages).toEqual([
      "extra.glossary a に term（用語）がありません",
      "extra.glossary b の aliases は文字列の配列で書きます",
      "extra.chapters c の target のラベル #nope が s にありません",
      "extra.chapters d に title がありません",
      "extra.chapters d の target のファイル missing がありません",
      "用語 zz が liminalia.json の extra.glossary にありません（おまけに表示されません）",
    ]);
  });

  it("数を数える実績: goal は 1 以上の整数。@achieve-progress は一覧に無い名前と goal の無い実績を警告する", () => {
    const extra = { achievements: [{ id: "reads", title: "読書家", goal: 10 }, { id: "star", title: "星" }, { id: "bad", title: "壊れた", goal: 1.5 }] };
    expect(achievementGoals(extra)).toEqual({ reads: 10, bad: 1.5 });
    const messages = checkExtra(extra, scripts({ s: "@achieve-progress reads\n@achieve-progress star\n@achieve-progress nope" })).map((d) => d.message);
    expect(messages).toEqual([
      "extra.achievements bad の goal は 1 以上の整数で書きます",
      "実績 star に goal（数える目標）がありません（数を進めても解除されません）",
      "実績 nope が liminalia.json の extra.achievements にありません（おまけに表示されません）",
    ]);
  });
});
