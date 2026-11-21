import { describe, expect, it } from "vitest";
import { parseInline, printInline, speechOpenAt, stripSpeechQuotes, unquoteSpeech } from "../src/index.ts";

const strip = (src: string) => printInline(stripSpeechQuotes(parseInline(src).content));

describe("台詞の始まり", () => {
  it("括弧はすぐ後だけ、引用符は半角の空白を一つ挟んでもよい", () => {
    expect(speechOpenAt("ユイ「a」", 2)).toBe(2);
    expect(speechOpenAt("ユイ 「a」", 2)).toBe(-1);
    expect(speechOpenAt('Yui "a"', 3)).toBe(4);
    expect(speechOpenAt('Yui"a"', 3)).toBe(3);
    expect(speechOpenAt("Yui “a”", 3)).toBe(4);
    expect(speechOpenAt('Yui  "a"', 3)).toBe(-1);
    expect(speechOpenAt("Yui 'a'", 3)).toBe(-1);
  });
});

describe("外側の引用符を外す（ui.text.quotes: strip）", () => {
  it("外側の一組の “” \"\" 「」 『』 を外し、（）と () は残す", () => {
    expect(strip('"Hello."')).toBe("Hello.");
    expect(strip("“Wait for me!”")).toBe("Wait for me!");
    expect(strip("「おはよう」")).toBe("おはよう");
    expect(strip("『遠い声』")).toBe("遠い声");
    expect(strip("（心の声）")).toBe("（心の声）");
    expect(strip("(aside)")).toBe("(aside)");
  });

  it("途中で閉じるもの、閉じていないもの、端がルビや式の値のものは外さない", () => {
    expect(strip("「あ」「い」")).toBe("「あ」「い」");
    expect(strip('"a" and "b"')).toBe('"a" and "b"');
    expect(strip('"Hello')).toBe('"Hello');
    expect(strip("「あ」と言った")).toBe("「あ」と言った");
    expect(strip("{r 漢|かん}」")).toBe("{r 漢|かん}」");
    expect(strip('"{= game.name}')).toBe('"{= game.name}');
  });

  it("入れ子の括弧は残し、飾りの中・本文の中のコマンド・{noclick} を越えて外す", () => {
    expect(strip("「『夢』だった」")).toBe("『夢』だった");
    expect(strip("“She said ‘hi’.”")).toBe("She said ‘hi’.");
    expect(strip("{b “Run!”}")).toBe("{b Run!}");
    expect(strip('"Wait{click} for me."{noclick}')).toBe("Wait{click} for me.{noclick}");
    expect(strip('{@voice yui/1}"Hi."')).toBe("{@voice yui/1}Hi.");
    expect(strip('"{b Hi}."')).toBe("{b Hi}.");
  });

  it("文字列の版（文字数の集計などに使う）", () => {
    expect(unquoteSpeech("“Hi.”")).toBe("Hi.");
    expect(unquoteSpeech('"a" "b"')).toBe('"a" "b"');
    expect(unquoteSpeech("（心の声）")).toBe("（心の声）");
  });
});
