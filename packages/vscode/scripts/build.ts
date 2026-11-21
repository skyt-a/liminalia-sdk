// 拡張機能を dist/ に束ねる。拡張機能の側（VS Code が require する）は CommonJS、
// 言語サーバーは ES モジュール（プラグインを import() で読むため）。
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });

const common = { bundle: true, platform: "node", target: "node20", sourcemap: true, logLevel: "info", legalComments: "none" } as const;

await build({
  ...common,
  entryPoints: [join(root, "src/extension.ts")],
  outfile: join(dist, "extension.cjs"),
  format: "cjs",
  external: ["vscode"],
});

await build({
  ...common,
  entryPoints: [join(root, "src/server.ts")],
  outfile: join(dist, "server.mjs"),
  format: "esm",
  // 束ねた CommonJS のパッケージ（vscode-languageserver）が require を使う
  banner: { js: 'import { createRequire as __limCreateRequire } from "node:module"; const require = __limCreateRequire(import.meta.url);' },
});
