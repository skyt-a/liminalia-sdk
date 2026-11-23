#!/usr/bin/env node
// lim コマンドの入口。TypeScript のまま動かす（tsx）。作品のプラグインが読む @liminalia/… は、作品に無ければ lim のものを使う（hooks.mjs）。
import { register } from "node:module";
import { register as registerTsx } from "tsx/esm/api";
registerTsx();
// 探し直す起点は src の中（npm で入れた lim は、エンジンの部品を src/node_modules/@liminalia/ に持つ。scripts/npm-pack-public.mjs の bundleCli）
register("./hooks.mjs", import.meta.url, { data: { base: new URL("../src/main.ts", import.meta.url).href } });
await import("../src/main.ts");
