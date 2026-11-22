import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/**
 * 既読の先の選択肢の印（飛び先の最初のページを読んだことがあれば is-read）と、次の未読へ（next-unread）を、実際のブラウザで確かめる。
 */

const SCENARIO = `@window show
一。
二。
@choice
- 甲 -> #a
- 乙 -> #b
@end
# a
@jump #a_body
# a_body
甲の一。
甲の二。
# b
乙の一。
`;

const text = (p: Page) => p.evaluate(`document.querySelector(".message .text").textContent.replace("▼", "")`) as Promise<string>;
const advance = async (p: Page) => {
  await p.evaluate("window.__liminalia.host.advance()");
  await p.waitForTimeout(80);
  await p.evaluate("window.__liminalia.host.advance()");
  await p.waitForTimeout(300);
};

describe.skipIf(!e2e)("既読の選択肢と次の未読へ（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({ scenario: { a: SCENARIO, keys: "@window show\n一。\n二。\n三。\n" } });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("読んだ先の選択肢に印が付き、次の未読へは設定によらず未読で止まる", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await p.waitForTimeout(300);
      await advance(p);
      await advance(p);
      await p.waitForSelector(".choices button");
      expect(await p.evaluate(`[...document.querySelectorAll(".choices button")].map((b) => b.classList.contains("is-read"))`), name).toEqual([false, false]);
      await p.locator(".choices button").nth(0).click();
      await p.waitForTimeout(400);
      expect(await text(p), name).toBe("甲の一。");
      await advance(p);
      // 初めから: 甲の先（@jump の先の最初のページ）を読んだので甲に印
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForSelector(".message .text .ch");
      await p.waitForTimeout(300);
      // 「すべて飛ばす」にしても、次の未読へは既読を飛ばして選択肢で止まる
      await p.evaluate("window.__liminalia.system.updateSettings({ skipUnread: true })");
      await p.evaluate("void window.__liminalia.system.perform('next-unread')");
      await p.waitForSelector(".choices button", { timeout: 10_000 });
      expect(await p.evaluate(`[...document.querySelectorAll(".choices button")].map((b) => b.classList.contains("is-read"))`), name).toEqual([true, false]);
      await p.locator(".choices button").nth(1).click();
      await p.waitForTimeout(400);
      expect(await text(p), name).toBe("乙の一。");
      // ここから先はもう未読は無い（知らせて飛ばさない）
      await p.evaluate("void window.__liminalia.system.perform('next-unread')");
      await p.waitForTimeout(600);
      expect([await text(p), await p.evaluate("window.__liminalia.system.status.skip")], name).toEqual(["乙の一。", false]);
      await p.close();
    }
  });

  it("シナリオを直して行がずれても既読は動かず、足した行は未読のまま。前のバージョンの行の既読は鍵に移す", async () => {
    const READ = "liminalia:hoshi_wo_matsu_oka:read";
    const marks = async (p: Page, pages: number) => {
      const out: [string, boolean][] = [];
      for (let i = 0; i < pages; i++) {
        if (i > 0) {
          // 文字を出し終えてから一つだけ送る
          await p.waitForTimeout(300);
          await p.evaluate("window.__liminalia.host.advance()");
          await p.waitForTimeout(300);
        }
        out.push([await text(p), (await p.evaluate(`document.querySelector(".message").classList.contains("is-read")`)) as boolean]);
      }
      return out;
    };
    const open = async (p: Page) => {
      await p.goto(`${project.url}?autostart=1&start=keys`);
      await p.waitForSelector(".message .text .ch");
      await p.waitForTimeout(300);
    };
    for (const { name, browser } of list) {
      writeFileSync(join(project.dir, "scenario", "keys.lim"), "@window show\n一。\n二。\n三。\n");
      const p = await openPlayer(browser, project.url, "keys");
      await p.waitForTimeout(300);
      expect(await marks(p, 3), name).toEqual([["一。", false], ["二。", false], ["三。", false]]);
      await p.waitForTimeout(1500);
      const saved = JSON.parse((await p.evaluate(`window.__liminalia.saves.entries()[${JSON.stringify(READ)}]`)) as string) as { version: number; pages: Record<string, string[]> };
      expect([saved.version, saved.pages.keys?.length], name).toEqual([2, 3]);
      // 頭に行を足し（行がずれる）、二と三のあいだに一行足す
      writeFileSync(join(project.dir, "scenario", "keys.lim"), "@window show\n\n// 足した\n一。\n二。\n足した。\n三。\n");
      await open(p);
      expect(await marks(p, 4), name).toEqual([["一。", true], ["二。", true], ["足した。", false], ["三。", false]]);
      // 前のバージョンの形（ファイル → 行）で覚えた既読は、今のシナリオの行で鍵に移す。
      // プレイヤーは閉じるときに書き終わっていない保存を localStorage の JOURNAL に置き、次の起動で後から入れる。
      // それが古い形を上書きしないよう、スクリプトの無い同じオリジンのページに移ってから JOURNAL を外して書く（プレイヤーのページで書くと、閉じるときにまた置かれる）
      await p.route(`${project.url}__blank`, (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>blank</title>" }));
      await p.goto(`${project.url}__blank`);
      await p.evaluate((key) => {
        localStorage.removeItem("liminalia-journal");
        localStorage.setItem(key, JSON.stringify({ keys: [4, 6] }));
      }, READ);
      await open(p);
      expect(await marks(p, 3), name).toEqual([["一。", true], ["二。", false], ["足した。", true]]);
      await p.waitForTimeout(1500);
      const moved = JSON.parse((await p.evaluate(`window.__liminalia.saves.entries()[${JSON.stringify(READ)}]`)) as string) as { version: number; pages: Record<string, string[]>; lines?: unknown };
      expect([moved.version, moved.pages.keys?.length, moved.lines], name).toEqual([2, 3, undefined]);
      await p.close();
    }
  });
});
