import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { openGameSection } from "../../../studio/test/game-section.ts";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

describe.skipIf(!e2e)("テーマの適用", { timeout: 120_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({ scenario: { a: "# a\n本文。\n@stop\n" } });
    list = await browsers();
  }, 60_000);
  afterAll(async () => {
    await project?.close();
    for (const b of list ?? []) await b.browser.close();
  });

  it("選択やキャンセルでは保存せず、適用したテーマだけ素材を置く", async () => {
    const page = await list[0]!.browser.newPage({ viewport: { width: 1500, height: 900 }, locale: "ja-JP" });
    page.on("dialog", (dialog) => void dialog.accept());
    await page.addInitScript(() => localStorage.setItem("liminalia.studio.tourDone", "1"));
    await page.goto(`${project.url}__liminalia/studio`);
    // 読み込み直後はキーの受け口がまだ無いことがある（CI で空振りした）。ゲームの設定の画面が出るまで押し直す
    for (let i = 0; i < 20 && !(await page.locator(".game-theme-current button").count()); i++) {
      await page.keyboard.press("Control+7");
      await page.waitForTimeout(500);
    }
    // テーマの欄は、見出しで開いたカテゴリの中にある
    await openGameSection(page, "theme");
    await page.locator(".game-theme-current button").click();
    const dialog = page.locator(".game-theme-dialog[open]");
    const apply = dialog.getByRole("button", { name: "適用", exact: true });
    expect(await apply.isDisabled()).toBe(true);
    const config = () => JSON.parse(readFileSync(join(project.dir, "liminalia.json"), "utf8"));
    const before = JSON.stringify(config().ui ?? {});
    const themes = join(project.dir, "assets/image/themes");
    await dialog.locator(".game-theme", { hasText: "洋館" }).click();
    expect(JSON.stringify(config().ui ?? {})).toBe(before);
    expect(existsSync(themes)).toBe(false);
    await dialog.getByRole("button", { name: "閉じる" }).click();
    expect(JSON.stringify(config().ui ?? {})).toBe(before);
    await page.locator(".game-theme-current button").click();
    await dialog.locator(".game-theme", { hasText: "洋館" }).click();
    await apply.click();
    await expect.poll(() => config().ui?.system?.preset).toBe("mansion");
    expect(existsSync(join(themes, "mansion/button.svg"))).toBe(true);
    await page.locator(".game-theme-current button").click();
    await dialog.locator(".game-theme", { hasText: "学園" }).click();
    await apply.click();
    await expect.poll(() => config().ui?.system?.preset).toBe("school");
    await expect.poll(() => existsSync(join(themes, "mansion"))).toBe(false);
    expect(existsSync(join(themes, "school/button.svg"))).toBe(true);
    await page.close();
  });
});
