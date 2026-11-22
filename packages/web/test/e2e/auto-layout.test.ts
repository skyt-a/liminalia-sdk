import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

const scenario = `@window show
@chara アカリ normal time=0ms
@emote アカリ sweat
ひとり。
@chara ソウ normal time=250ms auto-fade=400ms
ふたり。
@chara アカリ smile time=200ms
表情。
@chara-hide ソウ time=300ms
またひとり。
`;
const batch = `@window show
@chara アカリ normal time=0ms
@chara ソウ normal time=250ms auto-fade=300ms
@chara レン normal time=250ms auto-fade=300ms wait=true
三人。
`;
const explicit = `@window show
@chara アカリ normal time=0ms
ひとり。
@chara ソウ normal at=right time=250ms auto-fade=300ms wait=true
ふたり。
`;
const cancelled = `@window show
@chara アカリ normal time=0ms
ひとり。
@chara ソウ normal time=250ms auto-fade=300ms
@chara-hide-all time=0ms
全員退場。
`;
const replacement = `@window show
@chara アカリ normal time=0ms
@chara ソウ normal time=0ms auto-fade=0ms wait=true
入れ替え前。
@chara レン normal replace=left time=200ms wait=true
入れ替え後。
`;
const faceDuringReflow = `@window show
@chara アカリ normal time=0ms
@chara ソウ normal time=250ms auto-fade=300ms
@wait 420ms
@chara アカリ smile time=200ms
表情替え。
`;
const together = `@window show
はじめ。
@chara アカリ normal time=400ms
@chara ソウ normal time=400ms
ふたり。
`;
const cancelReplacement = `@window show
@chara アカリ normal time=0ms
はじめ。
@chara レン replace=アカリ time=300ms
@chara-hide-all time=0ms
退場。
`;

/** 並べ直しの出し直しの途中で表情を替え（並べ直しを待ってから替える）、終わる前にロードする。ロードしたあとは表情をゆっくり替える。 */
const faceThenLoad = `@window show
@chara アカリ normal time=0ms
はじめ。
@if system.d1
@chara アカリ surprised time=4000ms
三。
@end
@set system.d1 = true
@chara ソウ normal time=3000ms auto-fade=300ms
@wait 700ms
@chara アカリ smile time=0ms
二人。
`;

// 退場しても動かさない並べ方（exit: keep）でも、登場と入れ替えと全消しは前と同じに動く（退場で並べ直す場合だけ違う）
describe.skipIf(!e2e).each([["", undefined], ["（exit: keep）", { exit: "keep" }]] as const)("登場順の自動配置%s", { timeout: 180_000 }, (label, autoLayout) => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({ scenario: { a: scenario, batch, explicit, cancelled, replacement, cancelReplacement, faceDuringReflow, together, faceThenLoad }, config: { entry: "a", commandDefaults: { chara: { "auto-layout": true } }, variables: { "system.d1": false }, ...(autoLayout ? { autoLayout } : {}) }, before: async (dir) => {
      const path = join(dir, "cast.json");
      const cast = JSON.parse(readFileSync(path, "utf8"));
      cast.cast.レン = structuredClone(cast.cast.ソウ);
      writeFileSync(path, JSON.stringify(cast));
    } });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });
  it("入れ替えの間、他の人物は表示されたまま同じ位置に残る", async () => {
    for (const { browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=replacement`);
      await p.waitForFunction(() => (window as any).__liminalia?.host.waiting && document.querySelector(".message .text")?.textContent?.includes("入れ替え前"));
      await p.locator('.sprite[data-who="ソウ"]').evaluate((el: HTMLElement) => { el.dataset.untouched = "yes"; });
      await p.evaluate("window.__liminalia.host.advance()");
      await p.waitForTimeout(100);
      expect(await p.locator('.sprite[data-who="ソウ"]').evaluate((el: HTMLElement) => [parseFloat(el.style.left), getComputedStyle(el).opacity])).toEqual([733, "1"]);
      await p.waitForFunction(() => (window as any).__liminalia?.host.waiting && document.querySelector(".message .text")?.textContent?.includes("入れ替え後"));
      expect(await p.locator('.sprite[data-who="アカリ"]').count()).toBe(0);
      // レンの画像はアカリと別の frame を持つため、同じ left でも座標はキャストごとの値になる。
      expect(await p.locator('.sprite[data-who="レン"]').evaluate((el: HTMLElement) => parseFloat(el.style.left))).toBe(40);
      expect(await p.locator('.sprite[data-who="ソウ"]').evaluate((el: HTMLElement) => [parseFloat(el.style.left), el.dataset.untouched, getComputedStyle(el).opacity])).toEqual([733, "yes", "1"]);
      await p.close();
    }
  });
  it("並べ直しの出し直し中の表情替えで、全員をもう一度消さない", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      // ソウが出そろってから、また薄くなったか（前は表情替えで並べ直しが繰り返され、全員が 0 まで消えて出直した）
      await p.addInitScript(() => {
        const w = window as any;
        w.__dip = { shown: false, min: 1 };
        const f = () => {
          const el = document.querySelector<HTMLElement>('.sprite[data-who="ソウ"]');
          const o = el ? Number(getComputedStyle(el).opacity) : 0;
          if (o > 0.99) w.__dip.shown = true;
          else if (w.__dip.shown) w.__dip.min = Math.min(w.__dip.min, o);
          requestAnimationFrame(f);
        };
        requestAnimationFrame(f);
      });
      await p.goto(`${project.url}?autostart=1&start=faceDuringReflow`);
      await p.waitForFunction(() => (window as any).__liminalia?.host.waiting && document.querySelector(".message .text")?.textContent?.includes("表情替え"));
      await p.waitForFunction(() => {
        const img = document.querySelector<HTMLImageElement>('.sprite[data-who="アカリ"] > img');
        return !!img && img.src.includes("smile") && !document.querySelector('[data-snapshot="アカリ"]');
      });
      await p.waitForTimeout(300);
      expect(await p.evaluate(() => (window as any).__dip), name).toEqual({ shown: true, min: 1 });
      await p.close();
    }
  });
  it("並べ直しを待っていた表情替えは、その前にロードしたら、ロードしたあとの立ち絵に効かせない", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      const at = (text: string) => p.waitForFunction((t) => (window as any).__liminalia?.host.waiting && document.querySelector(".message .text")?.textContent?.includes(t), text, { timeout: 30_000 });
      await p.goto(`${project.url}?autostart=1&start=faceThenLoad`);
      await at("はじめ");
      expect(await p.evaluate("window.__liminalia.system.saveTo(1)"), name).toBe(true);
      await p.evaluate("window.__liminalia.host.advance()");
      // 出し直しの途中の表情替えは、並べ直しが終わるまで待っている
      await at("二人");
      expect(await p.locator('.sprite[data-who="アカリ"] > img').last().evaluate((img: HTMLImageElement) => img.src.includes("smile")), name).toBe(false);
      await p.evaluate("window.__liminalia.system.loadFrom(1)");
      await at("はじめ");
      await p.evaluate("window.__liminalia.host.advance()");
      // ロードしたあとの、ゆっくりした表情替え（4 秒）が、前のプレイの待っていた表情替えで途中で終わらない
      await at("三");
      await p.waitForTimeout(2500);
      expect(await p.locator('.sprite[data-who="アカリ"]').evaluate((el: HTMLElement) => el.getAnimations({ subtree: true }).length > 0 || !!document.querySelector('[data-snapshot="アカリ"]')), name).toBe(true);
      await p.waitForTimeout(2500);
      expect(await p.locator('.sprite[data-who="アカリ"] > img').last().evaluate((img: HTMLImageElement) => img.src.includes("surprised")), name).toBe(true);
      await p.close();
    }
  });

  it("誰もいない舞台に続けて出す二人は、最初から並んだ位置で一緒に出る", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      // 前は先の人物が自分だけの並び（中央）で出始め、後の人物が出るときに左へ跳び、後の人物だけ遅れて出た
      await p.addInitScript(() => {
        const w = window as any;
        w.__frames = [];
        const f = () => {
          const els = [...document.querySelectorAll<HTMLElement>(".sprite[data-who]")];
          if (els.length > 0) w.__frames.push(Object.fromEntries(els.map((el) => [el.dataset.who, [parseFloat(el.style.left), Number(getComputedStyle(el).opacity)]])));
          requestAnimationFrame(f);
        };
        requestAnimationFrame(f);
      });
      await p.goto(`${project.url}?autostart=1&start=together`);
      await p.waitForFunction(() => (window as any).__liminalia?.host.waiting && document.querySelector(".message .text")?.textContent?.includes("はじめ"));
      await p.evaluate("window.__liminalia.host.advance()");
      await p.waitForTimeout(1200);
      const frames: Record<string, [number, number]>[] = await p.evaluate(() => (window as any).__frames);
      expect(frames.at(-1), name).toEqual({ アカリ: [60, 1], ソウ: [733, 1] });
      for (const frame of frames) {
        if (frame.アカリ) expect(frame.アカリ[0], name).toBe(60);
        if (frame.ソウ) expect(frame.ソウ[0], name).toBe(733);
        const a = frame.アカリ?.[1] ?? 0;
        const s = frame.ソウ?.[1] ?? 0;
        expect(Math.abs(a - s), name).toBeLessThan(0.15);
      }
      await p.close();
    }
  });
  it("待たない入れ替えの直後に全員を消しても、後から復活しない", async () => {
    for (const { browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=cancelReplacement`);
      await p.waitForFunction(() => (window as any).__liminalia?.host.waiting && document.querySelector(".message .text")?.textContent?.includes("はじめ"));
      await p.evaluate("window.__liminalia.host.advance()");
      await p.waitForFunction(() => (window as any).__liminalia?.host.waiting && document.querySelector(".message .text")?.textContent?.includes("退場"));
      await p.waitForTimeout(800);
      expect(await p.locator(".sprite[data-who]").count()).toBe(0);
      await p.close();
    }
  });
  it.skipIf(label !== "")("人数が変われば全員を消して並べ直し、表情変更やセーブ／ロードで状態を保つ", async () => {
    for (const { name, browser } of list) {
      const p: Page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      const waitText = (text: string) => p.waitForFunction((s) => (window as any).__liminalia?.host.waiting === true && document.querySelector(".message .text")?.textContent?.includes(s), text);
      const next = () => p.evaluate("window.__liminalia.host.advance()");
      await waitText("ひとり");
      await p.waitForSelector('.sprite[data-who="アカリ"] .lim-emote');
      await p.evaluate(() => { document.querySelector<HTMLElement>('.sprite[data-who="アカリ"]')!.dataset.original = "yes"; });
      expect(await p.locator('.sprite[data-who="アカリ"]').evaluate((e: HTMLElement) => parseFloat(e.style.left)), name).toBe(407);
      await next();
      await p.waitForFunction(() => {
        const el = document.querySelector<HTMLElement>('.sprite[data-who="アカリ"]');
        return !!el && Number(getComputedStyle(el).opacity) < 0.8;
      });
      expect(await p.locator('.sprite[data-who="アカリ"]').evaluate((e: HTMLElement) => parseFloat(e.style.left)), name).toBe(407);
      await p.waitForFunction(() => {
        const a = document.querySelector<HTMLElement>('.sprite[data-who="アカリ"]');
        const b = document.querySelector<HTMLElement>('.sprite[data-who="ソウ"]');
        return !!a && !!b && parseFloat(a.style.left) === 60 && parseFloat(b.style.left) === 733 && Number(getComputedStyle(a).opacity) > 0.99 && Number(getComputedStyle(b).opacity) > 0.99;
      });
      expect(await p.locator('.sprite[data-who="アカリ"]').getAttribute("data-original"), name).toBe("yes");
      expect(await p.locator('.sprite[data-who="アカリ"] .lim-emote').count(), name).toBe(1);
      await waitText("ふたり");
      await next();
      await waitText("表情");
      await p.waitForTimeout(300);
      expect(await p.locator('.sprite[data-who="アカリ"]').evaluate((e: HTMLElement) => parseFloat(e.style.left)), name).toBe(60);
      expect(await p.locator('.sprite[data-who="アカリ"] .lim-emote').count(), name).toBe(1);
      await p.evaluate("window.__liminalia.system.loadSave(window.__liminalia.system.runtime.save())");
      await waitText("表情");
      expect(await p.locator('.sprite[data-who="アカリ"]').evaluate((e: HTMLElement) => parseFloat(e.style.left)), name).toBe(60);
      expect(await p.locator('.sprite[data-who="ソウ"]').evaluate((e: HTMLElement) => parseFloat(e.style.left)), name).toBe(733);
      await next();
      await waitText("またひとり");
      await p.waitForFunction(() => {
        const a = document.querySelector<HTMLElement>('.sprite[data-who="アカリ"]');
        return !!a && parseFloat(a.style.left) === 407 && Number(getComputedStyle(a).opacity) > 0.99 && !document.querySelector('.sprite[data-who="ソウ"]');
      });
      await p.close();
    }
  });
  it("連続する登場をまとめ、明示位置と全消しを優先する", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=batch`);
      await p.waitForFunction('window.__liminalia?.host.waiting === true && document.querySelector(".message .text")?.textContent.includes("三人")');
      const positions = await p.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLElement>(".sprite[data-who]")].map((el) => [el.dataset.who, parseFloat(el.style.left)])));
      expect(positions, name).toEqual({ アカリ: 60, ソウ: 387, レン: 733 });
      await p.goto(`${project.url}?autostart=1&start=explicit`);
      await p.waitForFunction('window.__liminalia?.host.waiting === true && document.querySelector(".message .text")?.textContent.includes("ひとり")');
      await p.evaluate("window.__liminalia.host.advance()");
      await p.waitForFunction('window.__liminalia?.host.waiting === true && document.querySelector(".message .text")?.textContent.includes("ふたり")');
      expect(await p.locator('.sprite[data-who="アカリ"]').evaluate((e: HTMLElement) => parseFloat(e.style.left)), name).toBe(60);
      expect(await p.locator('.sprite[data-who="ソウ"]').evaluate((e: HTMLElement) => parseFloat(e.style.left)), name).toBe(733);
      await p.goto(`${project.url}?autostart=1&start=cancelled`);
      await p.waitForFunction('window.__liminalia?.host.waiting === true && document.querySelector(".message .text")?.textContent.includes("ひとり")');
      await p.evaluate("window.__liminalia.host.advance()");
      await p.waitForFunction('document.querySelector(".message .text")?.textContent.includes("全員退場")');
      await p.waitForTimeout(1000);
      expect(await p.locator(".sprite[data-who]").count(), name).toBe(0);
      await p.close();
    }
  });
});

const keep = `@window show
@chara アカリ normal time=0ms
@chara ソウ normal time=0ms auto-fade=0ms
@chara レン normal time=0ms auto-fade=0ms wait=true
三人。
@chara-hide ソウ time=400ms
抜けた。
@chara ソウ normal time=400ms
戻った。
`;

describe.skipIf(!e2e)("自動配置の規則（退場しても動かさない）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({ scenario: { keep }, config: { entry: "keep", commandDefaults: { chara: { "auto-layout": true } }, autoLayout: { exit: "keep", positions: { "3": ["15%", "50%", "85%"] } } }, before: async (dir) => {
      const path = join(dir, "cast.json");
      const cast = JSON.parse(readFileSync(path, "utf8"));
      cast.cast.レン = structuredClone(cast.cast.ソウ);
      writeFileSync(path, JSON.stringify(cast));
    } });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });
  it("退場と、空いた枠への登場で、ほかの人物は消えず動かない", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=keep`);
      const waitText = (text: string) => p.waitForFunction((s) => (window as any).__liminalia?.host.waiting === true && document.querySelector(".message .text")?.textContent?.includes(s), text);
      const look = (): Promise<Record<string, [number, number]>> => p.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLElement>(".sprite[data-who]")].map((el) => [el.dataset.who, [parseFloat(el.style.left), Number(getComputedStyle(el).opacity)]])));
      await waitText("三人");
      const before = await look();
      const lefts = Object.fromEntries(Object.entries(before).map(([who, [left]]) => [who, left]));
      // 中心が画面の幅の 15%、50%、85%
      const centers = await p.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLElement>(".sprite[data-who]")].map((el) => [el.dataset.who, parseFloat(el.style.left) + parseFloat(el.style.width) / 2])));
      expect(centers, name).toEqual({ アカリ: 1280 * 0.15, ソウ: 1280 * 0.5, レン: 1280 * 0.85 });
      for (const step of ["抜けた", "戻った"]) {
        await p.evaluate("window.__liminalia.host.advance()");
        await p.waitForTimeout(200);
        const mid = await look();
        for (const who of ["アカリ", "レン"]) expect(mid[who], `${name} ${step} ${who}`).toEqual([lefts[who], 1]);
        await waitText(step);
      }
      await p.waitForTimeout(300);
      expect(await look(), name).toEqual(before);
      await p.close();
    }
  });
});

const live = `@window show
@chara アカリ normal time=0ms
@chara ソウ normal time=0ms auto-fade=0ms wait=true
ふたり。
`;

// 開発中に liminalia.json の autoLayout を書き換えると、読み直さずに表示中の立ち絵が新しい並べ方の位置に動き、次に出す人物にも効く
describe.skipIf(!e2e)("自動配置の規則の書き換え（開発中）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({ scenario: { live }, config: { entry: "live", commandDefaults: { chara: { "auto-layout": true } } } });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });
  it("書き換えた並べ方が、読み直さずに表示中の立ち絵と実行器に効く", async () => {
    const file = join(project.dir, "liminalia.json");
    const original = readFileSync(file, "utf8");
    for (const { name, browser } of list) {
      writeFileSync(file, original);
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=live`);
      await p.waitForFunction(() => (window as any).__liminalia?.host.waiting === true && document.querySelector(".message .text")?.textContent?.includes("ふたり"));
      await p.evaluate(() => ((window as any).__notReloaded = true));
      const centers = (): Promise<Record<string, number>> => p.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLElement>(".sprite[data-who]")].map((el) => [el.dataset.who, Math.round(parseFloat(el.style.left) + parseFloat(el.style.width) / 2)])));
      const before = await centers();
      expect(before.アカリ!, name).toBeLessThan(before.ソウ!);
      writeFileSync(file, JSON.stringify({ ...JSON.parse(original), autoLayout: { positions: { "2": ["30%", "70%"] } } }));
      await p.waitForFunction(() => {
        const el = document.querySelector<HTMLElement>('.sprite[data-who="アカリ"]');
        return !!el && Math.round(parseFloat(el.style.left) + parseFloat(el.style.width) / 2) === Math.round(1280 * 0.3);
      }, undefined, { timeout: 30_000 });
      expect(await centers(), name).toEqual({ アカリ: Math.round(1280 * 0.3), ソウ: Math.round(1280 * 0.7) });
      expect(await p.evaluate(() => (window as any).__notReloaded === true), name).toBe(true);
      expect(await p.evaluate(() => (window as any).__liminalia.runtime().autoLayout), name).toEqual({ positions: { "2": ["30%", "70%"] } });
      await p.close();
    }
    writeFileSync(file, original);
  });
});
