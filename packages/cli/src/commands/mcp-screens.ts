import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { containedPath } from "@liminalia/project/contained-path";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkScreenTemplates, checkUiCss, uiCssFiles, uiCssPathProblem, UI_CSS_DEFAULT, type Diagnostic } from "@liminalia/lang";
import { loadProject, projectFileReader } from "@liminalia/project";
import { copyScreen, diffScreen, screenRegistered, screenScriptPath, screenTemplatePath, splitTemplateParts } from "@liminalia/project/screen-copy";
import { pluginScreens } from "@liminalia/project/screen-templates";
import { screenTemplateRules } from "@liminalia/web/screen-rules";
import { screenDiffText, screenOverriddenBy } from "./screens.ts";
import type { ScreenSampleState } from "@liminalia/studio/protocol";
import { planScreenShot, SCREEN_STATES, screenList, type ScreenShotOptions, type ScreenShotResult } from "./shot-screen.ts";
import { both, need, PROJECT_PARAM as project, str, text, ToolError, type Tool, type ToolResult } from "./mcp-tools.ts";
import { engineVersion } from "../version.ts";

/**
 * lim mcp の道具のうち、標準の画面（セーブ、コンフィグ、結末など）を見る道具（list_screens と screen_shot）。
 * 作者に「スロットを横並びにして」などと頼まれたアシスタントが、直す値を選び、直した結果を自分の目で確かめるためのもの。
 * 撮るのは lim shot --screen（shot-screen.ts）を子のプロセスで動かす（開発サーバーの経過が MCP の通信に混ざらないように）。
 *
 * 画面の形を変えるときの道具（copy_screen、read_screen_files、write_screen_file、diff_screen）も置く。標準の画面のテンプレートを作品に写し
 * （lim screens copy と同じ。@liminalia/project/screen-copy）、テンプレートと作品の CSS と画面の JS を読み書きし、書いたらテンプレートの検査
 * （lim check と同じ checkScreenTemplates と checkUiCss）を流して返す。「写す → 直す → 撮って確かめる（screen_shot）」の流れ。
 */

export interface ScreensHost {
  /** 作品のフォルダ（置き場の中にあり、liminalia.json がある）。 */
  project(args: Record<string, unknown>): string;
  /** lim のコマンドを子のプロセスで動かす。 */
  lim(args: string[], timeoutMs?: number): Promise<{ code: number; out: string }>;
  /** 画面なしで撮る道具（playwright-core と Chromium）が無ければ、その理由。そろっていれば null。 */
  headlessMissing(): Promise<string | null>;
}

/** 道具の引数から、撮るものを決める（確かめは planScreenShot）。 */
function shotOptions(args: Record<string, unknown>): ScreenShotOptions {
  const state = str(args, "state") ?? "filled";
  if (!(SCREEN_STATES as readonly string[]).includes(state)) throw new ToolError(`state は ${SCREEN_STATES.join("、")} のどれかです`);
  const orientation = str(args, "orientation");
  if (orientation !== undefined && orientation !== "portrait" && orientation !== "landscape") throw new ToolError("orientation は portrait か landscape です");
  const lang = str(args, "lang");
  const theme = str(args, "theme");
  return {
    screen: need(args, "screen"),
    state: state as ScreenSampleState,
    ...(orientation ? { orientation } : {}),
    ...(lang ? { language: lang } : {}),
    ...(theme ? { theme } : {}),
  };
}

/** lim shot --json の出力（前に経過の行があっても、最初の { から読む）。読めなければ null。 */
function shotJson(out: string): ScreenShotResult | null {
  const at = out.search(/^\{/m);
  if (at < 0) return null;
  try {
    return JSON.parse(out.slice(at)) as ScreenShotResult;
  } catch {
    // JSON でなければ（途中で止まったなど）、呼ぶ側が出力をそのまま返す
    return null;
  }
}

/** 作品の liminalia.json（書き換えるときに読む）。 */
function readConfig(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown>;
}

/** 診断を道具の返す形にする。 */
const brief = (list: readonly Diagnostic[]) => list.map(({ severity, code, message, file, line, hint }) => ({ severity, code, message, file, line, ...(hint ? { hint } : {}) }));

/** その画面のテンプレートと画面の JS の検査（lim check と同じ）。その画面のファイルと、liminalia.json のその画面の行のものだけ。 */
function screenDiagnostics(dir: string, screen: string): Diagnostic[] {
  const raw = readConfig(dir);
  const ui = raw.ui as { templates?: unknown; system?: { preset?: unknown } } | undefined;
  const preset = typeof ui?.system?.preset === "string" ? ui.system.preset : undefined;
  const files = new Set([screenTemplatePath(ui, screen), screenScriptPath(ui, screen)]);
  const all = checkScreenTemplates({
    templates: ui?.templates,
    rules: screenTemplateRules(),
    read: projectFileReader(dir).text,
    plugins: pluginScreens(dir, Array.isArray(raw.plugins) ? (raw.plugins as string[]) : []),
    ...(preset !== undefined ? { preset } : {}),
  });
  return all.filter((d) => (d.file !== undefined && files.has(d.file)) || (d.file === "liminalia.json" && d.message.includes(`ui.templates.${screen} `)));
}

/** 画面の名前を確かめる（テンプレートで作れる画面だけ）。 */
function templateScreen(args: Record<string, unknown>): string {
  const screen = need(args, "screen");
  const screens = Object.keys(screenTemplateRules().screens);
  if (!screens.includes(screen)) throw new ToolError(`${screen} はテンプレートで作れる画面ではありません（テンプレートで作れる画面: ${screens.join("、")}）`);
  return screen;
}

const SCREEN_PARAM = { type: "string", description: both("テンプレートで作れる画面の名前（confirm など。read_screen_files で決まりを見る）", "Name of a screen that can be built from a template (such as confirm)") } as const;

export function screenTools(host: ScreensHost): Tool[] {
  return [
    {
      name: "list_screens",
      description: both(
        "標準の画面（セーブ、コンフィグ、バックログ、結末など）の一覧を JSON で返す。画面ごとに、id と名前、見本で開けるか（開けなければ why）、選べる状態（states）、部品の表（parts。部品の名前、CSS のセレクタ、見た目を決めるテーマの値のパスと CSS の変数）、テーマの値（theme。liminalia.json の ui のパス）、文言のキー（texts）、CSS のクラス（classes）と変数（vars。systemVars が true なら共通の systemVars も効く）、差し替えフック（replace。プラグインの WebPlugin のフック）。project を渡すと選べるテーマ（themes）も返す。screen で一つに絞れる。変える値を選んだら update_settings で ui を編集し、screen_shot で確認する。",
        "Returns the built-in screens (save, settings, log, ending and so on) as JSON. For each screen: id and name, whether it opens with sample content (why if not), the states you can pick (states), the parts table (parts: part name, CSS selector, and the theme value paths and CSS variables that decide its look), theme values (theme: paths in ui of liminalia.json), text keys (texts), CSS classes (classes) and variables (vars; when systemVars is true, the shared systemVars apply too), and replacement hooks (replace: WebPlugin hooks for plugins). With project, the themes you can pick (themes) are returned too. screen narrows it to one screen. After picking the values to change, edit ui with update_settings and check with screen_shot.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          project: { ...project, description: both("プロジェクト（省くとテーマの一覧を返さない）", "Project (omit to leave out the theme list)") },
          screen: { type: "string", description: both("一つの画面の id（省くとすべて）", "id of one screen (omit for all)") },
        },
      },
      run: async (args) => {
        const dir = str(args, "project") !== undefined ? host.project(args) : null;
        const list = screenList(dir ? loadProject(dir) : null);
        const id = str(args, "screen");
        if (id === undefined) return text(JSON.stringify(list));
        const screen = list.screens.find((s) => s.id === id);
        if (!screen) throw new ToolError(`${id} という標準の画面はありません（あるもの: ${list.screens.map((s) => s.id).join("、")}）`);
        return text(JSON.stringify({ ...list, screens: [screen] }, null, 2));
      },
    },
    {
      name: "screen_shot",
      description: both(
        "標準の画面（list_screens の id）を、サンプルデータ（セーブデータ、バックログ、おまけなど）を入れた状態で開いて撮り、画像で返す（lim shot --screen。Studio の「ゲームの画面」と同じ見本）。state は filled（入った状態）、empty（空）、long（長い文と長い名前）。orientation で縦長と横長を入れ替え、lang でプレイ言語（en なら英語）、theme でテーマを適用して撮る。プロジェクトの liminalia.json とセーブデータには保存しない。開けなければ理由と problems を返す。撮れても、画面が見えない、画面を覆うもの（ロードの幕、全画面の演出の層）が残っている、サンプルデータが出ていないときは、画像を添えて ok を false にし、problems に理由を出す（エラーとして返す）。プラグインが差し替えた画面なら replacedBy にプラグインの名前を添える。画面なしの Chromium が要る。",
        "Opens a built-in screen (an id from list_screens) with sample content (save data, the log, extras and so on), captures it and returns the image (lim shot --screen; the same sample as Game screens in Studio). state is filled, empty or long (long text and long names). orientation swaps portrait and landscape, lang sets the play language (en for English) and theme applies a theme. Nothing is saved to liminalia.json or the save data. If it can't open, the reason and problems are returned. If it captures but the screen isn't visible, something still covers it (a load curtain or a full-screen effect layer) or the sample content isn't showing, the image comes back with ok set to false and the reasons in problems, as an error. If a plugin replaces the screen, replacedBy names the plugin. Needs a headless Chromium.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          project,
          screen: { type: "string", description: both("画面の id（list_screens の id。saveload、config、backlog、ending など）", "Screen id (an id from list_screens, such as saveload, config, backlog or ending)") },
          state: { type: "string", enum: [...SCREEN_STATES], description: both("中身（既定は filled。empty と long は list_screens の states にある画面だけ）", "Content (filled by default; empty and long only for screens that list them in states)") },
          orientation: { type: "string", enum: ["portrait", "landscape"], description: both("画面の向き（省くとプロジェクトのまま。違う向きなら幅と高さを入れ替えて撮る）", "Screen orientation (omit for the project's own; the other orientation swaps width and height)") },
          lang: { type: "string", description: both("遊ぶ言語（en なら標準の画面の文言と作り物の中身を英語に。プロジェクトの languages に無くてもよい）", "Play language (en for English built-in text and sample content; it doesn't have to be in the project's languages)") },
          theme: { type: "string", description: both("当てるテーマ（ui.system.preset の名前かプロジェクトの themes/<id>。list_screens の themes）", "Theme to apply (a ui.system.preset name or the project's themes/<id>; themes in list_screens)") },
        },
        required: ["project", "screen"],
      },
      run: async (args): Promise<ToolResult> => {
        const dir = host.project(args);
        const o = shotOptions(args);
        // 撮る前に確かめる（知らない画面、開けない画面、無い状態とテーマは、Chromium を立てずに選べるものを返す）
        try {
          planScreenShot(loadProject(dir), o);
        } catch (e) {
          throw new ToolError(e instanceof Error ? e.message : String(e));
        }
        const missing = await host.headlessMissing();
        if (missing) return text(`${missing}\n標準の画面は画面なしの Chromium で撮ります（npx playwright install chromium-headless-shell で入れるか、環境変数 LIMINALIA_CHROMIUM に場所を書いてください）。`, true);
        const tmp = mkdtempSync(join(tmpdir(), "liminalia-mcp-screen-"));
        const out = join(tmp, "screen.png");
        try {
          const flags = [
            "--screen",
            o.screen,
            "--state",
            o.state,
            ...(o.orientation === "portrait" ? ["--portrait"] : o.orientation === "landscape" ? ["--landscape"] : []),
            ...(o.language ? ["--lang", o.language] : []),
            ...(o.theme ? ["--theme", o.theme] : []),
          ];
          const r = await host.lim(["shot", dir, ...flags, "--out", out, "--json"], 180_000);
          const result = shotJson(r.out);
          if (!result) return text(r.out || "撮れませんでした", true);
          // 画像のファイルは返したら消すので、パスは返さない
          const about: Partial<ScreenShotResult> = { ...result };
          delete about.out;
          if (!existsSync(out) || !result.out) return text(JSON.stringify(about, null, 2), true);
          const content: ToolResult["content"] = [{ type: "image", data: readFileSync(out).toString("base64"), mimeType: "image/png" }, { type: "text", text: JSON.stringify(about, null, 2) }];
          // 撮れたが確かめ（画面が見える、覆うものが無い、中身がある）を通らなければ、画像を添えて道具のエラーにする
          return result.ok ? { content } : { content, isError: true };
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
    {
      name: "copy_screen",
      description: both(
        "標準の画面のテンプレートをプロジェクトにコピーし（lim screens copy と同じ）、liminalia.json の ui.templates に登録し、コピー元の内容を .liminalia/screens/ に残す。parts で部品だけをコピーする（あるファイルに部品を足す）。js で画面の JS の雛形もテンプレートの隣に置く。あるファイル（部品）は force が無ければ書かない。結果のファイル、コピーした部品、登録したか、プラグインの screens.* が優先されるなら overriddenBy、コピー後のテンプレートのチェック（diagnostics）を返す。コピーしたら read_screen_files で読み、write_screen_file で編集し、screen_shot で撮って確認する。",
        "Copies a built-in screen template into the project (same as lim screens copy), registers it in ui.templates of liminalia.json and keeps the copied original in .liminalia/screens/. parts copies only those parts (adding them to an existing file). js also puts a screen JS skeleton next to the template. Existing files (parts) aren't rewritten without force. Returns the file, the copied parts, whether it was registered, overriddenBy when a plugin's screens.* comes first, and the template check after copying (diagnostics). Then read it with read_screen_files, edit it with write_screen_file and check it with screen_shot.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          project,
          screen: SCREEN_PARAM,
          parts: { type: "array", items: { type: "string" }, description: both("コピーする部品の名前（省くと画面の全体）", "Names of the parts to copy (omit for the whole screen)") },
          js: { type: "boolean", description: both("画面の JS の雛形も置く", "Also put a screen JS skeleton") },
          force: { type: "boolean", description: both("あるファイル（部品）を書き直す", "Rewrite existing files (parts)") },
        },
        required: ["project", "screen"],
      },
      run: async (args) => {
        const dir = host.project(args);
        const screen = templateScreen(args);
        const parts = Array.isArray(args.parts) ? args.parts.filter((p): p is string => typeof p === "string") : [];
        let r;
        try {
          r = copyScreen(dir, screenTemplateRules().screens, screen, { ...(parts.length > 0 ? { parts } : {}), force: args.force === true, js: args.js === true, engine: engineVersion() });
        } catch (e) {
          throw new ToolError(e instanceof Error ? e.message : String(e));
        }
        const by = screenOverriddenBy(dir, screen);
        return text(JSON.stringify({ ...r, ...(by ? { overriddenBy: by } : {}), diagnostics: brief(screenDiagnostics(dir, screen)) }, null, 2));
      },
    },
    {
      name: "read_screen_files",
      description: both(
        "画面のファイルを読む: プロジェクトのテンプレート（template。登録した場所か既定の場所。無ければ text は null）、現在の標準テンプレート（standard）と部品名（parts）、画面の JS（script。テンプレートと同じ名前の .js）、プロジェクトの CSS（css。liminalia.json の ui.css のファイル）。ルール（rules。働く data-role と data-field、必須の data-role）も返す。",
        "Reads a screen's files: the project's template (template: registered or default location; text is null if missing), the current built-in template (standard) and its part names (parts), the screen JS (script: the .js with the template's name) and the project CSS (css: the files in ui.css of liminalia.json). Also returns the rules (data-role and data-field values that work, required data-role).",
      ),
      inputSchema: { type: "object", properties: { project, screen: SCREEN_PARAM }, required: ["project", "screen"] },
      run: async (args) => {
        const dir = host.project(args);
        const screen = templateScreen(args);
        const std = screenTemplateRules().screens[screen]!;
        const ui = readConfig(dir).ui;
        const read = projectFileReader(dir).text;
        const template = screenTemplatePath(ui, screen);
        const script = screenScriptPath(ui, screen);
        const files = {
          screen,
          template: { file: template, registered: screenRegistered(ui, screen), text: read(template) },
          standard: std.template,
          parts: splitTemplateParts(std.template).flatMap((p) => (p.name ? [p.name] : [])),
          rules: { roles: std.roles, fields: std.fields, required: std.required },
          script: { file: script, text: read(script) },
          css: uiCssFiles(ui).map((file) => ({ file, text: read(file) })),
        };
        return text(JSON.stringify(files, null, 2));
      },
    },
    {
      name: "write_screen_file",
      description: both(
        "画面のファイルを書く。kind が template ならテンプレート（登録が無ければ既定の場所に書いて ui.templates に登録する）、script なら画面の JS、css ならプロジェクトの CSS（file で ui.css のどれかを選ぶ。省くと一つ目、無ければ ui/screens.css に書いて ui.css に登録する）。書いたら lim check と同じテンプレートのチェック（css ならプロジェクトの CSS のチェック）を実行し、diagnostics と、エラーが無いか（ok）を返す。編集したら screen_shot で撮って確認する。",
        "Writes a screen's file. kind template writes the template (if not registered, at the default location, registering it in ui.templates); script writes the screen JS; css writes project CSS (file picks one in ui.css; default is the first, or ui/screens.css registered in ui.css). After writing, runs the same template check as lim check (the project CSS check for css) and returns diagnostics and whether there are no errors (ok). Then check it with screen_shot.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          project,
          screen: SCREEN_PARAM,
          kind: { type: "string", enum: ["template", "script", "css"], description: both("書くもの", "What to write") },
          text: { type: "string", description: both("ファイルの中身（全体）", "The whole file content") },
          file: { type: "string", description: both("css のとき、書く作品の CSS（作品のフォルダからのパス。.css）", "For css, the project CSS file to write (path from the project folder, .css)") },
        },
        required: ["project", "screen", "kind", "text"],
      },
      run: async (args) => {
        const dir = host.project(args);
        const screen = templateScreen(args);
        const kind = need(args, "kind");
        if (kind !== "template" && kind !== "script" && kind !== "css") throw new ToolError("kind は template、script、css のどれかです");
        const body = typeof args.text === "string" ? args.text : "";
        const raw = readConfig(dir);
        const ui = (raw.ui && typeof raw.ui === "object" && !Array.isArray(raw.ui) ? raw.ui : {}) as Record<string, unknown>;
        const put = (file: string) => {
          const path = join(dir, ...file.split("/"));
          // 作品の中のフォルダがリンクで外を指していたら、その先へ書かない
          if (!containedPath(dir, path)) throw new ToolError(`作品のフォルダの外を指すリンクの先には書けません: ${file}`);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, body);
        };
        const saveConfig = () => {
          raw.ui = ui;
          writeFileSync(join(dir, "liminalia.json"), `${JSON.stringify(raw, null, 2)}\n`);
        };
        let file: string;
        let registered = false;
        let diagnostics: Diagnostic[];
        if (kind === "css") {
          file = str(args, "file") ?? uiCssFiles(ui)[0] ?? UI_CSS_DEFAULT;
          const problem = uiCssPathProblem(file);
          if (problem) throw new ToolError(`${file} ${problem}`);
          put(file);
          const list = Array.isArray(ui.css) ? (ui.css as unknown[]) : [];
          if (!list.includes(file)) {
            ui.css = [...list, file];
            saveConfig();
            registered = true;
          }
          diagnostics = checkUiCss(ui, projectFileReader(dir)).filter((d) => d.file === file);
        } else {
          file = kind === "template" ? screenTemplatePath(ui, screen) : screenScriptPath(ui, screen);
          put(file);
          if (kind === "template" && !screenRegistered(ui, screen)) {
            ui.templates = { ...(ui.templates && typeof ui.templates === "object" ? (ui.templates as Record<string, unknown>) : {}), [screen]: file };
            saveConfig();
            registered = true;
          }
          diagnostics = screenDiagnostics(dir, screen);
        }
        return text(JSON.stringify({ file, registered, ok: !diagnostics.some((d) => d.severity === "error"), diagnostics: brief(diagnostics) }, null, 2));
      },
    },
    {
      name: "diff_screen",
      description: both(
        "プロジェクトのテンプレートと標準の違いを返す（lim screens diff と同じ）。部品ごとに、現在の標準からプロジェクトへの差分（authorDiff）と、コピー元のバージョンから現在の標準で変わったところ（standardChange。元のファイルが無ければバージョン番号だけ）。text は人が読む形。lim check の template-outdated が出たら、これで標準の変わったところを見て反映する。",
        "Returns how the project's template differs from the built-in one (same as lim screens diff). For each part: the diff from the current built-in part to the project's (authorDiff) and what changed in the built-in template since the copied version (standardChange; only version numbers when the original isn't kept). text is the readable form. When lim check reports template-outdated, use this to see what changed and copy it again.",
      ),
      inputSchema: { type: "object", properties: { project, screen: SCREEN_PARAM }, required: ["project", "screen"] },
      run: async (args) => {
        const dir = host.project(args);
        const screen = templateScreen(args);
        try {
          const d = diffScreen(dir, screenTemplateRules().screens, screen);
          return text(JSON.stringify({ ...d, text: screenDiffText(d) }, null, 2));
        } catch (e) {
          throw new ToolError(e instanceof Error ? e.message : String(e));
        }
      },
    },
  ];
}
