import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 図鑑の区分の見せ方（年表・相関図・地図）と、作品が図鑑の画面を差し替える口（WebPlugin の screens.codex）を、実際のブラウザで確かめる。
 * 項目を決めずに開いたとき（と区分を替えたとき）は、新しい印の付いた項目、無ければ並びの一つ目を右の欄に出しておく。
 * そうして出しておいただけの項目は読んだことにしない（「新」の印を残す）。遊ぶ人が選んだ項目と、@codex で名前を決めて開いた項目を読んだことにする。
 */

const SCENARIO = `@bg hill_night.webp
はじまり。
@set game.met = true
@codex haru
おわり。
@stop
`;

/** 項目を決めずに開く（@codex だけ）。 */
const OPEN_ANY = `@bg hill_night.webp
はじまり。
@set game.met = true
@codex
おわり。
@stop
`;

const CODEX = {
  title: "記録",
  categories: [
    { id: "people", label: "相関図", type: "relations" },
    { id: "years", label: "年表", type: "timeline" },
    { id: "town", label: "地図", type: "map", map: "town.png" },
  ],
  entries: [
    { id: "haru", category: "people", title: "ハル", image: "face.png", x: 25, y: 50, if: "game.met", links: [{ to: "yuika", label: "友人", tone: "positive" }], sections: [{ text: "天文部の部長。" }] },
    { id: "yuika", category: "people", title: "ユイカ", x: 75, y: 50, if: "game.met", sections: [{ text: "後輩。" }] },
    { id: "late", category: "years", title: "事件", date: "1925年", order: 2, if: "game.met" },
    { id: "early", category: "years", title: "出会い", date: "1923年", order: 1, if: "game.met" },
    { id: "station", category: "town", title: "駅", x: 40, y: 30, if: "game.met" },
  ],
};

const PLUGIN = `
import { defineWebPlugin } from "@liminalia/web";
const log = (window.__codex = { calls: [], closed: 0 });
export default defineWebPlugin({
  name: "t",
  screens: {
    codex(api) {
      log.calls.push({
        entries: api.entries.map((e) => e.id + ":" + e.links.map((l) => l.to + "/" + l.tone).join(",")),
        types: api.data.categories.map((c) => c.type),
        entry: api.entry ?? null,
        playing: api.playing,
        fresh: api.entries.filter((e) => e.fresh).map((e) => e.id),
        title: api.text("記録", "Records"),
      });
      api.onClose(() => log.closed++);
      const el = document.createElement("div");
      el.className = "t-codex";
      const b = document.createElement("button");
      b.className = "t-close";
      b.textContent = "close";
      b.onclick = () => {
        api.markSeen(["haru", "haru#0"]);
        api.close();
      };
      el.append(b);
      return el;
    },
  },
});
`;

const FIXTURES = resolve(import.meta.dirname, "fixtures");
const SHOTS = process.env.LIMINALIA_E2E_SHOTS ?? "/tmp";
const files = { "assets/image/face.png": join(FIXTURES, "layer-top.png"), "assets/image/town.png": join(FIXTURES, "stripes.png") };
const before = (dir: string) => {
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "data", "codex.json"), JSON.stringify(CODEX));
};

describe.skipIf(!e2e)("図鑑の年表・相関図・地図と差し替え（ブラウザ）", { timeout: 240_000 }, () => {
  let standard: TestProject;
  let custom: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    standard = await startProject({ scenario: { a: SCENARIO, b: OPEN_ANY }, config: { entry: "a" }, files, before });
    custom = await startProject({ scenario: { a: SCENARIO }, config: { entry: "a" }, files, before, plugin: PLUGIN });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await standard?.close();
    await custom?.close();
  });

  const open = async (browser: Browser, url: string, selector: string, start = "a"): Promise<Page> => {
    const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await p.goto(`${url}?autostart=1&start=${start}`);
    for (let i = 0; i < 20 && (await p.locator(selector).count()) === 0; i++) {
      await p.mouse.click(640, 650);
      await p.waitForTimeout(300);
    }
    await p.waitForSelector(selector, { timeout: 20_000 });
    return p;
  };

  it("相関図は線と位置、年表は日付の順、地図は絵の上に並べる", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, standard.url, ".lm-codex");
      // @codex haru: 相関図の区分でハルを開いている
      expect(await p.locator(".lm-codex-body").getAttribute("data-type"), name).toBe("relations");
      expect(await p.locator(".lm-codex-node").count(), name).toBe(2);
      expect(await p.locator('.lm-codex-line[data-link="haru>yuika"]').count(), name).toBe(1);
      expect(await p.locator(".lm-codex-line-label").textContent(), name).toBe("友人");
      expect(await p.locator(".lm-codex-node-image").count(), name).toBe(1);
      // 位置は図の割合（ハルは左から 25%）
      const board = (await p.locator(".lm-codex-board").boundingBox())!;
      const haru = (await p.locator('.lm-codex-node[data-entry="haru"]').boundingBox())!;
      expect(Math.abs(haru.x + haru.width / 2 - (board.x + board.width * 0.25)), name).toBeLessThan(3);
      // 関連に相関図の相手が並ぶ
      expect(await p.locator(".lm-codex-related .lm-codex-link").textContent(), name).toBe("ユイカ（友人）");
      await p.screenshot({ path: join(SHOTS, `codex-relations-${name}.png`) }).catch(() => undefined);
      // 年表: order の順に日付と題
      await p.locator('.lm-tab[data-category="years"]').click();
      expect(await p.locator(".lm-codex-body").getAttribute("data-type"), name).toBe("timeline");
      expect(await p.locator(".lm-codex-event-date").allTextContents(), name).toEqual(["1923年", "1925年"]);
      await p.screenshot({ path: join(SHOTS, `codex-timeline-${name}.png`) }).catch(() => undefined);
      // 地図: 絵の上に印
      await p.locator('.lm-tab[data-category="town"]').click();
      expect(await p.locator(".lm-codex-board-image").count(), name).toBe(1);
      expect(await p.locator(".lm-codex-marker").count(), name).toBe(1);
      // 地図の位置は絵の割合（駅は左から 40%、上から 30%）
      await p.waitForFunction(() => (document.querySelector(".lm-codex-board-image") as HTMLImageElement | null)?.complete === true);
      await p.waitForTimeout(100);
      const image = (await p.locator(".lm-codex-board-image").boundingBox())!;
      const marker = (await p.locator('.lm-codex-marker[data-entry="station"]').boundingBox())!;
      expect(Math.abs(marker.x + marker.width / 2 - (image.x + image.width * 0.4)), name).toBeLessThan(3);
      expect(Math.abs(marker.y + marker.height / 2 - (image.y + image.height * 0.3)), name).toBeLessThan(3);
      await p.locator('.lm-codex-marker[data-entry="station"]').click();
      expect(await p.locator(".lm-codex-title").textContent(), name).toBe("駅");
      await p.screenshot({ path: join(SHOTS, `codex-map-${name}.png`) }).catch(() => undefined);
      await p.close();
    }
  });

  it("項目を決めずに開くと、新しい印の付いた項目（無ければ一つ目）を右の欄に出し、区分を替えてもその区分の項目を出す。出しておいただけの項目は読んだことにしない", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, standard.url, ".lm-codex", "b");
      const shown = () => p.evaluate(() => document.querySelector(".lm-codex-detail .lm-codex-title")?.textContent ?? null);
      const fresh = (id: string) => p.locator(`[data-entry="${id}"] .lm-codex-fresh`).count();
      const seen = () => p.evaluate("Object.keys(window.__liminalia.runtime().state.game['@codex']?.seen ?? {}).sort()");
      // 相関図の区分。ハルもユイカも新しいので、並びの先のハル。出しておいただけなので「新」は残し、読んだ記録にも入れない
      expect(await shown(), name).toBe("ハル");
      expect(await p.locator('.lm-codex-node[data-entry="haru"]').getAttribute("aria-pressed"), name).toBe("true");
      expect(await fresh("haru"), name).toBe(1);
      expect(await seen(), name).toEqual([]);
      // 年表は日付の順の先（出会い）。区分を替えて出しておいただけの項目も同じ
      await p.locator('.lm-tab[data-category="years"]').click();
      expect(await shown(), name).toBe("出会い");
      expect(await fresh("early"), name).toBe(1);
      // 相関図へ戻ると、まだ読んでいないハルをまた出す
      await p.locator('.lm-tab[data-category="people"]').click();
      expect(await shown(), name).toBe("ハル");
      // 押して選んだ項目は読んだことにする（「新」を外し、記録に入れる）。戻ると次の読んでいないユイカ
      await p.locator('.lm-codex-node[data-entry="haru"]').click();
      expect(await fresh("haru"), name).toBe(0);
      expect(await seen(), name).toEqual(["haru", "haru#0"]);
      await p.locator('.lm-tab[data-category="years"]').click();
      await p.locator('.lm-tab[data-category="people"]').click();
      expect(await shown(), name).toBe("ユイカ");
      await p.locator('.lm-codex-node[data-entry="yuika"]').click();
      // どれも読んだ区分は一つ目
      await p.locator('.lm-tab[data-category="years"]').click();
      await p.locator('.lm-tab[data-category="people"]').click();
      expect(await shown(), name).toBe("ハル");
      await p.close();
    }
  });

  it("@codex で名前を決めて開いた項目は、読んだことにする", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, standard.url, ".lm-codex");
      expect(await p.locator(".lm-codex-detail .lm-codex-title").textContent(), name).toBe("ハル");
      expect(await p.locator('[data-entry="haru"] .lm-codex-fresh').count(), name).toBe(0);
      expect(await p.evaluate("window.__liminalia.runtime().state.game['@codex'].seen"), name).toMatchObject({ haru: true });
      await p.close();
    }
  });

  it("作品の screens.codex が画面を作る。中身（開いた項目・線・新しい印）は api に入る", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, custom.url, ".t-codex");
      const call = (await p.evaluate("window.__codex.calls[0]")) as Record<string, unknown>;
      expect(call, name).toEqual({
        entries: ["haru:yuika/positive", "yuika:", "late:", "early:", "station:"],
        types: ["relations", "timeline", "map"],
        entry: "haru",
        playing: true,
        fresh: ["haru", "yuika", "late", "early", "station"],
        title: "記録",
      });
      await p.locator(".t-close").click();
      expect(await p.evaluate("window.__codex.closed"), name).toBe(1);
      // 読んだ印はこのプレイの記録に入る
      expect(await p.evaluate("window.__liminalia.runtime().state.game['@codex'].seen"), name).toEqual({ haru: true, "haru#0": true });
      await p.close();
    }
  });
});
