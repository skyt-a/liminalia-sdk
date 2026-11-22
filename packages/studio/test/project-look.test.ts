import { describe, expect, it } from "vitest";
import { chooseCover, firstBackground, storyLineAt, storyText, titleHue } from "../src/project-look.ts";

describe("作品の顔（制作アプリのはじめの画面とスマホ版の入口）", () => {
  it("題名の絵を表紙に選び、ボタンやロゴは選ばない", () => {
    expect(chooseCover(["a/room.png", "ui/title_button.png", "ui/title_mayu.png"])).toBe("ui/title_mayu.png");
    expect(chooseCover(["scene/a/cover_room.png", "ui/title_mayu.png"])).toBe("ui/title_mayu.png");
    expect(chooseCover(["hill_dusk.webp", "hill_night.webp"])).toBe("hill_dusk.webp");
    expect(chooseCover(["notes.txt", "logo.png"])).toBeNull();
    // 語の途中の title は題名の絵と見ない
    expect(chooseCover(["a.png", "subtitle.png"])).toBe("a.png");
    expect(chooseCover(["a.png", "b/hill.webp"], "hill.webp")).toBe("b/hill.webp");
    expect(chooseCover(["a.png", "ui/title.png"], "a.png")).toBe("ui/title.png");
    expect(firstBackground("@define s(image: string)\n@bg (image)\n@end\n@bg hill_dusk.webp\n")).toBe("hill_dusk.webp");
  });

  it("本文だけを読み、ルビと命令を除く", () => {
    expect(storyText("@chara アカリ normal")).toBeNull();
    expect(storyText("# start")).toBeNull();
    expect(storyText("// 注釈")).toBeNull();
    expect(storyText("- 行く -> next")).toBeNull();
    expect(storyText("{click}")).toBeNull();
    // 中身のまだ無い台詞は見せない
    expect(storyText("アカリ「」")).toBeNull();
    expect(storyText('Akari ""')).toBeNull();
    expect(storyText("アカリ「着いた……っ」")).toEqual({ speaker: "アカリ", text: "「着いた……っ」" });
    // 英語の台詞（引用符。前の半角の空白一つは本文に入れない）
    expect(storyText('Akari "Made it!"')).toEqual({ speaker: "Akari", text: '"Made it!"' });
    expect(storyText("Akari“Made it!”")).toEqual({ speaker: "Akari", text: "“Made it!”" });
    expect(storyText('Note: "x"')).toEqual({ speaker: null, text: 'Note: "x"' });
    expect(storyText("　今夜は{r 流星群|りゅうせいぐん}が来る。{click}……らしい。")).toEqual({ speaker: null, text: "今夜は流星群が来る。……らしい。" });
    expect(storyText("あ".repeat(130))?.text).toHaveLength(121);
  });

  it("指定の行の少し前の本文を引き、無ければ後ろを探す", () => {
    const source = "@bg a\n一行目\n@se b\n\n# label\n三行目\n";
    expect(storyLineAt(source, 5, "episode.lim", true)).toEqual({ speaker: null, text: "一行目", file: "episode", line: 2, resume: true });
    expect(storyLineAt("// 注釈\n@bg a\n本文\n", 1, "start", false)).toMatchObject({ text: "本文", line: 3, resume: false });
    expect(storyLineAt(source, 999, "x", true)?.text).toBe("三行目");
    expect(storyLineAt("@bg a\n", 1, "x", true)).toBeNull();
  });

  it("題名から決まった色相を返す", () => {
    expect(titleHue("星を待つ丘")).toBe(titleHue("星を待つ丘"));
    expect(titleHue("星を待つ丘")).toBeLessThan(360);
  });
});
