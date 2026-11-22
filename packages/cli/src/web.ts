import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { createServer, mergeConfig, type InlineConfig, type Plugin, type ViteDevServer } from "vite";
import type { Project } from "@liminalia/project";
import { bundledCatalogDir, CLI_ROOT, webDir } from "./engine-paths.ts";

/**
 * Windows の短い名前（8.3 形式。C:\Users\RUNNER~1\… など）を長い名前にする。それ以外の OS と、~ を含まないパスはそのまま。
 * Vite は Windows で ~ を含むパスを一律に断る（403 Restricted）ので、開発サーバーに渡すフォルダはこれを通す。
 * 一時フォルダ（TEMP）は、ユーザー名が長いと短い名前で指されることがある。
 */
export function longPath(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32" || !path.includes("~")) return path;
  try {
    return realpathSync.native(path);
  } catch {
    // 長い名前にできなければ、そのまま渡す
    return path;
  }
}

/** プレイヤー（packages/web か、入れた @liminalia/web）のフォルダ。 */
export const WEB_ROOT = longPath(webDir());

/**
 * Vite の控え（依存の事前の束ね・設定を束ねた一時ファイル）の置き場所。プロジェクトの .liminalia/vite に置き、
 * エンジンのフォルダには書かない（エンジンが読み取り専用の場所にあっても、作品のフォルダだけで完結する）。
 * 設定は packages/web/vite.config.ts をそのまま読む小さなファイルを控えのフォルダに置いて指す。Vite は設定を束ねた一時ファイルを
 * 設定ファイルのそばに書くので、エンジンの設定を直接指すとエンジンのフォルダに書き込みが起きる。
 */
export function viteCache(project: Project): { configFile: string; cacheDir: string } {
  const dir = join(project.root, ".liminalia", "vite");
  mkdirSync(dir, { recursive: true });
  const configFile = join(dir, "vite.config.mjs");
  writeFileSync(configFile, `// Liminalia が自動で生成します。削除してもかまいません\nexport { default } from ${JSON.stringify(join(WEB_ROOT, "vite.config.ts"))};\n`);
  return { configFile, cacheDir: join(dir, "cache") };
}

/**
 * node_modules の中のエンジン（@liminalia/*。制作アプリや npm で入れたエンジン）を、ずっと変わらない印なしで渡す。
 * Vite は node_modules の中のファイルを「?v=依存の番号」付きで、一年変わらない（immutable）として渡す。番号は依存の組み合わせで決まり、
 * エンジンの中身では変わらないので、エンジンを入れ替えてもブラウザ（制作アプリ）は古いファイルを使い続けた。
 * 毎回 ETag で確かめさせる（変わっていなければ 304 で済む）。
 */
function engineRevalidate(): Plugin {
  return {
    name: "liminalia:engine-revalidate",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url && /\/node_modules\/(@|%40)liminalia\//.test(req.url)) {
          const set = res.setHeader.bind(res);
          res.setHeader = (name, value) => set(name, name.toLowerCase() === "cache-control" && String(value).includes("immutable") ? "no-cache" : value);
        }
        next();
      });
    },
  };
}

/**
 * 空いているポートの番号（OS に選ばせる）。Vite は port 0 を既定の 5173 から順に試すので、同時に立てたほかのプロセスの開発サーバー
 * （並べて流すブラウザのテスト、lim studio など）と近い番号を取り合い、IPv4 と IPv6 で別のサーバーに当たることがある。
 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * プロジェクトを指定してプレイヤーの開発サーバーを立てる（port 0 なら空いている番号）。lim dev と lim studio が使う。
 * overrides は Vite の設定に重ねるもの（制作アプリが、待つアドレスや控えの置き場所を変えるのに使う）。
 */
export async function startPlayerServer(project: Project, port: number, quiet = false, overrides: InlineConfig = {}, times: StartupTimes = new StartupTimes()): Promise<{ server: ViteDevServer; url: string }> {
  // 開発サーバー（vite.config.ts）は LIMINALIA_PROJECT から作品を読み直す。短い名前のままだと Windows の Vite が素材を断る
  process.env.LIMINALIA_PROJECT = longPath(project.root);
  // 制作画面の「サンプル素材から追加」が読むひな形（npm で入れた lim は cli の中に持つ。@liminalia/studio の samples.ts）
  if (existsSync(join(CLI_ROOT, "templates", "default"))) process.env.LIMINALIA_TEMPLATES ??= join(CLI_ROOT, "templates");
  // 制作画面の「公式のプラグイン」の一覧（npm で入れた lim は cli の中に持つ。@liminalia/studio の catalog.ts）
  const catalog = bundledCatalogDir();
  if (catalog) process.env.LIMINALIA_PLUGIN_CATALOG ??= catalog;
  // 読み込めないプラグインを抜いて読んだプロジェクト（lim studio）なら、開発サーバー（vite.config.ts）も抜いて開く
  if (project.pluginErrors !== undefined) process.env.LIMINALIA_SKIP_BROKEN_PLUGINS = "1";
  else delete process.env.LIMINALIA_SKIP_BROKEN_PLUGINS;
  const base: InlineConfig = {
    root: WEB_ROOT,
    plugins: [startupMarks(times), engineRevalidate()],
    // 控えの置き場所を呼ぶ側が決めていなければ、プロジェクトの .liminalia/vite
    ...(overrides.configFile === undefined ? viteCache(project) : {}),
    server: { port: port === 0 ? await freePort() : port, strictPort: false },
    logLevel: quiet ? "error" : "info",
  };
  const server = await createServer(mergeConfig(base, overrides));
  times.mark("Vite のサーバーの作成");
  await server.listen();
  times.mark("依存の下調べと待ち受けの開始");
  // 長くかかったら、どこで待ったかを記録に残す（制作アプリでは studio.log。制作画面がプロジェクトを開くときの記録と同じ書き方）
  const slow = times.report();
  if (slow) server.config.logger.warn(slow, { timestamp: true });
  return { server, url: server.resolvedUrls?.local[0] ?? `http://localhost:${port}/` };
}

/** 開発サーバーの起動にこれより長くかかったら、内訳を記録に出す（ミリ秒。制作画面がプロジェクトを開くときと同じ）。 */
export const SLOW_START_MS = 3000;

/**
 * 開発サーバーの起動にかかった時間の内訳。作ったときから数え、mark でそこまでの区切りに名前を付ける。report は全体が SLOW_START_MS 以上なら
 * 一行の文（「開発サーバーの起動に 17.2 秒かかりました（設定の読み込み 15.0 秒、…）」）、短ければ null。
 */
export class StartupTimes {
  private readonly now: () => number;
  private readonly started: number;
  private last: number;
  private readonly steps: [string, number][] = [];

  // 引数のプロパティ（constructor(private …)）は使わない。この部品は Vite の設定から Node の型を外すだけの読み込みでも読まれる
  constructor(now: () => number = Date.now) {
    this.now = now;
    this.started = now();
    this.last = this.started;
  }

  mark(label: string): void {
    const t = this.now();
    this.steps.push([label, t - this.last]);
    this.last = t;
  }

  report(): string | null {
    const total = this.last - this.started;
    if (total < SLOW_START_MS) return null;
    const seconds = (ms: number) => (ms / 1000).toFixed(1);
    return `開発サーバーの起動に ${seconds(total)} 秒かかりました（${this.steps.map(([label, ms]) => `${label} ${seconds(ms)} 秒`).join("、")}）`;
  }
}

/**
 * Vite がサーバーを作る途中の区切り（設定ファイルを読み終えた、プラグインの設定を終えた、プラグインを開始した）を times に付ける。
 * 設定ファイル（packages/web/vite.config.ts）はプロジェクトとプラグインの Vite の部品を読むので、そこで長く待つこともある。
 */
function startupMarks(times: StartupTimes): Plugin {
  const once = new Set<string>();
  const mark = (label: string) => {
    if (once.has(label)) return;
    once.add(label);
    times.mark(label);
  };
  return {
    name: "liminalia:startup-times",
    enforce: "pre",
    config: () => mark("Vite の設定ファイルの読み込み"),
    configResolved: () => mark("Vite のプラグインの準備"),
    buildStart: () => mark("プラグインの開始"),
  };
}
