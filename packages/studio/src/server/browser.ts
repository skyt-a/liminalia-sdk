import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CHROMIUM_MISSING_STATUS } from "../protocol.ts";

/**
 * 画面なしのブラウザで、開発サーバーのプレイヤーを開くための口（画面写真・重さの計測。lim profile も使う）。
 *
 * 開き方は二つ:
 * - Playwright（playwright-core）と、LIMINALIA_CHROMIUM か Playwright が入れた chrome-headless-shell（findChromium）。lim studio・lim profile
 * - デスクトップ版では、アプリの Electron の見えないウィンドウ（packages/studio-desktop の engine/electron-pages.ts が setBrowserProvider で置く）。
 *   パッケージにしたアプリには playwright-core も Chromium も入れないので、こちらを使う
 *
 * playwright-core はここでは読み込まない（使うときに import する）。パッケージにしたアプリで、この組み立てを読んでも落ちないように。
 */

/** 開いたページ。evaluate・waitFor の fn は文字列にしてページの中で呼ぶので、外の変数を使わない（引数は JSON で渡す）。 */
export interface BrowserPage {
  evaluate<A, R>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
  /** fn が真を返すまで待つ。timeout ミリ秒を過ぎたら投げる。 */
  waitFor<A>(fn: (arg: A) => unknown, arg: A, timeout: number): Promise<void>;
  /** 見えている画面（開いたときの大きさ）の PNG。 */
  screenshot(): Promise<Buffer>;
  close(): Promise<void>;
  /** 開いてからページで出たエラー（例外、console.error、読み込みの失敗）。待ちが切れたときの説明に添える。 */
  problems?(): Promise<string[]>;
}

export interface BrowserProvider {
  /** url を size の大きさ（CSS の px。拡大は 1）で開く。 */
  open(url: string, size: { width: number; height: number }): Promise<BrowserPage>;
}

/** Chromium が見つからない（画面には、入れ方を添えた言葉で出す。口の応答は CHROMIUM_MISSING_STATUS）。 */
export class ChromiumMissingError extends Error {
  readonly status = CHROMIUM_MISSING_STATUS;
  constructor(detail: string) {
    super(`Chromium が見つかりません（${detail}）。npx playwright install chromium-headless-shell でインストールするか、LIMINALIA_CHROMIUM で指定してください`);
  }
}

/** 撮影・自動確認に使う Chromium。LIMINALIA_CHROMIUM か、Playwright が入れた chrome-headless-shell を探す。無ければ ChromiumMissingError。 */
export function findChromium(): string {
  const given = process.env.LIMINALIA_CHROMIUM;
  if (given) {
    if (!existsSync(given)) throw new ChromiumMissingError(`LIMINALIA_CHROMIUM の ${given} がありません`);
    return given;
  }
  const bases = [process.env.PLAYWRIGHT_BROWSERS_PATH, join(homedir(), "Library/Caches/ms-playwright"), join(homedir(), ".cache/ms-playwright"), join(homedir(), "AppData/Local/ms-playwright")];
  for (const base of bases) {
    if (!base || !existsSync(base)) continue;
    for (const dir of readdirSync(base).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()) {
      for (const sub of readdirSync(join(base, dir))) {
        for (const name of ["chrome-headless-shell", "chrome-headless-shell.exe"]) {
          const bin = join(base, dir, sub, name);
          if (existsSync(bin)) return bin;
        }
      }
    }
  }
  throw new ChromiumMissingError("Playwright の chrome-headless-shell が入っていません");
}

/** Playwright で開く。ページごとにブラウザを立て、閉じるときに止める。 */
export const playwrightProvider: BrowserProvider = {
  async open(url, size) {
    const executablePath = findChromium();
    let pw: typeof import("playwright-core");
    try {
      pw = await import("playwright-core");
    } catch {
      throw new ChromiumMissingError("playwright-core が入っていません");
    }
    const browser = await pw.chromium.launch({ executablePath, args: ["--mute-audio"] });
    try {
      const page = await browser.newPage({ viewport: size, deviceScaleFactor: 1 });
      const problems: string[] = [];
      page.on("pageerror", (e) => problems.push(e.message));
      page.on("console", (m) => {
        if (m.type() === "error") problems.push(m.text());
      });
      await page.goto(url);
      return {
        // 引数は JSON にできるものだけを渡す（Playwright の型の取り回しは使わない）
        evaluate: (fn, arg) => page.evaluate(fn as (a: unknown) => never, arg as unknown),
        waitFor: async (fn, arg, timeout) => void (await page.waitForFunction(fn as (a: unknown) => unknown, arg as unknown, { timeout })),
        screenshot: () => page.screenshot(),
        close: () => browser.close(),
        problems: async () => [...problems],
      };
    } catch (e) {
      await browser.close().catch(() => undefined);
      throw e;
    }
  },
};

const KEY = Symbol.for("liminalia.studio.browser");

/** ページの開き方を差し替える（デスクトップ版）。開発サーバーの組み立て（vite.config の束ね）と同じプロセスなので、globalThis に置く。 */
export function setBrowserProvider(provider: BrowserProvider | null): void {
  (globalThis as Record<symbol, unknown>)[KEY] = provider ?? undefined;
}

/** 今のページの開き方（差し替えていなければ Playwright）。 */
export function browserProvider(): BrowserProvider {
  return ((globalThis as Record<symbol, unknown>)[KEY] as BrowserProvider | undefined) ?? playwrightProvider;
}

/** fn が真を返すまで、間を置いて evaluate で確かめる（waitFor を持たない開き方のため）。 */
export async function pollUntil<A>(evaluate: BrowserPage["evaluate"], fn: (arg: A) => unknown, arg: A, timeout: number, interval = 50): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await evaluate(fn, arg)) return;
    if (Date.now() > deadline) throw new Error(`${Math.round(timeout / 1000)} 秒待っても、ページが用意できません`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

/**
 * 待ちが切れたときに添える、ページの今の様子（URL、読み込みの状態、エンジンが立ったか、今の画面、出ている文字の頭、ページで出たエラーの終わりの 5 件）。
 * 開けなかった・閉じたなどで様子が取れなければ、取れなかった理由を返す。
 */
export async function describePage(page: BrowserPage): Promise<string> {
  const state = await page
    .evaluate(() => {
      const l = window.__liminalia;
      let mode = "";
      try {
        mode = l?.screen().mode ?? "";
      } catch (e) {
        mode = `screen() threw: ${e instanceof Error ? e.message : String(e)}`;
      }
      const text = (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
      // 起動のどこまで進んだか（web の main.ts）と、失敗した読み込み（400 以上）
      const boot = (globalThis as { __liminaliaBoot?: string }).__liminaliaBoot ?? "";
      const resources = performance.getEntriesByType("resource") as (PerformanceResourceTiming & { responseStatus?: number })[];
      const failed = resources.filter((r) => (r.responseStatus ?? 0) >= 400).map((r) => `${r.responseStatus} ${r.name}`).slice(-8);
      return { href: location.href, readyState: document.readyState, engine: !!l, mode, boot, resources: resources.length, failed, text };
    }, null)
    .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
  const problems = await (page.problems?.() ?? Promise.resolve([])).catch(() => []);
  return JSON.stringify({ ...state, problems: problems.slice(-5) });
}
