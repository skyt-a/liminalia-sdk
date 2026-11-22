import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { runBuild } from "../../../cli/src/commands/build.ts";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/**
 * 作品の CSS（liminalia.json の ui.css）: テーマとプラグインの CSS（import した CSS と、setup で足した <style>）より後に効く。
 * 中の url() の素材を読む。開発サーバーでは保存すると読み込み直さずにその場で差し替わり、ui.css に足したファイルもその場で効く。
 * 書き出したゲームでも効き、url() の素材が書き出しに入る。
 */

const TEMPLATE = resolve(import.meta.dirname, "../../../../templates/default");
const ICON = resolve(import.meta.dirname, "fixtures/layer-top.png");
const SCENARIO = "@window show\n本文の一行目。\n二行目。\n@stop\n";
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".lim": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json", ".png": "image/png", ".webp": "image/webp", ".wav": "audio/wav" };

/** プラグインの CSS（import）と、setup で足す <style>。どちらも本文の色を決める。 */
const PLUGIN = `import { defineWebPlugin } from "@liminalia/web";
import "./t.css";
export default defineWebPlugin({ name: "t", setup() {
  const s = document.createElement("style");
  s.textContent = ".message .text { color: rgb(2, 2, 2); }";
  document.head.append(s);
} });
`;
const PLUGIN_CSS = ".message .text { color: rgb(1, 1, 1); }\n.message .name { color: rgb(1, 1, 1); }\n";
/** 作品の CSS（作品のフォルダの ui/ に置く）。 */
const WORK_CSS = (color: string) => `.message .text { color: ${color}; }\n.message { background-color: rgb(4, 4, 4); background-image: url(img/frame.png); }\n.message .name { border-image-source: url(../assets/image/sun.png); }\n.stage { --work-marker: work-css-ok; }\n`;

/** 作品の中に作品の CSS と素材を置く。 */
function placeWorkCss(dir: string): void {
  mkdirSync(join(dir, "ui", "img"), { recursive: true });
  cpSync(ICON, join(dir, "ui", "img", "frame.png"));
  mkdirSync(join(dir, "assets", "image"), { recursive: true });
  cpSync(ICON, join(dir, "assets", "image", "sun.png"));
  writeFileSync(join(dir, "ui", "screens.css"), WORK_CSS("rgb(3, 3, 3)"));
}

const textColor = (page: Page) => page.evaluate(() => getComputedStyle(document.querySelector(".message .text")!).color);
/** 要素の CSS の url() の絵を読み、幅を返す（読めなければ 0）。 */
const imageWidth = (page: Page, selector: string, property: string) =>
  page.evaluate(
    async ([sel, prop]) => {
      const value = getComputedStyle(document.querySelector(sel!)!).getPropertyValue(prop!);
      const url = /url\("?([^")]+)"?\)/.exec(value)?.[1];
      if (!url) return 0;
      const img = new Image();
      img.src = url;
      try {
        await img.decode();
      } catch {
        return 0;
      }
      return img.naturalWidth;
    },
    [selector, property],
  );

describe.skipIf(!e2e)("作品の CSS（ui.css）", { timeout: 600_000 }, () => {
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
  });

  describe("開発サーバー", () => {
    let project: TestProject;
    beforeAll(async () => {
      project = await startProject({
        scenario: { a: SCENARIO },
        plugin: PLUGIN,
        // テーマ（夜）の値も当てる
        config: { ui: { system: { preset: "night" }, css: ["ui/screens.css"] } },
        before: (dir) => {
          writeFileSync(join(dir, "plugins", "t", "src", "t.css"), PLUGIN_CSS);
          placeWorkCss(dir);
        },
      });
    }, 120_000);
    afterAll(async () => {
      await project?.close();
    });

    it("テーマとプラグインの CSS より後に効き、url() の素材を読む", async () => {
      for (const { name, browser } of list) {
        const page = await openPlayer(browser, project.url, "a");
        expect(await textColor(page), name).toBe("rgb(3, 3, 3)");
        expect(await page.evaluate(() => getComputedStyle(document.querySelector(".message")!).backgroundColor), name).toBe("rgb(4, 4, 4)");
        // プラグインの CSS だけが決めるものは、プラグインのまま
        expect(await page.evaluate(() => getComputedStyle(document.querySelector(".message .name")!).color), name).toBe("rgb(1, 1, 1)");
        expect(await imageWidth(page, ".message", "background-image"), name).toBeGreaterThan(0);
        expect(await imageWidth(page, ".message .name", "border-image-source"), name).toBeGreaterThan(0);
        await page.close();
      }
    });

    it("保存すると読み込み直さずにその場で差し替わり、ui.css に足したファイルもその場で効く", async () => {
      const { browser } = list[0]!;
      const page = await openPlayer(browser, project.url, "a");
      await page.evaluate(() => ((window as unknown as { __kept?: number }).__kept = 1));
      writeFileSync(join(project.dir, "ui", "screens.css"), WORK_CSS("rgb(5, 5, 5)"));
      await expect.poll(() => textColor(page), { timeout: 30_000 }).toBe("rgb(5, 5, 5)");
      // 足したファイル（後のものが勝つ）
      writeFileSync(join(project.dir, "ui", "more.css"), ".message .text { color: rgb(6, 6, 6); }\n");
      const file = join(project.dir, "liminalia.json");
      const cfg = JSON.parse(readFileSync(file, "utf8")) as { ui: { css: string[] } };
      cfg.ui.css = ["ui/screens.css", "ui/more.css"];
      writeFileSync(file, JSON.stringify(cfg));
      await expect.poll(() => textColor(page), { timeout: 30_000 }).toBe("rgb(6, 6, 6)");
      // 外すと元に戻る
      cfg.ui.css = ["ui/screens.css"];
      writeFileSync(file, JSON.stringify(cfg));
      await expect.poll(() => textColor(page), { timeout: 30_000 }).toBe("rgb(5, 5, 5)");
      expect(await page.evaluate(() => (window as unknown as { __kept?: number }).__kept)).toBe(1);
      await page.close();
    });
  });

  describe("書き出したゲーム", () => {
    let root: string;
    let web: string;
    let server: Server;
    let url: string;
    beforeAll(async () => {
      root = mkdtempSync(join(tmpdir(), "liminalia-work-css-"));
      const dir = join(root, "game");
      cpSync(TEMPLATE, dir, { recursive: true });
      writeFileSync(join(dir, "scenario", "a.lim"), SCENARIO);
      const plugin = join(dir, "plugins", "t");
      mkdirSync(join(plugin, "src"), { recursive: true });
      writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "t", version: "0.0.0", type: "module", exports: { "./web": "./src/web.ts" } }));
      writeFileSync(join(plugin, "src", "web.ts"), PLUGIN);
      writeFileSync(join(plugin, "src", "t.css"), PLUGIN_CSS);
      placeWorkCss(dir);
      const cfg = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown>;
      cfg.entry = "a";
      cfg.plugins = ["./plugins/t"];
      cfg.ui = { system: { preset: "night" }, css: ["ui/screens.css"] };
      writeFileSync(join(dir, "liminalia.json"), JSON.stringify(cfg));
      const log = console.log;
      console.log = () => undefined;
      try {
        expect(await runBuild(dir, { targets: ["browser"], import: false, verify: false })).toBe(true);
      } finally {
        console.log = log;
      }
      const browserDir = join(dir, "dist", "browser");
      web = join(browserDir, readdirSync(browserDir).find((d) => statSync(join(browserDir, d)).isDirectory())!);
      server = createServer((req, res) => {
        const rel = decodeURIComponent((req.url ?? "/").split("?")[0]!);
        const file = join(web, rel === "/" ? "index.html" : rel);
        if (!file.startsWith(web) || !existsSync(file) || statSync(file).isDirectory()) return void res.writeHead(404).end();
        res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
      });
      url = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://localhost:${(server.address() as { port: number }).port}/`)));
    }, 300_000);
    afterAll(async () => {
      server?.close();
      if (root) rmSync(root, { recursive: true, force: true });
    });

    it("書き出したゲームでも、テーマとプラグインの CSS より後に効き、url() の素材が入る", async () => {
      for (const { name, browser } of list) {
        const page = await openPlayer(browser, url, "a");
        expect(await textColor(page), name).toBe("rgb(3, 3, 3)");
        expect(await page.evaluate(() => getComputedStyle(document.querySelector(".message")!).backgroundColor), name).toBe("rgb(4, 4, 4)");
        expect(await imageWidth(page, ".message", "background-image"), name).toBeGreaterThan(0);
        expect(await imageWidth(page, ".message .name", "border-image-source"), name).toBeGreaterThan(0);
        await page.close();
      }
      // 作品の CSS の中の文字が書き出しに入る（作品の外の ui/ は写さない。素材は束の中か engine/ に入る）
      const files = readdirSync(join(web, "engine"));
      const text = files.filter((f) => /\.(js|css)$/.test(f)).map((f) => readFileSync(join(web, "engine", f), "utf8")).join("\n");
      expect(text).toContain("work-css-ok");
      expect(existsSync(join(web, "ui"))).toBe(false);
    });
  });
});
