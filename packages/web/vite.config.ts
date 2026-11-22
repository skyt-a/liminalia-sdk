import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import { imageSize, MEDIA_TYPES, uiCssFiles } from "@liminalia/lang";
import { loadProject, pluginEntry, projectFlow, STD_PLUGIN, stdWebFeatures, type Project } from "@liminalia/project";
import { defineConfig, type Plugin } from "vite";
import { setScreenTable, setScreenTemplateRules, setUiStringTable, studioServer } from "@liminalia/studio/server";
import { uiStringTable } from "./src/system/ui-strings.ts";
import { screenPreviewTable } from "./src/screen-preview/samples.ts";
import { screenTemplateRules } from "@liminalia/screens/rules";
import { casterServer } from "./src/caster/server.ts";
import { importServer } from "./src/import-server.ts";
import { liveConfig, playerInfo, templateFiles } from "./player-info.ts";
import { SCREEN_SCRIPTS_ID, screenScriptsModule } from "./screen-scripts-module.ts";
import { STANDARD_SCREENS } from "@liminalia/screens/rules";
import { pwaIcons } from "./pwa-icons.ts";
import { linkedAllowDirs } from "./dev-allow.ts";

/**
 * プレイヤーの開発サーバーと書き出し。対象のプロジェクトは環境変数 LIMINALIA_PROJECT（liminalia.json のあるフォルダ）。
 * プロジェクトのファイルは、立ち絵の位置調整画面が保存するときのほかは読むだけで、書き換えない。
 *   project/scenario/  … paths.scenario（.lim）
 *   project/data/      … paths.data
 *   project/cast.json  … paths.cast
 *   project/lang/      … paths.lang（多言語の訳 <言語>.json）
 *   assets/<種類>/     … paths.assets
 *   virtual:liminalia/project … 作品の情報とプラグイン（"./commands" と "./web"）
 *   virtual:liminalia/studio  … 制作画面に足すプラグインの画面（"./studio"。開発サーバーだけ）
 *   virtual:liminalia/work-css … 作品の CSS（ui.css。url() を解いた中身）
 * 開発サーバーだけ、立ち絵の位置調整画面 /__liminalia/cast を置き、cast.json と assets/fgimage/ を書く（src/caster/server.ts）。
 * 制作画面 /__liminalia/studio（@liminalia/studio）も開発サーバーだけに置き、書き込み口から .lim を書く（前の版は .liminalia/history/）。
 * 取り込みで作る作品では、制作画面の「取り込み直す」を src/import-server.ts が受ける。
 */
const webRoot = import.meta.dirname;
const projectDir = process.env.LIMINALIA_PROJECT;
if (!projectDir) throw new Error("LIMINALIA_PROJECT にプロジェクトのフォルダ（liminalia.json のあるところ）を指定してください");
// lim studio と制作アプリは、読み込めないプラグインを抜いて開く（LIMINALIA_SKIP_BROKEN_PLUGINS。cli/src/web.ts の startPlayerServer が置く）
const project = loadProject(projectDir, { skipBrokenPlugins: process.env.LIMINALIA_SKIP_BROKEN_PLUGINS === "1" });

/** 中身の種類。素材は書き出しと同じ表（@liminalia/lang の MEDIA_TYPES）。 */
const TYPES: Record<string, string> = {
  ".lim": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ...MEDIA_TYPES,
};

/**
 * Vite の /__open-in-editor（エラーの画面からエディタでファイルを開く口）を閉じる。どのサイトからでも起こせて、
 * 好きなファイルをエディタで開かせられる。制作画面は使わない（エディタで開くのは制作画面の API が sameOrigin を確かめてから）。
 */
function closeEditorOpener(): Plugin {
  return {
    name: "liminalia-close-open-in-editor",
    configureServer(server) {
      server.middlewares.use("/__open-in-editor", (_req, res) => {
        res.statusCode = 403;
        res.end();
      });
    },
  };
}

/** SVG の応答に付ける CSP（packages/studio-mobile/src/sw/index.ts、packages/desktop/main.cjs と同じ）。 */
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

function serve(prefix: string, target: string, single = false): Plugin {
  return {
    name: `liminalia-serve-${prefix}`,
    configureServer(server) {
      server.middlewares.use(prefix, (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? "/").split("?")[0]!);
        const file = single ? target : normalize(join(target, rel));
        if ((!single && file !== target && !file.startsWith(target + sep)) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader("Content-Type", TYPES[extname(file).toLowerCase()] ?? "application/octet-stream");
        // SVG を文書として開いても中のスクリプトを動かさない（スマホ版の Service Worker と同じ。<img> で読む絵には効かない）
        if (extname(file).toLowerCase() === ".svg") res.setHeader("Content-Security-Policy", SVG_CSP);
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Accept-Ranges", "bytes");
        // 範囲の指定（音・動画の飛ばし読みと、長い BGM の流し読み）にも答える
        const size = statSync(file).size;
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
        if (range && size > 0 && (range[1] || range[2])) {
          const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
          const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
          if (start > end || start >= size) {
            res.statusCode = 416;
            res.setHeader("Content-Range", `bytes */${size}`);
            res.end();
            return;
          }
          res.statusCode = 206;
          res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
          res.setHeader("Content-Length", String(end - start + 1));
          createReadStream(file, { start, end }).pipe(res);
          return;
        }
        res.setHeader("Content-Length", String(size));
        createReadStream(file).pipe(res);
      });
    },
  };
}

/** 遊ぶ人に見せるフローチャート（/project/flow.json。頼まれたときに台本から作る。台本の読み直しは変わったファイルだけ）。 */
function flowJson(p: Project): Plugin {
  return {
    name: "liminalia-flow",
    configureServer(server) {
      server.middlewares.use("/project/flow.json", (_req, res) => {
        projectFlow(p).then(
          (flow) => {
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.setHeader("Cache-Control", "no-cache");
            res.end(JSON.stringify(flow));
          },
          (e: Error) => {
            res.statusCode = 500;
            res.end(e.message);
          },
        );
      });
    },
  };
}

/** liveConfig が変わったことをプレイヤーに知らせるカスタムイベント（変数は次の「はじめから」から、見た目はすぐ効く）。 */
export const LIVE_CONFIG_EVENT = "liminalia:live-config";
/**
 * シナリオ（.lim）が変わった・増えた・消えたことをプレイヤーに知らせるカスタムイベント（data は { file }。拡張子なし）。
 * 遊んでいる途中のプレイヤーは読み込んだ台本のまま続くので、テストプレイが「この場所から読み直す」を出す（src/play-dev.ts）。
 */
export const SCENARIO_CHANGED_EVENT = "liminalia:scenario-changed";

/** 読み込めないプラグインの入口を飛ばす読み方（virtual: の中に置く。読めなければコンソールに出して undefined）。 */
const SKIP_BROKEN = `const tryImport = async (load, name) => { try { return (await load()).default; } catch (e) { console.error("[プラグイン] " + name + " を読み込めません", e); return undefined; } };`;

/**
 * 作品の情報とプラグインの入口を、プレイヤーが import できる形にする。
 * 標準の命令の描画（@liminalia/std）は部品ごとに分けてあり、遊び始める前に読む部品を preloadStd で決める。
 * 書き出しは作品が使う部品だけ（@liminalia/project の stdWebFeatures。ほかは初めて描くときに読む）、開発サーバーはすべて（台本を書き替えていくので）。
 */
export function projectModule(p: Project): Plugin {
  const id = "virtual:liminalia/project";
  let command: "build" | "serve" = "serve";
  return {
    name: "liminalia-project",
    configResolved(config) {
      command = config.command;
    },
    configureServer(server) {
      // liminalia.json の variables・ui が変わったら（制作画面の変数・ゲームの設定の画面など）、開いているプレイヤーに渡す。
      // シナリオが変わったときも、CG の自動の登録（extra.cgAuto）が変わるので見る
      const file = join(p.root, "liminalia.json");
      server.watcher.add([file, p.paths.scenario]);
      const scenario = (path: string) => path.startsWith(p.paths.scenario) && path.endsWith(".lim");
      // 開発サーバーだけで動くので、作品の版も渡す（書き換えたら次の「はじめから」から効く）
      let last = JSON.stringify(liveConfig(p, { dev: true }));
      // 作品の画面の型（ui.templates のファイル）も見る。書き換えたら live-config で渡す
      let templates = Object.values(templateFiles(p.root, liveConfig(p).ui));
      server.watcher.add(templates);
      const changed = (path: string) => {
        if (path === file) {
          const next = Object.values(templateFiles(p.root, liveConfig(p).ui));
          server.watcher.add(next.filter((t) => !templates.includes(t)));
          templates = next;
        }
        if (path !== file && !scenario(path) && !templates.includes(path)) return;
        if (scenario(path)) server.ws.send({ type: "custom", event: SCENARIO_CHANGED_EVENT, data: { file: relative(p.paths.scenario, path).slice(0, -".lim".length).split(sep).join("/") } });
        const next = liveConfig(p, { dev: true });
        if (JSON.stringify(next) === last) return;
        last = JSON.stringify(next);
        const mod = server.moduleGraph.getModuleById(`\0${id}`);
        if (mod) server.moduleGraph.invalidateModule(mod);
        server.ws.send({ type: "custom", event: LIVE_CONFIG_EVENT, data: next });
      };
      server.watcher.on("change", changed);
      server.watcher.on("add", changed);
      server.watcher.on("unlink", changed);
    },
    resolveId: (source) => (source === id ? `\0${id}` : null),
    load(resolved) {
      if (resolved !== `\0${id}`) return null;
      const lines: string[] = [];
      const commands: string[] = [];
      const web: string[] = [];
      // 読み込めないプラグインを抜いて開くとき（制作画面）は、一つずつ読んで、読み込めないものを飛ばす（ゲームは残りで動く）
      const skip = p.pluginErrors !== undefined;
      if (skip) lines.push(SKIP_BROKEN);
      p.plugins.forEach((dir, i) => {
        const c = pluginEntry(dir, "commands");
        const w = pluginEntry(dir, "web");
        if (c) {
          lines.push(skip ? `const c${i} = await tryImport(() => import(${JSON.stringify(c)}), ${JSON.stringify(c)});` : `import c${i} from ${JSON.stringify(c)};`);
          commands.push(`c${i}`);
        }
        if (w) {
          lines.push(skip ? `const w${i} = await tryImport(() => import(${JSON.stringify(w)}), ${JSON.stringify(w)});` : `import w${i} from ${JSON.stringify(w)};`);
          web.push(`w${i}`);
          if (resolve(dir) === resolve(STD_PLUGIN)) {
            const preload = command === "build" ? stdWebFeatures(p) : "all";
            lines.push(`import { preloadStd as preloadStd${i} } from ${JSON.stringify(w)};`, `preloadStd${i}(${JSON.stringify(preload)});`);
          }
        }
      });
      const info = playerInfo(p, { dev: command === "serve" });
      lines.push(`export const project = ${JSON.stringify(info)};`);
      lines.push(`export const commandPlugins = [${commands.join(", ")}]${skip ? ".filter(Boolean)" : ""};`);
      lines.push(`export const webPlugins = [${web.join(", ")}]${skip ? ".filter(Boolean)" : ""};`);
      return lines.join("\n");
    },
  };
}

/** HTML の属性と本文に書く文字。 */
const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Web アプリの定義（manifest.webmanifest）とページの題と説明。スマホでホーム画面に追加すると、全画面・横向き（縦長の作品なら縦向き）で開く。
 * アイコンは書き出しの設定の icon（PNG）から 192px、512px、maskable の 512px、apple-touch-icon の 180px を作る（pwa-icons.ts。
 * 開けない PNG なら元の絵を一つだけ）。ページの <title> は作品の題、<meta name="description"> は liminalia.json の description、
 * <html lang> とマニフェストの lang は原文の言語（languages の一つ目。無ければ ja）。Open Graph の題と説明も入れる。
 * 開発サーバーでも同じものを返す。
 */
export function webManifest(p: Project): Plugin {
  const icon = p.config.build?.icon && extname(p.config.build.icon).toLowerCase() === ".png" ? resolve(p.root, p.config.build.icon) : null;
  /** 作った絵（ファイル名 → 中身）と、マニフェストに並べるもの。元の絵が変わったら作り直す。 */
  let made: { key: string; files: Map<string, Buffer>; entries: { src: string; sizes: string; type: string; purpose?: string }[] } | null = null;
  const icons = () => {
    if (!icon || !existsSync(icon)) return null;
    const key = `${icon}:${statSync(icon).mtimeMs}`;
    if (made?.key === key) return made;
    const source = readFileSync(icon);
    const generated = pwaIcons(source);
    if (generated) {
      const any = generated.filter((g) => g.file.startsWith("icon-"));
      made = { key, files: new Map(generated.map((g) => [g.file, g.data])), entries: any.map((g) => ({ src: g.file, sizes: `${g.size}x${g.size}`, type: "image/png", ...(g.purpose ? { purpose: g.purpose } : {}) })) };
    } else {
      const size = imageSize(source);
      made = { key, files: new Map([["icon.png", source]]), entries: [{ src: "icon.png", sizes: size ? `${size.width}x${size.height}` : "512x512", type: "image/png" }] };
    }
    return made;
  };
  const manifest = () =>
    JSON.stringify({
      name: p.config.title,
      short_name: p.config.title,
      ...(p.config.description ? { description: p.config.description } : {}),
      start_url: "./",
      lang: p.config.languages?.[0] ?? "ja",
      display: "fullscreen",
      orientation: p.screen.width >= p.screen.height ? "landscape" : "portrait",
      background_color: "#000000",
      theme_color: "#000000",
      ...(icons() ? { icons: icons()!.entries } : {}),
    });
  return {
    name: "liminalia-web-manifest",
    configureServer(server) {
      server.middlewares.use("/manifest.webmanifest", (_req, res) => {
        res.setHeader("Content-Type", "application/manifest+json; charset=utf-8");
        res.end(manifest());
      });
      server.middlewares.use((req, res, next) => {
        const name = (req.url ?? "").split("?")[0]!.replace(/^\//, "");
        const data = /^(icon(-\d+|-maskable-\d+)?|apple-touch-icon)\.png$/.test(name) ? icons()?.files.get(name) : undefined;
        if (!data) return next();
        res.setHeader("Content-Type", "image/png");
        res.end(data);
      });
    },
    // ページの題、説明、アイコン（無ければ空の指定を入れ、ブラウザが /favicon.ico を探して 404 を出さないようにする）
    transformIndexHtml(html) {
      const made = icons();
      const links = made
        ? [made.files.has("icon-192.png") ? '<link rel="icon" type="image/png" sizes="192x192" href="icon-192.png" />' : '<link rel="icon" type="image/png" href="icon.png" />', ...(made.files.has("apple-touch-icon.png") ? ['<link rel="apple-touch-icon" href="apple-touch-icon.png" />'] : [])]
        : ['<link rel="icon" href="data:," />'];
      const description = p.config.description ? [`<meta name="description" content="${escapeHtml(p.config.description)}" />`] : [];
      // SNS に URL を貼ったときの題と説明（Open Graph）。絵は公開する場所の絶対の URL が要るので入れない
      const og = [`<meta property="og:type" content="website" />`, `<meta property="og:title" content="${escapeHtml(p.config.title)}" />`, ...(p.config.description ? [`<meta property="og:description" content="${escapeHtml(p.config.description)}" />`] : [])];
      return html
        .replace(/<html lang="[^"]*">/, `<html lang="${escapeHtml(p.config.languages?.[0] ?? "ja")}">`)
        .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(p.config.title)}</title>`)
        .replace(/\s*<\/head>/, `${[...description, ...og, ...links].map((l) => `\n    ${l}`).join("")}\n  </head>`);
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "manifest.webmanifest", source: manifest() });
      for (const [fileName, source] of icons()?.files ?? []) this.emitFile({ type: "asset", fileName, source });
    },
  };
}

/** 作品のプラグインの制作画面の入口（"./studio"）を、制作画面が import できる形にする（開発サーバーだけ。書き出しには入らない）。 */
export function studioModule(p: Project): Plugin {
  const id = "virtual:liminalia/studio";
  return {
    name: "liminalia-studio-plugins",
    apply: "serve",
    resolveId: (source) => (source === id ? `\0${id}` : null),
    load(resolved) {
      if (resolved !== `\0${id}`) return null;
      const lines: string[] = [];
      const names: string[] = [];
      const skip = p.pluginErrors !== undefined;
      if (skip) lines.push(SKIP_BROKEN);
      p.plugins.forEach((dir, i) => {
        const s = pluginEntry(dir, "studio");
        if (!s) return;
        lines.push(skip ? `const s${i} = await tryImport(() => import(${JSON.stringify(s)}), ${JSON.stringify(s)});` : `import s${i} from ${JSON.stringify(s)};`);
        names.push(`s${i}`);
      });
      lines.push(`export const studioPlugins = [${names.join(", ")}]${skip ? ".filter(Boolean)" : ""};`);
      return lines.join("\n");
    },
  };
}

/** 作品の CSS の仮想モジュール。 */
const WORK_CSS_ID = "virtual:liminalia/work-css";

/**
 * 作品の CSS（liminalia.json の ui.css）を、プレイヤーが import できる形にする（src/work-css.ts が <head> の終わりに当てる）。
 * ファイルごとに ?inline で読むので、Vite が中の url() と @import を解き、書き出しでは素材も束に入れる（小さな絵は data: に、ほかは engine/ に）。
 * 作品のフォルダの外のファイルと、無いファイルは読まない（lim check が知らせる）。
 * 開発サーバーでは、ファイルを保存すると Vite がこのモジュールを差し替え（自分で受ける）、プレイヤーは読み込み直さずに中身だけを替える。
 * ui.css を書き換えたとき、並べたファイルを作ったとき消したときも、このモジュールを差し替える。
 */
export function workCssModule(p: Project): Plugin {
  const resolved = `\0${WORK_CSS_ID}`;
  /** 今の ui.css（liminalia.json を読み直す）の、作品のフォルダの中のファイル。 */
  const listed = () => uiCssFiles(liveConfig(p).ui).map((file) => ({ file, path: resolve(p.root, ...file.split("/")) }));
  const present = (path: string) => existsSync(path) && statSync(path).isFile();
  return {
    name: "liminalia-work-css",
    configureServer(server) {
      const keyOf = () => JSON.stringify(listed().map((f) => [f.file, present(f.path)]));
      let key = keyOf();
      const watched = new Set<string>();
      const watch = () => {
        for (const f of listed()) {
          if (watched.has(f.path)) continue;
          watched.add(f.path);
          server.watcher.add(f.path);
        }
      };
      watch();
      const changed = (path: string) => {
        if (path !== join(p.root, "liminalia.json") && !watched.has(path)) return;
        watch();
        const next = keyOf();
        if (next === key) return;
        key = next;
        const mod = server.moduleGraph.getModuleById(resolved);
        if (mod) void server.reloadModule(mod);
      };
      server.watcher.on("change", changed);
      server.watcher.on("add", changed);
      server.watcher.on("unlink", changed);
    },
    // 並べたファイルを書き換えたとき、作ったときは、Vite の既定の伝わり方に任せず、このモジュールを差し替えるだけにする（消したファイルを
    // また作ると、前に読めなかった部品から伝わる先が見つからず、制作画面まで丸ごと読み込み直してしまう）。パスは実際の場所で比べる
    hotUpdate({ type, file, modules }) {
      if (this.environment.name !== "client" || type === "delete") return;
      const real = (path: string) => {
        try {
          return realpathSync(path);
        } catch {
          // 無いファイル（消した直後）はそのままのパスで比べる
          return path;
        }
      };
      const target = real(file);
      if (!listed().some((f) => real(f.path) === target)) return;
      const graph = this.environment.moduleGraph;
      const now = Date.now();
      for (const m of modules) graph.invalidateModule(m, new Set(), now, true);
      const mod = graph.getModuleById(resolved);
      if (mod) void this.environment.reloadModule(mod);
      return [];
    },
    resolveId: (source) => (source === WORK_CSS_ID ? resolved : null),
    load(id) {
      if (id !== resolved) return null;
      const files = listed().filter((f) => f.path.startsWith(p.root + sep) && present(f.path));
      const lines = files.map((f, i) => `import c${i} from ${JSON.stringify(`${f.path}?inline`)};`);
      lines.push(`export const workCss = [${files.map((f, i) => `{ file: ${JSON.stringify(f.file)}, css: c${i} }`).join(", ")}];`);
      // 差し替えた中身をプレイヤーへ（src/work-css.ts の WORK_CSS_EVENT）
      lines.push('if (import.meta.hot) import.meta.hot.accept((m) => { if (m) window.dispatchEvent(new CustomEvent("liminalia:work-css", { detail: m.workCss })); });');
      return lines.join("\n");
    },
  };
}

/**
 * 作品のデータ（paths.data の .json）やプラグインのコードが変わったとき、それを読むのがプレイヤーだけなら、
 * Vite の既定（開いているすべてのページの全体の読み直し）の代わりに、プレイヤーにだけ読み直しを知らせる（PLAYER_RELOAD）。
 * 制作画面は自分の画面（保存待ちの編集）を保ったまま、舞台のプレイヤーだけが読み直される。
 * 変わったモジュールを読む側をたどって制作画面の入口（virtual:liminalia/studio・@liminalia/studio の client）に届くもの、
 * CSS だけの変更（Vite がその場で差し替える）は、既定のままにする。
 */
export const PLAYER_RELOAD = "liminalia:player-reload";
/** CSS のファイル（プラグインが JS から import したものも）。 */
const CSS_FILE = /\.(css|scss|sass|less|styl|stylus|pcss|postcss)$/;
export function playerOnlyReload(): Plugin {
  const inStudio = (id: string) => id.includes("virtual:liminalia/studio") || /[\\/]packages[\\/]studio[\\/]src[\\/]client[\\/]/.test(id) || id.includes("@liminalia/studio/client");
  /**
   * Vite がその場で差し替える CSS か。JS から import した CSS（プラグインの CSS）は種類が js の部品になるが、自分で差し替えを受けるので
   * その場で直る（開いているプレイヤーを読み直さない）。CSS Modules と ?inline などで読んだものは、読む側の JS が要るので読み直す。
   */
  const inPlaceCss = (m: { type: string; file: string | null; isSelfAccepting?: boolean | undefined }) => m.type === "css" || (m.isSelfAccepting === true && !!m.file && CSS_FILE.test(m.file) && !/\.module\./.test(m.file));
  return {
    name: "liminalia-player-only-reload",
    apply: "serve",
    handleHotUpdate({ file, modules, server }) {
      if (modules.length === 0 || modules.every(inPlaceCss)) return;
      // 作品の CSS（ui.css）は、読む側の仮想モジュールが自分で差し替えを受ける（workCssModule）
      // 作品の画面の JS も、読む側の仮想モジュールが差し替えを受ける（screen-scripts-module.ts）
      if (modules.every((m) => m.importers.size > 0 && [...m.importers].every((i) => i.id === `\0${WORK_CSS_ID}` || i.id === `\0${SCREEN_SCRIPTS_ID}`))) return;
      const seen = new Set<unknown>();
      const queue = [...modules];
      while (queue.length > 0) {
        const m = queue.pop()!;
        if (seen.has(m)) continue;
        seen.add(m);
        if (inStudio(m.id ?? m.url)) return;
        queue.push(...m.importers);
      }
      for (const m of seen) server.moduleGraph.invalidateModule(m as (typeof modules)[number]);
      server.ws.send({ type: "custom", event: PLAYER_RELOAD, data: { file } });
      return [];
    },
  };
}

// 制作画面の訳の画面に、システム画面の文言を英語の原文と並べさせる（制作画面は描画側を読まないので、ここで渡す）
setUiStringTable(uiStringTable());
// 制作画面の「ゲームの画面」に、標準の画面の一覧と見本の開き方を渡す
setScreenTable(screenPreviewTable());
// チェックに、標準の画面の決まり（作品の画面のテンプレートを確かめる）を渡す
setScreenTemplateRules(screenTemplateRules());

export default defineConfig({
  // テスト版の指摘の口（lim build --feedback が LIMINALIA_FEEDBACK を置く）。false なら src/feedback.ts は束に入らない
  define: { __LIMINALIA_FEEDBACK__: JSON.stringify(process.env.LIMINALIA_FEEDBACK === "1"), __LIMINALIA_ANALYTICS__: JSON.stringify(process.env.LIMINALIA_ANALYTICS === "1") },
  plugins: [
    closeEditorOpener(),
    projectModule(project),
    workCssModule(project),
    screenScriptsModule(project, () => Object.keys(STANDARD_SCREENS)),
    flowJson(project),
    webManifest(project),
    studioModule(project),
    playerOnlyReload(),
    serve("/project/scenario", project.paths.scenario),
    serve("/project/data", project.paths.data),
    serve("/project/cast.json", project.paths.cast, true),
    serve("/project/lang", project.paths.lang),
    serve("/assets", project.paths.assets),
    casterServer(project, webRoot),
    // 制作画面の口（studioServer）は STUDIO_API の下をすべて受けるので、「取り込み直す」の口を先に置く
    importServer(project),
    studioServer(project, webRoot),
  ],
  resolve: { dedupe: ["@liminalia/lang", "@liminalia/runtime", "@liminalia/sdk", "@liminalia/plugin-host", "@liminalia/web", "@liminalia/ks-import", "@liminalia/std", "@liminalia/studio"] },
  server: {
    port: Number(process.env.PORT ?? 5180),
    // 別の番号の localhost のページから、作品の台本と素材を読ませない（制作画面とゲームは同じオリジンから読む）
    cors: false,
    strictPort: false,
    // 素材のフォルダを作品の外に置いた（paths.assets）、作品の外へのリンクにした作品でも、CSS の url() やプラグインの import が指す素材を配る
    // （素材のフォルダと、その中のリンクの行き先だけ。dev-allow.ts）
    fs: { allow: [webRoot, join(webRoot, "../.."), project.root, project.paths.assets, ...project.plugins, ...linkedAllowDirs({ root: project.root, assets: project.paths.assets })] },
  },
});
