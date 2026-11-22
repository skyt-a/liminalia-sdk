#!/usr/bin/env node
// lim コマンドの入口。TypeScript のまま動かす（tsx）。作品のプラグインが読む @liminalia/… は、作品に無ければ lim のものを使う（hooks.mjs）。
import { register } from "node:module";
import { register as registerTsx } from "tsx/esm/api";
registerTsx();
register("./hooks.mjs", import.meta.url, { data: { base: import.meta.url } });
await import("../src/main.ts");
