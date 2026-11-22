import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { projectTextKey, translationKey } from "@liminalia/lang";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * @title-screen ending= で終えたとき、暗転してエンディングの名前と終わりの表記を出し、押すとタイトルへ戻ることを確かめる。
 * 画面の文言は種類から引き（bad は BAD END）、title= があれば種類の文言を上に添えて名前を出す。作品の endingKinds と、
 * 作品の文言の表（プラグインの texts、訳のファイルの ui）で差し替えられ、英語で遊べば英語の文言と訳した名前になる。
 * 移していない前の書き方（ending= に文言）は、書いた文言のまま出す。card=false と commandDefaults ではすぐ戻り、
 * 作品の screens.ending で見た目を差し替えられる。ending の無い @title-screen はすぐ戻る。
 */

const SCENARIO = (line: string) => `@bg hill_dusk.webp
@window show
はじまり。
${line}
`;

const PLUGIN = `import { defineWebPlugin } from "@liminalia/web";
export default defineWebPlugin({ name: "t",
  screens: {
    ending: (api) => {
      const el = document.createElement("div");
      el.className = "my-ending";
      el.textContent = [api.kind, api.label, api.title, api.name, api.text].join("/");
      el.onclick = () => api.close();
      return el;
    },
  },
});
`;

/** 作品の文言の表（プラグインの texts）で種類の文言を替える。 */
const TEXTS = `import { defineWebPlugin } from "@liminalia/web";
export default defineWebPlugin({ name: "t", texts: { "ending.kinds.bad": "バッドエンド" } });
`;

const shots = process.env.LIMINALIA_E2E_SHOTS ?? "/tmp";

describe.skipIf(!e2e)("エンディングの名前（ブラウザ）", { timeout: 300_000 }, () => {
  let project: TestProject;
  let custom: TestProject;
  let off: TestProject;
  let texts: TestProject;
  let flow: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    const scenario = {
      bad: SCENARIO("@title-screen ending=bad"),
      titled: SCENARIO('@title-screen ending=bad title="沈黙"'),
      other: SCENARIO('@title-screen ending=other title="通り雨"'),
      truth: SCENARIO("@title-screen ending=true"),
      secret: SCENARIO('@title-screen ending=secret title="雨の扉"'),
      legacy: SCENARIO('@title-screen ending="Bad End"'),
      mark: SCENARIO('@title-screen ending=true text="完"'),
      plain: SCENARIO("@title-screen"),
      nocard: SCENARIO("@title-screen ending=bad card=false"),
    };
    project = await startProject({
      scenario,
      config: { entry: "bad", languages: ["ja", "en"], endingKinds: { secret: "SECRET END" }, extra: { endings: true } },
      before: (dir) => {
        mkdirSync(join(dir, "lang"), { recursive: true });
        writeFileSync(
          join(dir, "lang/en.json"),
          JSON.stringify({
            language: "en",
            lines: {
              [translationKey("titled", "arg", "沈黙")]: { source: "沈黙", text: "Silence", note: "@title-screen" },
              [translationKey("secret", "arg", "雨の扉")]: { source: "雨の扉", text: "The Rain Door", note: "@title-screen" },
              [projectTextKey("SECRET END")]: { source: "SECRET END", text: "SECRET ENDING", note: "endingKinds" },
            },
            ui: { "ending.kinds.true": "True Ending" },
          }),
        );
      },
    });
    custom = await startProject({ scenario, config: { entry: "bad" }, plugin: PLUGIN });
    off = await startProject({ scenario, config: { entry: "bad", commandDefaults: { "title-screen": { card: "false" } } } });
    texts = await startProject({ scenario, config: { entry: "bad" }, plugin: TEXTS });
    // おまけの一覧は「はじめから」のフローチャートのエンディング
    flow = await startProject({ scenario: { titled: scenario.titled }, config: { entry: "titled", extra: { endings: true } } });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
    await custom?.close();
    await off?.close();
    await texts?.close();
    await flow?.close();
  });

  const mode = (p: Page) => p.evaluate("window.__liminalia.screen().mode") as Promise<string>;
  /** 「はじまり」を出し、送って @title-screen まで進める。 */
  const play = async (browser: Browser, url: string, start: string, lang = ""): Promise<Page> => {
    const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await p.goto(`${url}?autostart=1&start=${start}${lang ? `&lang=${lang}` : ""}`);
    await p.waitForFunction(`document.querySelector(".message .text")?.textContent.length > 0`, undefined, { timeout: 60_000 });
    for (let i = 0; i < 10 && (await mode(p)) === "game" && (await p.locator(".lm-ending, .my-ending").count()) === 0; i++) {
      await p.mouse.click(640, 400);
      await p.waitForTimeout(400);
    }
    return p;
  };
  /** 出ている名前（種類の文言、名前、終わりの表記）と種類。 */
  const shown = async (p: Page) => {
    await p.waitForSelector(".lm-ending", { timeout: 10_000 });
    return (await p.evaluate(`(() => {
      const root = document.querySelector(".lm-ending");
      const text = (s) => root.querySelector(s)?.textContent ?? null;
      return { kind: root.dataset.kind ?? null, label: text(".lm-ending-kind"), name: text(".lm-ending-name"), mark: text(".lm-ending-mark") };
    })()`)) as { kind: string | null; label: string | null; name: string | null; mark: string | null };
  };
  const toTitle = async (p: Page) => {
    await p.keyboard.press("Enter");
    await p.waitForFunction(`window.__liminalia.screen().mode === "title"`, undefined, { timeout: 10_000 });
  };

  it("種類の文言を出し、押すとタイトルへ戻る。title= があれば種類の文言を上に添える", async () => {
    for (const { name, browser } of list) {
      // 日本語と英語の作品なので、日本語で遊ぶ（ブラウザの言語によらず）
      const p = await play(browser, project.url, "bad", "ja");
      expect(await shown(p), name).toEqual({ kind: "bad", label: null, name: "BAD END", mark: "終" });
      // 出ている間はまだタイトルへ行かない（押すまで待つ）
      await p.waitForTimeout(2500);
      await p.screenshot({ path: `${shots}/ending-${name}.png` }).catch(() => undefined);
      expect([await mode(p), await p.evaluate("window.__liminalia.system.screen")], name).toEqual(["game", "ending"]);
      await toTitle(p);
      expect(await p.locator(".lm-ending").count(), name).toBe(0);
      await p.close();
      const cases: [string, { kind: string; label: string | null; name: string; mark: string }][] = [
        ["titled", { kind: "bad", label: "BAD END", name: "沈黙", mark: "終" }],
        ["other", { kind: "other", label: null, name: "通り雨", mark: "終" }],
        ["truth", { kind: "true", label: null, name: "TRUE END", mark: "終" }],
        // 作品が足した種類（endingKinds）の文言
        ["secret", { kind: "secret", label: "SECRET END", name: "雨の扉", mark: "終" }],
        // 移していない前の書き方は、書いた文言のまま（種類は文言から読む）
        ["legacy", { kind: "bad", label: null, name: "Bad End", mark: "終" }],
        ["mark", { kind: "true", label: null, name: "TRUE END", mark: "完" }],
      ];
      for (const [start, want] of cases) {
        const q = await play(browser, project.url, start, "ja");
        expect(await shown(q), `${name} ${start}`).toEqual(want);
        await q.waitForTimeout(2300);
        if (start === "titled" || start === "secret") await q.screenshot({ path: `${shots}/ending-${start}-${name}.png` }).catch(() => undefined);
        await toTitle(q);
        await q.close();
      }
    }
  });

  it("英語で遊べば英語の文言と訳した名前。訳のファイルの ui と作品の endingKinds の訳で種類の文言を替えられる", async () => {
    for (const { name, browser } of list) {
      for (const [start, want] of [
        ["titled", { kind: "bad", label: "BAD END", name: "Silence", mark: "The End" }],
        ["truth", { kind: "true", label: null, name: "True Ending", mark: "The End" }],
        ["secret", { kind: "secret", label: "SECRET ENDING", name: "The Rain Door", mark: "The End" }],
      ] as const) {
        const p = await play(browser, project.url, start, "en");
        expect(await shown(p), `${name} ${start}`).toEqual(want);
        await p.waitForTimeout(2300);
        if (start === "titled") await p.screenshot({ path: `${shots}/ending-en-${name}.png` }).catch(() => undefined);
        await toTitle(p);
        await p.close();
      }
    }
  });

  it("作品の文言の表（プラグインの texts）で種類の文言を替えられる", async () => {
    for (const { name, browser } of list) {
      const p = await play(browser, texts.url, "bad");
      expect(await shown(p), name).toEqual({ kind: "bad", label: null, name: "バッドエンド", mark: "終" });
      await toTitle(p);
      await p.close();
      const q = await play(browser, texts.url, "titled");
      expect(await shown(q), name).toEqual({ kind: "bad", label: "バッドエンド", name: "沈黙", mark: "終" });
      await toTitle(q);
      await q.close();
    }
  });

  it("おまけのエンディングの一覧は、種類の文言と名前を一行にし、種類を data-kind に書く", async () => {
    for (const { name, browser } of list) {
      const p = await play(browser, flow.url, "titled");
      await shown(p);
      await toTitle(p);
      await p.evaluate("window.__liminalia.system.openExtra('endings')");
      await p.waitForSelector(".lm-flow-ending");
      const rows = (await p.evaluate(`[...document.querySelectorAll(".lm-flow-ending")].map((e) => [e.dataset.kind ?? "", e.querySelector(".lm-extra-name").textContent])`)) as [string, string][];
      expect(rows, name).toEqual([["bad", "BAD END　沈黙"]]);
      await p.close();
    }
  });

  it("ending の無いもの、card=false、commandDefaults で外した作品はすぐタイトルへ戻る", async () => {
    for (const { name, browser } of list) {
      for (const [url, start] of [
        [off.url, "plain"],
        [off.url, "nocard"],
        [off.url, "bad"],
      ] as const) {
        const p = await play(browser, url, start);
        await p.waitForFunction(`window.__liminalia.screen().mode === "title"`, undefined, { timeout: 10_000 });
        expect(await p.locator(".lm-ending").count(), `${name} ${start}`).toBe(0);
        await p.close();
      }
    }
  });

  it("作品の screens.ending で見た目を差し替えられ（種類、文言、名前を受け取る）、Esc でも進む", async () => {
    for (const { name, browser } of list) {
      const p = await play(browser, custom.url, "titled");
      await p.waitForSelector(".my-ending", { timeout: 10_000 });
      expect(await p.locator(".my-ending").textContent(), name).toBe("bad/BAD END/沈黙/沈黙/終");
      expect(await p.locator(".lm-ending").count(), name).toBe(0);
      await p.keyboard.press("Escape");
      await p.waitForFunction(`window.__liminalia.screen().mode === "title"`, undefined, { timeout: 10_000 });
      await p.close();
    }
  });
});
