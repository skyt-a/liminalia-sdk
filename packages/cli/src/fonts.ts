import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import subsetFont from "subset-font";
import { plainText, type Inline, type Statement } from "@liminalia/lang";
import { projectPacks, projectPackScripts, projectScripts, type Project } from "@liminalia/project";
import { webDir } from "./engine-paths.ts";

/**
 * 書体を、作品で使う字だけに縮める（build.subsetFonts）。残す字:
 * - いつも残すもの: ASCII・ひらがな・カタカナ・全角の英数字と記号・句読点（名前の入力などで遊ぶ人が打つ字）
 * - 台本の本文・話者名・選択肢、data の JSON・訳のファイル・liminalia.json の文字（おまけの題など）
 * - 作品のプラグインのソース（画面の文言）と、エンジンのシステム画面の文言
 * - build.subsetFonts.text（足りない字を足す）
 * 縮めたものは .liminalia/build-cache/fonts に控え、同じ書体と字なら作り直さない。
 */
export interface FontSubsetOptions {
  /** 縮める書体（素材のフォルダからのパス。"others/fonts/a.otf"）。 */
  files: string[];
  /** 足す字。 */
  text?: string;
}

const ALWAYS = (() => {
  let s = "";
  const range = (a: number, b: number) => {
    for (let c = a; c <= b; c++) s += String.fromCodePoint(c);
  };
  range(0x20, 0x7e); // ASCII
  range(0x3000, 0x30ff); // 全角の記号・ひらがな・カタカナ
  range(0xff01, 0xff9f); // 全角の英数字・記号・半角カナ
  range(0x2010, 0x2027); // ダッシュ・…・‥ など
  return s;
})();

/** 作品で使う字。 */
export function projectCharacters(project: Project, extra = ""): string {
  const chars = new Set<string>([...ALWAYS, ...extra]);
  const add = (s: string) => {
    for (const c of s) chars.add(c);
  };
  const visit = (body: Statement[]) => {
    for (const s of body) {
      if (s.kind === "say") {
        add(s.speaker);
        add(plainText(s.content));
      } else if (s.kind === "prose") add(plainText(s.content));
      else if (s.kind === "choice") for (const o of s.options) add(plainText(o.content as Inline[]));
      else if (s.kind === "if") for (const b of s.branches) visit(b.body);
      else if (s.kind === "define") visit(s.body);
    }
  };
  // 本体とパックの台本（書き出しは作品のパックをすべて入れる）
  for (const { script, text } of [...projectScripts(project).values(), ...projectPackScripts(project).flatMap((p) => [...p.scripts.values()])]) {
    visit(script.body);
    // 命令の引数の文字（@layer-text・@dialog など）も拾う
    for (const line of text.split("\n")) if (line.trimStart().startsWith("@")) add(line);
  }
  const addFiles = (dir: string, exts: RegExp) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const path = join(dir, e.name);
      if (e.isDirectory()) addFiles(path, exts);
      else if (exts.test(e.name) && statSync(path).size < 8 * 1024 * 1024) add(readFileSync(path, "utf8"));
    }
  };
  addFiles(project.paths.data, /\.json$/i);
  addFiles(project.paths.lang, /\.json$/i);
  // パックのデータ、訳、キャラクター（pack.json の名前も）
  for (const pack of projectPacks(project)) addFiles(pack, /\.json$/i);
  add(readFileSync(join(project.root, "liminalia.json"), "utf8"));
  // 作品のプラグイン（画面の文言）。組み込みの標準の命令は除く
  for (const dir of project.plugins.slice(1)) addFiles(join(dir, "src"), /\.(ts|js|mjs|css|html|json)$/i);
  // エンジンのシステム画面の文言
  addFiles(join(webDir(), "src/system"), /^strings.*\.ts$/);
  return [...chars].join("");
}

/** 書体を縮める。assetsDir の中の書体を置き換え、縮めた大きさを返す。 */
export async function subsetFonts(project: Project, assetsDir: string, o: FontSubsetOptions, cache = join(project.root, ".liminalia", "build-cache", "fonts")): Promise<{ file: string; before: number; after: number }[]> {
  const text = projectCharacters(project, o.text ?? "");
  mkdirSync(cache, { recursive: true });
  const out: { file: string; before: number; after: number }[] = [];
  for (const rel of o.files) {
    const path = join(assetsDir, rel);
    if (!existsSync(path)) throw new Error(`build.subsetFonts のフォントが見つかりません: ${rel}`);
    const font = readFileSync(path);
    const ext = extname(rel).toLowerCase();
    const format = ext === ".woff2" ? "woff2" : ext === ".woff" ? "woff" : "sfnt";
    const key = createHash("sha1").update(font).update(text).update(format).digest("hex");
    const cached = join(cache, `${key}${ext}`);
    const small = existsSync(cached) ? readFileSync(cached) : await subsetFont(font, text, { targetFormat: format });
    if (!existsSync(cached)) writeFileSync(cached, small);
    writeFileSync(path, small);
    out.push({ file: rel, before: font.length, after: small.length });
  }
  return out;
}
