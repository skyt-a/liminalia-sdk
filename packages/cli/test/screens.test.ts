import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkScreenTemplates } from "@liminalia/lang";
import { projectFileReader } from "@liminalia/project";
import { copyScreen, splitTemplateParts } from "@liminalia/project/screen-copy";
import { screenTemplateRules, STANDARD_SCREENS } from "@liminalia/web/screen-rules";

/** lim screens（標準の画面のテンプレートを写す、標準との違いを見る、標準に戻す、画面の JS の雛形を置く）。ひな形の写しで動かす。 */

const bin = new URL("../bin/lim.mjs", import.meta.url).pathname;
const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
const EN_ENV = { ...process.env, LIMINALIA_LANG: "", LC_ALL: "", LC_MESSAGES: "", LANG: "en_US.UTF-8" };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-screens-"));
  cpSync(TEMPLATE, dir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const lim = (args: string[], env?: NodeJS.ProcessEnv) => spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", cwd: dir, ...(env ? { env } : {}) });
const config = () => JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as { ui?: { templates?: Record<string, string> } };

describe("lim screens", () => {
  it("標準の画面の一覧にある画面はどれも、写した直後のテンプレートと画面の JS の雛形を検査が何も知らせない（画面が増えても写せる）", () => {
    for (const screen of Object.keys(STANDARD_SCREENS)) {
      copyScreen(dir, STANDARD_SCREENS, screen, { js: true });
      const ui = (JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as { ui: { templates: unknown } }).ui;
      const list = checkScreenTemplates({ templates: ui.templates, rules: screenTemplateRules(), read: projectFileReader(dir).text });
      expect(list, screen).toEqual([]);
      // 部品ごとに分けた全体が、標準の部品と同じ字面
      const mine = splitTemplateParts(readFileSync(join(dir, `ui/screens/${screen}/${screen}.html`), "utf8")).map((p) => p.text);
      expect(mine, screen).toEqual(splitTemplateParts(STANDARD_SCREENS[screen]!.template).map((p) => p.text));
    }
  });

  it("copy で標準のテンプレートを写して登録し、写した直後は lim check がテンプレートを何も知らせない", () => {
    const r = lim(["screens", "copy", "confirm", "--js"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("ui/screens/confirm/confirm.html に画面 confirm のテンプレートをコピーしました");
    expect(config().ui?.templates).toEqual({ confirm: "ui/screens/confirm/confirm.html" });
    expect(readFileSync(join(dir, "ui/screens/confirm/confirm.html"), "utf8")).toContain(STANDARD_SCREENS.confirm!.template);
    expect(existsSync(join(dir, "ui/screens/confirm/confirm.js"))).toBe(true);
    expect(existsSync(join(dir, ".liminalia/screens/confirm/screen.2.html"))).toBe(true);
    const check = lim(["check", "--json"]);
    const { diagnostics } = JSON.parse(check.stdout) as { diagnostics: { code: string }[] };
    expect(diagnostics.filter((d) => d.code.startsWith("template-") || d.code.startsWith("screen-script-"))).toEqual([]);
    // あるファイルは --force が無ければ書かない
    const again = lim(["screens", "copy", "confirm"]);
    expect(again.status).toBe(2);
    expect(again.stderr).toContain("ui/screens/confirm/confirm.html はもうあります");
  }, 90_000);

  it("古い版から写したテンプレートは、lim check が lim screens diff を案内し、diff が違いを出す", () => {
    lim(["screens", "copy", "confirm"]);
    const file = join(dir, "ui/screens/confirm/confirm.html");
    writeFileSync(file, readFileSync(file, "utf8").replace('data-version="2"', 'data-version="0"').replace("lm-dialog-buttons", "lm-dialog-buttons my-buttons"));
    const check = (JSON.parse(lim(["check", "--json"]).stdout) as { diagnostics: { code: string; hint?: string }[] }).diagnostics;
    expect(check.find((d) => d.code === "template-outdated")?.hint).toContain("lim screens diff confirm");
    const d = lim(["screens", "diff", "confirm"]);
    expect(d.status, d.stderr).toBe(0);
    expect(d.stdout).toContain('+    <div class="lm-dialog-buttons my-buttons">');
    expect(d.stdout).toContain("部品 screen: バージョン 0 からバージョン 2 に変わりました（コピー元のファイルが .liminalia/screens に無いので、バージョン番号だけを表示します）");
    const json = JSON.parse(lim(["screens", "diff", "confirm", "--json"]).stdout) as { parts: { part: string; standardChange: unknown }[] };
    expect(json.parts[0]).toMatchObject({ part: "screen", standardChange: { from: 0, now: 2, missingOriginal: true } });
  }, 90_000);

  it("reset で登録を外し、ファイルは名前を変えて残す。英語でも日本語を出さない", () => {
    lim(["screens", "copy", "confirm", "--js"]);
    const r = lim(["screens", "reset", "confirm", "--lang", "en"], EN_ENV);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Removed ui.templates.confirm from liminalia.json");
    expect(r.stdout).not.toMatch(/[぀-ヿ㐀-鿿]/);
    expect(config().ui?.templates).toBeUndefined();
    expect(readdirSync(join(dir, "ui/screens/confirm")).every((f) => /^confirm\.reset-\d{8}-\d{6}\.(html|js)$/.test(f))).toBe(true);
    const js = lim(["screens", "js", "confirm"]);
    expect(js.status, js.stderr).toBe(0);
    expect(existsSync(join(dir, "ui/screens/confirm/confirm.js"))).toBe(true);
    const unknown = lim(["screens", "copy", "nothing", "--lang", "en"], EN_ENV);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("nothing isn't a screen you can build from a template");
  }, 90_000);
});
