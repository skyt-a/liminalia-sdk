import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE } from "@liminalia/project";
import type { SampleAssetsResult } from "../protocol.ts";
import { StudioError, type StudioWorkspace } from "./workspace.ts";

/** サンプル素材の説明（CC0 1.0 であること、絵は AI で作ったこと。lim new が置くものと同じ名前。cli/src/commands/new.ts）。 */
const SAMPLE_ASSETS_NOTE = "素材について.txt";
/** 英語の作品に置くサンプル素材の説明（英語の見本 templates/default-en のもの。lim new --lang en が置くものと同じ）。 */
const SAMPLE_ASSETS_NOTE_EN = "SAMPLE-ASSETS.txt";
/** 英語の見本のひな形のフォルダの名前（templates/default の隣）。 */
const ENGLISH_SAMPLE = "default-en";

/**
 * そのプロジェクトに置くサンプル素材の説明のファイル（ひな形の中の場所と、置く名前）。原文の言語（languages の先頭）が英語なら
 * 英語の見本の説明、ほかは日本語の説明。
 */
export function sampleAssetsNote(template: string, language: string | undefined): { from: string; name: string } {
  if (language !== undefined && /^en(?:-|$)/i.test(language)) return { from: join(dirname(template), ENGLISH_SAMPLE, SAMPLE_ASSETS_NOTE_EN), name: SAMPLE_ASSETS_NOTE_EN };
  return { from: join(template, SAMPLE_ASSETS_NOTE), name: SAMPLE_ASSETS_NOTE };
}

/**
 * lim new のひな形（templates/default）の場所。このリポジトリではリポジトリの直下、制作アプリでは cli の中（packages/studio-desktop/scripts/package.ts）。
 * npm で入れた lim は、開発サーバーを立てるときに環境変数 LIMINALIA_TEMPLATES で cli の中の templates を渡す（cli/src/web.ts。
 * npm install -g では制作画面が cli の node_modules の中に入り、隣に cli が無い）。
 * 見つからなければ null（スマホ版の制作画面はひな形のファイルを持たない）。
 */
export function sampleTemplateDir(): string | null {
  // import.meta.url で求める（スマホ版の束ね方は import.meta.url だけを置き換える。catalog.ts と同じ）
  const here = dirname(fileURLToPath(import.meta.url));
  const given = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.LIMINALIA_TEMPLATES;
  for (const root of [...(given ? [given] : []), resolve(here, "../../../../templates"), resolve(here, "../../../cli/templates")]) {
    const dir = join(root, "default");
    if (existsSync(join(dir, CONFIG_FILE)) && existsSync(join(dir, "assets"))) return dir;
  }
  return null;
}

/**
 * ひな形のサンプル素材（CC0 1.0。背景、立ち絵、BGM、効果音）を、プロジェクトの素材のフォルダへ写す。同じ名前のファイルは写さない
 * （書き換えない）。説明のファイル（素材について.txt。原文が英語の作品は SAMPLE-ASSETS.txt）も、無ければプロジェクトの直下に置く
 * （書き出すゲームには入らない）。
 */
export function addSampleAssets(ws: StudioWorkspace, template = sampleTemplateDir()): SampleAssetsResult {
  if (!template) throw new StudioError(404, "サンプル素材が見つかりません");
  const from = join(template, "assets");
  const added: string[] = [];
  const skipped: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const src = join(dir, e.name);
      if (e.isDirectory()) {
        walk(src);
        continue;
      }
      const rel = relative(from, src).split(sep).join("/");
      const dest = join(ws.project.paths.assets, ...rel.split("/"));
      if (existsSync(dest)) {
        skipped.push(rel);
        continue;
      }
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      added.push(rel);
    }
  };
  if (existsSync(from) && statSync(from).isDirectory()) walk(from);
  const note = sampleAssetsNote(template, ws.project.config.languages?.[0]);
  if (added.length > 0 && existsSync(note.from) && !existsSync(join(ws.project.root, note.name))) copyFileSync(note.from, join(ws.project.root, note.name));
  ws.forgetAssets();
  return { added, skipped, note: note.name };
}
