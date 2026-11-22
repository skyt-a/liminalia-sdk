import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pageKeys, parse, textHash } from "@liminalia/lang";
import { loadProject, type Project } from "@liminalia/project";
import { applyReview, feedbackShot, importFeedback, listReviews, REVIEWS_DIR } from "../src/server/reviews.ts";
import { writeStudioState } from "../src/server/studio-state.ts";
import { locateReview, openReviews, placeReviews } from "../src/model/reviews.ts";
import type { ReviewThread } from "../src/protocol.ts";

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");

describe("レビューのコメントの行を探す", () => {
  const thread = (line: number, text: string): Pick<ReviewThread, "line" | "text" | "hash"> => ({ line, text, hash: textHash(text) });
  const lines = ["# a", "一行目。", "@bg room.png", "二行目の本文。", "三行目。"];

  it("同じ行・動いた行（中身のハッシュ）・書き換えた行（似ている行）・見つからない行", () => {
    expect(locateReview(thread(4, "二行目の本文。"), lines)).toEqual({ line: 4, to: 4, exact: true });
    expect(locateReview(thread(2, "二行目の本文。"), lines)).toEqual({ line: 4, to: 4, exact: true });
    expect(locateReview(thread(4, "二行目の本文だよ。"), lines)).toEqual({ line: 4, to: 4, exact: false });
    expect(locateReview(thread(4, "まったく別の文"), lines)).toBeNull();
  });

  it("範囲に付けたものは最後の行も探し、見つからなければ付けたときの行の数だけ後ろまで", () => {
    const range = (line: number, text: string, end: number, endText: string) => ({ ...thread(line, text), end: { line: end, text: endText, hash: textHash(endText) } });
    expect(locateReview(range(2, "一行目。", 4, "二行目の本文。"), lines)).toEqual({ line: 2, to: 4, exact: true });
    // 間に行が増えた
    expect(locateReview(range(2, "一行目。", 4, "二行目の本文。"), ["# a", "一行目。", "足した行", "@bg room.png", "二行目の本文。"])).toEqual({ line: 2, to: 5, exact: true });
    // 最後の行が消えた
    expect(locateReview(range(2, "一行目。", 4, "消した行"), lines)).toEqual({ line: 2, to: 4, exact: false });
  });

  it("同じ中身の行が幾つもあれば、元の行に近いもの", () => {
    const twice = ["同じ。", "a", "b", "c", "同じ。"];
    expect(locateReview(thread(4, "同じ。"), twice)).toEqual({ line: 5, to: 5, exact: true });
    expect(locateReview(thread(2, "同じ。"), twice)).toEqual({ line: 1, to: 1, exact: true });
  });

  it("ファイルのスレッドを行ごとにまとめ、未解決を数える", () => {
    const t = (id: string, file: string, line: number, text: string, resolved = false): ReviewThread => ({ id, file, line, text, hash: textHash(text), resolved, comments: [] });
    const all = [t("a", "start", 4, "二行目の本文。"), t("b", "start", 1, "# a", true), t("c", "other", 1, "x"), t("d", "start", 9, "無い行")];
    const r = placeReviews(all, "start", lines);
    expect([...r.byLine].map(([l, ts]) => [l, ts.map((x) => x.id)])).toEqual([
      [4, ["a"]],
      [1, ["b"]],
    ]);
    expect(r.lost.map((x) => x.id)).toEqual(["d"]);
    expect(openReviews(all)).toBe(3);
  });
});

describe("レビューのコメントの保存（reviews/）", () => {
  let dir: string;
  let project: Project;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "liminalia-reviews-"));
    cpSync(TEMPLATE, dir, { recursive: true });
    project = loadProject(dir);
    writeStudioState(project, { reviewer: "ミナ" });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("足す・返信・解決・付け直し・削除を、スレッドごとのファイルに書く", () => {
    const now = new Date("2026-10-26T00:00:00Z");
    let list = applyReview(project, { kind: "create", file: "start", line: 23, text: "　坂をのぼりきった先に。 ", body: " ルビを付けたい " }, now);
    expect(list.author).toBe("ミナ");
    const t = list.threads[0]!;
    expect(t).toMatchObject({ file: "start", line: 23, text: "坂をのぼりきった先に。", hash: textHash("坂をのぼりきった先に。"), resolved: false });
    expect(t.comments).toEqual([{ id: t.comments[0]!.id, author: "ミナ", time: "2026-10-26T00:00:00.000Z", body: "ルビを付けたい" }]);
    expect(readdirSync(join(dir, REVIEWS_DIR))).toEqual([`${t.id}.json`]);

    list = applyReview(project, { kind: "reply", id: t.id, body: "了解" }, now);
    list = applyReview(project, { kind: "resolve", id: t.id, resolved: true }, now);
    expect(list.threads[0]).toMatchObject({ resolved: true, resolvedBy: "ミナ" });
    expect(list.threads[0]!.comments.map((c) => c.body)).toEqual(["ルビを付けたい", "了解"]);
    list = applyReview(project, { kind: "resolve", id: t.id, resolved: false }, now);
    expect(list.threads[0]!.resolvedBy).toBeUndefined();

    list = applyReview(project, { kind: "anchor", id: t.id, line: 25, text: "坂をのぼりきった先に、天文台。" }, now);
    expect(list.threads[0]).toMatchObject({ line: 25, hash: textHash("坂をのぼりきった先に、天文台。") });

    const [first, second] = list.threads[0]!.comments;
    list = applyReview(project, { kind: "delete", id: t.id, comment: first!.id }, now);
    expect(list.threads[0]!.comments).toEqual([second]);
    list = applyReview(project, { kind: "delete", id: t.id, comment: second!.id }, now);
    expect(list.threads).toEqual([]);
    expect(readdirSync(join(dir, REVIEWS_DIR))).toEqual([]);
  });

  it("範囲に付け、自分のコメントだけを書き直せる", () => {
    const now = new Date("2026-10-26T00:00:00Z");
    let list = applyReview(project, { kind: "create", file: "start", line: 3, text: "始め", body: "ここからここまで", end: { line: 6, text: " 終わり " } }, now);
    const t = list.threads[0]!;
    expect(t.end).toEqual({ line: 6, text: "終わり", hash: textHash("終わり") });
    const later = new Date("2026-10-27T00:00:00Z");
    list = applyReview(project, { kind: "edit", id: t.id, comment: t.comments[0]!.id, body: " 直した " }, later);
    expect(list.threads[0]!.comments[0]).toMatchObject({ body: "直した", time: "2026-10-26T00:00:00.000Z", edited: "2026-10-27T00:00:00.000Z" });
    // 付け直しで範囲も動かす（end を書かなければ範囲はそのまま）
    list = applyReview(project, { kind: "anchor", id: t.id, line: 4, text: "始め", end: { line: 8, text: "終わり" } }, now);
    expect(list.threads[0]).toMatchObject({ line: 4, end: { line: 8 } });
    list = applyReview(project, { kind: "anchor", id: t.id, line: 5, text: "始め" }, now);
    expect(list.threads[0]!.end?.line).toBe(8);
    // ほかの人のコメントは書き直せない
    writeStudioState(project, { reviewer: "ソウ" });
    expect(() => applyReview(project, { kind: "edit", id: t.id, comment: t.comments[0]!.id, body: "x" })).toThrow(/ほかの人/);
    // 一行だけの end は付けない
    list = applyReview(project, { kind: "create", file: "start", line: 3, text: "a", body: "b", end: { line: 3, text: "a" } }, now);
    expect(list.threads.find((x) => x.id !== t.id)!.end).toBeUndefined();
  });

  it("空のコメント・無いスレッドは断り、壊れたファイルは飛ばす", () => {
    expect(() => applyReview(project, { kind: "create", file: "start", line: 1, text: "", body: "  " })).toThrow();
    expect(() => applyReview(project, { kind: "reply", id: "r-none", body: "x" })).toThrow();
    applyReview(project, { kind: "create", file: "start", line: 1, text: "a", body: "b" });
    writeFileSync(join(dir, REVIEWS_DIR, "broken.json"), "{");
    writeFileSync(join(dir, REVIEWS_DIR, "r-x.json"), JSON.stringify({ id: "r-x", file: "start", line: 2, text: "本文", comments: [] }));
    const list = listReviews(project);
    expect(list.threads.map((t) => t.id).sort()).toContain("r-x");
    expect(list.threads.find((t) => t.id === "r-x")!.hash).toBe(textHash("本文"));
    expect(list.threads).toHaveLength(2);
  });

  it("書き出す素材とシナリオには入らない（reviews/ はシナリオ・データ・素材のフォルダの外）", () => {
    applyReview(project, { kind: "create", file: "start", line: 1, text: "a", body: "b" });
    for (const p of [project.paths.scenario, project.paths.data, project.paths.assets]) expect(join(dir, REVIEWS_DIR).startsWith(p)).toBe(false);
    expect(readFileSync(join(dir, "gitignore"), "utf8")).not.toMatch(/reviews/);
  });
});

describe("テスト版の指摘の取り込み", () => {
  let dir: string;
  let project: Project;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "liminalia-feedback-"));
    cpSync(TEMPLATE, dir, { recursive: true });
    writeFileSync(join(dir, "scenario", "a.lim"), "一行目の地の文。\n二行目の地の文。\n三行目の地の文。\n");
    project = loadProject(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** テスト版の packages/web/src/feedback.ts が書く形。 */
  const record = (o: Record<string, unknown> = {}) => ({
    kind: "liminalia-feedback",
    format: 1,
    project: "hoshi_wo_matsu_oka",
    version: "1.0.0",
    variant: "test",
    at: { file: "a", line: 2, key: pageKeys(parse("一行目の地の文。\n二行目の地の文。\n三行目の地の文。\n", "a")).get(2) },
    body: "ここが分かりにくい",
    author: "テスター",
    time: "2026-11-07T01:02:03.000Z",
    shot: `data:image/jpeg;base64,${Buffer.from("JPEG").toString("base64")}`,
    userAgent: "test",
    ...o,
  });

  it("ページの鍵で今の行を探し、名前、時刻、スクリーンショット、テスト版の版を付けたスレッドにする", () => {
    // 指摘のあとで頭に二行足した
    writeFileSync(join(dir, "scenario", "a.lim"), "// 足した\n// 足した\n一行目の地の文。\n二行目の地の文。\n三行目の地の文。\n");
    const r = importFeedback(project, [{ name: "a.json", data: record() }]);
    expect(r.imported).toBe(1);
    const [t] = r.list.threads;
    expect(t).toMatchObject({ file: "a", line: 4, text: "二行目の地の文。", resolved: false, comments: [{ author: "テスター", time: "2026-11-07T01:02:03.000Z", body: "ここが分かりにくい", feedback: { build: "1.0.0 test" } }] });
    expect(readFileSync(join(dir, REVIEWS_DIR, t!.comments[0]!.image!)).toString()).toBe("JPEG");
    expect(feedbackShot(project, t!.comments[0]!.image).data.toString()).toBe("JPEG");
    expect(() => feedbackShot(project, "../a.lim")).toThrow();
  });

  it("鍵で見つからなければ指摘した行。二度目、別のプロジェクト、無いシナリオ、形の違うものは取り込まない", () => {
    const r = importFeedback(project, [
      { name: "one", data: [record({ at: { file: "a", line: 3, key: "none" } }), record({ time: "2026-11-07T01:02:04.000Z", body: "もう一つ" })] },
      { name: "other", data: record({ project: "other" }) },
      { name: "missing", data: record({ at: { file: "nothing", line: 1 }, time: "2026-11-07T01:02:05.000Z" }) },
      { name: "bad", data: { hello: 1 } },
    ]);
    expect(r.imported).toBe(2);
    expect(r.list.threads.map((t) => t.line).sort()).toEqual([2, 3]);
    expect(r.skipped).toEqual([
      { name: "other", reason: "project" },
      { name: "missing", reason: "file" },
      { name: "bad", reason: "format" },
    ]);
    expect(importFeedback(project, [{ name: "again", data: record({ at: { file: "a", line: 3, key: "none" } }) }]).skipped).toEqual([{ name: "again", reason: "duplicate" }]);
    // 場面の位置の分からない指摘（タイトル画面）は「はじめから」のファイルの頭
    const title = importFeedback(project, [{ name: "title", data: record({ at: null, time: "2026-11-07T01:02:06.000Z" }) }]);
    expect(title.list.threads.find((t) => t.comments[0]!.time === "2026-11-07T01:02:06.000Z")).toMatchObject({ file: "start", line: 1 });
    expect(() => importFeedback(project, "x")).toThrow();
  });
});
