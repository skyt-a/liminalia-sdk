import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { screenScriptFile } from "@liminalia/lang";
import type { Project } from "@liminalia/project";
import type { Plugin } from "vite";
import { liveConfig } from "./player-info.ts";

/**
 * 作品の画面の JS（virtual:liminalia/screen-scripts。docs/design/screen-templates.md の「画面の JS」）。
 * 画面ごとに、テンプレートと同じ場所の同じ名前の .js（登録が無ければ ui/screens/<画面>/<画面>.js）が作品のフォルダの中にあれば読む。
 * 作品のプラグイン（plugins: ["."]）と同じ扱いで、制限付き（--restricted、LIMINALIA_RESTRICTED=1）では読まない。
 *
 * - 書き出しでは束に入る（作品のフォルダの ui/ は写さない）
 * - 開発サーバーでは、JS を保存すると、この仮想モジュールが差し替えを受けてプレイヤーに渡す（読み込み直さない。次に開いた画面から効く。
 *   src/screen-scripts.ts）。JS を足した、消した、ui.templates を書き換えたときも、作り直して渡す
 * - 読む画面の名前は、呼ぶ側が渡す（標準の画面の一覧。@liminalia/web/screen-rules の STANDARD_SCREENS の鍵）
 */
export const SCREEN_SCRIPTS_ID = "virtual:liminalia/screen-scripts";
/** 差し替えたときにプレイヤーへ送る出来事（src/screen-scripts.ts が受ける）。 */
export const SCREEN_SCRIPTS_EVENT = "liminalia:screen-scripts";

/** 今ある画面の JS（画面の名前と絶対パス）。制限付きなら空。 */
export function screenScriptFiles(p: Project, screens: readonly string[]): { screen: string; path: string }[] {
  if (p.restricted) return [];
  const templates = (liveConfig(p).ui as { templates?: unknown } | undefined)?.templates;
  const out: { screen: string; path: string }[] = [];
  for (const screen of screens) {
    const path = resolve(p.root, ...screenScriptFile(templates, screen).split("/"));
    const rel = relative(resolve(p.root), path);
    if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) continue;
    if (existsSync(path) && statSync(path).isFile()) out.push({ screen, path });
  }
  return out;
}

/** 仮想モジュールの中身。 */
export function screenScriptsSource(files: readonly { screen: string; path: string }[]): string {
  const lines = files.map((f, i) => `import s${i} from ${JSON.stringify(f.path)};`);
  lines.push(`export const screenScripts = { ${files.map((f, i) => `${JSON.stringify(f.screen)}: s${i}`).join(", ")} };`);
  lines.push(`if (import.meta.hot) import.meta.hot.accept((m) => { if (m) window.dispatchEvent(new CustomEvent(${JSON.stringify(SCREEN_SCRIPTS_EVENT)}, { detail: m.screenScripts })); });`);
  return lines.join("\n");
}

export function screenScriptsModule(p: Project, screens: () => readonly string[]): Plugin {
  const resolved = `\0${SCREEN_SCRIPTS_ID}`;
  /** 見る場所（画面ごとの JS の場所。ui.templates で変わる）。 */
  const candidates = () => {
    const templates = (liveConfig(p).ui as { templates?: unknown } | undefined)?.templates;
    return screens().map((screen) => resolve(p.root, ...screenScriptFile(templates, screen).split("/")));
  };
  return {
    name: "liminalia-screen-scripts",
    configureServer(server) {
      if (p.restricted) return;
      const keyOf = () => JSON.stringify(screenScriptFiles(p, screens()));
      let key = keyOf();
      const watched = new Set<string>();
      const watch = () => {
        for (const c of candidates()) {
          if (watched.has(c)) continue;
          watched.add(c);
          server.watcher.add(c);
        }
      };
      watch();
      // 中身の書き換えは、読む側（この仮想モジュール）が差し替えを受ける。足した、消した、場所が変わったときは作り直す
      const changed = (path: string) => {
        if (path !== join(p.root, "liminalia.json") && !watched.has(path)) return;
        watch();
        const next = keyOf();
        if (next === key) return;
        key = next;
        const mod = server.moduleGraph.getModuleById(resolved);
        if (mod) void server.reloadModule(mod);
      };
      server.watcher.on("add", changed);
      server.watcher.on("unlink", changed);
      server.watcher.on("change", changed);
    },
    resolveId: (source) => (source === SCREEN_SCRIPTS_ID ? resolved : null),
    load(id) {
      if (id !== resolved) return null;
      return screenScriptsSource(screenScriptFiles(p, screens()));
    },
  };
}
