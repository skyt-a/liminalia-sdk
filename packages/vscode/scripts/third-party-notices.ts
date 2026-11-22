// 束ねた依存（node_modules から dist/ に入ったもの）の利用条件を一つにまとめる（THIRD-PARTY-NOTICES.txt）。
// MIT や ISC は、写しに著作権の表示と許諾の文を入れることを求めるので、.vsix に一緒に入れる。
// 一覧は手で書かず、esbuild の metafile（実際に束ねたファイル）から作る。利用条件の文が見つからない依存があれば止める。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface BundledPackage {
  name: string;
  version: string;
  license: string;
  /** 利用条件の文（パッケージに入っている LICENSE などのファイルの中身）。 */
  text: string;
}

/** 束ねたファイルの道筋から、それが入っている node_modules のパッケージのフォルダを返す（node_modules の外なら undefined）。 */
export function packageDirOf(file: string): string | undefined {
  const parts = file.split(/[\\/]/);
  const at = parts.lastIndexOf("node_modules");
  const first = parts[at + 1];
  if (at < 0 || first === undefined) return undefined;
  const scoped = first.startsWith("@");
  if (scoped && at + 2 >= parts.length) return undefined;
  return parts.slice(0, at + (scoped ? 3 : 2)).join("/");
}

const LICENSE_FILE = /^(?:licen[cs]e|copying)(?:[.-].*)?$/i;

/** パッケージのフォルダから名前、版、利用条件の文を読む。利用条件の文のファイルが無ければ投げる。 */
export function readBundledPackage(dir: string): BundledPackage {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string; version: string; license?: string | { type?: string } };
  const file = readdirSync(dir).filter((f) => LICENSE_FILE.test(f)).sort()[0];
  if (!file) throw new Error(`${pkg.name}@${pkg.version} に利用条件の文のファイル（LICENSE など）がありません（${dir}）`);
  const license = typeof pkg.license === "string" ? pkg.license : (pkg.license?.type ?? "UNKNOWN");
  return { name: pkg.name, version: pkg.version, license, text: readFileSync(join(dir, file), "utf8").trim() };
}

/** metafile の inputs の道筋（cwd からの相対）から、束ねた依存を名前の順で返す（同じ名前と版は一つにまとめる）。 */
export function bundledPackages(inputs: Iterable<string>, cwd: string, read: (dir: string) => BundledPackage = readBundledPackage): BundledPackage[] {
  const dirs = new Set<string>();
  for (const input of inputs) {
    const dir = packageDirOf(input);
    if (dir) dirs.add(resolve(cwd, dir));
  }
  const byId = new Map<string, BundledPackage>();
  for (const dir of dirs) {
    if (!existsSync(join(dir, "package.json"))) continue;
    const p = read(dir);
    byId.set(`${p.name}@${p.version}`, p);
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** THIRD-PARTY-NOTICES.txt の中身。 */
export function renderNotices(packages: readonly BundledPackage[]): string {
  const head = [
    "THIRD-PARTY NOTICES",
    "",
    "The Liminalia extension bundles the following third-party packages.",
    "Their copyright notices and license terms are reproduced below.",
    "",
    ...packages.map((p) => `- ${p.name}@${p.version} (${p.license})`),
  ];
  const body = packages.map((p) => ["", "=".repeat(72), `${p.name}@${p.version} (${p.license})`, "=".repeat(72), "", p.text].join("\n"));
  return `${[...head, ...body].join("\n")}\n`;
}
