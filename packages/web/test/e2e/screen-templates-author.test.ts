import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";
import { focusedLabel, open, pad, screenNow, waitFocus, waitMode, waitScreen, waitText } from "./screens-behavior-shared.ts";

/**
 * 作品が写して直したメニュー、操作説明、結末の名前、選択肢（liminalia.json の ui.templates）。HTML と CSS だけで形を変え、
 * 属性の付いた要素にエンジンが働き、キー、フォーカス、状態を付けることを、中立の名前の作品で確かめる（確認の画面は confirm-template.test.ts）。
 * - メニュー: 項目の並びと、出す出さないを型で変える。今は使えない操作（ブラウザ版の終了）は書いてもエンジンが外す
 * - 操作説明: 一行（row）の部品だけを差し替え、残りは標準のまま。タブを替えても、選んだタブにフォーカスが残る
 * - 結末の名前: 形を変えても、名前、種類、進む操作が働く
 * - 選択肢: 一つの選択肢（option）だけ、並べる枠（screen）だけを、別々に差し替えられる。状態は data-lm-* で当たる
 */

const SCENARIO = `@window show
# top
選ぶ前。
@choice
- 甲 -> #a
- 乙 -> #b locked=true
- 丙 -> #c
@end
# a
甲を読んだ。
@jump #top
# b
乙を読んだ。
@stop
# c
丙を読んだ。
@stop
`;

const ENDING = `@window show
はじまり。
@title-screen ending=bad title="灰色の朝"
`;

/** 項目を三つだけ、コンフィグを先に並べ、ボタンでない要素も項目にする。ブラウザでは使えない終了も書く。 */
const MENU = `<style>
  .my-menu [data-lm-focus] { outline: 3px solid rgb(0, 128, 0); }
</style>
<template data-part="screen" data-version="1">
<div class="lm-screen lm-menu my-menu">
  <div class="lm-menu-panel">
    <h2 class="lm-screen-title">ひと休み</h2>
    <ul class="lm-menu-list">
      <li><button class="lm-button" data-role="config" data-text="menu.config"></button></li>
      <li><span class="lm-button my-log" data-role="backlog">これまで</span></li>
      <li><button class="lm-button" data-role="exit" data-text="menu.exit"></button></li>
      <li><button class="lm-button" data-role="save" data-text="menu.save"></button></li>
    </ul>
    <button class="lm-button lm-primary" data-role="close" data-autofocus>もどる</button>
  </div>
</div>
</template>
`;

/** 操作の表の一行だけを差し替える（ほかの部品は標準のまま）。 */
const HELP = `<template data-part="row" data-version="1">
<tr class="my-row"><td data-field="label"></td><td data-field="keyboard"></td></tr>
</template>
`;

const ENDING_TEMPLATE = `<template data-part="screen" data-version="1">
<div class="lm-screen lm-ending my-end" data-attr-data-kind="kind">
  <p class="lm-ending-name" data-field="name"></p>
  <p class="my-kind" data-field="kind-label"></p>
  <button class="lm-ending-go my-go" data-role="proceed" data-attr-aria-label="spoken" data-autofocus>つぎへ</button>
</div>
</template>
`;

/** 一つの選択肢だけを差し替える（番号を添え、押せないものと読んだものを data-lm-* で当てる）。 */
const OPTION = `<style>
  .my-option[data-lm-disabled] { opacity: 0.25; }
  .my-option[data-lm-read] { color: rgb(0, 0, 255); }
</style>
<template data-part="option" data-version="1">
<button class="my-option" data-role="choose"><span class="my-no" data-field="index"></span><span class="my-text" data-field="text"></span></button>
</template>
`;

/** 並べる枠だけを差し替える（一つの選択肢は標準のまま）。 */
const FRAME = `<template data-part="screen" data-version="1">
<div class="choices my-frame" data-look="frame">
  <p class="my-ask">どれにする</p>
  <template data-list="options" data-item="option"></template>
</div>
</template>
`;

/** 選択肢の画面の JS: 層に一行を足し、閉じたら外す。キーの x で api.result(2)（三つ目）を選ぶ。 */
const CHOICE_JS = `export default function (layer, api) {
  const note = document.createElement("p");
  note.className = "my-js-note";
  note.textContent = api.screen + ":" + api.values.timer;
  layer.append(note);
  const key = (e) => { if (e.key === "x") api.result(2); };
  document.addEventListener("keydown", key);
  return () => { document.removeEventListener("keydown", key); window.__choiceGone = (window.__choiceGone ?? 0) + 1; };
}
`;

/** メニューの画面の JS: 要素に印を付け、閉じたら数える。 */
const MENU_JS = `export default function (screen, api) {
  screen.dataset.fromJs = String(api.values.auto);
  return () => { window.__menuGone = (window.__menuGone ?? 0) + 1; };
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

const toChoice = async (p: Page) => {
  await waitText(p, "選ぶ前");
  await p.evaluate(() => window.__liminalia!.host.advance());
  await p.waitForFunction(() => window.__liminalia!.system.status!.choosing && document.querySelectorAll(".choices [data-role=choose]").length > 0, undefined, { timeout: 15_000 });
};

describe.skipIf(!e2e)("作品のテンプレートで差し替えたメニュー、操作説明、結末の名前、選択肢（ブラウザ）", { timeout: 300_000 }, () => {
  let project: TestProject;
  let framed: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({
      scenario: { a: SCENARIO, end: ENDING },
      config: { entry: "a", ui: { help: { pages: [{ title: "遊び方", text: "画面を押すと進む。" }] }, templates: templates(["menu", "help", "ending", "choice"]) } },
      before: write({ menu: MENU, help: HELP, ending: ENDING_TEMPLATE, choice: OPTION }, { menu: MENU_JS, choice: CHOICE_JS }),
    });
    framed = await startProject({ scenario: { a: SCENARIO }, config: { entry: "a", ui: { templates: templates(["choice"]) } }, before: write({ choice: FRAME }) });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
    await framed?.close();
  });

  it("メニュー: 型に書いた並びと項目だけを出し、使えない操作は外す。ボタンでない項目も押せ、キーとパッドで選べる", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, project.url, { start: "a" });
      await p.keyboard.press("Escape");
      await waitScreen(p, "menu");
      await waitFocus(p, "[data-lm-screen=menu]");
      expect(await focusedLabel(p), name).toBe("もどる");
      // 並びは型のまま。終了はブラウザでは使えないので外れる。項目には data-action
      expect(await p.locator(".my-menu [data-action]").evaluateAll((es) => es.map((e) => [e.getAttribute("data-action"), e.textContent])), name).toEqual([
        ["config", "コンフィグ"],
        ["backlog", "これまで"],
        ["save", "セーブ"],
      ]);
      expect(await p.locator(".my-log").evaluate((e) => [e.getAttribute("role"), e.getAttribute("tabindex")]), name).toEqual(["button", "0"]);
      // 矢印で選ぶと data-lm-focus が付き、作品の CSS が当たる
      await p.keyboard.press("ArrowUp");
      const picked = await focusedLabel(p);
      expect(["セーブ", "これまで", "コンフィグ"], `${name} ${picked}`).toContain(picked);
      expect(await p.evaluate(() => getComputedStyle(document.activeElement!).outlineColor), name).toBe("rgb(0, 128, 0)");
      // ボタンでない項目を Enter で押すと、メニューを閉じて履歴を開く
      await p.locator(".my-log").focus();
      await p.keyboard.press("Enter");
      await waitScreen(p, "backlog");
      expect(await p.locator(".my-menu").count(), name).toBe(0);
      await p.keyboard.press("Escape");
      await waitScreen(p, null);
      // 画面の JS が要素を受け取り、閉じたら片付けを呼ぶ
      await p.keyboard.press("Escape");
      await waitScreen(p, "menu");
      expect(await p.locator(".my-menu").getAttribute("data-from-js"), name).toBe("false");
      await p.keyboard.press("Escape");
      await waitScreen(p, null);
      expect(await p.evaluate(() => (window as unknown as { __menuGone?: number }).__menuGone), name).toBe(2);
      // パッドの START で開いて、B で閉じる
      await pad(p, "start");
      await waitScreen(p, "menu");
      await pad(p, "b");
      await waitScreen(p, null);
      await p.close();
    }
  });

  it("操作説明: 一行の部品だけを差し替え、タブと見出しは標準のまま。タブを替えてもフォーカスはそのタブに残る", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, project.url, { start: "a" });
      await p.evaluate(() => void window.__liminalia!.system.perform!("help"));
      await waitScreen(p, "help");
      expect(await p.locator(".lm-help-table tbody > tr.my-row").count(), name).toBeGreaterThan(3);
      expect(await p.locator(".lm-help-table tbody > tr.my-row").first().locator("td").count(), name).toBe(2);
      const tabs = p.locator(".lm-help .lm-tab");
      expect(await tabs.allTextContents(), name).toEqual(["操作", "遊び方"]);
      expect(await tabs.evaluateAll((ts) => ts.map((t) => t.getAttribute("aria-pressed"))), name).toEqual(["true", "false"]);
      await tabs.nth(1).focus();
      await p.keyboard.press("Enter");
      await p.waitForSelector(".lm-help-page");
      expect(await p.locator(".lm-help-text").textContent(), name).toBe("画面を押すと進む。");
      expect(await p.locator(".lm-help-page img").count(), name).toBe(0);
      expect(await tabs.evaluateAll((ts) => ts.map((t) => [t.getAttribute("aria-pressed"), t.hasAttribute("data-lm-current")])), name).toEqual([
        ["false", false],
        ["true", true],
      ]);
      expect(await focusedLabel(p), name).toBe("遊び方");
      await p.keyboard.press("Escape");
      await waitScreen(p, null);
      await p.close();
    }
  });

  it("結末の名前: 形を変えても、名前と種類と読み上げの名前を入れ、押すとタイトルへ進む", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, project.url, { start: "end" });
      await waitText(p, "はじまり");
      await p.keyboard.press("Enter");
      await waitScreen(p, "ending");
      await waitFocus(p, ".my-go");
      expect(await p.locator(".my-end").getAttribute("data-kind"), name).toBe("bad");
      expect([await p.locator(".my-end .lm-ending-name").textContent(), await p.locator(".my-kind").textContent()], name).toEqual(["灰色の朝", "BAD END"]);
      expect(await p.locator(".my-go").getAttribute("aria-label"), name).toBe("BAD END 灰色の朝 終 タイトルへ戻る");
      await p.keyboard.press("Enter");
      await waitMode(p, "title");
      await p.close();
    }
  });

  it("選択肢: 一つの選択肢の部品だけを差し替え、押せないもの、読んだもの、数字のキー、矢印、選んだ結果はエンジンが受け持つ", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, project.url, { start: "a" });
      await toChoice(p);
      // 層（.choices）の子に並び、番号と文が入る
      expect(await p.locator(".choices > .my-option").evaluateAll((es) => es.map((e) => [e.querySelector(".my-no")!.textContent, e.querySelector(".my-text")!.textContent])), name).toEqual([
        ["1", "甲"],
        ["2", "乙"],
        ["3", "丙"],
      ]);
      const locked = p.locator(".my-option", { hasText: "乙" });
      expect(await locked.evaluate((b) => [(b as HTMLButtonElement).disabled, b.hasAttribute("data-lm-disabled"), b.classList.contains("is-locked"), getComputedStyle(b).opacity]), name).toEqual([true, true, true, "0.25"]);
      await waitFocus(p, ".choices");
      expect(await p.evaluate(() => document.activeElement!.querySelector(".my-text")?.textContent), name).toBe("甲");
      await p.keyboard.press("ArrowDown");
      expect(await p.evaluate(() => document.activeElement!.querySelector(".my-text")?.textContent), name).toBe("丙");
      // 甲を選び、読んでから戻ると、甲に読んだ印が付き、作品の CSS が当たる
      await p.keyboard.press("1");
      await waitText(p, "甲を読んだ");
      await p.evaluate(() => window.__liminalia!.host.advance());
      await toChoice(p);
      const read = p.locator(".my-option", { hasText: "甲" });
      expect(await read.evaluate((b) => [b.hasAttribute("data-lm-read"), b.classList.contains("is-read"), getComputedStyle(b).color]), name).toEqual([true, true, "rgb(0, 0, 255)"]);
      // 画面の JS は層を受け取り、api.result(番号) で選べる。選び終えたら片付けを呼び、足した一行も層から消える
      await p.waitForSelector(".choices > .my-js-note");
      expect(await p.locator(".choices > .my-js-note").textContent(), name).toBe("choice:");
      await p.keyboard.press("x");
      await waitText(p, "丙を読んだ");
      expect(await p.evaluate(() => [(window as unknown as { __choiceGone?: number }).__choiceGone, document.querySelectorAll(".my-js-note").length]), name).toEqual([2, 0]);
      expect((await screenNow(p)).screen, name).toBeNull();
      await p.close();
    }
  });

  it("選択肢: 並べる枠だけを差し替えると、枠のクラスと属性は出している間だけ層に付き、一つの選択肢は標準のまま", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, framed.url, { start: "a" });
      await toChoice(p);
      const layer = await p.evaluate(() => {
        const c = document.querySelector(".choices")!;
        return { cls: c.classList.contains("my-frame"), look: c.getAttribute("data-look"), ask: c.querySelector(":scope > .my-ask")?.textContent, buttons: [...c.querySelectorAll(":scope > button")].map((b) => b.textContent) };
      });
      expect(layer, name).toEqual({ cls: true, look: "frame", ask: "どれにする", buttons: ["甲", "乙", "丙"] });
      await p.locator(".choices > button", { hasText: "丙" }).click();
      await waitText(p, "丙を読んだ");
      expect(await p.evaluate(() => { const c = document.querySelector(".choices")!; return [c.classList.contains("my-frame"), c.hasAttribute("data-look"), c.childElementCount]; }), name).toEqual([false, false, 0]);
      await p.close();
    }
  });
});
