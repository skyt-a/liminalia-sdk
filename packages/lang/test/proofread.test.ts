import { describe, expect, it } from "vitest";
import { aozoraToRuby, applyProse, parse, proseDocument, proseEntries, readProseDocument, rubyToAozora, scriptExportHtml, scriptExportText } from "../src/index.ts";

const speakers = ["ユイ", "Yui"];
const source = [
  "# start",
  "@bg room.jpg",
  "  {r 漢字|かんじ}を読む。{click}続き",
  "ユイ「おはよう、{= game.name}」",
  "ユイ{name ？？？}「誰？」",
  "@if game.a",
  "  　枝の中の地の文。",
  "@end",
  "@choice",
  "  - 北へ行く -> #north if=(game.n > 0)",
  "@end",
  "# north",
  "Yui \"Hi.\"",
].join("\n");

describe("《》のルビ", () => {
  it("｜親文字《よみ》と 漢字《かな》を {r} にし、{r} を ｜《》 にする（題の《》は変えない）", () => {
    expect(aozoraToRuby("｜漢字《かんじ》と東京《とうきょう》、絵画《星月夜》")).toBe("{r 漢字|かんじ}と{r 東京|とうきょう}、絵画《星月夜》");
    expect(rubyToAozora("{r 漢字|かんじ}を{b 読む}")).toBe("｜漢字《かんじ》を{b 読む}");
    expect(aozoraToRuby(rubyToAozora("{r 漢字|かんじ}"))).toBe("{r 漢字|かんじ}");
  });
});

describe("校正用の台本", () => {
  it("テキストは本文とシーンの見出しだけを、話者名を添え、ルビは《》で（コマンドとクリック待ちは出さない）", () => {
    const text = scriptExportText("start", parse(source, "start", { speakers }), { lines: false });
    expect(text.split("\n")).toEqual(["start.lim", "", "# start", "｜漢字《かんじ》を読む。続き", "ユイ「おはよう、{= game.name}」", "？？？「誰？」", "　枝の中の地の文。", "選択肢: 北へ行く", "", "# north", 'Yui "Hi."', ""]);
    expect(scriptExportText("start", parse(source, "start", { speakers }), { lines: true })).toContain("4\tユイ「おはよう、{= game.name}」");
  });

  it("HTML はルビを <ruby> に、話者名を太字に、行番号を添える", () => {
    const html = scriptExportHtml("start", parse(source, "start", { speakers }));
    expect(html).toContain("<ruby>漢字<rt>かんじ</rt></ruby>を読む。続き");
    expect(html).toContain('<p class="say"><span class="no">4</span><b>ユイ</b>「おはよう、<code>{= game.name}</code>」</p>');
    expect(html).toContain("<title>start.lim</title>");
  });
});

describe("本文の抜き出しと書き戻し（lim prose）", () => {
  it("本文の行だけを鍵付きで抜き出し、直したものを読み直せる", () => {
    const entries = proseEntries("start", source, speakers);
    expect(entries.map((e) => [e.line, e.text])).toEqual([
      [3, "｜漢字《かんじ》を読む。{click}続き"],
      [4, "ユイ「おはよう、{= game.name}」"],
      [5, "ユイ{name ？？？}「誰？」"],
      [7, "　枝の中の地の文。"],
      [10, "- 北へ行く"],
      [13, 'Yui "Hi."'],
    ]);
    const doc = proseDocument(entries);
    const back = readProseDocument(doc);
    expect(back.ruby).toBe("aozora");
    expect(back.entries).toEqual(entries);
    expect(back.problems).toEqual([]);
  });

  it("直した本文を書き戻し、字下げと選択肢のジャンプ先は残す。ルビは {r} に戻す", () => {
    const entries = proseEntries("start", source, speakers).map((e) => ({ ...e, text: e.text.replace("読む", "よむ").replace("おはよう", "おはよ").replace("北へ行く", "北に行く").replace("｜漢字《かんじ》", "｜漢字《かんじ》") }));
    const r = applyProse(source, entries, speakers, "aozora");
    expect(r.applied).toBe(3);
    expect(r.rejected).toEqual([]);
    const rows = r.text.split("\n");
    expect(rows[2]).toBe("  {r 漢字|かんじ}をよむ。{click}続き");
    expect(rows[3]).toBe("ユイ「おはよ、{= game.name}」");
    expect(rows[9]).toBe("  - 北に行く -> #north if=(game.n > 0)");
  });

  it("本文以外が変わったもの、元の行が変わったものは書き戻さない", () => {
    const entries = proseEntries("start", source, speakers, "lim");
    const edit = (line: number, text: string) => entries.filter((e) => e.line === line).map((e) => ({ ...e, text }));
    const cases: [number, string][] = [
      // 話者を替えた
      [4, "Yui「おはよう、{= game.name}」"],
      // 値を消した
      [4, "ユイ「おはよう」"],
      // クリック待ちを消した
      [3, "{r 漢字|かんじ}を読む。続き"],
      // コマンドの行にした
      [7, "@stop"],
      // 選択肢の頭を消した
      [10, "北へ行く"],
    ];
    for (const [line, text] of cases) expect(applyProse(source, edit(line, text), speakers).rejected.map((x) => x.reason), text).toEqual(["shape"]);
    const changed = source.replace("ユイ「おはよう", "ユイ「こんにちは");
    expect(applyProse(changed, edit(4, "ユイ「おはよ、{= game.name}」"), speakers).rejected.map((x) => x.reason)).toEqual(["stale"]);
  });
});
