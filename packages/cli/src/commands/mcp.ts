import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { applyUiTheme, COMMAND_META, MEDIA_EXTENSIONS, themeFitsScreen, UI_THEMES, type UiConfig } from "@liminalia/lang";
import { copyUiThemeAssets, listUiThemes, loadProject } from "@liminalia/project";
import { containedPath } from "@liminalia/project/contained-path";
import { catalogDir, copyPluginFolder, readCatalog } from "@liminalia/studio/catalog";
import { planLineEdits, type LineEdit } from "@liminalia/studio/line-edits";
import { STUDIO_API } from "@liminalia/studio/protocol";
import { studioPageUrl } from "@liminalia/studio/running";
import { uiStringTable } from "@liminalia/web/ui-strings";
import { screenTemplateRules } from "@liminalia/web/screen-rules";
import type { Diagnostic } from "@liminalia/lang";
import { collectReference } from "./reference.ts";
import { scenarioGuide } from "./scenario-guide.ts";
import { both, clip, need, PROJECT_DESCRIPTION, PROJECT_PARAM, queryTool, str, text, ToolError, type Tool, type ToolResult } from "./mcp-tools.ts";
import { studioTools } from "./mcp-studio.ts";
import { authoringTools } from "./mcp-authoring.ts";
import { testingTools } from "./mcp-testing.ts";
import { screenTools } from "./mcp-screens.ts";
import { engineVersion } from "../version.ts";
import { bundledCatalogDir } from "../engine-paths.ts";

/**
 * lim mcp — AI のアシスタント（Claude Desktop・Claude Code・Codex など）から作品を作り、検査し、流し、撮り、書き出すための
 * MCP サーバー（標準入出力の JSON-RPC。一行に一つ）。
 *
 * 道具は lim のコマンドを子のプロセスで動かすだけにする（コマンドは標準出力に経過を書くので、同じプロセスで動かすと
 * MCP の通信に混ざる）。命令のリファレンスだけは、出力を書かないのでこのプロセスで集める。
 *
 * 触れてよい場所は「作品の置き場」（--root か環境変数 LIMINALIA_MCP_ROOTS。無ければ ~/Liminalia）の中だけ。
 * 作品の指定は置き場の中のフォルダ名か、置き場の中を指す絶対パス。台本の読み書きはシナリオのフォルダ（既定 scenario/）の .lim に限る。
 *
 * 台本の書き込みと書く前の検査は、制作画面の開発サーバーと同じもの（@liminalia/studio/server の StudioWorkspace）を使う。
 * 読んだときの hash を書くときに確かめ（制作画面などでの直しを上書きしない）、前の版を .liminalia/history/ に残す。
 * 制作画面が開いていれば、そのファイルの見張りが外の変更として知らせ、編集中の内容と合わせ直す。
 */

const PROTOCOL_VERSION = "2025-06-18";
const LIM_BIN = fileURLToPath(new URL("../../bin/lim.mjs", import.meta.url));

/** シナリオの書き方の手引きの resource。 */
const GUIDE_URI = "liminalia://guide/scenario";

/** 制作画面の開発サーバーの中身（読み込みが重いので、使うときに一度だけ読む）。 */
type StudioServerModule = typeof import("@liminalia/studio/server");
let studioModule: Promise<StudioServerModule> | null = null;
const studio = () => (studioModule ??= import("@liminalia/studio/server"));

/**
 * このプロセスが制作アプリの実行ファイルで動いているか（制作アプリの「AI のアシスタントにつなぐ」が登録した MCP。
 * アプリを ELECTRON_RUN_AS_NODE で Node として動かすので、process.versions.electron がある）。
 */
const inStudioApp = () => !!process.versions.electron;

/** 画面なしで撮る道具（playwright-core と Chromium）が無ければ、その理由。そろっていれば null。 */
async function headlessMissing(): Promise<string | null> {
  try {
    createRequire(LIM_BIN).resolve("playwright-core");
  } catch {
    // 入っていないことを理由の文にして返す
    return "画面なしで撮るための playwright-core が入っていません。";
  }
  try {
    (await import("@liminalia/studio/browser")).findChromium();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** 書く道具の allowErrors。 */
const ALLOW_ERRORS = { type: "boolean", description: both("書くと作品の誤り（エラー）が増えても書く（既定は書かずに、増える誤りを返す）", "Write even if it adds errors to the project (by default nothing is written and the added errors are returned)") } as const;

/**
 * 書くと増える誤り（エラー）。書く前と後の診断を、ファイルと code ごとに数え合わせ、後のほうが多いものを返す
 * （行の番号は見ない。行を足すと後ろの行の番号がずれるため。文も数えない。直し方を当てると、同じ誤りの文が書いた引数の名前などで
 * 変わることがあり、文で数えると誤りが増えたと断っていたため。返すのは、前に同じ文の無いものを先にする）。
 */
export function addedErrors(before: readonly Diagnostic[], after: readonly Diagnostic[]): Diagnostic[] {
  const kind = (d: Diagnostic) => `${d.file ?? ""}\u0000${d.code}`;
  const exact = (d: Diagnostic) => `${kind(d)}\u0000${d.message}`;
  const errorsBefore = before.filter((d) => d.severity === "error");
  const errorsAfter = after.filter((d) => d.severity === "error");
  const room = new Map<string, number>();
  for (const d of errorsBefore) room.set(kind(d), (room.get(kind(d)) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const d of errorsBefore) seen.set(exact(d), (seen.get(exact(d)) ?? 0) + 1);
  // 前と同じ文のものから先に、前の数に当てる
  const same: Diagnostic[] = [];
  const changed: Diagnostic[] = [];
  for (const d of errorsAfter) {
    const n = seen.get(exact(d)) ?? 0;
    if (n > 0) {
      seen.set(exact(d), n - 1);
      same.push(d);
    } else changed.push(d);
  }
  const out: Diagnostic[] = [];
  for (const d of [...same, ...changed]) {
    const n = room.get(kind(d)) ?? 0;
    if (n > 0) room.set(kind(d), n - 1);
    else out.push(d);
  }
  return out;
}

/** 台本の行に番号を付ける（edit_scenario の from・to に使う）。 */
function numbered(text: string, from = 1): string {
  return text
    .split("\n")
    .map((line, i) => `${String(from + i).padStart(5)}| ${line}`)
    .join("\n");
}

/** 作品の置き場。 */
export function mcpRoots(flagRoots: string[], env: string | undefined = process.env.LIMINALIA_MCP_ROOTS): string[] {
  const roots = [...flagRoots, ...(env ? env.split(delimiter) : [])].filter((r) => r.trim() !== "").map((r) => resolve(r.replace(/^~(?=$|[/\\])/, homedir())));
  return roots.length > 0 ? [...new Set(roots)] : [join(homedir(), "Liminalia")];
}

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** import_asset で写せる素材のフォルダ。 */
const ASSET_KINDS = ["bgimage", "fgimage", "image", "bgm", "sound", "voice", "video", "others"] as const;
/** import_asset で写せるファイルの拡張子（書き出しがゲームに入れる素材の表と同じ）。 */
const ASSET_FILE_EXTENSIONS = new Set(Object.values(MEDIA_EXTENSIONS).flat());

export class McpServer {
  private readonly tools: Tool[];
  private readonly servers = new Map<string, { child: ChildProcess; url: string }>();

  constructor(private readonly roots: string[]) {
    this.tools = this.defineTools();
  }

  /** 作品のフォルダ（置き場の中にあり、liminalia.json がある）。 */
  private project(args: Record<string, unknown>): string {
    const spec = need(args, "project");
    const candidates = isAbsolute(spec) ? [resolve(spec)] : this.roots.map((r) => resolve(r, spec));
    for (const dir of candidates) {
      if (!this.roots.some((r) => inside(r, dir))) continue;
      if (existsSync(join(dir, "liminalia.json"))) return dir;
    }
    if (isAbsolute(spec) && !this.roots.some((r) => inside(r, resolve(spec)))) throw new ToolError(`プロジェクトの保存先（${this.roots.join("、")}）の外は扱えません: ${spec}`);
    throw new ToolError(`プロジェクトが見つかりません: ${spec}（list_projects でプロジェクト名を確認してください）`);
  }

  /** 台本の名前（シナリオのフォルダからのパス、拡張子なし）とファイル。file は scenario/ や拡張子を付けてもよい。 */
  private scenarioName(dir: string, file: string): { name: string; path: string } {
    const name = file.replace(/\\/g, "/").replace(/^scenario\//, "").replace(/\.lim$/, "");
    const base = loadProject(dir).paths.scenario;
    const path = resolve(base, `${name}.lim`);
    if (!inside(base, path) || name === "" || name.split("/").some((p) => p === "" || p === "." || p === ".." || p.startsWith("."))) throw new ToolError(`シナリオは scenario/ の中の .lim だけを扱えます: ${file}`);
    return { name, path };
  }

  /** 制作画面と同じ作品の読み書き（呼ぶたびに作品を読み直す。ほかで変わったキャラクターやプラグインも反映する）。 */
  private async workspace(dir: string) {
    const { StudioWorkspace, setUiStringTable, setScreenTemplateRules } = await studio();
    // 訳の道具（read_translation など）に、システム画面の文言を英語の原文と並べさせる（制作画面は描画側を読まないので、ここで渡す）
    setUiStringTable(uiStringTable());
    // check_text に、標準の画面の決まり（作品の画面のテンプレートを確かめる。lim check と同じ一覧にする）を渡す
    setScreenTemplateRules(screenTemplateRules());
    return StudioWorkspace.open(loadProject(dir));
  }

  /**
   * 台本を書く（write_scenario・edit_scenario・restore_scenario・apply_fixes）。読んだときの hash（新しい台本は null）を確かめ、
   * 書くと作品の誤り（エラー）が増えるなら書かずに、増える誤りを返す（allowErrors なら書く）。書いたら作品全体を検査して返す。
   * 誤りは、書く前と書いた後の作品の検査（台本どうしの検査も。行の番号は見ない）を比べて数える。
   */
  private async guardedWrite(dir: string, name: string, path: string, next: string, baseHash: string | null, allowErrors: boolean): Promise<ToolResult> {
    const rel = relative(dir, path).split(sep).join("/");
    const { hashText } = await studio();
    const now = existsSync(path) ? readFileSync(path, "utf8") : null;
    if ((now === null ? null : hashText(now)) !== baseHash) {
      if (now === null) throw new ToolError(`${rel} がありません（ほかで削除されたか、名前が変わりました）。新しく作るなら baseHash を省いてください`);
      return this.current(rel, path, `${rel} は読んだあとでほかで編集されています（Studio など）。書いていません。今の中身に合わせて直してから、この hash を baseHash にして書き直してください。`);
    }
    const ws = await this.workspace(dir);
    if (!allowErrors) {
      const added = addedErrors(ws.checkText(name, now ?? "", "project"), ws.checkText(name, next, "project"));
      if (added.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: clip(
                `${rel} は書いていません。書くとプロジェクトのエラーが ${added.length} 件増えます。直してから書き直してください（エラーがあっても書くなら allowErrors を true に）。\n\n` +
                  JSON.stringify({ file: name, addedErrors: added.map(({ file, line, column, code, message, hint }) => ({ file, line, ...(column !== undefined ? { column } : {}), code, message, ...(hint ? { hint } : {}) })) }, null, 2),
              ),
            },
          ],
          isError: true,
        };
      }
    }
    const r = ws.write(name, next, baseHash, false);
    if (!r.ok) return this.current(rel, path, `${rel} は書いている間にほかで直されました。何も書いていません。読み直してからやり直してください。`);
    return this.saved(dir, rel, name, r.result);
  }

  /** その作品を開いている制作画面（制作アプリか lim studio。作品の .liminalia/studio-server.json）。無ければ null。 */
  private async running(dir: string) {
    const { findRunningStudio } = await import("@liminalia/studio/running");
    return findRunningStudio(dir);
  }

  /** 書かなかったとき、今の中身と hash を返す（それに合わせて書き直してもらう）。 */
  private async current(rel: string, path: string, why: string): Promise<ToolResult> {
    const { hashText } = await studio();
    const now = readFileSync(path, "utf8");
    return { content: [{ type: "text", text: clip(`${why}\n\nhash: ${hashText(now)}\n\n# 今の ${rel}\n${now}`) }], isError: true };
  }

  /** 書いたあとの返事（作品全体を検査した結果）。 */
  private async saved(dir: string, rel: string, name: string, result: { hash: string; history: string | null }): Promise<ToolResult> {
    const kept = result.history ? `前のバージョンは .liminalia/history/${name}/${result.history}.lim に残しました。` : "";
    const c = await this.lim(["check", dir]);
    return text(`${rel} を保存しました（hash: ${result.hash}）。${kept}\n\n# チェック\n${c.out}`, c.code !== 0);
  }

  /** lim のコマンドを子のプロセスで動かす。 */
  private lim(args: string[], timeoutMs = 120_000): Promise<{ code: number; out: string }> {
    return new Promise((done) => {
      const child = spawn(process.execPath, [LIM_BIN, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
      let out = "";
      child.stdout.on("data", (b: Buffer) => (out += b.toString()));
      child.stderr.on("data", (b: Buffer) => (out += b.toString()));
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.on("close", (code) => {
        clearTimeout(timer);
        done({ code: code ?? 1, out: out.trim() });
      });
    });
  }

  private async limResult(args: string[], timeoutMs?: number): Promise<ToolResult> {
    const r = await this.lim(args, timeoutMs);
    return text(r.out || (r.code === 0 ? "終わりました" : `終了コード ${r.code}`), r.code !== 0);
  }

  private defineTools(): Tool[] {
    const project = PROJECT_PARAM;
    return [
      queryTool((args) => this.project(args), (args) => this.limResult(args)),
      {
        name: "list_projects",
        description: both("プロジェクトの保存先にある Liminalia プロジェクトの一覧を返す。", "Lists the Liminalia projects in the project root."),
        inputSchema: { type: "object", properties: {} },
        run: async () => {
          const found: string[] = [];
          for (const root of this.roots) {
            if (!existsSync(root)) continue;
            for (const name of readdirSync(root)) if (existsSync(join(root, name, "liminalia.json"))) found.push(join(root, name));
          }
          return text(found.length ? found.join("\n") : `プロジェクトはまだありません（保存先: ${this.roots.join("、")}）。create_project で作成できます。`);
        },
      },
      {
        name: "create_project",
        description: both("ひな形から新しいビジュアルノベルのプロジェクトを作成する。見本の物語、背景、立ち絵、BGM 入り（blank なら白紙）。作成後に check と screenshot で確認できる。", "Creates a new visual novel project from the template, with a sample story, backgrounds, character sprites and BGM (blank starts empty). Check the result with check and screenshot."),
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: both("プロジェクトのフォルダ名（保存先の中に作成）", "Folder name of the project (created in the project root)") },
            title: { type: "string", description: both("プロジェクトのタイトル", "Title of the project") },
            size: { type: "string", description: both("画面サイズ（幅x高さ。既定 1280x720）", "Screen size (WIDTHxHEIGHT, default 1280x720)") },
            novel: { type: "boolean", description: both("サウンドノベル（全画面に文字を出す）にする", "Make it a sound novel (text fills the screen)") },
            blank: { type: "boolean", description: both("見本の物語と素材を入れず、白紙のシナリオ一つから始める", "Start from one empty script without the sample story and assets") },
            ci: { type: "boolean", description: both("GitHub Actions のチェック用ワークフローと、はじめから終わりまで流れるシナリオテストも置く（lim new --ci）", "Also add the GitHub Actions check workflow and a script test that runs from start to end (lim new --ci)") },
            language: { type: "string", description: both("作る人の言語（\"en\" など。既定は日本語）。白紙ならシナリオの文とコメントを英語にし、原文の言語をその言語にしてシステム画面をその言語で出す（見本の物語は日本語のまま）", "Language of the author (\"en\" and so on, default Japanese). With blank, the script text and comments are in that language, the source language is set to it and the system screens use it (the sample story stays Japanese)") },
          },
          required: ["name"],
        },
        run: async (args) => {
          const name = need(args, "name");
          if (/[\\/]|^\.\.?$/.test(name)) throw new ToolError("name はフォルダ名だけにしてください（/ を含めない）");
          const root = this.roots[0]!;
          mkdirSync(root, { recursive: true });
          const dir = join(root, name);
          if (existsSync(dir)) throw new ToolError(`同じ名前のフォルダがすでにあります: ${dir}`);
          const flags = [...(str(args, "title") ? ["--title", str(args, "title")!] : []), ...(str(args, "size") ? ["--size", str(args, "size")!] : []), ...(args.novel === true ? ["--novel"] : []), ...(args.blank === true ? ["--blank"] : []), ...(args.ci === true ? ["--ci"] : []), ...((str(args, "language") ?? str(args, "lang")) ? ["--lang", (str(args, "language") ?? str(args, "lang"))!] : [])];
          const r = await this.lim(["new", dir, ...flags]);
          return text(`${r.out}\n\nプロジェクトのフォルダ: ${dir}`, r.code !== 0);
        },
      },
      {
        name: "list_files",
        description: both("プロジェクトのシナリオ（scenario/ の .lim）、素材（assets/ の種類ごと）、キャスト（cast.json の人物）を一覧にする。", "Lists the scripts (.lim in scenario/), the assets (by kind in assets/) and the cast (characters in cast.json) of a project."),
        inputSchema: { type: "object", properties: { project }, required: ["project"] },
        run: async (args) => {
          const dir = this.project(args);
          const walk = (base: string, depth: number): string[] => {
            if (!existsSync(base)) return [];
            return readdirSync(base).flatMap((n) => {
              const p = join(base, n);
              if (n.startsWith(".")) return [];
              return statSync(p).isDirectory() ? (depth > 0 ? walk(p, depth - 1) : []) : [relative(dir, p).split(sep).join("/")];
            });
          };
          const cast = existsSync(join(dir, "cast.json")) ? Object.keys((JSON.parse(readFileSync(join(dir, "cast.json"), "utf8")) as { cast?: Record<string, unknown> }).cast ?? {}) : [];
          return text([`プロジェクト: ${dir}`, "", "# シナリオ", ...walk(join(dir, "scenario"), 4), "", "# 素材", ...walk(join(dir, "assets"), 4), "", "# キャスト", cast.join("、") || "（なし）"].join("\n"));
        },
      },
      {
        name: "read_scenario",
        description: both(
          "シナリオ（.lim）を読む。file はシナリオフォルダからの名前（start、chapter1/a など。拡張子は省いてよい）。最後に hash を返すので、write_scenario の baseHash に渡す。" +
          "numbered なら行番号を付ける（edit_scenario の from、to に使う。行頭の番号と「| 」はシナリオの中身ではない）。",
          "Reads a script (.lim). file is the name from the scenario folder (start, chapter1/a and so on; the extension may be omitted). The hash at the end goes to baseHash of write_scenario. With numbered, lines get numbers (for from and to of edit_scenario; the leading number and \"| \" aren't part of the script).",
        ),
        inputSchema: { type: "object", properties: { project, file: { type: "string" }, numbered: { type: "boolean" } }, required: ["project", "file"] },
        run: async (args) => {
          const dir = this.project(args);
          const { path } = this.scenarioName(dir, need(args, "file"));
          if (!existsSync(path)) throw new ToolError(`シナリオがありません: ${relative(dir, path)}`);
          const body = readFileSync(path, "utf8");
          const { hashText } = await studio();
          return { content: [{ type: "text", text: clip(args.numbered === true ? numbered(body) : body) }, { type: "text", text: `hash: ${hashText(body)}` }] };
        },
      },
      {
        name: "write_scenario",
        description: both(
          "シナリオ（.lim）を丸ごと書く（無ければ作る）。すでにあるシナリオは、read_scenario で読んだときの hash を baseHash に渡す。読んだあとで Studio などで編集されていたら、書かずに今の中身と hash を返すので、それに合わせて直してから書き直す。" +
          "書くとプロジェクトのエラーが増えるなら書かずに、増えるエラーを JSON で返す（allowErrors で書く）。" +
          "書く前のバージョンは .liminalia/history/ に残る（restore_scenario で戻せる）。書いたあとプロジェクト全体をチェックし、その結果を返す。一部だけ直すなら edit_scenario。書き方は scenario_guide と command_reference。",
          "Writes a whole script (.lim), creating it if missing. For an existing script, pass the hash from read_scenario as baseHash. If it was changed elsewhere (in Studio and so on) after you read it, nothing is written and the current text and hash are returned; adjust to them and write again. " +
          "If writing adds errors to the project, nothing is written and the added errors are returned as JSON (allowErrors writes anyway). " +
          "The previous version is kept in .liminalia/history/ (restore it with restore_scenario). After writing, the whole project is checked and the result is returned. To change only part, use edit_scenario. For how to write, see scenario_guide and command_reference.",
        ),
        inputSchema: {
          type: "object",
          properties: {
            project,
            file: { type: "string" },
            text: { type: "string", description: both("シナリオの中身（.lim）", "Script text (.lim)") },
            baseHash: { type: ["string", "null"], description: both("read_scenario で読んだときの hash（新しいシナリオなら省く）", "hash returned by read_scenario (omit for a new script)") },
            allowErrors: ALLOW_ERRORS,
          },
          required: ["project", "file", "text"],
        },
        run: async (args) => {
          const dir = this.project(args);
          const { name, path } = this.scenarioName(dir, need(args, "file"));
          const rel = relative(dir, path).split(sep).join("/");
          const body = typeof args.text === "string" ? args.text : "";
          const baseHash = str(args, "baseHash") ?? null;
          if (existsSync(path) && baseHash === null) return this.current(rel, path, `${rel} はもうあります。書いていません。上書きするなら read_scenario で読んだ hash を baseHash に渡してください（Studio などでの編集を消さないため）。`);
          if (!existsSync(path) && baseHash !== null) throw new ToolError(`${rel} がありません（ほかで削除されたか、名前が変わりました）。新しく作るなら baseHash を省いてください`);
          return this.guardedWrite(dir, name, path, body.endsWith("\n") ? body : `${body}\n`, baseHash, args.allowErrors === true);
        },
      },
      {
        name: "edit_scenario",
        description: both(
          "シナリオ（.lim）の一部の行を書き換える（Studio のプラグインの ctx.script.apply と同じ形）。edits の行番号は、どれも書き換える前のシナリオの番号（read_scenario の numbered で見られる）。" +
          "from〜to の行（両端を含む）を text にする。text は改行を含んでよく、null なら行ごと消す。to を from - 1 にすると from の行の前に挿入する（行数 + 1 なら末尾）。" +
          "expect は書き換える前のその行（改行でつないだもの。挿入するときは \"\"）。どれかが違えば（ほかで編集された）何も書かずに、その辺りの今の行を返す。" +
          "書くとプロジェクトのエラーが増えるなら書かずに、増えるエラーを返す（allowErrors で書く）。書く前のバージョンは .liminalia/history/ に残り、書いたあとプロジェクト全体をチェックする。",
          "Rewrites some lines of a script (.lim) (the same form as ctx.script.apply of Studio plugins). Line numbers in edits all refer to the script before the edit (see them with numbered of read_scenario). Lines from to to (inclusive) become text. text may contain line breaks; null deletes the lines. Set to to from - 1 to insert before line from (line count + 1 appends at the end). expect is the current text of those lines (joined with line breaks; \"\" when inserting). If any differs (changed elsewhere), nothing is written and the current lines around it are returned. " +
          "If writing adds errors to the project, nothing is written and the added errors are returned (allowErrors writes anyway). The previous version is kept in .liminalia/history/, and the whole project is checked after writing.",
        ),
        inputSchema: {
          type: "object",
          properties: {
            project,
            file: { type: "string" },
            edits: {
              type: "array",
              items: {
                type: "object",
                properties: { from: { type: "integer" }, to: { type: "integer" }, expect: { type: "string" }, text: { type: ["string", "null"] } },
                required: ["from", "to", "expect", "text"],
              },
            },
            allowErrors: ALLOW_ERRORS,
          },
          required: ["project", "file", "edits"],
        },
        run: async (args) => {
          const dir = this.project(args);
          const { name, path } = this.scenarioName(dir, need(args, "file"));
          const rel = relative(dir, path).split(sep).join("/");
          if (!existsSync(path)) throw new ToolError(`シナリオがありません: ${rel}（新しく作るなら write_scenario）`);
          const edits = Array.isArray(args.edits) ? (args.edits as LineEdit[]) : [];
          if (edits.length === 0 || edits.some((e) => typeof e !== "object" || e === null || typeof e.expect !== "string" || (typeof e.text !== "string" && e.text !== null))) {
            throw new ToolError("edits は { from, to, expect, text } の並びで送ってください（text は文字列か null）");
          }
          const { hashText } = await studio();
          const doc = readFileSync(path, "utf8");
          const lines = doc.split("\n");
          const plan = planLineEdits(doc, edits);
          if (!plan.ok) {
            const e = edits[plan.index]!;
            if (plan.reason === "invalid") {
              throw new ToolError(`${plan.index + 1} 番目の書き換えの行の範囲が使えません（from ${e.from}、to ${e.to}。行は 1 から ${lines.length} まで。範囲は重ねず、足すときは to = from - 1 にして text を null にしない）`);
            }
            const first = Math.max(1, Math.min(e.from, e.to) - 2);
            const last = Math.min(lines.length, Math.max(e.from, e.to) + 2);
            return {
              content: [{ type: "text", text: clip(`${plan.index + 1} 番目の書き換えの行が expect と違います（ほかで直されたか、行の番号がずれています）。何も書いていません。今のその辺りの行:\n${numbered(lines.slice(first - 1, last).join("\n"), first)}\n\nhash: ${hashText(doc)}`) }],
              isError: true,
            };
          }
          let next = doc;
          for (const c of [...plan.changes].sort((a, b) => b.from - a.from)) next = next.slice(0, c.from) + c.insert + next.slice(c.to);
          return this.guardedWrite(dir, name, path, next, hashText(doc), args.allowErrors === true);
        },
      },
      {
        name: "check_text",
        description: both(
          "シナリオの中身を、書かずにチェックする（ほかのシナリオのラベル、キャラクター、素材と合わせて。lim check と同じ規則）。書く前に確認するのに使う。そのファイルの診断を JSON（severity、code、message、line、column、hint）で返す。",
          "Checks script text without writing it (against labels, characters and assets in the other scripts, with the same rules as lim check). Use it to check before writing. Returns the diagnostics of that file as JSON (severity, code, message, line, column, hint).",
        ),
        inputSchema: { type: "object", properties: { project, file: { type: "string", description: both("シナリオの名前（まだ無いシナリオでもよい）", "Script name (it doesn't have to exist yet)") }, text: { type: "string", description: both("チェックする中身（.lim）", "Text to check (.lim)") } }, required: ["project", "file", "text"] },
        run: async (args) => {
          const dir = this.project(args);
          const { name } = this.scenarioName(dir, need(args, "file"));
          const ws = await this.workspace(dir);
          const diagnostics = ws.checkText(name, typeof args.text === "string" ? args.text : "");
          const count = (s: Diagnostic["severity"]) => diagnostics.filter((d) => d.severity === s).length;
          return text(JSON.stringify({ file: name, errors: count("error"), warnings: count("warning"), diagnostics }, null, 2), count("error") > 0);
        },
      },
      {
        name: "scenario_guide",
        description: both("シナリオ（.lim）の書き方の手引き（行の種類、台詞、ラベル、ルビなど本文の中の書き方、コマンドの値の型、立ち絵、選択肢、@if、変数と式、マクロ、式の関数）を返す。初めて書く前に一度読む。コマンドごとのパラメータは command_reference。", "Returns the guide to writing scripts (.lim): kinds of lines, dialogue, labels, inline markup such as ruby, value types of commands, character sprites, choices, @if, variables and expressions, macros and expression functions. Read it once before writing a script for the first time. For the parameters of each command, use command_reference."),
        inputSchema: { type: "object", properties: {} },
        run: async () => text(scenarioGuide()),
      },
      {
        name: "check",
        description: both("プロジェクトの全シナリオをチェックする（コマンド、パラメータ、ラベル、キャスト、素材の実在）。エラーは位置と修正案付きで返る。format を json にすると lim check --json の JSON で返す。", "Checks all scripts of a project (commands, parameters, labels, cast and whether assets exist). Errors come with their location and how to fix them. With format json, returns the JSON of lim check --json."),
        inputSchema: { type: "object", properties: { project, format: { type: "string", enum: ["text", "json"] } }, required: ["project"] },
        run: async (args) => this.limResult(["check", this.project(args), ...(str(args, "format") === "json" ? ["--json"] : [])]),
      },
      {
        name: "trace",
        description: both("画面なしでシナリオを実行し、出たページ（話者と本文）、選択肢、画面の状態を返す。選択肢は choose で何番目を選ぶか決める。ページの頭の [N] は start から 1 で数えた番号で、screenshot の skip にそのまま渡すとそのページを撮る。", "Runs the scripts without a screen and returns the pages shown (speaker and text), the choices and the screen state. choose picks which option to take at each choice. [N] at the start of a page is its number counted from 1 at start; pass it as skip to screenshot to capture that page."),
        inputSchema: {
          type: "object",
          properties: { project, start: { type: "string", description: both("開始位置（ファイル か ファイル#ラベル）", "Where to start (file or file#label)") }, choose: { type: "string", description: both("選択肢で選ぶ番号（0 から。カンマ区切り）", "Options to pick at choices (from 0, comma-separated)") }, max_pages: { type: "number" } },
          required: ["project", "start"],
        },
        run: async (args) =>
          this.limResult(["trace", this.project(args), need(args, "start"), ...(str(args, "choose") ? ["--choose", str(args, "choose")!] : []), ...(typeof args.max_pages === "number" ? ["--max-pages", String(args.max_pages)] : [])]),
      },
      {
        name: "screenshot",
        description: both(
          "ゲームのスクリーンショットを撮って画像で返す。start から数えて skip 番目のページ（trace の [N]。1 から）のクリック待ちか、title が true ならタイトル画面。" +
          "skip が 1 以下なら、最初のページより前の選択肢と、プレイヤーの操作を待つ画面（プラグインのコマンドの画面など）でも止めて撮る。" +
          "プロジェクトを Liminalia Studio か lim studio で開いていれば、その開発サーバーで撮る。開いていなければ画面なしの Chromium で撮る（無ければ、Studio を開くよう理由を返す）。",
          "Takes a screenshot of the game and returns the image: the click wait of page skip counted from start (the [N] of trace, from 1), or the title screen when title is true. When skip is 1 or less, it also stops at a choice or a screen waiting for the player (such as a plugin command's screen) before the first page. If the project is open in the Studio app or lim studio, its dev server is used. Otherwise a headless Chromium is used (if there's none, the reason is returned with a suggestion to open Studio).",
        ),
        inputSchema: {
          type: "object",
          properties: {
            project,
            start: { type: "string", description: both("ファイル か ファイル#ラベル", "file or file#label") },
            skip: { type: "number", description: both("撮るページの番号（start から 1 で数える。trace の [N]。省くと最初のページ）", "Number of the page to capture (counted from 1 at start, the [N] of trace; omit for the first page)") },
            title: { type: "boolean" },
            lang: { type: "string", description: both("プレイ言語（liminalia.json の languages にあるもの。lim shot の --lang、プレイヤーの ?lang=）", "Language to play in (one of languages in liminalia.json; --lang of lim shot, ?lang= of the player)") },
          },
          required: ["project"],
        },
        run: async (args) => {
          const dir = this.project(args);
          const lang = str(args, "lang");
          const where: { title?: boolean; start?: string; skip?: number; lang?: string } = {
            ...(args.title === true ? { title: true } : { start: need(args, "start"), ...(typeof args.skip === "number" ? { skip: args.skip } : {}) }),
            ...(lang ? { lang } : {}),
          };
          // 開いている制作画面があれば、その開発サーバーに撮ってもらう（制作アプリはアプリの見えないウィンドウで撮る）
          const found = await this.running(dir);
          if (found) {
            const res = await fetch(`${found.url}${STUDIO_API}/shot/play`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(where), signal: AbortSignal.timeout(180_000) }).catch((e: Error) => e);
            if (res instanceof Error) return text(`開いている Studio で撮れませんでした: ${res.message}`, true);
            // 返事が JSON でなければ、決まった文で知らせる
            if (!res.ok) return text(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `開いている Studio で撮れませんでした（${res.status}）`, true);
            const by = found.app === "desktop" ? "Liminalia Studio " : "lim studio ";
            return { content: [{ type: "image", data: Buffer.from(await res.arrayBuffer()).toString("base64"), mimeType: "image/png" }, { type: "text", text: `${by}で開いている開発サーバーで撮りました（${found.url}）` }] };
          }
          const missing = await headlessMissing();
          if (missing) {
            return text(
              inStudioApp()
                ? "スクリーンショットは、このプロジェクトを Liminalia Studio で開いているときに、その画面で撮ります。いまは開いていません。open_studio で開いてから、もう一度 screenshot を呼んでください。"
                : `${missing}\nこのプロジェクトを Liminalia Studio か lim studio で開いていれば、その開発サーバーで撮ります（open_studio で開けます）。`,
              true,
            );
          }
          const tmp = mkdtempSync(join(tmpdir(), "liminalia-mcp-"));
          const out = join(tmp, "shot.png");
          try {
            const flags = [...(where.title ? ["--title"] : [where.start!, ...(where.skip !== undefined ? ["--skip", String(where.skip)] : [])]), ...(where.lang ? ["--lang", where.lang] : [])];
            const r = await this.lim(["shot", dir, ...flags, "--settle", "--out", out], 180_000);
            if (r.code !== 0 || !existsSync(out)) return text(r.out || "撮れませんでした", true);
            return { content: [{ type: "image", data: readFileSync(out).toString("base64"), mimeType: "image/png" }, { type: "text", text: clip(r.out) }] };
          } finally {
            rmSync(tmp, { recursive: true, force: true });
          }
        },
      },
      {
        name: "command_reference",
        description: both("コマンド（@bg、@chara、@quake など）の仕様（パラメータ、型、既定値、例）を返す。query でやりたいこと（「揺らす」「暗転」「雨」）や名前から絞れる。project を渡すとそのプロジェクトのプラグインのコマンドも入る。", "Returns the specs of commands (@bg, @chara, @quake and so on): parameters, types, defaults and examples. Narrow them with query by what you want to do (\"shake\", \"fade to black\", \"rain\") or by name. With project, the commands of its plugins are included."),
        inputSchema: { type: "object", properties: { project: { ...project, description: both(`${PROJECT_DESCRIPTION.ja}（省くと組み込みと標準のコマンドだけ）`, `${PROJECT_DESCRIPTION.en} (if omitted, only built-in and standard commands)`) }, query: { type: "string" } } },
        run: async (args) => {
          const dir = str(args, "project") ? this.project(args) : null;
          const q = str(args, "query")?.toLowerCase();
          const lines: string[] = [];
          for (const g of await collectReference(dir)) {
            for (const c of g.commands) {
              const keywords = [...(COMMAND_META[c.name]?.keywords ?? []), ...(c.keywords ?? [])];
              // 英語の要約とやりたいことの言葉でも当たる（"shake"、"fade out" など）
              if (q && ![c.name, c.summary, c.summaryEn ?? "", ...keywords, ...(c.keywordsEn ?? [])].some((s) => s.toLowerCase().includes(q))) continue;
              const params = Object.entries(c.params).map(([n, p]) => `  - ${c.positional.includes(n) ? `${n}（${c.positional.indexOf(n) + 1} 番目、名前なしで書く）` : `${n}=`} ${p.type.kind}${p.required ? " 必須" : p.default !== undefined ? ` 既定 ${p.default}` : ""}: ${p.doc ?? ""}`);
              lines.push(`## @${c.name}（${g.source}）`, c.summary, `例: ${c.example}`, ...(keywords.length ? [`言葉: ${keywords.join("、")}`] : []), ...params, "");
            }
          }
          return text(lines.length ? lines.join("\n") : `当てはまるコマンドがありません: ${q}`);
        },
      },
      {
        name: "open_studio",
        description: both(
          "プロジェクトの Studio（Liminalia Studio）を開き、URL を返す。Liminalia Studio か lim studio ですでに開いていれば、別の開発サーバーを立てずにそれを使う。" +
          "Liminalia Studio から登録した AI なら Liminalia Studio で開く（前に出す）。そうでなければ lim studio の開発サーバーを立て、ブラウザで開く URL を返す。",
          "Opens Studio (Liminalia Studio) for a project and returns the URL. If the Studio app or lim studio already has it open, that one is used without starting another dev server. If this AI was registered from the Studio app, the project opens there (brought to the front). Otherwise lim studio's dev server is started and the URL to open in a browser is returned.",
        ),
        inputSchema: { type: "object", properties: { project, port: { type: "number", description: both("lim studio を立てるときのポート番号", "Port to use when starting lim studio") } }, required: ["project"] },
        run: async (args) => {
          const dir = this.project(args);
          const found = await this.running(dir);
          if (found && !(found.app === "desktop" && inStudioApp())) {
            return text(`Studio: ${studioPageUrl(found.url)}\nプレイヤー: ${found.url}/\n${found.app === "desktop" ? "Liminalia Studio で開いている画面です。" : "lim studio で開いている開発サーバーです。"}`);
          }
          if (inStudioApp()) {
            // 制作アプリの実行ファイルを、作品を開く起動として動かす（動いているアプリがあればそちらが開くか前に出す）
            const env: NodeJS.ProcessEnv = { ...process.env };
            delete env.ELECTRON_RUN_AS_NODE;
            const appPath = process.env.LIMINALIA_STUDIO_APP_PATH;
            spawn(process.execPath, [...(appPath ? [appPath] : []), dir], { detached: true, stdio: "ignore", env }).unref();
            const deadline = Date.now() + 90_000;
            for (;;) {
              const opened = found ?? (await this.running(dir));
              if (opened) return text(`Liminalia Studio で開きました。\nStudio: ${studioPageUrl(opened.url)}\nプレイヤー: ${opened.url}/`);
              if (Date.now() > deadline) return text("Liminalia Studio で開けませんでした（90 秒待っても開発サーバーが立ち上がりません）。Liminalia Studio の「ヘルプ → ログを開く」で理由を確認してください。", true);
              await new Promise((r) => setTimeout(r, 700));
            }
          }
          const running = this.servers.get(dir);
          if (running && running.child.exitCode === null) return text(`Studio: ${running.url}`);
          const port = typeof args.port === "number" ? args.port : 5180 + this.servers.size;
          const child = spawn(process.execPath, [LIM_BIN, "studio", dir, "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
          const url = await new Promise<string | null>((done) => {
            let out = "";
            const timer = setTimeout(() => done(null), 30_000);
            const read = (b: Buffer) => {
              out += b.toString();
              const m = /Studio:\s*(\S+)/.exec(out);
              if (m) {
                clearTimeout(timer);
                done(m[1]!);
              }
            };
            child.stdout!.on("data", read);
            child.stderr!.on("data", read);
            child.on("close", () => done(null));
          });
          if (!url) {
            child.kill();
            return text("Studio を立ち上げられませんでした", true);
          }
          this.servers.set(dir, { child, url });
          return text(`Studio: ${url}\nプレイヤー: ${url.replace(/__liminalia\/studio$/, "")}`);
        },
      },
      {
        name: "set_theme",
        description: both(
          `ゲーム全体の見た目（本文、枠、名前、選択肢、システム画面）のテーマを適用する。素材もプロジェクトへコピーする。プロジェクトの themes/<id>/theme.json も選べる。用意したテーマ: ${UI_THEMES.map((t) => `${t.id}（${t.name}${t.orientation === "portrait" ? "。縦長のプロジェクト専用" : ""}）`).join("、")}。liminalia.json の ui.system を置き換える（フォントと画像はテーマが決めていなければ残す）。縦長専用のテーマは横長のプロジェクトには適用できない。`,
          `Applies a theme for the look of the whole game (text, frames, names, choices and system screens) and copies its assets into the project. A project's own themes/<id>/theme.json can be chosen too. Built-in themes: ${UI_THEMES.map((t) => `${t.id} (${t.nameEn}${t.orientation === "portrait" ? ", portrait projects only" : ""})`).join(", ")}. Replaces ui.system in liminalia.json (fonts and images are kept unless the theme sets them). A portrait-only theme can't be applied to a landscape project.`,
        ),
        inputSchema: { type: "object", properties: { project, theme: { type: "string" } }, required: ["project", "theme"] },
        run: async (args) => {
          const dir = this.project(args);
          const themes = listUiThemes(dir);
          const theme = themes.find((t) => t.id === need(args, "theme"));
          if (!theme) throw new ToolError(`テーマがありません。${themes.map((t) => t.id).join("、")} のどれかです`);
          const loaded = loadProject(dir);
          if (!themeFitsScreen(theme, loaded.screen)) throw new ToolError(`テーマ「${theme.name}」は縦長のプロジェクト専用です（このプロジェクトの画面は ${loaded.screen.width}×${loaded.screen.height}）。liminalia.json の screen を縦長にするか、ほかのテーマを選んでください`);
          copyUiThemeAssets(dir, theme, loaded.paths.assets);
          const file = join(dir, "liminalia.json");
          const config = JSON.parse(readFileSync(file, "utf8")) as { ui?: UiConfig };
          writeFileSync(file, `${JSON.stringify({ ...config, ui: applyUiTheme(config.ui ?? {}, theme, themes) }, null, 2)}\n`);
          return text(`テーマ「${theme.name}」を適用しました。screenshot の title で見た目を確認できます。`);
        },
      },
      {
        name: "install_plugin",
        description: both("公式のプラグインをプロジェクトに入れる（プロジェクトの plugins/ にコピーし、liminalia.json に追加する）。id を省くと入れられるものの一覧を返す。", "Installs an official plugin into a project (copies it to plugins/ and adds it to liminalia.json). Without id, lists the plugins that can be installed."),
        inputSchema: { type: "object", properties: { project, id: { type: "string" } }, required: ["project"] },
        run: async (args) => {
          const dir = this.project(args);
          // 一覧は LIMINALIA_PLUGIN_CATALOG かこのリポジトリの catalog/、npm で入れた lim は cli の中の plugins/
          const items = readCatalog(catalogDir() ?? bundledCatalogDir());
          const id = str(args, "id");
          if (!id) return text(items.length ? items.map((i) => `${i.entry.id}: ${i.entry.name} — ${i.entry.description}${i.dir ? "" : "（このコンピューターにはありません）"}`).join("\n") : "公式のプラグインの一覧が見つかりません");
          const item = items.find((i) => i.entry.id === id);
          if (!item?.dir) throw new ToolError(`公式のプラグイン ${id} は入れられません（一覧にないか、フォルダが見つかりません）`);
          const to = join(dir, "plugins", id);
          copyPluginFolder(item.dir, to);
          const file = join(dir, "liminalia.json");
          const config = JSON.parse(readFileSync(file, "utf8")) as { plugins?: string[] };
          const spec = `./plugins/${id}`;
          if (!(config.plugins ?? []).includes(spec)) writeFileSync(file, `${JSON.stringify({ ...config, plugins: [...(config.plugins ?? []), spec] }, null, 2)}\n`);
          return text(`${item.entry.name} を入れました（${spec}）。Studio を開き直すと使えます。`);
        },
      },
      {
        name: "import_asset",
        description: both("このコンピューターの画像、音、動画のファイルを、プロジェクトの素材にコピーする。kind は bgimage（背景）、fgimage（立ち絵）、image（画像）、bgm、sound（効果音）、voice、video、others。立ち絵をキャラクターに紐づけるのは register_character（コピーも一緒にできる）。", "Copies an image, audio or video file on this computer into the project's assets. kind is bgimage (background), fgimage (character sprite), image, bgm, sound (sound effect), voice, video or others. To link sprites to a character, use register_character (it can copy them too)."),
        inputSchema: {
          type: "object",
          properties: { project, file: { type: "string", description: both("コピーするファイルの絶対パス", "Absolute path of the file to copy") }, kind: { type: "string", enum: [...ASSET_KINDS] }, name: { type: "string", description: both("素材のフォルダの中の名前（省くと元の名前。sub/name.png のように下のフォルダも書ける）", "Name inside the asset folder (omit to keep the original name; subfolders like sub/name.png are allowed)") } },
          required: ["project", "file", "kind"],
        },
        run: async (args) => {
          const dir = this.project(args);
          const from = need(args, "file");
          if (!isAbsolute(from) || !existsSync(from) || !statSync(from).isFile()) throw new ToolError(`ファイルが見つかりません（絶対パスで指定してください）: ${from}`);
          const kind = need(args, "kind");
          // inputSchema の enum は呼ぶ側が守るとは限らないので、ここでも照らす（kind に .. を入れて置き場の外へ書かせない）
          if (!(ASSET_KINDS as readonly string[]).includes(kind)) throw new ToolError(`kind は ${ASSET_KINDS.join("、")} のどれかです`);
          // 写す元は素材に使う種類のファイルだけ（隠しフォルダの中の鍵や設定を、作品へ写して外へ出させない）
          if (!ASSET_FILE_EXTENSIONS.has(extname(from).toLowerCase()) || from.split(/[\\/]/).some((part) => part.startsWith("."))) throw new ToolError(`素材としてコピーできるのは、隠しフォルダの外の画像、音、動画、字幕、フォント、モデルのファイルだけです: ${from}`);
          const name = (str(args, "name") ?? basename(from)).replace(/\\/g, "/");
          const base = join(loadProject(dir).paths.assets, kind);
          const to = resolve(base, name);
          if (!inside(base, to) || !containedPath(base, to) || extname(to).toLowerCase() !== extname(from).toLowerCase()) throw new ToolError("name は素材のフォルダの中で、元と同じ拡張子にしてください");
          if (existsSync(to)) throw new ToolError(`同じ名前の素材があります: ${kind}/${name}`);
          mkdirSync(dirname(to), { recursive: true });
          copyFileSync(from, to);
          return text(`${kind}/${name} にコピーしました。シナリオからは ${kind === "bgimage" ? `@bg ${name}` : kind === "bgm" ? `@bgm ${name}` : kind === "sound" ? `@se ${name}` : name} のように指定できます。`);
        },
      },
      {
        name: "build",
        description: both("プロジェクトを書き出す（browser、mac、windows、linux）。書き出す前にチェックする。数分かかることがある。", "Exports a project (browser, mac, windows or linux). It's checked before export. This can take a few minutes."),
        inputSchema: { type: "object", properties: { project, target: { type: "string", enum: ["browser", "mac", "windows", "linux"] } }, required: ["project", "target"] },
        run: async (args) => {
          const target = need(args, "target");
          if (!["browser", "mac", "windows", "linux"].includes(target)) throw new ToolError("target は browser、mac、windows、linux のどれかです");
          return this.limResult(["build", this.project(args), target], 20 * 60_000);
        },
      },
      ...studioTools({ project: (a) => this.project(a), workspace: (d) => this.workspace(d), studio }),
      ...authoringTools({
        project: (a) => this.project(a),
        workspace: (d) => this.workspace(d),
        studio,
        scenarioName: (d, f) => this.scenarioName(d, f),
        guardedWrite: (d, n, p, next, base, allow) => this.guardedWrite(d, n, p, next, base, allow),
        lim: (a, t) => this.lim(a, t),
      }),
      ...testingTools({ project: (a) => this.project(a), lim: (a, t) => this.lim(a, t) }),
      ...screenTools({ project: (a) => this.project(a), lim: (a, t) => this.lim(a, t), headlessMissing }),
    ];
  }

  /** JSON-RPC の一つの要求に答える（通知なら null）。 */
  async handle(msg: { id?: number | string | null; method?: string; params?: Record<string, unknown> }): Promise<object | null> {
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
    if (msg.id === undefined || msg.id === null) return null;
    switch (msg.method) {
      case "initialize":
        return reply({
          protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "liminalia", version: engineVersion() },
          instructions: both(
            "Liminalia はビジュアルノベルのエンジン。シナリオ（.lim）を初めて書く前に scenario_guide で書き方の手引き（台詞、ラベル、ルビ、選択肢、@if、式の関数）を読む。" +
              "プロジェクトは create_project で作成し、シナリオは read_scenario で読んで（hash も返る）、write_scenario（丸ごと。すでにあるシナリオは baseHash に読んだ hash）か edit_scenario（一部の行）で書く。" +
              "読んだあとで Studio などで編集されていたら書かずに今の中身を返すので、合わせ直して書く。書くとエラーが増えるなら書かずに増えるエラーを返すので、直して書き直す（restore_scenario で前のバージョンに戻せる）。" +
              "書く前に check_text、書いたら check でチェックし、trace で流れ、screenshot で見た目を確認する。立ち絵は read_cast、マクロは list_macros、その行のプレビュー状態は line_state で確認する。" +
              "標準の画面（セーブ、コンフィグ、エンディングなど）の見た目を変えるときは、list_screens で部品と効くテーマの値を選び、update_settings で ui を編集し、screen_shot でサンプルデータを入れて撮って確認する。" +
              "値や CSS で届かない形（ボタンの並び、要素の追加など）に変えるときは、コピー → 編集 → スクリーンショット確認: copy_screen で標準の画面のテンプレートをプロジェクトにコピーし、read_screen_files で読み、write_screen_file でテンプレート（HTML と属性）、プロジェクトの CSS、画面の JS を書き（書いたらテンプレートのチェックが返る）、screen_shot で撮って確認する。lim check が template-outdated を出したら diff_screen で標準の変わったところを見る。" +
              "コマンドの書き方は command_reference で調べる（query にやりたいことを入れる）。人が手で直すときは open_studio で Studio を開く。",
            "Liminalia is a visual novel engine. Before writing a script (.lim) for the first time, read the guide with scenario_guide (dialogue, labels, ruby, choices, @if, expression functions). " +
              "Create a project with create_project. Read a script with read_scenario (it also returns a hash) and write it with write_scenario (the whole script; for an existing one, pass the hash you read as baseHash) or edit_scenario (some lines). " +
              "If it was changed elsewhere, such as in Studio, after you read it, nothing is written and the current text is returned; adjust to it and write again. If writing adds errors, nothing is written and the added errors are returned; fix them and write again (restore_scenario goes back to the previous version). " +
              "Check with check_text before writing and with check after, run it with trace and check the look with screenshot. Check sprites with read_cast, macros with list_macros and the stage at a line with line_state. " +
              "To change the look of a built-in screen (save, settings, ending and so on), pick the part and the theme value that applies with list_screens, edit ui with update_settings, and check it with screen_shot, which captures it with sample content. " +
              "For a shape values and CSS can't reach (the order of buttons, added elements and so on), copy, edit, then capture: copy the built-in screen template into the project with copy_screen, read it with read_screen_files, write the template (HTML and attributes), project CSS or screen JS with write_screen_file (the template check comes back after writing), and check it with screen_shot. When lim check reports template-outdated, see what changed in the built-in template with diff_screen. " +
              "Look up how to write commands with command_reference (put what you want to do in query). When a person wants to edit by hand, open Studio with open_studio.",
          ),
        });
      case "ping":
        return reply({});
      case "resources/list":
        return reply({ resources: [{ uri: GUIDE_URI, name: "scenario-guide", title: "シナリオ（.lim）の書き方 / How to write scripts (.lim)", description: both("scenario_guide と同じ手引き", "The same guide as scenario_guide"), mimeType: "text/markdown" }] });
      case "resources/read":
        if (msg.params?.uri !== GUIDE_URI) return fail(-32002, `resource がありません: ${String(msg.params?.uri)}`);
        return reply({ contents: [{ uri: GUIDE_URI, mimeType: "text/markdown", text: scenarioGuide() }] });
      case "tools/list":
        return reply({ tools: this.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case "tools/call": {
        const tool = this.tools.find((t) => t.name === msg.params?.name);
        if (!tool) return fail(-32602, `ツールがありません: ${String(msg.params?.name)}`);
        try {
          return reply(await tool.run((msg.params?.arguments as Record<string, unknown> | undefined) ?? {}));
        } catch (e) {
          return reply(text(e instanceof Error ? e.message : String(e), true));
        }
      }
      default:
        return fail(-32601, `扱えない要求です: ${msg.method}`);
    }
  }

  close(): void {
    for (const s of this.servers.values()) s.child.kill();
  }
}

export async function runMcp(flagRoots: string[]): Promise<void> {
  // 標準出力は MCP の通信だけに使う。同じプロセスで読む作品のプラグインなどが console.log で書いても混ざらないよう、標準エラーへ回す
  console.log = console.info = console.debug = (...a: unknown[]) => console.error(...a);
  const server = new McpServer(mcpRoots(flagRoots));
  const write = (o: object) => process.stdout.write(`${JSON.stringify(o)}\n`);
  const lines = createInterface({ input: process.stdin });
  const pending = new Set<Promise<void>>();
  for await (const line of lines) {
    if (!line.trim()) continue;
    let msg: Parameters<McpServer["handle"]>[0];
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      // 読めない行は JSON-RPC の誤り（-32700）として返す
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON として読めません" } });
      continue;
    }
    // 時間のかかる道具（書き出しなど）のあいだも、ほかの要求に答えられるように待たずに進む
    const p = server.handle(msg).then((r) => {
      if (r) write(r);
    });
    pending.add(p);
    void p.finally(() => pending.delete(p));
  }
  await Promise.all(pending);
  server.close();
}
