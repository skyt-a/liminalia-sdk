import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { collectTranslatable, mediaKindOf, parse, SCRIPT_ASSET_FORMS, updateTranslation, type Diagnostic, type ScriptAssetForm, type TranslationFile } from "@liminalia/lang";
import { ASSET_TEXT_SOURCES, loadProject, type AssetTextSource } from "@liminalia/project";
import type { AssetUse } from "@liminalia/studio/protocol";
import type { TextEdit, WorkspaceEdit } from "vscode-languageserver";
import { URI } from "vscode-uri";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LimProject } from "../../vscode/src/model.ts";
import { buildInput, listAssets, loadCommands, readCastFile, readProjectInfo } from "../../vscode/src/project.ts";
import { renameFiles } from "../../vscode/src/rename-files.ts";
import { renameAssetEdit } from "../../vscode/src/rename.ts";
import { runCheck } from "../src/commands/check.ts";
import { loadContext } from "../src/context.ts";
import { runRename } from "../src/commands/rename.ts";
import { assetsToDropForBuild, findUnusedAssets } from "../src/commands/unused.ts";

/**
 * 素材を指す書き方の表。書き方ごとに、次の三つを確かめる。
 * - onlyUsed: 書き出しの「使っている素材だけ」（lim build --only-used）で外さない
 * - check: 素材が無いとき、lim check が知らせる（出る言葉）。知らせられない書き方は、その理由
 * - rename: lim rename asset が書き換える（書き換わるファイル）、書き換えられないので「手で直す所」に挙げる（left）、または対象外の理由。
 *   どの書き方も、VS Code の F2（素材の名前の変更）が lim rename asset と同じファイルを同じ中身に書き換え、同じ所を手で直す所に挙げることを確かめる
 *
 * 台本の書き方（@liminalia/lang の SCRIPT_ASSET_FORMS）と、名前を文字として探す所（@liminalia/project の ASSET_TEXT_SOURCES）は、
 * 表を Record にしているので、足したのに表に足さないと型で落ちる（下の「一覧と表が合う」でも落ちる）。
 * 式で組み立てる名前、連番、濁点の分かれた名前など、どちらの一覧にも入らない書き方は MORE に並べる。
 */

interface Row {
  /** 作品に書くファイル（作品のフォルダからのパス → 中身）。 */
  files: Record<string, string>;
  /** 使う素材（assets/ からのパス）。同じ名前の型で複数あれば並べる。 */
  assets: string[];
  /** liminalia.json に足すもの。 */
  config?: Record<string, unknown>;
  /** cast.json の cast に足す人物。 */
  cast?: Record<string, unknown>;
  check: string | { skip: string };
  rename: { file: string } | "left" | { skip: string };
  /** 作品の外に置くファイル（作品の隣のフォルダからのパス → 中身）。 */
  outside?: Record<string, string>;
}

const SCRIPT_FORMS: Record<ScriptAssetForm, Row> = {
  command: { files: { "scenario/forms.lim": "# a\n@bg forms_cmd.png\n" }, assets: ["bgimage/forms_cmd.png"], check: "missing-asset", rename: { file: "scenario/forms.lim" } },
  macro: { files: { "scenario/forms.lim": "@define show-bg(place: asset(bgimage))\n@bg (place)\n@end\n# a\n@show-bg place=forms_macro.png\n" }, assets: ["bgimage/forms_macro.png"], check: "missing-asset", rename: { file: "scenario/forms.lim" } },
  with: { files: { "scenario/forms.lim": "@define framed(place: asset(bgimage))\n@bg (place)\n@content\n@end\n# a\n@with framed place=forms_with.png\n　中身。\n@end\n" }, assets: ["bgimage/forms_with.png"], check: "missing-asset", rename: { file: "scenario/forms.lim" } },
  "inline-command": { files: { "scenario/forms.lim": "# a\n　ラジオが鳴る。{@se forms_inline.wav}そして止む。\n" }, assets: ["sound/forms_inline.wav"], check: "missing-asset", rename: { file: "scenario/forms.lim" } },
  "inline-image": { files: { "scenario/forms.lim": "# a\n　{img forms_icon.png}の印。\n" }, assets: ["image/forms_icon.png"], check: "missing-asset", rename: { file: "scenario/forms.lim" } },
  "html-image": { files: { "scenario/forms.lim": '# a\n@html card\n  <img src="forms_html.png">\n@end\n' }, assets: ["image/forms_html.png"], check: "missing-asset", rename: { file: "scenario/forms.lim" } },
  "staff-roll-image": { files: { "scenario/forms.lim": "# a\n@staff-roll time=3s\n# 制作\n  ユイ\n\n{img forms_staff.png 80}\n@end\n" }, assets: ["image/forms_staff.png"], check: "missing-asset", rename: { file: "scenario/forms.lim" } },
  "choice-image": { files: { "scenario/forms.lim": "# a\n@choice\n- 見る -> #a image=forms_choice.png\n@end\n" }, assets: ["image/forms_choice.png"], check: "missing-asset", rename: { file: "scenario/forms.lim" } },
};

const TEXT_ONLY = { skip: "名前を文字として持つだけで、どの命令が使うかは分からない" };
const STRUCTURED = { skip: "liminalia.json と cast.json は、素材の参照の項目を構文で書き換える（ほかの項目の同じ名前は、ほかのフォルダの素材のことが多いので挙げない）" };

const TEXT_SOURCES: Record<AssetTextSource, Row> = {
  scenario: { files: { "scenario/forms.lim": '# a\n@set game.pic = "forms_scn.png"\n' }, assets: ["image/forms_scn.png"], check: TEXT_ONLY, rename: "left" },
  data: { files: { "data/gallery.json": JSON.stringify({ pics: ["forms_data.png"] }) }, assets: ["image/forms_data.png"], check: TEXT_ONLY, rename: "left" },
  cast: { files: {}, cast: { フォーム: { model: { type: "sway", src: "forms_cast.png" } } }, assets: ["fgimage/forms_cast.png"], check: TEXT_ONLY, rename: STRUCTURED },
  config: { files: {}, config: { description: "forms_cfg.png を使う" }, assets: ["image/forms_cfg.png"], check: TEXT_ONLY, rename: STRUCTURED },
  "voice-lock": { files: { "voice-lock.json": JSON.stringify({ lines: { a: { file: "forms_vl.ogg" } } }) }, assets: ["voice/forms_vl.ogg"], check: TEXT_ONLY, rename: "left" },
  theme: { files: {}, config: { ui: { system: { preset: "forms" } } }, assets: ["image/themes/forms/forms_theme.png"], check: { skip: "選んだテーマが写した素材は、そのテーマが読む" }, rename: { skip: "テーマが写した素材の名前は替えない" } },
  css: { files: { "ui/screens.css": '.frame { background: url("../assets/image/forms_css.png"); }\n' }, config: { ui: { css: ["ui/screens.css"] } }, assets: ["image/forms_css.png"], check: "ui-css-asset", rename: { file: "ui/screens.css" } },
  template: {
    files: { "ui/screens/title/title.html": '<template data-part="logo"><img src="assets/image/forms_tpl.png"></template>\n' },
    config: { ui: { templates: { title: "ui/screens/title/title.html" } } },
    assets: ["image/forms_tpl.png"],
    check: { skip: "テンプレートの中の素材は描くときに読む（検査は形だけ）" },
    rename: "left",
  },
  pack: { files: { "packs/after/pack.json": JSON.stringify({ id: "after" }), "packs/after/scenario/after.lim": "@bg forms_pack.png\n" }, assets: ["bgimage/forms_pack.png"], check: { skip: "パックの台本は lim pack が確かめる" }, rename: "left" },
  translation: { files: { "lang/en.json": JSON.stringify({ assets: { "image/x.png": "forms_lang.png" } }) }, assets: ["image/forms_lang.png"], check: { skip: "訳の素材の差し替えは訳の検査が見る" }, rename: "left" },
  plugin: {
    files: {},
    outside: { "forms-plugin/package.json": JSON.stringify({ name: "forms-plugin", type: "module", exports: { "./studio": "./src/studio.ts" } }), "forms-plugin/src/studio.ts": 'export default { name: "forms", views: [] };\nexport const CORE = "live2d/forms_core.min.js";\n' },
    config: { plugins: ["../forms-plugin"] },
    assets: ["others/live2d/forms_core.min.js"],
    check: { skip: "プラグインが既定の名前で読む素材は、そのプラグインの検査が見る（live2d-no-core など）" },
    rename: "left",
  },
  model: { files: { "assets/fgimage/forms_m/forms_m.model3.json": JSON.stringify({ FileReferences: { Textures: ["forms_m.64/texture_00.png"] } }) }, assets: ["fgimage/forms_m/forms_m.64/texture_00.png"], check: { skip: "モデルの中身は描くときに読む" }, rename: "left" },
};

const EXPRESSION = { skip: "式で名前を組み立てるので、どの素材かは実行するまで分からない" };

/** どちらの一覧にも入らない書き方（式、連番、名前の一部、合成の違い、置き場所の違い）。 */
const MORE: Record<string, Row> = {
  "命令の行の引数（式）": { files: { "scenario/forms.lim": "# a\n@bg (game.place)\n" }, assets: ["bgimage/forms_expr.png"], check: EXPRESSION, rename: EXPRESSION },
  "本文の中の命令の引数（式）": { files: { "scenario/forms.lim": "# a\n　ラジオが鳴る。{@se (game.sound)}\n" }, assets: ["sound/forms_inline_expr.wav"], check: EXPRESSION, rename: EXPRESSION },
  "画像の選択肢（式）": { files: { "scenario/forms.lim": "# a\n@choice\n- 見る -> #a image=(game.pic)\n@end\n" }, assets: ["image/forms_choice_expr.png"], check: EXPRESSION, rename: EXPRESSION },
  "folder= を式で書いた命令": { files: { "scenario/forms.lim": "# a\n@cg-unlock forms_folder.png folder=(game.folder)\n" }, assets: ["fgimage/forms_folder.png"], check: EXPRESSION, rename: EXPRESSION },
  "式でつなぐ名前の一部": { files: { "scenario/forms.lim": '# a\n@set game.s = "forms_radio_" + game.n\n' }, assets: ["sound/forms_radio_1.wav", "sound/forms_radio_2.wav"], check: EXPRESSION, rename: EXPRESSION },
  "@flipbook の連番": { files: { "scenario/forms.lim": "# a\n@flipbook fx/forms_slash_{nn}.png frames=2\n" }, assets: ["image/fx/forms_slash_01.png", "image/fx/forms_slash_02.png"], check: "flipbook-missing", rename: { skip: "連番の一コマだけの名前を替えると連番が崩れる" } },
  "@flipbook の data=": {
    files: { "scenario/forms.lim": "# a\n@flipbook data=flips#slash\n", "data/flips.json": JSON.stringify({ slash: { image: "fx/forms_dslash_{nn}.png", frames: 2 } }) },
    assets: ["image/fx/forms_dslash_01.png", "image/fx/forms_dslash_02.png"],
    check: "flipbook-missing",
    rename: { skip: "連番の一コマだけの名前を替えると連番が崩れる" },
  },
  キャストの差分: { files: {}, cast: { フォーム: { defaultAppearance: "default", appearances: { default: { variants: { normal: { image: "forms_variant.png" } } } } } }, assets: ["fgimage/forms_variant.png"], check: "missing-asset", rename: { file: "cast.json" } },
  "liminalia.json の ui": { files: {}, config: { ui: { message: { image: "forms_window.png" } } }, assets: ["image/forms_window.png"], check: "missing-asset", rename: { file: "liminalia.json" } },
  "@html の <img src> の引用の中の、値の前の空白": { files: { "scenario/forms.lim": '# a\n@html card\n  <img src=" forms_html_space.png">\n@end\n' }, assets: ["image/forms_html_space.png"], check: "missing-asset", rename: { file: "scenario/forms.lim" } },
  "濁点の分かれた名前（NFD）": { files: { "scenario/forms.lim": `# a\n@bg ${"フォームガード.png".normalize("NFC")}\n` }, assets: [`bgimage/${"フォームガード.png".normalize("NFD")}`], check: "missing-asset", rename: { file: "scenario/forms.lim" } },
  "作品の node_modules に入れたプラグイン": {
    files: { "node_modules/forms-pkg/package.json": JSON.stringify({ name: "forms-pkg", type: "module", exports: { "./studio": "./src/studio.ts" } }), "node_modules/forms-pkg/src/studio.ts": 'export default { name: "forms-pkg", views: [] };\nexport const RUNTIME = "spine/forms_runtime.js";\n' },
    config: { plugins: ["./node_modules/forms-pkg"] },
    assets: ["others/spine/forms_runtime.js"],
    check: { skip: "プラグインが既定の名前で読む素材は、そのプラグインの検査が見る" },
    rename: "left",
  },
  "作品の直下に置いた画面のテンプレートの JS": {
    files: { "title.html": '<template data-part="logo"></template>\n', "title.js": 'export default () => "image/forms_root_js.png";\n' },
    config: { ui: { templates: { title: "title.html" } } },
    assets: ["image/forms_root_js.png"],
    check: { skip: "画面の JS の中の名前は描くときに使う" },
    rename: "left",
  },
};

/**
 * 素材の型（asset(フォルダ)）でなく文字の型で、素材やファイルの名前を受ける引数（標準の命令と公式のプラグイン）。
 * 構文では素材として数えられないので、どう扱うかをここに書く（命令を足して当てはまるものが増えたら、ここと上の表に足す）。
 */
const NAMES_AS_TEXT: Record<string, string> = {
  "flipbook.image": "連番の型。上の表の「@flipbook の連番」（文字として探す。check は標準のプラグインの flipbook-missing）",
  "voice-auto.pattern": "声の連番の型。声（voice/）は自動の連番で鳴らすので、--only-used で外さない",
  "staff-roll.file": "data フォルダの JSON。中の {img …} は上の表の data として文字で探す",
};

const ROOT = resolve(import.meta.dirname, "../../..");
const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
let base: string;
let dir: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "liminalia-forms-"));
  dir = join(base, "game");
  cpSync(TEMPLATE, dir, { recursive: true });
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function setUp(row: Row): void {
  for (const [path, text] of Object.entries(row.files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  for (const [path, text] of Object.entries(row.outside ?? {})) {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), text);
  }
  for (const a of row.assets) {
    mkdirSync(dirname(join(dir, "assets", a)), { recursive: true });
    writeFileSync(join(dir, "assets", a), Buffer.alloc(16));
  }
  const config = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ ...config, format: 4, ...row.config }, null, 2));
  if (row.cast) {
    const cast = JSON.parse(readFileSync(join(dir, "cast.json"), "utf8")) as { cast: Record<string, unknown> };
    writeFileSync(join(dir, "cast.json"), JSON.stringify({ ...cast, cast: { ...cast.cast, ...row.cast } }, null, 2));
  }
}

async function quiet<T>(run: () => Promise<T>): Promise<{ value: T; out: string }> {
  const lines: string[] = [];
  const keep = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(keep);
  vi.spyOn(console, "warn").mockImplementation(keep);
  vi.spyOn(console, "error").mockImplementation(keep);
  try {
    return { value: await run(), out: lines.join("\n") };
  } finally {
    vi.restoreAllMocks();
  }
}

async function diagnostics(): Promise<Diagnostic[]> {
  const { out } = await quiet(() => runCheck(dir, true));
  return (JSON.parse(out) as { diagnostics: Diagnostic[] }).diagnostics;
}

/** 素材のフォルダの中の、書き出しに入る種類のファイル（"フォルダ/パス"）。 */
function mediaFiles(): string[] {
  const out: string[] = [];
  const walk = (folder: string, sub: string) => {
    for (const e of readdirSync(join(dir, "assets", folder, sub), { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (e.isDirectory()) walk(folder, rel);
      else if (mediaKindOf(e.name)) out.push(`${folder}/${rel}`);
    }
  };
  for (const folder of ["bgimage", "fgimage", "image", "bgm", "sound", "voice", "video", "others"]) if (existsSync(join(dir, "assets", folder))) walk(folder, "");
  return out;
}

/** 制作画面の素材の「未使用だけ」に出るもの（使われ方が一つも無いもの）。 */
async function studioUnused(): Promise<string[]> {
  const server = await import("@liminalia/studio/server");
  const ws = await server.StudioWorkspace.open(loadProject(dir));
  const usage = server.assetUsage(ws);
  return mediaFiles().filter((key) => (usage[key] ?? []).length === 0);
}

/** 作品のファイルの中身（作品のフォルダからのパス → 中身。素材のファイルは名前だけ）。制作画面の控え（.liminalia/）は覚え書きの studio.json だけ。 */
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (sub: string) => {
    for (const e of readdirSync(join(root, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (rel === ".liminalia") {
        if (existsSync(join(root, rel, "studio.json"))) out.set(`${rel}/studio.json`, readFileSync(join(root, rel, "studio.json"), "utf8"));
        continue;
      }
      if (e.isDirectory()) walk(rel);
      else if (e.isFile()) out.set(rel, rel.startsWith("assets/") && mediaKindOf(e.name) ? "" : readFileSync(join(root, rel), "utf8"));
    }
  };
  walk("");
  return out;
}

/** 書き方の違い（JSON の字下げと末尾の改行、濁点の合成）を除いた中身。 */
function sameText(path: string, text: string | undefined): string | undefined {
  if (text === undefined || !/\.json$/i.test(path)) return text?.normalize("NFC");
  try {
    return JSON.stringify(JSON.parse(text)).normalize("NFC");
  } catch {
    return text.normalize("NFC");
  }
}

/** 中身に編集を当てる（後ろの編集から）。 */
function applyEdits(text: string, edits: readonly TextEdit[]): string {
  const lines = text.split("\n");
  const offset = (p: { line: number; character: number }) => lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
  return [...edits].sort((a, b) => offset(b.range.start) - offset(a.range.start)).reduce((t, e) => t.slice(0, offset(e.range.start)) + e.newText + t.slice(offset(e.range.end)), text);
}

/** 作品のファイルの中身に VS Code の編集（書き換えとファイルの名前の変更）を当てたもの。 */
function applyWorkspaceEdit(files: Map<string, string>, edit: WorkspaceEdit): Map<string, string> {
  const out = new Map(files);
  const rel = (uri: string) => relative(dir, URI.parse(uri).fsPath).split(sep).join("/");
  const textEdits: [string, readonly TextEdit[]][] = [...Object.entries(edit.changes ?? {})];
  const renames: { oldUri: string; newUri: string }[] = [];
  for (const c of edit.documentChanges ?? []) {
    if ("textDocument" in c) textEdits.push([c.textDocument.uri, c.edits as TextEdit[]]);
    else if (c.kind === "rename") renames.push(c);
  }
  for (const [uri, edits] of textEdits) {
    const path = rel(uri);
    const text = out.get(path);
    if (text === undefined) throw new Error(`VS Code の編集が無いファイルを指す: ${path}`);
    out.set(path, applyEdits(text, edits));
  }
  for (const r of renames) {
    const from = rel(r.oldUri);
    const text = out.get(from);
    if (text === undefined) throw new Error(`VS Code の名前の変更が無いファイルを指す: ${from}`);
    out.delete(from);
    out.set(rel(r.newUri), text);
  }
  return out;
}

/** VS Code の F2 の素材の名前の変更（言語サーバーと同じ読み方。開いているファイルは無い）。ディスクは変えない。 */
async function vscodeRenameAsset(folder: string, from: string, to: string): Promise<{ edit: WorkspaceEdit; left: AssetUse[] }> {
  const info = readProjectInfo(dir);
  const commands = await loadCommands(info, { trusted: true, workspaceFolders: [base], node: process.execPath });
  const { speakers, cast } = readCastFile(info.paths.cast);
  const textOf = (path: string) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  };
  const project = new LimProject(buildInput(info, { commands, speakers, cast }, textOf, (f) => listAssets(join(info.paths.assets, f))));
  const r = renameAssetEdit(project, folder, from, to, "ja", renameFiles(info, commands.data));
  if ("error" in r) throw new Error(r.error);
  return r;
}

const usesKey = (uses: readonly AssetUse[]) => uses.map((u) => JSON.stringify(u)).sort();

/**
 * VS Code の F2 で素材 asset の名前を変えたときと、lim rename asset（@liminalia/studio/server の renameAsset。作品の写しで流す）が、
 * 同じファイルを同じ中身に書き換え、同じ所を手で直す所に挙げる。
 */
async function sameAsLimRename(name: string, asset: string, renamed: string): Promise<{ files: Map<string, string>; left: AssetUse[] }> {
  const folder = asset.slice(0, asset.indexOf("/"));
  const from = asset.slice(folder.length + 1);
  const to = renamed.slice(folder.length + 1);
  const before = snapshot(dir);
  const vscode = await vscodeRenameAsset(folder, from, to);
  const copy = join(base, "lim-rename");
  cpSync(dir, copy, { recursive: true });
  const server = await import("@liminalia/studio/server");
  const { value: ws } = await quiet(() => server.StudioWorkspace.open(loadProject(copy)));
  const lim = server.renameAsset(ws, folder, from, to);
  const viaLim = snapshot(copy);
  const viaVscode = applyWorkspaceEdit(before, vscode.edit);
  const paths = [...new Set([...viaLim.keys(), ...viaVscode.keys()])].sort();
  const differ = paths.filter((p) => sameText(p, viaLim.get(p)) !== sameText(p, viaVscode.get(p)));
  const show = differ.map((p) => `${p}\n  lim rename asset: ${viaLim.get(p)?.slice(0, 400)}\n  VS Code: ${viaVscode.get(p)?.slice(0, 400)}`).join("\n");
  expect(differ, `${name}: VS Code の F2 と lim rename asset で書き換えが違う\n${show}`).toEqual([]);
  expect(usesKey(vscode.left), `${name}: VS Code の F2 と lim rename asset で手で直す所が違う`).toEqual(usesKey(lim.left));
  rmSync(copy, { recursive: true, force: true });
  return { files: viaLim, left: lim.left };
}

async function verify(name: string, row: Row): Promise<void> {
  setUp(row);
  // 使っている素材だけ: 外さない
  const { value: drop } = await quiet(() => assetsToDropForBuild(dir));
  expect(drop.drop.map((d) => d.path).filter((p) => row.assets.includes(p)), `${name}: --only-used`).toEqual([]);
  // 制作画面の「未使用だけ」と lim unused --all が同じものを出す
  const { value: unused } = await quiet(() => findUnusedAssets(dir, { all: true }));
  const { value: studio } = await quiet(() => studioUnused());
  expect(studio.sort(), `${name}: 制作画面の「未使用だけ」と lim unused`).toEqual(unused.unused.map((u) => u.path).sort());
  // lim check: 素材が無いと知らせる
  if (typeof row.check === "string") {
    const asset = row.assets[0]!;
    const aside = join(base, "aside");
    renameSync(join(dir, "assets", asset), aside);
    const found = (await diagnostics()).filter((d) => d.code === row.check);
    expect(found.length, `${name}: lim check の ${row.check}`).toBeGreaterThan(0);
    renameSync(aside, join(dir, "assets", asset));
  }
  // VS Code の F2 は、どの書き方でも lim rename asset と同じ所を書き換え、同じ所を手で直す所に挙げる（lim rename asset の対象外の書き方も、同じ結果になる）
  const asset = row.assets[0]!;
  const renamed = asset.replace(/(\.[^./]+)$/, "_renamed$1");
  await sameAsLimRename(name, asset, renamed);
  // lim rename asset: 書き換えるか、手で直す所に挙げる
  if (row.rename === "left" || "file" in row.rename) {
    const folder = asset.slice(0, asset.indexOf("/"));
    const { value: ok, out } = await quiet(() => runRename(dir, "asset", asset, renamed));
    expect(ok, `${name}: lim rename asset\n${out}`).toBe(true);
    expect(existsSync(join(dir, "assets", renamed))).toBe(true);
    if (row.rename === "left") expect(out, `${name}: 手で直す所\n${out}`).toMatch(/書き換えられなかった参照が \d+ か所/);
    else {
      const text = readFileSync(join(dir, row.rename.file), "utf8");
      const newName = renamed.slice(folder.length + 1).split("/").pop()!;
      expect(text.normalize("NFC"), `${name}: ${row.rename.file}\n${out}`).toContain(newName.normalize("NFC"));
      const oldName = asset.slice(folder.length + 1).split("/").pop()!;
      expect(text.normalize("NFC").includes(oldName.normalize("NFC")), `${name}: ${row.rename.file} に前の名前が残る`).toBe(false);
      expect(out, `${name}: 書き換えたのに手で直す所に挙げる\n${out}`).not.toMatch(/書き換えられなかった参照/);
    }
  }
}

describe("素材を指す書き方の表", () => {
  it("一覧と表が合う（書き方を足したら表にも足す）", () => {
    expect(Object.keys(SCRIPT_FORMS).sort()).toEqual([...SCRIPT_ASSET_FORMS].sort());
    expect(Object.keys(TEXT_SOURCES).sort()).toEqual([...ASSET_TEXT_SOURCES].sort());
  });

  it("素材やファイルの名前を文字の型で受ける引数は、扱い方を表に書いてある（標準の命令と公式のプラグイン）", async () => {
    const config = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ ...config, plugins: [join(ROOT, "plugins/live2d"), join(ROOT, "plugins/spine")] }));
    const { registry } = await loadContext(dir);
    const listed = Object.keys(NAMES_AS_TEXT);
    const found: string[] = [];
    const unlisted: string[] = [];
    for (const spec of registry.values()) {
      // folder= で探す場所を替えるのに、素材の型の引数が無い命令
      if (spec.params.folder && !Object.values(spec.params).some((p) => p.type.kind === "asset") && !listed.some((k) => k.startsWith(`${spec.name}.`))) unlisted.push(spec.name);
      // 説明がパスかファイルを受けると書く、文字の型の引数
      for (const [k, p] of Object.entries(spec.params)) if (p.type.kind === "string" && /パス|ファイル/.test(p.doc ?? "")) found.push(`${spec.name}.${k}`);
    }
    expect(unlisted).toEqual([]);
    expect([...new Set(found)].sort()).toEqual(listed.sort());
  }, 60_000);

  it("Live2D のモデルの中のファイル（.moc3、テクスチャ、物理、モーション、表情）は、制作画面でも使っているとみなす", async () => {
    const model = { Version: 3, FileReferences: { Moc: "forms_l2d.moc3", Textures: ["forms_l2d.64/texture_00.png"], Physics: "forms_l2d.physics3.json", Motions: { Idle: [{ File: "motions/forms_idle.motion3.json" }] }, Expressions: [{ Name: "smile", File: "expressions/forms_smile.exp3.json" }] } };
    const inner = ["forms_l2d.moc3", "forms_l2d.64/texture_00.png", "forms_l2d.physics3.json", "motions/forms_idle.motion3.json", "expressions/forms_smile.exp3.json"].map((f) => `fgimage/forms_l2d/${f}`);
    setUp({ files: { "assets/fgimage/forms_l2d/forms_l2d.model3.json": JSON.stringify(model) }, assets: inner, cast: { フォーム: { model: { type: "live2d", src: "forms_l2d/forms_l2d.model3.json" } } }, check: TEXT_ONLY, rename: TEXT_ONLY });
    const server = await import("@liminalia/studio/server");
    const { value: ws } = await quiet(() => server.StudioWorkspace.open(loadProject(dir)));
    const usage = server.assetUsage(ws);
    expect(inner.filter((key) => (usage[key] ?? []).length === 0)).toEqual([]);
    const { value: unused } = await quiet(() => findUnusedAssets(dir, { all: true }));
    expect(unused.unused.map((u) => u.path).filter((p) => p.startsWith("fgimage/forms_l2d/"))).toEqual([]);
  }, 60_000);

  it("訳文の中の本文の中の命令とマクロの引数も、VS Code の F2 が lim rename asset と同じに書き換える", async () => {
    const text = "@define ring(s: asset(sound))\n@se (s)\n@end\n# a\n　ラジオが鳴る。{@se forms_tr.wav}そして止む。\n@ring s=forms_tr.wav\n";
    setUp({ files: { "scenario/forms.lim": text }, assets: ["sound/forms_tr.wav"], check: TEXT_ONLY, rename: { file: "scenario/forms.lim" } });
    const script = parse(text, "forms", { speakers: [] });
    const made = updateTranslation(null, "en", new Map([["forms", script]]), []).file;
    const key = collectTranslatable(script).find((t) => t.line === 5)!.key;
    made.lines![key]!.text = "The radio plays.{@se forms_tr.wav} Then it stops.";
    mkdirSync(join(dir, "lang"), { recursive: true });
    writeFileSync(join(dir, "lang", "en.json"), JSON.stringify(made, null, 2));
    const { files, left } = await sameAsLimRename("訳文", "sound/forms_tr.wav", "sound/forms_tr_renamed.wav");
    expect(left).toEqual([]);
    const after = JSON.parse(files.get("lang/en.json")!) as TranslationFile;
    expect(Object.values(after.lines!).map((e) => e.text)).toContain("The radio plays.{@se forms_tr_renamed.wav} Then it stops.");
    expect(files.get("scenario/forms.lim")).toContain("@ring s=forms_tr_renamed.wav");
  }, 60_000);

  for (const [name, row] of Object.entries(SCRIPT_FORMS)) it(`台本: ${name}`, () => verify(name, row), 60_000);
  for (const [name, row] of Object.entries(TEXT_SOURCES)) it(`文字として探す所: ${name}`, () => verify(name, row), 60_000);
  for (const [name, row] of Object.entries(MORE)) it(`ほかの書き方: ${name}`, () => verify(name, row), 60_000);
});
