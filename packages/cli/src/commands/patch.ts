import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { extractAll } from "@electron/asar";
import { buildPack, loadProject } from "@liminalia/project";
import { zipFolder } from "../zip.ts";
import { decryptBuffer, encryptContent, runBuild } from "./build.ts";
import { keyFromServiceWorker, SERVICE_WORKER } from "../encrypt.ts";
import { scriptHashSource } from "../csp.ts";

/**
 * lim patch [プロジェクト] --base <前の書き出し（フォルダか zip）> [--id 名前] [--out フォルダ] [--variant 版] [--force] [--allow-test]
 *
 * 前に書き出したもの（ブラウザ版・デスクトップ版のフォルダか、その zip）と今の作品を比べ、変わったものだけを入れたパック（パッチ）を作る。
 * - 比べるのは書き出しの中身: シナリオ（.lim）・データ・キャスト（cast.json）・訳（lang/*.json）・素材（assets.json の中身の鍵）。
 *   今の作品はブラウザ版として作業用の場所に書き出してから比べる（書き出しと同じ検査と手順を通る）
 * - 本体（プレイヤーのプログラムと liminalia.json の設定）が変わっていたら、パッチでは直せないので止める（--force で中身だけ作る）
 * - 消したファイルは、パッチでは消せない（本体に残る）ので知らせるだけ
 * - 前の書き出しがテスト版（lim build --feedback）なら止める（テスト版に当てるパッチを作るなら --allow-test）
 * - パックの requires は前の書き出しの版（project/build.json。無い古い書き出しはプログラムの中から探す）、order は作った時刻
 *   （後に作ったパッチが勝つ）
 *
 * out（既定 dist/patches）に作るもの:
 * - <id>/: パック（lim update-manifest --pack に渡せば、デスクトップ版がアップデートの確認で取り寄せて入れる）
 * - <id>-windows.zip・<id>-linux.zip: ゲームのフォルダに展開して上書きする形（resources/packs/<id>/）
 * - <id>-browser.zip: ブラウザ版の置き場に展開して上書きする形（packs/<id>/ と、足した packs/index.json）
 * Mac 版のアプリの中を書き換えると署名が壊れるので、Mac はアップデートの確認で配る。
 */
export interface PatchOptions {
  base: string;
  id?: string;
  out?: string;
  variant?: string;
  force?: boolean;
  /** 前の書き出しがテスト版（lim build --feedback）でも作る。 */
  allowTest?: boolean;
  /** 作ったもの（パックのフォルダと zip の絶対パス）をここに足す（制作アプリが「フォルダを開く」に使う）。 */
  results?: string[];
}

/** 書き出しの中の、比べるもの。 */
interface BuildContent {
  /** 書き出しの web の中身の場所（project/ と、本体のファイルがある）。 */
  web: string;
  /** 本体のファイル（web の中の project/・assets/・packs/ の外）→ 中身のハッシュ。 */
  code: Map<string, string>;
  /** 素材の "種類/パス" → 中身の鍵。 */
  assets: Record<string, string>;
  version: string | null;
  /** すでに入っているパック（ブラウザ版の packs/index.json）。 */
  packs: string[];
  /** 何の書き出しか（作る zip を決める）。 */
  kind: "browser" | "mac" | "windows" | "linux";
  /** 中身を暗号にした書き出し（build.encrypt）の鍵。パッチも同じ鍵で暗号にする。 */
  key: Buffer | null;
  /** テスト版（project/build.json の feedback）。 */
  feedback: boolean;
}

export async function runPatch(dir: string, o: PatchOptions): Promise<boolean> {
  const project = loadProject(dir);
  const work = mkdtempSync(join(tmpdir(), "liminalia-patch-"));
  try {
    console.log(`前の書き出しを読む: ${o.base}`);
    const before = readBuild(resolve(o.base), join(work, "base"));
    if (before.feedback && !o.allowTest) {
      console.error(`${o.base} はテスト版の書き出しです（lim build --feedback）。製品に当てるパッチは、製品の書き出しを --base に渡して作ります（テスト版に当てるなら --allow-test を付けます）`);
      return false;
    }
    console.log("今の作品を書き出す（比べるため。作業用の場所に）");
    const outDir = join(work, "now");
    const built: string[] = [];
    if (!(await runBuild(dir, { targets: ["browser"], import: false, verify: false, outDir, forPatch: before.kind === "browser" ? "browser" : "desktop", results: built, ...(o.variant ? { variant: o.variant } : {}) }))) return false;
    // 書き出したブラウザ版のフォルダ（エディションとテスト版は名前が変わる。build.ts の browserBuildName）
    const nowRoot = built.find((p) => !p.endsWith(".zip")) ?? join(outDir, "browser", project.config.id);
    const now = readBuild(nowRoot, null);

    // 本体が変わっていたら、パッチでは直せない
    const codeChanged = [...new Set([...before.code.keys(), ...now.code.keys()])].filter((f) => before.code.get(f) !== now.code.get(f));
    if (codeChanged.length > 0) {
      console.log(`\n本体（プレイヤーのプログラムか liminalia.json の設定）が前の書き出しと違います（${codeChanged.length} ファイル）。`);
      console.log("  エンジンを更新したか、liminalia.json の ui・extra・items などを変えると、ここが変わります。パックでは直せないので、本体を配り直してください。");
      for (const f of codeChanged.slice(0, 10)) console.log(`  ${f}`);
      if (!o.force) {
        console.log("  シナリオ・データ・素材の差分だけでパッチを作るなら --force を付けます（本体の設定の変更は入りません）。");
        return false;
      }
    }

    // 中身の差分
    const src = join(work, "pack");
    const changed: string[] = [];
    const removed: string[] = [];
    const compare = (rel: string, into: string) => {
      const a = join(before.web, rel);
      const b = join(now.web, rel);
      if (!existsSync(b)) {
        if (existsSync(a)) removed.push(rel);
        return;
      }
      if (existsSync(a) && hashFile(a) === hashFile(b)) return;
      changed.push(rel);
      mkdirSync(dirname(join(src, into)), { recursive: true });
      cpSync(b, join(src, into));
    };
    const filesUnder = (root: string, sub: string) => (existsSync(join(root, sub)) ? walk(join(root, sub)).map((f) => relative(root, f).split(sep).join("/")) : []);
    for (const rel of new Set([...filesUnder(before.web, "project/scenario"), ...filesUnder(now.web, "project/scenario")])) compare(rel, rel.replace(/^project\//, ""));
    for (const rel of new Set([...filesUnder(before.web, "project/data"), ...filesUnder(now.web, "project/data")])) compare(rel, rel.replace(/^project\//, ""));
    for (const rel of new Set([...filesUnder(before.web, "project/lang"), ...filesUnder(now.web, "project/lang")])) compare(rel, rel.replace(/^project\//, ""));
    compare("project/cast.json", "cast.json");
    for (const key of new Set([...Object.keys(before.assets), ...Object.keys(now.assets)])) {
      if (!(key in now.assets)) {
        removed.push(`assets/${key}`);
        continue;
      }
      if (before.assets[key] === now.assets[key]) continue;
      changed.push(`assets/${key}`);
      mkdirSync(dirname(join(src, "assets", key)), { recursive: true });
      cpSync(join(nowRoot, "assets", key), join(src, "assets", key));
    }
    if (changed.length === 0) {
      console.log("\n前の書き出しから変わったものはありません（パッチは作りません）。");
      for (const r of removed) console.log(`  消えたもの（パッチでは消せません）: ${r}`);
      return true;
    }

    const id = o.id ?? `patch-${(project.config.version ?? "").replace(/[^A-Za-z0-9_-]/g, "_") || new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`パッチの名前 ${id} は英数字、_、- で書きます（--id）`);
    const requires = before.version ?? undefined;
    writeFileSync(join(src, "pack.json"), JSON.stringify({ id, title: project.config.title, ...(project.config.version ? { version: project.config.version } : {}), ...(requires ? { requires } : {}), order: Math.floor(Date.now() / 1000) }, null, 2));
    const out = resolve(o.out ?? join(project.paths.out, "patches"));
    const dest = join(out, id);
    rmSync(dest, { recursive: true, force: true });
    const r = await buildPack(project, src, dest);
    for (const p of r.problems) console.error(`  ${p}`);
    if (r.problems.length > 0) return false;
    // 前の書き出しが中身を暗号にしていれば、パッチも同じ鍵で（pack.json はそのまま）
    if (before.key) encryptContent(dest, before.key, true);

    // 展開して上書きする形の zip（Windows・Linux はゲームのフォルダの resources/packs/、ブラウザ版は packs/ と一覧）
    const zips: string[] = [];
    const layout = (name: string, top: string, place: (root: string) => void) => {
      const root = join(work, `zip-${name}`);
      place(root);
      const file = join(out, `${id}-${name}.zip`);
      rmSync(file, { force: true });
      zips.push(file);
      return zipFolder(root, top, file);
    };
    // 前の書き出しと同じ置き方の zip だけ作る（Mac はアプリの中を書き換えると署名が壊れるので、アップデートの確認で配る）
    if (before.kind === "windows" || before.kind === "linux") await layout(before.kind, "resources", (root) => cpSync(dest, join(root, "resources", "packs", id), { recursive: true }));
    if (before.kind === "browser")
      await layout("browser", "packs", (root) => {
        cpSync(dest, join(root, "packs", id), { recursive: true });
        writeFileSync(join(root, "packs", "index.json"), JSON.stringify([...before.packs.filter((p) => p !== id), id]));
      });

    o.results?.push(dest, ...zips);
    console.log(`\nパッチ ${id}（${requires ? `バージョン ${requires} の本体向け` : "以前の書き出しバージョンが分からないため、すべてのバージョンに適用可能"}${before.key ? "。前の書き出しと同じ鍵で暗号化" : ""}）:`);
    console.log(`  シナリオ ${r.manifest.files!.scenario.length}、データ ${r.manifest.files!.data.length}、素材 ${r.manifest.files!.assets.length}${r.manifest.files!.cast ? "、キャスト" : ""}${r.manifest.files!.lang?.length ? `、訳 ${r.manifest.files!.lang.join("・")}` : ""}`);
    for (const c of changed) console.log(`  変わったもの: ${c}`);
    for (const x of removed) console.log(`  消えたもの（パッチでは消せず、本体に残ります）: ${x}`);
    console.log(`\n- ${relative(project.root, dest)}/（lim update-manifest --pack でアップデートの確認から配る）`);
    for (const z of zips) console.log(`- ${relative(project.root, z)}`);
    console.log(before.kind === "mac" ? "  Mac 版はアプリの中を書き換えられないので、アップデートの確認で配ります。" : `  zip を${before.kind === "browser" ? "ブラウザ版の配置先" : "ゲームのフォルダ"}に展開して上書きします。`);
    if (requires && project.config.version === requires) console.log(`  liminalia.json の version が前の書き出しと同じ ${requires} です。パッチを配るならバージョンを上げておくと、どのパッチを入れたかを見分けられます。`);
    return true;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * index.html から、Service Worker を入れる差し込み（encrypt.ts の injectServiceWorkerRegister と injectServiceWorkerLoader）を外す。
 * 前の書き出しはオフライン（build.browser.offline、既定でオン）か暗号化で差し込みを持ち、比べるための書き出しは持たないので、外してから比べる。
 * 差し込みは serviceWorker を含む <script>（src の無いもの）。エンジンを読み込む形（loader）は、元の <script type="module"> に戻す。
 * CSP（csp.ts の injectCsp）は index.html の中のスクリプトを中身のハッシュで許すので、外したスクリプトのハッシュも script-src から外す。
 */
export function withoutServiceWorker(html: string): string {
  const removed = new Set<string>();
  const out = html.replace(/<script>(\n[\s\S]*?)<\/script>(\n?)/g, (all, body: string, nl: string) => {
    if (!body.includes("serviceWorker")) return all;
    removed.add(scriptHashSource(body));
    const src = /var src = ("[^"]+");/.exec(body);
    return src ? `<script type="module" crossorigin src=${src[1]}></script>${nl}` : "";
  });
  if (removed.size === 0) return out;
  return out.replace(/(<meta http-equiv="Content-Security-Policy" content=")([^"]*)"/i, (_all, head: string, policy: string) => {
    const kept = policy.split(";").map((d) => d.trim().split(/\s+/).filter((s) => !removed.has(s)).join(" "));
    return `${head}${kept.join("; ")}"`;
  });
}

/**
 * 書き出したもの（フォルダか zip）の中から、web の中身を探して読む。デスクトップ版はアプリの app.asar を展開して読む（extract に）。
 */
function readBuild(path: string, extract: string | null): BuildContent {
  let root = path;
  if (statSync(path).isFile()) {
    if (!/\.zip$/i.test(path)) throw new Error(`${path} は書き出したフォルダか zip を指定します`);
    if (!extract) throw new Error("zip を展開する場所がありません");
    root = join(extract, "unzipped");
    mkdirSync(root, { recursive: true });
    if (process.platform === "win32") execFileSync("tar", ["-xf", path, "-C", root]);
    else execFileSync("unzip", ["-q", path, "-d", root]);
  }
  const found = findWeb(root, 0);
  if (!found) throw new Error(`${path} の中に書き出したゲーム（project/assets.json か app.asar）が見つかりません`);
  let web = found;
  if (found.endsWith(".asar")) {
    if (!extract) throw new Error("asar を展開する場所がありません");
    const to = join(extract, "app");
    extractAll(found, to);
    web = join(to, "web");
  }
  // デスクトップ版のアプリの設定（web の横の game.json）。中身を暗号にしていれば鍵があるので、戻してから比べる
  const game = readJson<{ encrypt?: string }>(join(dirname(web), "game.json"));
  // ブラウザ版（build.browser.encrypt）は Service Worker の中に鍵がある
  const key = game?.encrypt ? Buffer.from(game.encrypt, "base64") : keyFromServiceWorker(web);
  if (key) {
    if (!extract) throw new Error("暗号を戻す場所がありません");
    if (!web.startsWith(extract)) {
      cpSync(web, join(extract, "web"), { recursive: true });
      web = join(extract, "web");
    }
    for (const f of [...walk(join(web, "project")), ...walk(join(web, "packs"))]) writeFileSync(f, decryptBuffer(readFileSync(f), key));
  }
  const where = `${path}${sep}${relative(root, found)}`;
  const kind: BuildContent["kind"] = !game ? "browser" : /\.app([\\/]|$)/.test(where) ? "mac" : hasExe(root) ? "windows" : "linux";
  const code = new Map<string, string>();
  for (const f of walk(web)) {
    const rel = relative(web, f).split(sep).join("/");
    if (/^(project|assets|packs)\//.test(rel)) continue;
    // Service Worker（オフラインと暗号化のときに置く）は書き出すたびに中身が変わり、比べるための書き出しには置かないので比べない
    if (rel === SERVICE_WORKER) continue;
    code.set(rel, rel === "index.html" ? hashText(withoutServiceWorker(readFileSync(f, "utf8"))) : hashFile(f));
  }
  const assets = readJson<Record<string, string>>(join(web, "project/assets.json")) ?? {};
  const build = readJson<{ version?: string; feedback?: boolean }>(join(web, "project/build.json"));
  const packs = readJson<string[]>(join(web, "packs/index.json")) ?? [];
  return { web, code, assets, version: build?.version ?? versionFromCode(web), packs, kind, key, feedback: build?.feedback === true };
}

/** Windows 版の書き出し（.exe がある）か。 */
function hasExe(dir: string): boolean {
  try {
    return readdirSync(dir).some((f) => f.toLowerCase().endsWith(".exe")) || readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory() && readdirSync(join(dir, e.name)).some((f) => f.toLowerCase().endsWith(".exe")));
  } catch {
    // 読めないフォルダは Windows 版の書き出しではないとみなす
    return false;
  }
}

/** project/assets.json のあるフォルダ（ブラウザ版・展開したデスクトップ版）か、web を入れた app.asar を探す。 */
function findWeb(dir: string, depth: number): string | null {
  if (existsSync(join(dir, "project", "assets.json"))) return dir;
  if (depth > 6) return null;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isFile() && e.name === "app.asar") return p;
    if (e.isDirectory() && !e.name.endsWith(".asar")) {
      const hit = findWeb(p, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** project/build.json の無い古い書き出しの版（プレイヤーのプログラムに埋めた作品の情報から）。 */
function versionFromCode(web: string): string | null {
  for (const f of walk(web)) {
    if (!f.endsWith(".js") || /[\\/](project|assets|packs)[\\/]/.test(f)) continue;
    const m = /"version":"([^"]*)","entry"/.exec(readFileSync(f, "utf8"));
    if (m?.[1]) return m[1];
  }
  return null;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    // 無い・読めないものは null（呼ぶ側が前の書き出しの形の誤りとして止める）
    return null;
  }
}

function hashFile(file: string): string {
  return createHash("sha1").update(readFileSync(file)).digest("hex");
}

function hashText(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name.startsWith(".") ? [] : e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}
