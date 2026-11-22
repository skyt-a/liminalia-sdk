import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 探索と地図の画面の足りなかったもの（三回目の洗い出しの 27）を、実際のブラウザで確かめる。
 * - 調べる画面: 「場所を示す」で調べられる所をすべて光らせる。progress で見出しの横に調べた必須の場所の数を出す
 * - 地図の選択: 押せない地点を選ぶと、その理由（lockedDesc）を説明の欄に出す
 * - hud を立てた調べる画面と地図の選択の間も、常駐の文字を見せる（常駐のボタンは出さない）
 */

const SCENARIO = {
  inv: `@bg hill_night.webp
@hud-text day text="一日目" x=500 y=640 size=28
@hud-button memo label="メモ" x=1100 y=640 call=#memo
はじまり。
@investigate room
@stop
# desk
机を調べた。
# shelf
棚を調べた。
# memo
メモ。
@return
`,
  plain: `@bg hill_night.webp
@hud-text day text="一日目" x=500 y=640 size=28
はじまり。
@investigate plain
@stop
# desk
机を調べた。
`,
  map: `@bg hill_night.webp
@hud-text day text="一日目" x=500 y=640 size=28
はじまり。
@map-choice town result=temp.where
地図のあと。
@stop
`,
};

const spots = [
  { id: "desk", label: "机", rect: { x: 100, y: 200, width: 300, height: 300 }, target: "#desk" },
  { id: "shelf", label: "棚", rect: { x: 600, y: 200, width: 300, height: 300 }, target: "#shelf" },
  { id: "window", label: "窓", rect: { x: 950, y: 100, width: 200, height: 200 }, target: "#desk", required: false },
];

const DATA = {
  places: {
    room: { title: "部屋", file: "inv", finish: "button", progress: true, hud: true, views: [{ id: "a", label: "部屋", background: "hill_dusk.webp", spots }] },
    plain: { title: "部屋", file: "plain", finish: "button", views: [{ id: "a", label: "部屋", background: "hill_dusk.webp", spots: spots.slice(0, 1) }] },
  },
  maps: {
    town: {
      title: "行き先",
      file: "map",
      background: "hill_dusk.webp",
      hud: true,
      spots: [
        { id: "station", label: "駅", rect: { x: 100, y: 300, width: 120, height: 60 }, desc: "人が多い。" },
        { id: "park", label: "公園", rect: { x: 400, y: 300, width: 120, height: 60 }, desc: "静かな公園。", locked: "!game.key", lockedDesc: "門の鍵が要る。" },
      ],
    },
  },
};

describe.skipIf(!e2e)("探索と地図の画面（ブラウザ）", { timeout: 300_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({
      scenario: SCENARIO,
      config: { entry: "inv" },
      before: (dir) => {
        mkdirSync(join(dir, "data"), { recursive: true });
        writeFileSync(join(dir, "data", "investigation.json"), JSON.stringify(DATA));
      },
    });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  const open = async (browser: Browser, start: string, selector: string): Promise<Page> => {
    const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await p.goto(`${project.url}?autostart=1&start=${start}`);
    await p.waitForFunction(() => window.__liminalia?.host.waiting, undefined, { timeout: 60_000 });
    for (let i = 0; i < 20 && (await p.locator(selector).count()) === 0; i++) {
      await p.evaluate("window.__liminalia.host.advance()");
      await p.waitForTimeout(300);
    }
    await p.waitForSelector(selector, { timeout: 20_000 });
    await p.waitForTimeout(300);
    return p;
  };
  /** 常駐の文字（と、ボタン）が、一番上に見えているか（真ん中の点の一番上の要素がそれか）。 */
  const onTop = (p: Page, selector: string) =>
    p.evaluate((s) => {
      const el = document.querySelector<HTMLElement>(s);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width === 0) return false;
      // 常駐の層は押せない（pointer-events: none）ので、確かめる間だけ当たるようにする
      const was = el.style.pointerEvents;
      el.style.pointerEvents = "auto";
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      el.style.pointerEvents = was;
      return !!top && (top === el || el.contains(top)) && getComputedStyle(el).visibility !== "hidden";
    }, selector);

  it("調べる画面: 「場所を示す」で調べられる所を光らせ、progress なら調べた必須の場所の数を出す", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, "inv", ".lm-investigate-spot");
      expect(await p.locator(".lm-investigate-progress").textContent(), name).toBe("0 / 2");
      const border = () => p.evaluate(() => [...document.querySelectorAll(".lm-investigate-spot")].map((b) => getComputedStyle(b).borderTopColor));
      expect((await border()).every((c) => c === "rgba(0, 0, 0, 0)"), name).toBe(true);
      const reveal = p.locator(".lm-investigate-reveal");
      await reveal.click();
      expect(await reveal.getAttribute("aria-pressed"), name).toBe("true");
      expect((await border()).every((c) => c !== "rgba(0, 0, 0, 0)"), name).toBe(true);
      await reveal.click();
      expect((await border()).every((c) => c === "rgba(0, 0, 0, 0)"), name).toBe(true);
      // 調べると数が進む（必須でない窓は数えない）
      await p.locator('.lm-investigate-spot[data-spot="desk"]').click();
      await p.waitForFunction(() => document.querySelector(".message .text")?.textContent?.includes("机を調べた"), undefined, { timeout: 10_000 });
      for (let i = 0; i < 10 && (await p.locator(".lm-investigate-progress").count()) === 0; i++) {
        await p.evaluate("window.__liminalia.host.advance()");
        await p.waitForTimeout(300);
      }
      expect(await p.locator(".lm-investigate-progress").textContent(), name).toBe("1 / 2");
      await p.close();
    }
  });

  it("hud を立てた調べる画面と地図の選択の間は常駐の文字を見せ、常駐のボタンは出さない。立てなければ今までどおり隠れる", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, "inv", ".lm-investigate-spot");
      expect(await onTop(p, '.lim-hud-text[data-hud="day"]'), `${name} 調べる画面`).toBe(true);
      expect(await onTop(p, '.lim-hud-button[data-hud="memo"]'), `${name} 調べる画面のボタン`).toBe(false);
      // メニューを開いたら、常駐の文字はメニューの下
      await p.keyboard.press("Escape");
      await p.waitForSelector('.lm-sys [data-lm-screen="menu"], .lm-sys .lm-menu', { timeout: 5000 }).catch(() => undefined);
      expect(await onTop(p, '.lim-hud-text[data-hud="day"]'), `${name} メニュー`).toBe(false);
      await p.close();

      const m = await open(browser, "map", ".lm-map-choice-spot");
      expect(await onTop(m, '.lim-hud-text[data-hud="day"]'), `${name} 地図`).toBe(true);
      await m.close();

      const q = await open(browser, "plain", ".lm-investigate-spot");
      expect(await onTop(q, '.lim-hud-text[data-hud="day"]'), `${name} hud なし`).toBe(false);
      await q.close();
    }
  });

  it("地図の選択: 押せない地点を選ぶと、その理由（lockedDesc）を説明の欄に出す", async () => {
    for (const { name, browser } of list) {
      const m = await open(browser, "map", ".lm-map-choice-spot");
      await m.locator('.lm-map-choice-spot[data-spot="park"]').hover();
      await m.waitForTimeout(100);
      expect(await m.locator(".lm-map-choice-detail .lm-map-choice-locked").textContent(), name).toBe("門の鍵が要る。");
      expect(await m.locator(".lm-map-choice-go").isDisabled(), name).toBe(true);
      await m.locator('.lm-map-choice-spot[data-spot="station"]').hover();
      await m.waitForTimeout(100);
      expect(await m.locator(".lm-map-choice-detail .lm-map-choice-locked").count(), name).toBe(0);
      await m.close();
    }
  });
});
