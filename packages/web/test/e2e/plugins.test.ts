import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { loadProject } from "@liminalia/project";
import { StudioWorkspace } from "../../../studio/src/server/workspace.ts";
import { createPlugin } from "../../../studio/src/server/manage.ts";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/**
 * 制作画面の「プラグイン」のタブの「新しく作る」が作るひな形（studio の createPlugin）が、そのまま動くか。
 * - ゲーム: 例の命令 @<名前>-hello が画面に文を出す
 * - 制作画面: 「プラグイン」のタブの左の欄に、プラグインの名前と画面が出て、開ける
 */
describe.skipIf(!e2e)("新しく作ったプラグイン（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    // ひな形を作ってから開発サーバーを立てる（プラグインは起動したときに読む）
    project = await startProject({
      scenario: { a: "@window show\nはじめ。\n@my-fx-hello テストの文\n終わり。\n" },
      before: async (dir) => {
        const ws = await StudioWorkspace.open(loadProject(dir));
        createPlugin(ws, "my-fx", ["web", "studio"]);
      },
    });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("例の命令が画面に文を出し、制作画面のプラグインのタブに画面が並ぶ", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      // はじめのページを出し切って次へ（例の命令の文は 1.6 秒ほどで消える）
      await p.mouse.click(640, 360);
      await p.waitForTimeout(200);
      await p.mouse.click(640, 360);
      await p.waitForFunction(`[...document.querySelectorAll("div")].some((d) => d.textContent === "テストの文")`, undefined, { timeout: 10_000 });
      await p.close();

      const s = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      // はじめての案内は 600ms 後に画面を覆うので、見たことにしておく（ここで確かめたいのはプラグインの画面）
      await s.addInitScript(`localStorage.setItem("liminalia.studio.tourDone", "1")`);
      await s.goto(`${project.url}__liminalia/studio`);
      await s.waitForSelector(".tabs-more .tab", { timeout: 60_000 });
      const tabs = (await s.evaluate(`[...document.querySelectorAll(".tabs-more .tab")].map((t) => t.textContent)`)) as string[];
      expect(tabs.some((t) => /プラグイン|Plugins/.test(t)), name).toBe(true);
      // 上の帯に入りきらないときは「その他の画面」へ畳まれる（書体の幅で変わる）ので、どちらからでも開く
      // 書体が揃うと測り直して畳み方が変わるので、揃ってから決める
      await s.evaluate("document.fonts.ready");
      await s.waitForTimeout(100);
      const tab = s.locator(".tabs-more .tab", { hasText: /プラグイン|Plugins/ });
      // メニューはウィンドウが入力を失うと閉じる（読み込み中のプレビューが取ることがある）ので、閉じていたら開き直す
      for (let tries = 0; ; tries++) {
        if (await tab.isVisible()) {
          await tab.click();
          break;
        }
        await s.locator(".topbar-screens").click();
        try {
          await s.locator(".ctx-item", { hasText: /プラグイン|Plugins/ }).click({ timeout: 3000 });
          break;
        } catch (e) {
          const seen = await s.evaluate(`[...document.querySelectorAll(".ctx-item")].map((x) => x.textContent).join(" / ")`);
          if (tries >= 5) throw new Error(`メニューからプラグインを開けません: ${String(seen)}`, { cause: e });
        }
      }
      await s.waitForSelector(".plg-side .plg-group");
      // 標準の命令のデータ（図鑑・調べる場所）のまとまりも並ぶので、作ったプラグインのまとまりを名前で探す
      expect(await s.evaluate(`[...document.querySelectorAll(".plg-group-name")].map((x) => x.textContent)`), name).toContain("my-fx");
      await s.locator(".plg-group", { has: s.locator(".plg-group-name", { hasText: /^my-fx$/ }) }).locator(".plg-nav").first().click();
      await s.waitForFunction(`[...document.querySelectorAll(".plg-main p")].some((x) => /ファイル/.test(x.textContent))`, undefined, { timeout: 10_000 });
      // 一覧に戻ると、作ったプラグインが並ぶ
      await s.locator(".plg-manage").click();
      await s.waitForSelector(".plg-page .proj-item");
      expect(await s.evaluate(`document.querySelector(".plg-page .proj-plugin-head b").textContent`), name).toBe("my-fx");
      await s.close();
    }
  });
});
