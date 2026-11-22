import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { formatTrace, traceProject } from "../../../cli/src/commands/trace.ts";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * プレイヤーの ?start=ファイル#ラベル&skip=N（lim shot --skip N、VS Code の「ここからテストプレイ」の早送り）が止まるページと、
 * lim trace がページに付ける番号 [N] が同じページを指すことを、実際のブラウザで確かめる。
 * skip=N は「N ページ飛ばす」ではなく「N ページ目（開始位置から 1 で数える）で止まる」。trace の何番目かをそのまま渡せる。
 * 演出・マクロの中の本文・分岐・行の中のクリック待ち・クリックを待たない行も、両方で同じに数える。
 */

const SCENARIO = `@define note(text: string)
（{= text}）
@end

@window show
前置き。

# scene
@bg hill_dusk.webp time=300ms
一つめ。
@set game.n = 1
@if game.n == 1
二つめ（分岐）。
@else
出ない。
@end
三つめ。{click}続き。
@note text=四つめ
@chara アカリ normal time=200ms wait=true
アカリ「五つめ」{noclick}
@wait 300ms
六つめ。
@mask time=300ms
@mask-off time=300ms
七つめ。
八つめ。
`;

/** 止まったページ（早送りが終わってクリックを待っているところ）の番号と本文。 */
async function stopped(p: Page): Promise<{ pages: number; text: string }> {
  await p.waitForFunction(() => {
    const l = window.__liminalia;
    return !!l && l.pages() >= 1 && l.host.waiting && !l.host.skipping;
  }, null, { timeout: 30_000 });
  await p.waitForTimeout(400);
  return p.evaluate(() => ({ pages: window.__liminalia!.pages(), text: (document.querySelector(".message .text")?.textContent ?? "").replace("▼", "") }));
}

describe.skipIf(!e2e)("?skip=N が止まるページと lim trace のページの番号（ブラウザ）", { timeout: 240_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({ scenario: { a: SCENARIO }, config: { entry: "a" } });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("trace の [N] のページで止まる（0 と 1 は最初のページ。クリックを待たない行なら次のクリック待ちのページ）", async () => {
    const { trace, runtime } = await traceProject(project.dir, "a#scene");
    const pages = trace.flatMap((t) => (t.type === "page" ? [t] : []));
    expect(pages.map((t) => `${t.page}:${t.text}`)).toEqual(["1:一つめ。", "2:二つめ（分岐）。", "3:三つめ。続き。", "4:（四つめ）", "5:「五つめ」", "6:六つめ。", "7:七つめ。", "8:八つめ。"]);
    // 文字の出力の頭の [N]
    expect(formatTrace(pages[2]!, runtime.registry)).toBe("[3] a:17  三つめ。続き。");
    for (const { name, browser } of list) {
      // skip → 止まるページの番号。5 はクリックを待たない行なので、次のクリック待ちの 6 で止まる
      for (const [skip, page] of [[0, 1], [1, 1], [3, 3], [4, 4], [5, 6], [6, 6], [8, 8]] as const) {
        const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        await p.goto(`${project.url}?autostart=1&start=${encodeURIComponent("a#scene")}&skip=${skip}`);
        const at = await stopped(p);
        // 行の中のクリック待ち（{click}）があるページは、その手前まで出して待つ
        const text = pages[page - 1]!.text;
        expect({ skip, pages: at.pages, text: text.startsWith(at.text) && at.text !== "" ? text : at.text }, name).toEqual({ skip, pages: page, text });
        await p.close();
      }
    }
  });
});
