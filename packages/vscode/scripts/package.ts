// 束ねた拡張機能を .vsix にする（先に build を動かす）。
// npm のワークスペースのままでは vsce が依存を探しに行き、名前の @ も通らないので、
// 配るものだけを一時フォルダに写し、そこで vsce package を動かす。
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(root, "..", "..");
for (const f of ["dist/extension.cjs", "dist/server.mjs", "dist/THIRD-PARTY-NOTICES.txt"]) {
  if (!existsSync(join(root, f))) throw new Error(`${f} がありません。先に npm run -w @liminalia/vscode build を動かしてください`);
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown> & { version: string };
const stage = mkdtempSync(join(tmpdir(), "liminalia-vsix-"));
try {
  cpSync(join(root, "dist/extension.cjs"), join(stage, "dist/extension.cjs"));
  cpSync(join(root, "dist/server.mjs"), join(stage, "dist/server.mjs"));
  // 束ねた依存の利用条件（scripts/third-party-notices.ts。build が作る）
  cpSync(join(root, "dist/THIRD-PARTY-NOTICES.txt"), join(stage, "THIRD-PARTY-NOTICES.txt"));
  cpSync(join(root, "syntaxes"), join(stage, "syntaxes"), { recursive: true });
  // liminalia.json、cast.json、訳のファイル（lang/*.json）の補完と説明（jsonValidation。packages/project/scripts/config-schema.ts が型から作る）
  cpSync(join(root, "schemas"), join(stage, "schemas"), { recursive: true });
  cpSync(join(root, "language-configuration.json"), join(stage, "language-configuration.json"));
  cpSync(join(root, "README.md"), join(stage, "README.md"));
  // 利用条件（package.json の license は "SEE LICENSE IN LICENSE"。npm で配る形と同じ）
  cpSync(join(repo, "LICENSE"), join(stage, "LICENSE"));
  // 画面の言葉（英語が既定、日本語は .ja）とアイコン（icon.png は Marketplace と Open VSX の一覧、file-icon.svg はファイルの一覧で .lim の横に出る）
  for (const f of ["package.nls.json", "package.nls.ja.json", "resources/icon.png", "resources/file-icon.svg"]) cpSync(join(root, f), join(stage, f));

  // 配る package.json。依存は束ねてあるので書かない
  const { name: _name, private: _private, type: _type, scripts: _scripts, dependencies: _deps, devDependencies: _dev, ...rest } = pkg;
  writeFileSync(join(stage, "package.json"), JSON.stringify({ name: "liminalia", ...rest, files: ["dist/*.cjs", "dist/*.mjs", "syntaxes/**", "schemas/**", "language-configuration.json", "README.md", "LICENSE", "THIRD-PARTY-NOTICES.txt", "package.nls.json", "package.nls.ja.json", "resources/icon.png", "resources/file-icon.svg"] }, null, 2));

  const vsceDir = dirname(createRequire(import.meta.url).resolve("@vscode/vsce/package.json"));
  const out = join(root, `liminalia-${pkg.version}.vsix`);
  execFileSync(process.execPath, [join(vsceDir, "vsce"), "package", "--no-dependencies", "--out", out], { cwd: stage, stdio: "inherit" });
  console.log(`${out}（${Math.round(statSync(out).size / 1024)} KB）`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
