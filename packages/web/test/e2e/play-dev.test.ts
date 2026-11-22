import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * テストプレイの道具（開発サーバーだけ。src/play-dev.ts）を、実際のブラウザで確かめる。
 * - シナリオを直すと遊んでいる途中のプレイヤーに「シナリオが変わりました」と「この場所から読み直す」を出し、⇧R で今のページから読み直す
 *   （直した文が出る。履歴と変数は引き継ぐ）。タイトルでは出さない
 * - ⇧E で今のページの位置を、制作画面へ BroadcastChannel で送る（受けたら返事。返事が無ければ「制作画面が開いていません」）
 * - 実行時の問題を右上に数で出し、BroadcastChannel でも送る
 */

const SCRIPT = ["@window show", "@set game.n = 3", "一ページ目。", "@open-screen nowhere_screen", "二ページ目。もとの文。", "三ページ目。"].join("\n");

const text = (p: Page) => p.evaluate(`document.querySelector(".message .text")?.textContent ?? ""`) as Promise<string>;
const waitText = (p: Page, s: string) => p.waitForFunction((s) => document.querySelector(".message .text")?.textContent?.includes(s) && window.__liminalia!.host.waiting, s, { timeout: 15_000 });

describe.skipIf(!e2e)("テストプレイの道具（ブラウザ）", { timeout: 240_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({ scenario: { a: SCRIPT }, config: { entry: "a" } });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("シナリオを直したら知らせ、⇧R で今のページから読み直す。⇧E と実行時の問題は制作画面へ送る", async () => {
    const file = join(project.dir, "scenario", "a.lim");
    for (const { name, browser } of list) {
      writeFileSync(file, SCRIPT);
      // 開発用の道具の言葉はブラウザの言語で決まる（日本語で確かめる）
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "ja-JP" });
      const p = await context.newPage();
      // 制作画面の代わり（同じオリジンの別のページで BroadcastChannel を聞き、「開く」に返事する）
      const studio = await context.newPage();
      await studio.goto(`${project.url}manifest.webmanifest`);
      await studio.evaluate(() => {
        const w = window as unknown as { got: unknown[] };
        w.got = [];
        const ch = new BroadcastChannel("liminalia:test-play");
        ch.onmessage = (e) => {
          w.got.push(e.data);
          if (e.data?.type === "test-play-open") ch.postMessage({ type: "test-play-ack", id: e.data.id });
        };
      });
      const got = () => studio.evaluate(() => (window as unknown as { got: { type: string; file?: string; line?: number; diagnostic?: { code: string; line: number } }[] }).got);

      await p.goto(`${project.url}?play=1&start=a`);
      await p.locator(".layer.start").click();
      await waitText(p, "一ページ目");
      await p.evaluate("window.__liminalia.host.advance()");
      await waitText(p, "もとの文");
      await p.waitForFunction(() => document.querySelector(".lm-play-dev-entry")?.textContent === "警告 1", undefined, { timeout: 5000 });
      expect((await got()).some((m) => m.type === "test-play-diagnostic" && m.diagnostic?.code === "unknown-screen" && m.diagnostic.line === 4), name).toBe(true);
      expect((await got()).some((m) => m.type === "test-play-start"), name).toBe(true);

      // 直す → 知らせ → ⇧R
      writeFileSync(file, SCRIPT.replace("もとの文", "直した文").replace("@set game.n = 3", "@set game.n = 3\n// 行を一つ足す"));
      await p.waitForSelector(".lm-play-dev-banner", { timeout: 10_000 });
      expect(await text(p), name).toContain("もとの文");
      const logBefore = (await p.evaluate("window.__liminalia.system.backlog.length")) as number;
      await p.keyboard.press("Shift+R");
      await waitText(p, "直した文");
      expect(await p.locator(".lm-play-dev-banner").count(), name).toBe(0);
      expect(await p.evaluate("window.__liminalia.runtime().state.game.n"), name).toBe(3);
      expect((await p.evaluate("window.__liminalia.system.backlog.length")) as number, name).toBeGreaterThanOrEqual(logBefore);
      // 行がずれたので、今のページは 6 行目（ずれの知らせは右上に数えない）
      expect(await p.locator(".lm-play-dev-entry").textContent(), name).toBe("警告 1");

      // ⇧E: 今のページの位置を送り、返事があれば知らせない
      await p.keyboard.press("Shift+E");
      await p.waitForTimeout(400);
      const open = (await got()).filter((m) => m.type === "test-play-open");
      expect(open.at(-1), name).toMatchObject({ file: "a", line: 6 });
      expect(await p.locator(".lm-play-dev-banner").count(), name).toBe(0);
      // 制作画面が無ければ知らせる
      await studio.close();
      await p.keyboard.press("Shift+E");
      await p.waitForSelector(".lm-play-dev-banner", { timeout: 5000 });
      expect(await p.locator(".lm-play-dev-banner").textContent(), name).toContain("制作画面が開いていません");

      // タイトルでは知らせない
      const title = await context.newPage();
      await title.goto(`${project.url}?play=1`);
      await title.waitForTimeout(1000);
      writeFileSync(file, readFileSync(file, "utf8").replace("直した文", "三度目"));
      await title.waitForTimeout(2000);
      expect(await title.locator(".lm-play-dev-banner").count(), name).toBe(0);
      await context.close();
    }
  });
});
