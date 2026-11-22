import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, openPlayer, startProject, TEST_FONT, type TestProject } from "./harness.ts";

/**
 * 禁則の強さ（ui.text.lineBreak）の既定を、Chromium と WebKit で確かめる。
 * 書かなければ、日本語と中国語の作品は strict（行頭に小さい「ッ」「ュ」や「ー」を置かない）、ほかの言語は auto。auto と書いた作品は前のまま。
 * 一行の字数（lineChars: 10）とテストの書体（一字 1em）で、11 字目が次の行の頭に来るように組む。
 * 禁則は舞台に決めるので、本文の外（名前欄、選択肢、バックログ、標準の命令の画面）にも同じ値が効く。
 * LIMINALIA_E2E_OUT を指定すると、撮った画面をそこに残す。
 */

const OUT = process.env.LIMINALIA_E2E_OUT;

/** 10 字目までで一行。11 字目が小さい「ッ」、長音「ー」、小さい「っ」になる三つの文。 */
const SMALL_TSU = "あいうえおかきくロケットを見た。";
const LONG_VOWEL = "あいうえおかきくけコーヒーを飲んだ。";
const HIRAGANA_TSU = "かきくけこさしすせまってから出た。";
/** 行頭に来てはいけない字（strict のとき）。 */
const NOT_AT_START = ["ッ", "ュ", "ー", "っ"];

/** 本文の各行の頭の字と、本文に効いている line-break。 */
async function lineStarts(p: Page): Promise<{ starts: string[]; lineBreak: string }> {
  return (await p.evaluate(`(() => {
    const chs = [...document.querySelectorAll(".message .text .ch")];
    const starts = []; let top = null;
    for (const e of chs) {
      const t = e.getBoundingClientRect().top;
      if (top === null || Math.abs(t - top) > 4) { starts.push(e.textContent); top = t; }
    }
    const s = getComputedStyle(document.querySelector(".message .text"));
    return { starts, lineBreak: s.lineBreak || s.webkitLineBreak || "" };
  })()`)) as { starts: string[]; lineBreak: string };
}

describe.skipIf(!e2e)("禁則の強さの既定（Chromium と WebKit）", { timeout: 300_000 }, () => {
  let list: { name: string; browser: Browser }[];
  const projects: TestProject[] = [];
  beforeAll(async () => {
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    for (const p of projects) await p.close();
  });

  const FONT = { files: { "assets/others/test-font.ttf": TEST_FONT } };
  const open = async (config: Record<string, unknown>, text: Record<string, unknown> = {}) => {
    const scenario = { a: `@window show\n${SMALL_TSU}\n`, b: `@window show\n${LONG_VOWEL}\n`, c: `@window show\n${HIRAGANA_TSU}\n` };
    const project = await startProject({ scenario, config: { ...config, ui: { text: { fontFile: "test-font.ttf", lineChars: 10, ...text } } }, ...FONT });
    projects.push(project);
    return project;
  };
  const read = async (browser: Browser, project: TestProject, start: string, shot?: string) => {
    const p = await openPlayer(browser, project.url, start);
    await p.waitForTimeout(1200);
    const r = await lineStarts(p);
    if (OUT && shot) await p.screenshot({ path: `${OUT}/${shot}.png` });
    await p.close();
    return r;
  };

  it("日本語の作品（languages を書かない）は、書かなくても行頭に小さい「ッ」や「ー」を置かない", async () => {
    const project = await open({});
    for (const { name, browser } of list) {
      for (const [start, text] of [["a", SMALL_TSU], ["b", LONG_VOWEL], ["c", HIRAGANA_TSU]] as const) {
        const r = await read(browser, project, start, `line-break-ja-${start}-${name}`);
        const label = `${name} ${text} → ${r.starts.join(" / ")}`;
        expect(r.lineBreak, label).toBe("strict");
        expect(r.starts.length, label).toBeGreaterThanOrEqual(2);
        for (const c of NOT_AT_START) expect(r.starts, label).not.toContain(c);
      }
    }
  });

  it("auto と書いた作品は前と同じ（ブラウザに任せる。小さい「ッ」を行頭に置く）", async () => {
    const project = await open({}, { lineBreak: "auto" });
    for (const { name, browser } of list) {
      const r = await read(browser, project, "a", `line-break-auto-${name}`);
      const label = `${name} ${r.starts.join(" / ")}`;
      expect(r.lineBreak, label).toBe("auto");
      // 前の版の折り方が、このテストの組み方で出ること（直す前の不具合が起きる組み方で確かめている。Chromium も WebKit も auto では行頭に置く）
      expect(r.starts[1], label).toBe("ッ");
    }
  });

  it("中国語の作品も strict、英語の作品は auto のまま。決めた値は言語によらず効く", async () => {
    const zh = await open({ languages: ["zh"] });
    const en = await open({ languages: ["en"] });
    const loose = await open({}, { lineBreak: "loose" });
    for (const { name, browser } of list) {
      expect((await read(browser, zh, "a")).lineBreak, `${name} 中国語`).toBe("strict");
      expect((await read(browser, en, "a")).lineBreak, `${name} 英語`).toBe("auto");
      expect((await read(browser, loose, "a")).lineBreak, `${name} loose`).toBe("loose");
    }
  });
});

describe.skipIf(!e2e)("本文の外の禁則（Chromium と WebKit）", { timeout: 300_000 }, () => {
  let list: { name: string; browser: Browser }[];
  let ja: TestProject | undefined;
  let loose: TestProject | undefined;
  let en: TestProject | undefined;
  beforeAll(async () => {
    list = await browsers();
    const files = { files: { "assets/others/test-font.ttf": TEST_FONT } };
    const scenario = { d: `@window show\nアカリ「${SMALL_TSU}」\n@choice\n- ${LONG_VOWEL} -> #one\n- 二つ目 -> #one\n@end\n# one\n一つ目。\n@stop\n` };
    const text = { fontFile: "test-font.ttf", lineChars: 10 };
    ja = await startProject({ scenario, config: { entry: "d", ui: { text } }, ...files });
    loose = await startProject({ scenario, config: { entry: "d", ui: { text: { ...text, lineBreak: "loose" } } }, ...files });
    en = await startProject({ scenario, config: { entry: "d", languages: ["en"], ui: { text } }, ...files });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    for (const p of [ja, loose, en]) await p?.close();
  });

  it("本文の外（バックログ、選択肢、名前欄、標準の命令の画面）にも同じ禁則が効く", async () => {
    const lineBreakOf = (p: Page, selector: string) => p.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const st = getComputedStyle(el);
      return st.lineBreak || (st as unknown as { webkitLineBreak: string }).webkitLineBreak || "";
    }, selector);
    for (const { name, browser } of list) {
      for (const [project, want] of [[ja!, "strict"], [loose!, "loose"], [en!, "auto"]] as const) {
        const p = await openPlayer(browser, project.url, "d");
        const label = `${name} ${want}`;
        // 名前欄と、選択肢
        expect(await lineBreakOf(p, ".message .name"), label).toBe(want);
        for (let i = 0; i < 10 && (await p.locator(".choices button").count()) === 0; i++) {
          await p.mouse.click(640, 400);
          await p.waitForTimeout(300);
        }
        await p.waitForSelector(".choices button", { timeout: 10_000 });
        expect(await lineBreakOf(p, ".choices button"), label).toBe(want);
        // バックログ
        await p.evaluate("window.__liminalia.system.openBacklog()");
        await p.waitForSelector(".lm-log-text", { timeout: 10_000 });
        expect(await lineBreakOf(p, ".lm-log-text"), label).toBe(want);
        await p.keyboard.press("Escape");
        // 標準の命令の画面などが置く、舞台の中の要素（std の図鑑、調べる画面、地図、常駐の表示の層と同じ所）
        expect(await p.evaluate(() => {
          const el = Object.assign(document.createElement("p"), { textContent: "あ" });
          document.querySelector(".stage .layer")!.append(el);
          const st = getComputedStyle(el);
          const v = st.lineBreak || (st as unknown as { webkitLineBreak: string }).webkitLineBreak || "";
          el.remove();
          return v;
        }), label).toBe(want);
        await p.close();
      }
    }
  });
});
