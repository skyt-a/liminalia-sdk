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
import { basename, dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PACKAGES_DIR = join(ROOT, "packages");
export const SCOPE = "@liminalia/";
const HOMEPAGE = "https://liminalia.skyta.dev/";

/** npm に出す部品（依存の順）。プラグインを書く人が入れる sdk と、その依存だけ。 */
export const NPM_PUBLIC = ["lang", "runtime", "sdk"];

/** npm のページから辿れる、ソースの場所（公開用のリポジトリ）。 */
export const PUBLIC_REPOSITORY = "https://github.com/skyt-a/liminalia-sdk";

/**
 * NPM_PUBLIC の組み立て方。dir: packages/<dir>、js: dist/ に JavaScript も作る、types: false なら型の宣言を作らない、
 * entries と files: src のほかに入れるもの、peers: 入れなくてよい相手の部品。
 */
export const PUBLIC_SPECS = [
  { dir: "lang", js: true },
  { dir: "runtime", js: true },
  { dir: "sdk", js: true },
];

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
export function itemFiles(from, items) {
  const out = new Set();
  for (const item of items) {
    const path = join(from, item);
    if (!existsSync(path)) continue;
    const files = statSync(path).isDirectory() ? walk(path).map((f) => toPosix(relative(from, f))) : [toPosix(item)];
    for (const f of files) if (!skippedPath(f)) out.add(f);
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
  const pkg = readJson(join(from, "package.json"));
  const items = [];
  const files = new Set();
  const queue = [];
  const include = (item) => {
    if (items.includes(item)) return;
    if (!existsSync(join(from, item))) throw new Error(`${relative(ROOT, join(from, item))} がありません`);
    items.push(item);
    for (const f of itemFiles(from, [item])) {
      if (files.has(f)) continue;
      files.add(f);
      queue.push(f);
    }
  };
  for (const item of ["src", ...(spec.entries ?? []), ...(spec.files ?? [])]) include(item);
  const targets = (v) => (typeof v === "string" ? [v] : Object.values(v ?? {}).flatMap(targets));
  for (const t of [...targets(pkg.exports), ...targets(pkg.bin)]) {
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
 *   omit: 入れない依存の名前、optional: optionalDependencies に回す依存の名前、extraFiles: files に足すもの、liminalia: package.json の liminalia の欄
 */
export function publishManifest(pkg, o) {
  const { spec } = o;
  const pin = (deps) => Object.fromEntries(Object.entries(deps ?? {}).map(([name, range]) => [name, name.startsWith(SCOPE) ? o.version : range]));
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    if (name.startsWith(SCOPE) && !o.packed.includes(name)) throw new Error(`${pkg.name} の依存 ${name} は配るパッケージに入っていません`);
  }
  const dependencies = pin(pkg.dependencies);
  for (const name of o.omit ?? []) delete dependencies[name];
  const optionalDependencies = {};
  for (const name of o.optional ?? []) {
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
        ...(spec.js ? { node: jsPath(target) } : {}),
        default: target,
      };
    }
    // パッケージの場所を require.resolve で探せるように
    if (!exports["./package.json"]) exports["./package.json"] = "./package.json";
  }
  const items = (o.items ?? ["src", ...(spec.entries ?? []), ...(spec.files ?? [])]).filter((i) => i !== "src");
  const files = ["src", ...(spec.types === false ? [] : ["types"]), ...(spec.js ? ["dist"] : []), ...items, ...(o.extraFiles ?? [])];
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
    ...(o.liminalia ? { liminalia: o.liminalia } : {}),
    // 組織のスコープ（@liminalia）のパッケージは、既定では有料の非公開になるので、公開で出す
    publishConfig: { access: "public" },
  };
  if (Object.keys(out.engines).length === 0) delete out.engines;
  return out;
}

/** パッケージのフォルダの中の、配る形に入れるもの（packageItems）を写す。 */
function stageSources(from, to, items) {
  const filter = (src) => {
    const name = basename(src);
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

function tsc(work, name, compilerOptions, include) {
  const config = join(work, `tsconfig.${name}.json`);
  writeFileSync(
    config,
    JSON.stringify(
      {
        extends: join(ROOT, "tsconfig.json"),
        compilerOptions: { rootDir: PACKAGES_DIR, typeRoots: [join(ROOT, "node_modules/@types")], noUnusedLocals: false, noUnusedParameters: false, allowJs: false, ...compilerOptions },
        include,
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
  for (const [key, value] of Object.entries(manifest.exports ?? {})) for (const t of targets(value)) want(t, `exports の ${key}`);
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
  tsc(work, "types", { noEmit: false, declaration: true, emitDeclarationOnly: true, outDir: join(work, "types"), rewriteRelativeImportExtensions: true }, [
    ...typed.map((p) => join(PACKAGES_DIR, p.dir, "src/**/*.ts")),
    ...typed.flatMap((p) => itemsOf.get(p.dir).filter((f) => /\.ts$/.test(f) && !/\.d\.ts$/.test(f)).map((f) => join(PACKAGES_DIR, p.dir, f))),
  ]);
  const withJs = specs.filter((p) => p.js);
  if (withJs.length > 0) tsc(work, "js", { noEmit: false, declaration: false, outDir: join(work, "js"), allowImportingTsExtensions: false, rewriteRelativeImportExtensions: true, sourceMap: false }, withJs.map((p) => join(PACKAGES_DIR, p.dir, "src/**/*.ts")));

  const made = [];
  for (const spec of specs) {
    const from = join(PACKAGES_DIR, spec.dir);
    const pkg = readJson(join(from, "package.json"));
    const stage = join(stageRoot, spec.dir);
    mkdirSync(stage, { recursive: true });
    const items = itemsOf.get(spec.dir);
    stageSources(from, stage, items);
    if (spec.types !== false) {
      const types = join(work, "types", spec.dir);
      for (const f of walk(types)) {
        const to = join(stage, "types", relative(types, f));
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, rewriteDeclarationImports(readFileSync(f, "utf8")));
      }
      // 手で書いた宣言（src の .d.ts）も型の側に置く
      for (const f of walk(join(from, "src")).filter((x) => x.endsWith(".d.ts"))) {
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

/** npm に出す部品（PUBLIC_SPECS）を組み立てる。 */
export const buildPublicPackages = (o = {}) => buildPackages({ ...o, specs: PUBLIC_SPECS });

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const value = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  try {
    const r = buildPublicPackages({ version: value("--version"), out: value("--out") });
    const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;
    console.log(`版 ${r.version}（${relative(process.cwd(), r.out) || "."}/tarballs）`);
    for (const t of r.tarballs) console.log(`  ${t.name}: ${basename(t.file)}（${mb(t.size)}、展開して ${mb(t.unpacked)}、${t.count} ファイル）`);
    if (!r.hasLicense) console.log("注意: リポジトリの直下に LICENSE が無いので、パッケージに利用条件の文書と license を入れていません");
  } catch (e) {
    console.error(`npm のパッケージを作れませんでした: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
