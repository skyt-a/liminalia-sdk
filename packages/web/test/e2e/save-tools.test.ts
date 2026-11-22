import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/** セーブのメモ・保護・コピー・移動を、実際のブラウザで確かめる。 */

const slot = (p: Page, n: number) => p.locator(".lm-slot-wrap").nth(n);
const memoOf = (p: Page, n: number) => slot(p, n).locator(".lm-slot-memo").textContent();
const textOf = (p: Page, n: number) => slot(p, n).locator(".lm-slot-text").textContent();

describe.skipIf(!e2e)("セーブのメモ・保護・コピー・移動（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({ scenario: { a: "@window show\nいちページめ。\nにページめ。\n" }, config: { entry: "a" } });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("メモを書き、保護したスロットは上書き・削除できず、コピーと移動で写せる", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("いちページめ")`);
      await p.evaluate("window.__liminalia.system.saveTo(0)");
      await p.waitForTimeout(200);
      await p.mouse.click(640, 300);
      await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("にページめ")`);
      await p.evaluate("window.__liminalia.system.saveTo(1)");
      await p.evaluate("window.__liminalia.system.openSaveLoad('save')");
      // メモ
      await slot(p, 0).locator(".lm-slot-tool", { hasText: "メモ" }).click();
      await p.keyboard.type("森の手前");
      await p.keyboard.press("Enter");
      expect(await memoOf(p, 0), name).toBe("森の手前");
      // 保護: 削除できず、上書きもしない
      await slot(p, 0).locator(".lm-slot-tool", { hasText: "保護" }).click();
      expect(await slot(p, 0).locator(".lm-slot-lock").textContent()).toBe("保護中");
      expect(await slot(p, 0).locator(".lm-slot-tool", { hasText: "削除" }).isDisabled()).toBe(true);
      await slot(p, 0).locator(".lm-slot").click();
      expect(await p.locator(".lm-toast").textContent(), name).toBe("保護されているスロットです");
      expect(await textOf(p, 0)).toContain("いちページめ");
      // コピー: 保護は写さない
      await slot(p, 0).locator(".lm-slot-tool", { hasText: "コピー" }).click();
      expect(await p.locator(".lm-slot-banner").textContent()).toContain("No.01 のコピー先を選んでください");
      await slot(p, 2).locator(".lm-slot").click();
      expect([await textOf(p, 2), await memoOf(p, 2), await slot(p, 2).locator(".lm-slot-lock").count()], name).toEqual(["いちページめ。", "森の手前", 0]);
      // 移動: 保護したスロットへは移せない（押せない）。空きへ移すと元は空く
      await slot(p, 1).locator(".lm-slot-tool", { hasText: "移動" }).click();
      expect(await slot(p, 0).locator(".lm-slot").isDisabled(), name).toBe(true);
      await slot(p, 3).locator(".lm-slot").click();
      expect([await textOf(p, 1), await textOf(p, 3)], name).toEqual(["空き", "にページめ。"]);
      await p.close();
    }
  });
});
