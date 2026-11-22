import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e } from "../../web/test/e2e/harness.ts";

/**
 * ブロック表示の札のつまみ（blocks.ts の grip と pressGrip）を、lim studio を立ててブラウザで確かめる。
 * 同じ段に並んだ札のつまみは、左の札の×（札の右へはみ出す 24px の押せる所）の下に隠れ、真ん中を押すと左の札が消えていた。
 * - 札のつまみは、どれも真ん中で自分のつまみに当たる（左の札の×に取られない）
 * - つまみを押しただけでは台本は変わらない
 * - つまみの真ん中から引いて同じ段の前の札と入れ替え、⌘Z で戻す。左の札を選んで×が出ているときも同じ
 * - 選んだ左の札の×は、真ん中で押せる（右の札のつまみに取られない）
 * - ×の押せる所（24px の四角）の四隅とつまみの真ん中は、どれも自分に当たる（×とつまみ、×と上の段の札が重ならない）。
 *   選んでいないとき、左の札を選んだとき、札が何段にも折り返すとき、文字を縮めたとき（⌘−、80%）に見る
 * Chrome が要るので、LIMINALIA_E2E_BROWSER=1 のときだけ動かす。
 */

/** 短い札が一つの段に並ぶ台本（2〜5 行が札、6 行が本文）と、何段にも折り返す札（7〜20 行、21 行が本文）。 */
const WRAP = ["@wait 1s", "@se chime.wav", "@bgm quiet_night.wav", "@wait 2s", "@se chime.wav volume=50", "@wait 3s", "@bg hill_dusk.webp", "@wait 4s", "@se chime.wav volume=60", "@wait 5s", "@stop-bgm", "@wait 6s", "@se chime.wav volume=70", "@wait 7s"];
const SCRIPT = `# start\n@bg hill_dusk.webp\n@bgm quiet_night.wav\n@wait 1s\n@se chime.wav\n　本文の一行。\n${WRAP.join("\n")}\n　二行目の本文。\n`;

/**
 * 札ごとに、×の押せる所（見えていなくても押せる。is-off は出さない）の四隅（1px 内側）とつまみの真ん中に当たる要素が自分か。
 * 当たらなかった所を「行:場所→当たった要素」で返す。
 */
const misses = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = [];
    const name = (e: Element | null) => (e instanceof HTMLElement || e instanceof SVGElement ? `${e.closest<HTMLElement>("[data-from]")?.dataset.from ?? "?"}:${e.getAttribute("class") ?? e.tagName}` : "なし");
    for (const row of document.querySelectorAll<HTMLElement>(".blk-cues > .blk-cue-row")) {
      const line = row.dataset.from;
      const del = row.querySelector<HTMLElement>(":scope > .blk-del:not(.is-off)");
      if (del) {
        const r = del.getBoundingClientRect();
        for (const [where, x, y] of [["×左上", r.left + 1, r.top + 1], ["×右上", r.right - 1, r.top + 1], ["×左下", r.left + 1, r.bottom - 1], ["×右下", r.right - 1, r.bottom - 1], ["×真ん中", r.left + r.width / 2, r.top + r.height / 2]] as const) {
          const hit = document.elementFromPoint(x, y);
          if (!hit || !del.contains(hit)) out.push(`${line}:${where}→${name(hit)}`);
        }
      }
      const grip = row.querySelector<HTMLElement>(":scope > .blk-grip");
      if (grip) {
        const r = grip.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (hit !== grip) out.push(`${line}:つまみ→${name(hit)}`);
      }
    }
    return out;
  });

describe.skipIf(!e2e)("ブロック表示の札のつまみ", { timeout: 180_000 }, () => {
  let dir: string, url: string, server: ChildProcess;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    dir = mkdtempSync(join(tmpdir(), "liminalia-blocks-grip-"));
    cpSync(resolve(import.meta.dirname, "../../../templates/default"), dir, { recursive: true });
    writeFileSync(join(dir, "scenario/start.lim"), SCRIPT);
    server = spawn(process.execPath, [resolve(import.meta.dirname, "../../cli/bin/lim.mjs"), "studio", dir, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LIMINALIA_EXIT_WITH_PARENT: "1" } });
    url = await new Promise<string>((done, reject) => {
      let output = "";
      server.stdout!.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const match = /Studio: (\S+)/.exec(output);
        if (match) done(match[1]!);
      });
      server.on("exit", (code) => reject(new Error(`lim studio exited: ${code}\n${output}`)));
    });
  }, 120_000);
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    server?.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const text = (page: Page) => page.evaluate(() => (window as any).__liminaliaStudioApp.debug.editor.text() as string);
  const row = (page: Page, line: number) => page.locator(`.blk-line-row[data-from="${line}"]`);
  const gripCenter = async (page: Page, line: number) => {
    const box = (await row(page, line).locator(":scope > .blk-grip").boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  /** line の札のつまみを真ん中でつかみ、target の札の左の端へ引いて離す。 */
  const drag = async (page: Page, line: number, target: number) => {
    const grip = await gripCenter(page, line);
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down();
    const box = (await row(page, target).boundingBox())!;
    await page.mouse.move(box.x + 6, box.y + box.height / 2, { steps: 8 });
    // 札は隙間が動くと滑ってよける。滑り終わってから、動いた札の左の端へ動かし直す
    await page.waitForTimeout(250);
    const now = (await row(page, target).boundingBox())!;
    await page.mouse.move(now.x + 4, now.y + now.height / 2);
    await page.mouse.move(now.x + 6, now.y + now.height / 2);
    await page.waitForTimeout(250);
    await page.mouse.up();
  };
  const undo = async (page: Page) => {
    await page.locator(".blk-list").focus();
    await page.keyboard.press("ControlOrMeta+z");
  };

  it("同じ段の札のつまみは真ん中で押せて、引くと前の札と入れ替わり、⌘Z で戻る", async () => {
    for (const { browser, name } of list) {
      const page = await browser.newPage({ locale: "ja-JP", viewport: { width: 1440, height: 900 } });
      await page.addInitScript(() => {
        localStorage.setItem("liminalia.studio.tourDone", "1");
        localStorage.setItem("liminalia.studio.blocks", "1");
      });
      await page.goto(url);
      await row(page, 5).waitFor();
      await page.waitForTimeout(500);
      const before = await text(page);

      // 2〜4 行の札は一つの段に並ぶ（つまみの左に前の札の×がある並び。5 行は、札の間を広げてから次の段に折り返すことがある）
      const tops = await Promise.all([2, 3, 4].map(async (l) => Math.round((await row(page, l).boundingBox())!.y)));
      expect(new Set(tops).size, `${name}: ${tops.join(",")}`).toBe(1);

      // どの札のつまみも、真ん中に当たるのは自分のつまみ
      const hits = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".blk-cue-row > .blk-grip")].map((g) => {
          const r = g.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          const owner = (g.parentElement as HTMLElement).dataset.from;
          return hit === g ? owner : `${owner}→${(hit as HTMLElement | null)?.className ?? "なし"}`;
        }),
      );
      expect(hits.slice(0, 4), name).toEqual(["2", "3", "4", "5"]);
      // ×の押せる所の四隅とつまみの真ん中は、どれも自分に当たる
      expect(await misses(page), name).toEqual([]);

      // つまみを押しただけでは、台本は変わらない（左の札を消さない）
      const g3 = await gripCenter(page, 3);
      await page.mouse.click(g3.x, g3.y);
      await page.waitForTimeout(300);
      expect(await text(page), name).toBe(before);

      // つまみの真ん中から引いて、BGM の札を背景の札の前へ
      await drag(page, 3, 2);
      await expect.poll(() => text(page).then((t) => t.split("\n").slice(1, 3))).toEqual(["@bgm quiet_night.wav", "@bg hill_dusk.webp"]);
      await undo(page);
      await expect.poll(() => text(page)).toBe(before);

      // 左の札（背景）を選んで×が出ていても、右の札のつまみで引ける
      await row(page, 2).locator(".blk-cue").click();
      await expect.poll(() => row(page, 2).evaluate((e) => e.classList.contains("on"))).toBe(true);
      expect(await misses(page), name).toEqual([]);
      await drag(page, 3, 2);
      await expect.poll(() => text(page).then((t) => t.split("\n").slice(1, 3))).toEqual(["@bgm quiet_night.wav", "@bg hill_dusk.webp"]);
      await undo(page);
      await expect.poll(() => text(page)).toBe(before);

      // 選んだ左の札の×は、右の札のつまみに取られず、真ん中で押せる
      await row(page, 2).locator(".blk-cue").click();
      await expect.poll(() => row(page, 2).evaluate((e) => e.classList.contains("on"))).toBe(true);
      const del = (await row(page, 2).locator(":scope > .blk-del").boundingBox())!;
      await page.mouse.click(del.x + del.width / 2, del.y + del.height / 2);
      await expect.poll(() => text(page).then((t) => t.split("\n")[1])).toBe("@bgm quiet_night.wav");
      await undo(page);
      await expect.poll(() => text(page)).toBe(before);
      await page.close();
    }
  });

  for (const zoom of ["1", "0.8"]) {
    it(`札が何段にも折り返しても（文字の大きさ ${Number(zoom) * 100}%）、×の押せる所とつまみが、ほかの札の×やつまみ、上の段の札に重ならない`, async () => {
      for (const { browser, name } of list) {
        const page = await browser.newPage({ locale: "ja-JP", viewport: { width: 1440, height: 900 } });
        await page.addInitScript((z) => {
          localStorage.setItem("liminalia.studio.tourDone", "1");
          localStorage.setItem("liminalia.studio.blocks", "1");
          localStorage.setItem("liminalia.studio.zoom", z);
        }, zoom);
        await page.goto(url);
        await row(page, 20).waitFor();
        await page.waitForTimeout(500);
        // 7〜20 行の札は二段以上に折り返す（素通りしないための前提）
        const tops = new Set(await Promise.all(WRAP.map(async (_, i) => Math.round((await row(page, 7 + i).boundingBox())!.y))));
        expect(tops.size, name).toBeGreaterThan(1);
        expect(await misses(page), name).toEqual([]);
        // 札を選んで×を出しても同じ（段の頭でない札と、下の段の札）
        for (const line of [9, 18]) {
          await row(page, line).locator(".blk-cue").click();
          await expect.poll(() => row(page, line).evaluate((e) => e.classList.contains("on"))).toBe(true);
          expect(await misses(page), `${name}: ${line} 行を選んだとき`).toEqual([]);
        }
        await page.close();
      }
    });
  }
});
