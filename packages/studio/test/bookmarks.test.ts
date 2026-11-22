import { describe, expect, it } from "vitest";
import { moveBookmarks, placeBookmarks, storeBookmark } from "../src/model/bookmarks.ts";

/** ブックマークを、開いていないファイルがほかで書き換えられたときに付け直す（model/bookmarks.ts）。 */
describe("ブックマークの付け直し", () => {
  const before = ["# a", "　一行目。", "アカリ「二行目」", "　ここで終わる。"];

  it("上に行を足しても、同じ中身の行に付いたまま動く", () => {
    const marks = [storeBookmark(2, before[1]!), storeBookmark(4, before[3]!)];
    const after = ["# a", "@bg sky.png", "　足した行。", ...before.slice(1)];
    const r = placeBookmarks(marks, after);
    expect(r.changed).toBe(true);
    expect(r.marks.map((m) => [m.line, m.text])).toEqual([
      [4, "一行目。"],
      [6, "ここで終わる。"],
    ]);
  });

  it("書き換えた行は似ている行へ、見つからなければ元の行番号のまま（行の数までに縮める）", () => {
    const marks = [storeBookmark(3, before[2]!), storeBookmark(4, before[3]!)];
    const r = placeBookmarks(marks, ["# a", "　一行目。", "アカリ「二行目だよ」"]);
    expect(r.marks.map((m) => [m.line, m.text])).toEqual([[3, "アカリ「二行目だよ」"]]);
  });

  it("変わっていなければ changed は false。ハッシュを持たない前の版の印は、一覧の字で始まる行ならそのまま", () => {
    const marks = [storeBookmark(2, before[1]!)];
    expect(placeBookmarks(marks, before).changed).toBe(false);
    const long = `　${"長い行。".repeat(40)}`;
    const old = [{ line: 2, text: long.trim().slice(0, 80) }];
    const r = placeBookmarks(old, ["# a", long]);
    expect(r.marks).toEqual([storeBookmark(2, long)]);
  });

  it("行を別のファイルへ移すと、移した行の印は移した先へ（移さない行の印は元のファイルのまま）", () => {
    const a = ["# one", "　一。", "# two", "　二。"].join("\n");
    const marks = { a: [storeBookmark(2, "　一。"), storeBookmark(4, "　二。")], c: [storeBookmark(1, "x")] };
    const after = new Map([
      ["a", { text: ["# one", "　一。", "@jump b#two"].join("\n"), origin: [{ file: "a", line: 1 }, { file: "a", line: 2 }, null] }],
      ["b", { text: ["# b", "", "# two", "　二。"].join("\n"), origin: [null, null, { file: "a", line: 3 }, { file: "a", line: 4 }] }],
    ]);
    const moved = moveBookmarks(marks, new Map([["a", a]]), after)!;
    expect(Object.fromEntries(Object.entries(moved).map(([f, list]) => [f, list.map((m) => m.line)]))).toEqual({ a: [2], b: [4], c: [1] });
    expect(moveBookmarks({ c: marks.c }, new Map([["a", a]]), after)).toBeNull();
  });
});
