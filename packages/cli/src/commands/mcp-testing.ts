import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { loadProject } from "@liminalia/project";
import { both, need, PROJECT_PARAM as project, str, text, ToolError, type Tool, type ToolResult } from "./mcp-tools.ts";

/**
 * lim mcp の道具のうち、確かめる道具（lim test、lim reach、lim migrate、lim rename、lim playtest とその記録、lim shot --video、lim crash）。
 * どれも lim のコマンドを子のプロセスで動かし（経過が MCP の通信に混ざらないように）、JSON を出せるものは JSON で返す。
 */

export interface TestingHost {
  /** 作品のフォルダ（置き場の中にあり、liminalia.json がある）。 */
  project(args: Record<string, unknown>): string;
  /** lim のコマンドを子のプロセスで動かす。 */
  lim(args: string[], timeoutMs?: number): Promise<{ code: number; out: string }>;
}

/** lim rename の種類。 */
export const RENAME_KINDS = ["label", "file", "variable", "character", "speaker", "asset", "macro"] as const;

/** 一度に返すテストプレイの記録の行の上限。 */
const LOG_PAGE = 200;

const inside = (base: string, path: string) => {
  const rel = relative(base, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** 作品の中のパス（作品の外を指せば断る）。 */
function within(dir: string, given: string, what: string): string {
  const path = resolve(dir, given);
  if (!inside(dir, path)) throw new ToolError(`${what}はプロジェクトのフォルダの中だけを指せます: ${given}`);
  return path;
}

/** 子のコマンドの返事（終了の値が 0 でなければ誤り）。 */
async function run(host: TestingHost, args: string[], timeoutMs?: number): Promise<ToolResult> {
  const r = await host.lim(args, timeoutMs);
  return text(r.out || (r.code === 0 ? "終わりました" : `終了コード ${r.code}`), r.code !== 0);
}

/** テストプレイの記録（<書き出し先>/playtest/run-N.jsonl）の番号の一覧（小さい順）。 */
export function playtestRuns(out: string): number[] {
  const dir = join(out, "playtest");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((n) => /^run-(\d+)\.jsonl$/.exec(n)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

export function testingTools(host: TestingHost): Tool[] {
  return [
    {
      name: "run_tests",
      description: both(
        "シナリオのテスト（tests/*.limtest。lim test --json）を実行し、テストごとの結果（通ったか、期待と違った行と理由、実行したページ数、終わり方、選んだもの、最後の変数）を JSON で返す。paths でテストのファイルかフォルダに絞れる。",
        "Runs the script tests (tests/*.limtest; lim test --json) and returns each test's result as JSON (whether it passed, the lines that didn't match and why, pages run, how it ended, the choices made and the final variables). paths narrows it to test files or folders.",
      ),
      inputSchema: {
        type: "object",
        properties: { project, paths: { type: "array", items: { type: "string" }, description: both("実行するテストのファイルかフォルダ（プロジェクトのフォルダからのパス。省くと tests/ のすべて）", "Test files or folders to run (paths from the project folder; omit for all of tests/)") } },
        required: ["project"],
      },
      run: async (args) => {
        const dir = host.project(args);
        const paths = Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === "string" && p !== "") : [];
        return run(host, ["test", dir, ...paths.map((p) => within(dir, p, "テストのファイル")), "--json"], 10 * 60_000);
      },
    },
    {
      name: "reach",
      description: both(
        "はじめからその場所へ届く選び方を探す（lim reach --json）。target は ファイル#ラベル、ファイル:行、ファイル のどれか。ending ならエンディングの種類（bad など）か名前（title= の一部）で探し、endings なら全エンディングについて届くかを並べる。見つかれば選ぶ選択肢、届いた時点の変数、そのまま tests/*.limtest に書けるテスト（test）を返し、見つからなければ入る条件と条件の変数を決める行を返す。",
        "Searches for choices that reach a place from the start (lim reach --json). target is file#label, file:line or file. With ending, it searches by the kind of an ending (bad and so on) or its name (part of title=), and endings lists whether every ending is reached. When found, returns the choices to make, the variables at that point and a test (test) that can go into tests/*.limtest as is; otherwise returns the conditions to get in and the lines that set their variables.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          project,
          target: { type: "string", description: both("届かせたい場所（ファイル#ラベル、ファイル:行、ファイル）", "Place to reach (file#label, file:line or file)") },
          ending: { type: "string", description: both("届かせたいエンディングの種類か名前", "Kind or name of the ending to reach") },
          endings: { type: "boolean", description: both("すべてのエンディングについて届くかを並べる", "List whether every ending is reached") },
          timeout: { type: "number", description: both("探す時間の上限（秒。既定 30。endings ならエンディングごと）", "Time limit for the search (seconds, default 30; per ending with endings)") },
        },
        required: ["project"],
      },
      run: async (args) => {
        const dir = host.project(args);
        const target = str(args, "target");
        const ending = str(args, "ending");
        const endings = args.endings === true;
        if (!target && !ending && !endings) throw new ToolError("target、ending、endings のどれかを指定してください");
        const timeout = typeof args.timeout === "number" && args.timeout > 0 ? args.timeout : 30;
        const flags = [...(endings ? ["--endings"] : ending ? ["--ending", ending] : [target!]), "--timeout", String(timeout), "--json"];
        return run(host, ["reach", dir, ...flags], (timeout + 30) * 1000 * (endings ? 20 : 2));
      },
    },
    {
      name: "migrate",
      description: both(
        "シナリオと設定を現在の書式に移行する（lim migrate --json）。既定は書き換えずに、移行するもの（コマンド名、パラメータ名（fade= を time= に）、エンディングの書き方、設定）と、既定の見た目や動きが変わったもの（behavior）を返すだけ。write なら書き換え、書き換えたシナリオの行の翻訳キーも移行する。keepBehavior（true か名前の並び）なら、変わったものに前の動きを残す設定も書く。",
        "Moves scripts and settings to the current format (lim migrate --json). By default nothing is rewritten and only what would move (command names, parameter names such as fade= to time=, how endings are written, settings) is returned. With write, they are rewritten, and the translation keys of rewritten lines move with them. With keepBehavior (true or a list of names), settings that keep the old behavior are also written for the defaults that changed (behavior).",
      ),
      inputSchema: {
        type: "object",
        properties: {
          project,
          write: { type: "boolean", description: both("書き換える（既定は確かめるだけ）", "Rewrite (by default it only checks)") },
          keepBehavior: { type: ["boolean", "array"], items: { type: "string" }, description: both("前の動きを残す設定も書く（lim migrate --keep-behavior。true ですべて、名前の並びでそれだけ）", "Also write settings that keep the old behavior (lim migrate --keep-behavior; true for all, or a list of names)") },
        },
        required: ["project"],
      },
      run: async (args) => {
        const dir = host.project(args);
        const write = args.write === true;
        // 確かめるだけなら、移すものがあっても誤りにしない（移すものは JSON に出る）
        const keep = args.keepBehavior === true ? ["--keep-behavior"] : Array.isArray(args.keepBehavior) && args.keepBehavior.length > 0 ? ["--keep-behavior", args.keepBehavior.map(String).join(",")] : [];
        const r = await host.lim(["migrate", dir, ...(write ? [] : ["--check"]), ...keep, "--json"]);
        if (!write) {
          try {
            const j = JSON.parse(r.out) as Record<string, unknown>;
            return text(JSON.stringify({ ...j, ok: true }, null, 2));
          } catch {
            // JSON でなければ（作品が読めないなど）そのまま返す
            return text(r.out, r.code !== 0);
          }
        }
        return text(r.out, r.code !== 0);
      },
    },
    {
      name: "rename",
      description: both(
        "名前を変え、参照しているところも書き換える（lim rename。Studio の名前変更と同じ）。kind は label（ファイル#ラベル）、file（シナリオ）、variable（game.x など）、character（キャラクター ID）、speaker（話者名）、asset（素材のファイル）、macro（@define の名前）。書き換えられなかった参照も返す。",
        "Renames something and rewrites the places that refer to it (lim rename; the same as renaming in Studio). kind is label (file#label), file (script), variable (game.x and so on), character (character ID), speaker (speaker name), asset (asset file) or macro (name of an @define). References that couldn't be rewritten are returned too.",
      ),
      inputSchema: {
        type: "object",
        properties: { project, kind: { type: "string", enum: [...RENAME_KINDS] }, from: { type: "string" }, to: { type: "string" } },
        required: ["project", "kind", "from", "to"],
      },
      run: async (args) => {
        const dir = host.project(args);
        const kind = need(args, "kind");
        if (!(RENAME_KINDS as readonly string[]).includes(kind)) throw new ToolError(`kind は ${RENAME_KINDS.join("、")} のどれかです`);
        return run(host, ["rename", dir, kind, need(args, "from"), need(args, "to")]);
      },
    },
    {
      name: "playtest",
      description: both(
        "書き出したブラウザ版を画面なしの Chromium で「はじめから」最後まで流し（lim playtest --json --fast --log）、エラーと止まった所を JSON で返す。rebuild なら先に書き出す。ページごとの記録は read_playtest_log で読む。数分かかることがある。",
        "Plays the exported browser version from the start to the end in a headless Chromium (lim playtest --json --fast --log) and returns the errors and where it stopped as JSON. With rebuild, it exports first. Read the page-by-page log with read_playtest_log. This can take a few minutes.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          project,
          rebuild: { type: "boolean", description: both("実行前にブラウザ版を書き出す", "Export the browser version before playing") },
          runs: { type: "integer", description: both("実行回数（選び方を替える。既定 1）", "Number of runs (with different choices, default 1)") },
          avoidEnding: { type: "string", description: both("避けるエンディングの種類（カンマ区切り。bad など）", "Kinds of endings to avoid (comma-separated, such as bad)") },
        },
        required: ["project"],
      },
      run: async (args) => {
        const dir = host.project(args);
        const runs = typeof args.runs === "number" && Number.isInteger(args.runs) && args.runs > 0 && args.runs <= 20 ? args.runs : 1;
        const avoid = str(args, "avoidEnding");
        return run(host, ["playtest", dir, "--json", "--fast", "--log", "--runs", String(runs), ...(args.rebuild === true ? ["--rebuild"] : []), ...(avoid ? ["--avoid-ending", avoid] : [])], 30 * 60_000);
      },
    },
    {
      name: "read_playtest_log",
      description: both(
        "テストプレイの記録（lim playtest --log が書き出し先の playtest/run-N.jsonl に残すもの）を読む。ページ（位置、話者、本文、ボイス、舞台）と選択肢（並んだもの、選んだ番号）を順に JSON で返し、終わり方（end）を添える。run で何通り目かを選び（省くと一番新しい番号）、offset と limit（既定 200）で分ける。",
        "Reads a playtest log (what lim playtest --log leaves in playtest/run-N.jsonl in the export folder). Returns the pages (position, speaker, text, voice, stage) and choices (the options and the number picked) in order as JSON, with how it ended (end). run picks which run (omit for the highest number), and offset and limit (default 200) split it into pages.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          project,
          run: { type: "integer", description: both("何通り目の記録か（1 から）", "Which run's log (from 1)") },
          offset: { type: "integer" },
          limit: { type: "integer" },
        },
        required: ["project"],
      },
      run: async (args) => {
        const dir = host.project(args);
        const out = loadProject(dir).paths.out;
        const runs = playtestRuns(out);
        if (runs.length === 0) throw new ToolError("テストプレイの記録がありません。playtest（lim playtest --log）を実行すると残ります");
        const n = typeof args.run === "number" ? args.run : runs.at(-1)!;
        if (!runs.includes(n)) throw new ToolError(`${n} 通り目の記録はありません（あるもの: ${runs.join("、")}）`);
        const rows: Record<string, unknown>[] = [];
        let end: Record<string, unknown> | null = null;
        for (const line of readFileSync(join(out, "playtest", `run-${n}.jsonl`), "utf8").split("\n")) {
          if (line.trim() === "") continue;
          let row: Record<string, unknown>;
          try {
            row = JSON.parse(line) as Record<string, unknown>;
          } catch {
            // 書きかけの行（流している途中で読んだ）は飛ばす
            continue;
          }
          if (row.kind === "end") end = row;
          else rows.push(row);
        }
        const offset = typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 0;
        const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(Math.floor(args.limit), 1000) : LOG_PAGE;
        return text(JSON.stringify({ runs, run: n, total: rows.length, offset, end, entries: rows.slice(offset, offset + limit) }, null, 2));
      },
    },
    {
      name: "record_video",
      description: both(
        "その位置から実際の速さで送りながら録画する（lim shot --video。ffmpeg と Chromium が要る）。out は書き出し先（既定 dist/）の中の名前（split なら動画を置くフォルダ）。split で file か chapter ごとに分け、until で止める所、resume で止まった所から続け、redo で区切りの番号を指して一つだけ録り直す。長い録画は時間がかかる。",
        "Records video from that position while advancing at real speed (lim shot --video; needs ffmpeg and Chromium). out is a name inside the export folder (dist/ by default; with split, the folder for the videos). split divides it by file or chapter, until sets where to stop, resume continues from where it stopped and redo records only the part with that number again. Long recordings take time.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          project,
          start: { type: "string", description: both("録り始める所（ファイル か ファイル#ラベル）", "Where to start recording (file or file#label)") },
          out: { type: "string", description: both("出力の名前（書き出し先の中。既定 video.mp4、split なら video）", "Output name (inside the export folder; default video.mp4, or video with split)") },
          pages: { type: ["integer", "string"], description: both("録るページの数（all で終わりまで）", "Number of pages to record (all for to the end)") },
          split: { type: "string", enum: ["file", "chapter"] },
          until: { type: "string", description: both("止める所（ファイル か ファイル#ラベル）", "Where to stop (file or file#label)") },
          resume: { type: "boolean" },
          redo: { type: "integer", description: both("録り直す区切りの番号（mp4 の名前の頭の 3 桁。split と一緒に）", "Number of the part to record again (the 3 digits at the start of the mp4's name; with split)") },
        },
        required: ["project", "start"],
      },
      run: async (args) => {
        const dir = host.project(args);
        const split = str(args, "split");
        if (split !== undefined && split !== "file" && split !== "chapter") throw new ToolError("split は file か chapter です");
        const base = loadProject(dir).paths.out;
        const name = str(args, "out") ?? (split ? "video" : "video.mp4");
        const out = resolve(base, name);
        if (!inside(base, out) || out === base) throw new ToolError(`out は書き出し先（${relative(dir, base) || "."}）の中の名前にしてください: ${name}`);
        const pages = args.pages === "all" ? "all" : typeof args.pages === "number" && Number.isInteger(args.pages) && args.pages > 0 ? String(args.pages) : undefined;
        return run(
          host,
          [
            "shot",
            dir,
            need(args, "start"),
            "--video",
            out,
            ...(pages ? ["--pages", pages] : []),
            ...(split ? ["--split", split] : []),
            ...(str(args, "until") ? ["--until", str(args, "until")!] : []),
            ...(args.resume === true ? ["--resume"] : []),
            ...(typeof args.redo === "number" && Number.isInteger(args.redo) && args.redo > 0 ? ["--redo", String(args.redo)] : []),
          ],
          6 * 60 * 60_000,
        );
      },
    },
    {
      name: "read_crash_report",
      description: both(
        "書き出したゲームのクラッシュレポート（JSON）を読み、プログラムの位置を書き出しのソースマップの控え（build.sourcemap: \"separate\"）で元のファイルと行に戻して、シナリオの位置（最後のページ、実行中のコマンド、止まる前のページ、実行時の診断）と並べて JSON で返す（lim crash --json）。file はプロジェクトのフォルダからのパス。",
        "Reads a crash record (JSON) of an exported game, maps the program positions back to the original files and lines with the kept source maps (build.sourcemap: \"separate\"), and returns them as JSON next to the script positions (last page, command running, pages before it stopped, runtime diagnostics) (lim crash --json). file is a path from the project folder.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          project,
          file: { type: "string", description: both("クラッシュレポートのファイル（プロジェクトのフォルダからのパス）", "Crash record file (path from the project folder)") },
          maps: { type: "string", description: both("ソースマップの控えのフォルダ（省くと記録の書き出した日時で選ぶ）", "Folder of the kept source maps (omit to pick it by the export time in the record)") },
        },
        required: ["project", "file"],
      },
      run: async (args) => {
        const dir = host.project(args);
        const file = within(dir, need(args, "file"), "記録のファイル");
        const maps = str(args, "maps");
        const r = await host.lim(["crash", dir, file, ...(maps ? ["--maps", within(dir, maps, "ソースマップのフォルダ")] : []), "--json"]);
        // 位置を戻せなくても、台本の位置は返す（誤りにしない）
        return text(r.out, r.out.trim().startsWith("{") ? false : r.code !== 0);
      },
    },
  ];
}
