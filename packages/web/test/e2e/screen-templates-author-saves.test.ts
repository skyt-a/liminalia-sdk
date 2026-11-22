import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";
import { focusedLabel, open, screenNow, waitFocus, waitMode, waitScreen, waitText } from "./screens-behavior-shared.ts";

/**
 * 作品が写して直したセーブとロード、履歴、タイトル画面（liminalia.json の ui.templates。0.4.0 の段 f2）。HTML と CSS だけで形を変え、
 * 属性の付いた要素にエンジンが働き、キー、フォーカス、状態を付けることを、中立の名前の作品で確かめる。
 * - セーブとロード: スロットの一行（slot）だけを差し替え、残りは標準のまま。空きと保護は data-lm-* で当たり、押すと書く
 * - 履歴: 一つのページ（entry）だけを差し替える。検索で当たったページだけを並べ、ここに戻るが働く
 * - タイトル画面: 項目の並びと、出す出さないを型で変える。ブラウザ版の終了は書いてもエンジンが外す。画面の JS は外すときに片付けを呼ぶ
 */

const SCENARIO = `@window show
一つ目のページ。
ソウ「二つ目の台詞。」
三つ目のページ。
`;

/** スロットの一行だけを差し替える（番号と本文の頭とメモだけ。空きと保護を data-lm-* で当てる）。 */
const SLOT = `<style>
  .my-slot[data-lm-empty] .my-pick { opacity: 0.5; }
  .my-slot[data-lm-protected] .my-pick { color: rgb(255, 0, 0); }
</style>
<template data-part="slot" data-version="1">
<li class="my-slot">
  <button class="my-pick" data-role="pick"><b class="my-no" data-field="name"></b> <span class="my-text" data-field="text"></span></button>
  <span class="my-tools" data-if="tools">
    <button class="my-protect" data-role="protect" data-field="protect"></button>
    <button class="my-delete" data-role="delete">消す</button>
  </span>
</li>
</template>
`;

/** 一つのページだけを差し替える（話者と本文を一行に。ここに戻るは文字のボタン）。 */
const ENTRY = `<template data-part="entry" data-version="1">
<article class="my-entry">
  <span class="my-who" data-field="name"></span>
  <p class="my-body" data-field="text"></p>
  <button class="my-back" data-role="jump">戻る</button>
</article>
</template>
`;

/** 項目を三つだけ、コンフィグを先に並べる。ブラウザでは使えない終了も書く。題は書かない。 */
const TITLE = `<template data-part="screen" data-version="1">
<div class="lm-title my-title">
  <p class="my-name" data-field="name"></p>
  <nav class="lm-title-menu">
    <button class="lm-title-button" data-role="config">せってい</button>
    <button class="lm-title-button" data-role="start" data-text="title.start"></button>
    <button class="lm-title-button" data-role="exit" data-text="title.exit"></button>
    <button class="lm-title-button" data-role="load" data-text="title.continue"></button>
  </nav>
</div>
</template>
`;

/** タイトル画面の JS: 要素に印を付け、外したら数える。 */
const TITLE_JS = `export default function (screen, api) {
  screen.dataset.fromJs = api.screen + ":" + api.values.name;
  return () => { window.__titleGone = (window.__titleGone ?? 0) + 1; };
}
`;

const write = (files: Record<string, string>, scripts: Record<string, string> = {}) => (dir: string) => {
  for (const [name, html] of Object.entries(files)) {
    mkdirSync(join(dir, "ui", "screens", name), { recursive: true });
    writeFileSync(join(dir, "ui", "screens", name, `${name}.html`), html);
  }
  for (const [name, js] of Object.entries(scripts)) {
    mkdirSync(join(dir, "ui", "screens", name), { recursive: true });
    writeFileSync(join(dir, "ui", "screens", name, `${name}.js`), js);
  }
};
const templates = (names: string[]) => Object.fromEntries(names.map((n) => [n, `ui/screens/${n}/${n}.html`]));

const advanceTo = async (p: Page, text: string) => {
  await p.evaluate(() => window.__liminalia!.host.advance());
  await waitText(p, text);
};

describe.skipIf(!e2e)("作品のテンプレートで差し替えたセーブとロード、履歴、タイトル画面（ブラウザ）", { timeout: 300_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({
      scenario: { a: SCENARIO },
      config: { entry: "a", title: "中立の題", ui: { templates: templates(["saveload", "backlog", "title"]) } },
      before: write({ saveload: SLOT, backlog: ENTRY, title: TITLE }, { title: TITLE_JS }),
    });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("セーブ: スロットの一行だけを差し替え、タブと見出しは標準のまま。空きと保護を data-lm-* で当て、押すと書いて上書きを確かめる", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, project.url, { start: "a" });
      await p.evaluate(() => void window.__liminalia!.system.perform!("save"));
      await waitScreen(p, "save");
      // 標準の見出しとタブ、差し替えた一行が .lm-slots の子に並ぶ
      expect(await p.locator(".lm-saveload .lm-screen-title").textContent(), name).toBe("セーブ");
      expect(await p.locator(".lm-saveload .lm-tab").count(), name).toBe(6);
      expect(await p.locator(".lm-slots > .my-slot").count(), name).toBe(8);
      expect(await p.locator(".my-slot").first().evaluate((e) => [e.hasAttribute("data-lm-empty"), e.querySelector(".my-no")!.textContent, e.querySelector(".my-text")!.textContent, getComputedStyle(e.querySelector(".my-pick")!).opacity]), name).toEqual([true, "No.01", "空き", "0.5"]);
      // 空きには道具を出さない
      expect(await p.locator(".my-tools").count(), name).toBe(0);
      // 押すと書く（空きは確かめない）。一覧を作り直してもフォーカスは押した一行に残る
      await p.locator(".my-pick").first().focus();
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => window.__liminalia!.system.slot!(0).empty === false);
      const first = p.locator(".my-slot").first();
      expect(await first.evaluate((e) => [e.hasAttribute("data-lm-empty"), e.querySelector(".my-text")!.textContent]), name).toEqual([false, "一つ目のページ。"]);
      await waitFocus(p, ".my-slot");
      expect(await focusedLabel(p), name).toContain("No.01");
      // 保護すると data-lm-protected が付き、作品の CSS が当たる。保護のボタンの文字は「保護を外す」になる
      await first.locator(".my-protect").click();
      expect(await first.evaluate((e) => [e.hasAttribute("data-lm-protected"), getComputedStyle(e.querySelector(".my-pick")!).color, e.querySelector(".my-protect")!.textContent]), name).toEqual([true, "rgb(255, 0, 0)", "保護を外す"]);
      expect(await first.locator(".my-delete").isDisabled(), name).toBe(true);
      await first.locator(".my-protect").click();
      // 使っているスロットを押すと上書きを確かめる
      await first.locator(".my-pick").click();
      await waitScreen(p, "confirm");
      expect(await p.locator(".lm-dialog-message").textContent(), name).toBe("No.01 に上書きしますか？");
      await p.keyboard.press("Escape");
      await waitScreen(p, "save");
      // 消すは確かめてから
      await first.locator(".my-delete").click();
      await waitScreen(p, "confirm");
      await waitFocus(p, ".lm-dialog-buttons");
      await p.keyboard.press("Enter");
      await waitScreen(p, "save");
      await p.waitForFunction(() => window.__liminalia!.system.slot!(0).empty === true);
      expect(await p.locator(".my-slot").first().getAttribute("data-lm-empty"), name).toBe("");
      await p.keyboard.press("Escape");
      await waitScreen(p, null);
      await p.close();
    }
  });

  it("履歴: 一つのページだけを差し替える。本文と話者を入れ、検索で当たったページだけを並べ、戻るを押すと確かめてからそのページへ", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, project.url, { start: "a" });
      await advanceTo(p, "二つ目");
      await advanceTo(p, "三つ目");
      await p.keyboard.press("b");
      await waitScreen(p, "backlog");
      await waitFocus(p, ".lm-log");
      expect(await p.locator(".lm-log > .my-entry").evaluateAll((es) => es.map((e) => [e.querySelector(".my-who")!.textContent, e.querySelector(".my-body")!.textContent])), name).toEqual([
        ["", "一つ目のページ。"],
        ["ソウ", "「二つ目の台詞。」"],
        ["", "三つ目のページ。"],
      ]);
      // 今のページのほかは戻れる。地の文には data-lm-narration
      expect(await p.locator(".my-back").count(), name).toBe(2);
      expect(await p.locator(".my-entry[data-lm-narration]").count(), name).toBe(2);
      // 検索: 当たったページだけを並べ、件数を出す
      await p.locator(".lm-log-search").fill("台詞");
      await p.locator(".lm-log-count", { hasText: "1 件" }).waitFor();
      expect(await p.locator(".my-entry").evaluateAll((es) => es.map((e) => [e.querySelector(".my-body")!.textContent, e.hasAttribute("data-lm-hit")])), name).toEqual([["「二つ目の台詞。」", true]]);
      await p.locator(".lm-log-search").fill("");
      await p.locator(".my-entry").nth(2).waitFor();
      expect(await p.locator(".lm-log-count").textContent(), name).toBe("");
      // 戻る: 確かめてからそのページへ
      await p.locator(".my-back").first().click();
      await waitScreen(p, "confirm");
      await waitFocus(p, ".lm-dialog-buttons");
      await p.keyboard.press("Enter");
      await waitScreen(p, null);
      await waitText(p, "一つ目のページ");
      await p.close();
    }
  });

  it("タイトル画面: 型に書いた並びと項目だけを出し、ブラウザ版の終了は外す。セーブが無ければつづきからは押せない。画面の JS は外すときに片付けを呼ぶ", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, project.url);
      await p.waitForSelector(".my-title");
      expect(await p.locator(".my-name").textContent(), name).toBe("中立の題");
      expect(await p.locator(".my-title").getAttribute("data-from-js"), name).toBe("title:中立の題");
      expect(await p.locator(".lm-title-button").allTextContents(), name).toEqual(["せってい", "はじめから", "つづきから"]);
      expect(await p.locator(".lm-title-button", { hasText: "つづきから" }).evaluate((b) => [(b as HTMLButtonElement).disabled, b.hasAttribute("data-lm-disabled")]), name).toEqual([true, true]);
      // 矢印で選んで Enter で押す（コンフィグを開き、閉じたらそのボタンへ戻る）
      await p.keyboard.press("ArrowDown");
      expect(await focusedLabel(p), name).toBe("せってい");
      await p.keyboard.press("Enter");
      await waitScreen(p, "config");
      await p.keyboard.press("Escape");
      await waitScreen(p, null);
      expect(await focusedLabel(p), name).toBe("せってい");
      // はじめから: タイトルを外し、画面の JS の片付けを呼ぶ
      await p.locator(".lm-title-button", { hasText: "はじめから" }).click();
      await waitMode(p, "game");
      await waitText(p, "一つ目のページ");
      expect([await p.locator(".my-title").count(), await p.evaluate(() => (window as unknown as { __titleGone?: number }).__titleGone)], name).toEqual([0, 1]);
      expect((await screenNow(p)).screen, name).toBeNull();
      await p.close();
    }
  });
});
