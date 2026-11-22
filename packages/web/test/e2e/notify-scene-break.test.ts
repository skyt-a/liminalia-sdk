import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/**
 * @notify when=scene-break を、実際のブラウザで確かめる。
 * - 会話の途中では出さず、場面転換のあとの最初の本文の前に出す
 * - 待っている間にセーブし、読み込み直してロードしても、場面転換のあとに一度だけ出る
 * LIMINALIA_NOTIFY_SHOTS にフォルダを書くと、通知が出たところを撮る（目で確かめるため）。
 */

const SHOTS = process.env.LIMINALIA_NOTIFY_SHOTS;

const SCENARIO = `@bg hill_dusk.webp
@window show
アカリ「見つけた」
@notify 手帳に新しい頁が加わった when=scene-break
ソウ「どうしたの、急に」
アカリ「あとで話す」
@scene-change hill_night.webp time=100ms
夜になった。
二行目。
`;

const notices = (p: Page) => p.evaluate(`[...document.querySelectorAll(".lm-notice")].map((n) => n.textContent)`) as Promise<string[]>;
const page = (p: Page) => p.evaluate(`document.querySelector(".message .text").textContent`) as Promise<string>;
/** 本文を出し切ってから次へ（演出は終わりまで待つ）。 */
const next = async (p: Page) => {
  await p.mouse.click(640, 200);
  await p.waitForTimeout(150);
  await p.mouse.click(640, 200);
  await p.waitForTimeout(700);
};

describe.skipIf(!e2e)("@notify when=scene-break（ブラウザ）", { timeout: 300_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({ scenario: { a: SCENARIO } });
    list = await browsers();
  }, 120_000);
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("会話の途中では出さず、場面転換のあとの本文で出す。待っている間のセーブとロードでも一度だけ", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await p.waitForTimeout(300);
      await next(p);
      expect(await page(p), name).toContain("どうしたの");
      expect(await notices(p), name).toEqual([]);
      // 待っている間にセーブ
      expect(await p.evaluate("window.__liminalia.system.saveTo(1)"), name).toBe(true);
      await next(p);
      expect(await notices(p), name).toEqual([]);
      await next(p);
      expect(await page(p), name).toContain("夜になった");
      expect(await notices(p), name).toEqual(["手帳に新しい頁が加わった"]);
      if (SHOTS) {
        mkdirSync(SHOTS, { recursive: true });
        await p.screenshot({ path: join(SHOTS, `${name}-notify.png`) });
      }

      // 読み込み直して、待っている間のセーブをロード
      await p.reload();
      await p.waitForSelector(".message .text .ch", { timeout: 60_000 });
      await p.evaluate("window.__liminalia.system.loadFrom(1)");
      await p.waitForTimeout(1000);
      expect(await page(p), name).toContain("どうしたの");
      expect(await notices(p), name).toEqual([]);
      await next(p);
      await next(p);
      expect(await page(p), name).toContain("夜になった");
      expect(await notices(p), name).toEqual(["手帳に新しい頁が加わった"]);
      await p.close();
    }
  });
});
