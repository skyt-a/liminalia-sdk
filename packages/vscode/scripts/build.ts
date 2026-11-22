// 拡張機能を dist/ に束ねる。拡張機能の側（VS Code が require する）は CommonJS、
// 言語サーバーは ES モジュール（プラグインを import() で読むため）。
// 束ねた依存の利用条件は dist/THIRD-PARTY-NOTICES.txt にまとめる（.vsix に一緒に入れる。third-party-notices.ts）。
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { bundledPackages, renderNotices } from "./third-party-notices.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });

const common = { bundle: true, platform: "node", target: "node20", sourcemap: true, logLevel: "info", legalComments: "none", metafile: true } as const;

const client = await build({
  ...common,
  entryPoints: [join(root, "src/extension.ts")],
  outfile: join(dist, "extension.cjs"),
  format: "cjs",
  external: ["vscode"],
});

const server = await build({
  ...common,
  entryPoints: [join(root, "src/server.ts")],
  outfile: join(dist, "server.mjs"),
  format: "esm",
  // 束ねた CommonJS のパッケージ（vscode-languageserver）が require を使う
  banner: { js: 'import { createRequire as __limCreateRequire } from "node:module"; const require = __limCreateRequire(import.meta.url);' },
});

// metafile の道筋は cwd からの相対
const inputs = [...Object.keys(client.metafile.inputs), ...Object.keys(server.metafile.inputs)];
const packages = bundledPackages(inputs, process.cwd());
writeFileSync(join(dist, "THIRD-PARTY-NOTICES.txt"), renderNotices(packages));
console.log(`dist/THIRD-PARTY-NOTICES.txt（${packages.length} 個: ${packages.map((p) => p.name).join("、")}）`);
