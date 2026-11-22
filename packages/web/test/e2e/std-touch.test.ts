import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { mapPanelRect } from "../../../std/src/commands/data-check.ts";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 標準の命令の画面（図鑑、調べる画面、地図の選択）を、指の端末（横持ちのスマホ）と縦長の作品で確かめる。
 * - 文字は画面で 12px 以上、押すボタンは画面で 44px 以上の高さ。小さい調べる場所と地点も、指で押せる広さで当たる
 * - 指では、調べる場所を一度押すと名前と枠を出し、もう一度押すと調べる（マウスは今までどおり一度で調べる）
 * - マウスの端末（指でない）では、今までの大きさのまま
 */

const SCENARIO = {
  inv: `@bg hill_night.webp
はじまり。
@investigate room
@stop
# desk
机を調べた。
# key
鍵を見つけた。
# giveup
あきらめた。
@stop
`,
  codex: `@bg hill_night.webp
はじまり。
@set game.met = true
@codex
おわり。
@stop
`,
  map: `@bg hill_night.webp
はじまり。
@map-choice town result=temp.where
地図のあと。
@stop
`,
};

const INVESTIGATION = {
  places: {
    room: {
      title: "部屋",
      file: "inv",
      finish: "button",
      incomplete: "#giveup",
      views: [
        {
          id: "a",
          label: "部屋",
          background: "hill_dusk.webp",
          spots: [
            { id: "desk", label: "机", rect: { x: 100, y: 200, width: 300, height: 300 }, target: "#desk" },
            // 小さい場所（舞台で 40px 四方。スマホでは 20px ほど）
            { id: "key", label: "小さな鍵", rect: { x: 520, y: 600, width: 40, height: 40 }, target: "#key" },
          ],
        },
        { id: "b", label: "窓", background: "hill_morning.webp", spots: [{ id: "window", label: "窓", rect: { x: 600, y: 200, width: 300, height: 300 }, target: "#desk" }] },
      ],
    },
  },
  maps: {
    town: {
      title: "行き先",
      prompt: "どこへ行く？",
      file: "map",
      background: "hill_dusk.webp",
      spots: [
        { id: "station", label: "駅", rect: { x: 100, y: 300, width: 80, height: 30 }, desc: "人が多い。" },
        { id: "park", label: "公園", rect: { x: 400, y: 300, width: 80, height: 30 }, desc: "静かな公園。" },
      ],
    },
  },
};

const CODEX = {
  categories: [
    { id: "people", label: "人物" },
    { id: "years", label: "年表", type: "timeline" },
    { id: "town", label: "地図", type: "map" },
  ],
  entries: [
    { id: "haru", category: "people", title: "ハル", reading: "はる", if: "game.met", sections: [{ title: "部活", text: "天文部の部長。" }] },
    { id: "yuika", category: "people", title: "ユイカ", if: "game.met", sections: [{ text: "後輩。" }] },
    { id: "early", category: "years", title: "出会い", date: "1923年", order: 1, if: "game.met" },
    { id: "station", category: "town", title: "駅", x: 40, y: 30, if: "game.met" },
  ],
};

const before = (dir: string) => {
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "data", "investigation.json"), JSON.stringify(INVESTIGATION));
  writeFileSync(join(dir, "data", "codex.json"), JSON.stringify(CODEX));
};

/** 画面の中の文字の大きさ（画面の px）と、押すボタンの高さ（画面の px）を測り、小さすぎるものを返す。 */
async function tooSmall(p: Page, rootSelector: string, skipButtons: string): Promise<{ text: string[]; buttons: string[] }> {
  return p.evaluate(
    ([rootSel, skip]) => {
      const stage = document.querySelector<HTMLElement>(".stage")!;
      const k = stage.getBoundingClientRect().width / stage.offsetWidth;
      const root = document.querySelector(rootSel)!;
      const text: string[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = n.textContent?.trim() ?? "";
        const el = n.parentElement!;
        const r = el.getBoundingClientRect();
        if (!t || r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === "hidden" || el.closest("[hidden]")) continue;
        const px = parseFloat(getComputedStyle(el).fontSize) * k;
        if (px < 11.9) text.push(`${el.className}「${t.slice(0, 8)}」${px.toFixed(1)}px`);
      }
      const buttons = [...root.querySelectorAll<HTMLElement>("button")]
        .filter((b) => !b.matches(skip) && !b.closest("[hidden]"))
        .map((b) => [b, b.getBoundingClientRect()] as const)
        .filter(([, r]) => r.width > 0 && r.height > 0 && r.height < 43.5)
        .map(([b, r]) => `${b.className}「${(b.textContent ?? "").trim().slice(0, 8)}」${r.height.toFixed(1)}px`);
      return { text, buttons };
    },
    [rootSelector, skipButtons] as const,
  );
}

/** 押せる場所（調べる場所、地点）の真ん中から上下左右に 20px（画面の px）離れた所を押しても、その場所に当たるか。 */
const hitAround = (p: Page, selector: string) =>
  p.evaluate((s) => {
    const b = document.querySelector<HTMLElement>(s)!;
    const r = b.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    return [
      [cx, cy - 20],
      [cx, cy + 20],
      [cx - 20, cy],
      [cx + 20, cy],
    ].every(([x, y]) => document.elementFromPoint(x!, y!)?.closest(s) === b);
  }, selector);

describe.skipIf(!e2e)("標準の命令の画面を指の端末と縦長の作品で使う（ブラウザ）", { timeout: 300_000 }, () => {
  let landscape: TestProject;
  let portrait: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    landscape = await startProject({ scenario: SCENARIO, config: { entry: "inv" }, before });
    portrait = await startProject({ scenario: SCENARIO, config: { entry: "inv", screen: { width: 720, height: 1280 } }, before });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await landscape?.close();
    await portrait?.close();
  });

  const open = async (browser: Browser, project: TestProject, start: string, selector: string, o: { touch: boolean; width: number; height: number }): Promise<Page> => {
    const context = await browser.newContext({ viewport: { width: o.width, height: o.height }, hasTouch: o.touch });
    const p = await context.newPage();
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
  const SPOTS = ".lm-investigate-spot, .lm-map-choice-spot";

  for (const [label, kind, size] of [
    ["横持ちのスマホ（812×375）", "landscape", { width: 812, height: 375 }],
    ["縦長の作品を縦持ちのスマホ（375×812）", "portrait", { width: 375, height: 812 }],
  ] as const) {
    it(`${label}: 図鑑、調べる画面、地図の選択の文字は 12px 以上、ボタンは 44px 以上で、小さい場所も押せる`, async () => {
      const project = kind === "landscape" ? landscape : portrait;
      for (const { name, browser } of list) {
        const at = `${name} ${kind}`;
        const codex = await open(browser, project, "codex", ".lm-codex", { touch: true, ...size });
        expect(await tooSmall(codex, ".lm-codex", SPOTS), `${at} 図鑑`).toEqual({ text: [], buttons: [] });
        // 開いたときの知らせ（積み上げる通知）も 12px 以上
        await codex.waitForSelector(".lm-notice", { timeout: 5000 });
        expect(await tooSmall(codex, ".lm-notices", SPOTS), `${at} 図鑑の知らせ`).toEqual({ text: [], buttons: [] });
        for (const category of ["years", "town"]) {
          await codex.locator(`.lm-tab[data-category="${category}"]`).click();
          expect(await tooSmall(codex, ".lm-codex", SPOTS), `${at} 図鑑 ${category}`).toEqual({ text: [], buttons: [] });
        }
        await codex.screenshot({ path: `${process.env.LIMINALIA_E2E_SHOTS ?? "/tmp"}/std-touch-codex-${kind}-${name}.png` }).catch(() => undefined);
        await codex.context().close();

        const inv = await open(browser, project, "inv", ".lm-investigate-spot", { touch: true, ...size });
        expect(await tooSmall(inv, ".lm-investigate", SPOTS), `${at} 調べる画面`).toEqual({ text: [], buttons: [] });
        expect(await hitAround(inv, '.lm-investigate-spot[data-spot="key"]'), `${at} 小さい場所`).toBe(true);
        // 名前の札も 12px 以上
        await inv.locator('.lm-investigate-spot[data-spot="key"]').tap();
        expect(await tooSmall(inv, ".lm-investigate", SPOTS), `${at} 調べる画面の名前`).toEqual({ text: [], buttons: [] });
        await inv.screenshot({ path: `${process.env.LIMINALIA_E2E_SHOTS ?? "/tmp"}/std-touch-investigate-${kind}-${name}.png` }).catch(() => undefined);
        await inv.context().close();

        const map = await open(browser, project, "map", ".lm-map-choice-spot", { touch: true, ...size });
        expect(await tooSmall(map, ".lm-map-choice", SPOTS), `${at} 地図の選択`).toEqual({ text: [], buttons: [] });
        expect(await hitAround(map, '.lm-map-choice-spot[data-spot="park"]'), `${at} 小さい地点`).toBe(true);
        if (kind === "portrait") {
          // 縦長では説明の欄を下に横いっぱいに置く
          const panel = (await map.locator(".lm-map-choice-panel").boundingBox())!;
          const stage = (await map.locator(".stage").boundingBox())!;
          expect(panel.width / stage.width, at).toBeGreaterThan(0.8);
          expect(panel.y + panel.height, at).toBeGreaterThan(stage.y + stage.height * 0.9);
          // 構文チェック（map-spot-hidden）が見る範囲の中に収まる（舞台の px。下の端と左右は同じ、高さは中身まで）
          const k = stage.width / 720;
          const want = mapPanelRect(undefined, { width: 720, height: 1280 });
          expect(Math.abs((panel.x - stage.x) / k - want.x), at).toBeLessThan(2);
          expect(Math.abs(panel.width / k - want.width), at).toBeLessThan(2);
          expect(Math.abs((panel.y + panel.height - stage.y) / k - (want.y + want.height)), at).toBeLessThan(2);
          expect((panel.y - stage.y) / k, at).toBeGreaterThanOrEqual(want.y - 2);
        }
        await map.screenshot({ path: `${process.env.LIMINALIA_E2E_SHOTS ?? "/tmp"}/std-touch-map-${kind}-${name}.png` }).catch(() => undefined);
        await map.context().close();
      }
    });
  }

  it("指では、調べる場所を一度押すと名前と枠を出し、もう一度押すと調べる。マウスは一度で調べる", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, landscape, "inv", ".lm-investigate-spot", { touch: true, width: 812, height: 375 });
      const desk = p.locator('.lm-investigate-spot[data-spot="desk"]');
      await desk.tap();
      await p.waitForTimeout(300);
      expect(await p.locator(".lm-investigate-tip").isVisible(), name).toBe(true);
      expect(await p.locator(".lm-investigate-tip").textContent(), name).toBe("机");
      expect(await desk.getAttribute("data-armed"), name).toBe("true");
      expect(await p.locator(".lm-investigate").count(), name).toBe(1);
      // 別の場所を押すと、そちらの名前に替わる（まだ調べない）
      await p.locator('.lm-investigate-spot[data-spot="key"]').tap();
      await p.waitForTimeout(300);
      expect(await p.locator(".lm-investigate-tip").textContent(), name).toBe("小さな鍵");
      expect(await desk.getAttribute("data-armed"), name).toBeNull();
      // もう一度押すと調べる
      await desk.tap();
      await p.waitForTimeout(200);
      await desk.tap();
      await p.waitForFunction(() => document.querySelector(".message .text")?.textContent?.includes("机を調べた"), undefined, { timeout: 10_000 });
      await p.context().close();

      const m = await open(browser, landscape, "inv", ".lm-investigate-spot", { touch: false, width: 1280, height: 720 });
      await m.locator('.lm-investigate-spot[data-spot="desk"]').click();
      await m.waitForFunction(() => document.querySelector(".message .text")?.textContent?.includes("机を調べた"), undefined, { timeout: 10_000 });
      await m.context().close();
    }
  });

  it("マウスの端末では、今までの大きさのまま", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, landscape, "codex", ".lm-codex", { touch: false, width: 1280, height: 720 });
      const size = (s: string) => p.evaluate((sel) => parseFloat(getComputedStyle(document.querySelector(sel)!).fontSize), s);
      expect([await size(".lm-codex-item"), await size(".lm-codex .lm-tab"), await size(".lm-codex-title"), await size(".lm-codex .lm-screen-title")], name).toEqual([16, 16, 24, 30]);
      await p.context().close();
    }
  });
});
