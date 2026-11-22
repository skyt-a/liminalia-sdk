import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/**
 * 確認の画面（system.ask）の今の動きを、実際のブラウザで確かめる。標準の画面を HTML の型で書き直しても、同じに通ること。
 * - 形: 暗がり（.lm-dialog-backdrop）の中に枠（.lm-dialog、role=alertdialog、aria-modal）、文、いいえ、はい の順のボタン
 * - フォーカス: 開いたら「はい」。矢印キーとTabで二つのボタンを回り、外へ出ない。閉じたら開く前の要素へ戻る
 * - 結果: はい は true、いいえ、Esc、右クリック は false。閉じたら画面から外れる
 */

const SCENARIO = `@window show
はじめ。
つぎ。
`;

/** 尋ねて、答えを window.__answer に入れる（出るまで待つ）。 */
const ask = async (p: Page, message = "進みますか") => {
  await p.evaluate(`window.__answer = undefined; void window.__liminalia.system.ask(${JSON.stringify(message)}, "confirm").then((ok) => (window.__answer = ok))`);
  await p.waitForSelector("[data-lm-screen='confirm']");
  await p.waitForTimeout(100);
};
const answer = async (p: Page) => {
  await p.waitForFunction("window.__answer !== undefined", undefined, { timeout: 5000 });
  return p.evaluate("window.__answer") as Promise<boolean>;
};
const focused = (p: Page) => p.evaluate(`document.activeElement?.textContent ?? ""`) as Promise<string>;
const gone = (p: Page) => p.evaluate(`!document.querySelector("[data-lm-screen='confirm']")`) as Promise<boolean>;

describe.skipIf(!e2e)("確認の画面の動き（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({ scenario: { a: SCENARIO }, config: { entry: "a" } });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("形と読み上げの印、初めのフォーカス", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await ask(p, "本当に進みますか");
      const shape = await p.evaluate(`(() => {
        const root = document.querySelector("[data-lm-screen='confirm']");
        const box = root.querySelector(".lm-dialog");
        return {
          root: root.className,
          box: box.className,
          role: box.getAttribute("role"),
          modal: box.getAttribute("aria-modal"),
          message: root.querySelector(".lm-dialog-message").textContent,
          buttons: [...root.querySelectorAll(".lm-dialog-buttons button")].map((b) => [b.className, b.textContent, b.type]),
          tabindex: root.getAttribute("tabindex"),
        };
      })()`);
      expect(shape, name).toEqual({
        root: "lm-dialog-backdrop",
        box: "lm-dialog",
        role: "alertdialog",
        modal: "true",
        message: "本当に進みますか",
        buttons: [
          ["lm-button", "いいえ", "button"],
          ["lm-button lm-primary", "はい", "button"],
        ],
        tabindex: "-1",
      });
      expect(await focused(p), name).toBe("はい");
      await p.keyboard.press("Escape");
      expect(await answer(p), name).toBe(false);
      await p.close();
    }
  });

  it("矢印キーとTabで二つのボタンを回り、Enter で押す", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await ask(p);
      await p.keyboard.press("ArrowLeft");
      expect(await focused(p), name).toBe("いいえ");
      await p.keyboard.press("ArrowRight");
      expect(await focused(p), name).toBe("はい");
      await p.keyboard.press("Tab");
      expect(await focused(p), name).toBe("いいえ");
      await p.keyboard.press("Tab");
      expect(await focused(p), name).toBe("はい");
      await p.keyboard.press("Shift+Tab");
      expect(await focused(p), name).toBe("いいえ");
      await p.keyboard.press("Enter");
      expect(await answer(p), name).toBe(false);
      expect(await gone(p), name).toBe(true);

      await ask(p);
      await p.keyboard.press("Enter");
      expect(await answer(p), name).toBe(true);
      expect(await gone(p), name).toBe(true);
      await p.close();
    }
  });

  it("テキスト読み上げでは、キーで選んだボタンの文字を読む", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.addInitScript(() => {
        const said: string[] = [];
        (window as unknown as { __said: string[] }).__said = said;
        Object.defineProperty(window, "speechSynthesis", { value: { speak: (u: { text: string }) => said.push(u.text), cancel: () => undefined }, configurable: true });
        (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = class {
          lang = "";
          constructor(public text: string) {}
        };
      });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForFunction("window.__liminalia?.host.waiting");
      await p.evaluate("window.__liminalia.system.updateSettings({ selfVoicing: true })");
      await ask(p);
      await p.evaluate("window.__said.length = 0");
      await p.keyboard.press("ArrowLeft");
      await p.keyboard.press("ArrowRight");
      expect(await p.evaluate("window.__said"), name).toEqual(["いいえ", "はい"]);
      await p.keyboard.press("Escape");
      expect(await answer(p), name).toBe(false);
      await p.close();
    }
  });

  it("はい は true、いいえ と右クリックは false。閉じたらフォーカスを戻し、本文は送らない", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      const page = () => p.evaluate("window.__liminalia.runtime().state.position.index") as Promise<number>;
      const before = await page();
      // 開く前に選んでいた要素（舞台の上のボタンの代わり）
      await p.evaluate(`(() => { const b = document.createElement("button"); b.id = "before"; b.textContent = "前"; document.querySelector(".lm-stage, #stage, body").append(b); b.focus(); })()`);
      await ask(p);
      await p.locator("[data-lm-screen='confirm'] button", { hasText: "はい" }).click();
      expect(await answer(p), name).toBe(true);
      expect(await p.evaluate(`document.activeElement?.id`), name).toBe("before");

      await ask(p);
      await p.locator("[data-lm-screen='confirm'] button", { hasText: "いいえ" }).click();
      expect(await answer(p), name).toBe(false);

      await ask(p);
      await p.locator("[data-lm-screen='confirm']").click({ button: "right", position: { x: 5, y: 5 } });
      expect(await answer(p), name).toBe(false);
      expect(await gone(p), name).toBe(true);
      // 暗がりを押しても閉じず、本文も送らない
      await ask(p);
      await p.locator("[data-lm-screen='confirm']").click({ position: { x: 5, y: 5 } });
      await p.waitForTimeout(300);
      expect(await gone(p), name).toBe(false);
      await p.keyboard.press("Escape");
      expect(await answer(p), name).toBe(false);
      expect(await page(), name).toBe(before);
      await p.close();
    }
  });
});

/**
 * 作品が写して直した確認の画面（liminalia.json の ui.templates.confirm）。HTML と CSS だけで形を変え、印の付いた要素に機能が付く。
 * スクリプト、on* の属性、外の URL は外す。同じ画面をプラグインの screens.confirm が差し替えていれば、そちらが先。
 */
const AUTHOR_TEMPLATE = `<!-- 標準の確認の画面（版 1）から写して直した -->
<style>
  .my-ask { position: absolute; inset: 0; display: flex; align-items: flex-end; justify-content: center; }
  .my-ask .lm-dialog { background: rgb(10, 20, 30); }
  .my-ask .my-close[data-lm-focus] { outline: 2px solid rgb(200, 100, 0); }
  .my-ask { background-image: url(https://example.com/bg.png); }
</style>
<template data-part="screen" data-version="1">
<div class="lm-dialog-backdrop my-ask">
  <div class="lm-dialog">
    <p class="my-ask-kind" data-field="kind"></p>
    <p class="lm-dialog-message" data-field="message"></p>
    <div class="lm-dialog-buttons">
      <button class="lm-button lm-primary my-yes" data-role="ok" data-autofocus>進む</button>
      <span class="my-close" data-role="close">閉じる</span>
      <button class="lm-button" data-role="cancel" data-text="confirm.no"></button>
    </div>
    <script>window.__bad = 1;</script>
    <img class="my-img" src="https://example.com/x.png" onerror="window.__bad = 2">
  </div>
</div>
</template>
`;

const writeTemplate = (dir: string) => {
  mkdirSync(join(dir, "ui", "screens", "confirm"), { recursive: true });
  writeFileSync(join(dir, "ui", "screens", "confirm", "confirm.html"), AUTHOR_TEMPLATE);
};

/** 同じ画面を差し替えるプラグイン（screens.confirm）。 */
const PLUGIN = `export default {
  screens: {
    confirm: (api) => {
      const box = document.createElement("div");
      box.id = "plugin-confirm";
      const yes = document.createElement("button");
      yes.textContent = api.yes;
      yes.addEventListener("click", () => api.answer(true));
      box.append(yes);
      return box;
    },
  },
};
`;

describe.skipIf(!e2e)("作品の型で差し替えた確認の画面（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let both: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    const config = { entry: "a", ui: { templates: { confirm: "ui/screens/confirm/confirm.html" } } };
    project = await startProject({ scenario: { a: SCENARIO }, config, before: writeTemplate });
    both = await startProject({ scenario: { a: SCENARIO }, config, plugin: PLUGIN, before: writeTemplate });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
    await both?.close();
  });

  it("HTML と CSS で形を変え、閉じる印が働き、キーとフォーカスが付く。スクリプトと外の URL は外す", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await ask(p, "作品の形で尋ねる");
      const shape = await p.evaluate(`(() => {
        const root = document.querySelector("[data-lm-screen='confirm']");
        return {
          root: root.className,
          role: root.getAttribute("role"),
          modal: root.getAttribute("aria-modal"),
          kind: root.querySelector(".my-ask-kind").textContent,
          message: root.querySelector(".lm-dialog-message").textContent,
          buttons: [...root.querySelectorAll("[data-role]")].map((b) => b.textContent),
          close: [root.querySelector(".my-close").getAttribute("role"), root.querySelector(".my-close").getAttribute("tabindex")],
          bg: getComputedStyle(root.querySelector(".lm-dialog")).backgroundColor,
          backdropImage: getComputedStyle(root).backgroundImage,
          scripts: root.querySelectorAll("script").length,
          img: [root.querySelector(".my-img").hasAttribute("src"), root.querySelector(".my-img").hasAttribute("onerror")],
          bad: window.__bad ?? null,
        };
      })()`);
      expect(shape, name).toEqual({
        root: "lm-dialog-backdrop my-ask",
        role: "alertdialog",
        modal: "true",
        kind: "confirm",
        message: "作品の形で尋ねる",
        buttons: ["進む", "閉じる", "いいえ"],
        close: ["button", "0"],
        bg: "rgb(10, 20, 30)",
        backdropImage: "none",
        scripts: 0,
        img: [false, false],
        bad: null,
      });
      // 初めのフォーカスは data-autofocus。矢印キーで印の付いた要素を回る
      expect(await focused(p), name).toBe("進む");
      await p.keyboard.press("ArrowRight");
      expect(await focused(p), name).toBe("閉じる");
      expect(await p.evaluate(`getComputedStyle(document.querySelector(".my-close")).outlineColor`), name).toBe("rgb(200, 100, 0)");
      await p.keyboard.press("Tab");
      expect(await focused(p), name).toBe("いいえ");
      await p.keyboard.press("Tab");
      expect(await focused(p), name).toBe("進む");
      // 閉じる印（ボタンでない要素）を Enter で押すと「いいえ」
      await p.keyboard.press("Shift+Tab");
      await p.keyboard.press("Shift+Tab");
      expect(await focused(p), name).toBe("閉じる");
      await p.keyboard.press("Enter");
      expect(await answer(p), name).toBe(false);
      expect(await gone(p), name).toBe(true);
      // ok の印は「はい」、Esc は「いいえ」
      await ask(p);
      await p.locator(".my-yes").click();
      expect(await answer(p), name).toBe(true);
      await ask(p);
      await p.keyboard.press("Escape");
      expect(await answer(p), name).toBe(false);
      await p.close();
    }
  });

  it("型を書き換えたら、次に開いた確認の画面から効く（開発サーバー）", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      writeFileSync(join(project.dir, "ui", "screens", "confirm", "confirm.html"), AUTHOR_TEMPLATE.replace(">進む<", ">先へ<"));
      await p.waitForFunction("window.__liminalia.system !== undefined");
      await p.waitForTimeout(800);
      await ask(p);
      expect(await focused(p), name).toBe("先へ");
      await p.keyboard.press("Escape");
      expect(await answer(p), name).toBe(false);
      writeFileSync(join(project.dir, "ui", "screens", "confirm", "confirm.html"), AUTHOR_TEMPLATE);
      await p.waitForTimeout(800);
      await p.close();
    }
  });

  it("同じ画面をプラグインの screens.confirm が差し替えていれば、そちらが先", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, both.url, "a");
      await p.evaluate(`window.__answer = undefined; void window.__liminalia.system.ask("どちら", "confirm").then((ok) => (window.__answer = ok))`);
      await p.waitForSelector("#plugin-confirm");
      expect(await p.evaluate(`!!document.querySelector(".my-ask")`), name).toBe(false);
      await p.locator("#plugin-confirm button").click();
      expect(await answer(p), name).toBe(true);
      await p.close();
    }
  });
});
