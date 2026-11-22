import { describe, expect, it } from "vitest";
import { countChars, findVariants, normalizeName, parse, textStats, textUnits, updateVoiceLock, type Script } from "../src/index.ts";

const speakers = ["ユイ", "レン", "アン・ナ"];
const scripts = (files: Record<string, string>) => new Map<string, Script>(Object.entries(files).map(([k, v]) => [k, parse(v, k, { speakers })]));

describe("文字数の集計", () => {
  it("台詞と地の文と選択肢を分けて数え、ルビは親文字だけ、コマンドと空白と台詞の外側の括弧は数えない", () => {
    const s = scripts({
      a: ["　{r 黄昏|たそがれ}の空。{@wait 1s}", "ユイ「おはよう、{b 今日}は{br}早いね」", "@choice", "- 行く -> #b", "- 戻る -> #b", "@end", "# b", "レン「（小声で）……」"].join("\n"),
    });
    const st = textStats(s);
    expect(st.total.prose).toEqual({ lines: 1, chars: 5 });
    // 「おはよう、今日は早いね」→ 11 文字（改行と括弧は数えない）。「（小声で）……」は外側の括弧ではない（」で閉じていない）
    expect(st.total.say.lines).toBe(2);
    expect(st.total.say.chars).toBe(11 + countChars("（小声で）……"));
    expect(st.total.choice).toEqual({ lines: 2, chars: 4 });
    expect(st.scenes.map((x) => [x.label, x.line, x.say.lines])).toEqual([
      [null, 1, 1],
      ["b", 7, 1],
    ]);
    expect(st.speakers.map((x) => x.speaker)).toEqual(["ユイ", "レン"]);
  });

  it("ボイスの付いた台詞: @voice、本文の {@voice}、@voice-auto（止めている間は数えない）", () => {
    const src = [
      "@voice yui/001.ogg",
      "ユイ「一」",
      "ユイ「二{@voice yui/002.ogg}」",
      '@voice-auto レン pattern="ren/{n:3}.ogg"',
      "レン「三」",
      "@voice-auto-off レン",
      "レン「四」",
      "@voice-auto レン",
      "レン「五」",
      "ユイ「六」",
    ].join("\n");
    const st = textStats(scripts({ a: src }));
    expect(st.total.voiced).toBe(4);
    expect(st.speakers.find((x) => x.speaker === "レン")?.voiced).toBe(2);
  });

  it("番号の固定があれば、固定に無い自動のボイスの台詞は数えない", () => {
    const s = scripts({ a: '@voice-auto レン pattern="ren/{n}.ogg"\nレン「一」\nレン「二」' });
    const lock = updateVoiceLock(null, s, new Set(["レン"])).lock;
    const one = new Map(s);
    expect(textStats(one, lock).total.voiced).toBe(2);
    const added = scripts({ a: '@voice-auto レン pattern="ren/{n}.ogg"\nレン「一」\nレン「二」\nレン「足した台詞」' });
    expect(textStats(added, lock).total.voiced).toBe(2);
  });
});

describe("表記ゆれ", () => {
  const units = (lines: string[]) => textUnits(scripts({ a: lines.join("\n") }));

  it("漢字とかな、送り仮名、記号、全角と半角の揺れを組にし、多い書き方を先に出す", () => {
    const u = units(["それなら出来る。", "わたしにもできる。", "もうできない。", "話は終った。", "全部終わりだ。", "……え", "・・・え", "本当！？", "本当!?", "〜だね", "〜かな", "～よ"]);
    const v = findVariants(u);
    const byId = new Map(v.map((g) => [g.id, g]));
    expect(byId.get("kana:できる")?.forms.map((f) => [f.label, f.count])).toEqual([
      ["できる", 2],
      ["出来る", 1],
    ]);
    expect(byId.get("okurigana:終わる")?.forms.map((f) => f.count)).toEqual([1, 1]);
    expect(byId.get("symbol:三点リーダー")?.forms.map((f) => f.label)).toEqual(["…", "・・・"]);
    expect(byId.get("symbol:感嘆疑問")?.forms.map((f) => f.label).sort()).toEqual(["!?", "！？"]);
    expect(byId.get("width:波ダッシュ")?.forms.map((f) => [f.label, f.count])).toEqual([
      ["〜", 2],
      ["～", 1],
    ]);
    // 場所と抜き出し
    expect(byId.get("kana:できる")?.forms[1]?.occurrences[0]).toMatchObject({ file: "a", line: 1, text: "出来る", excerpt: "それなら出来る。" });
  });

  it("一つの書き方しか使っていなければ出さない。別の語の一部（出来事）は数えない", () => {
    expect(findVariants(units(["出来事があった。", "できる。"]))).toEqual([]);
  });

  it("辞書で組を足し、組や種類を外せる", () => {
    const u = units(["ユイは猫が好き。", "ゆいは猫がすき。", "出来る", "できる", "……", "..."]);
    const v = findVariants(u, { dictionary: { add: [["好き", "すき"]], ignore: ["できる"], off: ["symbol"] } });
    expect(v.map((g) => g.id)).toEqual(["custom:好き"]);
  });

  it("辞書の空の書き方は組から除く（空の書き方だけになった組は出さない）", () => {
    const u = units(["好きだ。", "すきだ。"]);
    // 空の書き方はどこにも当たるので、探し始めると読み進めが止まる（止まらないことが確かめたい）
    expect(findVariants(u, { dictionary: { add: [["", "好き", "すき"]] } }).map((g) => g.id)).toEqual(["custom:好き"]);
    expect(findVariants(u, { dictionary: { add: [["", "好き"]] } })).toEqual([]);
  });

  it("少ない書き方には、多い書き方にそろえる置換を付ける", () => {
    const u = units(["それなら出来る。", "わたしにもできる。", "もうできない。", "……え", "・・・え", "…", "私達は", "私たちは", "僕たち", "凄い", "すごい", "すごく", "有難う", "ありがとう", "ありがとう", "全角の数字は１", "半角は2と3"]);
    const byId = new Map(findVariants(u).map((g) => [g.id, g]));
    const fix = (id: string) => byId.get(id)?.forms.map((f) => f.replace ?? null);
    // 違う所だけを、後ろの字を確かめて置き換える（出来事の「出来」は変えない）
    expect(fix("kana:できる")).toEqual([null, { query: "出来(?=る|ない|た|ます|て|れ|な)", regex: true, text: "でき" }]);
    expect(fix("symbol:三点リーダー")).toEqual([null, { query: "[・･]{3,}", regex: true, text: "…" }]);
    expect(fix("kana:たち")).toEqual([null, { query: "(?<=私|僕|俺|君|彼女)達", regex: true, text: "たち" }]);
    expect(fix("kana:すごい")).toEqual([null, { query: "凄(?=い|く)", regex: true, text: "すご" }]);
    expect(fix("kana:ありがとう")).toEqual([null, { query: "有り難う|有難う", regex: true, text: "ありがとう" }]);
    // 書き方が一つに決まらないもの（全角の数字／半角の数字）は付けない
    expect(fix("width:数字")).toEqual([null, null]);
    const re = new RegExp(byId.get("kana:できる")!.forms[1]!.replace!.query, "g");
    expect("出来事が出来ない".replace(re, "でき")).toBe("出来事ができない");
  });

  it("用語集の語と別表記を組にする", () => {
    const u = units(["月の都へ行く。", "月の都は遠い。", "ルナリアの夜。"]);
    const v = findVariants(u, { glossary: [{ term: "月の都", aliases: ["ルナリア"] }, { term: "星", aliases: [] }] });
    expect(v.map((g) => [g.id, g.kind, g.forms.map((f) => [f.label, f.count, f.replace?.text ?? null])])).toEqual([["glossary:月の都", "glossary", [["月の都", 2, null], ["ルナリア", 1, "月の都"]]]]);
    expect(findVariants(u, { glossary: [{ term: "月の都", aliases: ["ルナリア"] }], dictionary: { off: ["glossary"] } })).toEqual([]);
  });

  it("話者の名前の揺れ（ひらがなとカタカナ、中点）を、台詞の話者と本文から見つける", () => {
    expect(normalizeName("アン・ナ")).toBe(normalizeName("あんな"));
    const s = new Map<string, Script>([["a", parse("ユイ「アンナはどこ？」\nアン・ナ「ここよ」\nゆい「よかった」", "a", { speakers: [...speakers, "ゆい"] })]]);
    const v = findVariants(textUnits(s), { speakers: [...speakers, "ゆい"] });
    const names = v.filter((g) => g.kind === "name").map((g) => g.forms.map((f) => f.label).sort());
    expect(names).toEqual(expect.arrayContaining([["アンナ", "アン・ナ"], ["ゆい", "ユイ"]]));
  });
});
