import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/**
 * 選択肢を本文の流れに出す（ui.choice.position: inline。サウンドノベル式）を、実際のブラウザで確かめる。
 * - ボタンの層（.choices）ではなく、文字を出す所（.message .text）の終わりに書き込む
 * - 選ぶとボタンは文字の行に戻り、選んだ行に印が残る（.is-done / .is-picked）
 * - @nvl の間は段落と同じく積まれ、セーブとロードで出し直す
 */

const SCENARIO = `@nvl on
雪が降っている。
ペンションの灯りが見える。
@choice
- ペンションへ向かう -> #a
- 引き返す -> #b
@end
# a
ペンションに着いた。
@stop
# b
引き返した。
@stop
`;

const ADV_SCENARIO = `雪が降っている。
@choice
- 行く -> #a
@end
# a
着いた。
@stop
`;

const UI = { choice: { position: "inline" } };

const choosing = (p: Page) => p.evaluate("window.__liminalia.host.choosing") as Promise<boolean>;
const advance = async (p: Page) => {
  await p.evaluate("window.__liminalia.host.advance()");
  await p.waitForTimeout(300);
};
const readToChoice = async (p: Page) => {
  for (let i = 0; i < 20 && !(await choosing(p)); i++) await advance(p);
  expect(await choosing(p)).toBe(true);
};

describe.skipIf(!e2e)("選択肢を本文の流れに出す（ブラウザ）", { timeout: 300_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({ scenario: { a: SCENARIO, adv: ADV_SCENARIO }, config: { entry: "a", ui: UI } });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("本文の続きに選択肢を書き込み、選ぶと文字の行に戻して残す", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await readToChoice(p);
      // 選択肢はボタンの層ではなく、文字を出す所の終わりにある
      const at = await p.evaluate(() => {
        const inline = document.querySelector(".message .text .choice-inline");
        const overlay = document.querySelectorAll(".stage > .choices button").length;
        const buttons = [...(inline?.querySelectorAll("button") ?? [])].map((b) => b.textContent);
        return { inside: !!inline, overlay, buttons };
      });
      expect(at, name).toEqual({ inside: true, overlay: 0, buttons: ["ペンションへ向かう", "引き返す"] });
      // 一つ目を選ぶ: ボタンは文字の行に戻り、選んだ行に印が残って本文の一部になる
      await p.locator(".choice-inline button").nth(0).click();
      await p.waitForTimeout(400);
      const sealed = await p.evaluate(() => {
        const inline = document.querySelector(".choice-inline");
        const lines = [...(inline?.querySelectorAll("span") ?? [])].map((s) => ({ text: s.textContent, picked: s.classList.contains("is-picked") }));
        return { done: inline?.classList.contains("is-done") ?? false, lines };
      });
      expect(sealed, name).toEqual({
        done: true,
        lines: [
          { text: "ペンションへ向かう", picked: true },
          { text: "引き返す", picked: false },
        ],
      });
      // 次の本文は、残した選択肢の行の下に積まれる
      await advance(p);
      const order = await p.evaluate(() => {
        const text = document.querySelector(".message .text")!;
        return [...text.children].map((c) => (c.classList.contains("choice-inline") ? "choice" : "page"));
      });
      expect(order.slice(-2), name).toEqual(["choice", "page"]);
      // セーブとロードで、選んだ印ごと出し直す
      await p.evaluate('window.__liminalia.system.perform("quick-save")');
      await p.evaluate('window.__liminalia.system.perform("quick-load")');
      await p.waitForTimeout(600);
      const restored = await p.evaluate(() => {
        const inline = document.querySelector(".choice-inline");
        const lines = [...(inline?.querySelectorAll("span") ?? [])].map((s) => ({ text: s.textContent, picked: s.classList.contains("is-picked") }));
        return { done: inline?.classList.contains("is-done") ?? false, lines };
      });
      expect(restored, name).toEqual(sealed);
      await p.close();
    }
  });

  it("メッセージウィンドウの中（@nvl 無し）でも出し、次のページで消える", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "adv");
      await readToChoice(p);
      const at = await p.evaluate(() => ({
        inside: !!document.querySelector(".message .text .choice-inline button"),
        overlay: document.querySelectorAll(".stage > .choices button").length,
      }));
      expect(at, name).toEqual({ inside: true, overlay: 0 });
      await p.locator(".choice-inline button").nth(0).click();
      await p.waitForTimeout(400);
      // 残した行は次のページでいっしょに消える（メッセージ枠の本文として残る）
      await advance(p);
      const after = await p.evaluate(() => ({
        inline: !!document.querySelector(".choice-inline"),
        text: document.querySelector(".message .text")?.textContent ?? "",
      }));
      expect(after.inline, name).toBe(false);
      expect(after.text.includes("着いた"), name).toBe(true);
      await p.close();
    }
  });
});
