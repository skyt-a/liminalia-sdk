import { describe, expect, it } from "vitest";
import { checkTranslation, dataTextKey, dataTranslatables, parse, updateTranslation, type DataDeclaration } from "../src/index.ts";

/** 作品のデータ（data/*.json）の、訳す印（translate）の付いた文を訳のファイルに並べる。 */

const decl: DataDeclaration = {
  file: "notes.json",
  title: "メモ",
  root: {
    kind: "list",
    of: {
      kind: "record",
      fields: {
        id: { kind: "string" },
        title: { kind: "string", translate: true },
        titleEn: { kind: "string" },
        body: { kind: "string", multiline: true, translate: true },
        image: { kind: "asset", folder: "image" },
      },
    },
  },
};
const value = [
  { id: "a", title: "丘", titleEn: "Hill", body: "坂の上。", image: "hill.png" },
  { id: "b", title: "駅", body: "" },
];
const data = [{ decl, value }];
const scripts = new Map([["start", parse("はじまり。\n", "start")]]);

describe("作品のデータの訳", () => {
  it("訳す印の付いた空でない文を集め、英語の欄があれば添える", () => {
    expect(dataTranslatables(data)).toEqual([
      { file: "notes.json", source: "丘", note: "/0/title", en: "Hill" },
      { file: "notes.json", source: "坂の上。", note: "/0/body" },
      { file: "notes.json", source: "駅", note: "/1/title" },
    ]);
  });

  it("lim i18n の訳のファイルに並べ（英語は英語の欄のあるものを除く）、データを渡さなければ今ある訳をそのまま残す", () => {
    const ko = updateTranslation(null, "ko", scripts, [], { data: dataTranslatables(data) }).file;
    expect(ko.lines![dataTextKey("notes.json", "丘")]).toEqual({ source: "丘", text: "", note: "data/notes.json /0/title" });
    expect(Object.keys(ko.lines!).filter((k) => k.startsWith("data/"))).toHaveLength(3);
    const en = updateTranslation(null, "en", scripts, [], { data: dataTranslatables(data) }).file;
    expect(Object.keys(en.lines!).filter((k) => k.startsWith("data/"))).toHaveLength(2);
    // 訳を書いたあと、データを渡さずに合わせ直しても（制作画面の古い版など）、データの訳は残る
    ko.lines![dataTextKey("notes.json", "丘")]!.text = "언덕";
    const again = updateTranslation(ko, "ko", scripts, []).file;
    expect(again.lines![dataTextKey("notes.json", "丘")]!.text).toBe("언덕");
    expect(again.stale).toBeUndefined();
    // データを渡さない検査は、データの訳を「使われていない」と数えない
    expect(checkTranslation(again, "lang/ko.json", scripts, { project: {} }).map((d) => d.code)).not.toContain("unused-translation");
    expect(checkTranslation(again, "lang/ko.json", scripts, { project: {}, data: dataTranslatables([{ decl, value: [] }]) }).map((d) => d.code)).toContain("unused-translation");
  });
});
