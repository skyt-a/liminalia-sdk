#!/usr/bin/env node
/**
 * npm に出す部品（@liminalia/lang、@liminalia/runtime、@liminalia/sdk）を組み立てて npm pack する。公開はしない（scripts/npm-publish.mjs）。
 * 公開用のリポジトリ（skyt-a/liminalia-sdk）の publish-npm.yml がこれで組み立て、正本のリリースが組み立てて確かめた tarball と中身を比べてから出す。
 * 正本では scripts/npm-pack.mjs が、ここの関数でほかの部品も組み立てる（ここは公開用のリポジトリにも写す）。
 *
 *   node scripts/npm-pack-public.mjs [--version 1.2.3] [--out out/npm]
 *
 * 部品の package.json は private のままにし、out/npm/stage/<名前>/ に配る形を作る:
 * - src/ は TypeScript のまま入れ、types/ に型の宣言（.d.ts）を作って exports の "types" で指す。dist/ に JavaScript も作り、exports の "node" で指す
 *   （tsx の無い Node からも読める）
 * - 入れるものは、src と exports が指すファイルから相対の読み込みをたどって決める（packageItems。手で並べると抜ける）
 * - 中の @liminalia/… の依存は同じ版に固定する。開発用（devDependencies）は入れない
 * - リポジトリの直下に LICENSE があれば各パッケージに写し、license を "SEE LICENSE IN LICENSE" にする
 *   （部品のフォルダに自分の LICENSE があればそちらを写し、license はその部品の package.json の欄。@liminalia/sdk の MIT）
 * --version を省くと、部品の package.json の版（どれも同じ版）を使う。
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PACKAGES_DIR = join(ROOT, "packages");
export const SCOPE = "@liminalia/";
const HOMEPAGE = "https://liminalia.skyta.dev/";

/**
 * 配るパッケージ（依存の順。公開もこの順で行う）。
 * - js: dist/ に JavaScript も作る（"node" の条件で指す）
 * - types: false なら型の宣言を作らない（lim の入口だけのもの）
 * - entries: import されずに名前で読まれる入口（Vite のページと lim が読む設定）。ここからも相対の読み込みをたどる
 * - files: 中を丸ごと入れるフォルダ（読み込みをたどらずに入れるもの）
 * - peers: lim の中でだけ読むもの（入れなくてよい peerDependencies。版は値か、このリポジトリで使っている版）
 * 入れるものは src と entries と files に、exports と bin が指すファイルと、そこから相対で読むファイルを足したもの（packageItems）。
 */
export const NPM_PACKAGES = [
  // プラグインとの約束（型と軽い関数。エンジンの実装を読まない）。lang も約束の値（口の版など）をここから読む
  { dir: "sdk", js: true },
  { dir: "lang", js: true },
  { dir: "runtime", js: true },
  // プラグインを読み込んで動かすエンジンの側（命令の定義を仕様にする、検査）
  { dir: "plugin-host", js: true },
  // 標準の画面の決まりと文言（web が読む）
  { dir: "screens" },
  {
    dir: "web",
    // lim が Vite に渡す設定とページ（制作画面のページは @liminalia/studio が名前で読む）
    entries: ["index.html", "caster.html", "vite.config.ts"],
    // 開発サーバーの設定（vite.config.ts）と、取り込み直しと立ち絵の位置合わせの口が読む。lim（@liminalia/cli）が入れる
    peers: ["@liminalia/project", "@liminalia/ks-import", "@liminalia/studio", "vite"],
  },
  // js: lim のテストの口（@liminalia/cli/testing）が tsx の無い Node から標準の命令を読む
  { dir: "std", js: ["./commands"] },
  // schemas/ は src/index.ts が new URL(`../schemas/${…}`, import.meta.url) で読む（たどって入る）
  { dir: "project" },
  // 制作画面と VS Code の拡張機能が共有する部品（project を読む）
  { dir: "editor" },
  { dir: "ks-import", js: true },
  { dir: "story-import" },
  // 画面の写真と開発サーバー（lim studio）が読む。lim が入れる
  { dir: "studio", peers: ["playwright-core", "vite"] },
  { dir: "cli", files: ["bin"], types: false },
];

/**
 * npm に出すもの（依存の順）。プラグインを書く人の @liminalia/sdk（約束だけ。MIT）と、ゲームを作る人の @liminalia/cli（lim と、
 * NPM_PACKAGES のほかの部品を中に同梱する。中の部品は外から名前で使わせない）の二つだけ。
 */
export const NPM_PUBLIC = ["sdk", "cli"];

/** npm のページから辿れる、ソースの場所（公開用のリポジトリ）。 */
export const PUBLIC_REPOSITORY = "https://github.com/skyt-a/liminalia-sdk";

/**
 * 公開する部品の中の、非公開の所。制作画面の見た目と操作（studio の src/client）と、制作画面のプラグインの口（src/plugin.ts。画面の部品を読む）は、
 * 制作アプリ（studio-desktop）が @liminalia/studio/client の名前で読むので、部品の名前は変えずに、ここで分ける。
 * 配る形（ここ）と公開用の写し（scripts/public-mirror.mjs）は、この所と exports の項目と、画面だけが使う依存を外す。境界は scripts/public-boundary.mjs が確かめる。
 */
export const PRIVATE_PARTS = {
  studio: {
    paths: ["src/client/"],
    exports: ["./client"],
    dependencies: [
      "@codemirror/autocomplete",
      "@codemirror/commands",
      "@codemirror/lang-css",
      "@codemirror/lang-json",
      "@codemirror/language",
      "@codemirror/lint",
      "@codemirror/search",
      "@codemirror/state",
      "@codemirror/view",
      "@fontsource/jetbrains-mono",
      "@fontsource/zen-kaku-gothic-new",
      "@fontsource/zen-old-mincho",
      "@lezer/highlight",
      "@liminalia/story-import",
      "@radix-ui/colors",
    ],
  },
};

/** その入口（exports の項目）に JavaScript も作るか（spec.js が true なら全部、並びならその入口だけ）。 */
const jsFor = (spec, key) => spec.js === true || (Array.isArray(spec.js) && spec.js.includes(key));

/** 部品の中の非公開の所（部品の直下からの道筋。/ で終わるものはフォルダ）。 */
export const hiddenPaths = (dir) => PRIVATE_PARTS[dir]?.paths ?? [];
/** rel（部品の直下からの道筋）が非公開の所か。 */
export const isHidden = (hidden, rel) => hidden.some((p) => (p.endsWith("/") ? rel === p.slice(0, -1) || rel.startsWith(p) : rel === p));

/** 部品の package.json から、非公開の所の exports と依存を外したもの（無ければそのまま）。 */
export function withoutPrivateParts(dir, pkg) {
  const part = PRIVATE_PARTS[dir];
  if (!part) return pkg;
  const out = structuredClone(pkg);
  for (const key of part.exports) delete out.exports?.[key];
  for (const dep of part.dependencies) delete out.dependencies?.[dep];
  return out;
}

/** 配る形に入れないもの（フォルダとファイル）。 */
const SKIP_DIRS = new Set(["test", "tests", "__tests__", "dev", "scripts", "node_modules", "dist", "out", ".vite", ".vite-temp"]);
const SKIP_FILE = /(\.test\.[cm]?[jt]s|\.DS_Store|\.tsbuildinfo)$/;
/** npm が必ず入れるので、files に書かないもの。 */
const ALWAYS_PACKED = new Set(["package.json", "README.md", "LICENSE"]);
/** 中の相対の読み込みを探すファイル。 */
const CODE_FILE = /\.(?:[cm]?[jt]s|html|css)$/;

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const isTsTarget = (target) => typeof target === "string" && /\.ts$/.test(target) && !/\.d\.ts$/.test(target);
/** "./src/a.ts" → "./types/src/a.d.ts"（型の宣言はパッケージの中の道筋をそのまま types/ の下に写す）。 */
const typesPath = (target) => `./types/${target.replace(/^\.\//, "").replace(/\.ts$/, ".d.ts")}`;
/** "./src/a.ts" → "./dist/src/a.js"。 */
const jsPath = (target) => `./dist/${target.replace(/^\.\//, "").replace(/\.ts$/, ".js")}`;
const toPosix = (p) => p.split("\\").join("/");

/**
 * ファイルの中の相対の参照（書いたままの "./a.ts"。?raw などは外す）。拾うもの:
 * - import、export … from、import()、require()、(…, import.meta.url)（new URL と register）の、"./" か "../" で始まる文字列
 * - new URL(`../schemas/${名前}.json`, import.meta.url) のように途中を埋めるものは、埋める前までのフォルダ（"../schemas/"。/ で終わる）
 * - CSS の @import と url()、HTML の src と href（/ で始まるものはパッケージの直下から。/ で終わるもの、つまりページへのリンクは外す）
 */
export function relativeReferences(text, file) {
  const out = [];
  const add = (spec) => {
    const s = spec.replace(/[?#].*$/, "");
    if (s) out.push(s);
  };
  if (/\.css$/.test(file)) {
    for (const m of text.matchAll(/(?:@import\s+(?:url\(\s*)?|url\(\s*)["']?(\.{1,2}\/[^"')\s]+)/g)) add(m[1]);
    return out;
  }
  if (/\.html$/.test(file)) {
    for (const m of text.matchAll(/\s(?:src|href)=["']((?:\.{1,2})?\/[^"']*)["']/g)) if (!m[1].endsWith("/")) add(m[1]);
  }
  const patterns = [
    /(?:^|[\s;{}(),])(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?["'](\.{1,2}\/[^"'\n]+)["']/g,
    /\b(?:import|require)\s*\(\s*["'](\.{1,2}\/[^"'\n]+)["']\s*\)/g,
    /["'](\.{1,2}\/[^"'\n]+)["']\s*,\s*import\.meta\.url/g,
    /`(\.{1,2}\/(?:[^`$\n]*\/)?)[^`/$\n]*\$\{[^`]*`\s*,\s*import\.meta\.url/g,
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) add(m[1]);
  return out;
}

/**
 * file（パッケージの直下からの道筋）の参照 spec が指すもの（パッケージの直下からの道筋。外なら ../ で始まる。フォルダなら / で終わる）。
 * HTML の / で始まるものは直下から。型の宣言（.d.ts）の "./a.js" は "a.d.ts" を指す。
 */
export function referenceTarget(file, spec) {
  let target = posix.normalize(spec.startsWith("/") ? `.${spec}` : posix.join(posix.dirname(file), spec));
  if (/\.d\.[cm]?ts$/.test(file)) target = target.replace(/\.([cm]?)js$/, ".d.$1ts");
  return target === "." || target === "./" ? "" : target;
}

/** パッケージの外を指すか（referenceTarget の道筋）。 */
const outside = (target) => target === ".." || target.startsWith("../");

/** 配る形に入れないフォルダかファイルか（パッケージの直下からの道筋）。 */
const skippedPath = (rel) => rel.split("/").some((part, i, all) => (i < all.length - 1 ? SKIP_DIRS.has(part) : SKIP_FILE.test(part)));

/** items（パッケージの直下からの道筋。ファイルかフォルダ）に入るファイル（配る形に入れないものを除く）。 */
export function itemFiles(from, items, hidden = []) {
  const out = new Set();
  for (const item of items) {
    const path = join(from, item);
    if (!existsSync(path)) continue;
    const files = statSync(path).isDirectory() ? walk(path).map((f) => toPosix(relative(from, f))) : [toPosix(item)];
    for (const f of files) if (!skippedPath(f) && !isHidden(hidden, f)) out.add(f);
  }
  return out;
}

/**
 * 配る形のファイル（files。パッケージの直下からの道筋）が相対で読むもので、入っていないもの。root はパッケージのフォルダ。
 * パッケージの外を指すもの（リポジトリの直下を見るものなど）は見ない。HTML の参照でファイルの無いもの（Vite が配る仮のもの）も見ない。
 */
export function missingReferences(root, files) {
  const problems = [];
  for (const file of files) {
    if (!CODE_FILE.test(file)) continue;
    for (const spec of relativeReferences(readFileSync(join(root, file), "utf8"), file)) {
      const target = referenceTarget(file, spec);
      if (target === "" || outside(target)) continue;
      // 型の宣言に残る CSS の読み込み（import "./a.css"）は型を引かないので見ない
      if (/\.d\.[cm]?ts$/.test(file) && !/\.d\.[cm]?ts$/.test(target)) continue;
      if (target.endsWith("/")) {
        if (![...files].some((f) => f.startsWith(target))) problems.push(`${file} が読む ${spec} のフォルダが入っていません`);
        continue;
      }
      if (files.has(target) || ALWAYS_PACKED.has(target)) continue;
      const path = join(root, target);
      if (existsSync(path) && statSync(path).isDirectory()) continue;
      if (/\.html$/.test(file) && !existsSync(path)) continue;
      problems.push(`${file} が読む ${spec} が入っていません`);
    }
  }
  return problems;
}

/**
 * 配る形に入れるもの（パッケージの直下からの道筋。ファイルかフォルダ）。src と spec.entries と spec.files に、exports と bin が指すファイルと、
 * そこから相対で読むファイル（import、new URL(…, import.meta.url)、HTML の src など）をたどって足す。手で並べると抜ける
 * 。
 * パッケージの外のファイルや、配る形に入れないフォルダ（test、dev など）のファイルを読んでいれば止める。
 */
export function packageItems(spec, from = join(PACKAGES_DIR, spec.dir)) {
  const pkg = withoutPrivateParts(spec.dir, readJson(join(from, "package.json")));
  const hidden = hiddenPaths(spec.dir);
  const items = [];
  const files = new Set();
  const queue = [];
  const include = (item) => {
    if (items.includes(item)) return;
    if (!existsSync(join(from, item))) throw new Error(`${relative(ROOT, join(from, item))} がありません`);
    items.push(item);
    for (const f of itemFiles(from, [item], hidden)) {
      if (files.has(f)) continue;
      files.add(f);
      queue.push(f);
    }
  };
  for (const item of ["src", ...(spec.entries ?? []), ...(spec.files ?? [])]) include(item);
  const targets = (v) => (typeof v === "string" ? [v] : Object.values(v ?? {}).flatMap(targets));
  for (const t of [...targets(pkg.exports), ...targets(pkg.bin)]) {
    // ./src/* のような型の入口（ほかの部品の深い読み込みのため）は、たどらない
    if (t.includes("*")) continue;
    const rel = posix.normalize(t);
    if (!files.has(rel) && !ALWAYS_PACKED.has(rel)) include(rel);
  }
  const where = (file) => `packages/${spec.dir}/${file}`;
  while (queue.length > 0) {
    const file = queue.shift();
    if (!CODE_FILE.test(file)) continue;
    for (const ref of relativeReferences(readFileSync(join(from, file), "utf8"), file)) {
      const target = referenceTarget(file, ref);
      const path = join(from, target);
      const isDir = existsSync(path) && statSync(path).isDirectory();
      if (target === "" || ALWAYS_PACKED.has(target) || files.has(target)) continue;
      if (outside(target)) {
        // パッケージの外のフォルダ（リポジトリの直下を見るなど）は配る形の話ではない。ファイルは入らないので止める
        if (existsSync(path) && !isDir) throw new Error(`${where(file)} がパッケージの外の ${ref} を読んでいます（配る形に入りません）`);
        continue;
      }
      if (target.endsWith("/")) {
        const folder = target.slice(0, -1);
        if (isDir && ![...files].some((f) => f.startsWith(target))) include(folder);
        continue;
      }
      if (isDir) continue;
      if (!existsSync(path)) {
        // HTML の参照でファイルの無いものは、Vite が配る仮のもの
        if (/\.html$/.test(file)) continue;
        throw new Error(`${where(file)} が読む ${ref} がありません`);
      }
      if (skippedPath(target)) throw new Error(`${where(file)} が、配る形に入れない ${target} を読んでいます`);
      if (isHidden(hidden, target)) throw new Error(`${where(file)} が、非公開の所（PRIVATE_PARTS）の ${target} を読んでいます`);
      include(target);
    }
  }
  return items;
}


/**
 * 配る package.json を作る（リポジトリの package.json から）。o:
 *   version: 配る版、packed: 一緒に配るパッケージの名前、spec: 組み立て方の一つ、engines: Node の版（直下の package.json の engines）、
 *   license: LICENSE を入れるか（文字列ならその license）、peerVersions: peers の版（名前 → 版）、
 *   items: 入れるもの（packageItems。省くと src と spec.entries と spec.files だけ）、
 *   electron: 組み立てに使った Electron の版（cli だけ。package.json の liminalia.electron に書く）
 * Electron 本体（100MB を超える）は入れず、書き出すときに @electron/packager が liminalia.electron の版を取り寄せる。
 * Steam の部品（steamworks.js）は optionalDependencies。lim（cli）にはひな形、デスクトップ版の外枠、公式のプラグインも入れる（files）。
 * 非公開の所（PRIVATE_PARTS）の exports と依存は入れない。
 */
export function publishManifest(rawPkg, o) {
  const { spec } = o;
  const pkg = withoutPrivateParts(spec.dir, rawPkg);
  const omit = ["electron"];
  const optional = ["steamworks.js"];
  const extraFiles = spec.dir === "cli" ? ["templates", "desktop", "plugins"] : [];
  const liminalia = o.electron ? { electron: o.electron } : undefined;
  const pin = (deps) => Object.fromEntries(Object.entries(deps ?? {}).map(([name, range]) => [name, name.startsWith(SCOPE) ? o.version : range]));
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    if (name.startsWith(SCOPE) && !o.packed.includes(name)) throw new Error(`${pkg.name} の依存 ${name} は配るパッケージに入っていません`);
  }
  const dependencies = pin(pkg.dependencies);
  for (const name of omit) delete dependencies[name];
  const optionalDependencies = {};
  for (const name of optional) {
    if (!dependencies[name]) continue;
    optionalDependencies[name] = dependencies[name];
    delete dependencies[name];
  }
  const peerDependencies = {};
  for (const name of spec.peers ?? []) peerDependencies[name] = name.startsWith(SCOPE) ? o.version : (o.peerVersions?.[name] ?? "*");
  let exports;
  if (pkg.exports) {
    exports = {};
    for (const [key, target] of Object.entries(pkg.exports)) {
      if (!isTsTarget(target)) {
        exports[key] = target;
        continue;
      }
      exports[key] = {
        ...(spec.types === false ? {} : { types: typesPath(target) }),
        ...(jsFor(spec, key) ? { node: jsPath(target) } : {}),
        default: target,
      };
    }
    // パッケージの場所を require.resolve で探せるように
    if (!exports["./package.json"]) exports["./package.json"] = "./package.json";
  }
  const items = (o.items ?? ["src", ...(spec.entries ?? []), ...(spec.files ?? [])]).filter((i) => i !== "src");
  const files = ["src", ...(spec.types === false ? [] : ["types"]), ...(spec.js ? ["dist"] : []), ...items, ...extraFiles];
  const out = {
    name: pkg.name,
    version: o.version,
    ...(pkg.description ? { description: pkg.description } : {}),
    // 部品が自分の LICENSE を持つ（@liminalia/sdk の MIT）なら、その部品の license の欄。ほかはリポジトリの利用条件
    ...(o.license ? { license: typeof o.license === "string" ? o.license : "SEE LICENSE IN LICENSE" } : {}),
    homepage: HOMEPAGE,
    ...(NPM_PUBLIC.includes(spec.dir) ? { repository: { type: "git", url: `git+${PUBLIC_REPOSITORY}.git`, directory: `packages/${spec.dir}` } } : {}),
    type: pkg.type ?? "module",
    ...(pkg.bin ? { bin: pkg.bin } : {}),
    ...(exports ? { exports } : {}),
    files,
    engines: { ...(o.engines ? { node: o.engines } : {}) },
    ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
    ...(Object.keys(optionalDependencies).length > 0 ? { optionalDependencies } : {}),
    ...(Object.keys(peerDependencies).length > 0
      ? { peerDependencies, peerDependenciesMeta: Object.fromEntries(Object.keys(peerDependencies).map((n) => [n, { optional: true }])) }
      : {}),
    ...(liminalia ? { liminalia } : {}),
    // 組織のスコープ（@liminalia）のパッケージは、既定では有料の非公開になるので、公開で出す
    publishConfig: { access: "public" },
  };
  if (Object.keys(out.engines).length === 0) delete out.engines;
  return out;
}

/** パッケージのフォルダの中の、配る形に入れるもの（packageItems）を写す。 */
function stageSources(from, to, items, hidden = []) {
  const filter = (src) => {
    const name = basename(src);
    if (isHidden(hidden, toPosix(relative(from, src)))) return false;
    if (statSync(src).isDirectory()) return src === from || !SKIP_DIRS.has(name);
    return !SKIP_FILE.test(name);
  };
  for (const item of items) {
    const src = join(from, item);
    if (!existsSync(src)) throw new Error(`${relative(ROOT, src)} がありません`);
    cpSync(src, join(to, item), { recursive: true, filter });
  }
}

export function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function tsc(work, name, compilerOptions, include, exclude = []) {
  const config = join(work, `tsconfig.${name}.json`);
  writeFileSync(
    config,
    JSON.stringify(
      {
        extends: join(ROOT, "tsconfig.json"),
        compilerOptions: { rootDir: PACKAGES_DIR, typeRoots: [join(ROOT, "node_modules/@types")], noUnusedLocals: false, noUnusedParameters: false, allowJs: false, ...compilerOptions },
        include,
        ...(exclude.length > 0 ? { exclude } : {}),
      },
      null,
      2,
    ),
  );
  const r = spawnSync(process.execPath, [join(ROOT, "node_modules/typescript/bin/tsc"), "-p", config], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`型の宣言（${name}）を作れません\n${r.stdout}${r.stderr}`);
}

/** 型の宣言の中の相対の読み込み（"./a.ts"）を、宣言のファイル（"./a.js" → a.d.ts）を指す形にする。 */
export function rewriteDeclarationImports(text) {
  return text.replace(/((?:from|import)\s*\(?\s*["'])(\.{1,2}\/[^"']+?)\.ts(["'])/g, "$1$2.js$3");
}


/**
 * npm pack して、入ったファイルの一覧を確かめる。tarball の場所を返す。
 * allowTests は、テストのフォルダ（tests/ など）を入れてよい道筋の頭（配る中身として入れるもの）。
 */
export function pack(stage, dest, manifest, allowTests = []) {
  const r = spawnSync("npm", ["pack", "--json", "--pack-destination", dest], { cwd: stage, encoding: "utf8", shell: process.platform === "win32" });
  if (r.status !== 0) throw new Error(`${manifest.name} を npm pack できません\n${r.stderr}`);
  const [info] = JSON.parse(r.stdout);
  const files = new Set(info.files.map((f) => f.path));
  const problems = [];
  const want = (path, why) => {
    const p = path.replace(/^\.\//, "");
    if (!files.has(p)) problems.push(`${why} の ${p} が入っていません`);
  };
  const targets = (v) => (typeof v === "string" ? [v] : Object.values(v ?? {}).flatMap(targets));
  for (const [key, value] of Object.entries(manifest.exports ?? {})) for (const t of targets(value)) if (!t.includes("*")) want(t, `exports の ${key}`);
  for (const [name, t] of Object.entries(manifest.bin ?? {})) want(t, `bin の ${name}`);
  for (const f of files) if (!allowTests.some((p) => f.startsWith(p)) && /(^|\/)(test|tests|dev|node_modules)\/|\.test\.[cm]?[jt]s$|\.DS_Store$/.test(f)) problems.push(`入れてはいけないもの: ${f}`);
  // 入れたファイルが相対で読むもの（import、new URL(…, import.meta.url)、HTML の src など）が、すべて入っていること
  problems.push(...missingReferences(stage, files));
  if (problems.length > 0) throw new Error(`${manifest.name}:\n  ${problems.join("\n  ")}`);
  return { file: join(dest, info.filename), size: info.size, unpacked: info.unpackedSize, count: info.entryCount };
}

/**
 * specs（組み立て方の並び）を組み立てて npm pack する。o:
 *   specs、version（省くと部品の版）、out（out/npm）、peerVersions、
 *   stageExtra(spec, stage, version): 配る形に足すもの、manifestOptions(spec): publishManifest に足す指定、allowTests(spec): pack の allowTests
 */
export function buildPackages(o) {
  const specs = o.specs;
  const versions = new Set(specs.map((p) => readJson(join(PACKAGES_DIR, p.dir, "package.json")).version));
  const version = o.version ?? (versions.size === 1 ? [...versions][0] : null);
  if (!version) throw new Error(`パッケージの版がそろっていません（${[...versions].join("、")}）。--version で配る版を渡します`);
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`版は 1.2.3 の形で書きます: ${version}`);
  const out = resolve(o.out ?? join(ROOT, "out/npm"));
  const work = join(out, "work");
  const stageRoot = join(out, "stage");
  const tarballDir = join(out, "tarballs");
  rmSync(out, { recursive: true, force: true });
  for (const d of [work, stageRoot, tarballDir]) mkdirSync(d, { recursive: true });

  const license = join(ROOT, "LICENSE");
  const hasLicense = existsSync(license);
  const rootPkg = readJson(join(ROOT, "package.json"));
  const packed = specs.map((p) => readJson(join(PACKAGES_DIR, p.dir, "package.json")).name);

  // 入れるもの（読み込みをたどって決める）
  const itemsOf = new Map(specs.map((p) => [p.dir, packageItems(p)]));
  // 型の宣言（一度にまとめて作る）と、JavaScript
  const typed = specs.filter((p) => p.types !== false);
  // 非公開の所（PRIVATE_PARTS）は型の宣言にも JavaScript にも入れない
  const excluded = specs.flatMap((p) => hiddenPaths(p.dir).map((h) => join(PACKAGES_DIR, p.dir, h.endsWith("/") ? `${h}**/*` : h)));
  tsc(work, "types", { noEmit: false, declaration: true, emitDeclarationOnly: true, outDir: join(work, "types"), rewriteRelativeImportExtensions: true }, [
    ...typed.map((p) => join(PACKAGES_DIR, p.dir, "src/**/*.ts")),
    ...typed.flatMap((p) => itemsOf.get(p.dir).filter((f) => /\.ts$/.test(f) && !/\.d\.ts$/.test(f)).map((f) => join(PACKAGES_DIR, p.dir, f))),
  ], excluded);
  const withJs = specs.filter((p) => p.js);
  if (withJs.length > 0) tsc(work, "js", { noEmit: false, declaration: false, outDir: join(work, "js"), allowImportingTsExtensions: false, rewriteRelativeImportExtensions: true, sourceMap: false }, [
      ...withJs.flatMap((p) => {
        if (p.js === true) return [join(PACKAGES_DIR, p.dir, "src/**/*.ts")];
        // 入口を選んだ部品は、その入口のファイル（tsc が読み込みをたどる）
        const pkgExports = readJson(join(PACKAGES_DIR, p.dir, "package.json")).exports ?? {};
        return p.js.map((key) => join(PACKAGES_DIR, p.dir, pkgExports[key]));
      }),
      // JavaScript を作る部品が読むほかの部品の型の宣言（Vite の型など、src の .d.ts）
      ...specs.map((p) => join(PACKAGES_DIR, p.dir, "src/**/*.d.ts")),
    ], excluded);

  const made = [];
  for (const spec of specs) {
    const from = join(PACKAGES_DIR, spec.dir);
    const pkg = readJson(join(from, "package.json"));
    const stage = join(stageRoot, spec.dir);
    mkdirSync(stage, { recursive: true });
    const items = itemsOf.get(spec.dir);
    const hidden = hiddenPaths(spec.dir);
    stageSources(from, stage, items, hidden);
    if (spec.types !== false) {
      const types = join(work, "types", spec.dir);
      for (const f of walk(types)) {
        const to = join(stage, "types", relative(types, f));
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, rewriteDeclarationImports(readFileSync(f, "utf8")));
      }
      // 手で書いた宣言（src の .d.ts）も型の側に置く
      for (const f of walk(join(from, "src")).filter((x) => x.endsWith(".d.ts") && !isHidden(hidden, toPosix(relative(from, x))))) {
        const to = join(stage, "types", relative(from, f));
        mkdirSync(dirname(to), { recursive: true });
        cpSync(f, to);
      }
    }
    if (spec.js) cpSync(join(work, "js", spec.dir), join(stage, "dist"), { recursive: true });
    o.stageExtra?.(spec, stage, version);
    const ownLicense = join(PACKAGES_DIR, spec.dir, "LICENSE");
    if (existsSync(ownLicense)) cpSync(ownLicense, join(stage, "LICENSE"));
    else if (hasLicense) cpSync(license, join(stage, "LICENSE"));
    const manifest = publishManifest(pkg, { spec, items, version, packed, engines: rootPkg.engines?.node, license: existsSync(ownLicense) ? pkg.license : hasLicense, peerVersions: o.peerVersions, ...(o.manifestOptions?.(spec) ?? {}) });
    writeFileSync(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    made.push({ name: manifest.name, stage, ...pack(stage, tarballDir, manifest, o.allowTests?.(spec) ?? []) });
  }
  return { version, out, tarballs: made, hasLicense };
}

function electronVersion() {
  return readJson(join(ROOT, "node_modules/electron/package.json")).version;
}

const CATALOG_ENTRIES = ["commands", "web", "import", "studio", "studio-server"];
/** 公式のプラグインを写すときに入れないもの（@liminalia/studio の catalog.ts の CATALOG_SKIP と同じ）。 */
const CATALOG_SKIP = new Set(["node_modules", ".git", "test", "tests", "__tests__", ".DS_Store"]);

/**
 * 一覧（catalog/catalog.json）に並ぶ公式のプラグインのうち、入れるもの。このリポジトリの中にあるものだけ（外を指すもの、たとえば
 * 隣に置いた別のリポジトリは、組み立てる人の手元にしか無いので入れない。使う人は LIMINALIA_PLUGIN_CATALOG で自分の一覧を渡せる）。
 * folder は写した先のフォルダの名前（id）にし、version と entries は package.json から決めて書く（制作アプリの Resources/plugins と同じ形）。
 */
export function bundledCatalog(catalogFile = join(ROOT, "catalog/catalog.json")) {
  const base = dirname(catalogFile);
  const plugins = [];
  const skipped = [];
  for (const entry of readJson(catalogFile).plugins ?? []) {
    const { folder, folderEnv: _env, ...rest } = entry;
    const from = resolve(base, folder);
    if (relative(ROOT, from).startsWith("..") || !existsSync(join(from, "package.json"))) {
      skipped.push(entry.id);
      continue;
    }
    const pkg = readJson(join(from, "package.json"));
    const deps = Object.keys(pkg.dependencies ?? {});
    if (deps.length > 0) throw new Error(`公式のプラグイン ${entry.id} に依存（${deps.join("、")}）があります。作品の plugins/ に写して使うので、依存を持たない形にします`);
    plugins.push({
      from,
      entry: { ...rest, version: entry.version ?? pkg.version ?? "", entries: entry.entries ?? CATALOG_ENTRIES.filter((e) => pkg.exports?.[`./${e}`] !== undefined), folder: entry.id },
    });
  }
  return { plugins, skipped };
}

/** npm から入れた lim が配る CI のひな形。公開済みの同じ版の lim を入れる。 */
function stageCiTemplates(to, version) {
  const from = join(ROOT, "templates/ci");
  for (const file of walk(from).filter((path) => path.endsWith(".yml"))) {
    const name = relative(from, file);
    const source = readFileSync(file, "utf8");
    // エンジンの checkout、Node の用意、npm ci を、npm から入れる手順に置き換える。
    const checkout = /^      # (?:エンジン|The engine)（?[^\n]*\n[\s\S]*?(^      - uses: actions\/setup-node@[^\n]+\n        with:\n          node-version: [^\n]+\n)[\s\S]*?^        working-directory: \.liminalia-engine\n/m;
    if (!checkout.test(source)) throw new Error(`CI のひな形のエンジンの取得手順が見つかりません: ${name}`);
    const install = name.startsWith(`en${sep}`) ? "Install the engine" : "エンジンを入れる";
    const text = source
      .replace(checkout, (_, setup) => setup + [
        `      - name: ${install}`,
        "        run: |",
        '          npm install --prefix "$RUNNER_TEMP/liminalia" --no-audit --no-fund "@liminalia/cli@$LIMINALIA_ENGINE_VERSION"',
        '          echo "$RUNNER_TEMP/liminalia/node_modules/.bin" >> "$GITHUB_PATH"',
        "",
      ].join("\n"))
      .replace(/^  # [^\n]*\n(?:  # [^\n]*\n)*  LIMINALIA_ENGINE_REF: [^\n]+/m, `  LIMINALIA_ENGINE_VERSION: "${version}"`)
      .replace("このファイルの LIMINALIA_ENGINE_REF に、使うエンジンのタグかコミットを書いてください", "このファイルの LIMINALIA_ENGINE_VERSION に、使うエンジンの npm の版を書いてください")
      .replaceAll("LIMINALIA_ENGINE_REF", "LIMINALIA_ENGINE_VERSION")
      .replaceAll("node .liminalia-engine/packages/cli/bin/lim.mjs", "lim")
      .replace("run: npx playwright-core install", "run: playwright-core install")
      .replace(/^        working-directory: \.liminalia-engine\n/gm, "");
    if (text.includes(".liminalia-engine") || text.includes("skyt-a/liminalia")) throw new Error(`CI のひな形にソースから入れる手順が残っています: ${name}`);
    const dest = join(to, name);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, text);
  }
}

/** 公式のプラグインの一覧とプラグインを to（cli の plugins/）に置く。 */
function stageCatalog(to) {
  const { plugins } = bundledCatalog();
  mkdirSync(to, { recursive: true });
  for (const p of plugins) cpSync(p.from, join(to, p.entry.id), { recursive: true, dereference: true, filter: (src) => src === p.from || !CATALOG_SKIP.has(basename(src)) });
  writeFileSync(join(to, "catalog.json"), `${JSON.stringify({ plugins: plugins.map((p) => p.entry) }, null, 2)}\n`);
}

/** npm pack して、入ったファイルの一覧を確かめる。tarball の場所を返す。 */

/** 空のフォルダに tarball を入れ、プラグインの見本の型を確かめ、tsx の無い Node から SDK を読む。 */

function buildParts(o) {
  const cliDeps = readJson(join(PACKAGES_DIR, "cli/package.json")).dependencies;
  return buildPackages({
    specs: NPM_PACKAGES,
    version: o.version,
    out: o.out,
    // 相手の部品の版は lim（cli）が入れる版にそろえる
    peerVersions: { vite: cliDeps.vite, "playwright-core": cliDeps["playwright-core"] },
    manifestOptions: (spec) => (spec.dir === "cli" ? { electron: electronVersion() } : {}),
    // ひな形（cli の templates/）の台本のテスト（tests/*.limtest）は lim new が写すもの
    allowTests: (spec) => (spec.dir === "cli" ? ["templates/"] : []),
    stageExtra: (spec, stage, version) => {
      if (spec.dir !== "cli") return;
      const templates = join(stage, "templates");
      cpSync(join(ROOT, "templates/default"), join(templates, "default"), { recursive: true, filter: (f) => basename(f) !== ".DS_Store" && !relative(join(ROOT, "templates/default"), f).startsWith("dist") });
      // 英語の見本（lim new --lang en。素材は default のものを使う）
      cpSync(join(ROOT, "templates/default-en"), join(templates, "default-en"), { recursive: true, filter: (f) => basename(f) !== ".DS_Store" });
      stageCiTemplates(join(templates, "ci"), version);
      // 書き出すデスクトップ版のゲームの外枠。lim は cli の中の desktop/ を先に探す（packages/cli/src/engine-paths.ts）
      mkdirSync(join(stage, "desktop"), { recursive: true });
      for (const f of readdirSync(join(PACKAGES_DIR, "desktop")).filter((n) => n.endsWith(".cjs"))) cpSync(join(PACKAGES_DIR, "desktop", f), join(stage, "desktop", f));
      // 公式のプラグインの一覧と、その中のプラグイン（制作画面の「公式のプラグイン」と lim mcp の install_plugin が読む）
      stageCatalog(join(stage, "plugins"));
    },
  });
}

/**
 * sdk の型の宣言（types/）が読むエンジンの型の宣言（@liminalia/<部品>）を、たどれる分だけ sdk の types/engine/<部品>/ に写し、
 * 読み込みの名前を中の道筋に書き換える。sdk は約束だけで、エンジンの部品は npm に出さない（cli の中にだけある）ので、
 * プラグインを書く人は sdk だけを入れて型を引ける。写すのは型の宣言だけで、エンジンの実装は入れない。
 */
export function vendorEngineTypes(stageRoot, sdkStage) {
  const dirOf = new Map();
  for (const spec of NPM_PACKAGES) dirOf.set(readJson(join(stageRoot, spec.dir, "package.json")).name, spec.dir);
  const engine = join(sdkStage, "types", "engine");
  const done = new Set();
  const queue = walk(join(sdkStage, "types")).filter((f) => f.endsWith(".d.ts"));
  /** @liminalia/<部品>[/<入口>] の型の宣言の、写した先の道筋。 */
  const target = (name, sub) => {
    const dir = dirOf.get(name);
    if (!dir) throw new Error(`sdk の型が、配る部品に無い ${name} を読んでいます`);
    const manifest = readJson(join(stageRoot, dir, "package.json"));
    const entry = manifest.exports?.[sub ? `.${sub}` : "."];
    const types = typeof entry === "object" ? entry?.types : undefined;
    if (typeof types !== "string") throw new Error(`${name}${sub ?? ""} の型の宣言（exports の types）がありません`);
    return { src: join(stageRoot, dir, types), dest: join(engine, dir, types.replace(/^\.\/types\//, "")) };
  };
  const relSpec = (from, to) => {
    const r = toPosix(relative(dirname(from), to)).replace(/\.d\.ts$/, ".js");
    return r.startsWith(".") ? r : `./${r}`;
  };
  while (queue.length > 0) {
    const file = queue.shift();
    if (done.has(file)) continue;
    done.add(file);
    let text = readFileSync(file, "utf8");
    text = text.replace(/((?:from|import)\s*\(?\s*["'])(@liminalia\/[a-z-]+)(\/[a-z-]+)?(["'])/g, (all, pre, name, sub, post) => {
      if (name === "@liminalia/sdk") {
        // sdk どうしの読み込みは、sdk の types の入口を指す
        const own = target(name, sub).src;
        return `${pre}${relSpec(file, own.replace(join(stageRoot, "sdk"), sdkStage))}${post}`;
      }
      const t = target(name, sub);
      if (!existsSync(t.dest)) {
        mkdirSync(dirname(t.dest), { recursive: true });
        cpSync(t.src, t.dest);
        queue.push(t.dest);
      }
      return `${pre}${relSpec(file, t.dest)}${post}`;
    });
    // 写したエンジンの型の宣言が相対で読むもの（"./a.js" → a.d.ts）も写す
    if (file.startsWith(engine)) {
      const rel = toPosix(relative(engine, file));
      const [dir] = rel.split("/");
      const srcFile = join(stageRoot, dir, "types", rel.slice(dir.length + 1));
      for (const spec of relativeReferences(text, file)) {
        const to = referenceTarget(rel.slice(dir.length + 1), spec);
        if (to === "" || !to.endsWith(".d.ts")) continue;
        const src = join(dirname(srcFile), relative(dirname(rel.slice(dir.length + 1)), to));
        const dest = join(engine, dir, to);
        if (!existsSync(dest) && existsSync(src)) {
          mkdirSync(dirname(dest), { recursive: true });
          cpSync(src, dest);
          queue.push(dest);
        }
      }
    }
    writeFileSync(file, text);
  }
  return [...done].filter((f) => f.startsWith(engine)).length;
}

/**
 * lim（cli）に、ほかの部品（展開した tarball）を node_modules/@liminalia/ に同梱する（bundleDependencies）。
 * 中の部品が使う第三者の依存は cli の依存の欄に集める（同じ名前で範囲が違えば止める）。
 */
export function bundleCli(cliStage, parts, version) {
  const into = join(cliStage, "node_modules", "@liminalia");
  rmSync(join(cliStage, "node_modules"), { recursive: true, force: true });
  mkdirSync(into, { recursive: true });
  const manifest = readJson(join(cliStage, "package.json"));
  const deps = { ...(manifest.dependencies ?? {}) };
  const bundled = [];
  for (const part of parts) {
    const dest = join(into, part.dir);
    mkdirSync(dest, { recursive: true });
    const r = spawnSync("tar", ["-xzf", part.file, "-C", dest, "--strip-components=1"], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`${part.name} を cli の中に展開できません\n${r.stderr}`);
    const pm = readJson(join(dest, "package.json"));
    bundled.push(pm.name);
    deps[pm.name] = version;
    for (const [name, range] of Object.entries(pm.dependencies ?? {})) {
      if (name.startsWith(SCOPE)) continue;
      if (deps[name] !== undefined && deps[name] !== range) throw new Error(`${pm.name} の依存 ${name}（${range}）が、cli の ${deps[name]} と違います`);
      deps[name] = range;
    }
  }
  manifest.dependencies = Object.fromEntries(Object.entries(deps).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  manifest.bundleDependencies = bundled.sort();
  writeFileSync(join(cliStage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/**
 * 配るものを組み立てて npm pack する。部品（NPM_PACKAGES）をすべて組み立てて out/parts に置き、
 * sdk には写したエンジンの型の宣言を足し、cli にはほかの部品を同梱して、npm に出す二つ（NPM_PUBLIC）を out/tarballs に置く。
 */
export function buildNpmPackages(o = {}) {
  const built = buildParts(o);
  const parts = join(built.out, "parts");
  const tarballs = join(built.out, "tarballs");
  rmSync(parts, { recursive: true, force: true });
  mkdirSync(parts, { recursive: true });
  const partsMade = built.tarballs.map((t) => {
    const to = join(parts, basename(t.file));
    cpSync(t.file, to);
    rmSync(t.file);
    return { ...t, file: to, dir: NPM_PACKAGES.find((p) => readJson(join(built.out, "stage", p.dir, "package.json")).name === t.name).dir };
  });
  const stageRoot = join(built.out, "stage");
  // sdk: 約束の型の宣言に、たどれるエンジンの型の宣言を写す
  const sdkStage = join(stageRoot, "sdk");
  const vendored = vendorEngineTypes(stageRoot, sdkStage);
  const sdkManifest = readJson(join(sdkStage, "package.json"));
  if (Object.keys(sdkManifest.dependencies ?? {}).some((n) => n.startsWith(SCOPE))) throw new Error("sdk がエンジンの部品に依っています（約束だけにする）");
  const sdk = { name: sdkManifest.name, stage: sdkStage, ...pack(sdkStage, tarballs, sdkManifest), vendored };
  // cli: ほかの部品を中に同梱する
  const cliStage = join(stageRoot, "cli");
  const cliManifest = bundleCli(cliStage, partsMade.filter((p) => p.dir !== "cli"), built.version);
  const cli = { name: cliManifest.name, stage: cliStage, ...pack(cliStage, tarballs, cliManifest, ["templates/", "node_modules/@liminalia/"]) };
  return { ...built, tarballs: [sdk, cli], parts: partsMade };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const value = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  try {
    const r = buildNpmPackages({ version: value("--version"), out: value("--out") });
    const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;
    console.log(`版 ${r.version}（${relative(process.cwd(), r.out) || "."}/tarballs）`);
    for (const t of r.tarballs) console.log(`  ${t.name}: ${basename(t.file)}（${mb(t.size)}、展開して ${mb(t.unpacked)}、${t.count} ファイル）`);
    if (!r.hasLicense) console.log("注意: リポジトリの直下に LICENSE が無いので、パッケージに利用条件の文書と license を入れていません");
  } catch (e) {
    console.error(`npm のパッケージを作れませんでした: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
