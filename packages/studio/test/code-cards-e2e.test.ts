import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e } from "../../web/test/e2e/harness.ts";

/**
 * コード表示で命令を畳んだとき、本文の行の右に出す札（editor/cards.ts）を、lim studio を立ててブラウザで確かめる。
 * 札の行の高さを札の数から見積もっていた（一段に札二つ）ので、台本の欄が狭く一段に一つしか並ばないと、札が次の行へはみ出し、
 * 次の行の札の欄の下に隠れて押せなかった。
 * - 札の欄は自分の行の中に収まる
 * - どの札も、真ん中と端（角丸の内側の上下の端と、左右の端。1px 内側）に当たるのは自分（ほかの行の札に覆われない）。
 *   コード表示の札には×とつまみが無いので、ブロック表示の札の×とつまみの当たり（blocks-grip-e2e.test.ts）と同じ趣旨で札の端を見る
 * - 隠れていた札（二つ目の札）を押すと、その命令のフォームが開く
 * 台本の欄が狭いとき（札の列が 9rem）と広いとき（12.5rem）の両方で見る。
 * Chrome が要るので、LIMINALIA_E2E_BROWSER=1 のときだけ動かす。
 */

/** 二つ、三つ、二つの命令を畳む本文の行が続く台本（札は 4、8、11 行に出る）。 */
const SCRIPT = [
  "# start",
  "@bg hill_dusk.webp",
  "@chara アカリ normal at=left",
  "　一行目の本文。",
  "@wait 1s",
  "@se chime.wav",
  "@chara アカリ smile",
  "　二行目の本文。",
  "@bgm quiet_night.wav",
  "@wait 500ms",
  "　三行目の本文。",
  "　四行目の本文。",
  "",
].join("\n");

describe.skipIf(!e2e)("コード表示の札", { timeout: 180_000 }, () => {
  let dir: string, url: string, server: ChildProcess;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    dir = mkdtempSync(join(tmpdir(), "liminalia-code-cards-"));
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

  /** 見えている札の欄ごとに、行に収まるか、どの札も真ん中で自分に当たるか。札の欄の幅も返す。 */
  const layout = (page: Page) =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".cm-content .lim-cards")].map((cards) => {
        const line = cards.closest<HTMLElement>(".cm-line")!;
        const box = cards.getBoundingClientRect();
        const row = line.getBoundingClientRect();
        const chips = [...cards.querySelectorAll<HTMLElement>(".lim-chip")].map((chip) => {
          const r = chip.getBoundingClientRect();
          // 真ん中、角丸の内側の上下の端、左右の端（札は高さの半分の角丸なので、四隅そのものは札の外）
          const round = Math.min(r.height / 2, r.width / 2);
          const points = [
            ["真ん中", r.left + r.width / 2, r.top + r.height / 2],
            ["左上", r.left + round, r.top + 1],
            ["右上", r.right - round, r.top + 1],
            ["左下", r.left + round, r.bottom - 1],
            ["右下", r.right - round, r.bottom - 1],
            ["左", r.left + 1, r.top + r.height / 2],
            ["右", r.right - 1, r.top + r.height / 2],
          ] as const;
          const missed = points.flatMap(([where, x, y]) => {
            const hit = document.elementFromPoint(x, y);
            return chip === hit || chip.contains(hit) ? [] : [`${where}→${(hit as HTMLElement | null)?.textContent ?? "なし"}`];
          });
          return missed.length === 0 ? "ok" : `${chip.textContent}: ${missed.join(", ")}`;
        });
        return { text: line.textContent!.replace(/.*　/, "　"), width: Math.round(box.width), inside: box.bottom <= row.bottom + 0.5, chips };
      }),
    );

  for (const [label, viewport, narrow] of [
    ["台本の欄が狭いとき", { width: 1440, height: 900 }, true],
    ["台本の欄が広いとき", { width: 2200, height: 900 }, false],
  ] as const) {
    it(`${label}も、札の欄は自分の行に収まり、どの札も押せる`, async () => {
      for (const { browser, name } of list) {
        const page = await browser.newPage({ locale: "ja-JP", viewport });
        await page.addInitScript(() => {
          localStorage.setItem("liminalia.studio.tourDone", "1");
          localStorage.setItem("liminalia.studio.blocks", "0");
          localStorage.setItem("liminalia.studio.fold", "1");
        });
        await page.goto(url);
        await page.waitForFunction(() => !!(window as any).__liminaliaStudioApp?.debug?.editor);
        // カーソルは札の無い最後の本文の行（札のまとまりに触れると畳みが開く）
        await page.evaluate(() => (window as any).__liminaliaStudioApp.debug.editor.gotoLine(12));
        await expect.poll(() => page.locator(".cm-content .lim-cards").count()).toBe(3);
        await page.evaluate("document.fonts.ready.then(() => undefined)");
        await page.waitForTimeout(300);
        const rows = await layout(page);
        const detail = `${name}: ${JSON.stringify(rows)}`;
        // 札の列の幅（9rem − 24px か 12.5rem − 24px）で、狭いときと広いときを見分ける
        expect(rows.every((r) => (narrow ? r.width < 130 : r.width > 140)), detail).toBe(true);
        expect(rows.map((r) => r.inside), detail).toEqual([true, true, true]);
        expect(rows.flatMap((r) => r.chips).filter((c) => c !== "ok"), detail).toEqual([]);
        // 一行目の本文の行の二つ目の札（2 行目の @chara の要約）を押すと、その命令のフォーム
        await page.locator(".cm-line", { hasText: "一行目の本文。" }).locator(".lim-chip-ch").click();
        await expect.poll(() => page.locator(".inspector:not([hidden]) header .muted").textContent()).toBe("@chara");
        await page.close();
      }
    });
  }
});
