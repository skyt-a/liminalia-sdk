import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { chromium, webkit, type Browser, type Page } from "playwright-core";
import { findChromium } from "../../../cli/src/chromium.ts";
import { startPlayerServer } from "../../../cli/src/web.ts";
import { loadProject } from "@liminalia/project";
import { register as registerHooks } from "node:module";
import { register } from "tsx/esm/api";

// 開発サーバーの設定（packages/web/vite.config.ts）は TypeScript のパッケージを読むので、lim と同じく tsx で読めるようにする。
// 作品のプラグインが読む @liminalia/… は、作品に無ければ lim のものを使う（lim と同じ hooks.mjs）
register();
const LIM = new URL("../../../cli/bin/lim.mjs", import.meta.url).href;
registerHooks("../../../cli/bin/hooks.mjs", import.meta.url, { data: { base: LIM } });

/**
 * ブラウザで動かすテスト（LIMINALIA_E2E_BROWSER=1 のときだけ）の道具。ひな形の写しに台本とプラグインを足した作品を作り、
 * プレイヤーの開発サーバーを立てて、Chromium と WebKit で開く。
 * WebKit は Playwright の WebKit（npx playwright install webkit）。見つからなければ LIMINALIA_WEBKIT に実行ファイルを書く。
 * WebKit は音を止める起動の指定が無く、手元で流すとテストの BGM や効果音がスピーカーから鳴る（Chromium は --mute-audio で止める）ので、
 * CI（LIMINALIA_E2E_REQUIRE_WEBKIT=1）か LIMINALIA_E2E_WEBKIT=1 のときだけ WebKit でも流す（2026-11-20）。
 */

const TEMPLATE = resolve(import.meta.dirname, "../../../../templates/default");

export const e2e = !!process.env.LIMINALIA_E2E_BROWSER;

export interface TestProject {
  dir: string;
  url: string;
  close(): Promise<void>;
}

/** テストの書体（fixtures/make-test-font.py。和文はすべて四角、横も縦も一字 1em）。files に置いて ui.text.fontFile で使う。 */
export const TEST_FONT = resolve(import.meta.dirname, "fixtures/test-font.ttf");

/**
 * ひな形の写しに、台本（ファイル名 → 中身）と、web だけのプラグイン（中身）を足した作品を立てる。
 * files は作品の中のパス → 写す元のファイル。before は開発サーバーを立てる前に呼ぶ。
 */
export async function startProject(o: {
  scenario: Record<string, string>;
  plugin?: string;
  config?: Record<string, unknown>;
  files?: Record<string, string>;
  /** 開発サーバーを立てる前に、作品のフォルダに手を入れる。 */
  before?(dir: string): Promise<void> | void;
}): Promise<TestProject> {
  const dir = mkdtempSync(join(tmpdir(), "liminalia-e2e-"));
  cpSync(TEMPLATE, dir, { recursive: true });
  for (const [to, from] of Object.entries(o.files ?? {})) {
    mkdirSync(dirname(join(dir, to)), { recursive: true });
    cpSync(from, join(dir, to));
  }
  for (const [name, text] of Object.entries(o.scenario)) writeFileSync(join(dir, "scenario", `${name}.lim`), text);
  const cfg = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown>;
  if (o.plugin) {
    const plugin = join(dir, "plugins", "t");
    mkdirSync(join(plugin, "src"), { recursive: true });
    writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "t", version: "0.0.0", type: "module", exports: { "./web": "./src/web.ts" } }));
    writeFileSync(join(plugin, "src", "web.ts"), o.plugin);
    cfg.plugins = ["./plugins/t"];
  }
  Object.assign(cfg, o.config ?? {});
  writeFileSync(join(dir, "liminalia.json"), JSON.stringify(cfg));
  await o.before?.(dir);
  const { server, url } = await startPlayerServer(loadProject(dir), 0, true);
  return {
    dir,
    url,
    close: async () => {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 使えるブラウザ（Chromium は必ず。WebKit は見つかれば）。 */
export async function browsers(): Promise<{ name: "chromium" | "webkit"; browser: Browser }[]> {
  const out: { name: "chromium" | "webkit"; browser: Browser }[] = [];
  const required = !!process.env.LIMINALIA_E2E_REQUIRE_WEBKIT;
  const useWebkit = required || process.env.LIMINALIA_E2E_WEBKIT === "1";
  const exe = useWebkit ? (process.env.LIMINALIA_WEBKIT ?? installedWebkit()) : null;
  if (required && (!exe || !existsSync(exe))) throw new Error("WebKit が必要です（npx playwright-core install webkit）");
  const chrome = await chromium.launch({ executablePath: findChromium()!, args: ["--mute-audio"] });
  out.push({ name: "chromium", browser: chrome });
  if (exe && existsSync(exe)) {
    try {
      out.push({ name: "webkit", browser: await webkit.launch({ executablePath: exe }) });
    } catch (error) {
      await chrome.close();
      throw error;
    }
  }
  return out;
}

/** Playwright の WebKit（今の playwright-core が求める版が無ければ、入っているほかの版）。 */
function installedWebkit(): string | null {
  try {
    const want = webkit.executablePath();
    if (existsSync(want)) return want;
  } catch {
    // 見つからない
  }
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
  if (!existsSync(cache)) return null;
  const dirs = readdirSync(cache).filter((d) => d.startsWith("webkit-")).sort().reverse();
  for (const d of dirs) {
    for (const exe of [join(cache, d, "pw_run.sh"), join(cache, d, "minibrowser-gtk", "pw_run.sh")]) if (existsSync(exe)) return exe;
  }
  return null;
}

/** 作品を ?autostart=1&start=… で開き、最初の文字が出て書体が読み終わるまで待つ。 */
export async function openPlayer(browser: Browser, url: string, start: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${url}?autostart=1&start=${encodeURIComponent(start)}`);
  await page.waitForSelector(".message .text .ch", { timeout: 60_000 });
  await page.evaluate("document.fonts.ready.then(() => undefined)");
  return page;
}
