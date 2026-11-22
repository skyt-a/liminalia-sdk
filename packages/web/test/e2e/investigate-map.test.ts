import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { mapPanelRect } from "../../../std/src/commands/data-check.ts";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/**
 * @investigate の視点の顔の札・初めて入る視点の場面・二度目の場所（temp.first_visit）・扉の題・調べ足りないまま終える道と、
 * 地図で行き先を選ぶ @map-choice（説明の欄と決定の確認）を、実際のブラウザで確かめる。セーブとロードで同じ画面に戻ることも。
 */

const SCENARIO = `@bg hill_night.webp
はじまり。
@investigate room
@stop
# desk
@if temp.first_visit
初めての机。
@else
また机。
@end
# yuika_in
ユイカの目に替わった。
# bed
寝台だ。
# giveup
あきらめた。
@map-choice town result=temp.where
地図のあと。
@stop
# station
駅に着いた。
@stop
`;

const DATA = {
  places: {
    room: {
      title: "部屋",
      opening: "はじめの部屋",
      file: "a",
      finish: "button",
      incomplete: "#giveup",
      hitScale: 0.8,
      views: [
        { id: "haru", label: "ハル", face: "face.png", background: "hill_dusk.webp", spots: [{ id: "desk", label: "机", rect: { x: 100, y: 200, width: 300, height: 300 }, target: "#desk" }] },
        { id: "yuika", label: "ユイカ", background: "hill_morning.webp", enter: "#yuika_in", spots: [{ id: "bed", label: "寝台", rect: { x: 700, y: 200, width: 300, height: 300 }, target: "#bed" }] },
      ],
    },
  },
  maps: {
    town: {
      title: "行き先",
      prompt: "どこへ行く？",
      file: "a",
      background: "hill_dusk.webp",
      spots: [
        { id: "station", label: "駅", rect: { x: 100, y: 300, width: 120, height: 60 }, target: "#station", desc: "人が多い。", image: "face.png" },
        { id: "park", label: "公園", rect: { x: 400, y: 300, width: 120, height: 60 }, desc: "閉まっている。", locked: "!game.key" },
      ],
    },
  },
};

const FIXTURES = resolve(import.meta.dirname, "fixtures");
const SHOTS = process.env.LIMINALIA_E2E_SHOTS ?? "/tmp";

describe.skipIf(!e2e)("調べる場所の視点と地図の選択（ブラウザ）", { timeout: 240_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({
      scenario: { a: SCENARIO },
      config: { entry: "a" },
      files: { "assets/image/face.png": join(FIXTURES, "layer-top.png") },
      before: (dir) => {
        mkdirSync(join(dir, "data"), { recursive: true });
        writeFileSync(join(dir, "data", "investigation.json"), JSON.stringify(DATA));
      },
    });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  const text = (p: Page) => p.evaluate(() => document.querySelector(".message .text")?.textContent ?? "");
  const advance = async (p: Page, until: string) => {
    for (let i = 0; i < 20 && !(await text(p)).includes(until); i++) {
      await p.mouse.click(640, 650);
      await p.waitForTimeout(250);
    }
    expect(await text(p)).toContain(until);
  };
  const until = async (p: Page, selector: string) => {
    for (let i = 0; i < 20 && (await p.locator(selector).count()) === 0; i++) {
      await p.mouse.click(640, 650);
      await p.waitForTimeout(300);
    }
    await p.waitForSelector(selector, { timeout: 20_000 });
  };

  it("扉の題、顔の札、二度目の場所、初めて入る視点、セーブとロード、調べ足りないまま終える、地図で選ぶ", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await advance(p, "はじまり");
      await until(p, ".lm-investigate-opening");
      expect(await p.locator(".lm-investigate-opening-title").textContent(), name).toBe("はじめの部屋");
      await p.screenshot({ path: join(SHOTS, `investigate-opening-${name}.png`) }).catch(() => undefined);
      // 押すとすぐ消える
      await p.locator(".lm-investigate-opening").click();
      await p.waitForFunction(() => !document.querySelector(".lm-investigate-opening"));
      expect(await p.locator('.lm-investigate-view[data-view="haru"] .lm-investigate-face').count(), name).toBe(1);
      await p.screenshot({ path: join(SHOTS, `investigate-face-${name}.png`) }).catch(() => undefined);
      // 調べ足りないまま終える道があるので、「調べ終える」は押せる
      expect(await p.locator(".lm-investigate-finish").isDisabled(), name).toBe(false);
      // 当たり判定を縮める（300px の 0.8 倍）
      const box = await p.locator('.lm-investigate-spot[data-spot="desk"]').boundingBox();
      expect(Math.round(box!.width), name).toBe(240);
      await p.locator('.lm-investigate-spot[data-spot="desk"]').click();
      await advance(p, "初めての机");
      await until(p, '.lm-investigate-spot[data-spot="desk"][data-done="true"]');
      // 場面から戻ったときは扉の題を出さない
      expect(await p.locator(".lm-investigate-opening").count(), name).toBe(0);
      await p.locator('.lm-investigate-spot[data-spot="desk"]').click();
      await advance(p, "また机");
      await until(p, ".lm-investigate-spot");
      // 初めて入る視点: 場面を読んで、その視点で戻る
      await p.locator('.lm-investigate-view[data-view="yuika"]').click();
      await advance(p, "ユイカの目に替わった");
      await until(p, '.lm-investigate-spot[data-spot="bed"]');
      expect(await p.locator('.lm-investigate-view[data-view="yuika"]').getAttribute("aria-pressed"), name).toBe("true");
      // 調べる画面を出したままセーブして、ロードすると同じ視点の画面に戻る（扉の題は出さない）
      expect(await p.evaluate("window.__liminalia.system.saveTo(1)"), name).toBe(true);
      await p.evaluate("window.__liminalia.system.loadFrom(1)");
      await p.waitForSelector('.lm-investigate-spot[data-spot="bed"]', { timeout: 20_000 });
      expect(await p.locator(".lm-investigate-opening").count(), name).toBe(0);
      expect(await p.locator('.lm-investigate-view[data-view="yuika"]').getAttribute("aria-pressed"), name).toBe("true");
      // 調べ足りないまま終える: 調べていない場所が残っているので確かめる。いいえなら調べる画面のまま
      await p.locator(".lm-investigate-finish").click();
      await p.waitForSelector("[data-lm-screen='confirm']", { timeout: 5000 });
      expect(await p.locator("[data-lm-screen='confirm']").textContent(), name).toContain("まだ調べていない場所があります");
      await p.keyboard.press("Escape");
      await p.waitForSelector("[data-lm-screen='confirm']", { state: "detached", timeout: 5000 });
      expect(await p.locator('.lm-investigate-spot[data-spot="bed"]').count(), name).toBe(1);
      await p.locator(".lm-investigate-finish").click();
      await p.locator("[data-lm-screen='confirm'] .lm-primary").click();
      await advance(p, "あきらめた");
      // 地図で選ぶ: 最初の押せる地点の説明が出ている
      await until(p, ".lm-map-choice");
      expect(await p.locator(".lm-map-choice-title").textContent(), name).toBe("行き先");
      expect(await p.locator(".lm-map-choice-name").textContent(), name).toBe("駅");
      expect(await p.locator(".lm-map-choice-image").count(), name).toBe(1);
      // 説明の欄の「ここに決める」は欄の中に見えている
      expect(await p.locator(".lm-map-choice-go").isVisible(), name).toBe(true);
      // 説明の欄の範囲は、構文チェック（map-spot-hidden）が見る範囲と同じ（舞台の px）
      const panel = (await p.evaluate(`(() => {
        const stage = document.querySelector(".stage").getBoundingClientRect();
        const r = document.querySelector(".lm-map-choice-panel").getBoundingClientRect();
        const k = 1280 / stage.width;
        return { x: (r.left - stage.left) * k, y: (r.top - stage.top) * k, width: r.width * k, height: r.height * k };
      })()`)) as { x: number; y: number; width: number; height: number };
      const want = mapPanelRect(undefined, { width: 1280, height: 720 });
      for (const k of ["x", "y", "width", "height"] as const) expect(Math.abs(panel[k] - want[k]), `${name} ${k} ${panel[k]} ${want[k]}`).toBeLessThan(2);
      await p.screenshot({ path: join(SHOTS, `map-choice-${name}.png`) }).catch(() => undefined);
      // 押せない地点を選ぶと、決めるボタンは押せない
      await p.locator('.lm-map-choice-spot[data-spot="park"]').click({ force: true });
      expect(await p.locator(".lm-map-choice-name").textContent(), name).toBe("公園");
      expect(await p.locator(".lm-map-choice-go").isDisabled(), name).toBe(true);
      // 地図を出したままセーブしてロードすると、地図に戻る
      await p.evaluate("window.__liminalia.system.saveTo(2)");
      await p.evaluate("window.__liminalia.system.loadFrom(2)");
      await p.waitForSelector('.lm-map-choice-spot[data-spot="station"]', { timeout: 20_000 });
      await p.locator('.lm-map-choice-spot[data-spot="station"]').click();
      await p.locator(".lm-map-choice-go").click();
      await advance(p, "駅に着いた");
      expect(await p.evaluate("window.__liminalia.runtime().state.temp.where"), name).toBe("station");
      await p.close();
    }
  });
});
