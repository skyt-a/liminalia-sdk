import { existsSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { copyScreen, diffScreen, resetScreen, SCREEN_ORIGINALS_DIR, screenRegistered, screenScriptPath, screenTemplatePath, splitTemplateParts, writeScreenScript } from "@liminalia/project/screen-copy";
import { pluginScreens } from "@liminalia/project/screen-templates";
import type { ScreenCopyResult, ScreenDiffInfo, ScreenFiles, ScreenOverride, ScreenResetResult } from "../protocol.ts";
import { moveStep, type Step } from "./file-undo.ts";
import { configStep } from "./manage.ts";
import { screenTemplateRules } from "./screens.ts";
import { keepVersion, writeAtomic } from "./versions.ts";
import { ENGINE_VERSION, HISTORY_DIR, StudioError, type StudioWorkspace } from "./workspace.ts";

/**
 * ゲームの画面のタブのテンプレートの欄が使う、作品の画面のテンプレートと画面の JS の読み書き（docs/design/screen-templates.md の「写し出し」）。
 * 中身は lim screens と同じ @liminalia/project/screen-copy。書いたものは、ゲームの画面のタブの ⌘Z で戻せる控え（undo）にする
 * （写したファイル、元の文字、liminalia.json。標準に戻すときに名前を変えて残したファイルも、前の名前に戻る）。
 */

type Rules = NonNullable<ReturnType<typeof screenTemplateRules>>;

function rules(): Rules {
  const r = screenTemplateRules();
  if (!r) throw new StudioError(400, "テンプレートで作れる画面の定義がありません");
  return r;
}

/** テンプレートで作れる画面か（違えば断る）。 */
function standard(screen: unknown): string {
  const screens = rules().screens;
  if (typeof screen !== "string" || !screens[screen]) throw new StudioError(400, `${String(screen)} はテンプレートで作れる画面ではありません（テンプレートで作れる画面: ${Object.keys(screens).join("、")}）`);
  return screen;
}

const configPath = (ws: StudioWorkspace) => join(ws.project.root, "liminalia.json");
const readRaw = (ws: StudioWorkspace) => JSON.parse(readFileSync(configPath(ws), "utf8")) as Record<string, unknown>;
const abs = (ws: StudioWorkspace, file: string) => join(ws.project.root, ...file.split("/"));
const readText = (path: string): string | null => (existsSync(path) && statSync(path).isFile() ? readFileSync(path, "utf8") : null);

/**
 * screen-copy の断りの文は lim screens の旗（--force、--part）とコマンドを案内するので、制作画面でできることに読み替える
 * （部品だけなら、ゲームの画面のタブの「写す範囲」で選んで今のファイルに足せる）。
 */
export function studioScreenMessage(message: string): string {
  return message
    .replace("（書き直すなら --force を付けます。部品だけを足すなら --part で選びます）", "（今のファイルに部品を足すなら、コピーする範囲で部品を選びます）")
    .replace("（書き直すなら --force を付けます）", "")
    .replace(/。コピーするなら lim screens copy \S+）/, "）");
}

/** screen-copy の断り（あるファイル、無い部品など）を、開発サーバーの断りにする。 */
function guard<T>(run: () => T): T {
  try {
    return run();
  } catch (e) {
    if (e instanceof StudioError || !(e instanceof Error)) throw e;
    throw new StudioError(/もうあります/.test(e.message) ? 409 : 400, studioScreenMessage(e.message));
  }
}

/** その画面を先に差し替えるプラグイン（lim screens copy の知らせと lim check の template-overridden と同じ見方。後のプラグインが勝つ）。 */
export function screenOverride(ws: StudioWorkspace, screen: string): ScreenOverride | null {
  const std = rules().screens[screen];
  if (!std) return null;
  const raw = readRaw(ws) as { plugins?: unknown; ui?: { system?: { preset?: unknown } } };
  const preset = typeof raw.ui?.system?.preset === "string" ? raw.ui.system.preset : undefined;
  let by: ScreenOverride | null = null;
  for (const p of pluginScreens(ws.project.root, Array.isArray(raw.plugins) ? raw.plugins : [])) {
    const themed = preset !== undefined ? std.replacedBy.find((k) => p.themes?.[preset]?.includes(k)) : undefined;
    const hit = std.replacedBy.find((k) => p.replaces.includes(k));
    if (themed) by = { plugin: p.plugin, hook: themed, theme: preset! };
    else if (hit) by = { plugin: p.plugin, hook: hit };
  }
  return by;
}

/** 画面のテンプレートと画面の JS（GET /screens/files）。 */
export function readScreenFiles(ws: StudioWorkspace, screenName: unknown): ScreenFiles {
  const screen = standard(screenName);
  const ui = readRaw(ws).ui;
  const template = screenTemplatePath(ui, screen);
  const script = screenScriptPath(ui, screen);
  // ui.templates の値が .html でないか作品の外を指すと、遊ぶ側も検査も決まりの場所を使う（lim check は bad-ui）。その値は登録として扱わない
  const value = (ui as { templates?: Record<string, unknown> } | undefined)?.templates?.[screen];
  const registered = screenRegistered(ui, screen) && typeof value === "string" && value.replace(/\\/g, "/") === template;
  return {
    screen,
    registered,
    misregistered: typeof value === "string" && !registered ? value : null,
    template: { file: template, text: readText(abs(ws, template)) },
    script: { file: script, text: readText(abs(ws, script)) },
    path: resolve(abs(ws, template)),
    overriddenBy: screenOverride(ws, screen),
  };
}

/**
 * files（作品のフォルダからのパス）と liminalia.json の前後を取って run を動かし、変わったものを ⌘Z で戻す手順にする。
 * 新しく作ったファイルは、戻すと消し、そのとき作ったフォルダも空なら消す。liminalia.json の前の中身は変更履歴に残す。
 */
function recorded<T>(ws: StudioWorkspace, files: readonly string[], run: () => T): { result: T; steps: Step[] } {
  const root = resolve(ws.project.root);
  const before = new Map(files.map((f) => [abs(ws, f), readText(abs(ws, f))]));
  /** 作る前に無かったいちばん上のフォルダ（戻したあと、空なら消す上限）。 */
  const made = new Map<string, string | null>();
  for (const [path, text] of before) {
    if (text !== null) continue;
    let top: string | null = null;
    for (let d = dirname(path); d.startsWith(root + sep) && !existsSync(d); d = dirname(d)) top = d;
    made.set(path, top);
  }
  const configBefore = readFileSync(configPath(ws), "utf8");
  const result = guard(run);
  const steps: Step[] = [];
  for (const [path, was] of before) {
    const now = readText(path);
    if (now === was) continue;
    const name = relative(root, path).split(sep).join("/");
    const write = (text: string | null) => {
      if (text !== null) return writeAtomic(path, text);
      rmSync(path, { force: true });
      const top = made.get(path);
      if (!top) return;
      for (let d = dirname(path); d.length >= top.length; d = dirname(d)) {
        if (!existsSync(d) || readdirSync(d).length > 0) break;
        rmdirSync(d);
      }
    };
    steps.push({ name, key: path, undo: () => write(was), redo: () => write(now), isAfter: () => readText(path) === now, isBefore: () => readText(path) === was });
  }
  if (readFileSync(configPath(ws), "utf8") !== configBefore) {
    keepVersion(join(ws.project.root, HISTORY_DIR, "@config"), ".json", configBefore);
    steps.push(configStep(ws, configBefore));
  }
  return { result, steps };
}

/** 写すときに書くかもしれないファイル（テンプレート、画面の JS、元の文字）。 */
function copyTargets(ws: StudioWorkspace, screen: string): string[] {
  const ui = readRaw(ws).ui;
  const originals = splitTemplateParts(rules().screens[screen]!.template).flatMap((p) => (p.name ? [`${SCREEN_ORIGINALS_DIR}/${screen}/${p.name}.${p.version ?? 0}.html`] : []));
  return [screenTemplatePath(ui, screen), screenScriptPath(ui, screen), ...originals];
}

/** 標準の画面のテンプレート（parts を渡せばその部品だけ）を作品に写して登録する（lim screens copy と同じ）。 */
export function copyScreenUndoable(ws: StudioWorkspace, screenName: unknown, parts: unknown): ScreenCopyResult {
  const screen = standard(screenName);
  const picked = Array.isArray(parts) ? parts.filter((p): p is string => typeof p === "string" && p !== "") : [];
  const { result, steps } = recorded(ws, copyTargets(ws, screen), () => copyScreen(ws.project.root, rules().screens, screen, { ...(picked.length > 0 ? { parts: picked } : {}), engine: ENGINE_VERSION }));
  const undo = ws.journals.add(steps);
  return { file: result.file, parts: result.parts, registered: result.registered, ...(undo ? { undo } : {}) };
}

/** 画面の JS の雛形を置く（lim screens js と同じ。あれば断る）。 */
export function addScreenScript(ws: StudioWorkspace, screenName: unknown): { file: string; text: string; undo?: string } {
  const screen = standard(screenName);
  const file = screenScriptPath(readRaw(ws).ui, screen);
  const { result, steps } = recorded(ws, [file], () => writeScreenScript(ws.project.root, rules().screens, screen));
  const undo = ws.journals.add(steps);
  return { file: result, text: readFileSync(abs(ws, result), "utf8"), ...(undo ? { undo } : {}) };
}

/**
 * テンプレートの欄から、テンプレート（kind "template"）か画面の JS（"script"）を丸ごと書く。before は読んだときの中身（無ければ ""）で、
 * ほかで変わっていれば書かずに今の中身を返す（ok: false）。登録の無いテンプレートを書くときは ui.templates に登録する。
 */
export function writeScreenFile(ws: StudioWorkspace, screenName: unknown, kind: unknown, text: unknown, before: unknown): { ok: true; file: string; text: string; undo?: string } | { ok: false; file: string; text: string } {
  const screen = standard(screenName);
  if ((kind !== "template" && kind !== "script") || typeof text !== "string" || typeof before !== "string") throw new StudioError(400, "kind（template か script）、text、before（読んだときの中身）を送ってください");
  const raw = readRaw(ws);
  const file = kind === "template" ? screenTemplatePath(raw.ui, screen) : screenScriptPath(raw.ui, screen);
  const current = readText(abs(ws, file)) ?? "";
  if (current !== before) return { ok: false, file, text: current };
  const { steps } = recorded(ws, [file], () => {
    writeAtomic(abs(ws, file), text);
    if (kind !== "template" || screenRegistered(raw.ui, screen)) return;
    const ui = (raw.ui && typeof raw.ui === "object" && !Array.isArray(raw.ui) ? raw.ui : {}) as Record<string, unknown>;
    const templates = ui.templates && typeof ui.templates === "object" && !Array.isArray(ui.templates) ? (ui.templates as Record<string, unknown>) : {};
    raw.ui = { ...ui, templates: { ...templates, [screen]: file } };
    writeAtomic(configPath(ws), `${JSON.stringify(raw, null, 2)}\n`);
  });
  const undo = ws.journals.add(steps);
  return { ok: true, file, text, ...(undo ? { undo } : {}) };
}

/** 標準との違い（lim screens diff と同じ）。 */
export function screenDiff(ws: StudioWorkspace, screenName: unknown): ScreenDiffInfo {
  const screen = standard(screenName);
  return guard(() => diffScreen(ws.project.root, rules().screens, screen));
}

/** ui.templates から外して標準に戻す（lim screens reset と同じ。テンプレートと画面の JS は名前を変えて残す）。 */
export function resetScreenUndoable(ws: StudioWorkspace, screenName: unknown): ScreenResetResult {
  const screen = standard(screenName);
  const { result, steps } = recorded(ws, [], () => resetScreen(ws.project.root, screen));
  const moves = result.moved.map((m) => moveStep(m.from, abs(ws, m.from), abs(ws, m.to), null));
  const undo = ws.journals.add([...moves, ...steps]);
  return { ...result, ...(undo ? { undo } : {}) };
}
