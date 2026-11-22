import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { PLUGIN_API_VERSION } from "@liminalia/lang";
import { pluginEntry, resolvePackageDir } from "@liminalia/project";
import type { CatalogInstallResult, CatalogPluginInfo, PartWrite, PluginInfo, PluginPart } from "../protocol.ts";
import { compareVersions, copyPluginFolder, readCatalog, type CatalogItem } from "./catalog.ts";
import { updateConfigPart } from "./manage-shared.ts";
import { BACKUP_DIR, versionStamp, writeAtomic } from "./versions.ts";
import { StudioError, type StudioWorkspace } from "./workspace.ts";

// ---- プラグイン ----

/** 作品のプラグイン（liminalia.json の plugins）と、その中身。 */
export function listPlugins(ws: StudioWorkspace): PluginInfo[] {
  const specs = ws.readConfig().plugins ?? [];
  // 読み込めずに外したプラグインは、上の帯とチェックと同じ理由で出す（Node の生の文を出さない）
  const broken = new Map((ws.project.pluginErrors ?? []).map((e) => [e.spec, e.message]));
  return specs.map((spec) => {
    let dir: string | null = null;
    try {
      dir = resolvePackageDir(ws.project.root, spec);
      if (!existsSync(dir)) throw new Error("フォルダがありません");
      if (!existsSync(join(dir, "package.json"))) throw new Error("package.json がありません");
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string; description?: string };
      const entries = (["commands", "web", "import", "studio", "studio-server"] as const).filter((e) => pluginEntry(dir!, e) !== null);
      const commands = Object.entries(ws.commandSources).filter(([, source]) => source === pkg.name).map(([name]) => name).sort();
      const error = broken.get(spec);
      return { spec, name: pkg.name ?? spec, version: pkg.version ?? "", description: pkg.description ?? "", entries, commands, loaded: !error && (ws.project.config.plugins?.includes(spec) ?? false), local: isLocalPlugin(ws, dir), ...(error ? { error } : {}) };
    } catch (e) {
      const error = broken.get(spec) ?? (dir === null ? "パッケージが見つかりません" : e instanceof Error ? e.message : String(e));
      return { spec, name: spec, version: "", description: "", entries: [], commands: [], loaded: false, local: false, error };
    }
  });
}

/**
 * 作品のプラグインの並びを書く。読めないプラグインは書かない。起動し直すと効く。前の内容は変更履歴に残す。
 * baseHash（読んだときの PluginList.hash）を渡したときは、読んだあとにほかで変わっていれば書かずに今の並びを返す。
 */
export function setPlugins(ws: StudioWorkspace, specs: string[], baseHash?: string): PartWrite<string[]> {
  for (const spec of specs) {
    let dir: string;
    try {
      dir = resolvePackageDir(ws.project.root, spec);
    } catch {
      throw new StudioError(400, `プラグイン ${spec} が見つかりません。プロジェクトのフォルダからの相対パス（"./plugins/…"）、プロジェクトの外のフォルダの絶対パス、インストールしたパッケージの名前のどれかを指定します`);
    }
    if (!existsSync(join(dir, "package.json"))) throw new StudioError(400, `プラグイン ${spec} に package.json がありません`);
  }
  if (new Set(specs).size !== specs.length) throw new StudioError(400, "同じプラグインが重複しています");
  const r = updateConfigPart(ws, (raw) => (raw.plugins ?? []) as string[], baseHash, (raw) => {
    if (specs.length === 0) delete raw.plugins;
    else raw.plugins = specs;
  });
  return r;
}

/** 作品のフォルダの中に置いたプラグインか（入れたパッケージ＝node_modules の中のものは書き換えない）。 */
function isLocalPlugin(ws: StudioWorkspace, dir: string): boolean {
  const rel = relative(ws.project.root, dir);
  return !rel.startsWith("..") && !rel.split(sep).includes("node_modules");
}

/** 作品のフォルダの中のプラグインのフォルダ（入れたパッケージなら 400）。 */
export function localPluginDir(ws: StudioWorkspace, spec: string): string {
  if (!(ws.readConfig().plugins ?? []).includes(spec)) throw new StudioError(404, `プラグイン ${spec} はこのプロジェクトにありません`);
  const dir = resolvePackageDir(ws.project.root, spec);
  if (!isLocalPlugin(ws, dir)) throw new StudioError(400, `プラグイン ${spec} はインストールしたパッケージのため、ここでは編集できません`);
  return dir;
}

/** プラグインの名前と説明（package.json の name・description）を書き換える。ほかの項目はそのまま。 */
export function updatePlugin(ws: StudioWorkspace, spec: string, change: { name?: string; description?: string }): void {
  const dir = localPluginDir(ws, spec);
  const path = join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (change.name !== undefined) {
    const name = change.name.trim();
    if (!PACKAGE_NAME.test(name)) throw new StudioError(400, `名前 ${name} は使えません（英小文字、数字、- と、@スコープ/名前の形）`);
    pkg.name = name;
  }
  if (change.description !== undefined) {
    const description = change.description.trim();
    if (description) pkg.description = description;
    else delete pkg.description;
  }
  writeAtomic(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
/** 新しく作るプラグインの名前（plugins/ の下のフォルダの名前・命令の名前の頭にもなる）。 */
const NEW_PLUGIN_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * 新しいプラグインを plugins/<名前> に作り、liminalia.json の plugins の最後に足す（起動し直すと効く）。
 * 中身は動く小さな例: 命令（@名前-hello。web があれば画面に文を出す）と、制作画面のタブ。
 * language が "en"（英語の制作画面から作るとき）なら、要約、例の文、コメントを英語で書く。
 */
export function createPlugin(ws: StudioWorkspace, name: string, parts: PluginPart[], language: "ja" | "en" = "ja"): string {
  if (!NEW_PLUGIN_NAME.test(name)) throw new StudioError(400, `名前 ${name} は使えません（英小文字で始め、英小文字、数字、- だけを使います）`);
  const spec = `./plugins/${name}`;
  const dir = join(ws.project.root, "plugins", name);
  if (existsSync(dir)) throw new StudioError(409, `plugins/${name} はすでにあります`);
  const specs = ws.readConfig().plugins ?? [];
  if (specs.includes(spec)) throw new StudioError(409, `${spec} はすでに追加されています`);
  const want = new Set<PluginPart>(["commands", ...parts]);
  const files = pluginTemplate(name, want, language === "en");
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeAtomic(join(dir, file), text);
  }
  setPlugins(ws, [...specs, spec]);
  return spec;
}

// ---- 公式のプラグイン（同梱の一覧から入れる。./catalog.ts） ----

/** 入れ直す前の版を残す数（プラグインごと）。 */
const PLUGIN_BACKUP_KEEP = 3;

/** 作品の plugins/<id> に入っているもの（同じパッケージなら版、別のものなら other）。 */
function installedCatalogPlugin(ws: StudioWorkspace, item: CatalogItem): { version: string | null; other?: string } {
  const file = join(ws.project.root, "plugins", item.entry.id, "package.json");
  if (!existsSync(join(ws.project.root, "plugins", item.entry.id))) return { version: null };
  try {
    const pkg = JSON.parse(readFileSync(file, "utf8")) as { name?: string; version?: string };
    if (pkg.name !== item.packageName) return { version: null, other: pkg.name ?? item.entry.id };
    return { version: pkg.version ?? "" };
  } catch {
    // 入っているものの package.json が読めなければ、別のものとして上書きを確かめる
    return { version: null, other: item.entry.id };
  }
}

/** 公式のプラグインの一覧と、作品に入れてあるかどうか。catalog は一覧のフォルダ（catalogDir()）。 */
export function catalogPlugins(ws: StudioWorkspace, catalog: string | null): CatalogPluginInfo[] {
  const specs = ws.readConfig().plugins ?? [];
  return readCatalog(catalog).map((item) => {
    const { entry } = item;
    const installed = installedCatalogPlugin(ws, item);
    const error = !item.dir
      ? `同梱のフォルダが見つかりません（${entry.folderEnv ? `環境変数 ${entry.folderEnv} か、` : ""}${entry.folder}）`
      : installed.other
        ? `plugins/${entry.id} に別のプラグイン（${installed.other}）があるため入れられません`
        : undefined;
    return {
      id: entry.id,
      name: entry.name,
      nameEn: entry.nameEn,
      description: entry.description,
      descriptionEn: entry.descriptionEn,
      version: item.version,
      entries: item.entries,
      installed: installed.version,
      added: specs.includes(`./plugins/${entry.id}`),
      update: installed.version !== null && item.version !== "" && compareVersions(item.version, installed.version) > 0,
      ...(error ? { error } : {}),
      ...(!item.dir ? { unavailable: true as const } : {}),
    };
  });
}

/**
 * 公式のプラグインを作品の plugins/<id> に写し、liminalia.json の plugins に ./plugins/<id> を足す（起動し直すと効く）。
 * すでに入れてあれば入れ直す（前の版は .liminalia/backups/plugins/<id>-<日時> に残す）。
 */
export function installPlugin(ws: StudioWorkspace, catalog: string | null, id: string): CatalogInstallResult {
  const item = readCatalog(catalog).find((i) => i.entry.id === id);
  if (!item) throw new StudioError(404, `公式のプラグイン ${id} はありません`);
  if (!item.dir) throw new StudioError(404, `公式のプラグイン ${id} のフォルダが見つかりません`);
  const installed = installedCatalogPlugin(ws, item);
  if (installed.other) throw new StudioError(409, `plugins/${id} に別のプラグイン（${installed.other}）があります。フォルダの名前を変更してから入れてください`);
  const dest = join(ws.project.root, "plugins", id);
  if (existsSync(dest)) {
    const backups = join(ws.project.root, BACKUP_DIR, "plugins");
    mkdirSync(backups, { recursive: true });
    renameSync(dest, join(backups, `${id}-${versionStamp(new Date())}`));
    const old = readdirSync(backups).filter((n) => n.startsWith(`${id}-`)).sort().reverse();
    for (const name of old.slice(PLUGIN_BACKUP_KEEP)) rmSync(join(backups, name), { recursive: true, force: true });
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyPluginFolder(item.dir, dest);
  const spec = `./plugins/${id}`;
  const specs = ws.readConfig().plugins ?? [];
  if (!specs.includes(spec)) setPlugins(ws, [...specs, spec]);
  return { spec, version: item.version };
}

/** ひな形が読むパッケージ（プラグインとの約束 @liminalia/sdk の入口。制作画面のサーバーは描画側を読まないので、名前は文字列として書く）。 */
const TEMPLATE_PACKAGES = { sdk: "@liminalia/sdk", web: "@liminalia/sdk/web", studio: "@liminalia/sdk/studio" };

function pluginTemplate(name: string, parts: Set<PluginPart>, english = false): Record<string, string> {
  const tr = (ja: string, en: string) => (english ? en : ja);
  const from = (pkg: keyof typeof TEMPLATE_PACKAGES) => JSON.stringify(TEMPLATE_PACKAGES[pkg]);
  const exports: Record<string, string> = {};
  for (const part of ["commands", "web", "studio"] as const) if (parts.has(part)) exports[`./${part}`] = `./src/${part}.ts`;
  const command = `${name}-hello`;
  const files: Record<string, string> = {
    // engines.liminalia: 合うエンジンの口の版（今の版から。lim check が合わないエンジンで知らせる）
    "package.json": `${JSON.stringify({ name, version: "0.0.0", private: true, type: "module", engines: { liminalia: `>=${PLUGIN_API_VERSION}` }, exports }, null, 2)}\n`,
    "src/commands.ts": [
      `import { defineCommandPlugin, t, type CommandDefinition } from ${from("sdk")};`,
      ``,
      tr(`/** コマンドの例。書き方は Liminalia の docs/plugins.md の「命令」。 */`, `/** An example command. See the ./commands section of docs/plugins.md in Liminalia. */`),
      `const hello: CommandDefinition = {`,
      `  name: "${command}",`,
      tr(`  summary: "画面に短いテキストを表示する（例）",`, `  summary: "Show a short text on the screen (an example)",`),
      `  positional: ["text"],`,
      `  params: {`,
      tr(`    text: t.string("表示するテキスト", "こんにちは"),`, `    text: t.string("Text to show", "Hello"),`),
      `  },`,
      tr(`  example: "@${command} こんにちは",`, `  example: "@${command} Hello",`),
      `};`,
      ``,
      `export default defineCommandPlugin({ name: "${name}", commands: [hello] });`,
      ``,
    ].join("\n"),
  };
  if (parts.has("web")) {
    files["src/web.ts"] = [
      `import { defineWebPlugin } from ${from("web")};`,
      ``,
      tr(`/** コマンドの描画。書き方は Liminalia の docs/plugins.md の「描画」。 */`, `/** How the command is drawn. See the ./web section of docs/plugins.md in Liminalia. */`),
      `export default defineWebPlugin({`,
      `  name: "${name}",`,
      `  extensions: {`,
      `    renderers: {`,
      `      "${command}": async (ctx, args) => {`,
      `        const el = document.createElement("div");`,
      `        el.textContent = String(args.text);`,
      `        Object.assign(el.style, { position: "absolute", left: "50%", top: "40%", translate: "-50% 0", padding: "12px 24px", background: "rgb(0 0 0 / 0.6)", color: "#fff", borderRadius: "8px" });`,
      `        ctx.layers.overlay.append(el);`,
      `        await el.animate([{ opacity: 1 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }], { duration: ctx.time(1600) }).finished;`,
      `        el.remove();`,
      `      },`,
      `    },`,
      `  },`,
      `});`,
      ``,
    ].join("\n");
  }
  if (parts.has("studio")) {
    files["src/studio.ts"] = [
      `import { defineStudioPlugin } from ${from("studio")};`,
      ``,
      tr(
        `/** Studio に追加する画面（プラグインのタブに表示される）。書き方は Liminalia の docs/plugins.md の「制作画面」。 */`,
        `/** A screen added to Studio (shown on the Plugins tab). See the ./studio section of docs/plugins.md in Liminalia. */`,
      ),
      `export default defineStudioPlugin({`,
      `  name: "${name}",`,
      `  views: [`,
      `    {`,
      `      id: "${name}",`,
      `      title: "${name}",`,
      `      mount(el, ctx) {`,
      `        const p = document.createElement("p");`,
      `        p.style.padding = "16px";`,
      tr(
        `        p.textContent = \`\${ctx.project.title}: \${ctx.project.files.length} ファイル\`;`,
        `        p.textContent = \`\${ctx.project.title}: \${ctx.project.files.length} \${ctx.project.files.length === 1 ? "file" : "files"}\`;`,
      ),
      `        el.append(p);`,
      `      },`,
      `    },`,
      `  ],`,
      `});`,
      ``,
    ].join("\n");
  }
  return files;
}
