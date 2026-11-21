import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pluginScreens, webPluginScreens } from "../src/screen-templates.ts";

/** プラグインの "./web" の字面から、差し替える画面を読む（@liminalia/web の ui-probe.ts の replacedScreens と同じ見方）。 */
describe("プラグインが差し替える画面", () => {
  it("screens の項目、system、title を読む", () => {
    const source = `import type { WebPlugin } from "@liminalia/web";
const plugin: WebPlugin = {
  name: "frame",
  // screens: { menu } はコメントなので読まない
  screens: {
    confirm(api) {
      const box = { backlog: 1 };
      return box;
    },
    "saveload": (api) => api,
    ...extra,
  },
  title: (ctx) => ctx,
};
export default plugin;`;
    expect(webPluginScreens(source)).toEqual({ replaces: ["title", "screens.confirm", "screens.saveload"], themes: {} });
    expect(webPluginScreens(`export default { name: "all", system: (ctx) => make(ctx) };`).replaces).toEqual(["system"]);
  });

  it("テーマの screens は、テーマの名前ごとに分ける", () => {
    const source = `export default definePlugin({ name: "t", themes: { dark: { screens: { confirm: () => {} }, rootClass: "x" }, light: { title: () => {} } } });`;
    expect(webPluginScreens(source)).toEqual({ replaces: [], themes: { dark: ["screens.confirm"], light: ["title"] } });
  });

  it("プラグインでないオブジェクト（name と title だけ）、文字列とテンプレート文字列の中は読まない", () => {
    expect(webPluginScreens(`const pages = [{ name: "a", title: "b" }]; const s = "{ name: 'x', screens: { confirm } }"; const t = \`\${"{"} screens: { confirm }\`;`)).toEqual({ replaces: [], themes: {} });
  });

  const work = mkdtempSync(join(tmpdir(), "liminalia-plugin-screens-"));
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it("liminalia.json の plugins の package.json の ./web の入口を読む（無いもの、./web の無いものは飛ばす）", () => {
    const dir = join(work, "plugins/frame");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "frame", exports: { "./web": "./src/web.ts" } }));
    writeFileSync(join(dir, "src/web.ts"), `export default { name: "frame", screens: { confirm: () => undefined } };`);
    const bare = join(work, "plugins/bare");
    mkdirSync(bare, { recursive: true });
    writeFileSync(join(bare, "package.json"), JSON.stringify({ name: "bare", exports: { "./commands": "./c.ts" } }));
    expect(pluginScreens(work, ["./plugins/frame", "./plugins/bare", "./plugins/gone", "not-installed", 3])).toEqual([{ plugin: "./plugins/frame", replaces: ["screens.confirm"] }]);
  });
});
