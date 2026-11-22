import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProject } from "@liminalia/project";
import { copyScreenUndoable, readScreenFiles, screenDiff } from "../src/server/screen-files.ts";
import { setScreenTemplateRules } from "../src/server/screens.ts";
import { StudioWorkspace } from "../src/server/workspace.ts";
import { screenTemplateRules } from "@liminalia/screens/rules";

/** ゲームの画面のテンプレートの欄が読むもの（../src/server/screen-files.ts。書くものと ⌘Z は file-undo.test.ts）。 */

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
setScreenTemplateRules(screenTemplateRules());
let dir: string;
let ws: StudioWorkspace;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-screen-files-"));
  cpSync(TEMPLATE, dir, { recursive: true });
  ws = await StudioWorkspace.open(loadProject(dir));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("画面のテンプレートの欄", () => {
  it("写す前は登録が無く、決まりの場所を返す", () => {
    expect(readScreenFiles(ws, "confirm")).toMatchObject({
      screen: "confirm",
      registered: false,
      template: { file: "ui/screens/confirm/confirm.html", text: null },
      script: { file: "ui/screens/confirm/confirm.js", text: null },
      overriddenBy: null,
    });
    expect(readScreenFiles(ws, "confirm").path).toBe(resolve(dir, "ui/screens/confirm/confirm.html"));
  });

  it("テンプレートで作れない画面は断る", () => {
    expect(() => readScreenFiles(ws, "extra")).toThrow(/テンプレートで作れる画面ではありません/);
    expect(() => copyScreenUndoable(ws, "extra", undefined)).toThrow(/テンプレートで作れる画面ではありません/);
  });

  it("写したあとは中身を返し、二度目の写しは断る", () => {
    const r = copyScreenUndoable(ws, "confirm", undefined);
    expect(r).toMatchObject({ file: "ui/screens/confirm/confirm.html", parts: ["screen"], registered: true });
    const files = readScreenFiles(ws, "confirm");
    expect(files.registered).toBe(true);
    expect(files.template.text).toContain('data-part="screen"');
    expect(() => copyScreenUndoable(ws, "confirm", undefined)).toThrow(/もうあります/);
  });

  it("ui.templates の値が使われない場所（.html でないものなど）なら登録していない扱いにし、その値を返す", () => {
    const cfg = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(dir, "liminalia.json"), `${JSON.stringify({ ...cfg, ui: { templates: { confirm: "ui/confirm.htm" } } }, null, 2)}\n`);
    expect(readScreenFiles(ws, "confirm")).toMatchObject({ registered: false, misregistered: "ui/confirm.htm", template: { file: "ui/screens/confirm/confirm.html" } });
    writeFileSync(join(dir, "liminalia.json"), `${JSON.stringify({ ...cfg, ui: { templates: { confirm: "ui/confirm.html" } } }, null, 2)}\n`);
    expect(readScreenFiles(ws, "confirm")).toMatchObject({ registered: true, misregistered: null, template: { file: "ui/confirm.html" } });
  });

  it("写せないときの断りは、制作画面に無い CLI の旗を案内しない", () => {
    copyScreenUndoable(ws, "confirm", undefined);
    const cfg = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as { ui: Record<string, unknown> };
    // 決まりの場所にファイルがあり、登録が無い
    writeFileSync(join(dir, "liminalia.json"), `${JSON.stringify({ ...cfg, ui: { ...cfg.ui, templates: undefined } }, null, 2)}\n`);
    const messages: string[] = [];
    for (const parts of [undefined, ["screen"]]) {
      try {
        copyScreenUndoable(ws, "confirm", parts);
      } catch (e) {
        messages.push((e as Error).message);
      }
    }
    expect(() => screenDiff(ws, "confirm")).toThrow(/標準のテンプレートのまま/);
    try {
      screenDiff(ws, "confirm");
    } catch (e) {
      messages.push((e as Error).message);
    }
    expect(messages.length).toBe(3);
    for (const m of messages) expect(m).not.toMatch(/--force|--part|lim screens/);
    expect(messages[0]).toBe("ui/screens/confirm/confirm.html はもうあります（今のファイルに部品を足すなら、コピーする範囲で部品を選びます）");
  });

  it("プラグインの screens.confirm が先に差し替えていれば、そのプラグインと口を返す", () => {
    const plugin = join(dir, "plugins", "look");
    mkdirSync(join(plugin, "src"), { recursive: true });
    writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "look", version: "0.0.0", type: "module", exports: { "./web": "./src/web.ts" } }));
    writeFileSync(join(plugin, "src", "web.ts"), 'import { defineWebPlugin } from "@liminalia/web";\nexport default defineWebPlugin({ name: "look", screens: { confirm: () => document.createElement("div") } });\n');
    const cfg = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(dir, "liminalia.json"), `${JSON.stringify({ ...cfg, plugins: ["./plugins/look"] }, null, 2)}\n`);
    expect(readScreenFiles(ws, "confirm").overriddenBy).toEqual({ plugin: "./plugins/look", hook: "screens.confirm" });
  });

  it("標準との違いは lim screens diff と同じ中身", () => {
    expect(() => screenDiff(ws, "confirm")).toThrow(/標準のテンプレートのまま/);
    copyScreenUndoable(ws, "confirm", undefined);
    const file = join(dir, "ui/screens/confirm/confirm.html");
    writeFileSync(file, readFileSync(file, "utf8").replace("lm-dialog-message", "lm-dialog-message mine"));
    const d = screenDiff(ws, "confirm");
    expect(d.parts).toHaveLength(1);
    expect(d.parts[0]!.authorDiff).toContain("+    <p class=\"lm-dialog-message mine\"");
    expect(d.parts[0]!.standardChange).toBeNull();
  });
});
