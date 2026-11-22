import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Browser } from "playwright-core";
import { browsers, e2e } from "../../web/test/e2e/harness.ts";

const scenario = "ソウ「おはよう」\nアカリ「うん」\nソウ「次の話」\n地の文。\n";

describe.skipIf(!e2e)("会話の直後の話者補完", { timeout: 180_000 }, () => {
  let dir: string, url: string, server: ChildProcess;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    dir = mkdtempSync(join(tmpdir(), "liminalia-dialogue-completion-"));
    cpSync(resolve(import.meta.dirname, "../../../templates/default"), dir, { recursive: true });
    const castPath = join(dir, "cast.json");
    const cast = JSON.parse(readFileSync(castPath, "utf8"));
    cast.speakers.push("ア一", "ア二", "ア三", "ア四");
    writeFileSync(castPath, JSON.stringify(cast));
    writeFileSync(join(dir, "scenario/start.lim"), scenario);
    writeFileSync(join(dir, "scenario/ranking.lim"), `${"ア三「よく出る」\n".repeat(6)}${"ア四「ときどき」\n".repeat(3)}`);
    server = spawn(process.execPath, [resolve(import.meta.dirname, "../../cli/bin/lim.mjs"), "studio", dir, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LIMINALIA_EXIT_WITH_PARENT: "1" } });
    url = await new Promise<string>((done, reject) => {
      let output = "";
      server.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString(); const m = /Studio: (\S+)/.exec(output); if (m) done(m[1]!); });
      server.on("exit", (code) => reject(new Error(`lim studio exited: ${code}\n${output}`)));
    });
  }, 120_000);
  afterAll(async () => { for (const b of list ?? []) await b.browser.close(); server?.kill(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("改行後に直前の話者と相手を出し、Tab で括弧の中から書ける", async () => {
    for (const { browser, name } of list) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.addInitScript(() => { localStorage.setItem("liminalia.studio.tourDone", "1"); localStorage.setItem("liminalia.studio.blocks", "0"); });
      await page.goto(url);
      await page.waitForFunction(() => !!(window as any).__liminaliaStudioApp?.debug?.editor);
      await expect.poll(() => page.evaluate(() => (window as any).__liminaliaStudioApp.debug.editor.text())).toContain("アカリ「うん」");
      await page.evaluate(() => { const ed = (window as any).__liminaliaStudioApp.debug.editor; ed.view.focus(); ed.view.dispatch({ selection: { anchor: ed.state.doc.line(2).to } }); });
      await page.keyboard.press("Enter");
      const labels = () => page.locator(".cm-tooltip-autocomplete li .cm-completionLabel").allTextContents();
      await expect.poll(labels, { timeout: 5000 }).toEqual(["アカリ", "ソウ"]);
      await page.waitForTimeout(120);
      await page.keyboard.press("Tab");
      await expect.poll(() => page.locator(".cm-tooltip-autocomplete").count()).toBe(0);
      expect(await page.evaluate(() => { const ed = (window as any).__liminaliaStudioApp.debug.editor; return [ed.state.doc.line(3).text, ed.state.selection.main.head - ed.state.doc.line(3).from]; }), name).toEqual(["アカリ「」", 4]);
      await page.keyboard.insertText("続き");
      await page.keyboard.press("Enter");
      expect(await page.evaluate(() => (window as any).__liminaliaStudioApp.debug.editor.state.doc.line(3).text), name).toBe("アカリ「続き」");
      await expect.poll(labels, { timeout: 5000 }).toEqual(["アカリ", "ソウ"]);
      // CodeMirror は候補の表示直後、誤操作を避けるため短い入力猶予を設けている。
      await page.waitForTimeout(120);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => (window as any).__liminaliaStudioApp.debug.editor.state.doc.line(4).text), name).toBe("ソウ「」");
      await page.evaluate(() => (window as any).__liminaliaStudioApp.debug.editor.replaceAll("ソウ「おはよう」\nアカリ「うん」\nソウ「次の話」\n地の文。\n"));
      await page.close();
    }
  });

  it("地の文や命令には候補を出さず、候補を使わなければ改行だけにする", async () => {
    const page = await list[0]!.browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(() => { localStorage.setItem("liminalia.studio.tourDone", "1"); localStorage.setItem("liminalia.studio.blocks", "0"); });
    await page.goto(url);
    await page.waitForFunction(() => !!(window as any).__liminaliaStudioApp?.debug?.editor && (window as any).__liminaliaStudioApp.debug.editor.text().includes("地の文。"));
    await page.evaluate((text) => (window as any).__liminaliaStudioApp.debug.editor.replaceAll(text), scenario);
    await page.evaluate(() => { const ed = (window as any).__liminaliaStudioApp.debug.editor; ed.view.focus(); ed.view.dispatch({ selection: { anchor: ed.state.doc.line(4).to } }); });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    expect(await page.locator(".cm-tooltip-autocomplete").count()).toBe(0);
    await page.evaluate((text) => { const ed = (window as any).__liminaliaStudioApp.debug.editor; ed.replaceAll(text); ed.view.dispatch({ selection: { anchor: ed.state.doc.line(2).from + 4 } }); }, scenario);
    await page.keyboard.press("Enter");
    await expect.poll(() => page.locator(".cm-tooltip-autocomplete li .cm-completionLabel").allTextContents(), { timeout: 5000 }).toEqual(["アカリ", "ソウ"]);
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => { const ed = (window as any).__liminaliaStudioApp.debug.editor; return [ed.state.doc.line(2).text, ed.state.doc.line(3).text]; })).toEqual(["アカリ「", "うん」"]);
    await page.evaluate((text) => { const ed = (window as any).__liminaliaStudioApp.debug.editor; ed.replaceAll(text); ed.view.dispatch({ selection: { anchor: ed.state.doc.line(2).to } }); }, scenario);
    await page.keyboard.press("Enter");
    await expect.poll(() => page.locator(".cm-tooltip-autocomplete").count(), { timeout: 5000 }).toBe(1);
    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator(".cm-tooltip-autocomplete").count()).toBe(0);
    await page.keyboard.press("Control+Space");
    await expect.poll(() => page.locator(".cm-tooltip-autocomplete li .cm-completionLabel").allTextContents(), { timeout: 5000 }).toContain("ラジオ");
    await page.keyboard.press("Escape");
    await page.keyboard.insertText("地の文");
    expect(await page.evaluate(() => (window as any).__liminaliaStudioApp.debug.editor.state.doc.line(3).text)).toBe("地の文");
    for (const tail of ["@wait 1s", "ソウ「別の人」", "# next", "// コメント"]) {
      await page.evaluate((suffix) => {
        const ed = (window as any).__liminaliaStudioApp.debug.editor;
        ed.replaceAll(`アカリ「うん」${suffix}\n`);
        ed.view.dispatch({ selection: { anchor: 'アカリ「うん」'.length } });
      }, tail);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(200);
      expect(await page.locator(".cm-tooltip-autocomplete").count(), tail).toBe(0);
    }
    await page.evaluate((text) => (window as any).__liminaliaStudioApp.debug.editor.replaceAll(text), scenario);
    await page.close();
  });

  it("台詞の途中で分けた後に候補を選ぶと、前を閉じて後半の本文と行 ID を保つ", async () => {
    for (const { browser, name } of list) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.addInitScript(() => { localStorage.setItem("liminalia.studio.tourDone", "1"); localStorage.setItem("liminalia.studio.blocks", "0"); });
      await page.goto(url);
      await page.waitForFunction(() => !!(window as any).__liminaliaStudioApp?.debug?.editor && (window as any).__liminaliaStudioApp.debug.editor.text().includes("アカリ"));
      for (const [tail, expected, other] of [["先日は木箱がありました」", "アカリ「先日は木箱がありました」", false], ["先日は木箱がありました」 #line:abc", "アカリ「先日は木箱がありました」 #line:abc", false], ["先日は木箱がありました #line:abc", "アカリ「先日は木箱がありました」 #line:abc", false], ["他の人が答えた」", "ソウ「他の人が答えた」", true]] as const) {
        await page.evaluate((suffix) => {
          const ed = (window as any).__liminaliaStudioApp.debug.editor;
          ed.replaceAll(`ソウ「本以外のもの？」\nアカリ「変な鏡とか。${suffix}\n`);
          ed.view.focus();
          const row = ed.state.doc.line(2);
          ed.view.dispatch({ selection: { anchor: row.from + 'アカリ「変な鏡とか。'.length } });
        }, tail);
        await page.keyboard.press("Enter");
        await expect.poll(() => page.locator(".cm-tooltip-autocomplete li .cm-completionLabel").allTextContents(), { timeout: 5000 }).toEqual(["アカリ", "ソウ"]);
        await page.waitForTimeout(120);
        if (other) await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Tab");
        const lines = await page.evaluate(() => { const ed = (window as any).__liminaliaStudioApp.debug.editor; return [ed.state.doc.line(2).text, ed.state.doc.line(3).text]; });
        expect(lines, name).toEqual(["アカリ「変な鏡とか。」", expected]);
        if (expected.includes("#line:")) {
          await page.evaluate(() => { const ed = (window as any).__liminaliaStudioApp.debug.editor; const row = ed.state.doc.line(3); ed.view.dispatch({ selection: { anchor: row.from + row.text.indexOf("」") } }); });
          await page.keyboard.press("Enter");
          expect(await page.evaluate(() => (window as any).__liminaliaStudioApp.debug.editor.state.doc.line(3).text), name).toBe(expected);
        }
      }
      await page.evaluate((text) => (window as any).__liminaliaStudioApp.debug.editor.replaceAll(text), scenario);
      await page.close();
    }
  });

  it("英語の原文では引用符を対で挿入する", async () => {
    const page = await list[0]!.browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(() => { localStorage.setItem("liminalia.studio.tourDone", "1"); localStorage.setItem("liminalia.studio.blocks", "0"); });
    await page.goto(url);
    await page.waitForFunction(() => !!(window as any).__liminaliaStudioApp?.debug?.editor && (window as any).__liminaliaStudioApp.debug.editor.text().includes("アカリ"));
    await page.evaluate(() => {
      const app = (window as any).__liminaliaStudioApp;
      app.debug.editor.setContext({ ...app.ctx, language: "en" });
      app.debug.editor.replaceAll('ソウ "Hello"\nアカリ "Hi"\n');
      app.debug.editor.view.focus();
      app.debug.editor.view.dispatch({ selection: { anchor: app.debug.editor.state.doc.line(2).to } });
    });
    await page.keyboard.press("Enter");
    await expect.poll(() => page.locator(".cm-tooltip-autocomplete li .cm-completionLabel").allTextContents(), { timeout: 5000 }).toEqual(["アカリ", "ソウ"]);
    await page.waitForTimeout(120);
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => { const ed = (window as any).__liminaliaStudioApp.debug.editor; return [ed.state.doc.line(3).text, ed.state.selection.main.head - ed.state.doc.line(3).from]; })).toEqual(['アカリ ""', 5]);
    await page.evaluate((text) => (window as any).__liminaliaStudioApp.debug.editor.replaceAll(text), scenario);
    await page.close();
  });

  it("閉じ括弧の後で文章を分けた場合も候補を出し、残った本文を保つ", async () => {
    const page = await list[0]!.browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(() => { localStorage.setItem("liminalia.studio.tourDone", "1"); localStorage.setItem("liminalia.studio.blocks", "0"); });
    await page.goto(url);
    await page.waitForFunction(() => !!(window as any).__liminaliaStudioApp?.debug?.editor && (window as any).__liminaliaStudioApp.debug.editor.text().includes("アカリ"));
    for (const tail of ["続きの文」", "続きの文"]) {
      await page.evaluate((suffix) => {
        const ed = (window as any).__liminaliaStudioApp.debug.editor;
        ed.replaceAll(`ソウ「前」\nアカリ「うん」${suffix}\n`);
        ed.view.focus();
        const line = ed.state.doc.line(2);
        ed.view.dispatch({ selection: { anchor: line.from + 'アカリ「うん」'.length } });
      }, tail);
      await page.keyboard.press("Enter");
      await expect.poll(() => page.locator(".cm-tooltip-autocomplete li .cm-completionLabel").allTextContents(), { timeout: 5000 }).toEqual(["アカリ", "ソウ"]);
      await page.waitForTimeout(120);
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => { const ed = (window as any).__liminaliaStudioApp.debug.editor; return [ed.state.doc.line(2).text, ed.state.doc.line(3).text, ed.state.selection.main.head - ed.state.doc.line(3).from]; })).toEqual(["アカリ「うん」", "アカリ「続きの文」", 4]);
    }
    await page.evaluate((text) => (window as any).__liminaliaStudioApp.debug.editor.replaceAll(text), scenario);
    await page.close();
  });

  it("既存の話者補完も近さを優先し、その次に全シナリオの登場回数で並べる", async () => {
    const page = await list[0]!.browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(() => { localStorage.setItem("liminalia.studio.tourDone", "1"); localStorage.setItem("liminalia.studio.blocks", "0"); });
    await page.goto(url);
    await page.waitForFunction(() => !!(window as any).__liminaliaStudioApp?.debug?.editor && (window as any).__liminaliaStudioApp.debug.editor.text().length > 0);
    await page.evaluate(() => {
      const ed = (window as any).__liminaliaStudioApp.debug.editor;
      ed.replaceAll('ア二「少し前」\nア一「直近」\n\n@wait 1s\n');
      ed.view.focus();
      ed.view.dispatch({ selection: { anchor: ed.state.doc.line(3).from } });
    });
    await page.keyboard.insertText("ア");
    const labels = () => page.locator(".cm-tooltip-autocomplete li .cm-completionLabel").allTextContents();
    await expect.poll(labels, { timeout: 5000 }).toEqual(["ア一", "ア二", "ア三", "ア四", "アカリ"]);
    await page.keyboard.insertText("三");
    await expect.poll(labels, { timeout: 5000 }).toEqual(["ア三"]);
    await page.keyboard.press("Escape");
    await page.evaluate((text) => (window as any).__liminaliaStudioApp.debug.editor.replaceAll(text), scenario);
    await page.locator('.toc-file[data-file="ranking"] .toc-file-name').click();
    await expect.poll(() => page.evaluate(() => (window as any).__liminaliaStudioApp.debug.editor.text())).toContain("ア三「よく出る」");
    await expect.poll(() => page.evaluate(() => (window as any).__liminaliaStudioApp.sync?.file)).toBe("ranking");
    await page.evaluate(() => (window as any).__liminaliaStudioApp.debug.editor.replaceAll('ア四「増やした」\n'.repeat(10)));
    await page.locator('.toc-file[data-file="start"] .toc-file-name').click();
    await expect.poll(() => page.evaluate(() => (window as any).__liminaliaStudioApp.debug.editor.text())).toContain("アカリ「うん」");
    await page.evaluate(() => {
      const ed = (window as any).__liminaliaStudioApp.debug.editor;
      ed.replaceAll("地の文。\n\n");
      ed.view.focus();
      ed.view.dispatch({ selection: { anchor: ed.state.doc.line(2).from } });
    });
    await page.keyboard.insertText("ア");
    await expect.poll(async () => (await labels())[0], { timeout: 5000 }).toBe("ア四");
    await page.evaluate((text) => (window as any).__liminaliaStudioApp.debug.editor.replaceAll(text), scenario);
    await page.close();
  });
});
