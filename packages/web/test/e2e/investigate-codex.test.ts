import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/** 標準の調べる場所（@investigate）と図鑑（data/codex.json）を、実際のブラウザで確かめる。 */

const SCENARIO = `@bg hill_night.webp
はじまり。
@investigate room
調べ終えた。
@codex haru
おわり。
@stop
# window
@set game.met = true
窓を調べた。
# shelf
本棚を調べた。
`;

const INVESTIGATION = {
  places: {
    room: {
      title: "部屋",
      file: "a",
      views: [
        {
          id: "main",
          label: "部屋",
          background: "hill_dusk.webp",
          spots: [
            { id: "window", label: "窓", rect: { x: 100, y: 100, width: 200, height: 200 }, target: "#window" },
            { id: "shelf", label: "本棚", rect: { x: 800, y: 100, width: 200, height: 200 }, target: "#shelf" },
          ],
        },
      ],
    },
  },
};

const CODEX = {
  title: "記録",
  categories: [{ id: "people", label: "人物" }],
  entries: [
    {
      id: "haru",
      category: "people",
      title: "ハル",
      if: "game.met",
      sections: [
        { text: "天文部の部長。" },
        { id: "past", title: "過去", text: "前は写真部。", if: "game.met && visits(\"a#shelf\") > 0" },
      ],
    },
  ],
};

describe.skipIf(!e2e)("調べる場所と図鑑（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({
      scenario: { a: SCENARIO },
      config: { entry: "a" },
      before: (dir) => {
        mkdirSync(join(dir, "data"), { recursive: true });
        writeFileSync(join(dir, "data", "investigation.json"), JSON.stringify(INVESTIGATION));
        writeFileSync(join(dir, "data", "codex.json"), JSON.stringify(CODEX));
      },
    });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  const text = (p: Page) => p.evaluate(() => document.querySelector(".message .text")?.textContent ?? "");
  const advance = async (p: Page, until: string) => {
    for (let i = 0; i < 20 && !(await text(p)).includes(until); i++) {
      await p.mouse.click(640, 600);
      await p.waitForTimeout(250);
    }
    expect(await text(p)).toContain(until);
  };
  /** selector が出るまで本文を送る。 */
  const until = async (p: Page, selector: string) => {
    for (let i = 0; i < 20 && (await p.locator(selector).count()) === 0; i++) {
      await p.mouse.click(640, 600);
      await p.waitForTimeout(300);
    }
    await p.waitForSelector(selector, { timeout: 20_000 });
  };

  it("途中から始めて調べる場所より先まで飛ばしても（?skip=）、画面を出して押すのを待つ（自動で選んで進まない）", async () => {
    for (const { browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a&skip=5`);
      await p.waitForSelector(".lm-investigate-spot", { timeout: 60_000 });
      await p.waitForTimeout(1500);
      expect(await p.locator(".lm-investigate-spot").count()).toBe(2);
      expect(await text(p)).not.toContain("窓を調べた");
      expect(await text(p)).not.toContain("調べ終えた");
      await p.close();
    }
  });

  it("場所を押すと場面を読み、自動で戻り、調べ終えたら先へ進む。図鑑は条件で開き、新の印と知らせを出す", async () => {
    for (const { browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await advance(p, "はじまり");
      await until(p, ".lm-investigate-spot");
      expect(await p.locator(".lm-investigate-title").textContent()).toBe("部屋");
      // 窓（左上の場所）を押す
      await p.locator('.lm-investigate-spot[data-spot="window"]').click();
      await advance(p, "窓を調べた");
      // 条件（game.met）で図鑑が開いたことを知らせる（標準の知らせ）
      await p.waitForSelector(".lm-notice", { timeout: 10_000 });
      expect(await p.locator(".lm-notice").textContent()).toContain("ハル");
      // 場面の終わり（次のラベル）で、調べる画面へ戻る。調べた場所には印
      await until(p, '.lm-investigate-spot[data-spot="window"][data-done="true"]');
      await p.locator('.lm-investigate-spot[data-spot="shelf"]').click();
      await advance(p, "本棚を調べた");
      // 必須の場所を調べ終えたので、@investigate の次の行へ
      await advance(p, "調べ終えた");
      // @codex haru: 項目を開いて出す。段の条件（本棚を見た）で二つ目の段も開いている
      await until(p, ".lm-codex");
      expect(await p.locator(".lm-codex-title").textContent()).toBe("ハル");
      expect(await p.locator(".lm-codex-section").count()).toBe(2);
      expect(await p.locator(".lm-codex-section-title").textContent()).toBe("過去");
      // はじめて読む段には新の印（この表示の間だけ）
      expect(await p.locator('.lm-codex-section[data-fresh="true"]').count()).toBe(2);
      await p.locator(".lm-codex .lm-close").click();
      await advance(p, "おわり");
      // 全セーブ共通の記録に残る
      const unlocked = await p.evaluate(() => (window as unknown as { __liminalia: { system: { systemVariables: Record<string, unknown> } } }).__liminalia.system.systemVariables.codex_unlocked);
      expect(unlocked).toEqual({ haru: true, "haru#0": true, "haru#past": true });
      await p.close();
    }
  });
});
