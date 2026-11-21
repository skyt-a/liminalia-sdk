import type { CompletionItem } from "vscode-languageserver";
import { describe, expect, it } from "vitest";
import { completions } from "../src/features.ts";
import { start } from "./helpers.ts";

/** start.lim を text にしたときの、‸ の位置の補完の候補の名前。 */
async function labels(text: string): Promise<string[]> {
  return (await items(text)).map((i) => i.label);
}

async function items(text: string): Promise<CompletionItem[]> {
  const { project, pos } = await start(text);
  return completions(project, "start", pos);
}

const editOf = (item: CompletionItem | undefined) => (item?.textEdit && "range" in item.textEdit ? item.textEdit : null);

describe("命令の名前", () => {
  it("@ のあとに組み込み・標準・プラグインの命令と、@use したファイルの部品", async () => {
    const list = await items("@use common\n@‸");
    const names = list.map((i) => i.label);
    expect(names).toEqual(expect.arrayContaining(["bg", "chara", "jump", "if", "glint", "title-card"]));
    expect(list.find((i) => i.label === "bg")?.detail).toBe("背景を切り替える");
    expect(list.find((i) => i.label === "title-card")?.detail).toBe("common の @define");
    // @define のすぐ上の // の行はマクロの要約として説明に出す
    const doc = list.find((i) => i.label === "title-card")?.documentation;
    expect(typeof doc === "object" ? doc.value : "").toContain("共通の部品");
  });

  it("英語の表示では、命令の説明も英語（英語の無いものは日本語）", async () => {
    const { project, pos } = await start("@use common\n@‸");
    const list = completions(project, "start", pos, "en");
    expect(list.find((i) => i.label === "bg")?.detail).toBe("Change the background");
    expect(list.find((i) => i.label === "if")?.detail).toBe("Conditional branch. Add @elif and @else as needed and close with @end");
    expect(list.find((i) => i.label === "title-card")?.detail).toBe("@define in common");
    expect(list.find((i) => i.label === "glint")?.detail).toBe("画面を一瞬光らせる");
    const doc = list.find((i) => i.label === "quake")?.documentation;
    expect(typeof doc === "object" ? doc.value : "").toContain("| count | Integer (1 or more) | `5` | Number of shakes |");
    const args = await (async () => {
      const s = await start("@bg room_night.jpg ‸");
      return completions(s.project, "start", s.pos, "en");
    })();
    const time = args.find((i) => i.label === "time=");
    expect(time?.detail).toBe("Duration");
    expect(typeof time?.documentation === "object" ? time.documentation.value : "").toContain("Transition time");
  });

  it("書きかけの名前を置き換える範囲", async () => {
    const item = (await items("  @ch‸")).find((i) => i.label === "chara");
    expect(editOf(item)?.range).toEqual({ start: { line: 0, character: 3 }, end: { line: 0, character: 5 } });
  });

  it("@use していないファイルの部品は出さない", async () => {
    expect(await labels("@‸")).not.toContain("title-card");
  });

  it("本文の中の {@ では、制御の命令を出さない", async () => {
    const names = await labels("ユイ「待って{@‸}」");
    expect(names).toContain("chara");
    expect(names).not.toContain("if");
  });
});

describe("引数", () => {
  it("引数の名前（位置引数と書いたものは除く）", async () => {
    const names = await labels("@bg room_night.jpg time=1s ‸");
    expect(names).toEqual(expect.arrayContaining(["method=", "cross=", "wait="]));
    expect(names).not.toContain("time=");
    expect(names).not.toContain("image=");
  });

  it("選べる値・真偽", async () => {
    expect(await labels("@bg room_night.jpg method=‸")).toEqual(expect.arrayContaining(["crossfade", "fadeIn"]));
    expect(await labels("@bg room_night.jpg cross=‸")).toEqual(["true", "false"]);
  });

  it("素材のファイル（位置引数）", async () => {
    expect(await labels("@bg ‸")).toEqual(expect.arrayContaining(["room_night.jpg", "room/morning.png", "method="]));
    expect(await labels("@bgm ‸")).toContain("theme.ogg");
  });

  it("キャスト・差分・立ち絵セット・立ち位置", async () => {
    expect(await labels("@chara ‸")).toEqual(expect.arrayContaining(["ユイカ", "レン"]));
    expect(await labels("@chara ユイカ ‸")).toEqual(expect.arrayContaining(["normal", "smile", "appearance=", "at="]));
    expect(await labels("@chara ユイカ normal appearance=‸")).toEqual(["default", "casual"]);
    expect(await labels("@chara ユイカ normal at=‸")).toEqual(["left", "center", "right", "far", "auto"]);
    expect(await labels("@chara ユイカ normal appearance=casual at=‸")).toEqual(["center", "auto"]);
  });

  it("プラグインの命令の引数（どの命令の行にも if= を出す）", async () => {
    expect(await labels("@glint ‸")).toEqual(["color=", "time=", "if="]);
    expect(await labels("@glint if=(game.x) ‸")).toEqual(["color=", "time="]);
  });

  it("@use したファイルの部品の引数", async () => {
    expect(await labels("@use common\n@title-card ‸")).toEqual(["text=", "time=", "if="]);
  });

  it("本文の中の命令には if= を出さない。@for と @function、出し分けの書き方も出す", async () => {
    expect(await labels("レン「待って{@chara ユイカ ‸}」")).not.toContain("if=");
    expect(await labels("@‸")).toEqual(expect.arrayContaining(["for", "function"]));
    expect(await labels("ユイカ「{‸」")).toEqual(expect.arrayContaining(["{seq", "{cycle", "{once", "{shuffle"]));
  });

  it("本文の中の命令の引数", async () => {
    expect(await labels("レン「待って{@chara ユイカ ‸}」")).toContain("smile");
  });

  it("NVL の見た目と色調の名前には、作品の ui.nvlStyles と ui.tones の名前を出す（制作画面と同じ）", async () => {
    expect(await labels("@nvl on style=‸")).toEqual(["letter", "terminal"]);
    expect(await labels("@tone ‸")).toEqual(expect.arrayContaining(["sepia", "none", "dusk"]));
    expect(await labels("@bg room_night.jpg tone=‸")).toContain("dusk");
  });
});

describe("前の名前と名前なしの時間（2026-11-19 の L12）", () => {
  it("fade= や名前なしの時間を書いた行では、time= を候補に出さない（検査と同じ読み方）", async () => {
    for (const text of ["@mask 600ms ‸", "@stop-se 1s ‸", "@bg room_night.jpg fade=1s ‸", "地の文{@chara-hide-all 300ms ‸}"]) {
      expect(await labels(text), text).not.toContain("time=");
    }
    // 書いていなければ出す
    expect(await labels("@mask ‸")).toContain("time=");
  });
});

describe("飛び先", () => {
  it("@jump のあとに、このファイルのラベル・ファイル・ファイル#ラベル", async () => {
    const names = await labels("# start\n# north_road\n@jump ‸");
    expect(names).toEqual(expect.arrayContaining(["#start", "#north_road", "common", "chapter2", "chapter2#south", "common#interlude"]));
  });

  it("ファイル# のあとにはそのファイルのラベルだけ", async () => {
    const list = await items("@call common#in‸");
    expect(list.map((i) => i.label)).toEqual(["common#interlude"]);
    expect(editOf(list[0])?.range).toEqual({ start: { line: 0, character: 6 }, end: { line: 0, character: 15 } });
  });

  it("選択肢の -> のあと", async () => {
    expect(await labels("# here\n@choice\n- 行く -> #‸\n@end")).toEqual(["#here"]);
  });

  it("選択肢の飛び先のあとは選択肢の引数", async () => {
    expect(await labels("@choice\n- 行く -> #here ‸\n@end")).toEqual(expect.arrayContaining(["if=", "image=", "x="]));
  });

  it("@use のあとにファイル", async () => {
    expect(await labels("@use ‸")).toEqual(["chapter2", "common"]);
  });
});

describe("本文", () => {
  it("行頭に話者の名前（括弧も入れる）", async () => {
    const list = await items("ユ‸");
    expect(list.map((i) => i.label)).toEqual(["ユイ", "レン", "？？？"]);
    expect(editOf(list[0])?.newText).toBe("ユイ「$0」");
  });

  it("原文が英語の作品（languages の先頭が en）では、引用符の台詞の形を入れる。引用符を打った後には出さない", async () => {
    const { project, pos } = await start("ユ‸");
    project.update({ ...project.input, config: { ...project.input.config, languages: ["en", "ja"] } });
    expect(editOf(completions(project, "start", pos)[0])?.newText).toBe('ユイ "$0"');
    expect(await labels('ユイ "‸')).toEqual([]);
    expect(await labels("ユイ“‸")).toEqual([]);
  });

  it("後ろに括弧があれば名前だけ", async () => {
    const list = await items("ユ‸「おはよう」");
    expect(editOf(list[0])?.newText).toBe("ユイ");
  });

  it("地の文の途中では出さない", async () => {
    expect(await labels("　窓の外では‸")).toEqual([]);
    expect(await labels("// メモ‸")).toEqual([]);
  });

  it("{ のあとに本文の中の書き方", async () => {
    const names = await labels("ユイ「{‸」");
    expect(names).toEqual(expect.arrayContaining(["{r", "{br", "{=", "{@"]));
  });

  it("@script の中では何も出さない", async () => {
    expect(await labels("@script\n@‸\n@end")).toEqual([]);
  });
});
