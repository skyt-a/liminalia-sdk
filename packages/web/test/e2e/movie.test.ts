import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * @movie の再生中はクイックメニューを出さない（menu=true なら出したまま）ことと、飛ばせる動画と飛ばせない動画を、実際のブラウザで確かめる。
 *
 * 待ち方は、壁の時計と重さに左右されないようにする（ブラウザのテストを並べて流すと、ここが 15 秒の待ちで切れていた）。
 * - 待つのは状態だけ（本文はクリック待ち（host.waiting）、動画は要素の数と流れ始めた数）で、待ちごとの打ち切りは置かず、テスト全体の打ち切り（describe の timeout）に任せる。
 *   切れていたのは、開いたばかりの開発サーバーがエンジンを組み立て終えて最初の本文を出すまでの間（重い組では 15 秒を超える）だった
 * - 動画は 2 秒しかないので、確かめる前に終わらないよう、出た動画をページの中で繰り返しにしておく（ひとりでには終わらない）。
 *   最後まで見せるときは繰り返しを外す（止めて流し直すことはしない。WebKit は止めた動画を流し直しても時刻が進まないことがある）
 * - 作品は二つだけ立て（プラグインの有る無し）、台本を分けて使う（開発サーバーを立てるたびに、はじめの組み立てで重くなるため）
 */

const MOVIE = resolve(import.meta.dirname, "fixtures/test-movie.webm");
const SUBTITLES = resolve(import.meta.dirname, "fixtures/test-movie.vtt");
const menu = (args: string) => `@window show
はじまり。
@movie m.webm${args}
終わり。
`;
const SCENARIOS = {
  plain: menu(""),
  menu: menu(" menu=true"),
  subtitles: "@window show\nはじまり。\n@movie m.webm subtitles=m.vtt\n終わり。\n",
  seen: "@window show\nはじまり。\n@movie m.webm\n一回目。\n@movie m.webm\n二回目。\n@movie m.webm skip-seen=false\n三回目。\n",
  skippable: "@window show\nはじまり。\n@movie m.webm skip=true\n一回目。\n@movie m.webm skip=true\n二回目。\n@movie m.webm skip=true\n三回目。\n",
  unskippable: "@window show\nはじまり。\n@movie m.webm skip-seen=false\n一回目。\n@movie m.webm skip-seen=false\n二回目。\n",
};

/** プラグインが差し替えたクイックメニュー（status.menuBar で出し分けるのはシステムが受け持つ）。 */
const PLUGIN = `
import { defineWebPlugin } from "@liminalia/web";
export default defineWebPlugin({
  name: "t",
  screens: {
    menuBar() {
      const el = document.createElement("div");
      el.className = "t-bar";
      el.textContent = "BAR";
      return el;
    },
  },
});
`;

/** 待ちごとには打ち切らない（テスト全体の打ち切りに任せる）。 */
const UNTIL_DONE = { timeout: 0 };

const barShown = (p: Page, selector: string) => p.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return !!el && !el.hidden; })()`) as Promise<boolean>;

/** 本文を出し終えてクリック待ちになるまで待つ（text を渡せば、その文のページで）。開いたばかりなら、エンジンを組み立てて最初の本文を出すまでも。 */
const clickWait = (p: Page, text?: string) =>
  p.waitForFunction(`window.__liminalia?.host.waiting === true && !document.querySelector("video.lim-movie")${text ? ` && document.querySelector(".message .text")?.textContent.includes(${JSON.stringify(text)})` : ""}`, null, UNTIL_DONE);

/** n 本目の動画が流れ始める（再生中で時刻が進んだ）まで待つ。動画は繰り返しにしてあるので、待っている間に終わることはない。 */
const flowing = (p: Page, n: number) => p.waitForFunction(`window.__moviesFlowing >= ${n}`, null, UNTIL_DONE);

/** 流している動画の繰り返しを外す（今の一周の終わりで、最後まで見たことになって終わる）。 */
const release = (p: Page) => p.evaluate(`document.querySelector("video.lim-movie").loop = false`);

/** 描画を二コマ進める（押したことへの反応を待つ。時間では待たない）。 */
const frames = (p: Page) => p.evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");

const playing = (p: Page) => p.evaluate(`!!document.querySelector("video.lim-movie")`) as Promise<boolean>;

/**
 * 動画の要素を見張る（開く前に入れる）。出た数、流れ始めた数、外れたときに最後まで流れていたか。
 * 出た動画は繰り返しにする（ひとりでには終わらない。最後まで見せるなら release）。要素は load() の前に足されるので、流れる前に繰り返しになる。
 */
const watchMovies = (p: Page) =>
  p.addInitScript(() => {
    const w = window as unknown as { __movies: number; __moviesFlowing: number; __moviesRemoved: { ended: boolean; time: number }[] };
    w.__movies = 0;
    w.__moviesFlowing = 0;
    w.__moviesRemoved = [];
    new MutationObserver((list) => {
      for (const m of list) {
        for (const n of m.addedNodes) {
          if (!(n instanceof HTMLVideoElement) || !n.classList.contains("lim-movie")) continue;
          w.__movies++;
          n.loop = true;
          const flow = () => {
            if (n.paused || n.currentTime <= 0) return;
            n.removeEventListener("timeupdate", flow);
            w.__moviesFlowing++;
          };
          n.addEventListener("timeupdate", flow);
        }
        for (const n of m.removedNodes) if (n instanceof HTMLVideoElement && n.classList.contains("lim-movie")) w.__moviesRemoved.push({ ended: n.ended, time: n.currentTime });
      }
    }).observe(document, { childList: true, subtree: true });
  });
const movies = (p: Page) => p.evaluate("window.__movies") as Promise<number>;
const removed = (p: Page) => p.evaluate("window.__moviesRemoved") as Promise<{ ended: boolean; time: number }[]>;

describe.skipIf(!e2e)("動画の再生中のクイックメニュー（ブラウザ）", { timeout: 300_000 }, () => {
  let plain: TestProject;
  let plugin: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    const files = { "assets/video/m.webm": MOVIE, "assets/video/m.vtt": SUBTITLES };
    plain = await startProject({ scenario: SCENARIOS, config: { entry: "plain" }, files });
    plugin = await startProject({ scenario: { plain: SCENARIOS.plain }, config: { entry: "plain" }, files, plugin: PLUGIN });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await plain?.close();
    await plugin?.close();
  });

  /** 動画を見張ってから、台本 start で開く（読み終えるのは待たず、そのあとの状態で待つ）。 */
  async function open(browser: Browser, project: TestProject, start: string, query = ""): Promise<Page> {
    const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await watchMovies(p);
    await p.goto(`${project.url}?autostart=1&start=${start}${query}`, { waitUntil: "commit", ...UNTIL_DONE });
    return p;
  }

  async function run(project: TestProject, start: string, selector: string): Promise<{ before: boolean; during: boolean; after: boolean }[]> {
    const out = [];
    for (const { browser } of list) {
      const p = await open(browser, project, start);
      await clickWait(p, "はじまり");
      const before = await barShown(p, selector);
      await p.mouse.click(640, 360);
      await flowing(p, 1);
      const during = await barShown(p, selector);
      // 最後まで流して、次のページが出るまで
      await release(p);
      await clickWait(p, "終わり");
      const after = await barShown(p, selector);
      out.push({ before, during, after });
      await p.close();
    }
    return out;
  }

  it("標準のクイックメニューは、再生中だけ隠れる", async () => {
    for (const r of await run(plain, "plain", ".lm-menubar")) expect(r).toEqual({ before: true, during: false, after: true });
  });

  it("プラグインが差し替えたクイックメニューも、再生中だけ隠れる", async () => {
    for (const r of await run(plugin, "plain", ".t-bar")) expect(r).toEqual({ before: true, during: false, after: true });
  });

  it("menu=true なら再生中も出したまま", async () => {
    for (const r of await run(plain, "menu", ".lm-menubar")) expect(r).toEqual({ before: true, during: true, after: true });
  });

  it("subtitles= の字幕（WebVTT）を動画に重ねて出す", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, plain, "subtitles");
      await clickWait(p, "はじまり");
      await p.mouse.click(640, 360);
      await p.waitForFunction(`(() => { const t = document.querySelector("video.lim-movie")?.textTracks[0]; return !!t && t.mode === "showing" && (t.cues?.length ?? 0) > 0; })()`, null, UNTIL_DONE);
      expect(await p.evaluate(`document.querySelector("video.lim-movie").textTracks[0].cues[0].text`), name).toBe("丘の上で星を待つ");
      await p.close();
    }
  });

  it("一度最後まで見た動画は、skip=false でもクリックで飛ばせる（skip-seen=false なら飛ばせない）", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, plain, "seen");
      await clickWait(p, "はじまり");
      // 一回目: 見ていないので、押しても飛ばない（流れている動画を押しても残り、繰り返しを外すと最後まで流れて次へ）
      await p.mouse.click(640, 360);
      await flowing(p, 1);
      await p.mouse.click(640, 360);
      await frames(p);
      expect(await playing(p), name).toBe(true);
      await release(p);
      await clickWait(p, "一回目");
      expect(await p.evaluate(`window.__liminalia.system.systemVariables.movies_watched`), name).toEqual({ "m.webm": true });
      // 二回目: 見たので、押せば飛ぶ（繰り返しの動画が、押したことで外れる）
      await p.mouse.click(640, 360);
      await flowing(p, 2);
      await p.mouse.click(640, 360);
      await clickWait(p, "二回目");
      expect((await removed(p)).at(-1)?.ended, name).toBe(false);
      // 三回目: skip-seen=false なら飛ばない
      await p.mouse.click(640, 360);
      await flowing(p, 3);
      await p.mouse.click(640, 360);
      await frames(p);
      expect(await playing(p), name).toBe(true);
      await release(p);
      await clickWait(p, "三回目");
      expect((await removed(p)).map((m) => m.ended), name).toEqual([true, false, true]);
      await p.close();
    }
  });

  it("飛ばせる動画（skip=true）は、決定キー、送り（host.advance）、スキップの始まりで終わる", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, plain, "skippable");
      // 流れ始めた動画（繰り返しなのでひとりでには終わらない）を送る。次のページが出れば送りで飛ばしたことになる
      const next = async (text: string, n: number) => {
        await clickWait(p, text);
        await p.mouse.click(640, 360);
        await flowing(p, n);
      };
      await next("はじまり", 1);
      await p.keyboard.press("Enter");
      await next("一回目", 2);
      await p.evaluate("window.__liminalia.host.advance()");
      await next("二回目", 3);
      await p.evaluate("window.__liminalia.host.skipping = true");
      await p.waitForFunction(`!document.querySelector("video.lim-movie") && document.querySelector(".message .text")?.textContent.includes("三回目")`, null, UNTIL_DONE);
      // どれも最後まで流れずに外れた
      expect((await removed(p)).map((m) => m.ended), name).toEqual([false, false, false]);
      await p.close();
    }
  });

  it("飛ばせない動画は、決定キーと送りでは終わらず、スキップ中も流す。開発用の早送り（?skip=）と自動確認（?autoplay=1）では流さない", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, plain, "unskippable");
      await clickWait(p, "はじまり");
      await p.mouse.click(640, 360);
      // 流れている動画に決定キーと送り。外れなければ、繰り返しを外して最後まで流す
      await flowing(p, 1);
      await p.keyboard.press("Enter");
      await p.evaluate("window.__liminalia.host.advance()");
      await frames(p);
      expect(await playing(p), name).toBe(true);
      await release(p);
      await clickWait(p, "一回目");
      // スキップ中に来ても流す（流し終えるまで次へ進まない）
      await p.evaluate("window.__liminalia.host.skipping = true; window.__liminalia.host.advance()");
      await flowing(p, 2);
      await release(p);
      await p.waitForFunction(`!document.querySelector("video.lim-movie") && document.querySelector(".message .text")?.textContent.includes("二回目")`, null, UNTIL_DONE);
      expect((await removed(p)).map((m) => m.ended), name).toEqual([true, true]);
      await p.close();

      // 開発用の早送り（?skip=2 で 2 ページ目まで）と、自動確認（?autoplay=1）
      for (const query of ["skip=2", "autoplay=1"]) {
        const q = await open(browser, plain, "unskippable", `&${query}`);
        await q.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("はじまり") || document.querySelector(".message .text")?.textContent.includes("一回目")`, null, UNTIL_DONE);
        if (query === "autoplay=1") {
          await clickWait(q);
          await q.mouse.click(640, 360);
        }
        await q.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("一回目")`, null, UNTIL_DONE);
        expect(await movies(q), `${name} ${query}`).toBe(0);
        await q.close();
      }
    }
  });
});
