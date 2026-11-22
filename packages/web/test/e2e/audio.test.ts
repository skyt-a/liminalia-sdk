import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 音の鳴らし方を、実際のブラウザ（Web Audio）で確かめる。
 * - 読み込んでいる間に次の BGM・同じチャンネルの効果音・止める指示が来たら、前の音は鳴らさない（鳴らすと誰も止められず、
 *   繰り返す音が裏で鳴り続けてメモリも離さない）
 * - 展開する音は 48kHz まで（出力が 96kHz の端末でも、展開した大きさを倍にしない）
 */

/** 無音の WAV（16bit・二つの声部）。 */
function wav(seconds: number, rate = 44_100): Buffer {
  const samples = Math.round(seconds * rate);
  const data = samples * 4;
  const b = Buffer.alloc(44 + data);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + data, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(2, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 4, 28);
  b.writeUInt16LE(4, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(data, 40);
  return b;
}

/** 鳴らし始めて、止めても終わってもいない音（長さの秒）。 */
const TRACK = `
  window.__sounding = new Set();
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...a) {
    window.__sounding.add(this);
    this.addEventListener("ended", () => window.__sounding.delete(this));
    return start.apply(this, a);
  };
  const stop = AudioBufferSourceNode.prototype.stop;
  AudioBufferSourceNode.prototype.stop = function (...a) {
    window.__sounding.delete(this);
    return stop.apply(this, a);
  };
`;
const SOUNDING = `[...window.__sounding].map((s) => Math.round(s.buffer.duration)).sort((a, b) => a - b)`;

describe.skipIf(!e2e)("音（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  const dir = mkdtempSync(join(tmpdir(), "liminalia-e2e-audio-"));
  beforeAll(async () => {
    // 長いものほど展開に時間がかかり、後から頼んだ短いものより遅く読み終わる
    const files: Record<string, string> = {};
    for (const [name, seconds] of [["long", 40], ["short", 2], ["se-long", 30], ["se-short", 3]] as const) {
      const path = join(dir, `${name}.wav`);
      writeFileSync(path, wav(seconds));
      files[`assets/${name.startsWith("se") ? "sound" : "bgm"}/${name}.wav`] = path;
    }
    const scenario = [
      "@window show",
      "@bgm long.wav",
      "@bgm short.wav",
      "@se se-long.wav channel=1 loop=true",
      "@se se-short.wav channel=1 loop=true",
      "鳴らした。",
      "@bgm long.wav",
      "@stop-bgm",
      "@stop-se channel=1",
      "止めた。",
    ].join("\n");
    project = await startProject({ scenario: { a: `${scenario}\n` }, files });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("読み込み中に次の音・止める指示が来たら、前の音は鳴らさない。展開は 48kHz まで", async () => {
    for (const { name, browser } of list) {
      const page = await openPlayerWith(browser, project.url, TRACK);
      await page.waitForTimeout(1500);
      expect(await page.evaluate(SOUNDING), `${name} 鳴らした`).toEqual([2, 3]);
      expect(await page.evaluate("window.__liminalia.host.audio.context.sampleRate"), name).toBeLessThanOrEqual(48_000);
      await page.mouse.click(640, 360);
      await page.waitForTimeout(1500);
      expect(await page.evaluate(SOUNDING), `${name} 止めた`).toEqual([]);
      await page.close();
    }
  });
});

describe.skipIf(!e2e)("一時停止した BGM のセーブ（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  const dir = mkdtempSync(join(tmpdir(), "liminalia-e2e-audio-"));
  beforeAll(async () => {
    const path = join(dir, "tune.wav");
    writeFileSync(path, wav(5));
    project = await startProject({ scenario: { a: "@window show\n@bgm tune.wav\n鳴らした。\n@pause-bgm\n止めた。\n@resume-bgm\n続けた。\n" }, files: { "assets/bgm/tune.wav": path } });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("@pause-bgm で止めた位置をセーブに残し、ロードしたあとの @resume-bgm はそこから鳴らす", async () => {
    // 鳴らし始めた位置（AudioBufferSourceNode.start の二つ目）
    const starts = `window.__starts = []; const s = AudioBufferSourceNode.prototype.start; AudioBufferSourceNode.prototype.start = function (...a) { window.__starts.push(a[1] ?? 0); return s.apply(this, a); };`;
    for (const { name, browser } of list) {
      const page = await openPlayerWith(browser, project.url, starts);
      // 鳴った位置が 0.2 秒を過ぎるまで待つ（音の時計は機械の負荷で実際の時間より大きく遅れるので、時間を決めて待たない）
      await page.waitForFunction("(window.__liminalia.host.audio.bgmProgress()?.position ?? 0) > 0.2", null, { timeout: 60_000 });
      await page.mouse.click(640, 360);
      await page.waitForFunction(`document.querySelector(".message .text").textContent.includes("止めた") && window.__liminalia.host.waiting`);
      const at = (await page.evaluate("window.__liminalia.runtime().state.stage.bgm.pausedAt")) as number;
      expect(at, name).toBeGreaterThan(0.2);
      await page.evaluate('window.__liminalia.system.perform("quick-save")');
      await page.waitForTimeout(200);
      await page.evaluate('window.__liminalia.system.perform("quick-load")');
      await page.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("止めた") && window.__liminalia.host.waiting`);
      await page.evaluate("window.__starts.length = 0");
      await page.mouse.click(640, 360);
      await page.waitForFunction(`document.querySelector(".message .text").textContent.includes("続けた")`);
      await page.waitForTimeout(500);
      const started = (await page.evaluate("window.__starts")) as number[];
      expect(started.length, name).toBeGreaterThan(0);
      expect(Math.abs(started[0]! - at), name).toBeLessThan(0.05);
      // 続けたあとは、止めた位置を残さない
      expect(await page.evaluate("window.__liminalia.runtime().state.stage.bgm.pausedAt"), name).toBeUndefined();
      await page.close();
    }
  });
});

/** 読み込む前に script を入れてから開く。 */
async function openPlayerWith(browser: Browser, url: string, script: string) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.addInitScript(script);
  const page = await context.newPage();
  await page.goto(`${url}?autostart=1&start=a`);
  await page.waitForSelector(".message .text .ch", { timeout: 60_000 });
  return page;
}
