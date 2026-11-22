import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/** 図鑑の新着の知らせを、条件の式が読む変数が変わった時点で出すこと（次のページを待たない）を、実際のブラウザで確かめる。 */

const SCENARIO = `@window show
はじまり。
@set game.other = 1
@wait 1500ms
@set game.met = true
@wait 3000ms
次のページ。
`;

const CODEX = { categories: [{ id: "people", label: "人物" }], entries: [{ id: "haru", category: "people", title: "ハル", if: "game.met" }] };

describe.skipIf(!e2e)("図鑑の新着の知らせ（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({
      scenario: { a: SCENARIO },
      config: { entry: "a" },
      before: (dir) => {
        mkdirSync(join(dir, "data"), { recursive: true });
        writeFileSync(join(dir, "data", "codex.json"), JSON.stringify(CODEX));
      },
    });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("@set で条件が真になったら、次のページを待たずに知らせる。条件が読まない変数では見回さない", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("はじまり")`);
      // 見回した回数を数える（図鑑の条件の式 game.met を評価した回数）
      await p.evaluate(`(() => { const rt = window.__liminalia.system.runtime; const ev = rt.eval.bind(rt); window.__evals = 0; rt.eval = (e) => (JSON.stringify(e).includes('"met"') && window.__evals++, ev(e)); })()`);
      await p.evaluate("window.__liminalia.host.advance()");
      await p.waitForTimeout(80);
      await p.evaluate("window.__liminalia.host.advance()");
      // game.other は条件が読まないので見回さない
      await p.waitForTimeout(800);
      expect(await p.evaluate("window.__evals"), name).toBe(0);
      // game.met が立った時点（@wait の途中）で知らせる（標準の知らせ）
      await p.waitForSelector(".lm-notice", { timeout: 5000 });
      expect(await p.locator(".lm-notice").textContent(), name).toContain("ハル");
      expect(await p.evaluate(`document.querySelector(".message .text")?.textContent ?? ""`), name).not.toContain("次のページ");
      await p.close();
    }
  });
});

/** 続けて開いたものと、一度に開いたもの。知らせは標準の知らせ（積み上げる）で出す。 */
const MANY = `@window show
はじまり。
@codex-unlock aki
@codex-unlock fuyu
@codex-unlock natsu
続けて開いた。
@set game.all = true
一度に開いた。
@codex-unlock aki section=more
@codex-unlock fuyu section=more
段が開いた。
`;

const MANY_CODEX = {
  categories: [{ id: "people", label: "人物" }],
  entries: [
    { id: "aki", category: "people", title: "アキ", sections: [{ text: "はじめ" }, { id: "more", text: "続き", locked: true }] },
    { id: "fuyu", category: "people", title: "フユ", sections: [{ text: "はじめ" }, { id: "more", text: "続き", locked: true }] },
    { id: "natsu", category: "people", title: "ナツ" },
    { id: "haru", category: "people", title: "ハル", if: "game.all" },
    { id: "kaze", category: "people", title: "カゼ", if: "game.all" },
    { id: "sora", category: "people", title: "ソラ", if: "game.all" },
  ],
};

describe.skipIf(!e2e)("図鑑の知らせを続けて出す（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({
      scenario: { a: MANY },
      config: { entry: "a" },
      before: (dir) => {
        mkdirSync(join(dir, "data"), { recursive: true });
        writeFileSync(join(dir, "data", "codex.json"), JSON.stringify(MANY_CODEX));
      },
    });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("@codex-unlock を続けて書けば一つずつ知らせ、条件で一度に開いたものは数でまとめる", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      // 出た知らせの文を、出た順にすべて控える（出しておく時間によらない）
      await p.addInitScript(() => {
        const w = window as unknown as { __notices: string[] };
        w.__notices = [];
        new MutationObserver((list) => {
          for (const m of list) for (const n of m.addedNodes) if (n instanceof HTMLElement && n.classList.contains("lm-notice")) w.__notices.push(n.textContent ?? "");
        }).observe(document, { childList: true, subtree: true });
      });
      await p.goto(`${project.url}?autostart=1&start=a`);
      const page = (text: string) => p.waitForFunction(`window.__liminalia?.host.waiting === true && document.querySelector(".message .text")?.textContent.includes(${JSON.stringify(text)})`, null, { timeout: 60_000 });
      const notices = () => p.evaluate("window.__notices") as Promise<string[]>;
      await page("はじまり");
      await p.evaluate("window.__liminalia.host.advance()");
      await page("続けて開いた");
      await p.waitForFunction("window.__notices.length >= 3", null, { timeout: 60_000 });
      expect(await notices(), name).toEqual(["記録に「アキ」を加えた", "記録に「フユ」を加えた", "記録に「ナツ」を加えた"]);
      // 三つとも並んで見えている（前のものを消して置き換えない）
      expect(await p.evaluate(`document.querySelectorAll(".lm-notice").length`), name).toBe(3);
      await p.evaluate("window.__liminalia.host.advance()");
      await page("一度に開いた");
      await p.waitForFunction("window.__notices.length >= 4", null, { timeout: 60_000 });
      expect((await notices()).slice(3), name).toEqual(["記録に 3 件加えた"]);
      await p.evaluate("window.__liminalia.host.advance()");
      await page("段が開いた");
      await p.waitForFunction("window.__notices.length >= 6", null, { timeout: 60_000 });
      expect((await notices()).slice(4), name).toEqual(["「アキ」の記録が増えた", "「フユ」の記録が増えた"]);
      await p.close();
    }
  });
});
