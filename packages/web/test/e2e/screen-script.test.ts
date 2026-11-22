import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { SCREEN_SCRIPT_API } from "@liminalia/lang";
import { copyScreen } from "@liminalia/project/screen-copy";
import { runBuild } from "../../../cli/src/commands/build.ts";
import { STANDARD_SCREENS } from "@liminalia/screens/rules";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/**
 * 画面の JS（作品のフォルダの ui/screens/<画面>/<画面>.js。docs/design/screen-templates.md の「画面の JS」）。
 * - テンプレートから作った画面の要素と、画面の api（値、働き、閉じる、結果、部品を作る、標準の文言）を受け取る
 * - 属性の働き（キー、フォーカス、Esc、押したときの結果）はそのまま効く。返した関数は閉じるときに一度呼ぶ
 * - 開発サーバーでは保存すると、次に開いた画面から新しい JS が効く。書き出しにも入る
 * - 作品のプラグインと同じく、--restricted（LIMINALIA_RESTRICTED=1）では読まない
 */

const TEMPLATE = resolve(import.meta.dirname, "../../../../templates/default");
const SCENARIO = "@window show\nはじめ。\nつぎ。\n";
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".lim": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json", ".png": "image/png", ".webp": "image/webp", ".wav": "audio/wav" };

const SCRIPT = (mark: string) => `export default function (screen, api) {
  const w = window;
  w.__opened = (w.__opened ?? 0) + 1;
  w.__script = { mark: ${JSON.stringify(mark)}, root: screen.className, connected: screen.isConnected, screen: api.screen, version: api.version, keys: Object.keys(api).sort(), values: { ...api.values }, text: api.text("confirm.yes") };
  screen.dataset.kind = String(api.values.kind);
  // テンプレートの部品を作る口（属性の働きが付く）
  const extra = api.render("screen", { fields: { message: "部品", yes: "Y", no: "N" } });
  w.__rendered = extra.querySelector(".lm-dialog-message").textContent;
  // 属性で書けない動き: あとで のボタンは結果 false、y のキーは「はい」の働き
  const later = document.createElement("button");
  later.className = "my-later";
  later.textContent = "あとで";
  later.addEventListener("click", () => api.result(false));
  screen.querySelector(".lm-dialog-buttons").append(later);
  const key = (e) => { if (e.key === "y") api.press("ok"); };
  document.addEventListener("keydown", key);
  return () => { document.removeEventListener("keydown", key); w.__closed = (w.__closed ?? 0) + 1; };
}
`;

/** テンプレートを写して、画面の JS を置く（lim screens copy confirm --js と同じ）。 */
const place = (dir: string, mark = "one") => {
  copyScreen(dir, STANDARD_SCREENS, "confirm");
  writeFileSync(join(dir, "ui", "screens", "confirm", "confirm.js"), SCRIPT(mark));
};

const ask = async (p: Page, message = "進みますか") => {
  await p.evaluate(`window.__answer = undefined; void window.__liminalia.system.ask(${JSON.stringify(message)}, "confirm").then((ok) => (window.__answer = ok))`);
  await p.waitForSelector("[data-lm-screen='confirm']");
  await p.waitForTimeout(100);
};
const answer = async (p: Page) => {
  await p.waitForFunction("window.__answer !== undefined", undefined, { timeout: 5000 });
  return p.evaluate("window.__answer") as Promise<boolean>;
};
const focused = (p: Page) => p.evaluate(`document.activeElement?.textContent ?? ""`) as Promise<string>;

describe.skipIf(!e2e)("画面の JS（ブラウザ）", { timeout: 300_000 }, () => {
  let project: TestProject;
  let restricted: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({ scenario: { a: SCENARIO }, config: { entry: "a" }, before: (dir) => place(dir) });
    const before = process.env.LIMINALIA_RESTRICTED;
    process.env.LIMINALIA_RESTRICTED = "1";
    try {
      restricted = await startProject({ scenario: { a: SCENARIO }, config: { entry: "a" }, before: (dir) => place(dir) });
    } finally {
      if (before === undefined) delete process.env.LIMINALIA_RESTRICTED;
      else process.env.LIMINALIA_RESTRICTED = before;
    }
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
    await restricted?.close();
  });

  it("要素と api を受け取り、属性の働き（フォーカス、矢印、Esc、押した結果）はそのまま効く。返した関数は閉じるときに一度呼ぶ", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await ask(p, "JS の画面");
      expect(await p.evaluate("window.__script"), name).toEqual({
        mark: "one",
        root: "lm-dialog-backdrop",
        connected: true,
        screen: "confirm",
        version: 1,
        keys: [...SCREEN_SCRIPT_API].sort(),
        values: { message: "JS の画面", yes: "はい", no: "いいえ", kind: "confirm" },
        text: "はい",
      });
      expect(await p.evaluate("window.__rendered"), name).toBe("部品");
      expect(await p.evaluate(`document.querySelector("[data-lm-screen='confirm']").dataset.kind`), name).toBe("confirm");
      // 属性の働き: 初めのフォーカスは「はい」、矢印で「いいえ」、Esc は false
      expect(await focused(p), name).toBe("はい");
      await p.keyboard.press("ArrowLeft");
      expect(await focused(p), name).toBe("いいえ");
      await p.keyboard.press("Escape");
      expect(await answer(p), name).toBe(false);
      expect(await p.evaluate("window.__closed"), name).toBe(1);
      // JS が足したボタンは結果 false、JS のキーは「はい」の働き
      await ask(p);
      await p.locator(".my-later").click();
      expect(await answer(p), name).toBe(false);
      expect(await p.evaluate("window.__closed"), name).toBe(2);
      await ask(p);
      await p.keyboard.press("y");
      expect(await answer(p), name).toBe(true);
      expect(await p.evaluate("window.__closed"), name).toBe(3);
      // 閉じたあとは JS のキーが外れている
      await p.evaluate("window.__answer = undefined");
      await p.keyboard.press("y");
      await p.waitForTimeout(200);
      expect(await p.evaluate("window.__answer"), name).toBeUndefined();
      // テンプレートの中の <script> を外す決まりは今のまま
      expect(await p.evaluate("document.querySelectorAll('[data-lm-screen] script').length"), name).toBe(0);
      await p.close();
    }
  });

  it("保存すると、次に開いた画面から新しい JS が効く（開発サーバー）", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await p.evaluate("window.__kept = true");
      writeFileSync(join(project.dir, "ui", "screens", "confirm", "confirm.js"), SCRIPT("two"));
      await p.waitForTimeout(1200);
      await ask(p);
      expect(await p.evaluate("window.__script.mark"), name).toBe("two");
      // ページを読み込み直していない
      expect(await p.evaluate("window.__kept ?? false"), name).toBe(true);
      await p.keyboard.press("Escape");
      expect(await answer(p), name).toBe(false);
      writeFileSync(join(project.dir, "ui", "screens", "confirm", "confirm.js"), SCRIPT("one"));
      await p.waitForTimeout(1200);
      await p.close();
    }
  });

  it("制限付き（LIMINALIA_RESTRICTED=1）では読まない。テンプレートの画面はそのまま動く", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, restricted.url, "a");
      await ask(p);
      expect(await p.evaluate("window.__script ?? null"), name).toBeNull();
      expect(await p.locator(".my-later").count(), name).toBe(0);
      expect(await focused(p), name).toBe("はい");
      await p.keyboard.press("Enter");
      expect(await answer(p), name).toBe(true);
      await p.close();
    }
  });

  describe("書き出したゲーム", () => {
    let root: string;
    let server: Server;
    let url: string;
    let web: string;
    beforeAll(async () => {
      root = mkdtempSync(join(tmpdir(), "liminalia-screen-script-"));
      const dir = join(root, "game");
      cpSync(TEMPLATE, dir, { recursive: true });
      writeFileSync(join(dir, "scenario", "a.lim"), SCENARIO);
      const cfg = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown>;
      cfg.entry = "a";
      writeFileSync(join(dir, "liminalia.json"), JSON.stringify(cfg));
      place(dir, "built");
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

    it("書き出したゲームでも画面の JS が効く（作品のフォルダの ui/ は写さず、束に入る）", async () => {
      for (const { name, browser } of list) {
        const p = await openPlayer(browser, url, "a");
        await ask(p);
        expect(await p.evaluate("window.__script.mark"), name).toBe("built");
        await p.locator(".my-later").click();
        expect(await answer(p), name).toBe(false);
        await p.close();
      }
      expect(existsSync(join(web, "ui"))).toBe(false);
    });
  });
});
