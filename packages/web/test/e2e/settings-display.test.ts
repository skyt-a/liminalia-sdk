import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/**
 * 設定画面の表示と音の項目（枠の濃さ・文字の大きさ・書体・演出を弱める・ボイスの間 BGM を下げる）が、
 * 舞台と音に効くかを実際のブラウザで確かめる。作品の初期値（ui.defaults）も効く。
 */

const SCENARIO = `@window show
{fx wave 波打つ}文字。
`;

describe.skipIf(!e2e)("設定の表示と音の項目（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({ scenario: { a: SCENARIO }, config: { ui: { defaults: { textScale: 120 } } } });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("枠の濃さ・文字の大きさ・書体・演出・BGM を下げる、が効く", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await p.waitForTimeout(500);
      const look = () =>
        p.evaluate(`(() => {
          const m = document.querySelector(".message");
          const cs = getComputedStyle(m);
          return {
            alpha: Number((/\\/\\s*([\\d.]+)\\)$/.exec(cs.backgroundColor) ?? /rgba\\([^)]*,\\s*([\\d.]+)\\)$/.exec(cs.backgroundColor) ?? [0, 1])[1]),
            size: parseFloat(cs.fontSize),
            gothic: getComputedStyle(document.querySelector(".message .text")).fontFamily.includes("Hiragino Sans"),
            wave: getComputedStyle(document.querySelector(".tfx")).animationName,
            duck: window.__liminalia.host.audio.duckLevel,
          };
        })()`) as Promise<{ alpha: number; size: number; gothic: boolean; wave: string; duck: number }>;
      const before = await look();
      // 作品の初期値の文字の大きさ 120%（既定 26px）
      expect([Math.round(before.size), before.gothic, before.wave, before.duck], name).toEqual([31, false, "lim-fx-wave", 0.4]);
      await p.evaluate(`window.__liminalia.system.updateSettings({ windowOpacity: 20, textScale: 100, font: "gothic", duckBgm: false })`);
      await p.waitForTimeout(200);
      const after = await look();
      expect([after.alpha < before.alpha * 0.3, Math.round(after.size), after.gothic, after.wave, after.duck], name).toEqual([true, 26, true, "lim-fx-wave", 1]);
      // 履歴の本文も、遊ぶ人が選んだ書体
      await p.evaluate(`void window.__liminalia.system.perform("backlog")`);
      await p.waitForSelector(".lm-backlog .lm-log-text");
      expect(await p.evaluate(`getComputedStyle(document.querySelector(".lm-backlog .lm-log-text")).fontFamily.includes("Hiragino Sans")`), name).toBe(true);
      await p.close();
    }
  });
});
