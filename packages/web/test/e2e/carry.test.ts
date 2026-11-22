import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 体験版などからの引き継ぎ（liminalia.json の saves.carryFrom）を、実際のブラウザで確かめる。
 * はじめて起動したとき、この作品にセーブが無く、同じ保存先に引き継げる作品のセーブがあれば尋ね、引き継ぐ（一度だけ尋ねる）。
 */

describe.skipIf(!e2e)("体験版からの引き継ぎ（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({ scenario: { a: "@window show\n一。\n二。\n" }, config: { entry: "a", saves: { carryFrom: { demo_game: "体験版" } } } });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("体験版のセーブを見つけて尋ね、引き継ぐ", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForSelector(".message .text .ch");
      // 体験版のセーブを作る（この作品のセーブを作って、体験版の id の鍵へ移す）
      await p.evaluate(`(() => {
        window.__liminalia.system.saveTo(0);
        const id = ${JSON.stringify("hoshi_wo_matsu_oka")};
        const saves = window.__liminalia.saves;
        for (const [k, v] of Object.entries(saves.entries("liminalia:" + id + ":"))) {
          saves.set(k.replace("liminalia:" + id + ":", "liminalia:demo_game:"), v);
          saves.remove(k);
        }
        return window.__liminalia.flushSaves();
      })()`);
      await p.goto(project.url);
      await p.click(".lm-gate");
      await p.waitForSelector(".lm-dialog");
      expect(await p.evaluate(`document.querySelector(".lm-dialog").textContent`), name).toContain("「体験版」のセーブデータが見つかりました");
      await p.click(".lm-dialog .lm-primary");
      await p.waitForTimeout(1500);
      expect(await p.evaluate(`Object.keys(window.__liminalia.saves.entries("liminalia:hoshi_wo_matsu_oka:slot:"))`), name).toEqual(["liminalia:hoshi_wo_matsu_oka:slot:0"]);
      // 二度目は尋ねない
      await p.goto(project.url);
      await p.click(".lm-gate");
      await p.waitForSelector(".lm-title-button");
      expect(await p.evaluate(`!!document.querySelector(".lm-dialog")`), name).toBe(false);
      await p.close();
    }
  });
});
