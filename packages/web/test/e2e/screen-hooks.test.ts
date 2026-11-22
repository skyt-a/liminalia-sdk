import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 作品の画面に差し替える口（WebPlugin.screens の choice、name、dialog、help、items）を、実際のブラウザで確かめる。
 * どれも、差し替えると標準の部品（ボタン、名前の文字、枠、表）を作らずに作品の要素を出し、作品の要素から渡した答えで進む。
 * 差し替えていない作品は標準の部品のまま（同じ台本で比べる）。
 */

const SCENARIO = `@window show
@item-add key
アカリ「はじめの台詞。」
地の文。
@choice
- 右へ -> #right
- 左へ -> #left locked=true
@end
# right
@dialog type=confirm text="進みますか" target=#yes cancel-target=#no
# yes
@text-input game.who prompt="名前" initial="ソウ"
@item-select temp.used
結果 {= game.who}/{= temp.used}
# no
やめた。
`;

const PLUGIN = `import { defineWebPlugin } from "@liminalia/web";
const el = (cls, text) => { const e = document.createElement("div"); e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const button = (cls, text, onClick) => { const b = document.createElement("button"); b.className = cls; b.textContent = text; b.onclick = onClick; return b; };
export default defineWebPlugin({ name: "t",
  screens: {
    choice: (api) => {
      const row = el("my-choices");
      for (const o of api.options) { const b = button("my-choice", o.text + (o.locked ? "（鍵）" : ""), () => api.choose(o.index)); b.disabled = o.locked; row.append(b); }
      return row;
    },
    name: (api) => {
      const tag = el("my-name");
      const show = (n) => { tag.textContent = n.label ? "【" + n.label + "】" : ""; tag.dataset.speaker = n.speaker ?? ""; };
      show(api.current);
      api.onChange(show);
      return tag;
    },
    dialog: (api) => {
      const box = el("my-dialog");
      box.dataset.kind = api.kind;
      box.append(el("my-dialog-message", api.message));
      box.append(button("my-ok", api.okLabel, () => api.ok(api.input ? api.input.initial + "さん" : undefined)));
      if (api.cancelLabel) box.append(button("my-cancel", api.cancelLabel, () => api.cancel()));
      return box;
    },
    help: (api) => { const s = el("my-help", "操作 " + api.rows.length); s.onclick = () => api.close(); return s; },
    items: (api) => {
      const s = el("my-items");
      for (const key of Object.keys(api.items)) if (api.held[key]) s.append(button("my-item", api.items[key].name, () => (api.select ? api.select.pick(key) : api.close())));
      return s;
    },
  },
});
`;

describe.skipIf(!e2e)("作品の画面に差し替える口（ブラウザ）", { timeout: 300_000 }, () => {
  let custom: TestProject;
  let plain: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    const config = { entry: "a", items: { key: { name: "古い鍵" } } };
    custom = await startProject({ scenario: { a: SCENARIO }, plugin: PLUGIN, config });
    plain = await startProject({ scenario: { a: SCENARIO }, config });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await custom?.close();
    await plain?.close();
  });

  const open = async (browser: Browser, url: string): Promise<Page> => {
    const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await p.goto(`${url}?autostart=1&start=a`);
    await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("はじめ")`, undefined, { timeout: 60_000 });
    return p;
  };
  /** 条件が真になるまで送る（文字を出し切るクリックも数える）。 */
  const advanceUntil = async (p: Page, condition: string) => {
    for (let i = 0; i < 12 && !(await p.evaluate(condition)); i++) {
      await p.mouse.click(640, 300);
      await p.waitForTimeout(300);
    }
    expect(await p.evaluate(condition), condition).toBe(true);
  };
  const toChoices = (p: Page) => advanceUntil(p, `window.__liminalia.host.choosing === true`);
  const text = (p: Page, sel: string) => p.evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`) as Promise<string | null>;

  it("名前欄、選択肢、確かめと入力の枠、持ち物を作品の要素で出し、その答えで進む", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, custom.url);
      // 名前欄: .name の中に作品の要素があり、標準の文字は入れない
      await p.waitForFunction(`document.querySelector(".message .name .my-name")?.textContent === "【アカリ】"`, undefined, { timeout: 10_000 });
      expect(await p.evaluate(`document.querySelector(".message .name").classList.contains("lm-name-custom")`), name).toBe(true);
      expect(await p.evaluate(`document.querySelector(".message .name").childNodes.length`), name).toBe(1);
      // 地の文では名前欄を隠す
      await advanceUntil(p, `document.querySelector(".message .text")?.textContent.includes("地の文")`);
      expect(await p.evaluate(`[document.querySelector(".message .name").classList.contains("is-empty"), getComputedStyle(document.querySelector(".message .name")).display]`), name).toEqual([true, "none"]);
      // 選択肢: 作品の要素だけを出し、標準のボタンは作らない
      await toChoices(p);
      await p.waitForSelector(".choices .my-choices");
      expect(await p.evaluate(`[...document.querySelectorAll(".choices .my-choice")].map((b) => [b.textContent, b.disabled])`), name).toEqual([
        ["右へ", false],
        ["左へ（鍵）", true],
      ]);
      expect(await p.locator(".choices > button").count(), name).toBe(0);
      // 標準のボタンの見た目（幅、地）は作品のボタンに当たらず、押せる
      expect(await p.evaluate(`(() => { const s = getComputedStyle(document.querySelector(".my-choice")); return [s.pointerEvents, s.minWidth === "560px" || s.width === "560px"]; })()`), name).toEqual(["auto", false]);
      await p.screenshot({ path: `${process.env.LIMINALIA_E2E_SHOTS ?? "/tmp"}/screen-hooks-choice-${name}.png` }).catch(() => undefined);
      await p.click(".my-choice >> nth=0");
      // 確かめの枠: 標準の枠（.lm-panel-box）を作らず、作品の要素を幕の上に置く
      await p.waitForSelector(".lm-panel.lm-panel-custom .my-dialog[data-kind=confirm]");
      expect(await p.locator(".lm-panel-box").count(), name).toBe(0);
      expect([await text(p, ".my-dialog-message"), await text(p, ".my-ok"), await text(p, ".my-cancel")], name).toEqual(["進みますか", "OK", "キャンセル"]);
      await p.click(".my-ok");
      // 文字の入力の枠（@text-input）: ok に渡した文字が変数に入る
      await p.waitForSelector(".my-dialog[data-kind=text]");
      expect(await p.locator(".my-cancel").count(), name).toBe(0);
      await p.click(".my-ok");
      // 持ち物を選ばせる（@item-select）
      await p.waitForSelector(".my-items .my-item");
      expect(await p.locator(".lm-items").count(), name).toBe(0);
      await p.click(".my-item");
      await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("結果") && window.__liminalia.host.waiting`, undefined, { timeout: 10_000 });
      expect((await text(p, ".message .text"))?.replace("▼", ""), name).toBe("結果 ソウさん/key");
      // 操作説明（メニューから開く画面）
      await p.evaluate(`window.__liminalia.system.perform("help")`);
      await p.waitForSelector(".my-help");
      expect(await p.locator(".lm-help").count(), name).toBe(0);
      expect(await p.evaluate(`window.__liminalia.system.status.screen`), name).toBe("help");
      await p.click(".my-help");
      await p.waitForFunction(`window.__liminalia.system.status.screen === null`);
      await p.close();
    }
  });

  it("確かめの枠のやめるボタンと戻るで cancel-target へ進む", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, custom.url);
      await toChoices(p);
      await p.waitForSelector(".my-choice");
      await p.click(".my-choice >> nth=0");
      await p.waitForSelector(".my-dialog[data-kind=confirm]");
      await p.keyboard.press("Escape");
      await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("やめた")`, undefined, { timeout: 10_000 });
      expect(await p.locator(".my-dialog").count(), name).toBe(0);
      await p.close();
    }
  });

  it("差し替えていない作品は標準の部品のまま", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, plain.url);
      expect(await text(p, ".message .name"), name).toBe("アカリ");
      await toChoices(p);
      await p.waitForSelector(".choices > button");
      expect(await p.evaluate(`[...document.querySelectorAll(".choices > button")].map((b) => b.textContent)`), name).toEqual(["右へ", "左へ"]);
      await p.click(".choices > button >> nth=0");
      await p.waitForSelector(".lm-panel-box");
      expect(await p.evaluate(`[...document.querySelectorAll(".lm-panel-buttons button")].map((b) => b.textContent)`), name).toEqual(["OK", "キャンセル"]);
      await p.close();
    }
  });
});
