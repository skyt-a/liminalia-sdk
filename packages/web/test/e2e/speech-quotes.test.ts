import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 英語の台詞（話者名の後ろの " “ で始まる行）と、台詞の外側の括弧と引用符の出し方（ui.text.quotes）を、実際のブラウザで確かめる。
 * 既定（keep）は書いたまま、strip は外側の一組を外す。メッセージ枠・名前欄・バックログ・@balloon・チャットの画面の吹き出し。
 */

const SCENARIO = `@window show
Yui "Hello."
Yui“Wait for me!”
アカリ「おはよう」
Yui "a" and "b"
@chara アカリ normal at=right
@balloon on
アカリ "In a balloon."
@balloon off
Yui{name ???} "Who?"
`;

const CHAT = `Yui "Hello."
アカリ「おはよう」
Yui “Bye.”
`;

interface Liminalia {
  host: { waiting: boolean; advance(): void };
  pages(): number;
}

const waiting = (p: Page) => p.waitForFunction(() => (window as unknown as { __liminalia?: Liminalia }).__liminalia?.host.waiting === true, null, { timeout: 30_000 });
const send = async (p: Page) => {
  await waiting(p);
  await p.evaluate(() => (window as unknown as { __liminalia: Liminalia }).__liminalia.host.advance());
  await p.waitForFunction(() => (window as unknown as { __liminalia: Liminalia }).__liminalia.host.waiting === false, null, { timeout: 5000 }).catch(() => undefined);
};

/** 今のページの名前欄と本文（クリック待ちの印は除く）。 */
const page = async (p: Page): Promise<[string, string]> => {
  await waiting(p);
  return p.evaluate(() => {
    const text = document.querySelector(".message .text")!.cloneNode(true) as HTMLElement;
    for (const x of text.querySelectorAll(".glyph")) x.remove();
    return [document.querySelector(".message .name")!.textContent ?? "", text.textContent ?? ""];
  });
};

/** チャットの画面の吹き出しの文字。 */
const bubbles = (p: Page) =>
  p.evaluate(() =>
    [...document.querySelectorAll(".lim-chat-bubble")].map((b) => {
      const clone = b.cloneNode(true) as HTMLElement;
      for (const x of clone.querySelectorAll(".glyph")) x.remove();
      return clone.textContent;
    }),
  ) as Promise<string[]>;

/** 英語の話者 Yui を足す。 */
const addYui = (dir: string) => {
  const file = join(dir, "cast.json");
  const cast = JSON.parse(readFileSync(file, "utf8"));
  cast.speakers.push("Yui");
  writeFileSync(file, JSON.stringify(cast));
};

describe.skipIf(!e2e)("英語の台詞と台詞の外側の引用符（ブラウザ）", { timeout: 300_000 }, () => {
  const projects: Record<string, TestProject> = {};
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    for (const quotes of ["keep", "strip"] as const) {
      const text = quotes === "keep" ? {} : { text: { quotes } };
      projects[quotes] = await startProject({ scenario: { a: SCENARIO }, config: { entry: "a", ui: text }, before: addYui });
      projects[`chat-${quotes}`] = await startProject({ scenario: { a: CHAT }, config: { entry: "a", ui: { ...text, chat: { dialogue: true } } }, before: addYui });
    }
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    for (const p of Object.values(projects)) await p.close();
  });

  const expected = {
    keep: [
      ["Yui", '"Hello."'],
      ["Yui", "“Wait for me!”"],
      ["アカリ", "「おはよう」"],
      ["Yui", '"a" and "b"'],
      ["アカリ", '"In a balloon."'],
      ["???", '"Who?"'],
    ],
    strip: [
      ["Yui", "Hello."],
      ["Yui", "Wait for me!"],
      ["アカリ", "おはよう"],
      // 途中で閉じる引用符は外さない
      ["Yui", '"a" and "b"'],
      ["アカリ", "In a balloon."],
      ["???", "Who?"],
    ],
  };

  for (const quotes of ["keep", "strip"] as const) {
    it(`メッセージ枠・吹き出し・バックログ（ui.text.quotes: ${quotes}）`, async () => {
      for (const { name, browser } of list) {
        const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        await p.goto(`${projects[quotes]!.url}?autostart=1&start=a`);
        const shown: [string, string][] = [];
        for (let i = 0; i < expected[quotes].length; i++) {
          if (i > 0) await send(p);
          shown.push(await page(p));
          if (i === 4) expect(await p.evaluate(() => document.querySelector(".message")!.classList.contains("balloon")), `${name} 吹き出し`).toBe(true);
        }
        expect(shown, name).toEqual(expected[quotes]);
        const shots = process.env.LIMINALIA_SHOT_DIR;
        if (name === "chromium" && shots) await p.screenshot({ path: `${shots}/speech-quotes-${quotes}.png` });
        await p.evaluate(`void window.__liminalia.system.perform("backlog")`);
        await p.waitForSelector(".lm-log-entry");
        const log = (await p.evaluate(`[...document.querySelectorAll(".lm-log-entry")].map((r) => [r.querySelector(".lm-log-name").textContent, r.querySelector(".lm-log-text").textContent])`)) as [string, string][];
        expect(log, `${name} バックログ`).toEqual(expected[quotes]);
        await p.close();
      }
    });

    it(`チャットの画面の吹き出し（ui.text.quotes: ${quotes}）`, async () => {
      for (const { name, browser } of list) {
        const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        await p.goto(`${projects[`chat-${quotes}`]!.url}?autostart=1&start=a`);
        await waiting(p);
        await send(p);
        await send(p);
        await waiting(p);
        // チャットの画面は「」をいつも外す（吹き出しが括弧の代わり）。引用符は設定のとおり
        expect(await bubbles(p), name).toEqual(quotes === "keep" ? ['"Hello."', "おはよう", "“Bye.”"] : ["Hello.", "おはよう", "Bye."]);
        // 名前は話者名
        expect(await p.evaluate(() => [...document.querySelectorAll(".lim-chat-name")].map((n) => n.textContent)), name).toContain("Yui");
        await p.close();
      }
    });
  }
});
