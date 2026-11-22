import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { translationKey } from "@liminalia/lang";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/** 置いたままの文字（@layer-text・チャットの吹き出し・常駐の表示）を、遊んでいる途中で言語を替えたら今の言語で出し直すことを、実際のブラウザで確かめる。 */

const SCENARIO = `@window show
@layer-text "第一章" x=40 y=40 size=40 name=chapter
@chat-open 連絡 me=ソウ
@chat ユイ text="いまどこ？" wait=false
@set game.day = 3
@hud-text day text="{= game.day} 日目" x=40 y=640 size=28
@hud-button memo label=メモ x=1100 y=20 call=#memo
本文。
@stop

# memo
メモ。
@return
`;

const shown = (p: Page) =>
  p.evaluate(`(() => ({
    text: document.querySelector(".lim-text")?.textContent ?? null,
    head: document.querySelector(".lim-chat-head")?.textContent ?? null,
    bubble: document.querySelector(".lim-chat-bubble")?.textContent ?? null,
    name: document.querySelector(".lim-chat-name")?.textContent ?? null,
    hud: [document.querySelector(".lim-hud-text")?.textContent ?? null, document.querySelector(".lim-hud-button")?.textContent ?? null],
  }))()`) as Promise<{ text: string | null; head: string | null; bubble: string | null; name: string | null; hud: (string | null)[] }>;

/** 言語を替え、開き直した設定画面を閉じる。 */
async function switchTo(p: Page, language: string): Promise<void> {
  await p.evaluate(`window.__liminalia.system.updateSettings({ language: ${JSON.stringify(language)} })`);
  await p.waitForTimeout(600);
  while (await p.locator(".lm-screen").count()) {
    await p.keyboard.press("Escape");
    await p.waitForTimeout(200);
  }
}

describe.skipIf(!e2e)("置いたままの文字を言語に合わせて出し直す（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    const arg = (s: string) => translationKey("a", "arg", s);
    project = await startProject({
      scenario: { a: SCENARIO },
      config: { entry: "a", languages: ["ja", "en"] },
      before: (dir) => {
        mkdirSync(join(dir, "lang"), { recursive: true });
        writeFileSync(
          join(dir, "lang/en.json"),
          JSON.stringify({
            language: "en",
            speakers: { ユイ: "Yui" },
            lines: {
              [arg("第一章")]: { source: "第一章", text: "Chapter 1" },
              [arg("連絡")]: { source: "連絡", text: "Messages" },
              [arg("いまどこ？")]: { source: "いまどこ？", text: "Where are you?" },
              [arg("{= game.day} 日目")]: { source: "{= game.day} 日目", text: "Day {= game.day}" },
              [arg("メモ")]: { source: "メモ", text: "Memo" },
            },
          }),
        );
      },
    });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("言語を替えると、出したままの章題とチャットの題、吹き出し、名前、常駐の表示が今の言語になり、戻すと原文に戻る", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 }, locale: "ja-JP" });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("本文")`);
      expect(await shown(p), name).toEqual({ text: "第一章", head: "連絡", bubble: "いまどこ？", name: "ユイ", hud: ["3 日目", "メモ"] });
      await switchTo(p, "en");
      await p.waitForFunction(`document.querySelector(".lim-text")?.textContent === "Chapter 1"`, null, { timeout: 5000 });
      expect(await shown(p), name).toEqual({ text: "Chapter 1", head: "Messages", bubble: "Where are you?", name: "Yui", hud: ["Day 3", "Memo"] });
      await p.screenshot({ path: join(process.env.LIMINALIA_E2E_SHOTS ?? "/tmp", `relocalize-${name}.png`) }).catch(() => undefined);
      await switchTo(p, "ja");
      await p.waitForFunction(`document.querySelector(".lim-text")?.textContent === "第一章"`, null, { timeout: 5000 });
      expect(await shown(p), name).toEqual({ text: "第一章", head: "連絡", bubble: "いまどこ？", name: "ユイ", hud: ["3 日目", "メモ"] });
      await p.close();
    }
  });
});
