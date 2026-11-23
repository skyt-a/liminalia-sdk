/**
 * プラグインのテストの口（@liminalia/cli/testing）。プラグインを書く人が、台本を読んで検査し、画面なしで動かし、
 * プラグインの検査と取り込みを試すためのもの。@liminalia/sdk は約束だけなので、実装の要るものはここから読む。
 * 読み込むと、@liminalia/sdk の実装へつなぐ口（std と取り込み）も使えるようになる。
 */
import "@liminalia/std/commands";
import "@liminalia/ks-import";

export { check, CORE_COMMANDS, createRegistry, parse } from "@liminalia/lang";
export { HeadlessHost, Runtime } from "@liminalia/runtime";
export { checkPluginManifest, combinePlugins, runPluginChecks } from "@liminalia/plugin-host";
export { convert, resolveImportProfile } from "@liminalia/ks-import";
