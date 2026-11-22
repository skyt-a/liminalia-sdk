import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 場面転換（@scene-change）を実際のブラウザで確かめる。暗転したところで立ち絵が消えて背景が替わり、明転のときには前の本文を見せず、
 * 終わると覆いが外れている。スキップ中は時間をかけない。おまけの CG の画像なら解放する。
 * @mask と @mask-off を並べたときも、明転のあいだは前の本文を見せない（hide-window=false なら見せたまま）。
 * @bg は替えているあいだもウィンドウを出したまま（一枚絵の差分を替えても窓が消えない。hide-window=true なら隠す）。
 */

const scenario = `@bg hill_dusk.webp
@window show
@chara アカリ
はじまり。
@scene-change hill_night.webp time=400ms hold=200ms
夜になった。
@chara アカリ
@scene-change fade-out=0ms fade-in=0ms
立ち絵だけ消えた。
`;

const masked = `@bg hill_dusk.webp
@window show
答えは、出なかった。
@mask time=200ms
@chara-hide-all
@mask-off time=1s
二人とも、しばらく言葉が出なかった。
@mask time=200ms hide-window=false
@mask-off time=1s
窓を残した。
`;

const backgrounds = `@bg hill_dusk.webp
@window show
夕方の丘。
@bg hill_night.webp time=1s
夜の丘。
@bg hill_dusk.webp time=1s hide-window=true
また夕方。
`;

const reshown = `@bg hill_dusk.webp
@window show
前の本文。
@scene-change time=200ms
@window show
@wait 1s
次の本文。
@nvl on
一行目。
@mask time=200ms
@mask-off time=200ms
二行目。
`;

const explicitHide = `@bg hill_dusk.webp
@window show
前の本文。
@scene-change time=400ms hold=300ms hide-window=true hide-window-at=covered
@wait 1200ms
次の本文。
`;
const explicitKeep = explicitHide.replace("hide-window=true", "hide-window=false");
const hideWindowAtStart = explicitHide.replace("time=400ms", "time=1500ms").replace("hide-window-at=covered", "hide-window-at=start");
const hideWindowDefault = hideWindowAtStart.replace(" hide-window-at=start", "");
const hideWindowCovered = hideWindowAtStart.replace("hide-window-at=start", "hide-window-at=covered");
const keepWindowAtStart = hideWindowAtStart.replace("hide-window=true", "hide-window=false");

const concurrentExit = `@bg hill_dusk.webp
@window show
@chara アカリ at=left
@chara ソウ at=right
前の本文。
@scene-change time=1500ms hold=300ms hide-chara-at=start hide-fade=900ms
次の本文。
`;
const singleExit = concurrentExit.replace("hide-chara-at=start", "hide-who=アカリ hide-chara-at=start");
const legacyExit = concurrentExit.replace("hide-chara-at=start", "hide-at=start");
const keepSprites = concurrentExit.replace("hide-chara-at=start hide-fade=900ms", "hide-chara=false hide-chara-at=start hide-fade=900ms");
const skippableHold = `@window show
前の本文。
@scene-change time=0ms hold=20s
次の本文。
`;

const controlsPlugin = `import { defineWebPlugin } from "@liminalia/web";
export default defineWebPlugin({ name: "t",
  screens: { menuBar: () => { const bar = document.createElement("div"); bar.id = "test-menu-bar"; bar.textContent = "操作"; return bar; } },
  ready: ({ system }) => {
    const button = document.createElement("button"); button.id = "test-records"; button.textContent = "境界記録"; document.body.append(button);
    const update = (s) => { button.hidden = !s.menuBar; };
    system.onStatusChange(update); update(system.status);
  },
});`;

/** 前のファイルの終わりで暗転してから飛び、移った先の頭で @scene-change を書く。もう覆っているので、暗転の時間（fade-out）を待たない。 */
const covered = `@bg hill_dusk.webp
@window show
前の場面の終わり。
@mask time=0ms
@jump e2
`;
const coveredNext = `@chara アカリ
@scene-change hill_night.webp fade-out=60s hold=0ms fade-in=0ms
新しい場面。
`;

const look = (p: Page) =>
  p.evaluate(`(() => ({
    sprites: document.querySelectorAll(".sprite").length,
    bg: document.querySelector(".background img:last-child")?.dataset.bg ?? null,
    mask: getComputedStyle(document.querySelector(".layer.mask")).opacity,
    windowHidden: document.querySelector(".message").classList.contains("bg-hidden"),
  }))()`) as Promise<{ sprites: number; bg: string | null; mask: string; windowHidden: boolean }>;

describe.skipIf(!e2e)("場面転換（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let controls: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({ scenario: { a: scenario, b: masked, c: backgrounds, d: reshown, e: covered, e2: coveredNext, explicitHide, concurrentExit, singleExit, legacyExit, keepSprites, skippableHold }, config: { entry: "a", ui: { message: { keepText: true } }, extra: { cg: [{ id: "night", images: ["hill_night.webp"] }] } } });
    controls = await startProject({ scenario: { explicitHide, explicitKeep, hideWindowAtStart, hideWindowDefault, hideWindowCovered, keepWindowAtStart }, plugin: controlsPlugin, config: { entry: "explicitHide" } });
  });

  it("hide-window=true は暗転完了時に枠を隠し、明転後も次の本文まで隠す", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${controls.url}?autostart=1&start=explicitHide`);
      await p.waitForFunction('window.__liminalia?.host.waiting === true && document.querySelector(".message .text")?.textContent.includes("前の本文")');
      await expect.poll(() => p.locator("#test-menu-bar").isVisible()).toBe(true);
      await expect.poll(() => p.locator("#test-records").isVisible()).toBe(true);
      await p.evaluate("window.__liminalia.host.advance()");
      await p.waitForFunction('document.querySelector(".message")?.classList.contains("bg-hidden")');
      await p.waitForFunction('Number(getComputedStyle(document.querySelector(".layer.mask")).opacity) === 0');
      const hidden = await p.evaluate(() => {
        const message = document.querySelector<HTMLElement>(".message")!;
        return { hidden: message.classList.contains("bg-hidden"), opacity: Number(getComputedStyle(message).opacity) };
      });
      expect(hidden, name).toEqual({ hidden: true, opacity: 0 });
      expect(await p.locator("#test-menu-bar").isVisible(), name).toBe(false);
      expect(await p.locator("#test-records").isVisible(), name).toBe(false);
      await p.waitForFunction('document.querySelector(".message .text")?.textContent.includes("次の本文")');
      expect((await look(p)).windowHidden, name).toBe(false);
      await expect.poll(() => p.locator("#test-menu-bar").isVisible()).toBe(true);
      await expect.poll(() => p.locator("#test-records").isVisible()).toBe(true);
      await p.close();
    }
  });

  it("暗転と同時に全員または指定した一人をフェード退場させる", async () => {
    for (const { name, browser } of list) for (const [scenarioName, remaining] of [["concurrentExit", 0], ["singleExit", 1], ["legacyExit", 0]] as const) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=${scenarioName}`);
      await p.waitForFunction('window.__liminalia?.host.waiting === true && document.querySelector(".message .text")?.textContent.includes("前の本文")');
      await p.evaluate("window.__liminalia.host.advance()");
      await p.waitForFunction('Number(getComputedStyle(document.querySelector(".layer.mask")).opacity) > 0.1');
      const early = await p.evaluate(() => {
        const sprite = document.querySelector<HTMLElement>('.sprite[data-who="アカリ"]')!;
        return Number(getComputedStyle(sprite).opacity);
      });
      expect(early, `${name} ${scenarioName}`).toBeLessThan(1);
      expect(early, `${name} ${scenarioName}`).toBeGreaterThan(0);
      await p.waitForFunction(`document.querySelectorAll(".sprite[data-who]").length === ${remaining}`);
      if (remaining) expect(await p.locator('.sprite[data-who="ソウ"]').count(), name).toBe(1);
      await p.close();
    }
  });

  it("hide-chara=false ならほかの退場指定があっても全員を残す", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=keepSprites`);
      await p.waitForFunction('window.__liminalia?.host.waiting === true && document.querySelector(".message .text")?.textContent.includes("前の本文")');
      await p.evaluate("window.__liminalia.host.advance()");
      await p.waitForFunction('document.querySelector(".message .text")?.textContent.includes("次の本文")');
      expect(await p.locator('.sprite[data-who="アカリ"]').count(), name).toBe(1);
      expect(await p.locator('.sprite[data-who="ソウ"]').count(), name).toBe(1);
      await p.close();
    }
  });

  it("hide-window-at=start は暗転の途中から枠と操作ボタンを隠す", async () => {
    for (const { name, browser } of list) for (const [script, shouldHide] of [["hideWindowAtStart", true], ["hideWindowDefault", true], ["hideWindowCovered", false], ["keepWindowAtStart", false]] as const) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${controls.url}?autostart=1&start=${script}`);
      await p.waitForFunction('window.__liminalia?.host.waiting === true && document.querySelector(".message .text")?.textContent.includes("前の本文")');
      await p.evaluate("window.__liminalia.host.advance()");
      await p.waitForFunction('Number(getComputedStyle(document.querySelector(".layer.mask")).opacity) > 0.1');
      expect((await look(p)).windowHidden, `${name} ${script}`).toBe(shouldHide);
      expect(await p.locator("#test-menu-bar").isVisible(), `${name} ${script}`).toBe(!shouldHide);
      expect(await p.locator("#test-records").isVisible(), `${name} ${script}`).toBe(!shouldHide);
      await p.close();
    }
  });

  it("hide-window=false なら操作帯と境界記録を隠さない", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${controls.url}?autostart=1&start=explicitKeep`);
      await p.waitForFunction('window.__liminalia?.host.waiting === true && document.querySelector(".message .text")?.textContent.includes("前の本文")');
      await p.evaluate("window.__liminalia.host.advance()");
      await p.waitForTimeout(850);
      expect((await look(p)).windowHidden, name).toBe(false);
      expect(await p.locator("#test-menu-bar").isVisible(), name).toBe(true);
      expect(await p.locator("#test-records").isVisible(), name).toBe(true);
      await p.close();
    }
  });

  it("暗転中の hold は @wait と同じくクリックで早送りできる", async () => {
    for (const { browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=skippableHold`);
      await p.waitForFunction('window.__liminalia?.host.waiting === true && document.querySelector(".message .text")?.textContent.includes("前の本文")');
      await p.evaluate("window.__liminalia.host.advance()");
      await p.waitForFunction('document.querySelector(".message")?.classList.contains("bg-hidden")');
      expect(await p.evaluate("window.__liminalia.host.fastForward()")).toBe(true);
      await p.waitForFunction('document.querySelector(".message .text")?.textContent.includes("次の本文")', null, { timeout: 3000 });
      await p.close();
    }
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
    await controls?.close();
  });

  it("暗転のあいだに立ち絵を消して背景を替え、明転のあいだはウィンドウを隠し、次の本文で出す", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      const text = (t: string) => p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes(${JSON.stringify(t)})`);
      await text("はじまり");
      await p.waitForTimeout(200);
      expect(await look(p), name).toMatchObject({ sprites: 1, bg: "hill_dusk.webp", mask: "0" });
      await p.mouse.click(640, 80);
      // 暗転し終えて、暗転したまま置いている間（400ms + 200ms のうち）
      await p.waitForTimeout(500);
      expect(await look(p), name).toMatchObject({ sprites: 0, bg: "hill_night.webp", mask: "1", windowHidden: true });
      await text("夜になった");
      await p.waitForTimeout(100);
      expect(await look(p), name).toMatchObject({ sprites: 0, bg: "hill_night.webp", mask: "0", windowHidden: false });
      expect(await p.evaluate(`window.__liminalia.system.systemVariables.cg_unlocked?.["hill_night.webp"]`), name).toBe(true);
      // 本文を出し終えてから送る
      await p.waitForTimeout(400);
      await p.mouse.click(640, 80);
      await text("立ち絵だけ消えた");
      await p.waitForTimeout(100);
      expect(await look(p), name).toMatchObject({ sprites: 0, bg: "hill_night.webp", mask: "0" });
      await p.close();
    }
  });

  it("もう暗転している所の @scene-change は、暗転の時間（fade-out）を待たずに背景を替えて明転する", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=e`);
      await p.waitForFunction(`window.__liminalia?.host.waiting === true && document.querySelector(".message .text")?.textContent.includes("前の場面の終わり")`, null, { timeout: 60_000 });
      await p.evaluate("window.__liminalia.host.advance()");
      // fade-out は 60 秒。待っていれば、ここで時間切れになる
      await p.waitForFunction(`window.__liminalia.host.waiting === true && document.querySelector(".message .text")?.textContent.includes("新しい場面")`, null, { timeout: 30_000 });
      expect(await look(p), name).toMatchObject({ sprites: 0, bg: "hill_night.webp", mask: "0", windowHidden: false });
      await p.close();
    }
  });

  it("@mask で覆い終えたらウィンドウを隠し、明転のあいだは前の本文を見せない。hide-window=false なら見せたまま", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=b`);
      const text = (t: string) => p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes(${JSON.stringify(t)})`);
      const shown = () => p.evaluate(`document.querySelector(".message .text")?.textContent ?? ""`) as Promise<string>;
      await text("答えは");
      await p.waitForTimeout(400);
      await p.mouse.click(640, 80);
      // 覆い終えて（200ms）、明転している途中（1s のうち）
      const fadingIn = async () => {
        const opacity = Number((await look(p)).mask);
        expect(opacity > 0 && opacity < 1, `${name} mask=${opacity}`).toBe(true);
      };
      await p.waitForTimeout(600);
      await fadingIn();
      expect(await look(p), name).toMatchObject({ windowHidden: true });
      await text("二人とも");
      await p.waitForTimeout(100);
      expect(await look(p), name).toMatchObject({ mask: "0", windowHidden: false });
      // 本文を出し終えてから送る
      await p.waitForTimeout(1200);
      await p.mouse.click(640, 80);
      await p.waitForTimeout(600);
      await fadingIn();
      expect(await look(p), name).toMatchObject({ windowHidden: false });
      expect(await shown(), name).toContain("二人とも");
      await text("窓を残した");
      await p.close();
    }
  });

  it("@bg は替えているあいだもウィンドウを出したまま。hide-window=true なら隠し、次の本文で出す", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=c`);
      const text = (t: string) => p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes(${JSON.stringify(t)})`);
      const shown = () =>
        p.evaluate(`({ opacity: getComputedStyle(document.querySelector(".message")).opacity, text: document.querySelector(".message .text")?.textContent ?? "" })`) as Promise<{ opacity: string; text: string }>;
      await text("夕方の丘");
      await p.waitForTimeout(400);
      await p.mouse.click(640, 80);
      // 替えている途中（1s のうち）
      await p.waitForTimeout(500);
      expect(await look(p), name).toMatchObject({ bg: "hill_night.webp", windowHidden: false });
      expect(await shown(), name).toMatchObject({ opacity: "1", text: expect.stringContaining("夕方の丘") });
      await text("夜の丘");
      await p.waitForTimeout(400);
      await p.mouse.click(640, 80);
      await p.waitForTimeout(500);
      expect(await look(p), name).toMatchObject({ bg: "hill_dusk.webp", windowHidden: true });
      await text("また夕方");
      await p.waitForTimeout(300);
      expect(await look(p), name).toMatchObject({ windowHidden: false });
      expect((await shown()).opacity, name).toBe("1");
      await p.close();
    }
  });

  it("隠した枠を @window show や NVL の次の本文で出し直しても、前の本文は出ない", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=d`);
      const text = (t: string) => p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes(${JSON.stringify(t)})`);
      const body = () => p.evaluate(`document.querySelector(".message .text")?.textContent ?? ""`) as Promise<string>;
      await text("前の本文");
      await p.waitForTimeout(400);
      await p.mouse.click(640, 80);
      // 場面転換（200ms + 200ms）のあと @window show で枠を出し、1s 待っている間
      await p.waitForTimeout(800);
      expect(await look(p), name).toMatchObject({ mask: "0", windowHidden: false });
      expect(await body(), name).not.toContain("前の本文");
      await text("次の本文");
      await p.waitForTimeout(400);
      await p.mouse.click(640, 80);
      await text("一行目");
      await p.waitForTimeout(400);
      await p.mouse.click(640, 80);
      await text("二行目");
      expect(await body(), name).not.toContain("一行目");
      await p.close();
    }
  });
});
