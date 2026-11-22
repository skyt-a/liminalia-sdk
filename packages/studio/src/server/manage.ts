import { managedPath } from "./managed-path.ts";
import { renameInDeclaredData } from "./data-rename.ts";
import { assetRenameLeft, isRenamedCss, renameCssAssets } from "./asset-rename.ts";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import {
  normalizeBooleanArgs,
  appearanceKey,
  applyUiTheme,
  UI_THEMES,
  type UiConfig,
  castProblems,
  projectMacros,
  checkUi,
  FORBIDDEN_PROPERTIES,
  isVariablePath,
  renameVariableInLine,
  variableUses,
  collectTranslatable,
  exchangeContext,
  updateTranslation,
  type ExchangeContext,
  type TranslationSources,
  type Cast,
  type Script,
  type Statement,
  type TranslationFile,
  type UiSourceText,
  type VoiceLock,
  themeFitsScreen,
  type UiThemePreset,
  checkSeverityConfig,
  setCssRules,
  uiCssFiles,
  UI_CSS_DEFAULT,
  type CssRuleEdit,
} from "@liminalia/lang";
import { assetTextFiles, fileNameProblems, readAssetTextFiles, listPackSources, listUiThemes, PROJECT_ID_MAX, PROJECT_ID_PATTERN, unsafeProjectId } from "@liminalia/project";
import { plainName } from "@liminalia/project/contained-path";
import { packTranslationScope, parsePacks } from "@liminalia/plugin-host";
import type { Value } from "@liminalia/runtime";
import type {
  AssetRenameResult,
  AssetTrashResult,
  CastRenameRequest,
  CastRenameResult,
  CastUsage,
  FileText,
  HistoryEntry,
  PartFileName,
  PartFileWrite,
  MacroRenameResult,
  ProjectSettings,
  PartRead,
  PartWrite,
  ScenarioRenameResult,
  SettingsResult,
  StudioState,
  TestRenameResult,
  TrashEntry,
  TrashItem,
  TranslationStatus,
  TranslationView,
  VariableInfo,
} from "../protocol.ts";
import { SETTINGS_KEYS } from "../protocol.ts";
import { HISTORY_DIR, hashText, StudioError, writeAtomic, type StudioWorkspace } from "./workspace.ts";
import { BACKUP_DIR, keepVersion, listVersions, versionStamp, versionTime } from "./versions.ts";
import { moveVoiceLockKeys, renameBaselines, specLookup } from "./labels.ts";
import { renameReviewFile } from "./reviews.ts";
import { readStudioState, STUDIO_SHARED_FILE, STUDIO_STATE_FILE, writeStudioState } from "./studio-state.ts";
import { withRollback, type Remember } from "./undo.ts";
import { moveStep, putFile, removeEmptyDir, textStep, writeOrRemove, type Step } from "./file-undo.ts";
import { targetVariables } from "@liminalia/editor/label-rename";
import { translationMoves } from "@liminalia/editor/label-follow";
import {
  castNameProblem,
  configFileLeft,
  macroNameProblem,
  moveCastImages,
  moveTranslationEntries,
  renameInCast,
  renameStateAssets,
  renameStateCast,
  renameStateFile,
  renameStateVariable,
  renameTranslationFileKeys,
  renameTranslationSpeaker as renameTranslationSpeakerIn,
  renameVoiceLockFileKeys,
  renameVoiceLockSpeaker,
  rewriteAssetInScript,
  rewriteInlineAssets,
  rewriteCastInScript,
  rewriteConfigAssets,
  rewriteConfigCast,
  rewriteConfigFile,
  rewriteConfigMacro,
  rewriteConfigVariable,
  rewriteFileInScript,
  rewriteMacroInScript,
  rewriteSpeakerInScript,
  rewriteVariableInScript,
} from "@liminalia/editor/name-rename";
import { assetUsage } from "./assets.ts";
import { configPartHash, configStep, refuseNotUtf8, updateConfig, updateConfigPart, writeConfigText } from "./manage-shared.ts";
export { assetKinds, assetUsage, listAssets } from "./assets.ts";
import { renameInTests } from "./test-rename.ts";

/**
 * 制作画面の素材とキャラクターの管理（Node 側）。素材の一覧・使っている場所・名前の変更・ごみ箱・フォルダ作り、
 * キャスト名・話者名の変更。名前を変えるときは、参照している台本の行（書き込み口を通すので履歴に残る）とキャストも書き換える。
 *
 * - ごみ箱は .liminalia/trash/<id>/<種類>/<パス>。restore で元の場所へ戻す（同じ名前があれば戻さない）。TRASH_KEEP 件まで。
 *   何を入れたかは <id>/.items.json に書いておき、ごみ箱の一覧（listTrash）に出す
 * - cast.json を書くときは、前の版を .liminalia/backups/cast-<日時>.json に残す（立ち絵の位置調整画面と同じ置き場・名前）
 * - liminalia.json と訳（lang/<言語>.json）を書くときは、前の内容を変更履歴（.liminalia/history/@config/・@lang/<言語>/）に残す。
 *   画面が読んだ写しで一部を置き換える口（ui・extra・基本と書き出しの項目・訳）は、読んだあとにその部分がほかで変わっていれば書かない
 */

const TRASH_DIR = join(".liminalia", "trash");
const TRASH_KEEP = 100;
/** ごみ箱の中の、シナリオのファイルを入れるところ（素材の種類の名前と重ならないよう @ で始める）。 */
export const SCENARIO_TRASH = "@scenario";
/** ごみ箱の一つの id の中の、入れたものの一覧（. で始めるので、戻すときの種類には数えない）。 */
const TRASH_ITEMS = ".items.json";
/** ごみ箱の一覧に、一つの id から出すものの数。 */
const TRASH_LIST_ITEMS = 20;
/** ごみ箱の中のテーマ（作品の themes/<id> ごと）。 */
export const THEME_TRASH = "@themes";
const BACKUP_KEEP = 20;

export { configPartHash, configStep, refuseNotUtf8, updateConfig, updateConfigPart, writeConfigText } from "./manage-shared.ts";
export { catalogPlugins, createPlugin, installPlugin, listPlugins, localPluginDir, setPlugins, updatePlugin } from "./manage-plugins.ts";

// ---- 素材 ----

/**
 * 素材の名前を変える（フォルダごとでもよい）。参照している台本の行と、キャストの立ち絵（fgimage のとき）、
 * liminalia.json の ui・extra・items の素材の参照、頭の印（.liminalia/studio.json の heads。fgimage のとき）も書き換える。
 * 途中で書けなくなったら、書き終えたものを元に戻す（素材も元の名前に戻す）。
 */
export function renameAsset(ws: StudioWorkspace, kind: string, from: string, to: string): AssetRenameResult {
  const root = kindRoot(ws, kind);
  const src = managedPath(root, from, "素材");
  const dest = managedPath(root, to, "素材");
  if (!existsSync(src)) throw new StudioError(404, `${kind}/${from} がありません`);
  if (existsSync(dest)) throw new StudioError(409, `${kind}/${to} はすでにあります`);
  if ((dest + sep).startsWith(src + sep)) throw new StudioError(400, "フォルダをそのフォルダの中へは移動できません");
  refuseNotUtf8(ws);
  const isDir = statSync(src).isDirectory();
  /** 古いパス → 新しいパス。 */
  const moves = new Map<string, string>();
  if (isDir) for (const f of filesUnder(src)) moves.set(`${from}/${f}`, `${to}/${f}`);
  else moves.set(from, to);

  let undo: string | null = null;
  const out = withRollback(RENAME_FAILED, (remember) => {
    const made = mkdirSync(dirname(dest), { recursive: true });
    renameSync(src, dest);
    ws.forgetAssets();
    const moved = moveStep(`${kind}/${from}`, src, dest, made ?? null);
    remember(
      `${kind}/${from}`,
      () => {
        moved.undo();
        ws.forgetAssets();
      },
      moved,
    );

    const scriptLeft: { file: string; line: number }[] = [];
    const files: string[] = [];
    const before = scriptMap(ws);
    // マクロ（@define）の素材の型の引数も書き換える
    const macros = projectMacros(ws.files().map((file) => [file, ws.script(file).script] as const));
    for (const file of ws.files()) {
      const { text, hash, script } = ws.script(file);
      const r = rewriteAssetInScript(text, script, ws.commands, kind, moves, macros);
      for (const line of r.left) scriptLeft.push({ file, line });
      if (r.changed.length === 0) continue;
      writeScriptUndoable(ws, file, r.text, hash, text, remember);
      files.push(file);
    }
    // 本文の中の {img …} と {@…} を書き換えた行は、原文から作る訳の鍵が変わる（訳文の中の {img …} と {@…} も替える）
    followLineKeys(ws, before, (t) => rewriteInlineAssets(t, ws.commands, kind, moves, macros) ?? t, remember);

    let cast = false;
    if (kind === "fgimage") {
      cast = updateCastUndoable(ws, (c) => moveCastImages(c, moves), false, remember);
      // 頭の印（立ち絵の画像のパスで覚えている）
      updateStudioStateUndoable(ws, (s) => renameStateAssets(s, moves), remember);
    }
    const config: string[] = [];
    updateConfigUndoable(
      ws,
      (raw) => {
        config.push(...rewriteConfigAssets(raw, kind, moves));
        if (config.length === 0) return false;
      },
      remember,
    );
    // プラグインが形を宣言した作品のデータの中の素材
    const data = new Set<string>();
    for (const [a, b] of moves) for (const f of renameInDeclaredData(ws, { kind: "asset", folder: kind, from: a, to: b }, remember)) data.add(f);
    // 作品の CSS（ui.css とそのフォルダ）の url() と @import
    const css: string[] = [];
    const kindDir = `${relative(ws.project.root, ws.project.paths.assets).split(sep).join("/")}/${kind}`;
    for (const { source, file } of assetTextFiles(ws.project)) {
      if (!isRenamedCss(source, file)) continue;
      const rel = relative(ws.project.root, file).split(sep).join("/");
      const text = readFileSync(file, "utf8");
      const next = renameCssAssets(text, rel, kindDir, moves);
      if (next === text) continue;
      writeTextUndoable(file, next, rel, remember);
      css.push(rel);
    }
    // 手で直す所（書き換えたあとの中身で探す。VS Code の F2 も同じもの）: 台本と設定に残った参照と、前の名前が文字として出てくる所（式に渡す文字、データ、訳、テンプレート、プラグインなど）
    const scenarios = ws.files().map((file) => {
      const { text, script } = ws.script(file);
      return { file, text, script };
    });
    const left = assetRenameLeft({ scenarios, scriptLeft, config: ws.readConfig(), texts: readAssetTextFiles(ws.project) }, ws.commands, kind, moves);
    return { moved: [...moves.values()], files, cast, left, ...(config.length > 0 ? { config } : {}), ...(data.size > 0 ? { data: [...data] } : {}), ...(css.length > 0 ? { css } : {}) };
  }, (steps) => (undo = steps ? ws.journals.add(steps, () => ws.forgetAssets()) : null));
  return undo ? { ...out, undo } : out;
}

/** 素材をごみ箱へ（フォルダごとでもよい）。⌘Z で戻すための控え（undo）も返す。 */
export function trashAsset(ws: StudioWorkspace, kind: string, path: string): AssetTrashResult {
  const root = kindRoot(ws, kind);
  const src = managedPath(root, path, "素材");
  if (!existsSync(src)) throw new StudioError(404, `${kind}/${path} がありません`);
  const moved = statSync(src).isDirectory() ? filesUnder(src).map((f) => `${path}/${f}`) : [path];
  const { id, step } = moveAllToTrash(ws, [{ src, kind, path }]);
  ws.forgetAssets();
  const undo = ws.journals.add([step], () => ws.forgetAssets());
  return { id, moved, ...(undo ? { undo } : {}) };
}

/**
 * 素材のファイルをまとめてごみ箱へ。一つの id に入れるので、件数が多くても古いものを減らすときに一部だけ消えず、まとめて元に戻せる。
 * どれかが無い・ファイルでなければ、何も動かさない。⌘Z で戻すための控え（undo）も返す。
 */
export function trashAssets(ws: StudioWorkspace, items: readonly { kind: string; path: string }[]): AssetTrashResult {
  const { id, moved, step } = trashAssetFiles(ws, items);
  const undo = ws.journals.add([step], () => ws.forgetAssets());
  return { id, moved, ...(undo ? { undo } : {}) };
}

/** 素材のファイルをまとめてごみ箱へ入れ、⌘Z で戻す手順だけを返す（テーマの適用が自分の控えに並べる）。 */
function trashAssetsStep(ws: StudioWorkspace, items: readonly { kind: string; path: string }[]): Step {
  return trashAssetFiles(ws, items).step;
}

function trashAssetFiles(ws: StudioWorkspace, items: readonly { kind: string; path: string }[]): { id: string; moved: string[]; step: Step } {
  if (items.length === 0) throw new StudioError(400, "ごみ箱に入れる素材がありません");
  const seen = new Set<string>();
  const moves: { src: string; kind: string; path: string }[] = [];
  for (const { kind, path } of items) {
    if (seen.has(`${kind}/${path}`)) continue;
    seen.add(`${kind}/${path}`);
    const src = managedPath(kindRoot(ws, kind), path, "素材");
    if (!existsSync(src)) throw new StudioError(404, `${kind}/${path} がありません`);
    if (!statSync(src).isFile()) throw new StudioError(400, `${kind}/${path} はファイルではありません`);
    moves.push({ src, kind, path });
  }
  const { id, step } = moveAllToTrash(ws, moves);
  ws.forgetAssets();
  return { id, moved: moves.map((m) => `${m.kind}/${m.path}`), step };
}

/**
 * ファイルかフォルダを動かす。別のディスクへは名前の付け替えで動かせない（EXDEV）ので、写してから元を消す
 * （素材のフォルダを作品の外のディスクに置いたとき、ごみ箱は作品の .liminalia/trash にあるため）。rename は試験で差し替える。
 */
export function moveAcross(src: string, dest: string, rename: (a: string, b: string) => void = renameSync): void {
  try {
    rename(src, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    cpSync(src, dest, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    rmSync(src, { recursive: true, force: true });
  }
}

/** src を .liminalia/trash/<id>/<kind>/<path> へ動かし、id を返す。古いものは TRASH_KEEP 件まで減らす。 */
export function moveToTrash(ws: StudioWorkspace, src: string, kind: string, path: string): string {
  return moveAllToTrash(ws, [{ src, kind, path }]).id;
}

/**
 * まとめてごみ箱の一つの id へ動かし、id と、⌘Z で戻す手順を返す。戻すと元の場所へ動かしてその id を消し、
 * やり直すと同じ id へ動かし直す（ごみ箱の古いものを減らして、その id が消えていれば戻さない）。
 */
function moveAllToTrash(ws: StudioWorkspace, moves: readonly { src: string; kind: string; path: string }[]): { id: string; step: Step } {
  const trash = join(ws.project.root, TRASH_DIR);
  const base = versionStamp(new Date());
  let id = base;
  for (let i = 1; existsSync(join(trash, id)); i++) id = `${base}-${i}`;
  const items: TrashItem[] = [];
  const placed: { src: string; dest: string }[] = [];
  for (const { src, kind, path } of moves) {
    const dest = join(trash, id, kind, ...path.split("/"));
    mkdirSync(dirname(dest), { recursive: true });
    const folder = statSync(src).isDirectory();
    moveAcross(src, dest);
    placed.push({ src, dest });
    items.push({ kind, path, ...(folder ? { folder: true } : {}) });
  }
  const list = `${JSON.stringify(items)}\n`;
  writeAtomic(join(trash, id, TRASH_ITEMS), list);
  const ids = readdirSync(trash).sort().reverse();
  for (const old of ids.slice(TRASH_KEEP)) rmSync(join(trash, old), { recursive: true, force: true });
  const dir = join(trash, id);
  const step: Step = {
    name: `.liminalia/trash/${id}`,
    key: `trash:${id}`,
    undo: () => {
      for (const p of placed) {
        mkdirSync(dirname(p.src), { recursive: true });
        moveAcross(p.dest, p.src);
      }
      rmSync(dir, { recursive: true, force: true });
    },
    redo: () => {
      for (const p of placed) {
        mkdirSync(dirname(p.dest), { recursive: true });
        moveAcross(p.src, p.dest);
      }
      writeAtomic(join(dir, TRASH_ITEMS), list);
    },
    isAfter: () => placed.every((p) => existsSync(p.dest) && !existsSync(p.src)),
    isBefore: () => placed.every((p) => existsSync(p.src) && !existsSync(p.dest)),
  };
  return { id, step };
}

/** ごみ箱から戻す。戻す先に同じ名前があれば何も戻さない。 */
export function restoreTrash(ws: StudioWorkspace, id: string): { restored: string[] } {
  if (!/^[0-9]{8}-[0-9]{6}-[0-9]{3}(-[0-9]+)?$/.test(id)) throw new StudioError(400, `ごみ箱の ID として使えません: ${id}`);
  const dir = join(ws.project.root, TRASH_DIR, id);
  if (!existsSync(dir)) throw new StudioError(404, `ごみ箱に ${id} はありません`);
  // ごみ箱の中は <種類>/<パス>（シナリオは @scenario/<パス>）。いちばん上（種類の中の、消したファイルかフォルダ）ごと戻す
  const tops: { from: string; to: string; rel: string }[] = [];
  for (const kind of readdirSync(dir)) {
    if (kind.startsWith(".")) continue;
    const base = kind === SCENARIO_TRASH ? ws.project.paths.scenario : kind === THEME_TRASH ? join(ws.project.root, "themes") : join(ws.project.paths.assets, kind);
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        const rel = relative(join(dir, kind), p);
        const to = join(base, rel);
        if (e.isDirectory() && existsSync(to) && statSync(to).isDirectory()) walk(p);
        else tops.push({ from: p, to, rel: `${kind}/${rel.split(sep).join("/")}` });
      }
    };
    walk(join(dir, kind));
  }
  const taken = tops.filter((t) => existsSync(t.to));
  if (taken.length > 0) throw new StudioError(409, `復元先に同じ名前のものがあります: ${taken.map((t) => t.rel).join("、")}`);
  for (const t of tops) {
    mkdirSync(dirname(t.to), { recursive: true });
    moveAcross(t.from, t.to);
  }
  rmSync(dir, { recursive: true, force: true });
  ws.forgetAssets();
  return { restored: tops.map((t) => t.rel) };
}

/**
 * ごみ箱の中身（新しい順）。何を（種類とパス。一つの id から TRASH_LIST_ITEMS 件まで）、いつ入れたか。戻すのは restoreTrash。
 * 入れたものの一覧（.items.json）の無い古いものは、中のいちばん上のファイルとフォルダを出す。
 */
export function listTrash(ws: StudioWorkspace): TrashEntry[] {
  const trash = join(ws.project.root, TRASH_DIR);
  if (!existsSync(trash)) return [];
  const ids = readdirSync(trash)
    .filter((id) => /^[0-9]{8}-[0-9]{6}-[0-9]{3}(-[0-9]+)?$/.test(id) && statSync(join(trash, id)).isDirectory())
    .sort()
    .reverse();
  return ids.map((id) => {
    const dir = join(trash, id);
    let items: TrashItem[];
    try {
      items = (JSON.parse(readFileSync(join(dir, TRASH_ITEMS), "utf8")) as TrashItem[]).filter((i) => typeof i?.kind === "string" && typeof i?.path === "string");
    } catch {
      // ごみ箱の目録が読めなければ、フォルダの中身から並べ直す
      items = readdirSync(dir)
        .filter((kind) => !kind.startsWith(".") && statSync(join(dir, kind)).isDirectory())
        .flatMap((kind) => readdirSync(join(dir, kind), { withFileTypes: true }).map((e): TrashItem => ({ kind, path: e.name, ...(e.isDirectory() ? { folder: true } : {}) })));
    }
    const shown = items.slice(0, TRASH_LIST_ITEMS).map((item) => {
      // テーマは名前で出す（theme.json の name）
      if (item.kind !== THEME_TRASH) return item;
      try {
        const name = (JSON.parse(readFileSync(join(dir, THEME_TRASH, item.path, "theme.json"), "utf8")) as { name?: unknown }).name;
        return typeof name === "string" ? { ...item, name } : item;
      } catch {
        // テーマの名前が読めなければ ID で出す
        return item;
      }
    });
    const time = versionTime(id);
    return { id, time: time === null ? statSync(dir).mtime.toISOString() : new Date(time).toISOString(), items: shown, total: items.length };
  });
}

/** 素材のフォルダの中にフォルダを作る。 */
export function makeAssetFolder(ws: StudioWorkspace, kind: string, path: string): void {
  const dir = managedPath(kindRoot(ws, kind), path, "フォルダ");
  if (existsSync(dir)) throw new StudioError(409, `${kind}/${path} はすでにあります`);
  mkdirSync(dir, { recursive: true });
}

/** 開く素材フォルダを用意する。リンクをたどって素材の外へ出ない。 */
export function assetFolderToReveal(ws: StudioWorkspace, kind: string, path: string): string {
  const root = kindRoot(ws, kind);
  if (path) managedPath(root, path, "フォルダ");
  mkdirSync(ws.project.paths.assets, { recursive: true });
  let dir = ws.project.paths.assets;
  for (const part of [kind, ...(path ? path.split("/") : [])]) {
    dir = join(dir, part);
    try {
      const info = lstatSync(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new StudioError(400, `フォルダを開けません: ${kind}/${path}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      mkdirSync(dir);
    }
  }
  return dir;
}

// ---- シナリオのファイル ----

/** ファイルの画面で選ぶシナリオ。存在する台本だけを受け付ける。 */
export function scenarioFileToReveal(ws: StudioWorkspace, file: string): string {
  const path = ws.path(file);
  if (!ws.files().includes(file)) throw new StudioError(404, `${file}.lim がありません`);
  return path;
}

/** 素材のファイルを選ぶ。各階層でシンボリックリンクをたどらない。 */
export function assetFileToReveal(ws: StudioWorkspace, kind: string, path: string): string {
  const root = kindRoot(ws, kind);
  const target = managedPath(root, path, "素材");
  let current = ws.project.paths.assets;
  const parts = [kind, ...path.split("/")];
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let info;
    try { info = lstatSync(current); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new StudioError(404, `${kind}/${path} がありません`);
      throw e;
    }
    if (info.isSymbolicLink() || (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())) throw new StudioError(400, `フォルダを開けません: ${kind}/${path}`);
  }
  return target;
}

/** 新しいシナリオのファイルを作る。text を省くとラベル一つだけの台本。 */
export function createScenario(ws: StudioWorkspace, file: string, text?: string): void {
  if (existsSync(ws.path(file))) throw new StudioError(409, `${file}.lim はすでにあります`);
  const name = file.slice(file.lastIndexOf("/") + 1);
  const body = text ?? `# ${/^[\p{L}\p{N}_-]+$/u.test(name) ? name : "start"}\n`;
  const r = ws.write(file, body, null, false);
  if (!r.ok) throw new StudioError(409, `${file}.lim はすでにあります`);
}

/** シナリオのファイルを写す（飛び先は書き換えない。写した先の中の、元のファイルを名指しした飛び先も元のまま）。 */
export function duplicateScenario(ws: StudioWorkspace, from: string, to: string): void {
  createScenario(ws, to, ws.fileText(from).text);
}

/**
 * シナリオのファイルの名前を変える。ほかのファイル（と自分）の飛び先（@jump・@call・@use・選択肢・飛び先の引数）を書き換え、
 * 前の版の履歴も移す。ファイルの名前を持つほかの場所も追従させる:
 * - liminalia.json の entry・afterLoad・extra.replay と extra.chapters の target・extra.flowchart.titles の鍵・飛び先に使う変数の初期値
 *   （entry・afterLoad を書き換えたら、起動し直しを求める（entry: true））
 * - 訳の鍵と voice-lock.json の鍵（"ファイル:…"）、reviews/ のスレッドのファイル
 * - .liminalia/studio.json のブックマーク・ブレークポイント・最後に開いていた場所・フローチャートで動かした位置、lim regress の基準の画像
 * 途中で書けなくなったら、書き終えたものを元に戻す。
 */
export function renameScenario(ws: StudioWorkspace, from: string, to: string): ScenarioRenameResult {
  const src = ws.path(from);
  const dest = ws.path(to);
  if (!existsSync(src)) throw new StudioError(404, `${from}.lim がありません`);
  if (existsSync(dest)) throw new StudioError(409, `${to}.lim はすでにあります`);
  refuseNotUtf8(ws);
  const specOf = (name: string) => ws.commands.get(name);
  const rewrite = (file: string) => {
    const { text, script } = ws.script(file);
    return rewriteFileInScript(text, script, specOf, from, to).text;
  };
  const before = ws.script(from);
  const labels: string[] = [];
  visit(before.script.body, (s) => {
    if (s.kind === "label") labels.push(s.name);
  });
  const variables = targetVariables(scriptMap(ws).values());
  return withRollback(RENAME_FAILED, (remember) => {
    const files: string[] = [];
    // 名前を変えるファイル: 中身を書き換えて新しい名前で書き、古いものを消す
    const own = rewrite(from);
    const created = ws.write(to, own, null, false);
    if (!created.ok) throw new StudioError(409, `${to}.lim はすでにあります`);
    remember(`${to}.lim`, () => {
      rmSync(dest, { force: true });
      ws.touched(dest);
    });
    rmSync(src);
    ws.touched(src);
    remember(`${from}.lim`, () => {
      writeAtomic(src, before.text);
      ws.touched(src);
    });
    const history = join(ws.project.root, ".liminalia", "history");
    const oldHistory = join(history, ...from.split("/"));
    const newHistory = join(history, ...to.split("/"));
    if (existsSync(oldHistory) && !existsSync(newHistory)) {
      mkdirSync(dirname(newHistory), { recursive: true });
      renameSync(oldHistory, newHistory);
      remember(`.liminalia/history/${from}`, () => renameSync(newHistory, oldHistory));
    }
    for (const file of ws.files()) {
      if (file === to) continue;
      const { text, hash } = ws.script(file);
      const out = rewrite(file);
      if (out === text) continue;
      writeScriptUndoable(ws, file, out, hash, text, remember);
      files.push(file);
    }
    renameTranslationKeys(ws, from, to, remember);
    renameVoiceLockFile(ws, from, to, remember);
    renameReviewFile(ws.project, from, to, remember);
    for (const label of labels) renameBaselines(ws, { file: from, from: label, to: label, toFile: to }, remember);
    // ファイルの名前を持つ覚え書き（ブックマーク、ブレークポイント、最後に開いていた場所、フローチャートの位置、シーンの印）
    updateStudioStateUndoable(ws, (st) => renameStateFile(st, from, to), remember);
    // 設定の飛び先（「はじめから」・ロード直後・回想と章・フローチャートの題・飛び先に使う変数の初期値・章のファイル・場面の情報・無音の場面）
    let entry = false;
    let config: string[] = [];
    let left: string[] = [];
    updateConfigUndoable(
      ws,
      (raw) => {
        left = configFileLeft(raw, from, to);
        config = rewriteConfigFile(raw, from, to, variables);
        if (config.length === 0) return false;
        entry = config.includes("entry") || config.includes("afterLoad");
      },
      remember,
    );
    if (entry) ws.targetsChanged();
    const data = renameInDeclaredData(ws, { kind: "file", from, to }, remember);
    // 台本のテスト（from と expect reach の場所、式の飛び先）
    const tests = renameInTests(ws, { kind: "file", from, to }, remember);
    return { files, entry, ...(data.length > 0 ? { data } : {}), ...(config.length > 0 ? { config } : {}), ...(left.length > 0 ? { left } : {}), ...(tests ? { tests } : {}) };
  });
}

/**
 * マクロ（@define）の名前を変える（lim rename macro）。@define の行と、全シナリオの呼び出し（行の命令、本文の中の {@…}、@with）を書き換え、
 * liminalia.json の commandDefaults の鍵も替える。本文を書き換えた行の訳の鍵と voice-lock.json の鍵は、同じ行の新しい鍵へ付け替える。
 * 同じ名前の @define が二つ以上のファイルにあるときは、file でどのファイルの @define かを選ぶ（選ばなければ断る）。そのときは、そのファイルと、
 * 呼び出しがそのファイルの @define に当たるファイル（自分の @define が無く、@use した中でそのファイルが最初に持つもの。遊ぶ側の findDefine と同じ）
 * だけを書き換え、commandDefaults は元の鍵を残して新しい鍵へ写す。途中で書けなくなったら元に戻す。
 */
export function renameMacro(ws: StudioWorkspace, from: string, to: string, file?: string): MacroRenameResult {
  const defines = (f: string, name: string) => ws.script(f).script.body.some((s) => s.kind === "define" && s.name === name);
  const found = ws.files().filter((f) => defines(f, from));
  if (found.length === 0) throw new StudioError(404, `マクロ @${from} がありません（@define ${from}(…) が見つかりません）`);
  if (file !== undefined && !found.includes(file)) throw new StudioError(404, `${file}.lim に @define ${from} がありません`);
  if (found.length > 1 && file === undefined) throw new StudioError(409, `@define ${from} が ${found.map((f) => `${f}.lim`).join("、")} にあります。先に一つにしてください`);
  if (from === to) return { files: [], lines: 0, config: false };
  // 同じ名前が二つ以上あれば、選んだ @define に当たるファイルだけ（一つなら、@use し忘れた呼び出しも含めてすべて）
  const home = (f: string): string | null => {
    if (defines(f, from)) return f;
    for (const s of ws.script(f).script.body) if (s.kind === "use" && found.includes(s.file)) return s.file;
    return null;
  };
  const only = found.length > 1 ? file! : null;
  const problem = macroNameProblem(to, ws.commands);
  if (problem) throw new StudioError(400, problem);
  if (ws.files().some((f) => ws.script(f).script.body.some((s) => s.kind === "define" && s.name === to))) throw new StudioError(409, `マクロ @${to} はすでにあります`);
  refuseNotUtf8(ws);
  const before = scriptMap(ws);
  return withRollback(RENAME_FAILED, (remember) => {
    const files: string[] = [];
    let lines = 0;
    for (const f of ws.files()) {
      if (only !== null && home(f) !== only) continue;
      const { text, hash, script } = ws.script(f);
      const r = rewriteMacroInScript(text, script, from, to);
      if (r.changed.length === 0) continue;
      writeScriptUndoable(ws, f, r.text, hash, text, remember);
      files.push(f);
      lines += r.changed.length;
    }
    // 本文の中の {@マクロ} を書き換えた行は、原文から作る訳の鍵が変わる（訳文の中の {@マクロ} も替える）
    const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    followLineKeys(ws, before, (t) => t.replace(new RegExp(`\\{@${esc}(?=[\\s}])`, "g"), `{@${to}`), remember);
    const config = updateConfigUndoable(ws, (raw) => (rewriteConfigMacro(raw, from, to, only !== null) ? undefined : false), remember);
    return { files, lines, config };
  });
}

/** シナリオのファイルをごみ箱へ。「はじめから」のファイルは消せない。 */
export function trashScenario(ws: StudioWorkspace, file: string): AssetTrashResult {
  const src = ws.path(file);
  if (!existsSync(src)) throw new StudioError(404, `${file}.lim がありません`);
  if (ws.project.config.entry.split("#")[0] === file) throw new StudioError(400, `${file} は「はじめから」のファイルのため削除できません`);
  const id = moveToTrash(ws, src, SCENARIO_TRASH, `${file}.lim`);
  ws.touched(src);
  return { id, moved: [file] };
}

// ---- 変数 ----

/** 台本で使っている変数と、初期値を決めた変数（名前順。game・system・temp の順）。 */
export function listVariables(ws: StudioWorkspace): VariableInfo[] {
  const map = new Map<string, VariableInfo>();
  const get = (path: string): VariableInfo => {
    let v = map.get(path);
    if (!v) map.set(path, (v = { path, scope: path.split(".")[0] as VariableInfo["scope"], writes: [], reads: [] }));
    return v;
  };
  for (const [path, value] of Object.entries(ws.readVariables())) get(path).initial = value;
  for (const file of ws.files()) {
    for (const u of variableUses(ws.script(file).script, ws.commands)) {
      const v = get(u.path);
      const list = u.write ? v.writes : v.reads;
      if (!list.some((x) => x.file === file && x.line === u.line)) list.push({ file, line: u.line });
    }
  }
  const order = { game: 0, system: 1, temp: 2 };
  // 名前の中の数は数として並べる（chapter_2 を chapter_10 より前に）
  return [...map.values()].sort((a, b) => order[a.scope] - order[b.scope] || a.path.localeCompare(b.path, "en", { numeric: true }));
}

/** 変数の初期値を決める（remove なら外す）。temp の変数には決められない。 */
export function setVariable(ws: StudioWorkspace, path: string, value: Value, remove: boolean, create = false): void {
  if (!isVariablePath(path) || path.startsWith("temp.")) throw new StudioError(400, `初期値を設定できる変数は game.名前 か system.名前 です: ${path}`);
  forbidPath(path);
  updateConfig(ws, (raw) => {
    const vars = { ...((raw.variables as Record<string, Value> | undefined) ?? {}) };
    if (create && Object.hasOwn(vars, path)) throw new StudioError(409, `この変数にはもう初期値があります: ${path}`);
    if (remove) delete vars[path];
    else vars[path] = value;
    if (Object.keys(vars).length === 0) delete raw.variables;
    else raw.variables = Object.fromEntries(Object.entries(vars).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  });
}

/** 変数の名前に使えないキー（__proto__ など。実行器も代入しない）を含む道筋は受け付けない。 */
function forbidPath(path: string): void {
  const bad = path.split(".").find((k) => FORBIDDEN_PROPERTIES.has(k));
  if (bad) throw new StudioError(400, `${bad} は変数の名前やキーに使えません: ${path}`);
}

/**
 * 変数の名前を変える。台本の中の読む・書く場所と、初期値の名前も書き換える。置き場所（game・system・temp）も替えられる。
 * liminalia.json の ui と extra の条件（"if"）と、制作画面のブレークポイントの条件も書き換える。途中で書けなくなったら元に戻す。
 */
export function renameVariable(ws: StudioWorkspace, from: string, to: string): { files: string[]; tests?: TestRenameResult } {
  if (!isVariablePath(from) || !isVariablePath(to)) throw new StudioError(400, `変数名は game.名前、system.名前、temp.名前 のどれかの形で指定します: ${to}`);
  if (from === to) return { files: [] };
  forbidPath(to);
  const used = listVariables(ws);
  if (used.some((v) => v.path === to)) throw new StudioError(409, `変数 ${to} はすでにあります`);
  refuseNotUtf8(ws);
  const before = scriptMap(ws);
  return withRollback(RENAME_FAILED, (remember) => {
    const files: string[] = [];
    for (const file of ws.files()) {
      const { text, hash, script } = ws.script(file);
      const r = rewriteVariableInScript(text, script, ws.commands, from, to);
      if (r.changed.length === 0) continue;
      writeScriptUndoable(ws, file, r.text, hash, text, remember);
      files.push(file);
    }
    // 本文の中の {= 変数} を書き換えた行は、原文から作る訳の鍵が変わる（訳文の中の変数も替える）
    followLineKeys(ws, before, (t) => renameVariableInLine(t, from, to), remember);
    // 初期値の名前と、設定の条件（タイトルの差し替え・システムボイスなどの "if"）
    updateConfigUndoable(ws, (raw) => (rewriteConfigVariable(raw, from, to) ? undefined : false), remember);
    updateStudioStateUndoable(ws, (st) => renameStateVariable(st, from, to), remember);
    // プラグインが形を宣言した作品のデータの中のフラグと条件の式
    const data = renameInDeclaredData(ws, { kind: "variable", from, to }, remember);
    // 台本のテストの set と expect の式（書き換えないと、消えた変数が null になって expect が誤って通ることがある）
    const tests = renameInTests(ws, { kind: "variable", from, to }, remember);
    return { files: [...files, ...data.map((d) => `data/${d}`)], ...(tests ? { tests } : {}) };
  });
}

// ---- 作品の設定 ----

/** liminalia.json の項目の並び（足すときはこの並びの前の項目の後ろに入れる）。 */
const CONFIG_ORDER = ["id", "title", "version", "author", "screen", "entry", "titleScreen", "afterLoad", "allowScript", "saves", "paths", "languages", "variables", "ui", "extra", "plugins", "import", "check", "scenes", "fmt", "build"];

/** 作品の設定（liminalia.json のうち、制作画面の「作品」の基本と書き出しで直す項目）。 */
export function readSettings(ws: StudioWorkspace): ProjectSettings {
  return pickSettings(ws.readConfig() as unknown as Record<string, unknown>);
}

function pickSettings(raw: Record<string, unknown>): ProjectSettings {
  return Object.fromEntries(SETTINGS_KEYS.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]])) as ProjectSettings;
}

/**
 * 作品の設定を書く。送らなかった項目・空にした項目は外す（id・title・entry は外せない）。形が誤っていれば書かない。
 * baseHash（読んだときの configPartHash(readSettings)）を渡したときは、読んだあとにほかで変わっていれば書かずに今の中身を返す。
 * 開発サーバーを起動し直さないと効かない項目（書き出しの設定のほか）が、起動したときと違えば restart。
 */
export function setSettings(ws: StudioWorkspace, settings: unknown, baseHash?: string): ({ ok: true; hash: string | null } & SettingsResult) | { ok: false; current: PartRead<ProjectSettings> } {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new StudioError(400, "settings はオブジェクトで送ってください");
  const next = prune(settings) as Record<string, unknown>;
  const problems = settingsProblems(ws, next);
  if (problems.length > 0) throw new StudioError(400, problems.join("\n"));
  const r = updateConfigPart(ws, pickSettings, baseHash, (raw) => {
    for (const key of SETTINGS_KEYS) {
      if (next[key] === undefined) delete raw[key];
      else placeKey(raw, key, next[key]);
    }
  });
  if (!r.ok) return r;
  return { ...r, restart: restartNeeded(ws, ws.readConfig() as unknown as Record<string, unknown>) };
}

/**
 * 開発サーバーを起動し直さないと効かない項目（作品の設定とプラグイン）が、起動したときと違うか。
 * 書き出しの設定と、検査と整形の設定（読むたびに liminalia.json から読む）は、起動し直さなくても効く。
 * 書いたあとと、読んだとき（元に戻すで起動したときの値に戻ったら、起動し直すよう知らせるのをやめる）に見る。
 */
export function restartNeeded(ws: StudioWorkspace, next: Record<string, unknown>): boolean {
  const running = ws.project.config as unknown as Record<string, unknown>;
  return RESTART_KEYS.some((k) => JSON.stringify(prune(next[k]) ?? (k === "plugins" ? [] : undefined)) !== JSON.stringify(prune(running[k]) ?? (k === "plugins" ? [] : undefined)));
}

/** 空の文字列・空のオブジェクト・空の配列を外す（深いところも）。 */
function prune(v: unknown): unknown {
  if (Array.isArray(v)) return v.length > 0 ? v : undefined;
  if (v && typeof v === "object") {
    const out = Object.fromEntries(Object.entries(v).flatMap(([k, x]) => {
      const p = prune(x);
      return p === undefined ? [] : [[k, p]];
    }));
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return v === "" || v === null ? undefined : v;
}

/** 項目を、あればその場所で、無ければ CONFIG_ORDER の並びの場所に入れる。 */
function placeKey(raw: Record<string, unknown>, key: string, value: unknown): void {
  if (key in raw) {
    raw[key] = value;
    return;
  }
  const at = CONFIG_ORDER.indexOf(key);
  const entries = Object.entries(raw);
  const index = entries.findIndex(([k]) => CONFIG_ORDER.indexOf(k) > at);
  entries.splice(index < 0 ? entries.length : index, 0, [key, value]);
  for (const k of Object.keys(raw)) delete raw[k];
  Object.assign(raw, Object.fromEntries(entries));
}

/** Steam Input のアクションに結べるゲームの操作（packages/desktop の store.cjs の INPUT_TARGETS と同じ）。 */
export const STEAM_INPUT_TARGETS: readonly unknown[] = ["a", "b", "x", "y", "lb", "rb", "lt", "rt", "select", "start", "up", "down", "left", "right", "advance", "back", "quick-save", "quick-load", "save", "load", "auto", "skip", "rollback", "rollforward", "prev-choice", "next-choice", "next-unread", "backlog", "config", "flowchart", "screenshot", "hide", "menu", "title"];

/** 作品の設定の形の誤り。 */
function settingsProblems(ws: StudioWorkspace, s: Record<string, unknown>): string[] {
  const out: string[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const str = (v: unknown) => v === undefined || typeof v === "string";
  const bool = (v: unknown) => v === undefined || typeof v === "boolean";
  const int = (v: unknown, min: number) => v === undefined || (Number.isInteger(v) && (v as number) >= min);
  const strings = (v: unknown) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === "string"));
  const oneOf = (v: unknown, values: readonly string[]) => v === undefined || values.includes(v as string);
  const target = (name: string, v: unknown) => {
    if (typeof v !== "string") return;
    const [file = "", label] = v.split("#");
    if (!ws.files().includes(file)) return out.push(`${name} のファイル ${file} がありません`);
    if (label !== undefined && !ws.script(file).script.body.some((x) => x.kind === "label" && x.name === label)) out.push(`${name} のラベル #${label} が ${file} にありません`);
  };
  for (const key of ["id", "title", "entry"] as const) if (typeof s[key] !== "string") out.push(`${key} は空にできません`);
  if (!str(s.version) || !str(s.author)) out.push("version、author は文字列で指定します");
  // id と version は書き出したフォルダとファイルの名前になる。id は変えるときだけ作る所と同じ形にする（手で書いた形の違う id の作品も設定を書ける）
  if (typeof s.id === "string" && (unsafeProjectId(s.id) || (s.id !== ws.readConfig().id && !(PROJECT_ID_PATTERN.test(s.id) && s.id.length <= PROJECT_ID_MAX)))) out.push(`id は英数字、_、- で書き、英数字で始めて ${PROJECT_ID_MAX} 文字までにします`);
  if (typeof s.version === "string" && !plainName(s.version)) out.push("version に / と \\ と制御文字は書けません（書き出したファイルの名前に入ります）");
  if (s.screen !== undefined && !(isObj(s.screen) && int(s.screen.width, 1) && int(s.screen.height, 1) && s.screen.width !== undefined && s.screen.height !== undefined)) out.push("screen は幅と高さ（1 以上の整数）で指定します");
  target("entry", s.entry);
  if (s.afterLoad !== undefined) target("afterLoad", s.afterLoad);
  if (!bool(s.titleScreen) || !bool(s.allowScript)) out.push("titleScreen、allowScript は true か false で指定します");
  if (s.saves !== undefined && !(isObj(s.saves) && oneOf(s.saves.location, ["user", "portable"]) && bool(s.saves.protect) && (s.saves.carryFrom === undefined || (isObj(s.saves.carryFrom) && Object.values(s.saves.carryFrom).every((v) => typeof v === "string"))))) out.push('saves は location（"user" か "portable"）、protect、carryFrom（プロジェクト ID → タイトル）で指定します');
  if (s.paths !== undefined && !(isObj(s.paths) && Object.entries(s.paths).every(([k, v]) => ["scenario", "assets", "data", "cast", "lang", "voiceLock", "out"].includes(k) && typeof v === "string"))) out.push("paths はフォルダの名前で指定します");
  if (s.import !== undefined && !(isObj(s.import) && (s.import.tyrano === undefined || (isObj(s.import.tyrano) && typeof s.import.tyrano.source === "string" && str(s.import.tyrano.profile))))) out.push("import.tyrano には source（インポート元のフォルダ）を指定します");
  const c = s.check;
  if (c !== undefined) {
    if (!isObj(c)) out.push("check はオブジェクトで指定します");
    else {
      if (c.punctuation !== undefined && c.punctuation !== false && !(isObj(c.punctuation) && strings(c.punctuation.off))) out.push('check.punctuation は false か { "off": [外す検査の名前] } で指定します');
      if (c.rules !== undefined && !(Array.isArray(c.rules) && c.rules.every((r) => isObj(r) && typeof r.rule === "string"))) out.push("check.rules は { rule: ルール名 } の配列で指定します");
      out.push(...checkSeverityConfig(c.severity).map((d) => d.message));
      if (!oneOf(c.variables, ["declared"])) out.push('check.variables は "declared" か、書かないかです');
    }
  }
  const fmt = s.fmt;
  if (fmt !== undefined && !(isObj(fmt) && (fmt.indent === undefined || fmt.indent === "tab" || (Number.isInteger(fmt.indent) && (fmt.indent as number) >= 0 && (fmt.indent as number) <= 8)))) out.push('fmt.indent は 0 から 8 の空白の数か "tab" で指定します');
  if (isObj(fmt) && !bool(fmt.expressions)) out.push("fmt.expressions は true か false で指定します");
  const b = s.build;
  if (b !== undefined) {
    if (!isObj(b)) return [...out, "build はオブジェクトで指定します"];
    if (!str(b.bundleId) || !str(b.icon) || !str(b.winIcon) || !str(b.executableName)) out.push("build の bundleId、icon、winIcon、executableName は文字列で指定します");
    if (b.iconBackground !== undefined && !(typeof b.iconBackground === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(b.iconBackground))) out.push("build.iconBackground は #rrggbb の色で指定します");
    // 実行ファイル名は、どの OS に書き出しても使える名前だけ受け付ける
    if (typeof b.executableName === "string") {
      const problems = (["windows", "mac", "linux"] as const).flatMap((p) => fileNameProblems(b.executableName as string, p).filter((x) => x.level === "error").map((x) => x.message));
      if (problems.length > 0) out.push(`build.executableName: ${[...new Set(problems)].join("、")}`);
    }
    if (b.crashReport !== undefined && !(isObj(b.crashReport) && typeof b.crashReport.url === "string" && /^https?:\/\//.test(b.crashReport.url))) out.push("build.crashReport の url は http(s):// の URL で指定します");
    if (b.feedback !== undefined && !(isObj(b.feedback) && (b.feedback.url === undefined || (typeof b.feedback.url === "string" && /^https?:\/\//.test(b.feedback.url))))) out.push("build.feedback の url は http(s):// の URL で指定します");
    if (!int(b.verifyWait, 0) || !int(b.buildNumber, 1)) out.push("build の verifyWait は 0 以上、buildNumber は 1 以上の整数で指定します");
    if (!bool(b.asar) || !bool(b.resizable) || !bool(b.encrypt)) out.push("build の asar、encrypt、resizable は true か false で指定します");
    if (!strings(b.exclude) || !strings(b.forbid)) out.push("build の exclude、forbid は文字列の配列で指定します");
    if (b.variants !== undefined && !(isObj(b.variants) && Object.entries(b.variants).every(([k, v]) => /^[A-Za-z0-9_-]+$/.test(k) && isObj(v) && strings(v.forbid) && strings(v.exclude) && bool(v.contentFilter) && bool(v.feedback)))) out.push("build.variants はエディションの名前（英数字）→ { forbid, exclude, contentFilter, feedback } で指定します");
    if (b.subsetFonts !== undefined && !(isObj(b.subsetFonts) && Array.isArray(b.subsetFonts.files) && strings(b.subsetFonts.files) && str(b.subsetFonts.text))) out.push("build.subsetFonts は files（フォントのパスの配列）と text で指定します");
    if (!oneOf(b.gpu, ["high-performance", "default"])) out.push('build.gpu は "high-performance" か "default" です');
    const a = b.android;
    // 署名は三つ揃えるか、どれも書かない（targetSdk などだけを書いてもよい）
    const signing = isObj(a) ? [a.keystore, a.alias, a.storePasswordEnv] : [];
    if (a !== undefined && !(isObj(a) && (signing.every((x) => typeof x === "string") || signing.every((x) => x === undefined)) && str(a.keyPasswordEnv))) out.push("Android の署名には、キーストアのファイル、キーのエイリアス、パスワードの環境変数の三つを指定します");
    if (isObj(a) && !int(a.targetSdk, 24)) out.push("build.android.targetSdk は 24 以上の整数で指定します");
    if (b.ios !== undefined && !(isObj(b.ios) && str(b.ios.team))) out.push("build.ios.team は文字列で指定します");
    if (isObj(b.ios) && !oneOf(b.ios.audioSession, ["ambient", "playback"])) out.push('build.ios.audioSession は "ambient" か "playback" です');
    const m = b.mobile;
    if (m !== undefined) {
      const okAudio = m === undefined || !isObj(m) || m.audio === undefined || (isObj(m.audio) && oneOf(m.audio.format, ["m4a", "opus"]) && str(m.audio.bitrate) && strings(m.audio.folders));
      const okImages = !isObj(m) || m.images === undefined || (isObj(m.images) && oneOf(m.images.format, ["webp"]) && (m.images.quality === undefined || (typeof m.images.quality === "number" && m.images.quality >= 0 && m.images.quality <= 100)) && strings(m.images.folders));
      if (!isObj(m) || !okAudio || !okImages) out.push("build.mobile の形式が正しくありません");
    }
    const up = b.update;
    if (up !== undefined && !(isObj(up) && typeof up.url === "string" && /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)[:/])/.test(up.url) && bool(up.checkOnStartup) && bool(up.steam))) out.push("build.update は url（https:// の URL）と checkOnStartup、steam（true か false）で指定します");
    const shop = b.store;
    if (shop !== undefined) {
      if (!isObj(shop)) out.push("build.store はオブジェクトで指定します");
      else {
        const p = shop.products;
        if (p !== undefined && !(isObj(p) && Object.entries(p).every(([k, v]) => /^[\p{ID_Start}_][\p{ID_Continue}_]*$/u.test(k) && isObj(v) && str(v.ios) && str(v.android) && int(v.steam, 1) && Object.values(v).every((x) => typeof x === "string" || typeof x === "number"))))
          out.push("build.store.products は商品の名前（英数字で始める）→ { ios、android（商品 ID）、steam（DLC の App ID）、ほかのストアの ID } で指定します");
        const d = shop.desktop;
        if (d !== undefined && !(isObj(d) && typeof d.module === "string" && d.module !== "" && (d.options === undefined || isObj(d.options)))) out.push("build.store.desktop には module（ストアのプラグインのファイル）を指定します");
        const a = shop.android;
        if (a !== undefined && !(isObj(a) && Array.isArray(a.libraries) && strings(a.libraries))) out.push("build.store.android.libraries はファイルのパスの配列で指定します");
      }
    }
    const mac = b.mac;
    if (mac !== undefined && !(isObj(mac) && str(mac.signIdentity) && str(mac.entitlements) && str(mac.notaryProfile) && bool(mac.notarize))) out.push("build.mac は signIdentity、entitlements、notaryProfile（文字列）と notarize（true か false）で指定します");
    const win = b.windows;
    if (win !== undefined) {
      const sign = isObj(win) ? win.sign : undefined;
      if (!isObj(win) || (sign !== undefined && !(isObj(sign) && str(sign.pfx) && str(sign.passwordEnv) && str(sign.timestampUrl) && strings(sign.command) && oneOf(sign.ifMissing, ["fail", "skip"])))) out.push('build.windows.sign は pfx、passwordEnv、timestampUrl（文字列）、command（文字列の配列）、ifMissing（"fail" か "skip"）で指定します');
      if (isObj(win) && win.installer !== undefined && !(typeof win.installer === "boolean" || (isObj(win.installer) && bool(win.installer.perMachine) && bool(win.installer.desktopShortcut) && (win.installer.languages === undefined || (Array.isArray(win.installer.languages) && win.installer.languages.every((l) => l === "ja" || l === "en")))))) out.push('build.windows.installer は true か、perMachine、desktopShortcut（true か false）と languages（"ja"、"en" の配列）で指定します');
      if (isObj(sign) && Array.isArray(sign.command) && sign.command.length > 0 && !sign.command.some((a) => typeof a === "string" && a.includes("{file}"))) out.push('build.windows.sign.command には、署名するファイルの場所に "{file}" を書きます');
      if (isObj(win) && win.wrap !== undefined && !(Array.isArray(win.wrap) && strings(win.wrap) && win.wrap.some((a) => String(a).includes("{file}")))) out.push('build.windows.wrap は文字列の配列で、実行ファイルの場所に "{file}" を書きます');
    }
    const br = b.browser;
    if (isObj(br) && !bool(br.encrypt)) out.push("build.browser の encrypt は true か false で指定します");
    const st = b.steam;
    if (st !== undefined) {
      if (!isObj(st) || !int(st.appId, 1) || st.appId === undefined) out.push("Steam には App ID（1 以上の整数）を指定します");
      else {
        if (st.achievements !== undefined && !(isObj(st.achievements) && Object.values(st.achievements).every((v) => typeof v === "string"))) out.push("Steam の実績は @achieve の名前 → 実績の API 名で指定します");
        if (st.variants !== undefined && !(isObj(st.variants) && Object.values(st.variants).every((v) => int(v, 1)))) out.push("Steam のエディションごとの App ID は 1 以上の整数で指定します");
        if (!bool(st.workshop)) out.push("Steam の workshop は true か false で指定します");
        if (st.depots !== undefined && !(isObj(st.depots) && Object.entries(st.depots).every(([k, v]) => ["windows", "mac", "linux"].includes(k) && int(v, 1)))) out.push("Steam のデポは windows、mac、linux → 1 以上のデポ ID で指定します");
        const input = st.input;
        if (input !== undefined && !(isObj(input) && str(input.actionSet) && isObj(input.actions) && Object.values(input.actions).every((v) => typeof v === "string" && STEAM_INPUT_TARGETS.includes(v))))
          out.push(`Steam Input の actions は、アクションの名前 → ゲームの操作（${STEAM_INPUT_TARGETS.join("、")}）で指定します`);
      }
    }
  }
  return out;
}

// ---- おまけ ----

/** おまけの一覧（liminalia.json の extra）を書く。空なら外す。baseHash は setSettings と同じ。 */
export function setExtra(ws: StudioWorkspace, extra: unknown, baseHash?: string): PartWrite<unknown> {
  if (extra !== undefined && (!extra || typeof extra !== "object" || Array.isArray(extra))) throw new StudioError(400, "extra はオブジェクトで送ってください");
  return updateConfigPart(ws, (raw) => raw.extra ?? {}, baseHash, (raw) => {
    // 一覧は中身のあるものだけ、CG の自動の登録（cgAuto）はそのまま残す。自動で足したもの（auto）は書かない
    const kept = Object.entries((extra ?? {}) as Record<string, unknown>).flatMap(([k, v]): [string, unknown][] => {
      if (k === "cgAuto") return v && typeof v === "object" ? [[k, v]] : [];
      if (k === "flowchart") return v === true || (v && typeof v === "object") ? [[k, v]] : [];
      const items = Array.isArray(v) && k === "cg" ? v.filter((c) => !(c as { auto?: unknown } | null)?.auto) : v;
      return Array.isArray(items) && items.length > 0 ? [[k, items]] : [];
    });
    if (kept.length === 0) delete raw.extra;
    else raw.extra = Object.fromEntries(kept);
  });
}

// ---- 翻訳 ----

/** 言語ごとの訳の進み具合。languages は liminalia.json の languages（先頭が原文の言語）。 */
export function translationStatus(ws: StudioWorkspace): TranslationStatus {
  const languages = ws.readConfig().languages ?? [];
  const scripts = scriptMap(ws);
  const status: TranslationStatus["status"] = {};
  for (const language of languages.slice(1)) {
    const r = updateTranslation(readTranslationFile(ws, language), language, scripts, ws.castFile.speakers, translationSources(ws, language));
    // システム画面の文言（日本語と英語のほかの言語だけ）は、シナリオの訳と分けて数える（画面の並びも分けて絞る）
    status[language] = { total: r.total, translated: r.translated, exists: existsSync(translationPath(ws, language)), ...(r.ui ? { ui: { total: r.ui.total, translated: r.ui.translated } } : {}) };
  }
  return { languages, status, hash: configListHash(ws, "languages") };
}

/**
 * システム画面の文言と英語の原文（@liminalia/web の ui-strings.ts の uiStringTable）。制作画面は描画側を読まないので、
 * 開発サーバーを立てる側（web の vite.config.ts、スマホ版の Service Worker、lim mcp）が渡す。渡さなければ訳のファイルに並べない（今ある分は残す）。
 */
let uiStrings: readonly UiSourceText[] | undefined;

export function setUiStringTable(table: readonly UiSourceText[]): void {
  uiStrings = table;
}

/**
 * 訳すものを集める元（コマンドの文字は命令の仕様、作品の設定の文字は liminalia.json、作品のデータの文は data/*.json の訳す欄、
 * システム画面の文言は setUiStringTable で渡された英語の表。システム画面の文言は日本語と英語以外の言語にだけ並ぶ）。lim i18n と同じ数え方。
 * パックに訳が無ければ、遊ぶ側は本体の訳をパックの台本にも使うので、その行も並べる（alsoShown）。訳を持つパックの台本だけが使う訳も残す（alsoUsedBy）。
 */
function translationSources(ws: StudioWorkspace, language: string): TranslationSources {
  const scope = packTranslationScope(parsePacks(listPackSources(ws.project.root), ws.castFile.speakers), language);
  return { registry: ws.commands, project: ws.readConfig(), data: ws.dataTexts(), ...(uiStrings ? { ui: uiStrings } : {}), ...(scope.alsoShown.length > 0 ? { alsoShown: scope.alsoShown } : {}), ...(scope.alsoUsedBy.length > 0 ? { alsoUsedBy: scope.alsoUsedBy } : {}) };
}

/** 訳の受け渡し（表と XLIFF）に書く、項目の場所と前後の行。 */
export function translationContext(ws: StudioWorkspace): ExchangeContext {
  return exchangeContext(scriptMap(ws), ws.commands);
}

/** liminalia.json の並び（languages・plugins）の hash。書くときの baseHash に返す。 */
export function configListHash(ws: StudioWorkspace, key: "languages" | "plugins"): string {
  const raw = JSON.parse(readFileSync(join(ws.project.root, "liminalia.json"), "utf8")) as Record<string, unknown>;
  return configPartHash(raw[key] ?? []);
}

/**
 * その言語の訳（今の台本に合わせたもの。新しい行は訳を空で足し、使われなくなった訳は引き継ぐか取っておく。書くのは writeTranslation）。
 * where は鍵 → 台本の場所。
 */
export function readTranslation(ws: StudioWorkspace, language: string): TranslationView {
  checkLanguage(language);
  const scripts = scriptMap(ws);
  const existing = readTranslationFile(ws, language);
  const r = updateTranslation(existing, language, scripts, ws.castFile.speakers, translationSources(ws, language));
  const where: TranslationView["where"] = {};
  for (const [file, script] of scripts) for (const t of collectTranslatable(script, ws.commands)) where[t.key] ??= { file, line: t.line };
  const path = translationPath(ws, language);
  const hash = existsSync(path) ? hashText(readFileSync(path, "utf8")) : null;
  return { file: r.file, where, outdated: JSON.stringify(r.file) !== JSON.stringify(existing), hash };
}

/**
 * その言語の訳を書く（paths.lang の <言語>.json）。前の内容は変更履歴（.liminalia/history/@lang/<言語>/）に残す。
 * baseHash（読んだときの TranslationView.hash。無かったファイルは null）を渡したときは、読んだあとにほかで変わっていれば書かずに今の訳を返す。
 */
export function writeTranslation(ws: StudioWorkspace, language: string, file: TranslationFile, baseHash?: string | null): PartWrite<TranslationView> {
  checkLanguage(language);
  if (!file || typeof file !== "object" || (file.lines !== undefined && typeof file.lines !== "object")) throw new StudioError(400, "翻訳ファイルの形式ではありません");
  const path = translationPath(ws, language);
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  const currentHash = current === null ? null : hashText(current);
  if (baseHash !== undefined && baseHash !== currentHash) {
    const view = readTranslation(ws, language);
    return { ok: false, current: { value: view, hash: view.hash } };
  }
  const text = `${JSON.stringify({ ...file, language }, null, 2)}\n`;
  if (text !== current) {
    if (current !== null) keepVersion(join(ws.project.root, HISTORY_DIR, "@lang", language), ".json", current);
    writeAtomic(path, text);
  }
  return { ok: true, hash: hashText(text) };
}

/**
 * 遊べる言語（liminalia.json の languages。先頭が原文の言語）を書く。前の内容は変更履歴に残す。
 * baseHash（読んだときの TranslationStatus.hash）を渡したときは、読んだあとにほかで変わっていれば書かずに今の並びを返す。
 */
export function setLanguages(ws: StudioWorkspace, languages: string[], baseHash?: string): PartWrite<string[]> {
  for (const l of languages) checkLanguage(l);
  if (new Set(languages).size !== languages.length) throw new StudioError(400, "同じ言語が重複しています");
  return updateConfigPart(ws, (raw) => (raw.languages ?? []) as string[], baseHash, (raw) => {
    // 原文の言語だけでも残す（英語だけの作品は、システム画面を英語で出す）。空と、書かないときと同じ日本語だけは書かない
    if (languages.length === 0 || (languages.length === 1 && languages[0] === "ja")) delete raw.languages;
    else raw.languages = languages;
  });
}

function checkLanguage(language: string): void {
  if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(language)) throw new StudioError(400, `言語コードとして使えません: ${language}（"en"、"zh-Hans" など）`);
}

/**
 * 名前の変更に合わせて書き換える訳のファイルと voice-lock.json を読む。読めなければ止める（呼ぶ側の withRollback が書いたものを戻す）。
 * 飛ばして続けると、そのファイルだけ古い名前の鍵のまま残り、訳やボイスの番号が黙って使われなくなる。
 */
function readForRename<T>(path: string, shown: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    throw new StudioError(400, `${shown} を読めないので、名前の変更に合わせて書き換えられません。${shown} を直してから、もう一度変更してください（${e instanceof Error ? e.message : String(e)}）`);
  }
}

/** 訳の鍵（"ファイル:…"）のファイルの部分を書き換える（台本の名前を変えたとき。訳はそのまま使われ続ける）。 */
function renameTranslationKeys(ws: StudioWorkspace, from: string, to: string, remember: Remember): void {
  const dir = ws.project.paths.lang;
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const path = join(dir, f);
    const file = readForRename<TranslationFile>(path, `lang/${f}`);
    const next = renameTranslationFileKeys(file, from, to);
    if (JSON.stringify(next) !== JSON.stringify(file)) writeTextUndoable(path, `${JSON.stringify(next, null, 2)}\n`, `lang/${f}`, remember);
  }
}

/** voice-lock.json の鍵（"ファイル:v…"）のファイルの部分を書き換える（台本の名前を変えたとき。番号はそのまま）。 */
function renameVoiceLockFile(ws: StudioWorkspace, from: string, to: string, remember: Remember): void {
  const path = ws.project.paths.voiceLock;
  if (!existsSync(path)) return;
  const lock = readForRename<VoiceLock>(path, "voice-lock.json");
  const next = renameVoiceLockFileKeys(lock, from, to);
  if (JSON.stringify(next) !== JSON.stringify(lock)) writeTextUndoable(path, `${JSON.stringify(next, null, 2)}\n`, "voice-lock.json", remember);
}

function translationPath(ws: StudioWorkspace, language: string): string {
  return join(ws.project.paths.lang, `${language}.json`);
}

function readTranslationFile(ws: StudioWorkspace, language: string): TranslationFile | null {
  const path = translationPath(ws, language);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as TranslationFile;
  } catch {
    throw new StudioError(400, `${language}.json を JSON として読み込めません`);
  }
}

function scriptMap(ws: StudioWorkspace): Map<string, Script> {
  return new Map(ws.files().map((f) => [f, ws.script(f).script] as const));
}

// ---- ゲームの設定 ----

/** ゲームの見た目と操作の設定（liminalia.json の ui）を書く。空なら外す。形が誤っていれば書かない。baseHash は setSettings と同じ。 */
export function setUi(ws: StudioWorkspace, ui: unknown, baseHash?: string): PartWrite<UiConfig> {
  const problems = checkUi(ui);
  if (problems.length > 0) throw new StudioError(400, problems.map((p) => p.message).join("\n"));
  return updateConfigPart(ws, (raw) => (raw.ui ?? {}) as UiConfig, baseHash, (raw) => {
    if (!ui || Object.keys(ui as object).length === 0) delete raw.ui;
    else raw.ui = ui;
  });
}

/**
 * 部品の欄と CSS の欄が書く作品の CSS のファイル（ui.css の一つ目。無ければ ui/screens.css を作って ui.css に足す）と、その中身（無ければ空）。
 * assets は素材のフォルダの作品のフォルダからのパス（作品の外に置いていれば省く）。CSS の欄が保存する前の中身を見本へ送るとき、url() を /assets/ に直すのに使う。
 */
export function readUiCss(ws: StudioWorkspace): { file: string; text: string; assets?: string } {
  const file = uiCssFiles(ws.readUi())[0] ?? UI_CSS_DEFAULT;
  const path = join(ws.project.root, ...file.split("/"));
  const assets = relative(ws.project.root, ws.project.paths.assets).split(sep).join("/");
  const inside = assets !== "" && !assets.startsWith("..") && !/^[a-z]:|^\//i.test(assets);
  return { file, text: existsSync(path) && statSync(path).isFile() ? readFileSync(path, "utf8") : "", ...(inside ? { assets } : {}) };
}

/** 作品の CSS のファイルを書き、ui.css に無ければ足す手順（⌘Z で戻す控え）。中身が同じでファイルもあれば何もしない。 */
function writeUiCssSteps(ws: StudioWorkspace, file: string, before: string, text: string): Step[] {
  const path = join(ws.project.root, ...file.split("/"));
  const existed = existsSync(path);
  const steps: Step[] = [];
  if (text !== before || !existed) {
    if (existed) {
      steps.push(textStep(file, path, before, text));
      writeAtomic(path, text);
    } else steps.push(...putFile(ws.journals, file, path, text, ws.project.root));
  }
  // ui.css に無ければ足す（ほかの項目と並びは保つ）
  if (!uiCssFiles(ws.readUi()).includes(file)) {
    const configBefore = readFileSync(join(ws.project.root, "liminalia.json"), "utf8");
    updateConfig(ws, (raw) => {
      const ui = (raw.ui && typeof raw.ui === "object" ? raw.ui : {}) as Record<string, unknown>;
      raw.ui = { ...ui, css: [...(Array.isArray(ui.css) ? ui.css : []), file] };
    });
    steps.push(configStep(ws, configBefore));
  }
  return steps;
}

/**
 * ゲームの画面のタブの CSS の欄から、作品の CSS のファイル（readUiCss のファイル）を丸ごと書く。before は読んだときの中身、file は読んだときの
 * ファイル（省ける）で、ほかで変わっていれば（ui.css の一つ目が別のファイルに替わったときも）書かずに今の中身を返す（ok: false）。
 * ⌘Z で戻す控え（undo）も返す（CSS のファイルと、足したときの liminalia.json）。
 */
export function writeUiCss(ws: StudioWorkspace, text: unknown, before: unknown, file?: unknown): { ok: true; file: string; text: string; undo?: string } | { ok: false; file: string; text: string } {
  if (typeof text !== "string" || typeof before !== "string") throw new StudioError(400, "text と before（読んだときの中身）を送ってください");
  const current = readUiCss(ws);
  if (current.text !== before || (typeof file === "string" && file !== current.file)) return { ok: false, file: current.file, text: current.text };
  const undo = ws.journals.add(writeUiCssSteps(ws, current.file, current.text, text));
  return { ok: true, file: current.file, text, ...(undo ? { undo } : {}) };
}

/**
 * 部品の欄から作品の CSS に「セレクタ { 性質: 値; }」の行を書く（同じセレクタと性質の一行があれば書き換え、値が無ければ消す。@liminalia/lang の setCssRules）。
 * 書く先は ui.css の一つ目。無ければ ui/screens.css を作り、ui.css に足す。⌘Z で戻す控え（undo）も返す（CSS のファイルと liminalia.json）。
 */
export function setUiCssRules(ws: StudioWorkspace, edits: unknown): { file: string; text: string; undo?: string } {
  if (!Array.isArray(edits) || edits.length === 0) throw new StudioError(400, "edits（selector、property、value の並び）を送ってください");
  const list: CssRuleEdit[] = [];
  for (const e of edits as unknown[]) {
    const o = e as Partial<CssRuleEdit> | null;
    const ok = !!o && typeof o.selector === "string" && o.selector.trim() !== "" && !/[{}]/.test(o.selector) && typeof o.property === "string" && /^-?[a-z][a-z0-9-]*$/.test(o.property) && (o.value === undefined || o.value === null || (typeof o.value === "string" && !/[{};]/.test(o.value)));
    if (!ok) throw new StudioError(400, "edits の形が誤っています（値に波括弧とセミコロンは書けません）");
    list.push({ selector: o.selector!, property: o.property!, value: typeof o.value === "string" && o.value.trim() !== "" ? o.value : undefined });
  }
  const { file, text: before } = readUiCss(ws);
  const text = setCssRules(before, list);
  const undo = ws.journals.add(writeUiCssSteps(ws, file, before, text));
  return { file, text, ...(undo ? { undo } : {}) };
}

/** テーマを当てる。素材を作品へ写し、当てたあとの ui を書いて返す。 */
export function applyTheme(ws: StudioWorkspace, id: string): UiConfig {
  return applyThemeUndoable(ws, id).ui;
}

/**
 * テーマを当て、⌘Z で戻すための控え（undo）も返す。控えには、写した素材、liminalia.json の ui、ごみ箱へ移した前のテーマの素材、
 * 片付けた空のフォルダの手順が入る（戻すと、素材も設定も当てる前と同じになる）。
 */
export function applyThemeUndoable(ws: StudioWorkspace, id: string): { ui: UiConfig; undo?: string } {
  const themes = listUiThemes(ws.project.root);
  const theme = themes.find((t) => t.id === id);
  if (!theme) throw new StudioError(404, `テーマがありません: ${id}`);
  if (!themeFitsScreen(theme, ws.project.screen)) throw new StudioError(400, `テーマ「${theme.name}」は縦長の作品専用です（この作品の画面は ${ws.project.screen.width}×${ws.project.screen.height}）`);
  const steps: Step[] = [];
  copyThemeAssets(ws, theme, steps);
  const ui = applyUiTheme(ws.readUi() ?? {}, theme, themes);
  const configPath = join(ws.project.root, "liminalia.json");
  const configBefore = readFileSync(configPath, "utf8");
  setUi(ws, ui);
  steps.push(configStep(ws, configBefore));
  ws.forgetAssets();
  // 用意されたテーマが写したままの、ほかで使われていない素材だけをごみ箱へ。
  // 作品が直した素材、独自テーマの素材、シナリオや別のテーマなどから参照される素材は残す。
  try {
    const root = join(ws.project.paths.assets, "image", "themes");
    const usage = assetUsage(ws);
    const sourceLines = new Map<string, string[]>();
    const unused: { kind: string; path: string }[] = [];
    for (const old of UI_THEMES) {
      if (old.id === theme.id) continue;
      const folder = join(root, old.id);
      if (!existsSync(folder) || !lstatSync(folder).isDirectory()) continue;
      for (const [name, content] of Object.entries(old.assets ?? {})) {
        const path = `themes/${old.id}/${name}`;
        const file = join(folder, name);
        const used = (usage[`image/${path}`] ?? []).some((use) => {
          if (use.in !== "text") return true;
          // 素材一覧用の曖昧な検索は @choice や JSON の "frame": にも一致する。
          // ここでは実際のパスか、名前そのものを値として書いた箇所だけを残す。
          const key = `${use.scenario ? "scenario" : "file"}:${use.where}`;
          let lines = sourceLines.get(key);
          if (!lines) {
            try { lines = (use.scenario ? ws.script(use.where).text : readFileSync(join(ws.project.root, use.where), "utf8")).split("\n"); }
            // 読めないファイルの使い方は、使っているものとみなす（消さない）
            catch { return true; }
            sourceLines.set(key, lines);
          }
          const line = lines[use.line - 1] ?? "";
          if (line.includes(path)) return true;
          const stem = name.replace(/\.[^.]+$/, "");
          return [...line.matchAll(/(["'])(.*?)\1(?!\s*:)/g)].some((m) => m[2] === name || m[2] === stem);
        });
        if (!used && existsSync(file) && lstatSync(file).isFile() && readFileSync(file, "utf8") === content) unused.push({ kind: "image", path });
      }
    }
    if (unused.length) steps.push(trashAssetsStep(ws, unused));
    for (const old of UI_THEMES) {
      if (old.id === theme.id) continue;
      const removed = removeEmptyDir(`image/themes/${old.id}`, join(root, old.id));
      if (removed) steps.push(removed);
    }
    const removedRoot = removeEmptyDir("image/themes", root);
    if (removedRoot) steps.push(removedRoot);
  } catch (e) {
    // 設定はすでに適用済み。整理に失敗しても、適用が失敗したようには見せない。
    console.warn("使っていないテーマ素材を整理できませんでした", e);
  }
  const undo = ws.journals.add(steps, () => ws.forgetAssets());
  return { ui, ...(undo ? { undo } : {}) };
}

/** テーマの素材を置く image の中のフォルダ（@liminalia/project の copyUiThemeAssets と同じ）。 */
const themeAssetDir = (id: string) => `themes/${id}`;

/** テーマの素材を作品の assets/image/themes/<テーマ> へ写し（@liminalia/project の copyUiThemeAssets と同じ）、⌘Z で戻す手順を足す。 */
function copyThemeAssets(ws: StudioWorkspace, theme: UiThemePreset, steps: Step[]): void {
  const top = join(ws.project.paths.assets, "image");
  const to = join(top, themeAssetDir(theme.id));
  for (const [name, content] of Object.entries(theme.assets ?? {})) steps.push(...putFile(ws.journals, `image/${themeAssetDir(theme.id)}/${name}`, join(to, name), content, top));
  const from = join(ws.project.root, "themes", theme.id, "assets");
  if (theme.local && existsSync(from)) {
    for (const f of filesUnder(from)) steps.push(...putFile(ws.journals, `image/${themeAssetDir(theme.id)}/${f}`, join(to, ...f.split("/")), readFileSync(join(from, ...f.split("/"))), top));
  }
}

// ---- 設定のファイルそのもの（元に戻すと変更履歴の欄。"@config" は liminalia.json、"@lang/<言語>" は訳） ----

/** 設定のファイルの場所と、その変更履歴の置き場。 */
function partFile(ws: StudioWorkspace, part: string): { path: string; history: string; lang: string | null } {
  if (part === "@config") return { path: join(ws.project.root, "liminalia.json"), history: join(ws.project.root, HISTORY_DIR, "@config"), lang: null };
  if (typeof part === "string" && part.startsWith("@lang/")) {
    const language = part.slice("@lang/".length);
    checkLanguage(language);
    return { path: translationPath(ws, language), history: join(ws.project.root, HISTORY_DIR, "@lang", language), lang: language };
  }
  throw new StudioError(400, `設定のファイルとして扱えません: ${String(part)}（"@config"、"@lang/en" など）`);
}

/** 設定のファイルの今の中身（無い訳のファイルは空の文字）。 */
export function readPartFile(ws: StudioWorkspace, part: PartFileName): FileText {
  const { path } = partFile(ws, part);
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  return { file: part, text, hash: hashText(text) };
}

/** 開発サーバーを起動し直さないと効かない項目（基本の項目とプラグイン。書き出しの設定は書き出すときに読む）。 */
const RESTART_KEYS = [...SETTINGS_KEYS.filter((k) => k !== "build" && k !== "check" && k !== "fmt"), "plugins"] as const;

/**
 * 設定のファイルを text にする（元に戻す・変更履歴から戻す）。baseHash が今の中身の hash と違えば書かずに今の中身を返す。
 * 前の内容は変更履歴に残す。liminalia.json は JSON のオブジェクトでなければ書かず、書いたら作業場の変数を読み直す。
 * 訳を空の文字にするとファイルを外す（元に戻す前に無かったファイル）。
 */
export function writePartFile(ws: StudioWorkspace, part: PartFileName, text: string, baseHash: string): PartFileWrite {
  if (typeof text !== "string") throw new StudioError(400, "text を文字で送ってください");
  const { path, history, lang } = partFile(ws, part);
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (hashText(current ?? "") !== baseHash) return { ok: false, current: { file: part, text: current ?? "", hash: hashText(current ?? "") } };
  if (lang === null) {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new StudioError(400, `liminalia.json として読めません: ${(e as Error).message}`);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new StudioError(400, "liminalia.json はオブジェクトで書いてください");
    writeConfigText(ws, text);
    ws.variablesChanged();
    return { ok: true, hash: hashText(text), restart: restartNeeded(ws, raw as Record<string, unknown>) };
  }
  if (text !== "") {
    try {
      JSON.parse(text);
    } catch (e) {
      throw new StudioError(400, `翻訳ファイルとして読めません: ${(e as Error).message}`);
    }
  }
  if (text !== (current ?? "")) {
    if (current !== null) keepVersion(history, ".json", current);
    if (text === "") rmSync(path, { force: true });
    else writeAtomic(path, text);
  }
  return { ok: true, hash: hashText(text), restart: false };
}

/** 設定のファイルの変更履歴（書き換える前の内容。新しい順）。 */
export function partHistory(ws: StudioWorkspace, part: PartFileName): HistoryEntry[] {
  return listVersions(partFile(ws, part).history, ".json").map((v) => ({ id: v.id, time: new Date(v.time).toISOString(), bytes: v.bytes }));
}

/** 設定のファイルの変更履歴の一つ（id が "current" なら今の中身）。 */
export function partHistoryItem(ws: StudioWorkspace, part: PartFileName, id: string): FileText {
  if (id === "current") return readPartFile(ws, part);
  if (!/^[0-9]{8}-[0-9]{6}-[0-9]{3}(-[0-9]+)?$/.test(id)) throw new StudioError(400, `変更履歴の ID として使えません: ${id}`);
  const path = join(partFile(ws, part).history, `${id}.json`);
  if (!existsSync(path)) throw new StudioError(404, `${part} の変更履歴 ${id} はありません`);
  const text = readFileSync(path, "utf8");
  return { file: part, text, hash: hashText(text) };
}

// ---- キャラクター ----

/** キャスト名・話者名を使っている場所と、差分ごとの使った回数。 */
export function castUsage(ws: StudioWorkspace): CastUsage {
  const cast: CastUsage["cast"] = {};
  const speakers: CastUsage["speakers"] = {};
  const variants: NonNullable<CastUsage["variants"]> = {};
  const entries = ws.castFile.cast as Cast;
  for (const file of ws.files()) {
    visit(ws.script(file).script.body, (s) => {
      if (s.kind === "say") speakers[s.speaker] = (speakers[s.speaker] ?? 0) + 1;
      if (s.kind !== "command") return;
      const args = castArgs(ws, s);
      for (const a of args) (cast[a.who] ??= []).push({ file, line: s.line });
      const who = args[0]?.who;
      const entry = who === undefined ? undefined : entries[who];
      const shown = entry ? variantArg(ws, s) : null;
      if (!entry || !shown) return;
      const named = shown.appearance && entry.appearances[shown.appearance] ? shown.appearance : null;
      const appearance = named ?? (entry.appearances[appearanceKey(entry)]?.variants[shown.variant] ? appearanceKey(entry) : Object.keys(entry.appearances).find((k) => entry.appearances[k]!.variants[shown.variant]));
      if (appearance === undefined || !entry.appearances[appearance]?.variants[shown.variant]) return;
      const table = ((variants[who!] ??= {})[appearance] ??= {});
      table[shown.variant] = (table[shown.variant] ?? 0) + 1;
    });
  }
  return { cast, speakers, variants };
}

/** その命令に字面で書いた差分と立ち絵セット（差分の型の引数が無ければ null）。 */
function variantArg(ws: StudioWorkspace, s: Extract<Statement, { kind: "command" }>): { variant: string; appearance: string | null } | null {
  const spec = ws.commands.get(s.name);
  if (!spec) return null;
  let variant: string | null = null;
  let appearance: string | null = null;
  let pos = 0;
  for (const a of normalizeBooleanArgs(spec, s.args)) {
    const key = a.key ?? spec.positional[pos++];
    const kind = key ? spec.params[key]?.type.kind : undefined;
    if (a.value.kind !== "string") continue;
    if (kind === "variant") variant ??= a.value.value;
    if (kind === "appearance") appearance ??= a.value.value;
  }
  return variant === null ? null : { variant, appearance };
}

// ---- cast.json の変更履歴（.liminalia/backups/cast-<日時>.json。立ち絵の位置調整画面と同じ置き場） ----

/** cast.json の変更履歴（書き換える前の内容。新しい順）。 */
export function castBackups(ws: StudioWorkspace): HistoryEntry[] {
  const dir = join(ws.project.root, BACKUP_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^cast-\d{8}-\d{6}-\d{3}\.json$/.test(f))
    .sort()
    .reverse()
    .map((f) => ({ id: f.slice(5, -5), time: stampTime(f.slice(5, -5)), bytes: statSync(join(dir, f)).size }));
}

/** 変更履歴の一つ（id は castBackups の id。"current" なら今の cast.json）の内容。 */
export function castBackup(ws: StudioWorkspace, id: string): FileText {
  const path = id === "current" ? ws.project.paths.cast : /^\d{8}-\d{6}-\d{3}$/.test(id) ? join(ws.project.root, BACKUP_DIR, `cast-${id}.json`) : null;
  if (!path || !existsSync(path)) throw new StudioError(404, `cast.json の変更履歴 ${id} がありません`);
  const text = readFileSync(path, "utf8");
  return { file: "cast.json", text, hash: hashText(text) };
}

/** 20260101-093000-123（stamp の形。手元の時刻）を ISO 8601 に。 */
function stampTime(id: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})$/.exec(id)!;
  const [y, mo, d, hh, mi, ss, ms] = m.slice(1).map(Number) as [number, number, number, number, number, number, number];
  return new Date(y, mo - 1, d, hh, mi, ss, ms).toISOString();
}

/**
 * キャスト名・話者名を変える。台本の参照（キャスト型の引数・話者の行の頭）と cast.json を書き換える。名前を持つほかの場所も追従させる:
 * - キャスト名: 顔の切り出し（.liminalia/studio.json の faces）と覚え書き（castNotes）、システムボイスの担当（ui.systemVoice の character）
 * - 話者名: 訳の話者名（lang/<言語>.json の speakers と、訳す人に見せる speaker）、voice-lock.json（鍵が話者と原文から作られるので付け替える）
 * 途中で書けなくなったら、書き終えたものを元に戻す。
 */
export function renameCast(ws: StudioWorkspace, req: CastRenameRequest): CastRenameResult {
  const { from, to } = req;
  if (castNameProblem(to)) throw new StudioError(400, `名前として使えません: ${to}`);
  if (from === to) return { files: [], lines: 0 };
  const current = ws.castFile;
  if (req.kind === "cast") {
    if (!(from in current.cast)) throw new StudioError(404, `キャラクター ${from} がありません`);
    if (to in current.cast) throw new StudioError(409, `キャラクター ${to} はすでにあります`);
  }
  // ID と一緒に表示名も変えるとき（speakerToo）も、表示名の変更を先に確かめる（片方だけ変わって止まらないように）
  if (req.kind === "speaker" || req.speakerToo) {
    const known = current.speakers.includes(from) || Object.values(current.cast as Cast).some((c) => c.speaker === from);
    if (!known) throw new StudioError(404, `話者 ${from} がありません`);
    if (current.speakers.includes(to)) throw new StudioError(409, `話者 ${to} はすでにあります`);
  }
  refuseNotUtf8(ws);

  let undo: string | null = null;
  const out = withRollback(RENAME_FAILED, (remember) => {
    const first = renameCastIn(ws, req.kind, from, to, remember);
    if (req.kind !== "cast" || !req.speakerToo) return first;
    // 表示名も同じ名前に（一つの操作として ⌘Z で戻す）
    const second = renameCastIn(ws, "speaker", from, to, remember);
    return {
      files: [...new Set([...first.files, ...second.files])],
      lines: first.lines + second.lines,
      ...(first.data || second.data ? { data: [...new Set([...(first.data ?? []), ...(second.data ?? [])])] } : {}),
      ...(first.tests || second.tests ? { tests: second.tests ?? first.tests! } : {}),
    };
  }, (steps) => (undo = steps ? ws.journals.add(steps) : null));
  return undo ? { ...out, undo } : out;
}

/** キャラクター ID か表示名を変える書き換え（renameCast の中身。書いたものは remember で控える）。 */
function renameCastIn(ws: StudioWorkspace, kind: "cast" | "speaker", from: string, to: string, remember: Remember): CastRenameResult {
  const before = scriptMap(ws);
  const specOf = specLookup(ws, before.values());
  const req = { kind, from, to };
  const files: string[] = [];
  let count = 0;
  for (const file of ws.files()) {
    const { text, hash, script } = ws.script(file);
    const r = req.kind === "cast" ? rewriteCastInScript(text, script, specOf, from, to) : rewriteSpeakerInScript(text, script, from, to);
    if (r.changed.length === 0) continue;
    writeScriptUndoable(ws, file, r.text, hash, text, remember);
    files.push(file);
    count += r.changed.length;
  }

  updateCastUndoable(
    ws,
    (c, file) => {
      renameInCast(c, file, req.kind, from, to);
      return true;
    },
    true,
    remember,
  );

  if (req.kind === "cast") {
    // 本文の中の {@chara …} を書き換えた行は、原文から作る訳の鍵が変わる
    followLineKeys(ws, before, (t) => t, remember);
    updateStudioStateUndoable(ws, (st) => renameStateCast(st, from, to), remember);
    updateConfigUndoable(ws, (raw) => (rewriteConfigCast(raw, from, to) ? undefined : false), remember);
  } else {
    renameTranslationSpeaker(ws, from, to, remember);
    // 台詞の鍵は話者と原文から作るので、voice-lock.json の番号を新しい鍵へ付け替え、話者も書き換える
    moveVoiceLockKeys(ws, before, scriptMap(ws), remember);
    const path = ws.project.paths.voiceLock;
    if (existsSync(path)) {
      let lock: VoiceLock | null = null;
      try {
        lock = JSON.parse(readFileSync(path, "utf8")) as VoiceLock;
      } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
      }
      if (lock) writeTextUndoable(path, `${JSON.stringify(renameVoiceLockSpeaker(lock, from, to), null, 2)}\n`, "voice-lock.json", remember);
    }
  }
  const data = req.kind === "cast" ? renameInDeclaredData(ws, { kind: "cast", from, to }, remember) : [];
  // 台本のテストで、ページの話者と比べる expect text（キャラクター ID はテストに出ない。話者名をそのまま保つ）
  const tests = req.kind === "speaker" ? renameInTests(ws, { kind: "speaker", from, to }, remember) : undefined;
  return { files, lines: count, ...(data.length > 0 ? { data } : {}), ...(tests ? { tests } : {}) };
}

/** 訳の話者名の表（speakers）の鍵と、訳す人に見せる話者（speaker）を替える。 */
function renameTranslationSpeaker(ws: StudioWorkspace, from: string, to: string, remember: Remember): void {
  const dir = ws.project.paths.lang;
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const path = join(dir, f);
    const file = readForRename<TranslationFile>(path, `lang/${f}`);
    const next = renameTranslationSpeakerIn(file, from, to);
    if (JSON.stringify(next) !== JSON.stringify(file)) writeTextUndoable(path, `${JSON.stringify(next, null, 2)}\n`, `lang/${f}`, remember);
  }
}

/**
 * 台本を書き換えたあと、本文を書き換えた行の訳の鍵と voice-lock.json の鍵を、同じ行の新しい鍵へ付け替える（行の数を変えない書き換えのあと）。
 * rewrite は訳文の書き換え（訳文の中の同じ名前も替える）。
 */
function followLineKeys(ws: StudioWorkspace, before: ReadonlyMap<string, Script>, rewrite: (text: string) => string, remember: Remember): void {
  const after = scriptMap(ws);
  const moves = translationMoves(before, after);
  const dir = ws.project.paths.lang;
  if (moves.size > 0 && existsSync(dir)) {
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const path = join(dir, f);
      const file = readForRename<TranslationFile>(path, `lang/${f}`);
      const next = moveTranslationEntries(file, moves, rewrite);
      if (next) writeTextUndoable(path, `${JSON.stringify(next, null, 2)}\n`, `lang/${f}`, remember);
    }
  }
  moveVoiceLockKeys(ws, before, after, remember);
}

/** その命令のキャスト型の引数（文字列で書いたもの）。 */
function castArgs(ws: StudioWorkspace, s: Extract<Statement, { kind: "command" }>): { who: string; column: number }[] {
  const spec = ws.commands.get(s.name);
  if (!spec) return [];
  const out: { who: string; column: number }[] = [];
  let pos = 0;
  for (const a of normalizeBooleanArgs(spec, s.args)) {
    const key = a.key ?? spec.positional[pos++];
    if (key && spec.params[key]?.type.kind === "cast" && a.value.kind === "string") out.push({ who: a.value.value, column: a.column });
  }
  return out;
}

function visit(body: Statement[], fn: (s: Statement) => void): void {
  for (const s of body) {
    fn(s);
    if (s.kind === "if") for (const b of s.branches) visit(b.body, fn);
    if (s.kind === "define") visit(s.body, fn);
  }
}
export { visit as visitStatements };

/**
 * cast.json を書き換える。mutate が true を返したときだけ、前の版を残して書く。speakers も書き換えるなら withSpeakers。
 * 書いたら作業場のキャストを読み直す（見張りの知らせを待たない）。
 */
function updateCast(ws: StudioWorkspace, mutate: (cast: Cast, file: { speakers: string[] }) => boolean, withSpeakers = false): boolean {
  const path = ws.project.paths.cast;
  const raw = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
  const cast = structuredClone((raw.cast ?? {}) as Cast);
  const file = { speakers: [...((raw.speakers as string[] | undefined) ?? [])] };
  if (!mutate(cast, file)) return false;
  const problems = castProblems(cast);
  if (problems.length > 0) throw new StudioError(400, `キャラクターの設定に誤りがあります: ${problems.map((p) => p.message).join("\n")}`);
  if (existsSync(path)) backup(ws, path);
  writeAtomic(path, JSON.stringify({ ...raw, ...(withSpeakers ? { speakers: file.speakers } : {}), cast }, null, 2) + "\n");
  ws.changed(path);
  return true;
}

function backup(ws: StudioWorkspace, path: string): void {
  const dir = join(ws.project.root, BACKUP_DIR);
  mkdirSync(dir, { recursive: true });
  copyFileSync(path, join(dir, `cast-${versionStamp(new Date())}.json`));
  const old = readdirSync(dir)
    .filter((f) => f.startsWith("cast-") && f.endsWith(".json"))
    .sort()
    .reverse()
    .slice(BACKUP_KEEP);
  for (const f of old) rmSync(join(dir, f), { force: true });
}

// ---- 名前の変更の書き込み（途中で書けなくなったら元に戻す。./undo.ts） ----

const RENAME_FAILED = "名前を変更できませんでした。素材やシナリオのフォルダ、.liminalia に書き込めるか確認してください。";

/** シナリオを書き込み口で書き（変更履歴に残る）、元の内容へ書き戻す手順を控える。 */
function writeScriptUndoable(ws: StudioWorkspace, file: string, text: string, hash: string, original: string, remember: Remember): void {
  const w = ws.write(file, text, hash, false);
  if (!w.ok) throw new StudioError(409, `${file}.lim がほかで変更されたため、保存できませんでした`);
  const now = () => (existsSync(ws.path(file)) ? ws.fileText(file) : null);
  // 書き込み口で書く（変更履歴に残り、開いている画面に知らせる）
  const put = (to: string) => {
    const r = ws.write(file, to, now()?.hash ?? null, false);
    if (!r.ok) throw new StudioError(409, `${file}.lim がほかで変更されました`);
  };
  remember(`${file}.lim`, () => put(original), { key: ws.path(file), redo: () => put(text), isAfter: () => now()?.text === text, isBefore: () => now()?.text === original });
}

/** ファイルを text にし（同じなら書かない）、前の内容へ戻す手順を控える。 */
function writeTextUndoable(path: string, text: string, name: string, remember: Remember): void {
  const before = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (before === text) return;
  writeAtomic(path, text);
  const step = textStep(name, path, before, text);
  remember(name, step.undo, step);
}

/** liminalia.json を書き換え（updateConfig）、前の内容へ戻す手順を控える（戻すのも変更履歴を通す）。書いたら true。 */
function updateConfigUndoable(ws: StudioWorkspace, mutate: (raw: Record<string, unknown>) => void | false, remember: Remember): boolean {
  const path = join(ws.project.root, "liminalia.json");
  const before = readFileSync(path, "utf8");
  updateConfig(ws, mutate);
  const after = readFileSync(path, "utf8");
  if (after === before) return false;
  const step = configStep(ws, before);
  remember(
    "liminalia.json",
    () => {
      if (readFileSync(path, "utf8") !== after) throw new StudioError(409, "liminalia.json がほかで変更されました");
      step.undo();
    },
    step,
  );
  return true;
}

/** cast.json を書き換え（updateCast）、前の内容へ戻す手順を控える。書いたら true。 */
function updateCastUndoable(ws: StudioWorkspace, mutate: (cast: Cast, file: { speakers: string[] }) => boolean, withSpeakers: boolean, remember: Remember): boolean {
  const path = ws.project.paths.cast;
  const before = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (!updateCast(ws, mutate, withSpeakers)) return false;
  // 書いたら作業場のキャストを読み直す（見張りの知らせを待たない）
  const step = textStep("cast.json", path, before, readFileSync(path, "utf8"), (text) => {
    writeOrRemove(path)(text);
    ws.changed(path);
  });
  remember("cast.json", step.undo, step);
  return true;
}

/**
 * 制作画面のデータ（.liminalia/studio.json と、共有するものの .liminalia/shared.json）を書き換え、前の内容へ戻す手順を控える。
 * mutate が null を返せば書かない。
 */
function updateStudioStateUndoable(ws: StudioWorkspace, mutate: (state: StudioState) => StudioState | null, remember: Remember): void {
  const state = readStudioState(ws.project);
  const next = mutate(structuredClone(state));
  if (!next || JSON.stringify(next) === JSON.stringify(state)) return;
  const files = [STUDIO_STATE_FILE, STUDIO_SHARED_FILE].map((name) => {
    const path = join(ws.project.root, name);
    return { name: name.split(sep).join("/"), path, before: existsSync(path) ? readFileSync(path, "utf8") : null };
  });
  writeStudioState(ws.project, next);
  for (const f of files) {
    const after = existsSync(f.path) ? readFileSync(f.path, "utf8") : null;
    if (after === f.before) continue;
    const step = textStep(f.name, f.path, f.before, after);
    remember(f.name, step.undo, step);
  }
}

// ---- パス ----

function kindRoot(ws: StudioWorkspace, kind: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(kind)) throw new StudioError(400, `素材の種類として使えない名前です: ${kind}`);
  return managedPath(ws.project.paths.assets, kind, "素材");
}

/** フォルダの中のファイル（相対パス、"/" 区切り）。 */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(dir, p).split(sep).join("/"));
    }
  };
  walk(dir);
  return out;
}
