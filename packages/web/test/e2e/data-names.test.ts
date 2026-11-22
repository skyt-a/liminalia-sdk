import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/** プラグインが名前に点のあるデータ（data/code.en.json）を .json を省いて読めることを、実際のブラウザで確かめる。 */

const PLUGIN = `
import { defineWebPlugin } from "@liminalia/web";
export default defineWebPlugin({
  name: "t",
  async setup(host) {
    const read = (name) => host.context.loadData(name).then((v) => v, (e) => "error: " + e.message);
    window.__data = { short: await read("code.en"), full: await read("code.en.json"), nested: await read("codes/v1.2") };
  },
});
`;

describe.skipIf(!e2e)("データの名前（ブラウザ）", { timeout: 120_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({
      scenario: { a: "@window show\n本文\n" },
      config: { entry: "a" },
      plugin: PLUGIN,
      before: (dir) => {
        mkdirSync(join(dir, "data", "codes"), { recursive: true });
        writeFileSync(join(dir, "data", "code.en.json"), JSON.stringify({ lang: "en" }));
        writeFileSync(join(dir, "data", "codes", "v1.2.json"), JSON.stringify({ v: 1 }));
      },
    });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("loadData(\"code.en\") は data/code.en.json を読む（点のある名前を拡張子とみなさない）", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1`);
      await p.waitForFunction("!!window.__data", undefined, { timeout: 60_000 });
      expect(await p.evaluate("window.__data"), name).toEqual({ short: { lang: "en" }, full: { lang: "en" }, nested: { v: 1 } });
      await p.close();
    }
  });
});
