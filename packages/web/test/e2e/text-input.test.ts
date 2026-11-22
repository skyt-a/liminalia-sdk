import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 文字の入力（@text-input）の種類（mode=number・password）、受け付ける形（pattern=）、ゲームパッドで打つ画面のキーボード、
 * 指で触る端末で見えている範囲の上に寄せる枠を、実際のブラウザで確かめる。
 */

const SCENARIO = `@window show
@text-input game.pin prompt="暗証番号" mode=number pattern="[0-9]{4}" max=4
@text-input game.secret prompt="合言葉" mode=password
@text-input game.name prompt="名前" required=true
結果 {= game.pin}/{= game.secret}/{= game.name}
`;

const result = (p: Page) => p.waitForFunction(() => document.querySelector(".message .text")?.textContent?.includes("結果") && window.__liminalia?.host.waiting, null, { timeout: 10_000 }).then(() => p.evaluate(`document.querySelector(".message .text").textContent.replace("▼", "")`));

describe.skipIf(!e2e)("文字の入力（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({ scenario: { a: SCENARIO } });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("数字だけを入れ、形に合うまで決められない。暗証は伏せる", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForSelector(".lm-panel input");
      expect(await p.evaluate(`document.querySelector(".lm-panel input").inputMode`), name).toBe("numeric");
      expect(await p.evaluate(`document.querySelector(".lm-panel").getAttribute("role")`), name).toBe("dialog");
      // ゲームパッドをつないでいなければ画面のキーボードは出さない
      expect(await p.locator(".lm-keyboard").count(), name).toBe(0);
      await p.keyboard.type("1a2");
      expect(await p.inputValue(".lm-panel input"), name).toBe("12");
      expect(await p.locator(".lm-panel-buttons button").isDisabled(), name).toBe(true);
      await p.keyboard.type("34");
      expect(await p.locator(".lm-panel-buttons button").isDisabled(), name).toBe(false);
      await p.keyboard.press("Enter");
      await p.waitForFunction(`document.querySelector(".lm-panel input")?.type === "password"`);
      await p.keyboard.type("ひみつ");
      await p.keyboard.press("Enter");
      await p.waitForFunction(`document.querySelector(".lm-panel")?.textContent.includes("名前")`);
      await p.keyboard.type("ユイ");
      await p.keyboard.press("Enter");
      expect(await result(p), name).toBe("結果 1234/ひみつ/ユイ");
      await p.close();
    }
  });

  it("ゲームパッドをつないでいれば画面のキーボードを出し、十字キーで選んで A で打てる（遊んでいる最中の操作にはしない）", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.addInitScript(() => {
        const pad = { id: "Xbox pad", index: 0, connected: true, mapping: "standard", timestamp: 0, buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })), axes: [0, 0, 0, 0] };
        Object.defineProperty(navigator, "getGamepads", { value: () => [pad], configurable: true });
      });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForSelector(".lm-keyboard");
      // 数字の入力は数字のキーだけ
      expect(await p.evaluate(`[...document.querySelectorAll(".lm-keyboard-keys button")].map((b) => b.textContent).join("")`), name).toBe("1234567890");
      const press = async (button: string) => {
        await p.evaluate(`window.__liminalia.host && import("/src/system/input.ts").then((m) => { m.pressPadButton(${JSON.stringify(button)}, true); m.pressPadButton(${JSON.stringify(button)}, false); })`);
        await p.waitForTimeout(60);
      };
      // 下で入力の欄からキーへ移り、A で 1 を打つ。右で 2、A
      await press("down");
      await press("a");
      await press("right");
      await press("a");
      expect(await p.inputValue(".lm-panel input"), name).toBe("12");
      // 右で選んでもクイックセーブにはならない
      expect(await p.evaluate(`window.__liminalia.system.quickSlots().filter((s) => !s.empty).length`), name).toBe(0);
      await p.close();
    }
  });

  it("指で触る端末では、枠を見えている範囲の上に寄せる", async () => {
    for (const { name, browser } of list) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: name === "chromium" });
      const p = await context.newPage();
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForSelector(".lm-panel.lm-panel-touch .lm-panel-box");
      const box = await p.evaluate(() => {
        const panel = document.querySelector<HTMLElement>(".lm-panel")!.getBoundingClientRect();
        const b = document.querySelector<HTMLElement>(".lm-panel-box")!.getBoundingClientRect();
        return { top: b.top - panel.top, height: panel.height };
      });
      // 真ん中ではなく上に寄せる
      expect(box.top, name).toBeLessThan(box.height / 4);
      await context.close();
    }
  });
});
