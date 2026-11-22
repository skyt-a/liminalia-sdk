import { join } from "node:path";
import {
  applyTranslationEntries,
  appearanceKey,
  AUTO_POSITION,
  baseVariant,
  positionNames,
  printLiteral,
  translationKeyKind,
  voiceScriptRows,
  type Cast,
  type Diagnostic,
  type Statement,
  type TranslationFile,
} from "@liminalia/lang";
import { exportVoiceScript, loadProject, projectPackScripts, projectScripts, readCast, readScenarioFile, readVoiceLock } from "@liminalia/project";
import { HISTORY_DIR, keepVersion, writeAtomic } from "@liminalia/studio/server";
import { fmtTargets, formatTarget } from "./fmt.ts";
import type { StageState } from "@liminalia/runtime";
import { afterGame, lineChoices, lineSave, type Sweep } from "@liminalia/studio/protocol";
import { both, need, PROJECT_PARAM as project, str, text, ToolError, type Tool, type ToolResult } from "./mcp-tools.ts";
import type { StudioToolHost } from "./mcp-studio.ts";
import { applyFixesToText } from "../apply-fixes.ts";

/**
 * lim mcp の道具のうち、台本を書くときに読むもの（人物の立ち絵、マクロ、各行の舞台）と、訳、ボイスの台本、書いたものを戻す・整える道具。
 * 台本を書く道具は、書くと作品の誤り（エラー）が増えるなら書かずに増える誤りを返す（allowErrors で書ける。mcp.ts の guardedWrite）。
 */
export interface AuthoringHost extends StudioToolHost {
  /** 台本の名前（シナリオのフォルダからのパス、拡張子なし）とファイル。 */
  scenarioName(dir: string, file: string): { name: string; path: string };
  /** 台本を書く。読んだときの hash を確かめ、書くと誤りが増えるなら書かない（allowErrors なら書く）。書いたら作品全体を検査して返す。 */
  guardedWrite(dir: string, name: string, path: string, next: string, baseHash: string | null, allowErrors: boolean): Promise<ToolResult>;
  /** lim のコマンドを子のプロセスで動かす。 */
  lim(args: string[], timeoutMs?: number): Promise<{ code: number; out: string }>;
}

const ALLOW_ERRORS = { type: "boolean", description: both("書くと作品の誤り（エラー）が増えても書く（既定は書かずに、増える誤りを返す）", "Write even if it adds errors to the project (by default nothing is written and the added errors are returned)") } as const;

/** 一度に返す行の上限（read_translation・voice_script・line_state）。 */
const PAGE = 100;

const pageOf = (args: Record<string, unknown>, max = 500) => {
  const offset = typeof args.offset === "number" && Number.isInteger(args.offset) && args.offset >= 0 ? args.offset : 0;
  const limit = typeof args.limit === "number" && Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, max) : PAGE;
  return { offset, limit };
};

/** マクロの中に @content があるか（@with で中身を渡せるマクロ）。 */
function hasContent(body: readonly Statement[]): boolean {
  return body.some((s) => s.kind === "content" || (s.kind === "if" && s.branches.some((b) => hasContent(b.body))));
}

/** 舞台の様子の要約（背景、立ち絵、BGM、ループの効果音、ウィンドウなど。値のあるものだけ）。 */
function stageSummary(stage: StageState): Record<string, unknown> {
  const out: Record<string, unknown> = { background: stage.background };
  const sprites = Object.entries(stage.sprites ?? {}).map(([who, s]) => ({ who, appearance: s.appearance, variant: s.variant, at: s.at, ...(s.flip ? { flip: true } : {}), ...(s.x !== undefined ? { x: s.x } : {}), ...(s.y !== undefined ? { y: s.y } : {}) }));
  if (sprites.length) out.sprites = sprites;
  if (stage.faceShown) out.face = stage.faceShown;
  if (stage.bgm) out.bgm = { file: stage.bgm.file, volume: stage.bgm.volume, ...(stage.bgm.paused ? { paused: true } : {}) };
  const se = Object.values(stage.loopingSe ?? {}).map((s) => s.file);
  if (se.length) out.loopingSe = se;
  out.window = stage.window;
  if (stage.windowHidden) out.windowHidden = true;
  if (stage.nvl) out.nvl = true;
  if (stage.vertical) out.vertical = true;
  if (stage.mask) out.mask = stage.mask;
  if (stage.camera && (stage.camera.zoom !== 1 || stage.camera.x !== 0 || stage.camera.y !== 0 || stage.camera.rotate !== 0)) out.camera = stage.camera;
  if (stage.planes && Object.keys(stage.planes).length) out.planes = stage.planes;
  if (stage.names && Object.keys(stage.names).length) out.names = stage.names;
  if (stage.tones && Object.keys(stage.tones).length) out.tones = stage.tones;
  if (stage.extra && Object.keys(stage.extra).length) out.extra = Object.keys(stage.extra);
  return out;
}

/** 変数の数が多いときは、並びの先頭から。 */
const MAX_VARIABLES = 200;
const clipVars = (game: Record<string, unknown>) => {
  const keys = Object.keys(game);
  return keys.length <= MAX_VARIABLES ? game : { ...Object.fromEntries(keys.slice(0, MAX_VARIABLES).map((k) => [k, game[k]])), "…": `${keys.length - MAX_VARIABLES} more` };
};

/** 訳のファイルの項目（read_translation が返す形）。 */
interface TranslationItem {
  key: string;
  kind: string;
  source: string;
  text: string;
  speaker?: string;
  note?: string;
  previous?: { source: string; text: string };
  translatedFrom?: string;
  contexts?: Record<string, string>;
  place?: { file: string; line: number; scene: string; before?: string; after?: string };
}

export function authoringTools(host: AuthoringHost): Tool[] {
  const studioError = async <T>(fn: () => T): Promise<T> => {
    const s = await host.studio();
    try {
      return fn();
    } catch (e) {
      if (e instanceof s.StudioError) throw new ToolError(e.message);
      throw e;
    }
  };
  return [
    {
      name: "read_cast",
      description: both(
        "人物（cast.json）を返す。人物ごとの話者名、名前の色、自動配置の定位置（side）、立ち絵セット（既定のもの）、差分（既定のもの）、立ち位置（at= に書ける名前。auto も）、パーツ合成の層と選べる絵、話者の一覧。" +
          "liminalia.json に autoLayout（自動配置の人数ごとの立ち位置、入れる場所、退場したとき、人数で名前の立ち位置を読み替える byCount）があれば、それも返す。" +
          "@chara 人物 立ち絵セット 差分 at=立ち位置 を書く前に読む。who で一人に絞れる。",
        "Returns the characters (cast.json): per character the speaker name, name color, home side for automatic layout (side), appearances (and the default one), variants (and the default one), positions (names for at=, plus auto), layers of composited sprites with their options, and the list of speakers. " +
          "If liminalia.json has autoLayout (positions for each number of characters, where newcomers go, what happens on exit, and byCount, which remaps named positions by the number of characters), it's returned too. " +
          "Read it before writing @chara character appearance variant at=position. who narrows it to one character.",
      ),
      inputSchema: { type: "object", properties: { project, who: { type: "string", description: both("人物の ID（省くと全員）", "Character ID (all if omitted)") } }, required: ["project"] },
      run: async (args) => {
        const dir = host.project(args);
        const loaded = loadProject(dir);
        const castFile = readCast(loaded) as { speakers: string[]; cast: Cast };
        const who = str(args, "who");
        if (who && !castFile.cast[who]) throw new ToolError(`人物 ${who} はいません（${Object.keys(castFile.cast).join("、") || "まだ誰もいません"}）`);
        const cast = Object.fromEntries(
          Object.entries(castFile.cast)
            .filter(([id]) => !who || id === who)
            .map(([id, e]) => {
              const appearances = Object.fromEntries(
                Object.entries(e.appearances ?? {}).map(([key, a]) => {
                  const variants = Object.entries(a.variants ?? {});
                  const positions = [...new Set(variants.flatMap(([, v]) => positionNames(v))), AUTO_POSITION];
                  return [
                    key,
                    {
                      ...(a.label ? { label: a.label } : {}),
                      defaultVariant: baseVariant(a),
                      variants: variants.map(([name, v]) => (v.parts ? { name, parts: v.parts } : name)),
                      positions,
                      ...(a.layers?.length ? { layers: a.layers.map((l) => ({ name: l.name, options: Object.keys(l.options), ...(l.default ? { default: l.default } : {}) })) } : {}),
                    },
                  ];
                }),
              );
              return [id, { ...(e.speaker ? { speaker: e.speaker } : {}), ...(e.color ? { color: e.color } : {}), ...(e.side ? { side: e.side } : {}), defaultAppearance: Object.keys(appearances).length ? appearanceKey(e) : null, appearances }];
            }),
        );
        const autoLayout = loaded.config.autoLayout;
        return text(JSON.stringify({ speakers: castFile.speakers, cast, ...(autoLayout ? { autoLayout } : {}) }, null, 2));
      },
    },
    {
      name: "list_macros",
      description: both(
        "プロジェクトのマクロ（@define）の一覧を返す。名前、パラメータ（名前: 型 = 既定値）、要約（@define のすぐ上の // の行）、場所、@with で中身を渡せるか（@content があるか）、呼ばれている数。",
        "Lists the project's macros (@define): name, parameters (name: type = default), summary (the // lines just above @define), location, whether @with can pass content (it has @content) and how many times it's called.",
      ),
      inputSchema: { type: "object", properties: { project }, required: ["project"] },
      run: async (args) => {
        const ws = await host.workspace(host.project(args));
        const macros: { name: string; params: string[]; summary: string; file: string; line: number; content: boolean; calls: number }[] = [];
        const calls = new Map<string, number>();
        const count = (body: readonly Statement[]) => {
          for (const s of body) {
            if (s.kind === "command") calls.set(s.name, (calls.get(s.name) ?? 0) + 1);
            else if (s.kind === "if") {
              if (s.with) calls.set(s.with.name, (calls.get(s.with.name) ?? 0) + 1);
              for (const b of s.branches) count(b.body);
            } else if (s.kind === "define") count(s.body);
          }
        };
        for (const file of ws.files()) {
          const { script } = ws.script(file);
          count(script.body);
          for (const s of script.body) {
            if (s.kind !== "define" || s.name === "") continue;
            macros.push({ name: s.name, params: s.params.map((p) => `${p.name}: ${p.type}${p.defaultValue ? ` = ${printLiteral(p.defaultValue)}` : ""}`), summary: s.doc ?? "", file, line: s.line, content: hasContent(s.body), calls: 0 });
          }
        }
        for (const m of macros) m.calls = calls.get(m.name) ?? 0;
        return text(macros.length ? JSON.stringify(macros, null, 2) : "マクロ（@define）はまだありません");
      },
    },
    {
      name: "line_state",
      description: both(
        "シナリオの行の時点のプレビュー状態（背景、立ち絵、BGM、ループの効果音、ウィンドウなど）、変数、そこまでに選んだ選択肢を返す（Studio の現在地と同じ。はじめから本番どおりに実行して作る）。" +
          "本文と選択肢の行はその行を出す直前、コマンドの行は実行した直後。line か from〜to（50 行まで）で選ぶ。通らない行は無いと返す。",
        "Returns the stage at a script line (background, sprites, BGM, looping sound effects, window and so on), the variables and the choices made so far (same as the current position in Studio, made by running from the start as in the game). " +
          "For text and choice lines it's just before the line is shown; for command lines, just after it runs. Choose line, or from to to (up to 50 lines). Lines never reached are reported as such.",
      ),
      inputSchema: { type: "object", properties: { project, file: { type: "string" }, line: { type: "integer" }, from: { type: "integer" }, to: { type: "integer" } }, required: ["project", "file"] },
      run: async (args) => {
        const dir = host.project(args);
        const { name } = host.scenarioName(dir, need(args, "file"));
        const ws = await host.workspace(dir);
        if (!ws.files().includes(name)) throw new ToolError(`シナリオがありません: ${name}`);
        const from = typeof args.line === "number" ? args.line : typeof args.from === "number" ? args.from : 1;
        const to = typeof args.line === "number" ? args.line : typeof args.to === "number" ? args.to : from;
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to - from >= 50) throw new ToolError("line か、from〜to（1 から、50 行まで）を指定してください");
        const sweep: Sweep = (await ws.sweep(name)).sweep;
        const lines: Record<string, unknown>[] = [];
        for (let line = from; line <= to; line++) {
          const page = sweep.lines[line];
          const after = sweep.after[line];
          if (page) {
            const save = lineSave(sweep, page);
            lines.push({ line, at: "before-page", stage: stageSummary(save.stage), variables: clipVars(save.game), choices: lineChoices(sweep, page).map((c) => `${c.file}:${c.line} ${c.option} ${c.text}`) });
          } else if (after) {
            const stage = sweep.stages[after.stage];
            lines.push({ line, at: "after-command", ...(stage ? { stage: stageSummary(stage) } : {}), variables: clipVars(afterGame(sweep, after)), choices: lineChoices(sweep, after).map((c) => `${c.file}:${c.line} ${c.option} ${c.text}`) });
          } else if (typeof args.line === "number") lines.push({ line, reached: false });
        }
        return text(
          JSON.stringify(
            {
              file: name,
              how: sweep.how === "entry" ? "from-start" : "file-start",
              route: sweep.route.map((c) => `${c.file}:${c.line} ${c.option} ${c.text}`),
              lines,
              ...(lines.length === 0 ? { note: "この範囲には、通る本文や命令の行がありません（コメント、空行、通らない分かれ道の中など）" } : {}),
            },
            null,
            2,
          ),
        );
      },
    },
    {
      name: "fmt",
      description: both(
        "シナリオを整形する（lim fmt と同じ。コマンドの行の空白とパラメータの並び、不要な \"…\"。本文は変えない）。file を省くとすべてのシナリオ（パック（packs/<フォルダ>/scenario）のシナリオも。パックのシナリオは packs/<フォルダ>/scenario/<シナリオ> で指定できる）。構文エラーのあるシナリオは整形せずに理由を返す。前のバージョンは .liminalia/history/ に残る。",
        "Formats scripts (same as lim fmt: spacing and argument order of command lines and unneeded \"…\"; the text isn't changed). Without file, all scripts (including pack scripts in packs/<folder>/scenario, which can be named as packs/<folder>/scenario/<script>). Scripts with syntax errors aren't formatted and the reason is returned. The previous version is kept in .liminalia/history/.",
      ),
      inputSchema: { type: "object", properties: { project, file: { type: "string" } }, required: ["project"] },
      run: async (args) => {
        const dir = host.project(args);
        const ws = await host.workspace(dir);
        // lim fmt と同じ台本（本体、続けてパック）を同じ整え方で。パックの台本は位置（packs/<フォルダ>/scenario/<台本>）で指せる
        const all = fmtTargets(ws.project, ws.castFile.speakers);
        const wanted = str(args, "file");
        const packPlace = wanted ? all.find((t) => t.pack && t.place === wanted.replace(/\.lim$/, "")) : undefined;
        const only = wanted && !packPlace ? host.scenarioName(dir, wanted).name : null;
        if (only && !ws.files().includes(only)) throw new ToolError(`シナリオがありません: ${only}`);
        const targets = packPlace ? [packPlace] : only ? all.filter((t) => !t.pack && t.name === only) : all;
        const fmt = ws.readConfig().fmt;
        const changed: string[] = [];
        const skipped: string[] = [];
        for (const t of targets) {
          const file = t.place;
          if (t.pack) {
            // パックの台本は制作画面の書き込みの口を通らないので、前の版を変更履歴に残してから書く
            const { text: now, encoding } = readScenarioFile(t.path);
            if (encoding) {
              skipped.push(`${file}: UTF-8 で読めません（${encoding}）`);
              continue;
            }
            const r = formatTarget(now, t, { registry: ws.commands, fmt });
            if (!r.ok) skipped.push(`${file}: ${r.reason}`);
            else if (r.changed) {
              keepVersion(join(ws.project.root, HISTORY_DIR, ...file.split("/")), ".lim", now);
              writeAtomic(t.path, r.text);
              changed.push(file);
            }
            continue;
          }
          const { text: now, hash } = ws.script(t.name);
          const r = formatTarget(now, t, { registry: ws.commands, fmt });
          if (!r.ok) skipped.push(`${file}: ${r.reason}`);
          else if (r.changed) {
            const w = ws.write(t.name, r.text, hash, false);
            if (w.ok) changed.push(file);
            else skipped.push(`${file}: 整えている間にほかで直されました`);
          }
        }
        return text([changed.length ? `整えた台本: ${changed.join("、")}` : "整える所はありませんでした", ...(skipped.length ? ["整えなかった台本:", ...skipped.map((s) => `  ${s}`)] : [])].join("\n"), skipped.length > 0);
      },
    },
    {
      name: "apply_fixes",
      description: both(
        "シナリオの診断に付いた直し方（綴りの近い名前への置き換え、不要な行の削除など。Studio の「修正」と同じ）を適用して書く。codes で診断の code、lines で行に絞れる。" +
          "適用する前にその行がまだ同じかを確認する。行の外を書き換える直し方（話者の追加など）は適用せずに返す。書くとエラーが増えるなら書かない（allowErrors で書く）。",
        "Applies the fixes attached to a script's diagnostics (replacing with a similarly spelled name, deleting an unneeded line and so on; same as Fix in Studio) and writes the script. Narrow them by diagnostic code with codes or by line with lines. " +
          "Each line is checked to be unchanged before applying. Fixes that change things outside the line (adding a speaker and so on) aren't applied and are returned. If writing adds errors, nothing is written (allowErrors writes anyway).",
      ),
      inputSchema: {
        type: "object",
        properties: { project, file: { type: "string" }, codes: { type: "array", items: { type: "string" } }, lines: { type: "array", items: { type: "integer" } }, allowErrors: ALLOW_ERRORS },
        required: ["project", "file"],
      },
      run: async (args) => {
        const dir = host.project(args);
        const { name, path } = host.scenarioName(dir, need(args, "file"));
        const ws = await host.workspace(dir);
        if (!ws.files().includes(name)) throw new ToolError(`シナリオがありません: ${name}`);
        const { text: now, hash } = ws.script(name);
        const codes = Array.isArray(args.codes) ? new Set(args.codes.filter((c): c is string => typeof c === "string")) : null;
        const only = Array.isArray(args.lines) ? new Set(args.lines.filter((l): l is number => typeof l === "number")) : null;
        const wanted = (d: Diagnostic) => d.file === name && (!codes || codes.has(d.code)) && (!only || only.has(d.line));
        const diagnostics = ws.checkText(name, now).filter(wanted);
        // 下の行から当てる（何行かを一行にする直し方も。apply-fixes.ts）
        const fixedText = applyFixesToText(now, diagnostics);
        const rows = fixedText.text.split("\n");
        const applied = fixedText.applied.map((d) => `${d.line} 行（${d.code}）: ${d.result === null ? "行を消しました" : d.result}`);
        const outside = diagnostics.filter((d) => d.fixes?.some((f) => f.kind === "add-speaker" || f.kind === "add-label")).map((d) => `${d.line} 行（${d.code}）: ${d.fixes!.map((f) => (f.kind === "add-speaker" ? `話者 ${f.name} を cast.json に足す` : f.kind === "add-label" ? `${f.file}.lim に # ${f.label} を足す` : "")).filter(Boolean).join("、")}`);
        if (applied.length === 0) return text(["当てられる直し方はありませんでした。", ...(outside.length ? ["行の外を書き換える直し方（当てていません）:", ...outside] : [])].join("\n"), true);
        const result = await host.guardedWrite(dir, name, path, rows.join("\n"), hash, args.allowErrors === true);
        // 同じ所に重なる直し方は一度に一つだけ当てる（lim check --fix と同じ。書いたあとにもう一度呼ぶと当たる）
        const left = fixedText.left > 0 ? [`同じ所に重なる直し方が ${fixedText.left} 件あり、当てませんでした。書いたあとにもう一度 apply_fixes を呼ぶと当てます。`] : [];
        result.content.unshift({ type: "text", text: [`当てた直し方:`, ...applied.reverse(), ...left, ...(outside.length ? ["行の外を書き換える直し方（当てていません）:", ...outside] : [])].join("\n") });
        return result;
      },
    },
    {
      name: "restore_scenario",
      description: both(
        "シナリオを .liminalia/history/ に残った前のバージョンに戻す（Studio の変更履歴と同じ）。id を省くと一つ前のバージョン（最後に書く前の中身）。list ならバージョンの一覧を返す。" +
          "戻す前の中身も履歴に残る。戻すとエラーが増えるなら戻さない（allowErrors で戻す）。",
        "Restores a script to a previous version kept in .liminalia/history/ (same as the change history in Studio). Without id, the version just before the last write. With list, returns the versions. " +
          "The content before restoring is kept in the history too. If restoring adds errors, nothing is written (allowErrors restores anyway).",
      ),
      inputSchema: { type: "object", properties: { project, file: { type: "string" }, id: { type: "string" }, list: { type: "boolean" }, allowErrors: ALLOW_ERRORS }, required: ["project", "file"] },
      run: async (args) => {
        const dir = host.project(args);
        const { name, path } = host.scenarioName(dir, need(args, "file"));
        const ws = await host.workspace(dir);
        const versions = await studioError(() => ws.history(name));
        if (args.list === true || versions.length === 0) return text(versions.length ? versions.map((v) => `${v.id}（${v.time}、${v.bytes} バイト）`).join("\n") : `${name} の前のバージョンはありません`, versions.length === 0);
        const id = str(args, "id") ?? versions[0]!.id;
        const item = await studioError(() => ws.historyItem(name, id));
        if (!ws.files().includes(name)) return host.guardedWrite(dir, name, path, item.text, null, args.allowErrors === true);
        const { hash } = ws.script(name);
        const result = await host.guardedWrite(dir, name, path, item.text, hash, args.allowErrors === true);
        result.content.unshift({ type: "text", text: `${name} を ${id} のバージョンに戻します。` });
        return result;
      },
    },
    {
      name: "i18n_sync",
      description: both(
        "その言語の翻訳ファイル（lang/<言語>.json）を今のシナリオに合わせる（lim i18n と同じ。新しい行は訳を空で足し、使われなくなった訳は引き継ぐか取っておく。日本語と英語以外の言語にはシステム画面の文言も英語の原文を添えて並べる）。" +
          "stampIds なら、先に台詞、地の文、選択肢の行に固定の行 ID（#line:）を振る（原文を直しても訳が外れなくなる）。",
        "Updates the translation file of a language (lang/<language>.json) to the current scripts (same as lim i18n: new lines are added with an empty translation, and translations no longer used are carried over or kept; for languages other than Japanese and English, the system screen text is listed too with the English source). " +
          "With stampIds, fixed line IDs (#line:) are stamped first on dialogue, narration and choice lines (translations then stay attached when the source is edited).",
      ),
      inputSchema: { type: "object", properties: { project, language: { type: "string" }, stampIds: { type: "boolean" } }, required: ["project"] },
      run: async (args) => {
        const dir = host.project(args);
        const language = str(args, "language");
        if (!language && args.stampIds !== true) throw new ToolError("language を指定してください（\"en\" など）");
        const r = await host.lim(["i18n", dir, ...(language ? [language] : []), ...(args.stampIds === true ? ["--stamp-ids"] : [])]);
        return text(r.out || "終わりました", r.code !== 0);
      },
    },
    {
      name: "read_translation",
      description: both(
        "翻訳ファイルを今のシナリオに合わせたものを、ページに分けて返す（既定は訳の無い項目だけ。only を changed にすると訳のあとで原文が変わった項目、all ですべて）。" +
          "項目は key、kind、話者、原文、訳、前の原文と訳（previous）、訳したときの原文（translatedFrom）、場所（ファイル、行、場面、前後の行）。hash は write_translation の baseHash に渡す。",
        "Returns the translation file updated to the current scripts, in pages (by default only items without a translation; with only changed, items whose source changed after translation; with all, everything). " +
          "Each item has key, kind, speaker, source, text, the previous source and translation (previous), the source when translated (translatedFrom) and the place (file, line, scene, previous and next lines). Pass hash as baseHash to write_translation.",
      ),
      inputSchema: {
        type: "object",
        properties: { project, language: { type: "string" }, only: { type: "string", enum: ["untranslated", "changed", "all"] }, file: { type: "string", description: both("この台本の項目だけ", "Only items of this script") }, offset: { type: "integer" }, limit: { type: "integer" } },
        required: ["project", "language"],
      },
      run: async (args) => {
        const dir = host.project(args);
        const ws = await host.workspace(dir);
        const s = await host.studio();
        const language = need(args, "language");
        const view = await studioError(() => s.readTranslation(ws, language));
        const places = s.translationContext(ws);
        const only = str(args, "only") ?? "untranslated";
        const scenario = str(args, "file") ? host.scenarioName(dir, need(args, "file")).name : null;
        const items: TranslationItem[] = [];
        const f: TranslationFile = view.file;
        if (!scenario) for (const [name, t] of Object.entries(f.speakers ?? {})) items.push({ key: `speaker:${name}`, kind: "speaker", source: name, text: t });
        for (const [key, e] of Object.entries(f.lines ?? {})) {
          const place = places.get(key);
          if (scenario && place?.file !== scenario) continue;
          items.push({
            key,
            kind: ({ line: "line", option: "choice", arg: "command", text: "setting" } as const)[translationKeyKind(key) ?? "line"],
            source: e.source,
            text: e.text,
            ...(e.speaker && e.speaker !== "choice" ? { speaker: e.speaker } : {}),
            ...(e.note ? { note: e.note } : {}),
            ...(e.previous ? { previous: e.previous } : {}),
            ...(e.translatedFrom ? { translatedFrom: e.translatedFrom } : {}),
            ...(e.contexts ? { contexts: e.contexts } : {}),
            ...(place ? { place } : {}),
          });
        }
        if (!scenario)
          for (const [key, v] of Object.entries(f.ui ?? {}))
            if (v && typeof v === "object") items.push({ key: `ui:${key}`, kind: "ui", source: v.source, text: v.text, ...(v.translatedFrom ? { translatedFrom: v.translatedFrom } : {}) });
        const picked = items.filter((i) => only === "all" || (only === "changed" ? i.previous !== undefined || i.translatedFrom !== undefined : i.text === ""));
        const { offset, limit } = pageOf(args);
        const page = picked.slice(offset, offset + limit);
        return text(
          JSON.stringify({ language, hash: view.hash, total: picked.length, offset, ...(offset + limit < picked.length ? { next: offset + limit } : {}), items: page }, null, 2),
        );
      },
    },
    {
      name: "write_translation",
      description: both(
        "訳をキーごとに書く（read_translation の key。場面ごとの訳は キー#場面、話者名は speaker:名前、システム画面の文言は ui:キー）。baseHash は read_translation の hash（ファイルが無ければ null）。" +
          "読んだあとでほかで変わっていれば書かない。本文の行と選択肢の訳は .lim の本文の書き方（ルビ、{br}、本文中のコマンド）を確かめ、読めない訳は書かずに理由と位置を返す。source を添えると、原文が変わった項目は書かない。以前のバージョンは .liminalia/history/@lang/ に残る。",
        "Writes translations per key (the key from read_translation; a per-scene translation is key#scene, a speaker name speaker:name and system screen text ui:key). baseHash is the hash from read_translation (null if there was no file). " +
          "If the file changed after you read it, nothing is written. Translations of text lines and choices are checked as .lim text (ruby, {br}, inline commands), and unreadable ones aren't written; the reason and position are returned. With source, items whose source changed aren't written. The previous version is kept in .liminalia/history/@lang/.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          project,
          language: { type: "string" },
          baseHash: { type: ["string", "null"] },
          entries: { type: "array", items: { type: "object", properties: { key: { type: "string" }, text: { type: "string" }, source: { type: "string" } }, required: ["key", "text"] } },
        },
        required: ["project", "language", "baseHash", "entries"],
      },
      run: async (args) => {
        const dir = host.project(args);
        const ws = await host.workspace(dir);
        const s = await host.studio();
        const language = need(args, "language");
        const entries = Array.isArray(args.entries) ? (args.entries as { key?: unknown; text?: unknown; source?: unknown }[]) : [];
        if (entries.length === 0 || entries.some((e) => !e || typeof e.key !== "string" || typeof e.text !== "string" || (e.source !== undefined && typeof e.source !== "string"))) {
          throw new ToolError("entries は { key, text, source? } の並びで送ってください");
        }
        if (!(typeof args.baseHash === "string" || args.baseHash === null)) throw new ToolError("baseHash に read_translation の hash（ファイルが無ければ null）を渡してください");
        const view = await studioError(() => s.readTranslation(ws, language));
        if (view.hash !== args.baseHash) return text(`翻訳ファイルは読んだあとでほかで変わっています。書いていません。read_translation で読み直してください（今の hash: ${view.hash}）。`, true);
        const r = applyTranslationEntries(view.file, entries as { key: string; text: string; source?: string }[]);
        const at = (x: { at: { index: number } | object }) => ("index" in x.at ? x.at.index + 1 : 0);
        const report = {
          applied: r.applied,
          ...(r.rejected.length ? { rejected: r.rejected.map((x) => ({ key: x.key, entry: at(x), ...(x.column !== undefined ? { column: x.column } : {}), message: x.message })) } : {}),
          ...(r.warnings.length ? { warnings: r.warnings.map((x) => ({ key: x.key, entry: at(x), message: x.message })) } : {}),
          ...(r.changedKeys.length ? { changedSource: r.changedKeys } : {}),
          ...(r.unknown ? { unknownKeys: r.unknown } : {}),
        };
        if (r.applied === 0) return text(`書いていません。\n${JSON.stringify(report, null, 2)}`, true);
        const w = await studioError(() => s.writeTranslation(ws, language, r.file, view.hash));
        if (!w.ok) return text(`翻訳ファイルは書いている間にほかで変わりました。書いていません。read_translation で読み直してください（今の hash: ${w.current.hash}）。`, true);
        return text(`lang/${language}.json に書きました（hash: ${w.hash}）。\n${JSON.stringify(report, null, 2)}`, r.rejected.length > 0 || r.changedKeys.length > 0 || r.unknown > 0);
      },
    },
    {
      name: "voice_script",
      description: both(
        "収録用の台本（台詞ごとのボイスのファイル、話者、本文、演技のメモ、前の台詞、場面、場所、鳴らない理由、要再収録）を返す（lim voice-script と同じ行）。speaker で話者に絞り、offset と limit でページに分ける。" +
          "write なら lim voice-script と同じ CSV を exports/voice-script/ に書く。",
        "Returns the recording script (per line the voice file, speaker, text, acting notes, previous line, scene, place, why it won't play and whether it needs re-recording; the same rows as lim voice-script). Narrow it to a speaker with speaker, and page with offset and limit. " +
          "With write, the same CSV files as lim voice-script are written to exports/voice-script/.",
      ),
      inputSchema: { type: "object", properties: { project, speaker: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" }, write: { type: "boolean" } }, required: ["project"] },
      run: async (args) => {
        const dir = host.project(args);
        const loaded = loadProject(dir);
        if (args.write === true) {
          const r = exportVoiceScript(loaded);
          return text(`${r.folder} に台詞 ${r.lines} 件（話者 ${r.speakers} 人）を書きました。${r.missing ? `ボイスのファイルが決まっていない台詞が ${r.missing} 件あります。` : ""}`);
        }
        let lock = null;
        try {
          lock = readVoiceLock(loaded);
        } catch {
          // 番号の固定が読めなければ、固定していない台本として出す（読めないことは lim check が知らせる）
          lock = null;
        }
        // パックの台詞も並べる（lim voice-script と同じ。パックの行は pack にパックのフォルダ）
        const rows = voiceScriptRows(projectScripts(loaded), lock, { notes: loaded.config.voiceScript?.notes, entry: loaded.config.entry, packs: projectPackScripts(loaded) }).filter((r) => !str(args, "speaker") || r.speaker === str(args, "speaker"));
        const { offset, limit } = pageOf(args);
        return text(JSON.stringify({ total: rows.length, offset, ...(offset + limit < rows.length ? { next: offset + limit } : {}), rows: rows.slice(offset, offset + limit) }, null, 2));
      },
    },
  ];
}
