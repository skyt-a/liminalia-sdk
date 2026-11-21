import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyScreen, diffScreen, resetScreen, screenScriptPath, screenTemplatePath, splitTemplateParts, unifiedDiff, writeScreenScript } from "../src/screen-copy.ts";

/**
 * 標準の画面のテンプレートを作品に写す、標準との違いを出す、標準に戻す（docs/design/screen-templates.md の「写し出し」）。
 * 標準の画面は、テンプレートの字面だけを持つ一覧（@liminalia/web/screen-rules の STANDARD_SCREENS と同じ形）で渡す。
 */

const SAVES_V1 = `<template data-part="screen" data-version="2">
<div class="lm-saves">
  <ol class="lm-slot-list" data-list="slots" data-item="slot"></ol>
  <button data-role="close" data-text="common.close"></button>
</div>
</template>
<template data-part="slot" data-version="1">
<li class="lm-slot"><span data-field="title"></span></li>
</template>
`;

/** 標準の一行が版 2 に変わったもの。 */
const SAVES_V2 = SAVES_V1.replace('<template data-part="slot" data-version="1">\n<li class="lm-slot"><span data-field="title"></span></li>', '<template data-part="slot" data-version="2">\n<li class="lm-slot"><span data-field="title"></span><time data-field="date"></time></li>');

const screens = (template: string) => ({ saves: { template }, confirm: { template: `<template data-part="screen" data-version="1">\n<div class="lm-dialog"></div>\n</template>\n` } });

let dir: string;
const config = () => JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as { ui?: { templates?: Record<string, string> }; title: string };
const read = (path: string) => readFileSync(join(dir, path), "utf8");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-screen-copy-"));
  writeFileSync(join(dir, "liminalia.json"), `${JSON.stringify({ title: "t", ui: { text: { size: 30 } } }, null, 2)}\n`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("テンプレートを部品に分ける", () => {
  it("一番外の <template data-part> を、字面のまま版と一緒に取り出す（中の <template> とコメントは部品の中）", () => {
    const parts = splitTemplateParts(`<!-- <template data-part="x"> -->\n<style>.a{}</style>\n${SAVES_V1}<template data-part="outer"><template data-part="inner"></template></template>`);
    expect(parts.map((p) => [p.name, p.version])).toEqual([
      ["screen", 2],
      ["slot", 1],
      ["outer", undefined],
    ]);
    expect(parts[1]!.text).toBe('<template data-part="slot" data-version="1">\n<li class="lm-slot"><span data-field="title"></span></li>\n</template>');
    expect(parts[2]!.text).toBe('<template data-part="outer"><template data-part="inner"></template></template>');
  });
});

describe("写し出し", () => {
  it("画面の全体を ui/screens/<画面>/<画面>.html に写し、ui.templates に登録し、元の文字を .liminalia/screens/ に残す", () => {
    const r = copyScreen(dir, screens(SAVES_V1), "saves", { engine: "0.4.0" });
    expect(r.file).toBe("ui/screens/saves/saves.html");
    expect(r.parts).toEqual(["screen", "slot"]);
    expect(r.registered).toBe(true);
    const html = read("ui/screens/saves/saves.html");
    expect(html.startsWith("<!-- 標準の画面 saves のテンプレート（Liminalia 0.4.0）から写した")).toBe(true);
    expect(html).toContain("<style>\n</style>");
    expect(html).toContain(SAVES_V1);
    // ほかの設定と並びは残る
    expect(config()).toEqual({ title: "t", ui: { text: { size: 30 }, templates: { saves: "ui/screens/saves/saves.html" } } });
    expect(readFileSync(join(dir, "liminalia.json"), "utf8").endsWith("}\n")).toBe(true);
    expect(read(".liminalia/screens/saves/screen.2.html")).toBe(splitTemplateParts(SAVES_V1)[0]!.text);
    expect(read(".liminalia/screens/saves/slot.1.html")).toBe(splitTemplateParts(SAVES_V1)[1]!.text);
  });

  it("あるファイルは --force が無ければ上書きしない。--force なら書き直す", () => {
    copyScreen(dir, screens(SAVES_V1), "saves");
    writeFileSync(join(dir, "ui/screens/saves/saves.html"), "作者の直し");
    expect(() => copyScreen(dir, screens(SAVES_V1), "saves")).toThrow(/ui\/screens\/saves\/saves\.html はもうあります/);
    expect(read("ui/screens/saves/saves.html")).toBe("作者の直し");
    copyScreen(dir, screens(SAVES_V1), "saves", { force: true });
    expect(read("ui/screens/saves/saves.html")).toContain(SAVES_V1);
  });

  it("部品の一つだけを写す。あるファイルには部品を足し、同じ部品があれば --force が無ければ書かない", () => {
    const r = copyScreen(dir, screens(SAVES_V1), "saves", { parts: ["slot"] });
    expect(r.parts).toEqual(["slot"]);
    let html = read("ui/screens/saves/saves.html");
    expect(splitTemplateParts(html).map((p) => p.name)).toEqual(["slot"]);
    expect(existsSync(join(dir, ".liminalia/screens/saves/screen.2.html"))).toBe(false);
    // 作者が一行を直してから、全体の部品を足す
    writeFileSync(join(dir, "ui/screens/saves/saves.html"), html.replace("lm-slot", "lm-slot my-slot"));
    copyScreen(dir, screens(SAVES_V1), "saves", { parts: ["screen"] });
    html = read("ui/screens/saves/saves.html");
    expect(splitTemplateParts(html).map((p) => p.name)).toEqual(["slot", "screen"]);
    expect(html).toContain("lm-slot my-slot");
    expect(() => copyScreen(dir, screens(SAVES_V1), "saves", { parts: ["slot"] })).toThrow(/部品 slot はもう/);
    copyScreen(dir, screens(SAVES_V1), "saves", { parts: ["slot"], force: true });
    html = read("ui/screens/saves/saves.html");
    expect(html).not.toContain("my-slot");
    expect(splitTemplateParts(html).map((p) => p.name)).toEqual(["slot", "screen"]);
  });

  it("知らない画面と部品は、選べるものを添えて断る", () => {
    expect(() => copyScreen(dir, screens(SAVES_V1), "savs")).toThrow(/テンプレートで作れる画面: saves、confirm/);
    expect(() => copyScreen(dir, screens(SAVES_V1), "saves", { parts: ["row"] })).toThrow(/部品の名前: screen、slot/);
    expect(existsSync(join(dir, "ui"))).toBe(false);
  });

  it("登録した場所が決まりと違えば、登録した場所に写す", () => {
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ title: "t", ui: { templates: { saves: "my/saves.html" } } }));
    expect(copyScreen(dir, screens(SAVES_V1), "saves").file).toBe("my/saves.html");
    expect(existsSync(join(dir, "my/saves.html"))).toBe(true);
    expect(screenTemplatePath(config().ui, "saves")).toBe("my/saves.html");
    expect(screenScriptPath(config().ui, "saves")).toBe("my/saves.js");
    expect(screenScriptPath(config().ui, "confirm")).toBe("ui/screens/confirm/confirm.js");
  });

  it("画面の JS の雛形を置く（あれば --force が無ければ上書きしない）", () => {
    const file = writeScreenScript(dir, screens(SAVES_V1), "saves");
    expect(file).toBe("ui/screens/saves/saves.js");
    expect(read(file)).toMatch(/export default function \(screen, api\)/);
    writeFileSync(join(dir, file), "export default () => {};");
    expect(() => writeScreenScript(dir, screens(SAVES_V1), "saves")).toThrow(/ui\/screens\/saves\/saves\.js はもうあります/);
    writeScreenScript(dir, screens(SAVES_V1), "saves", { force: true });
    expect(read(file)).toMatch(/api\.values/);
    // テンプレートといっしょに置く
    expect(copyScreen(dir, screens(SAVES_V1), "confirm", { js: true }).script).toBe("ui/screens/confirm/confirm.js");
  });
});

describe("標準との違い", () => {
  it("作品のテンプレートと今の標準の差分と、写した元の版から標準が変わったところを出す", () => {
    copyScreen(dir, screens(SAVES_V1), "saves");
    writeFileSync(join(dir, "ui/screens/saves/saves.html"), read("ui/screens/saves/saves.html").replace('<li class="lm-slot">', '<li class="lm-slot my-slot">'));
    const d = diffScreen(dir, screens(SAVES_V2), "saves");
    expect(d.file).toBe("ui/screens/saves/saves.html");
    const slot = d.parts.find((p) => p.part === "slot")!;
    expect(slot.version).toBe(1);
    expect(slot.standardVersion).toBe(2);
    expect(slot.authorDiff).toContain('-<template data-part="slot" data-version="2">');
    expect(slot.authorDiff).toContain('+<li class="lm-slot my-slot"><span data-field="title"></span></li>');
    expect(slot.standardChange).toEqual({ from: 1, now: 2, diff: expect.stringContaining('+<li class="lm-slot"><span data-field="title"></span><time data-field="date"></time></li>') });
    // 標準の変わったところには作者の直しが混ざらない
    expect(slot.standardChange && "diff" in slot.standardChange ? slot.standardChange.diff : "").not.toContain("my-slot");
    const screen = d.parts.find((p) => p.part === "screen")!;
    expect(screen.authorDiff).toBe("");
    expect(screen.standardChange).toBeNull();
  });

  it("写した元の文字が無ければ、版の番号だけを出す。登録が無ければ断る", () => {
    copyScreen(dir, screens(SAVES_V1), "saves");
    rmSync(join(dir, ".liminalia"), { recursive: true });
    const slot = diffScreen(dir, screens(SAVES_V2), "saves").parts.find((p) => p.part === "slot")!;
    expect(slot.standardChange).toEqual({ from: 1, now: 2, missingOriginal: true });
    expect(() => diffScreen(dir, screens(SAVES_V2), "confirm")).toThrow(/confirm は標準のテンプレートのままです/);
  });

  it("差分の形（unified diff）", () => {
    expect(unifiedDiff("a\nb\nc\n", "a\nB\nc\n", "前", "後")).toBe("--- 前\n+++ 後\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n");
    expect(unifiedDiff("a\n", "a\n", "前", "後")).toBe("");
  });

  it("改行が CRLF のファイルも、行の中身だけで比べる（改行の違いだけなら差分は無い）", () => {
    expect(unifiedDiff("a\nb\nc\n", "a\r\nb\r\nc\r\n", "標準", "作品")).toBe("");
    expect(unifiedDiff("a\nb\nc\n", "a\r\nB\r\nc\r\n", "標準", "作品")).toBe("--- 標準\n+++ 作品\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n");
  });
});

describe("標準に戻す", () => {
  it("登録を外し、テンプレートと JS は消さずに名前を変えて残す", () => {
    copyScreen(dir, screens(SAVES_V1), "saves", { js: true });
    const r = resetScreen(dir, "saves", new Date(2026, 10, 8, 9, 5, 7));
    expect(r.unregistered).toBe(true);
    expect(r.moved).toEqual([
      { from: "ui/screens/saves/saves.html", to: "ui/screens/saves/saves.reset-20261108-090507.html" },
      { from: "ui/screens/saves/saves.js", to: "ui/screens/saves/saves.reset-20261108-090507.js" },
    ]);
    expect(readdirSync(join(dir, "ui/screens/saves")).sort()).toEqual(["saves.reset-20261108-090507.html", "saves.reset-20261108-090507.js"]);
    // 空になった ui.templates は外す。ほかの ui は残す
    expect(config().ui).toEqual({ text: { size: 30 } });
    expect(() => resetScreen(dir, "saves")).toThrow(/saves は標準のテンプレートのままです/);
  });

  it("同じ秒に二度戻しても、前に残したファイルを上書きせず、別の名前で残す", () => {
    const now = new Date(2026, 10, 8, 9, 5, 7);
    copyScreen(dir, screens(SAVES_V1), "saves", { js: true });
    writeFileSync(join(dir, "ui/screens/saves/saves.html"), "<!-- 一度目 -->\n");
    resetScreen(dir, "saves", now);
    copyScreen(dir, screens(SAVES_V1), "saves", { js: true });
    const r = resetScreen(dir, "saves", now);
    expect(r.moved.map((m) => m.to)).toEqual(["ui/screens/saves/saves.reset-20261108-090507-2.html", "ui/screens/saves/saves.reset-20261108-090507-2.js"]);
    expect(readFileSync(join(dir, "ui/screens/saves/saves.reset-20261108-090507.html"), "utf8")).toBe("<!-- 一度目 -->\n");
    expect(readdirSync(join(dir, "ui/screens/saves")).length).toBe(4);
  });

  it("ほかの画面の登録は残す", () => {
    mkdirSync(join(dir, "ui"), { recursive: true });
    copyScreen(dir, screens(SAVES_V1), "saves");
    copyScreen(dir, screens(SAVES_V1), "confirm");
    resetScreen(dir, "saves");
    expect(config().ui?.templates).toEqual({ confirm: "ui/screens/confirm/confirm.html" });
  });
});
