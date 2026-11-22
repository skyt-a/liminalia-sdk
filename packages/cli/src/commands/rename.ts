import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadProject, notUtf8Scenarios, ScenarioEncodingError } from "@liminalia/project";
import { assetUsePlace } from "@liminalia/studio/asset-rename";
import type { TestRenameResult } from "@liminalia/studio/protocol";

/**
 * lim rename [プロジェクト] <種類> <古い名前> <新しい名前> — 名前を変え、参照しているところも書き換える。
 * 制作画面の名前の変更と同じもの（@liminalia/studio/server の renameLabel・renameVariable・renameCast・renameAsset・renameScenario・renameMacro）を使い、
 * 台本の前の版は変更履歴（.liminalia/history/）に残る。途中で書けなくなったら、書き終えたものを元に戻す。
 *
 * | 種類 | 古い名前 | 新しい名前 |
 * |---|---|---|
 * | label | `ファイル#ラベル` | ラベルの名前 |
 * | file | シナリオの名前（`chapter1`、`part1/a`） | シナリオの名前 |
 * | variable | `game.x`（system.・temp. も） | `game.y` |
 * | character | キャラクター ID（cast.json の cast の鍵） | キャラクター ID |
 * | speaker | 話者名（cast.json の speakers） | 話者名 |
 * | asset | `種類/パス`（`bgimage/room.png`。フォルダも） | `種類/パス` か、同じ種類の中のパス |
 * | macro | マクロの名前（`@define` の名前） | マクロの名前 |
 */

export const RENAME_KINDS = ["label", "file", "variable", "character", "speaker", "asset", "macro"] as const;
export type RenameKind = (typeof RENAME_KINDS)[number];

type Lang = "ja" | "en";

const T = {
  unknownKind: { ja: (k: string) => `名前を変えられる種類は ${RENAME_KINDS.join("、")} です: ${k}`, en: (k: string) => `The kinds you can rename are ${RENAME_KINDS.join(", ")}: ${k}` },
  labelForm: { ja: (s: string) => `シーンは ファイル#ラベル の形で指定します: ${s}`, en: (s: string) => `Give the scene as file#label: ${s}` },
  assetForm: { ja: (s: string) => `素材は 種類/パス の形で指定します（bgimage/room.png など）: ${s}`, en: (s: string) => `Give the asset as kind/path (bgimage/room.png and so on): ${s}` },
  assetKind: { ja: (a: string, b: string) => `素材の種類は変えられません（${a} から ${b}）`, en: (a: string, b: string) => `The asset kind can't change (${a} to ${b})` },
  files: { ja: (n: number, list: string) => `書き換えたシナリオ: ${n} 件${list ? `（${list}）` : ""}`, en: (n: number, list: string) => `Rewrote ${n} ${n === 1 ? "script" : "scripts"}${list ? ` (${list})` : ""}` },
  noVariable: { ja: (v: string) => `変数 ${v} は台本と liminalia.json のどこにもありません`, en: (v: string) => `The variable ${v} isn't used in any script or in liminalia.json` },
  done: { ja: (a: string, b: string) => `${a} を ${b} に変更しました`, en: (a: string, b: string) => `Renamed ${a} to ${b}` },
  config: { ja: (list: string) => `liminalia.json も書き換えました（${list}）`, en: (list: string) => `Also rewrote liminalia.json (${list})` },
  entry: { ja: "「はじめから」のファイルだったので liminalia.json の entry も書き換えました", en: "It was the New Game file, so the entry in liminalia.json was rewritten too" },
  cast: { ja: "cast.json も書き換えました", en: "Also rewrote cast.json" },
  data: { ja: (list: string) => `作品のデータも書き換えました（${list}）`, en: (list: string) => `Also rewrote project data (${list})` },
  css: { ja: (list: string) => `作品の CSS も書き換えました（${list}）`, en: (list: string) => `Also rewrote the project's CSS (${list})` },
  assetLeft: {
    ja: (n: number) => `書き換えられなかった参照が ${n} か所あります（式に渡す文字、データ、訳、テンプレート、プラグインの中など）。手で直してください:`,
    en: (n: number) => `${n} ${n === 1 ? "reference" : "references"} couldn't be rewritten (text passed to expressions, data, translations, templates, plugins and so on). Fix them by hand:`,
  },
  translations: { ja: (list: string) => `翻訳キーを更新しました（${list}）`, en: (list: string) => `Moved translation keys (${list})` },
  left: { ja: (n: number) => `書き換えられなかった参照が ${n} か所あります（式で決まる飛び先、@script の中など）。手で直してください:`, en: (n: number) => `${n} ${n === 1 ? "reference" : "references"} couldn't be rewritten (targets set by expressions, inside @script and so on). Fix them by hand:` },
  tests: { ja: (list: string) => `テストも書き換えました（${list}）`, en: (list: string) => `Also rewrote tests (${list})` },
  testsLeft: {
    ja: (n: number) => `テストに書き換えられなかった所が ${n} か所あります（ファイルを省いた #ラベル のジャンプ先）。手で直してください:`,
    en: (n: number) => `${n} ${n === 1 ? "place" : "places"} in tests couldn't be rewritten (jump targets written as #label without the file). Fix them by hand:`,
  },
  chaptersLeft: { ja: "liminalia.json の chapters のワイルドカードが、新しい名前に当たらなくなります。手で直してください:", en: "Wildcards in chapters in liminalia.json won't match the new name. Fix them by hand:" },
};

export interface RenameOptions {
  lang?: Lang;
}

/** 名前を変える。変えられなければ理由を出して false。 */
export async function runRename(dir: string, kind: string, from: string, to: string, options: RenameOptions = {}): Promise<boolean> {
  const lang: Lang = options.lang ?? "ja";
  const server = await import("@liminalia/studio/server");
  const say = (text: string) => console.log(text);
  const fail = (text: string) => {
    console.error(lang === "en" ? server.englishServerText(text) : text);
    return false;
  };
  if (!(RENAME_KINDS as readonly string[]).includes(kind)) return fail(T.unknownKind[lang](kind));
  const project = loadProject(dir);
  // UTF-8 で読めない台本があれば、一つも書き換えない（化けた字面を書き戻さない。制作画面の名前の変更も同じ）
  const bad = notUtf8Scenarios(project.paths.scenario);
  if (bad.length > 0) return fail(new ScenarioEncodingError(bad, lang).message);
  const ws = await server.StudioWorkspace.open(project);
  const sep = lang === "en" ? ", " : "、";
  const reportFiles = (files: readonly string[]) => say(T.files[lang](files.length, files.join(sep)));
  /** 書き換えた台本のテストと、書き換えられなかった行。 */
  const reportTests = (tests: TestRenameResult | undefined) => {
    if (!tests) return;
    if (tests.files.length > 0) say(T.tests[lang](tests.files.join(sep)));
    if (tests.left.length > 0) {
      say(T.testsLeft[lang](tests.left.length));
      for (const l of tests.left) say(`  ${l.file}:${l.line}`);
    }
  };
  try {
    switch (kind as RenameKind) {
      case "label": {
        const hash = from.lastIndexOf("#");
        if (hash <= 0) return fail(T.labelForm[lang](from));
        const file = from.slice(0, hash).replace(/\.lim$/, "");
        const label = from.slice(hash + 1);
        const r = server.renameLabel(ws, file, label, to.replace(/^#/, ""));
        say(T.done[lang](`${file}#${label}`, `${file}#${to.replace(/^#/, "")}`));
        reportFiles(r.files);
        if (r.config.length > 0) say(T.config[lang](r.config.join(sep)));
        if (r.translations.length > 0) say(T.translations[lang](r.translations.join(sep)));
        if (r.data?.length) say(T.data[lang](r.data.join(sep)));
        reportTests(r.tests);
        if (r.left.length > 0) {
          say(T.left[lang](r.left.length));
          for (const l of r.left) say(`  ${l.config ? `liminalia.json ${l.config}` : `${l.file}.lim:${l.line}`}${lang === "en" ? ` (${l.reason})` : `（${l.reason}）`}`);
        }
        return true;
      }
      case "file": {
        const name = (s: string) => s.replace(/\\/g, "/").replace(/^scenario\//, "").replace(/\.lim$/, "");
        const r = server.renameScenario(ws, name(from), name(to));
        say(T.done[lang](`${name(from)}.lim`, `${name(to)}.lim`));
        reportFiles(r.files);
        if (r.entry) say(T.entry[lang]);
        const config = r.config?.filter((c) => c !== "entry");
        if (config?.length) say(T.config[lang](config.join(sep)));
        if (r.data?.length) say(T.data[lang](r.data.join(sep)));
        reportTests(r.tests);
        if (r.left?.length) {
          say(T.chaptersLeft[lang]);
          for (const l of r.left) say(`  liminalia.json ${l}`);
        }
        return true;
      }
      case "variable": {
        if (!server.listVariables(ws).some((v) => v.path === from)) return fail(T.noVariable[lang](from));
        const r = server.renameVariable(ws, from, to);
        say(T.done[lang](from, to));
        reportFiles(r.files);
        reportTests(r.tests);
        return true;
      }
      case "character":
      case "speaker": {
        const r = server.renameCast(ws, { kind: kind === "character" ? "cast" : "speaker", from, to });
        say(T.done[lang](from, to));
        reportFiles(r.files);
        say(T.cast[lang]);
        if (r.data?.length) say(T.data[lang](r.data.join(sep)));
        reportTests(r.tests);
        return true;
      }
      case "asset": {
        const slash = from.indexOf("/");
        if (slash <= 0) return fail(T.assetForm[lang](from));
        const folder = from.slice(0, slash);
        const path = from.slice(slash + 1);
        const target = to.startsWith(`${folder}/`) ? to.slice(folder.length + 1) : to;
        // ほかの種類のフォルダを指す新しい名前（bgimage の素材を bgm/… に）は受けない
        const other = /^([A-Za-z0-9_-]+)\//.exec(target)?.[1];
        if (other && other !== folder && existsSync(join(ws.project.paths.assets, other)) && !existsSync(join(ws.project.paths.assets, folder, other))) return fail(T.assetKind[lang](folder, other));
        const r = server.renameAsset(ws, folder, path, target);
        say(T.done[lang](from, `${folder}/${target}`));
        reportFiles(r.files);
        if (r.cast) say(T.cast[lang]);
        if (r.config?.length) say(T.config[lang](r.config.join(sep)));
        if (r.data?.length) say(T.data[lang](r.data.join(sep)));
        if (r.css?.length) say(T.css[lang](r.css.join(sep)));
        if (r.left.length > 0) {
          say(T.assetLeft[lang](r.left.length));
          for (const l of r.left) say(`  ${assetUsePlace(l)}`);
        }
        return true;
      }
      case "macro": {
        const r = server.renameMacro(ws, from.replace(/^@/, ""), to.replace(/^@/, ""));
        say(T.done[lang](`@${from.replace(/^@/, "")}`, `@${to.replace(/^@/, "")}`));
        reportFiles(r.files);
        if (r.config) say(T.config[lang]("commandDefaults"));
        return true;
      }
    }
  } catch (e) {
    if (e instanceof server.StudioError) return fail(e.message);
    throw e;
  }
  return false;
}
