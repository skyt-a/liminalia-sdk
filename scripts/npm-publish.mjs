#!/usr/bin/env node
/**
 * npm に公開する。公開用のリポジトリ（skyt-a/liminalia-sdk）の .github/workflows/publish-npm.yml（正本は scripts/public/publish-npm.yml）が、
 * そのリポジトリで組み立てた tarball（node scripts/npm-pack-public.mjs）を、OIDC（trusted publishing）で依存の順に出す。
 * 公開する部品（NPM_PUBLIC。sdk とその依存）だけを出し、制作アプリ、web、lim などは出さない（非公開）。
 *
 *   node scripts/npm-publish.mjs <tarball のフォルダ> --version 1.2.3 [--stage] [--same-as <フォルダ>] [--provenance] [--dry-run]
 *
 * - 先にすべての tarball（liminalia-<名前>-<版>.tgz）がそろっているかを見て、足りなければ一つも出さずに止める
 * - --same-as は、渡したフォルダの同じ名前の tarball と、展開した中身（ファイルの一覧と中身）が同じかを先に確かめ、違えば一つも出さずに止める。
 *   正本の release.yml が組み立てて空のフォルダに入れた lim で確かめ、配布用のリポジトリ（skyt-a/liminalia-releases）に置いたものと比べる
 *   （出すのは公開用のリポジトリで組み立てたもの。provenance が本当の出どころを指す。中身は確かめたものと同じ）
 * - --stage は npm stage publish（npm 11.15 以上）。公開の手前で止め、npmjs.com の Staged Packages で 2FA で承認すると公開される
 * - その版がもう npm にあるパッケージは飛ばす（途中で落ちたら、同じ版でもう一度動かせば続きから出す。npm は同じ版を出し直せない）。
 *   承認待ちの版は npm view に出ないので、承認待ちのまま動かし直すと、npm がもう待っている版を断って止まる
 * - 版に - が入る（1.2.3-beta.1）なら dist-tag を next にする（npm install @liminalia/sdk が入れる latest を動かさない）
 * - --provenance は出どころの証明を付ける（公開のリポジトリから GitHub のランナーで出すとき）。--dry-run は何も出さない
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NPM_PUBLIC } from "./npm-pack-public.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** npm pack が付ける tarball の名前（@liminalia/web → liminalia-web-1.2.3.tgz）。 */
export const tarballName = (name, version) => `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;

/** 出す dist-tag。版に - が入るもの（1.2.3-beta.1）は next。 */
export const distTag = (version) => (version.includes("-") ? "next" : "latest");

/** 出すもの（依存の順）と、足りない tarball。names は NPM_PACKAGES の順のパッケージの名前。 */
export function publishOrder(dir, version, names) {
  const order = names.map((name) => ({ name, file: join(dir, tarballName(name, version)) }));
  return { order, missing: order.filter((p) => !existsSync(p.file)).map((p) => tarballName(p.name, version)) };
}

/** その版が npm にもうあるか。無いパッケージ（E404）と無い版は false。ほかの失敗（つながらないなど）は投げる。 */
export function alreadyPublished(name, version, run = npm) {
  const r = run(["view", `${name}@${version}`, "version", "--json"]);
  if (r.status !== 0) {
    if (/E404|404 Not Found/.test(`${r.stdout}${r.stderr}`)) return false;
    throw new Error(`npm で ${name}@${version} があるかを確かめられません\n${r.stderr}`);
  }
  return r.stdout.trim() !== "";
}

/** tarball を展開した中身（ファイルの道筋 → 中身）。 */
function tarballContents(file) {
  const dir = mkdtempSync(join(tmpdir(), "liminalia-npm-tgz-"));
  try {
    const r = spawnSync("tar", ["-xzf", file, "-C", dir], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`${file} を展開できません\n${r.stderr}`);
    const out = new Map();
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out.set(relative(dir, p).split("\\").join("/"), readFileSync(p));
      }
    };
    walk(dir);
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 二つの tarball の展開した中身の違い（無ければ空）。tarball そのもの（圧縮や時刻）は比べない。 */
export function contentDifferences(a, b, read = tarballContents) {
  const x = read(a);
  const y = read(b);
  const out = [];
  for (const [path, data] of x) {
    if (!y.has(path)) out.push(`${path} が片方にしかありません`);
    else if (!data.equals(y.get(path))) out.push(`${path} の中身が違います`);
  }
  for (const path of y.keys()) if (!x.has(path)) out.push(`${path} が片方にしかありません`);
  return out;
}

function npm(args) {
  return spawnSync("npm", args, { encoding: "utf8", shell: process.platform === "win32" });
}

/** 依存の順に出す。出したもの、飛ばしたものを返す。run は npm を動かす口（テストで差し替える）。 */
export function publishAll(o) {
  const { dir, version, dryRun = false, stage = false, provenance = false, sameAs, run = npm, log = console.log, differences = contentDifferences } = o;
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`版は 1.2.3 の形で書きます: ${version}`);
  const names = o.names ?? NPM_PUBLIC.map((dir) => JSON.parse(readFileSync(join(ROOT, "packages", dir, "package.json"), "utf8")).name);
  const { order, missing } = publishOrder(dir, version, names);
  if (missing.length > 0) throw new Error(`tarball が足りないので、一つも出しません: ${missing.join("、")}（${dir}）`);
  if (sameAs) {
    const other = publishOrder(sameAs, version, names);
    if (other.missing.length > 0) throw new Error(`比べる tarball が足りないので、一つも出しません: ${other.missing.join("、")}（${sameAs}）`);
    const bad = order.flatMap((p, i) => differences(p.file, other.order[i].file).map((d) => `${p.name}: ${d}`));
    if (bad.length > 0) throw new Error(`確かめた tarball と中身が違うので、一つも出しません（${sameAs}）\n  ${bad.slice(0, 20).join("\n  ")}`);
    log(`確かめた tarball と中身が同じです: ${names.join("、")}`);
  }
  const tag = distTag(version);
  const published = [];
  const skipped = [];
  for (const p of order) {
    if (alreadyPublished(p.name, version, run)) {
      log(`飛ばします: ${p.name}@${version} はもう npm にあります`);
      skipped.push(p.name);
      continue;
    }
    const r = run([...(stage ? ["stage", "publish"] : ["publish"]), p.file, "--access", "public", "--tag", tag, ...(provenance ? ["--provenance"] : []), ...(dryRun ? ["--dry-run"] : [])]);
    if (r.status !== 0) throw new Error(`${p.name}@${version} を出せません（出したもの: ${published.join("、") || "なし"}。同じ版でもう一度動かすと続きから出します）\n${r.stderr}`);
    log(`${dryRun ? "出せます（--dry-run）" : stage ? "承認待ちにしました" : "出しました"}: ${p.name}@${version}（dist-tag ${tag}）`);
    published.push(p.name);
  }
  return { published, skipped, tag };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const value = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dir = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--version" && args[i - 1] !== "--same-as");
  const version = value("--version");
  const sameAs = value("--same-as");
  if (!dir || !version) {
    console.error("使い方: node scripts/npm-publish.mjs <tarball のフォルダ> --version 1.2.3 [--stage] [--same-as <フォルダ>] [--provenance] [--dry-run]");
    process.exit(2);
  }
  try {
    const stage = args.includes("--stage");
    const r = publishAll({ dir: resolve(dir), version, dryRun: args.includes("--dry-run"), stage, provenance: args.includes("--provenance"), ...(sameAs ? { sameAs: resolve(sameAs) } : {}) });
    console.log(`npm: ${r.published.length} 個${args.includes("--dry-run") ? "を確かめました" : stage ? "を承認待ちにしました（npmjs.com の Staged Packages で承認すると公開されます）" : "を出しました"}、${r.skipped.length} 個はもうありました（dist-tag ${r.tag}）`);
  } catch (e) {
    console.error(`npm に公開できませんでした: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
