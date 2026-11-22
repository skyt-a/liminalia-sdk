import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 送ったページの本文を、次の命令で消す（TyranoScript の [p] の改ページと同じ）のを、実際のブラウザで確かめる。
 * - 既定: クリックで送ったあとの最初の命令で、名前欄と本文を空にし、枠は残す
 * - @bg の keep-text=true: その行では消さず、次の本文まで残す
 * - ui.message.keepText: 前の版のとおり、次の本文まで残す
 */

const scenario = `@bg hill_dusk.webp
@window show
アカリ「消える台詞」
@wait 1500ms
一枚絵の差分を替える。
@bg hill_dusk.webp keep-text=true
@wait 1500ms
終わり。
`;

const message = (p: Page) =>
  p.evaluate(`(() => {
    const m = document.querySelector(".message");
    // クリック待ちの印（▼）の要素は本文の中にあるので、比べる文からは外す
    const text = m?.querySelector(".text");
    const copy = text?.cloneNode(true);
    copy?.querySelectorAll(".glyph, .click-glyph, [class*=glyph]").forEach((g) => g.remove());
    return { name: m?.querySelector(".name")?.textContent ?? "", text: (copy?.textContent ?? "").replace(/▼$/, ""), visible: !!m?.classList.contains("visible") };
  })()`) as Promise<{ name: string; text: string; visible: boolean }>;

const waitText = (p: Page, t: string) => p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes(${JSON.stringify(t)})`, undefined, { timeout: 30_000 });
const next = (p: Page) => p.mouse.click(640, 80);

describe.skipIf(!e2e)("送ったページの本文を次の命令で消す（ブラウザ）", { timeout: 240_000 }, () => {
  let project: TestProject;
  let keep: TestProject;
  let list: { name: string; browser: Browser }[];

  beforeAll(async () => {
    list = await browsers();
    project = await startProject({ scenario: { afterpage: scenario }, config: { entry: "afterpage" } });
    keep = await startProject({ scenario: { afterpage: scenario }, config: { entry: "afterpage", ui: { message: { keepText: true } } } });
  }, 120_000);
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
    await keep?.close();
  });

  it("送ったあとの最初の命令で名前と本文を消して枠は残し、keep-text=true の @bg は残す", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=afterpage`);
      await waitText(p, "消える台詞");
      await p.waitForTimeout(300);
      // 送ると、@wait の間は名前欄と本文が空で、枠は出たまま
      await next(p);
      await p.waitForTimeout(500);
      expect(await message(p), name).toEqual({ name: "", text: "", visible: true });
      // keep-text=true の @bg のあとの @wait の間は、前の本文が残る
      await waitText(p, "差分を替える");
      await p.waitForTimeout(300);
      await next(p);
      await p.waitForTimeout(500);
      expect(await message(p), name).toEqual({ name: "", text: "一枚絵の差分を替える。", visible: true });
      await p.close();

      // ui.message.keepText: 前の版のとおり、次の本文まで残す
      const q = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await q.goto(`${keep.url}?autostart=1&start=afterpage`);
      await waitText(q, "消える台詞");
      await q.waitForTimeout(300);
      await next(q);
      await q.waitForTimeout(500);
      expect(await message(q), name).toEqual({ name: "アカリ", text: "「消える台詞」", visible: true });
      await q.close();
    }
  });
});
