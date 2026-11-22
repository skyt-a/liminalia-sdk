import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e } from "../../web/test/e2e/harness.ts";

const scenario = `@bg hill_dusk.webp
@chara アカリ solo normal at=left time=300ms
本文です。
@wait 1s
@scene-change time=0ms hold=0ms hide-window=true
@wait 1s
次の本文です。
`;

const controlsPlugin = `import { defineWebPlugin } from "@liminalia/web";
export default defineWebPlugin({ name: "preview-controls",
  screens: { menuBar: () => { const bar = document.createElement("div"); bar.id = "test-menu-bar"; bar.textContent = "操作"; return bar; } },
  ready: ({ system }) => {
    const button = document.createElement("button"); button.id = "test-records"; button.textContent = "境界記録"; document.body.append(button);
    const update = (s) => { button.hidden = !s.menuBar; };
    system.onStatusChange(update); update(system.status);
  },
});`;

describe.skipIf(!e2e)("カーソル行のコマンド編集", { timeout: 180_000 }, () => {
  let dir: string;
  let server: ChildProcess;
  let url: string;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    dir = mkdtempSync(join(tmpdir(), "liminalia-inspector-"));
    cpSync(resolve(import.meta.dirname, "../../../templates/default"), dir, { recursive: true });
    writeFileSync(join(dir, "scenario/start.lim"), scenario);
    const plugin = join(dir, "plugins/preview-controls");
    mkdirSync(join(plugin, "src"), { recursive: true });
    writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "preview-controls", version: "0.0.0", type: "module", exports: { "./web": "./src/web.ts" } }));
    writeFileSync(join(plugin, "src/web.ts"), controlsPlugin);
    const configPath = join(dir, "liminalia.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.plugins = ["./plugins/preview-controls"];
    writeFileSync(configPath, JSON.stringify(config));
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

  it("コマンド行でフォームを開き、別の行へ追従し、本文では閉じる", async () => {
    for (const { browser } of list) {
      const page: Page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.addInitScript(() => {
        localStorage.setItem("liminalia.studio.tourDone", "1");
        localStorage.setItem("liminalia.studio.blocks", "0");
      });
      await page.goto(url);
      await page.waitForSelector(".cm-content", { state: "attached" });
      await page.waitForFunction(() => !!(window as any).__liminaliaStudioApp?.debug?.editor);
      const goto = (line: number) => page.evaluate((n) => (window as any).__liminaliaStudioApp.debug.editor.gotoLine(n), line);
      await goto(2);
      await expect.poll(() => page.locator(".inspector:not([hidden]) header .muted").textContent()).toBe("@chara");
      const solo = page.locator(".inspector .field", { has: page.locator(".field-name", { hasText: /^solo/ }) }).locator('input[type="checkbox"]');
      expect(await solo.isChecked()).toBe(true);
      const time = page.locator(".inspector .field", { has: page.locator(".field-name", { hasText: /^time/ }) }).locator("input");
      await time.fill("600");
      await time.dispatchEvent("change");
      await expect.poll(() => page.evaluate(() => (window as any).__liminaliaStudioApp.debug.editor.text())).toContain("time=600ms");
      await goto(4);
      await expect.poll(() => page.locator(".inspector:not([hidden]) header .muted").textContent()).toBe("@wait");
      await goto(3);
      await expect.poll(() => page.locator(".inspector:not([hidden])").count()).toBe(0);
      await goto(1);
      await expect.poll(() => page.locator(".inspector:not([hidden]) header .muted").textContent()).toBe("@bg");
      await page.close();
    }
  });

  it("素材の欄から選んだ素材をフォルダで表示でき、無い素材では操作できない", async () => {
    for (const { browser } of list) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.addInitScript(() => { localStorage.setItem("liminalia.studio.tourDone", "1"); localStorage.setItem("liminalia.studio.blocks", "0"); });
      const calls: unknown[] = [];
      await page.route("**/__liminalia/studio/api/assets/reveal-file", async (route) => {
        calls.push(route.request().postDataJSON());
        await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
      });
      await page.goto(url);
      await page.waitForFunction(() => !!(window as any).__liminaliaStudioApp?.debug?.editor);
      await expect.poll(() => page.evaluate(() => (window as any).__liminaliaStudioApp.debug.editor.text())).toContain("@bg hill_dusk.webp");
      await page.evaluate(() => (window as any).__liminaliaStudioApp.debug.editor.gotoLine(2));
      await expect.poll(() => page.locator(".inspector:not([hidden]) header .muted").textContent()).toBe("@chara");
      await page.evaluate(() => (window as any).__liminaliaStudioApp.debug.editor.gotoLine(1));
      await expect.poll(() => page.locator(".inspector:not([hidden]) header .muted").textContent()).toBe("@bg");
      const field = page.locator(".inspector:not([hidden]) .field", { has: page.locator(".field-name", { hasText: /^image/ }) });
      const reveal = field.locator(".asset-reveal");
      await expect.poll(() => reveal.isEnabled()).toBe(true);
      await reveal.click();
      expect(calls).toEqual([{ kind: "bgimage", path: "hill_dusk.webp" }]);
      await field.locator('input[type="text"]').fill("missing.webp");
      expect(await reveal.isDisabled()).toBe(true);
      await page.close();
    }
  });

  it("省略形、名前付き引数の値、位置引数にホバーするとそれぞれの説明を出す", async () => {
    for (const { browser } of list) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.addInitScript(() => {
        localStorage.setItem("liminalia.studio.tourDone", "1");
        localStorage.setItem("liminalia.studio.blocks", "0");
      });
      await page.goto(url);
      await page.waitForSelector(".cm-content", { state: "attached" });
      await page.waitForFunction(() => !!(window as any).__liminaliaStudioApp?.debug?.editor);
      await page.evaluate((source) => (window as any).__liminaliaStudioApp.debug.editor.replaceAll(source), scenario);
      await page.evaluate(() => (window as any).__liminaliaStudioApp.debug.editor.gotoLine(2));
      const hoverWord = async (word: string) => {
        await page.mouse.move(10, 10);
        const rect = await page.evaluate((needle) => {
          const ed = (window as any).__liminaliaStudioApp.debug.editor;
          const line = ed.state.doc.line(2);
          const index = line.text.indexOf(needle);
          return ed.view.coordsAtPos(line.from + index + Math.floor(needle.length / 2));
        }, word);
        if (!rect) throw new Error(`座標が見つかりません: ${word}`);
        await page.mouse.move(rect.left + 1, (rect.top + rect.bottom) / 2);
      };
      for (const [word, expected] of [["solo", "solo:"], ["left", "at:"], ["normal", "variant:"]] as const) {
        await hoverWord(word);
        await expect.poll(() => page.locator(".cm-tooltip-hover .lim-doc").allTextContents(), { timeout: 5000 }).toEqual(expect.arrayContaining([expect.stringContaining(expected)]));
      }
      await page.close();
    }
  });

  it("入力中は別の行の説明を閉じ、同じ行の説明は維持する", async () => {
    for (const { browser } of list) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.addInitScript(() => {
        localStorage.setItem("liminalia.studio.tourDone", "1");
        localStorage.setItem("liminalia.studio.blocks", "0");
      });
      await page.goto(url);
      await page.waitForSelector(".cm-content", { state: "attached" });
      await page.waitForFunction(() => !!(window as any).__liminaliaStudioApp?.debug?.editor);
      await page.evaluate((source) => (window as any).__liminaliaStudioApp.debug.editor.replaceAll(source), scenario);
      const goto = (line: number) => page.evaluate((n) => (window as any).__liminaliaStudioApp.debug.editor.gotoLine(n), line);
      const hoverSolo = async () => {
        await page.mouse.move(10, 10);
        const rect = await page.evaluate(() => {
          const ed = (window as any).__liminaliaStudioApp.debug.editor;
          const row = ed.state.doc.line(2);
          return ed.view.coordsAtPos(row.from + row.text.indexOf("solo") + 2);
        });
        if (!rect) throw new Error("solo の座標が見つかりません");
        await page.mouse.move(rect.left + 1, (rect.top + rect.bottom) / 2);
      };
      const tooltip = page.locator(".cm-tooltip-hover .lim-doc");
      // 前の復元・保存処理による入力扱いが落ち着いてから、別行のホバーを始める。
      await page.waitForTimeout(1100);
      await goto(3);
      await hoverSolo();
      await expect.poll(() => tooltip.count()).toBe(1);
      await page.keyboard.type("あ");
      await expect.poll(() => tooltip.count()).toBe(0);
      await goto(2);
      await page.keyboard.press("End");
      await hoverSolo();
      await expect.poll(() => tooltip.count()).toBe(1);
      await page.keyboard.type(" ");
      await expect.poll(() => tooltip.count()).toBe(1);
      await page.close();
    }
  });

  it("命令行の静止プレビューでも、隠した枠に連動して操作帯と境界記録を隠す", async () => {
    for (const { browser } of list) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.addInitScript(() => {
        localStorage.setItem("liminalia.studio.tourDone", "1");
        localStorage.setItem("liminalia.studio.blocks", "0");
      });
      await page.goto(url);
      await page.waitForSelector(".cm-content", { state: "attached" });
      await page.waitForFunction(() => !!(window as any).__liminaliaStudioApp?.debug?.editor);
      await page.evaluate((source) => (window as any).__liminaliaStudioApp.debug.editor.replaceAll(source), scenario);
      const goto = (line: number) => page.evaluate((n) => (window as any).__liminaliaStudioApp.debug.editor.gotoLine(n), line);
      const stage = page.frameLocator(".stage-frame");
      await goto(3);
      await expect.poll(() => stage.locator("#test-menu-bar").isVisible(), { timeout: 20_000 }).toBe(true);
      await expect.poll(() => stage.locator("#test-records").isVisible()).toBe(true);
      await goto(5);
      await expect.poll(() => stage.locator(".message.bg-hidden").count(), { timeout: 20_000 }).toBe(1);
      await expect.poll(() => stage.locator("#test-menu-bar").isVisible()).toBe(false);
      await expect.poll(() => stage.locator("#test-records").isVisible()).toBe(false);
      await goto(7);
      await expect.poll(() => stage.locator("#test-menu-bar").isVisible(), { timeout: 20_000 }).toBe(true);
      await expect.poll(() => stage.locator("#test-records").isVisible()).toBe(true);
      await page.close();
    }
  });

  it("畳んだ命令を本文の行の札から開いたフォームは、書き換えても閉じずに続けて直せ、カーソルがほかの行へ動くと追従する", async () => {
    for (const { browser, name } of list) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.addInitScript(() => {
        localStorage.setItem("liminalia.studio.tourDone", "1");
        localStorage.setItem("liminalia.studio.blocks", "0");
        localStorage.setItem("liminalia.studio.fold", "1");
      });
      await page.goto(url);
      await page.waitForSelector(".cm-content", { state: "attached" });
      await page.waitForFunction(() => !!(window as any).__liminaliaStudioApp?.debug?.editor);
      // 札の行のすぐ下は、札の無い本文の行にする
      await page.evaluate((source) => (window as any).__liminaliaStudioApp.debug.editor.replaceAll(source), "@bg hill_dusk.webp\n@chara アカリ solo normal at=left time=300ms\n本文です。\n二行目の本文。\n@wait 1s\n三行目の本文。\n");
      const goto = (line: number) => page.evaluate((n) => (window as any).__liminaliaStudioApp.debug.editor.gotoLine(n), line);
      const line = (n: number) => page.evaluate((k) => (window as any).__liminaliaStudioApp.debug.editor.state.doc.line(k).text as string, n);
      const header = () => page.locator(".inspector:not([hidden]) header .muted").textContent();
      // カーソルは本文の行。その行の札（畳んだ 2 行目の @chara）からフォームを開く
      await goto(3);
      await page.locator(".cm-line", { hasText: "本文です。" }).locator(".lim-chip-ch").click();
      await expect.poll(header).toBe("@chara");
      const time = page.locator(".inspector .field", { has: page.locator(".field-name", { hasText: /^time/ }) }).locator("input");
      await time.fill("600");
      await time.dispatchEvent("change");
      await expect.poll(() => line(2)).toContain("time=600ms");
      // 書き換えても、カーソルの行（本文）に合わせて閉じない
      await page.waitForTimeout(300);
      expect(await page.locator(".inspector:not([hidden]) header .muted").allTextContents(), name).toEqual(["@chara"]);
      await time.fill("0");
      await time.dispatchEvent("change");
      // 既定値と同じ値は書かない
      await expect.poll(() => line(2)).not.toContain("time=");
      // カーソルがほかの行へ動いたら、その行に合わせる
      await goto(5);
      await expect.poll(header).toBe("@wait");
      // カーソルの行の命令は、その行の札から開いても、本文に書き換えれば閉じる
      await page.locator(".cm-line", { hasText: "@wait 1s" }).locator(".lim-chip").click();
      await expect.poll(header).toBe("@wait");
      await page.evaluate(() => {
        const ed = (window as any).__liminaliaStudioApp.debug.editor;
        const row = ed.state.doc.line(5);
        ed.view.dispatch({ changes: { from: row.from, to: row.to, insert: "　本文に書き換えた。" } });
      });
      await expect.poll(() => line(5)).toBe("　本文に書き換えた。");
      await expect.poll(() => page.locator(".inspector:not([hidden])").count()).toBe(0);
      await goto(6);
      await expect.poll(() => page.locator(".inspector:not([hidden])").count()).toBe(0);
      await page.close();
    }
  });
});
