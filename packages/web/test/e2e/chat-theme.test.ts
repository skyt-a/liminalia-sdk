import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { UI_THEMES, applyUiTheme } from "@liminalia/lang";
import { copyUiThemeAssets } from "@liminalia/project";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * チャットのテーマ（ui.chat.dialogue）を、実際のブラウザで確かめる。シナリオの書き方はふつうのまま。
 * 台詞の吹き出し・地の文の一行・文中のクリック待ち・入力中の表示・選択肢と選んだあとの吹き出し・セーブとロード・スキップ・バックログ・既読・
 * @nvl との切り替え・枠を隠す操作。ui.chat を書かない作品の @chat の計算済みスタイルが、今までと同じ値のままであることも測る。
 */

const SCENARIO = `@bg hill_dusk.webp
アカリ「いま{r 丘|おか}の上にいるの。」
周りには、もう誰もいない。
ソウ「すぐ行く。{click}待ってて。」
アカリ「ほんと？」
@choice
- 走って向かう -> #run
- 歩いて向かう -> #walk
@end
# run
アカリ「はやい！」
ソウ「着いた。」
@chat アカリ text="スタンプの代わり"
@nvl on
ここは NVL の段落。
@nvl off
アカリ「戻ってきた。」
@clear
ソウ「消えた？」
@chat-close
最後の一行。
# walk
アカリ「ゆっくりでいいよ。」
`;

/** ボイス・文中の命令・文字の速さを確かめる台本。 */
const SOUND = `@bg hill_dusk.webp
アカリ「一つ目。」
@voice radio.wav folder=sound
アカリ「ボイスつき。」
アカリ「鳴らす{@se chime.wav}文中の命令。」
@text-speed per-char=200
アカリ「ゆっくり。」
`;

const CHAT = UI_THEMES.find((t) => t.id === "chat")!;
const PORTRAIT = { width: 720, height: 1280 };

interface Liminalia {
  host: { waiting: boolean; advance(): void };
  pages(): number;
}

/** 吹き出しの列（種類と文字。クリック待ちの印とルビは文字に入れない）。 */
const rows = (p: Page) =>
  p.evaluate(() =>
    [...document.querySelectorAll(".lim-chat-list > *")].map((r) => {
      const note = r.classList.contains("lim-chat-note");
      const clone = (note ? r : r.querySelector(".lim-chat-bubble")!).cloneNode(true) as HTMLElement;
      for (const x of clone.querySelectorAll(".glyph, .rt")) x.remove();
      return [note ? "note" : r.classList.contains("is-me") ? "me" : "other", clone.textContent];
    }),
  ) as Promise<[string, string][]>;

const waiting = (p: Page) => p.waitForFunction(() => (window as unknown as { __liminalia?: Liminalia }).__liminalia?.host.waiting === true, null, { timeout: 30_000 });
const pageIs = (p: Page, n: number) => p.waitForFunction((target) => { const l = (window as unknown as { __liminalia?: Liminalia }).__liminalia; return !!l && l.pages() === target && l.host.waiting; }, n, { timeout: 30_000 });

/** クリック待ちを一回送る。 */
const send = async (p: Page) => {
  await waiting(p);
  await p.evaluate(() => (window as unknown as { __liminalia: Liminalia }).__liminalia.host.advance());
  await p.waitForFunction(() => (window as unknown as { __liminalia: Liminalia }).__liminalia.host.waiting === false, null, { timeout: 5000 }).catch(() => undefined);
};

/** n ページ目のクリック待ちまで送る。 */
const toPage = async (p: Page, n: number) => {
  while (((await p.evaluate(() => (window as unknown as { __liminalia: Liminalia }).__liminalia.pages())) as number) < n) await send(p);
  await pageIs(p, n);
};

describe.skipIf(!e2e)("チャットのテーマ（ブラウザ）", { timeout: 300_000 }, () => {
  let project: TestProject;
  let plain: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    const ui = applyUiTheme({}, CHAT);
    project = await startProject({
      scenario: { a: SCENARIO, sound: SOUND },
      config: { screen: PORTRAIT, ui: { ...ui, chat: { ...ui.chat, me: "ソウ", typing: 400 } } },
      before: (dir) => {
        copyUiThemeAssets(dir, CHAT);
        // アカリにだけ顔（立ち絵の切り出し）を付ける
        const file = join(dir, "cast.json");
        const cast = JSON.parse(readFileSync(file, "utf8"));
        cast.cast["アカリ"].appearances.default.face = { x: 100, y: 40, width: 200, height: 200 };
        writeFileSync(file, JSON.stringify(cast));
      },
    });
    plain = await startProject({ scenario: { a: `@window hide\n@chat-open アカリ me=ソウ\n@chat アカリ text="いまどこ？"\n@chat ソウ text="着いた"\n` }, config: { entry: "a" } });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
    await plain?.close();
  });

  const open = async (browser: Browser): Promise<Page> => {
    const context = await browser.newContext({ viewport: PORTRAIT });
    const p = await context.newPage();
    await p.goto(`${project.url}?autostart=1&start=a`);
    await pageIs(p, 1);
    return p;
  };

  /** 選択肢まで送る。 */
  const toChoice = async (p: Page) => {
    await toPage(p, 4);
    await send(p);
    await p.waitForSelector(".choices button");
    await p.waitForTimeout(100);
  };

  it("台詞は鉤括弧を外して吹き出しに、地の文は中央の小さな一行になり、メッセージ枠は出ない", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser);
      expect(await rows(p), name).toEqual([["other", "いま丘の上にいるの。"]]);
      // ルビは枠の本文と同じ部品で出す
      expect(await p.locator(".lim-chat-bubble .ruby .rt").textContent(), name).toBe("おか");
      expect(await p.evaluate(() => getComputedStyle(document.querySelector(".message")!).visibility), name).toBe("hidden");
      await toPage(p, 2);
      expect((await rows(p)).at(-1), name).toEqual(["note", "周りには、もう誰もいない。"]);
      const note = await p.evaluate(() => {
        const n = document.querySelector<HTMLElement>(".lim-chat-note")!;
        const b = n.getBoundingClientRect();
        const s = document.querySelector(".stage")!.getBoundingClientRect();
        return { center: (b.left + b.right) / 2 - (s.left + s.right) / 2, size: parseFloat(getComputedStyle(n).fontSize), bubble: parseFloat(getComputedStyle(document.querySelector(".lim-chat-bubble")!).fontSize) };
      });
      expect(Math.abs(note.center), name).toBeLessThan(2);
      expect(note.size, name).toBeLessThan(note.bubble);
      await p.context().close();
    }
  });

  it("相手の吹き出しの前に入力中の表示を出し、押すと飛ばせる", async () => {
    for (const { name, browser } of list) {
      const context = await browser.newContext({ viewport: PORTRAIT });
      const p = await context.newPage();
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForSelector(".lim-chat-bubble.is-typing");
      expect(await p.locator(".lim-chat-dot").count(), name).toBe(3);
      await p.evaluate(() => (window as unknown as { __liminalia: Liminalia }).__liminalia.host.advance());
      await p.waitForFunction(() => !document.querySelector(".lim-chat-bubble.is-typing"));
      // 押したので文字は一度に出る
      await waiting(p);
      expect(await rows(p), name).toEqual([["other", "いま丘の上にいるの。"]]);
      await context.close();
    }
  });

  it("文中のクリック待ちは同じ吹き出しの中で進み、自分の吹き出しは右に出る", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser);
      await toPage(p, 3);
      expect((await rows(p)).at(-1), name).toEqual(["me", "すぐ行く。"]);
      expect(await p.locator(".lim-chat-row.is-me .glyph").count(), name).toBe(1);
      await send(p);
      await waiting(p);
      expect((await rows(p)).at(-1), name).toEqual(["me", "すぐ行く。待ってて。"]);
      const side = await p.evaluate(() => {
        const me = document.querySelector(".lim-chat-row.is-me .lim-chat-bubble")!.getBoundingClientRect();
        const other = document.querySelector(".lim-chat-row:not(.is-me) .lim-chat-bubble")!.getBoundingClientRect();
        return { me: me.right, other: other.left, stage: document.querySelector(".stage")!.getBoundingClientRect().right };
      });
      expect(side.stage - side.me, name).toBeLessThan(60);
      expect(side.other, name).toBeLessThan(side.me);
      await p.context().close();
    }
  });

  it("選択肢は下に並び、選ぶと自分の吹き出しになる。セーブして読み直すと列が戻る", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser);
      await toChoice(p);
      // 舞台の下のほうに並び、最後の吹き出しを隠さない
      const place = await p.evaluate(() => {
        const s = document.querySelector(".stage")!.getBoundingClientRect();
        const buttons = [...document.querySelectorAll(".choices button")].map((b) => b.getBoundingClientRect());
        const last = [...document.querySelectorAll(".lim-chat-bubble")].at(-1)!.getBoundingClientRect();
        return { top: (buttons[0]!.top - s.top) / s.height, bottom: (buttons.at(-1)!.bottom - s.top) / s.height, last: last.bottom, first: buttons[0]!.top };
      });
      expect(place.top, name).toBeGreaterThan(0.6);
      expect(place.bottom, name).toBeLessThan(1);
      expect(place.last, name).toBeLessThanOrEqual(place.first);
      await p.locator(".choices button").first().click();
      await pageIs(p, 5);
      const before = await rows(p);
      expect(before, name).toEqual([
        ["other", "いま丘の上にいるの。"],
        ["note", "周りには、もう誰もいない。"],
        ["me", "すぐ行く。待ってて。"],
        ["other", "ほんと？"],
        ["me", "走って向かう"],
        ["other", "はやい！"],
      ]);

      // セーブして読み直す（ページを開き直しても）
      await p.evaluate("window.__liminalia.system.saveTo(1)");
      await p.reload();
      await p.waitForFunction(() => !!(window as unknown as { __liminalia?: { system: unknown } }).__liminalia?.system);
      await p.evaluate("window.__liminalia.system.loadFrom(1)");
      await p.waitForFunction(() => document.querySelectorAll(".lim-chat-list > *").length === 6 && (window as unknown as { __liminalia: Liminalia }).__liminalia.host.waiting);
      expect(await rows(p), name).toEqual(before);
      expect(await p.locator(".lim-chat-bubble .ruby .rt").first().textContent(), name).toBe("おか");
      // 読み直したページの続きも同じ列に積む
      await send(p);
      await waiting(p);
      expect((await rows(p)).at(-1), name).toEqual(["me", "着いた。"]);
      expect((await rows(p)).length, name).toBe(7);
      await p.context().close();
    }
  });

  it("スキップしても列は同じで、入力中の表示で止まらない", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser);
      await p.evaluate("window.__liminalia.system.updateSettings({ skipUnread: true })");
      await p.evaluate(`void window.__liminalia.system.perform("skip")`);
      await p.waitForSelector(".choices button", { timeout: 20_000 });
      expect(await p.locator(".lim-chat-bubble.is-typing").count(), name).toBe(0);
      expect(await rows(p), name).toEqual([
        ["other", "いま丘の上にいるの。"],
        ["note", "周りには、もう誰もいない。"],
        ["me", "すぐ行く。待ってて。"],
        ["other", "ほんと？"],
      ]);
      await p.context().close();
    }
  });

  it("オートで次のページへ進み、選択肢で止まる", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser);
      await p.evaluate("window.__liminalia.system.updateSettings({ autoWait: 500 })");
      await p.evaluate(`void window.__liminalia.system.perform("auto")`);
      await p.waitForSelector(".choices button", { timeout: 60_000 });
      expect((await rows(p)).map((r) => r[1]), name).toEqual(["いま丘の上にいるの。", "周りには、もう誰もいない。", "すぐ行く。待ってて。", "ほんと？"]);
      await p.context().close();
    }
  });

  it("巻き戻しで列が戻り、進み直しても二重にならない", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser);
      await toPage(p, 3);
      await p.evaluate(`void window.__liminalia.system.perform("rollback")`);
      await p.waitForTimeout(600);
      await waiting(p);
      expect(await rows(p), name).toEqual([
        ["other", "いま丘の上にいるの。"],
        ["note", "周りには、もう誰もいない。"],
      ]);
      await send(p);
      await waiting(p);
      expect((await rows(p)).length, name).toBe(3);
      await p.context().close();
    }
  });

  it("次の選択肢へ飛んでも、飛ばしたページが列に入る", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser);
      await p.evaluate("window.__liminalia.system.updateSettings({ skipUnread: true })");
      await p.evaluate(`void window.__liminalia.system.perform("next-choice")`);
      await p.waitForSelector(".choices button", { timeout: 20_000 });
      await p.waitForTimeout(200);
      expect((await rows(p)).map((r) => r[1]), name).toEqual(["いま丘の上にいるの。", "周りには、もう誰もいない。", "すぐ行く。待ってて。", "ほんと？"]);
      await p.context().close();
    }
  });

  it("顔は立ち絵の切り出しを丸く出し、無い人物は名前の一文字目。同じ話者が続けば名前を省く", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser);
      await p.waitForSelector(".lim-chat-face img");
      await p.context().close();
      const q = await (await browser.newContext({ viewport: PORTRAIT })).newPage();
      await q.goto(`${project.url}?autostart=1&start=sound`);
      await pageIs(q, 1);
      await toPage(q, 2);
      expect(await q.locator(".lim-chat-name").count(), name).toBe(1);
      expect(await q.locator(".lim-chat-row.is-next").count(), name).toBe(1);
      await q.context().close();
    }
  });

  it("ボイス・文中の命令・文字の速さはいつもの本文と同じに効く", async () => {
    for (const { name, browser } of list) {
      const context = await browser.newContext({ viewport: PORTRAIT });
      const p = await context.newPage();
      await p.goto(`${project.url}?autostart=1&start=sound`);
      await pageIs(p, 1);
      await p.evaluate(() => {
        const host = (window as unknown as { __liminalia: { host: { playVoice(folder: string, file: string, volume: number): void; playVoiceCue(cue: { file: string }, speaker: string | null): void; audio: { playSe(...a: unknown[]): unknown } } } }).__liminalia.host;
        const seen: string[] = ((window as unknown as { seen: string[] }).seen = []);
        const voice = host.playVoice.bind(host);
        host.playVoice = (folder, file, volume) => {
          seen.push(`voice:${file}`);
          voice(folder, file, volume);
        };
        // ページのボイス（@voice のあとの台詞）は playVoiceCue で鳴らす（同時に鳴らすボイスもまとめて）
        const cue = host.playVoiceCue.bind(host);
        host.playVoiceCue = (c, speaker) => {
          seen.push(`voice:${c.file}`);
          cue(c, speaker);
        };
        const se = host.audio.playSe.bind(host.audio);
        host.audio.playSe = (...a: unknown[]) => {
          seen.push(`se:${String(a[1])}`);
          return se(...a);
        };
      });
      await toPage(p, 2);
      expect(await p.evaluate(() => (window as unknown as { seen: string[] }).seen), name).toEqual(["voice:radio.wav"]);
      await toPage(p, 3);
      expect(await p.evaluate(() => (window as unknown as { seen: string[] }).seen), name).toEqual(["voice:radio.wav", "se:chime.wav"]);
      expect((await rows(p)).at(-1), name).toEqual(["other", "鳴らす文中の命令。"]);
      // 文字の速さ: 一文字ずつ遅れて出す（途中で次の文字はまだ出ていない）
      await send(p);
      await p.waitForFunction(() => [...document.querySelectorAll(".lim-chat-bubble")].at(-1)!.textContent!.includes("ゆ"));
      const delays = await p.evaluate(() => [...[...document.querySelectorAll(".lim-chat-bubble")].at(-1)!.querySelectorAll<HTMLElement>(".ch")].map((c) => c.style.animationDelay));
      expect(delays.slice(0, 3), name).toEqual(["0ms", "200ms", "400ms"]);
      await context.close();
    }
  });

  it("バックログにはふだんの本文（括弧つき）と話者が残る", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser);
      await toPage(p, 2);
      await p.evaluate(`void window.__liminalia.system.perform("backlog")`);
      await p.waitForSelector(".lm-log-entry");
      const log = (await p.evaluate(`[...document.querySelectorAll(".lm-log-entry")].map((e) => e.textContent)`)) as string[];
      expect(log.some((t) => t.includes("アカリ") && t.includes("「いま丘") && t.includes("いるの。」")), `${name} ${log.join(" / ")}`).toBe(true);
      expect(log.some((t) => t.includes("周りには、もう誰もいない。")), name).toBe(true);
      await p.context().close();
    }
  });

  it("既読のページには印が付き、入力中の表示を出さない", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser);
      expect(await p.locator(".lim-chat-row.is-read").count(), name).toBe(0);
      await toPage(p, 2);
      // 既読を書き残してから、同じ作品をもう一度はじめから
      await p.evaluate(`window.__liminalia.system.saveTo(1)`);
      await p.waitForTimeout(600);
      await p.goto(`${project.url}?autostart=1&start=a`);
      await pageIs(p, 1);
      expect(await p.locator(".lim-chat-row.is-read").count(), name).toBe(1);
      // 読んだページでは一度も「…」を出していない（出していれば文字より先に要素が現れる）
      const seen = await p.evaluate(() => document.querySelectorAll(".lim-chat-dot").length);
      expect(seen, name).toBe(0);
      await p.context().close();
    }
  });

  it("@chat も同じ列に積み、@nvl on の間は枠に戻し、@clear で列を消し、@chat-close のあとは次の本文で開き直す", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser);
      await toChoice(p);
      await p.locator(".choices button").first().click();
      await pageIs(p, 5);
      await toPage(p, 6);
      await send(p);
      // @chat の吹き出し（ページではない）
      await p.waitForFunction(() => [...document.querySelectorAll(".lim-chat-bubble")].at(-1)!.textContent!.includes("スタンプの代わり"));
      await waiting(p);
      expect((await rows(p)).length, name).toBe(8);
      await send(p);
      // NVL: 枠に出し、チャットの画面は隠す
      await p.waitForSelector(".message.nvl .text .ch");
      await waiting(p);
      expect(await p.evaluate(() => [getComputedStyle(document.querySelector(".message")!).visibility, getComputedStyle(document.querySelector(".lim-chat")!).visibility]), name).toEqual(["visible", "hidden"]);
      await send(p);
      // 戻ったら列はそのままで、続きを積む
      await p.waitForFunction(() => [...document.querySelectorAll(".lim-chat-bubble")].at(-1)!.textContent!.includes("戻ってきた"));
      await waiting(p);
      expect(await p.evaluate(() => [getComputedStyle(document.querySelector(".message")!).visibility, getComputedStyle(document.querySelector(".lim-chat")!).visibility]), name).toEqual(["hidden", "visible"]);
      expect((await rows(p)).length, name).toBe(9);
      await send(p);
      // @clear で列を消す
      await p.waitForFunction(() => document.querySelectorAll(".lim-chat-list > *").length === 1);
      await waiting(p);
      expect(await rows(p), name).toEqual([["me", "消えた？"]]);
      await send(p);
      // @chat-close のあとの地の文は、開き直した画面の一行
      await p.waitForFunction(() => document.querySelector(".lim-chat-note")?.textContent?.includes("最後の一行"));
      expect(await rows(p), name).toEqual([["note", "最後の一行。"]]);
      await p.context().close();
    }
  });

  it("枠を隠す操作でチャットの画面も隠れ、戻すと出る", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser);
      await p.evaluate(`void window.__liminalia.system.perform("hide")`);
      await p.waitForTimeout(100);
      expect(await p.evaluate(() => getComputedStyle(document.querySelector(".lim-chat")!).visibility), name).toBe("hidden");
      await p.mouse.click(360, 640);
      await p.waitForTimeout(100);
      expect(await p.evaluate(() => getComputedStyle(document.querySelector(".lim-chat")!).visibility), name).toBe("visible");
      await p.context().close();
    }
  });

  it("基準と違う大きさ（1080×1920）でも舞台いっぱいに出し、選択肢の帯が列を隠さない", async () => {
    const big = await startProject({
      scenario: { a: SCENARIO },
      config: { screen: { width: 1080, height: 1920 }, ui: applyUiTheme({}, CHAT) },
      before: (dir) => copyUiThemeAssets(dir, CHAT),
    });
    try {
      for (const { name, browser } of list) {
        const p = await browser.newPage({ viewport: PORTRAIT });
        await p.goto(`${big.url}?autostart=1&start=a`);
        await pageIs(p, 1);
        const box = await p.evaluate(() => {
          const s = document.querySelector(".stage")!.getBoundingClientRect();
          const c = document.querySelector(".lim-chat")!.getBoundingClientRect();
          return [c.left - s.left, c.top - s.top, s.right - c.right, s.bottom - c.bottom].map((v) => Math.abs(Math.round(v)));
        });
        expect(box, name).toEqual([0, 0, 0, 0]);
        await toChoice(p);
        const place = await p.evaluate(() => {
          const last = [...document.querySelectorAll(".lim-chat-bubble")].at(-1)!.getBoundingClientRect();
          const first = document.querySelector(".choices button")!.getBoundingClientRect();
          return { last: last.bottom, first: first.top, stage: document.querySelector(".stage")!.getBoundingClientRect().bottom, end: [...document.querySelectorAll(".choices button")].at(-1)!.getBoundingClientRect().bottom };
        });
        expect(place.last, name).toBeLessThanOrEqual(place.first);
        expect(place.end, name).toBeLessThan(place.stage);
        await p.close();
      }
    } finally {
      await big.close();
    }
  });

  it("ui.chat を書かなければ @chat の見た目は今までと同じ（計算済みスタイルの値）", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${plain.url}?autostart=1&start=a`);
      await p.waitForSelector(".lim-chat-bubble");
      await p.waitForTimeout(400);
      await p.evaluate(() => (window as unknown as { __liminalia: Liminalia }).__liminalia.host.advance());
      await p.waitForSelector(".lim-chat-row.is-me");
      await p.waitForTimeout(400);
      const look = await p.evaluate(() => {
        const css = (s: string) => getComputedStyle(document.querySelector(s)!);
        const root = css(".lim-chat");
        const head = css(".lim-chat-head");
        const name = css(".lim-chat-name");
        const other = css(".lim-chat-row:not(.is-me) .lim-chat-bubble");
        const me = css(".lim-chat-row.is-me .lim-chat-bubble");
        const parent = document.querySelector(".lim-chat")!.parentElement!.className;
        return {
          parent,
          width: root.width,
          height: root.height,
          fontSize: root.fontSize,
          lineHeight: root.lineHeight,
          color: root.color,
          background: root.backgroundColor,
          image: root.backgroundImage,
          border: root.borderTopWidth,
          borderColor: root.borderTopColor,
          radius: root.borderTopLeftRadius,
          headBackground: head.backgroundColor,
          headColor: head.color,
          nameSize: name.fontSize,
          nameColor: name.color,
          otherColor: other.color,
          otherBackground: other.backgroundColor,
          otherRadius: [other.borderTopLeftRadius, other.borderBottomLeftRadius],
          meColor: me.color,
          meBackground: me.backgroundColor,
          meRadius: [me.borderTopLeftRadius, me.borderBottomRightRadius],
        };
      });
      expect(look, name).toEqual({
        parent: "layer overlay",
        width: "380px",
        height: "640px",
        fontSize: "16px",
        lineHeight: "24px",
        color: "rgb(28, 28, 30)",
        background: "rgb(233, 237, 242)",
        image: "none",
        border: "10px",
        borderColor: "rgb(17, 17, 17)",
        radius: "36px",
        headBackground: "rgb(247, 248, 250)",
        headColor: "rgb(28, 28, 30)",
        nameSize: "12px",
        nameColor: "rgb(93, 100, 112)",
        otherColor: "rgb(28, 28, 30)",
        otherBackground: "rgb(255, 255, 255)",
        otherRadius: ["16px", "4px"],
        meColor: "rgb(255, 255, 255)",
        meBackground: "rgb(47, 124, 246)",
        meRadius: ["16px", "4px"],
      });
      await p.close();
    }
  });
});
