import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/**
 * システム画面の効果音（ui.sound.ui）と、コンフィグの音量の欄の試聴（ui.settings.samples）を、実際のブラウザで確かめる。
 * 鳴らしたものは AudioPlayer の playSe と playSample を差し替えて見る（音のファイルは要らない）。
 */

const SOUNDS = { hover: "ui/hover.ogg", select: "ui/select.ogg", cancel: "ui/cancel.ogg", open: "ui/open.ogg", close: "ui/close.ogg", page: "ui/page.ogg", choice: "ui/choice.ogg" };
const NAMES = Object.fromEntries(Object.entries(SOUNDS).map(([k, v]) => [v, k]));

/** 鳴らした効果音の種類（と試聴）を数え直す。 */
const take = async (p: Page): Promise<string[]> => {
  const files = (await p.evaluate("window.__played.splice(0)")) as string[];
  return files.map((f) => NAMES[f] ?? f);
};

describe.skipIf(!e2e)("システム画面の効果音と音量の試聴（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({
      scenario: { a: "@window show\n一。\n@choice\n- 甲 -> #a\n@end\n# a\n終わり。\n" },
      config: { ui: { sound: { ui: SOUNDS }, settings: { samples: { se: "sample/se.ogg", voice: "sample/voice.ogg" } } } },
    });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("画面の開閉、タブ、マウスオーバー、閉じるボタン、Esc、選択肢で鳴らし、押した音と開閉の音は重ねない。音量の欄を動かし終えたら試聴を鳴らす", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await p.evaluate(() => {
        const w = window as unknown as { __played: string[]; __liminalia: { host: { audio: Record<string, unknown> } } };
        w.__played = [];
        const audio = w.__liminalia.host.audio;
        audio.playSe = async (_channel: string, file: string) => void w.__played.push(file);
        audio.playSample = async (kind: string, file: string) => void w.__played.push(`sample:${kind}:${file}`);
      });
      // 右クリックでメニューを開き、Esc で閉じる（戻る操作の音のあとの閉じる音は鳴らさない）
      await p.mouse.click(640, 300, { button: "right" });
      await p.waitForTimeout(200);
      expect(await take(p), name).toEqual(["open"]);
      await p.keyboard.press("Escape");
      await p.waitForTimeout(200);
      expect(await take(p), name).toEqual(["cancel"]);
      // コンフィグ: タブを替える、ボタンにマウスを乗せる、閉じるボタン
      await p.evaluate('void window.__liminalia.system.perform("config")');
      await p.waitForTimeout(200);
      expect(await take(p), name).toEqual(["open"]);
      const sound = p.locator(".lm-config .lm-tab", { hasText: "サウンド" });
      await sound.hover();
      await p.waitForTimeout(100);
      await sound.click();
      await p.waitForTimeout(100);
      expect(await take(p), name).toEqual(["hover", "page"]);
      // 効果音とボイスの音量を動かし終えたら試聴（BGM は決めていないので鳴らさない）
      await p.evaluate(() => {
        for (const input of document.querySelectorAll<HTMLInputElement>(".lm-config input[type=range]")) {
          input.value = String(Number(input.value) - 10);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
      await p.waitForTimeout(100);
      expect(await take(p), name).toEqual(["sample:se:sample/se.ogg", "sample:se:sample/se.ogg", "sample:voice:sample/voice.ogg"]);
      await p.locator(".lm-config .lm-close").click();
      await p.waitForTimeout(200);
      expect((await take(p)).filter((k) => k !== "hover"), name).toEqual(["cancel"]);
      // 選択肢を選ぶ
      await p.evaluate("window.__liminalia.host.advance()");
      await p.waitForSelector(".choices button");
      await p.locator(".choices button").first().click();
      await p.waitForTimeout(200);
      expect((await take(p)).filter((k) => k !== "hover"), name).toEqual(["choice"]);
      await p.close();
    }
  });
});
