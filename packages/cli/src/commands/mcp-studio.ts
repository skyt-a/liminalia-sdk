import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  addAppearance,
  castProblems,
  endingLabel,
  folderOf,
  initialFrameAlone,
  initialFrameFromReference,
  normalizeKey,
  referenceVariantKey,
  sanitizeFileBase,
  SPRITE_IMAGE_EXTENSIONS,
  uniqueKey,
  type Cast,
  type CastEntry,
  type CastFrame,
  type CastVariant,
} from "@liminalia/lang";
import { loadProject } from "@liminalia/project";
import { DEFAULT_COVERAGE_RUNS, type Value } from "@liminalia/runtime";
import type { StudioWorkspace } from "@liminalia/studio/server";
import { loadContext } from "../context.ts";
import { packFileCoverage } from "./coverage.ts";
import { imageInfoOf } from "../image-info.ts";
import { both, need, PROJECT_PARAM as project, str, text, ToolError, type Tool } from "./mcp-tools.ts";

/**
 * lim mcp の道具のうち、制作画面の開発サーバーの口と同じ処理（@liminalia/studio/server）をこのプロセスで呼ぶもの。
 * 規則（検査・名前の決まり・読んだあとの変更の確かめ）と履歴（liminalia.json は .liminalia/history/@config/、cast.json は
 * .liminalia/backups/、台本は .liminalia/history/<ファイル>/）は制作画面と同じ。制作画面が開いていれば、台本と cast.json の変更は
 * 開発サーバーのファイルの見張りが知らせる。
 */

type StudioServerModule = typeof import("@liminalia/studio/server");

export interface StudioToolHost {
  /** 作品のフォルダ（置き場の中にあり、liminalia.json がある）。 */
  project(args: Record<string, unknown>): string;
  /** 制作画面と同じ作品の読み書き（呼ぶたびに読み直す）。 */
  workspace(dir: string): Promise<StudioWorkspace>;
  studio(): Promise<StudioServerModule>;
}

/** キャラクター ID に使えない文字（制作画面のキャラクターの画面と同じ）。 */
const BAD_CAST_NAME = /[\s"=()#@]/;

/** JSON の値か（変数の初期値）。 */
const isValue = (v: unknown): v is Value => v === null || ["string", "number", "boolean"].includes(typeof v) || (typeof v === "object" && !Array.isArray(v)) || Array.isArray(v);

/** 今の値に重ねる（オブジェクトは中まで重ね、null の項目は外す）。 */
export function mergePatch(base: unknown, patch: unknown): unknown {
  if (patch === null) return undefined;
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || !base || typeof base !== "object" || Array.isArray(base)) return patch;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    const next = mergePatch(out[k], v);
    if (next === undefined) delete out[k];
    else out[k] = next;
  }
  return out;
}

/**
 * MCP からは変えられない設定の場所。外のコマンドやモジュールを動かすもの（書き出しの包み・署名・店の口）、
 * 台本のスクリプトを許すもの、ファイルの置き場を作品の外へ向けられるもの（paths・import）。
 * AI が読んだ文書に仕込まれた指示で、利用者の権限のコマンドが動いたり、置き場の外に書いたりしないようにする。
 * 変えるのは利用者が liminalia.json か制作画面で行う。
 */
export const MCP_LOCKED_SETTINGS = [
  ["paths"],
  ["import"],
  ["allowScript"],
  ["build", "windows", "wrap"],
  ["build", "windows", "sign"],
  ["build", "mac"],
  ["build", "store", "desktop"],
  ["build", "store", "android"],
] as const;

const at = (v: unknown, path: readonly string[]): unknown => path.reduce<unknown>((o, k) => (o && typeof o === "object" && !Array.isArray(o) && Object.hasOwn(o, k) ? (o as Record<string, unknown>)[k] : undefined), v);

/** 重ねたあとの設定で、MCP からは変えられない場所のうち変わったもの（"build.windows.wrap" の形）。 */
export function lockedSettingsChanged(before: unknown, after: unknown): string[] {
  return MCP_LOCKED_SETTINGS.filter((p) => JSON.stringify(at(before, p)) !== JSON.stringify(at(after, p))).map((p) => p.join("."));
}

export function studioTools(host: StudioToolHost): Tool[] {
  return [
    {
      name: "register_character",
      description: both(
        "キャラクター（cast.json の人物）を登録し、立ち絵を紐づける（Studio のキャラクター画面と同じ規則。cast.json の前のバージョンは .liminalia/backups/ に残る）。" +
        "無い人物は作り、話者にも追加する。sprites の画像は、このコンピューターの絶対パスなら assets/fgimage/<人物のフォルダ>/ にコピーし、assets/fgimage からのパスならそのまま使う。" +
        "差分の枠（大きさと立ち位置）は Studio と同じく、基準の差分に合わせる（無ければ画面に収める）。同じ名前の差分があれば絵を差し替える（枠はそのまま）。" +
        "登録したらシナリオから @chara <id> <差分> で出せる。位置を細かく合わせるのは Studio（open_studio）のキャラクター画面。",
        "Registers a character (an entry in cast.json) and links sprites to it (the same rules as the Characters screen in Studio; the previous cast.json is kept in .liminalia/backups/). A missing character is created and added to the speakers. Sprite images given as absolute paths on this computer are copied to assets/fgimage/<character folder>/; paths from assets/fgimage are used as they are. The frame of each variant (size and position) follows the base variant like in Studio (or fits the screen if there's none). A variant with the same name gets its image replaced (the frame stays). Once registered, show it from a script with @chara <id> <variant>. To fine-tune positions, use the Characters screen in Studio (open_studio).",
      ),
      inputSchema: {
        type: "object",
        properties: {
          project,
          id: { type: "string", description: both("キャラクター ID（シナリオの @chara の名前。空白と \" = ( ) # @ は使えない）", "Character ID (the name used in @chara; spaces and \" = ( ) # @ aren't allowed)") },
          speaker: { type: "string", description: both("台詞の行頭に書く話者名（ID と違うときだけ）", "Speaker name written at the start of dialogue lines (only when it differs from the ID)") },
          color: { type: "string", description: both("名前の欄の文字の色（CSS の色。#e05a7a など）", "Color of the name in the name box (a CSS color such as #e05a7a)") },
          appearance: { type: "string", description: both("立ち絵セット（服装など。既定 default。無ければ作る）", "Appearance (outfit and so on; default is default; created if missing)") },
          sprites: {
            type: "array",
            description: both("紐づける立ち絵", "Sprites to link"),
            items: {
              type: "object",
              properties: { file: { type: "string", description: both("画像（png、jpg、webp、gif）の絶対パスか、assets/fgimage からのパス", "Absolute path of an image (png, jpg, webp or gif), or a path from assets/fgimage") }, variant: { type: "string", description: both("差分の名前（表情など。省くとファイル名）", "Variant name (an expression and so on; omit to use the file name)") } },
              required: ["file"],
            },
          },
          defaultVariant: { type: "string", description: both("差分を書かずに出したときの差分", "Variant shown when none is written") },
        },
        required: ["project", "id"],
      },
      run: async (args) => {
        const dir = host.project(args);
        const id = need(args, "id").trim();
        if (BAD_CAST_NAME.test(id)) throw new ToolError(`キャラクター ID ${id} は使えません（空白と " = ( ) # @ を含めない）`);
        const loaded = loadProject(dir);
        const caster = await import("@liminalia/web/caster-server");
        const version = caster.currentVersion(loaded);
        const raw = existsSync(loaded.paths.cast) ? (JSON.parse(readFileSync(loaded.paths.cast, "utf8")) as { speakers?: string[]; cast?: Cast }) : {};
        const speakers = [...(raw.speakers ?? [])];
        const cast: Cast = structuredClone(raw.cast ?? {});
        const done: string[] = [];
        let entry: CastEntry | undefined = cast[id];
        if (!entry) {
          entry = cast[id] = { defaultAppearance: "default", appearances: { default: { variants: {} } } };
          if (!speakers.includes(id)) speakers.push(id);
          done.push(`キャラクター ${id} を足しました`);
        }
        const speaker = str(args, "speaker")?.trim();
        if (speaker !== undefined) {
          if (speaker === id) delete entry.speaker;
          else entry.speaker = speaker;
          if (!speakers.includes(speaker)) speakers.push(speaker);
          done.push(`話者名: ${speaker}`);
        }
        const color = str(args, "color");
        if (color !== undefined) {
          entry.color = color;
          done.push(`名前の色: ${color}`);
        }
        let app = str(args, "appearance") ?? entry.defaultAppearance ?? Object.keys(entry.appearances)[0] ?? "default";
        if (!entry.appearances[app]) {
          const key = normalizeKey(app);
          if (!key) throw new ToolError(`立ち絵セットの名前 ${app} は使えません`);
          app = entry.appearances[key] ? key : addAppearance(entry, key);
          done.push(`立ち絵セット ${app} を足しました`);
        }
        const appearance = entry.appearances[app]!;
        const sprites = Array.isArray(args.sprites) ? (args.sprites as { file?: unknown; variant?: unknown }[]) : [];
        if (sprites.length > 0) {
          const fgimage = join(loaded.paths.assets, "fgimage");
          const info = (path: string) => imageInfoOf(readFileSync(join(fgimage, path)));
          // 基準の差分（この立ち絵セットのもの、無ければほかの立ち絵セットのもの）。prepareVariants と同じ
          let reference: CastVariant | undefined;
          const refKey = referenceVariantKey(appearance);
          if (refKey) reference = appearance.variants[refKey];
          else for (const a of Object.values(entry.appearances)) reference ??= a.variants[referenceVariantKey(a) ?? ""];
          let refInfo = reference && existsSync(join(fgimage, reference.image)) ? info(reference.image) : null;
          const folder = (() => {
            for (const a of Object.values(entry.appearances)) for (const v of Object.values(a.variants)) return folderOf(v.image);
            return sanitizeFileBase(id);
          })();
          const screen = loaded.screen;
          for (const s of sprites) {
            if (typeof s?.file !== "string" || s.file === "") throw new ToolError("sprites は { file, variant? } の並びで送ってください");
            const ext = extname(s.file).toLowerCase().slice(1);
            if (!(SPRITE_IMAGE_EXTENSIONS as readonly string[]).includes(ext)) throw new ToolError(`立ち絵に使えるのは ${SPRITE_IMAGE_EXTENSIONS.join("、")} です: ${s.file}`);
            let path: string;
            if (isAbsolute(s.file) && !resolve(s.file).startsWith(fgimage + sep)) {
              if (!existsSync(s.file) || !statSync(s.file).isFile()) throw new ToolError(`ファイルが見つかりません: ${s.file}`);
              // 隠しフォルダの中のファイルは写さない（作品へ写して外へ出させない）
              if (s.file.split(/[\\/]/).some((part) => part.startsWith("."))) throw new ToolError(`隠しフォルダの中のファイルは立ち絵に使えません: ${s.file}`);
              const name = `${sanitizeFileBase(s.file.split(/[\\/]/).pop()!)}.${ext}`;
              path = folder ? `${folder}/${name}` : name;
              const to = join(fgimage, path);
              if (existsSync(to) && !readFileSync(to).equals(readFileSync(s.file))) throw new ToolError(`assets/fgimage/${path} に別の絵があります。上書きしないので、ファイルの名前を変えてから登録してください`);
              mkdirSync(join(to, ".."), { recursive: true });
              if (!existsSync(to)) copyFileSync(s.file, to);
            } else {
              path = (isAbsolute(s.file) ? relative(fgimage, resolve(s.file)) : s.file.replace(/\\/g, "/").replace(/^(assets\/)?fgimage\//, "")).split(sep).join("/");
              const at = resolve(fgimage, path);
              if (!at.startsWith(fgimage + sep) || !existsSync(at)) throw new ToolError(`assets/fgimage に ${path} がありません（このコンピューターの画像なら絶対パスで渡してください）`);
            }
            const next = info(path);
            if (!next) throw new ToolError(`画像として読めません: ${path}`);
            const wanted = typeof s.variant === "string" && s.variant.trim() !== "" ? normalizeKey(s.variant) : "";
            const existing = wanted ? appearance.variants[wanted] : undefined;
            if (existing) {
              existing.image = path;
              done.push(`差分 ${wanted} の絵を ${path} に差し替えました（枠はそのまま）`);
              continue;
            }
            let frame: CastFrame | undefined;
            if (reference?.frame) frame = initialFrameFromReference({ frame: reference.frame, info: refInfo }, next);
            else if (!reference) frame = initialFrameAlone(next, screen);
            const key = wanted || uniqueKey(appearance.variants, normalizeKey(path.split("/").pop()!.replace(/\.[^.]+$/, "")) || "variant");
            appearance.variants[key] = { image: path, ...(frame ? { frame } : {}) };
            done.push(`差分 ${key} を足しました（${path}${frame ? `、枠 ${frame.width}×${frame.height}` : ""}）`);
            // 最初の差分は、そのあとに足す差分の基準になる（制作画面で一つずつ足したときと同じ）
            if (!reference) {
              reference = appearance.variants[key];
              refInfo = next;
            }
          }
        }
        const dv = str(args, "defaultVariant");
        if (dv !== undefined) {
          if (!appearance.variants[dv]) throw new ToolError(`立ち絵セット ${app} に差分 ${dv} がありません（${Object.keys(appearance.variants).join("、") || "差分がありません"}）`);
          appearance.defaultVariant = dv;
          done.push(`差分を書かないときの差分: ${dv}`);
        }
        const problems = castProblems(cast as Record<string, unknown>);
        if (problems.length > 0) throw new ToolError(`キャラクターの設定に誤りがあります: ${problems.map((p) => `${p.who}: ${p.message}`).join("、")}`);
        if (caster.currentVersion(loaded) !== version) throw new ToolError("cast.json が読んでいる間にほかで変更されました。もう一度呼んでください");
        const saved = await caster.saveCast(loaded, cast, (entryFile) => import(pathToFileURL(entryFile).href), speakers, {});
        const variants = Object.keys(appearance.variants);
        return text(
          [
            ...done,
            saved.backup ? `cast.json の前のバージョン: ${relative(dir, saved.backup).split(sep).join("/")}` : "",
            ...saved.wroteBack.map((f) => `インポート元にも書き戻しました: ${f}`),
            ...saved.notes,
            "",
            `${id} の立ち絵セット ${app} の差分: ${variants.join("、") || "（なし）"}`,
            variants.length ? `シナリオからは @chara ${id} ${variants[0]} のように出せます。` : "",
          ]
            .filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== ""))
            .join("\n"),
        );
      },
    },
    {
      name: "read_settings",
      description: both(
        "プロジェクトの設定（liminalia.json のタイトル title、バージョン version、作者 author、画面サイズ screen、はじめの位置 entry、セーブ saves、書き出し build など。Studio の「プロジェクト」の基本と書き出し）と、変数の初期値を返す。" +
        "hash は update_settings の baseHash に渡す。",
        "Returns the project settings (title, version, author, screen size, entry, saves, build and so on in liminalia.json; the basics and export of Project in Studio) and the initial values of variables. Pass hash to baseHash of update_settings.",
      ),
      inputSchema: { type: "object", properties: { project }, required: ["project"] },
      run: async (args) => {
        const ws = await host.workspace(host.project(args));
        const s = await host.studio();
        const settings = s.readSettings(ws);
        return text(JSON.stringify({ settings, hash: s.configPartHash(settings), variables: ws.readVariables() }, null, 2));
      },
    },
    {
      name: "update_settings",
      description: both(
        "プロジェクトの設定と変数の初期値を変える（Studio の「プロジェクト」と「変数」と同じ規則。前の liminalia.json は .liminalia/history/@config/ に残る）。" +
        "settings は今の設定に重ねる（オブジェクトは中まで重ね、null の項目は外す。例: { \"title\": \"星の話\", \"version\": \"1.1.0\", \"screen\": { \"width\": 1920, \"height\": 1080 } }）。" +
        "baseHash（read_settings の hash）を渡すと、読んだあとにほかで変わっていれば書かずに今の設定を返す。" +
        "variables は変数のパス（game.名前、system.名前）→ 初期値（null なら初期値を外す）。",
        "Changes the project settings and the initial values of variables (the same rules as Project and Variables in Studio; the previous liminalia.json is kept in .liminalia/history/@config/). settings is merged into the current settings (objects are merged deeply and null removes an item; for example { \"title\": \"Star story\", \"version\": \"1.1.0\", \"screen\": { \"width\": 1920, \"height\": 1080 } }). With baseHash (the hash from read_settings), nothing is written and the current settings are returned if they changed elsewhere after reading. variables maps variable paths (game.name, system.name) to initial values (null removes the initial value).",
      ),
      inputSchema: {
        type: "object",
        properties: {
          project,
          settings: { type: "object", description: both("重ねる設定（id、title、version、author、screen、entry、titleScreen、afterLoad、saves、build）。paths、import、allowScript と、build の windows.wrap、windows.sign、mac、store.desktop、store.android は変えられない", "Settings to merge (id, title, version, author, screen, entry, titleScreen, afterLoad, saves, build). paths, import, allowScript and build windows.wrap, windows.sign, mac, store.desktop and store.android can't be changed") },
          baseHash: { type: "string" },
          variables: { type: "object", description: both("変数のパス → 初期値（null で外す）", "Variable path → initial value (null removes it)") },
        },
        required: ["project"],
      },
      run: async (args) => {
        const ws = await host.workspace(host.project(args));
        const s = await host.studio();
        const lines: string[] = [];
        const patch = args.settings;
        if (patch !== undefined) {
          if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new ToolError("settings はオブジェクトで送ってください");
          const current = s.readSettings(ws);
          const hash = str(args, "baseHash") ?? s.configPartHash(current);
          const merged = mergePatch(current, patch);
          const locked = lockedSettingsChanged(current, merged);
          if (locked.length > 0) throw new ToolError(`${locked.join("、")} は MCP からは変えられません（外のコマンドを動かす、または保存先の外を指す設定です）。変えるときは、利用者に liminalia.json か Studio で直してもらってください`);
          let r;
          try {
            r = s.setSettings(ws, merged, hash);
          } catch (e) {
            if (e instanceof s.StudioError) throw new ToolError(e.message);
            throw e;
          }
          if (!r.ok) return text(`設定は読んだあとでほかで変わっています。書いていません。今の設定に合わせて直し、この hash を baseHash にしてください。\n\n${JSON.stringify({ settings: r.current.value, hash: r.current.hash }, null, 2)}`, true);
          lines.push(`設定を書きました（hash: ${r.hash}）。`);
          if (r.restart) lines.push("Studio を開いていれば、起動し直すと効きます。");
        }
        const vars = args.variables;
        if (vars !== undefined) {
          if (!vars || typeof vars !== "object" || Array.isArray(vars)) throw new ToolError("variables は変数のパス → 初期値 のオブジェクトで送ってください");
          for (const [path, value] of Object.entries(vars)) {
            if (!isValue(value)) throw new ToolError(`${path} の初期値は JSON の値で送ってください`);
            try {
              s.setVariable(ws, path, value, value === null);
            } catch (e) {
              if (e instanceof s.StudioError) throw new ToolError(e.message);
              throw e;
            }
            lines.push(value === null ? `${path} の初期値を外しました` : `${path} の初期値: ${JSON.stringify(value)}`);
          }
        }
        if (lines.length === 0) throw new ToolError("settings か variables を送ってください");
        return text(lines.join("\n"));
      },
    },
    {
      name: "list_variables",
      description: both("シナリオで使っている変数と初期値、値を入れる行と読む行を返す（Studio の「変数」と同じ）。", "Returns the variables used in the scripts with their initial values and the lines that set and read them (same as Variables in Studio)."),
      inputSchema: { type: "object", properties: { project }, required: ["project"] },
      run: async (args) => {
        const ws = await host.workspace(host.project(args));
        const list = (await host.studio()).listVariables(ws);
        const at = (xs: { file: string; line: number }[]) => (xs.length ? xs.slice(0, 8).map((x) => `${x.file}:${x.line}`).join("、") + (xs.length > 8 ? ` ほか ${xs.length - 8}` : "") : "なし");
        return text(list.length ? list.map((v) => `${v.path}${v.initial !== undefined ? ` = ${JSON.stringify(v.initial)}` : "（初期値なし）"}\n  入れる: ${at(v.writes)}\n  読む: ${at(v.reads)}`).join("\n") : "変数はまだありません");
      },
    },
    {
      name: "search",
      description: both("プロジェクトの全シナリオを検索する（Studio の全体検索と同じ。5000 行まで）。body なら本文（台詞と地の文）だけ、regex なら正規表現（JavaScript の書き方）。ファイル:行: 中身 を返す。", "Searches all scripts of a project (same as the project search in Studio, up to 5000 lines). body searches only dialogue and narration, regex takes a regular expression (JavaScript syntax). Returns file:line: text."),
      inputSchema: {
        type: "object",
        properties: { project, query: { type: "string" }, regex: { type: "boolean" }, body: { type: "boolean" }, caseSensitive: { type: "boolean" }, kana: { type: "boolean", description: both("ひらがなとカタカナを同じに扱う", "Treat hiragana and katakana as the same") } },
        required: ["project", "query"],
      },
      run: async (args) => {
        const ws = await host.workspace(host.project(args));
        const s = await host.studio();
        const flag = (k: string) => (args[k] === true ? { [k]: true } : {});
        let r;
        try {
          r = s.searchProject(ws, { query: need(args, "query"), ...flag("regex"), ...flag("body"), ...flag("caseSensitive"), ...flag("kana") });
        } catch (e) {
          if (e instanceof s.StudioError) throw new ToolError(e.message);
          throw e;
        }
        const lines = r.files.flatMap((f) => f.lines.map((l) => `${f.file}:${l.line}: ${l.text}`));
        return text(lines.length ? `${r.count} 件${r.truncated ? "（多すぎるので途中まで）" : ""}\n${lines.join("\n")}` : "見つかりません");
      },
    },
    {
      name: "story_map",
      description: both(
        "シナリオから作る分岐の地図（Studio のフローチャートと同じ）。シーン（ファイル#ラベル。行、ページ数、最初の本文、終わり方。エンディングは種類と title（bad「沈黙」））と、シーンのつながり（次へ、@jump、@call、選択肢、コマンド。条件つき）を返す。",
        "Returns the story map built from the scripts (same as the flowchart in Studio): the scenes (file#label with lines, page count, first text and how they end; an ending shows its kind and title, as in bad「Silence」) and the links between them (next, @jump, @call, choices and commands, with conditions).",
      ),
      inputSchema: { type: "object", properties: { project }, required: ["project"] },
      run: async (args) => {
        const ws = await host.workspace(host.project(args));
        const map = ws.storyMap();
        const kinds: Record<string, string> = { next: "次へ", jump: "@jump", call: "@call", choice: "選択肢", command: "コマンド" };
        const ends: Record<string, string> = { end: "ファイルの終わり", return: "@return", stop: "@stop", exit: "終わる" };
        return text(
          [
            `はじめから: ${map.entry}`,
            "",
            "# シーン",
            ...map.nodes.map((n) => `${n.id}（${n.file}.lim ${n.line}〜${n.end} 行、${n.pages} ページ${n.ends ? `、${ends[n.ends]}${n.ending ? ` エンディング ${endingLabel(n.ending)}` : ""}` : ""}）${n.text ? ` ${n.text}` : ""}`),
            "",
            "# つながり",
            ...map.edges.map((e) => `${e.from} → ${e.to}（${kinds[e.kind]}${e.label ? ` ${e.label}` : ""}${e.cond ? ` 条件 ${e.cond}` : ""}、${e.line} 行${e.missing ? "、ジャンプ先がありません" : ""}）`),
          ].join("\n"),
        );
      },
    },
    {
      name: "coverage",
      description: both(
        "全ルートテスト（lim coverage のファイルごとの実行、Studio のチェックと同じ）。画面なしで、まだ試していない選び方へ広げながら実行し、ファイルごとに通った行数と通らない行、実行時の診断を返す。パック（packs/<フォルダ>/scenario）のシナリオも、lim coverage と同じく本体にパックを重ねて実行する（packs/<フォルダ>/scenario/<シナリオ> の位置で出す）。runs はファイルごとに実行する回数の上限（既定 8、32 まで。選び方を試し終えれば早く止まる）。",
        "All-routes test (same as the per-file runs of lim coverage and the checks in Studio). Runs the scripts without a screen, widening to choice combinations not yet tried, and returns per file the number of lines reached, the lines never reached and the diagnostics found while running. Pack scripts (packs/<folder>/scenario) are run too, with the packs laid over the main scripts as in lim coverage (shown as packs/<folder>/scenario/<script>). runs is the most runs per file (default 8, up to 32; it stops early once every choice combination has been tried).",
      ),
      inputSchema: { type: "object", properties: { project, runs: { type: "integer" } }, required: ["project"] },
      run: async (args) => {
        const dir = host.project(args);
        const ws = await host.workspace(dir);
        const runs = typeof args.runs === "number" && Number.isInteger(args.runs) && args.runs > 0 && args.runs <= 32 ? args.runs : DEFAULT_COVERAGE_RUNS;
        const r = await ws.coverage(runs);
        // パックの台本は lim coverage と同じ関数で流す（制作画面の全ルートテストは本体の台本だけ）
        const packs = await packFileCoverage(await loadContext(dir), ws.files(), runs);
        const files = [...r.files, ...packs.files.map((f) => ({ file: f.file, lines: f.lines.length, reached: f.reached.size, unreached: f.lines.filter((l) => !f.reached.has(l)) }))];
        const diagnostics = [...r.diagnostics, ...packs.diagnostics.map((x) => x.diagnostic)];
        return text(
          [
            ...files.map((f) => `${f.file}: ${f.reached}/${f.lines} 行${f.unreached.length ? `、通らない行 ${f.unreached.slice(0, 40).join(",")}${f.unreached.length > 40 ? ` ほか ${f.unreached.length - 40}` : ""}` : ""}`),
            "",
            diagnostics.length ? `# 実行時の診断\n${diagnostics.map((d) => `${d.severity} ${d.file ?? ""}:${d.line} ${d.message}${d.hint ? `（${d.hint}）` : ""}`).join("\n")}` : "実行時の診断はありません",
          ].join("\n"),
          diagnostics.some((d) => d.severity === "error"),
        );
      },
    },
    {
      name: "text_stats",
      description: both("文字数（台詞、地の文、選択肢の行と文字の数、ボイスの付いた台詞の数。全体、ファイル、シーン、話者ごと）と表記ゆれの候補を返す（lim stats、Studio のチェックと同じ集計）。", "Returns text counts (lines and characters of dialogue, narration and choices, and the number of voiced lines, in total and per file, scene and speaker) and possible spelling variations (the same counts as lim stats and the checks in Studio)."),
      inputSchema: { type: "object", properties: { project }, required: ["project"] },
      run: async (args) => {
        const ws = await host.workspace(host.project(args));
        const r = (await host.studio()).textReport(ws);
        const row = (x: { say: { lines: number; chars: number }; prose: { lines: number; chars: number }; choice: { lines: number; chars: number }; voiced: number }) =>
          `台詞 ${x.say.lines} 行 ${x.say.chars} 字、地の文 ${x.prose.lines} 行 ${x.prose.chars} 字、選択肢 ${x.choice.chars} 字、ボイス ${x.voiced}`;
        return text(
          [
            `全体: ${row(r.stats.total)}（${r.stats.total.say.chars + r.stats.total.prose.chars + r.stats.total.choice.chars} 字）`,
            "",
            "# ファイル",
            ...r.stats.files.map((f) => `${f.file}: ${row(f)}`),
            "",
            "# シーン",
            ...r.stats.scenes.map((sc) => `${sc.file}${sc.label ? `#${sc.label}` : ""}: ${row(sc)}`),
            "",
            "# 話者",
            ...r.stats.speakers.map((sp) => `${sp.speaker}: ${sp.say.lines} 行 ${sp.say.chars} 字、ボイス ${sp.voiced}`),
            "",
            "# 表記ゆれの候補",
            ...(r.variants.length ? r.variants.map((g) => `${g.label}: ${g.forms.map((f) => `${f.label}（${f.count}）`).join("、")}`) : ["なし"]),
          ].join("\n"),
        );
      },
    },
    {
      name: "rename_label",
      description: both(
        "シーン（ラベル）の名前を変える（Studio のシーンの名前変更と同じ）。ラベルの行と、そこへのジャンプ先（@jump、@call、選択肢、ジャンプ先の型のパラメータ。ほかのファイルからのものも）、liminalia.json の entry やおまけ、翻訳キーを書き換える。" +
        "書き換えられなかった参照（式の中など）も返す。シナリオの前のバージョンは .liminalia/history/ に残る。",
        "Renames a scene (label) (same as renaming a scene in Studio). Rewrites the label line, the targets pointing to it (@jump, @call, choices and target-type parameters, also from other files), entry and extras in liminalia.json, and translation keys. References that couldn't be rewritten (inside expressions and so on) are returned too. The previous version of the script is kept in .liminalia/history/.",
      ),
      inputSchema: { type: "object", properties: { project, file: { type: "string", description: both("ラベルのあるシナリオ", "Script that has the label") }, from: { type: "string" }, to: { type: "string" } }, required: ["project", "file", "from", "to"] },
      run: async (args) => {
        const ws = await host.workspace(host.project(args));
        const s = await host.studio();
        const file = need(args, "file").replace(/\\/g, "/").replace(/^scenario\//, "").replace(/\.lim$/, "");
        let r;
        try {
          r = s.renameLabel(ws, file, need(args, "from").replace(/^#/, ""), need(args, "to").replace(/^#/, ""));
        } catch (e) {
          if (e instanceof s.StudioError) throw new ToolError(e.message);
          throw e;
        }
        const reasons: Record<string, string> = { expr: "式の中", script: "@script の中", plugin: "プラグインのコマンド", conflict: "同じ名前がある", ambiguous: "どのファイルか決められない", macro: "マクロの中" };
        return text(
          [
            `${r.files.length} ファイル、${r.lines} 行を書き換えました${r.files.length ? `（${r.files.join("、")}）` : ""}。`,
            r.config.length ? `liminalia.json: ${r.config.join("、")}${r.entry ? "（はじめの位置。Studio は起動し直すと効きます）" : ""}` : "",
            r.translations.length ? `翻訳キーを更新した言語: ${r.translations.join("、")}` : "",
            r.left.length ? `書き換えられなかった参照（手で直してください）:\n${r.left.map((l) => `  ${l.config ? `liminalia.json ${l.config}` : `${l.file}:${l.line}`}（${reasons[l.reason] ?? l.reason}）`).join("\n")}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          r.left.length > 0,
        );
      },
    },
  ];
}
