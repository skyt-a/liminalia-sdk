import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Browser } from "playwright-core";
import { loadProject } from "@liminalia/project";
import { runCoverage } from "../../../cli/src/commands/coverage.ts";
import { runProjectTests } from "../../../cli/src/commands/test.ts";
import { traceProject } from "../../../cli/src/commands/trace.ts";
import { lineSave } from "@liminalia/editor/protocol";
import { StudioWorkspace } from "../../../studio/src/server/workspace.ts";
import { RUNTIME_OPTION_OWNERS } from "../../../runtime/src/project-options.ts";
import { PARITY_PAGES, PARITY_STATE, writeParityProject } from "../../../runtime/test/parity-project.ts";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 遊ぶ側（ブラウザのプレイヤー）と画面なしの流し（lim trace、lim test、lim coverage、制作画面の全ルートテストと現在地）が、
 * 自動配置、commandDefaults、言語、章、版、台詞の括弧、ボイスの番号の固定、CG、実績、エンディングの種類を使う作品で同じ結果になること。
 * 画面なしの流しのテスト（cli、studio、vscode の headless-parity.test.ts）が使う PARITY_PAGES と PARITY_STATE も、ここで遊ぶ側と突き合わせる。
 */

/** 遊ぶ側で終わるまでクリックで読み進め、出した本文と、最後のページの状態を集める。 */
interface Played {
  pages: string[];
  slots: Record<string, unknown>;
  nextVoice: unknown;
  version: unknown;
  cg: unknown;
  achievements: string[];
  /** 実行器の設定のうち、作品の設定から作る項目（RUNTIME_OPTION_OWNERS の project。作品のデータの読み口は、遊ぶ側では描画側が読むので除く）。 */
  options: string[];
}

const projectKeys = (keys: readonly string[]): string[] => keys.filter((k) => RUNTIME_OPTION_OWNERS[k as keyof typeof RUNTIME_OPTION_OWNERS] === "project" && k !== "loadData").sort();

async function play(browser: Browser, url: string): Promise<Played> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  try {
    // 原文の言語（日本語）で遊ぶ（ブラウザの言語が英語でも）
    await page.goto(`${url}?autostart=1&lang=ja&start=xa`);
    await page.waitForSelector(".message .text .ch", { timeout: 60_000 });
    const pages: string[] = [];
    let last: Omit<Played, "pages" | "cg" | "achievements"> | null = null;
    for (let i = 0; i < 60; i++) {
      const now = (await page.evaluate(`(() => {
        const rt = window.__liminalia.runtime();
        if (!rt) return null;
        return {
          text: document.querySelector(".message .text")?.textContent ?? "",
          slots: Object.fromEntries(Object.entries(rt.state.stage.sprites).map(([who, s]) => [who, s.autoSlot ?? null])),
          nextVoice: rt.state.stage.voice?.auto?.["アカリ"]?.next ?? null,
          version: rt.save().gameVersion ?? null,
          options: Object.keys(rt.options ?? {}),
        };
      })()`)) as ({ text: string } & Omit<Played, "pages" | "cg" | "achievements">) | null;
      if (now) {
        const { text, ...state } = now;
        last = state;
        const shown = text.replace(/▼$/, "");
        if (shown !== "" && pages.at(-1) !== shown) pages.push(shown);
      }
      if (await page.evaluate("!!window.__liminalia.ended || !window.__liminalia.runtime()")) break;
      await page.evaluate("window.__liminalia.host.advance()");
      // 次のページ（か、出し終えた印）が出るか、プレイが終わるまで待つ
      await page.waitForFunction(`!window.__liminalia.runtime() || !!window.__liminalia.ended || (document.querySelector(".message .text")?.textContent ?? "") !== ${JSON.stringify(now?.text ?? "")}`, undefined, { timeout: 10_000 });
    }
    const system = (await page.evaluate("JSON.parse(JSON.stringify({ cg: window.__liminalia.system.systemVariables.cg_unlocked ?? null, achievements: window.__liminalia.system.systemVariables.achievements ?? {} }))")) as { cg: unknown; achievements: Record<string, unknown> };
    return { pages, ...last!, cg: system.cg, achievements: Object.keys(system.achievements).sort(), options: projectKeys(last!.options) };
  } finally {
    await page.close();
  }
}

describe.skipIf(!e2e)("遊ぶ側と画面なしの流しの結果（ブラウザ）", { timeout: 240_000 }, () => {
  let project: TestProject;
  let list: Awaited<ReturnType<typeof browsers>>;

  beforeAll(async () => {
    project = await startProject({ scenario: {}, before: (dir) => writeParityProject(dir) });
    list = await browsers();
  });

  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("lim trace、lim test、lim coverage、制作画面の全ルートテストと現在地が、遊ぶ側と同じ本文を通り、同じ状態で終わる", async () => {
    // lim trace
    const { trace, runtime } = await traceProject(project.dir, "xa");
    const traced: Played = {
      pages: trace.flatMap((t) => (t.type === "page" ? [t.text] : [])),
      slots: Object.fromEntries(Object.entries(runtime.state.stage.sprites).map(([who, s]) => [who, s.autoSlot ?? null])),
      nextVoice: runtime.state.stage.voice?.auto?.アカリ?.next ?? null,
      version: runtime.save().gameVersion ?? null,
      cg: runtime.system.cg_unlocked ?? null,
      achievements: Object.keys((runtime.system.achievements ?? {}) as object).sort(),
      options: projectKeys(Object.keys(runtime.options)),
    };
    // lim test（遊ぶ側が出すものを期待に書いたテスト）
    const [tests] = await runProjectTests(project.dir);
    // lim coverage
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let coverage: { files: { file: string; reached: number; total: number }[]; route: { lines: { reached: number } } };
    try {
      await runCoverage(project.dir, 2, 1, 2, { json: true });
      coverage = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    } finally {
      log.mockRestore();
    }
    // 制作画面の全ルートテストと現在地
    const ws = await StudioWorkspace.open(loadProject(project.dir));
    const studioCoverage = await ws.coverage(2);
    const { sweep } = await ws.sweep("xa");
    const lines = Object.keys(sweep.lines).map(Number).sort((a, b) => a - b);
    const end = lineSave(sweep, sweep.lines[lines.at(-1)!]!);

    for (const { name, browser } of list) {
      const played = await play(browser, project.url);
      // 画面なしの流しのテストが使う、遊ぶ側の結果
      expect(played.pages, name).toEqual(PARITY_PAGES);
      expect(played, name).toMatchObject({ slots: PARITY_STATE.slots, nextVoice: PARITY_STATE.nextVoice, version: "1.0.0", cg: PARITY_STATE.cg, achievements: PARITY_STATE.achievements });

      // 遊ぶ実行器は、作品の設定から作る項目をすべて持つ（確かめの作品は ui.chat を書かないので chatDialogue は無い）
      expect(played.options, name).toEqual(projectKeys(Object.keys(RUNTIME_OPTION_OWNERS)).filter((k) => k !== "chatDialogue"));
      expect(traced, name).toEqual(played);
      expect(tests!.tests.map((t) => [t.ok, t.failures.map((f) => f.ja)]), name).toEqual([[true, []]]);
      expect(coverage.files, name).toEqual([{ file: "xa", reached: played.pages.length, total: played.pages.length, complete: true }]);
      expect(coverage.route.lines.reached, name).toBe(played.pages.length);
      expect(studioCoverage.files, name).toEqual([{ file: "xa", lines: played.pages.length, reached: played.pages.length, unreached: [] }]);
      expect(lines, name).toHaveLength(played.pages.length);
      expect({ slots: Object.fromEntries(Object.entries(end.stage.sprites).map(([who, s]) => [who, s.autoSlot ?? null])), nextVoice: end.stage.voice?.auto?.アカリ?.next, version: end.gameVersion }, name).toEqual({ slots: played.slots, nextVoice: played.nextVoice, version: played.version });
    }
  });
});
