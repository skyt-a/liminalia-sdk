import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { SCREENS } from "./game-screen-cases.ts";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 遊ぶ人の操作を待つ作品の画面（std の調べる画面、地図、図鑑と、持ち物を選ぶ画面、文字の入力、確認の枠、@open-screen の作品の画面）を
 * 出している間も、メニュー、セーブ、ロード、履歴、コンフィグを開け、閉じたら元の画面に戻り、セーブしてロードすると同じ画面に戻ることを確かめる。
 * 待つ命令（waits）を一覧に分けておき、新しく画面を出す命令を足して下の SCREENS に書かなければ、一覧の確かめが落ちる。
 */

const SCENARIO = (line: string) => `@bg hill_dusk.webp
@window show
@item-add key
はじまり。
${line}
あと。
@stop
# spot
調べた。
@stop
# station
着いた。
@stop
`;

const INVESTIGATION = {
  places: { room: { title: "部屋", file: "investigate", finish: "button", incomplete: "#spot", views: [{ id: "a", label: "部屋", background: "hill_dusk.webp", spots: [{ id: "desk", label: "机", rect: { x: 100, y: 200, width: 300, height: 300 }, target: "#spot" }] }] } },
  maps: { town: { title: "行き先", file: "map-choice", background: "hill_dusk.webp", spots: [{ id: "station", label: "駅", rect: { x: 100, y: 300, width: 120, height: 60 }, target: "#station", desc: "人が多い。" }] } },
};
const CODEX = { categories: [{ id: "people", label: "人物" }], entries: [{ id: "a", category: "people", title: "アカリ" }] };

const scenarioName = (id: string) => id.replace(/[^a-z]/g, "");

describe.skipIf(!e2e)("遊ぶ人の操作を待つ画面とメニュー（ブラウザ）", { timeout: 600_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({
      scenario: Object.fromEntries(Object.entries(SCREENS).map(([id, c]) => [scenarioName(id), SCENARIO(c.line)])),
      config: { entry: "investigate", items: { key: { name: "古い鍵" } } },
      before: (dir) => {
        mkdirSync(join(dir, "data"), { recursive: true });
        // 地図と調べる場所の file は、それを出すファイル（場面の名前は同じ）
        const data = structuredClone(INVESTIGATION);
        data.places.room.file = scenarioName("investigate");
        data.maps.town.file = scenarioName("map-choice");
        writeFileSync(join(dir, "data", "investigation.json"), JSON.stringify(data));
        writeFileSync(join(dir, "data", "codex.json"), JSON.stringify(CODEX));
      },
    });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  const top = (p: Page) => p.evaluate("window.__liminalia.system.screen") as Promise<string | null>;
  /** 標準の画面（name）が開くまで待つ。 */
  const opened = (p: Page, name: string) => p.waitForSelector(`[data-lm-screen='${name}']`, { timeout: 10_000 });
  const closed = (p: Page, name: string) => p.waitForSelector(`[data-lm-screen='${name}']`, { state: "detached", timeout: 10_000 });

  for (const [id, c] of Object.entries(SCREENS)) {
    it(`${id}: 出している間もメニュー、セーブ、ロード、履歴、コンフィグを開け、閉じたら戻り、ロードすると同じ画面に戻る`, async () => {
      for (const { name, browser } of list) {
        const label = `${name} ${id}`;
        const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        await p.goto(`${project.url}?autostart=1&start=${scenarioName(id)}`);
        await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("はじまり")`, undefined, { timeout: 60_000 });
        // 文字を出し終えて送るまで押す
        for (let i = 0; i < 20 && (await p.locator(c.shown).count()) === 0; i++) {
          await p.mouse.click(640, 650);
          await p.waitForTimeout(300);
        }
        await p.waitForSelector(c.shown, { timeout: 20_000 });
        await p.waitForTimeout(300);
        const screenName = await top(p);
        const stillShown = async () => {
          expect(await p.locator(c.shown).count(), label).toBeGreaterThan(0);
          expect(await top(p), label).toBe(screenName);
        };

        if (!c.typing) {
          // 履歴（B）とコンフィグ（C）を開いて Esc で閉じると、元の画面に戻る
          await p.keyboard.press("b");
          await opened(p, "backlog");
          await p.keyboard.press("Escape");
          await closed(p, "backlog");
          await stillShown();
          await p.keyboard.press("c");
          await opened(p, "config");
          await p.keyboard.press("Escape");
          await closed(p, "config");
          await stillShown();
          // クイックセーブ（S）
          await p.keyboard.press("s");
          await p.waitForFunction(`[...document.querySelectorAll(".lm-toast")].some((t) => t.textContent.includes("クイックセーブしました"))`, undefined, { timeout: 5000 });
        }

        // スマホの右上のメニューのボタンが出ていて、押すとメニューが開く（作品の画面の上に）
        await p.evaluate(`document.documentElement.classList.add("lm-emulate-touch")`);
        const menuButton = p.locator(".lm-touch-menu");
        expect(await menuButton.isVisible(), label).toBe(true);
        // メニューのボタンは、画面のボタンや入力欄に重ならない（画面が右上を空ける）
        await p.waitForTimeout(300);
        const covered = await p.evaluate(`(() => {
          const m = document.querySelector(".lm-touch-menu").getBoundingClientRect();
          return [...document.querySelectorAll(".lm-custom-screen button, [data-lm-screen] button, .lm-panel button, .lm-panel input")]
            .filter((b) => !b.classList.contains("lm-touch-menu"))
            .map((b) => [b.textContent.trim() || b.className, b.getBoundingClientRect()])
            .filter(([, r]) => r.width > 0 && r.height > 0 && r.left < m.right && r.right > m.left && r.top < m.bottom && r.bottom > m.top)
            .map(([t]) => t);
        })()`);
        expect(covered, label).toEqual([]);
        await menuButton.click();
        await opened(p, "menu");
        // メニューからセーブ: 一つ目の枠に書いて閉じると、元の画面に戻る
        await p.locator('.lm-menu button[data-action="save"]').click();
        await opened(p, "save");
        await p.locator(".lm-slot-wrap").first().locator(".lm-slot").click();
        await p.waitForFunction(`[...document.querySelectorAll(".lm-slot-text")].some((t) => t.textContent.includes("はじまり"))`, undefined, { timeout: 5000 });
        await p.keyboard.press("Escape");
        await closed(p, "save");
        await stillShown();

        // メニューからロード: 確かめて読むと、同じ画面がひとつだけ出る
        await menuButton.click();
        await opened(p, "menu");
        await p.locator('.lm-menu button[data-action="load"]').click();
        await opened(p, "load");
        await p.locator(".lm-slot-wrap").first().locator(".lm-slot").click();
        await p.locator("[data-lm-screen='confirm'] .lm-primary").click();
        await closed(p, "load");
        await p.waitForSelector(c.shown, { timeout: 20_000 });
        await p.waitForTimeout(500);
        expect(await top(p), label).toBe(screenName);
        expect(await p.locator(".lm-panel").count(), label).toBe(c.shown.startsWith(".lm-panel") ? 1 : 0);
        expect(await p.evaluate(`document.querySelectorAll(".lm-custom-screen").length`), label).toBe(screenName && screenName !== "items" ? 1 : 0);

        // Esc と右クリック: 戻るを持たない画面ではメニューを開き（閉じると元の画面）、戻るを持つ画面（図鑑、持ち物の選択、確かめの枠の Esc）はそちら
        const menuThenBack = async () => {
          await opened(p, "menu");
          // 本文を読み進める操作は並べない
          expect(await p.locator('.lm-menu button[data-action="auto"]').count(), label).toBe(0);
          await p.keyboard.press("Escape");
          await closed(p, "menu");
          await stillShown();
        };
        if (c.escape === "menu") {
          await p.keyboard.press("Escape");
          await menuThenBack();
          // スマホの戻る（Android の戻るボタン、ブラウザの戻る）も同じ。もう一度でメニューを閉じる
          expect(await p.evaluate("window.__liminalia.back()"), label).toBe(true);
          await opened(p, "menu");
          expect(await p.evaluate("window.__liminalia.back()"), label).toBe(true);
          await closed(p, "menu");
          await stillShown();
        }
        if (c.rightClick === "menu") {
          await p.mouse.click(640, 100, { button: "right" });
          await menuThenBack();
        }
        if (c.escape === "back") await p.keyboard.press("Escape");
        else if (c.rightClick === "back") await p.mouse.click(640, 100, { button: "right" });
        if (c.escape === "back" || c.rightClick === "back") {
          await p.waitForSelector(c.shown, { state: "detached", timeout: 10_000 });
          expect(await top(p), label).toBeNull();
        }
        await p.close();
      }
    });
  }
});
