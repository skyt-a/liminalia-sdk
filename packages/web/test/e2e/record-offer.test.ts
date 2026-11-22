import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/**
 * 録画（lim shot --video）が読む「選べるもの」（RenderContext.offer、host.offered と host.chooseOffered）を、実際のブラウザで確かめる。
 * 文字の入力と確かめの枠は進めるだけ、調べる画面と地図とふつうの選択肢は、文と飛び先を知らせ、選んだもので進む。
 */

const SCENARIO = `@bg hill_night.webp
はじまり。
@text-input game.name initial="ユイ"
@dialog "確かめます"
@investigate room
@map-choice town result=temp.where
行き先は{= temp.where}。
@choice
- 一つ目 -> #one
- 二つ目 -> #two
@end
# desk
机を調べた。
# one
一つ目だ。
@stop
# two
二つ目だ。
@stop
`;

const DATA = {
  places: { room: { file: "a", views: [{ id: "v", label: "部屋", background: "hill_dusk.webp", spots: [{ id: "desk", label: "机", rect: { x: 500, y: 300, width: 200, height: 160 }, target: "#desk" }] }] } },
  maps: {
    town: {
      background: "hill_dusk.webp",
      spots: [
        { id: "north", label: "北の丘", rect: { x: 300, y: 200, width: 140, height: 60 } },
        { id: "south", label: "南の町", rect: { x: 700, y: 400, width: 140, height: 60 } },
        { id: "east", label: "東の港", rect: { x: 900, y: 200, width: 140, height: 60 }, locked: "true" },
      ],
    },
  },
};

interface Offered {
  id: number;
  options: (string | null)[];
  targets: (string | null)[] | null;
  proceed: number | null;
}

describe.skipIf(!e2e)("録画が読む選べるもの（ブラウザ）", { timeout: 240_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({
      scenario: { a: SCENARIO },
      config: { entry: "a" },
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
  const offered = (p: Page) => p.evaluate(() => window.__liminalia!.host.offered()) as Promise<Offered | null>;
  /** 知らせが出るまで待つ（クリック待ちなら送る）。 */
  const next = async (p: Page): Promise<Offered> => {
    for (let i = 0; i < 40; i++) {
      const o = await offered(p);
      if (o) return o;
      if (await p.evaluate(() => window.__liminalia!.host.waiting)) await p.evaluate(() => window.__liminalia!.host.advance());
      await p.waitForTimeout(150);
    }
    throw new Error("選べるものが知らされません");
  };
  const choose = (p: Page, o: Offered, i: number) => p.evaluate(([id, index]) => window.__liminalia!.host.chooseOffered(id, index), [o.id, i] as const);
  const until = async (p: Page, want: string) => {
    for (let i = 0; i < 40 && !(await text(p)).includes(want); i++) {
      if (await p.evaluate(() => window.__liminalia!.host.waiting)) await p.evaluate(() => window.__liminalia!.host.advance());
      await p.waitForTimeout(150);
    }
    expect(await text(p)).toContain(want);
  };

  it("文字の入力、確かめの枠、調べる画面、地図、選択肢を、知らせたもので進める", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await until(p, "はじまり");
      // 本文を読んでいる間は何も知らせない
      expect(await offered(p), name).toBeNull();
      const input = await next(p);
      expect(input, name).toMatchObject({ options: ["OK"], proceed: 0 });
      expect(await p.locator(".lm-panel input").inputValue(), name).toBe("ユイ");
      expect(await choose(p, input, 0), name).toBe(true);
      const dialog = await next(p);
      expect(dialog.id, name).not.toBe(input.id);
      expect(dialog.proceed, name).toBe(0);
      expect(await choose(p, dialog, 0), name).toBe(true);
      // 調べる画面: 場所の一覧と飛び先。選ぶと、その場所の説明を見せてから押す
      const room = await next(p);
      expect(room, name).toMatchObject({ options: ["机"], targets: ["a#desk"], proceed: null });
      await p.waitForSelector(".lm-investigate-spot");
      expect(await choose(p, room, 0), name).toBe(true);
      await p.waitForSelector(".lm-investigate-tip:not([hidden])", { timeout: 5_000 });
      await until(p, "机を調べた");
      // 地図: 押せない地点は null。選ぶと説明の欄に出してから決める
      const town = await next(p);
      expect(town, name).toMatchObject({ options: ["北の丘", "南の町", null], proceed: null });
      expect(await choose(p, town, 2), name).toBe(false);
      expect(await choose(p, town, 1), name).toBe(true);
      await p.waitForFunction(() => document.querySelector(".lm-map-choice-name")?.textContent === "南の町", null, { timeout: 5_000 });
      await until(p, "行き先はsouth");
      // ふつうの選択肢: 文と飛び先
      const choice = await next(p);
      expect(choice, name).toMatchObject({ options: ["一つ目", "二つ目"], targets: ["a#one", "a#two"] });
      // 古い番号では選べない
      expect(await choose(p, town, 0), name).toBe(false);
      expect(await choose(p, choice, 1), name).toBe(true);
      await until(p, "二つ目だ");
      expect(await offered(p), name).toBeNull();
      await p.close();
    }
  });
});
