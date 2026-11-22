import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 図鑑の相関図と地図の重なり。同じ二人の行きと帰りの線（A から B、B から A）は重ねずにずらし、関係の文字も重ならない。
 * 「新」の印は名前の外に置き、名前の字を隠さない。要素の箱が重ならないかで確かめる。
 */

const SCENARIO = `@window show
はじまり。
@codex
おわり。
@stop
`;

const CODEX = {
  categories: [
    { id: "people", label: "相関図", type: "relations" },
    { id: "town", label: "地図", type: "map" },
  ],
  entries: [
    { id: "haru", category: "people", title: "ハルカゼ", x: 25, y: 50, if: "true", links: [{ to: "yuika", label: "知り合い", tone: "positive" }] },
    { id: "yuika", category: "people", title: "ユイカ", x: 75, y: 50, if: "true", links: [{ to: "haru", label: "対立", tone: "negative" }] },
    { id: "station", category: "town", title: "駅前広場", x: 40, y: 30, if: "true" },
  ],
};

type Rect = { x: number; y: number; width: number; height: number };
const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
const rects = (p: Page, selector: string) =>
  p.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })`) as Promise<Rect[]>;

describe.skipIf(!e2e)("図鑑の相関図と地図の重なり（ブラウザ）", { timeout: 240_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({
      scenario: { a: SCENARIO },
      config: { entry: "a" },
      before: (dir) => {
        mkdirSync(join(dir, "data"), { recursive: true });
        writeFileSync(join(dir, "data", "codex.json"), JSON.stringify(CODEX));
      },
    });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("行きと帰りの線と関係の文字は重ならず、「新」の印は名前を隠さない", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForFunction(`window.__liminalia?.host.waiting === true && document.querySelector(".message .text")?.textContent.includes("はじまり")`, null, { timeout: 60_000 });
      await p.evaluate("window.__liminalia.host.advance()");
      await p.waitForSelector(".lm-codex-node", { timeout: 60_000 });
      await p.evaluate("document.fonts.ready.then(() => undefined)");
      // 二本の線は別の道を通る（同じ所に重ねない）
      expect(await p.locator(".lm-codex-line").count(), name).toBe(2);
      const paths = (await p.evaluate(`[...document.querySelectorAll(".lm-codex-line")].map((l) => { const r = l.getBoundingClientRect(); return [l.dataset.link, Math.round(r.top + r.height / 2)]; })`)) as [string, number][];
      expect(new Set(paths.map((x) => x[1])).size, `${name} ${JSON.stringify(paths)}`).toBe(2);
      // 関係の文字は二つとも読める（重ならない）
      const labels = await rects(p, ".lm-codex-line-label");
      expect(labels.length, name).toBe(2);
      expect(overlap(labels[0]!, labels[1]!), name).toBe(0);
      // 「新」の印は名前の字に掛からない（相関図と地図）
      for (const id of ["haru", "yuika"]) {
        const [title] = await rects(p, `.lm-codex-node[data-entry="${id}"] .lm-codex-node-title`);
        const [fresh] = await rects(p, `.lm-codex-node[data-entry="${id}"] .lm-codex-fresh`);
        expect(fresh, `${name} ${id}`).toBeDefined();
        expect(overlap(title!, fresh!), `${name} ${id}`).toBe(0);
      }
      await p.locator('.lm-tab[data-category="town"]').click();
      const [title] = await rects(p, '.lm-codex-marker[data-entry="station"] .lm-codex-node-title');
      const [fresh] = await rects(p, '.lm-codex-marker[data-entry="station"] .lm-codex-fresh');
      expect(overlap(title!, fresh!), name).toBe(0);
      await p.close();
    }
  });
});
