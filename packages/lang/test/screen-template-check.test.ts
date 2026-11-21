import { describe, expect, it } from "vitest";
import { checkScreenTemplates, englishDiagnostic, placeConfigLines, type Diagnostic, type ScreenTemplateRules } from "../src/index.ts";
import { screenTemplateRules } from "@liminalia/screens/rules";

/**
 * 作品が登録した画面のテンプレート（liminalia.json の ui.templates）の検査（docs/design/screen-templates.md）。
 * 画面ごとの決まり（知っている部品、data-role、data-field、要る data-role、差し替えるプラグインの口）は、
 * 標準のテンプレートの持ち主（@liminalia/web の system/screens/）から読む。ここでは本物の決まり（確認の画面）で確かめる。
 */

const rules = screenTemplateRules();

/** 写した確認の画面（誤りなし。版 2 の見えない見出しは、作品が外してもよいので書かない。行の番号を下の試験が使う）。 */
const COPIED = `<!-- 標準の確認の画面から写した -->
<style>
  .lm-dialog { border-radius: 0; }
</style>
<template data-part="screen" data-version="2">
<div class="lm-dialog-backdrop">
  <div class="lm-dialog" role="alertdialog">
    <p class="lm-dialog-message" data-field="message"></p>
    <div class="lm-dialog-buttons">
      <button class="lm-button" data-role="cancel" data-field="no"></button>
      <button class="lm-button lm-primary" data-role="ok" data-field="yes" data-autofocus></button>
    </div>
  </div>
</div>
</template>
`;

const FILE = "ui/screens/confirm/confirm.html";

function run(files: Record<string, string>, o: { templates?: unknown; plugins?: Parameters<typeof checkScreenTemplates>[0]["plugins"]; preset?: string; rules?: ScreenTemplateRules } = {}): Diagnostic[] {
  return checkScreenTemplates({
    templates: "templates" in o ? o.templates : { confirm: FILE },
    rules: o.rules ?? rules,
    read: (file) => files[file] ?? null,
    ...(o.plugins ? { plugins: o.plugins } : {}),
    ...(o.preset ? { preset: o.preset } : {}),
  });
}

const brief = (list: readonly Diagnostic[]) => list.map((d) => `${d.file}:${d.line} ${d.severity} ${d.code}`);

describe("画面のテンプレートの検査", () => {
  it("写したままのテンプレートは何も出さない", () => {
    expect(run({ [FILE]: COPIED })).toEqual([]);
    // 部品一つだけ（標準の screen を写さず、残りを標準のまま使う）も、ui.templates が無いのも出さない
    expect(run({}, { templates: undefined })).toEqual([]);
  });

  it("登録したファイルが無い", () => {
    const list = run({});
    expect(brief(list)).toEqual(["liminalia.json:1 error template-missing"]);
    expect(list[0]!.message).toContain("ui.templates.confirm");
  });

  it("知らない画面の名前", () => {
    const list = run({ "ui/screens/nope/nope.html": COPIED }, { templates: { nope: "ui/screens/nope/nope.html" } });
    expect(brief(list)).toEqual(["liminalia.json:1 warning template-unknown-screen"]);
    expect(list[0]!.message).toContain("ui.templates.nope");
    expect(list[0]!.hint).toContain("confirm");
  });

  it("知らない部品の名前と、data-part の無い <template>", () => {
    const html = `${COPIED}<template data-part="slot" data-version="1"><li></li></template>\n<template><p></p></template>\n`;
    const list = run({ [FILE]: html });
    expect(brief(list)).toEqual([`${FILE}:16 warning template-unknown-part`, `${FILE}:17 warning template-unknown-part`]);
    expect(list[0]!.message).toContain("slot");
  });

  it("部品も <style> も無いファイルは使われないことを知らせる。<style> だけのファイルは使われるので知らせない（2026-11-19）", () => {
    const list = run({ [FILE]: '<div data-role="bogus"><script>go()</script></div>\n' });
    expect(brief(list)).toEqual([`${FILE}:1 warning template-unknown-part`]);
    expect(list[0]!.message).toContain("このファイルは使われません");
    expect(englishDiagnostic(list[0]!).message).toBe("This file has no parts (<template data-part>) and no <style>, so it isn't used (the confirm screen stays standard)");
    expect(run({ [FILE]: "<style>.lm-dialog { border-radius: 0; }</style>\n" })).toEqual([]);
  });

  it("知らない data-role と data-field と data-text の値", () => {
    const html = COPIED.replace('data-field="message"', 'data-field="mesage"').replace('data-role="cancel"', 'data-role="cancle" data-text="confirm.no"').replace("data-autofocus", 'data-autofocus data-text="confirm.nope"');
    const list = run({ [FILE]: html });
    expect(brief(list)).toEqual([`${FILE}:8 warning template-unknown-value`, `${FILE}:10 warning template-unknown-value`, `${FILE}:11 warning template-unknown-value`]);
    expect(list.map((d) => d.message).join("\n")).toMatch(/mesage[\s\S]*cancle[\s\S]*confirm\.nope/);
    // 近い名前を案に出す
    expect(list[0]!.hint).toContain("message");
    expect(list[1]!.hint).toContain("cancel");
  });

  it("コンフィグの data-setting は、設定の名前と作品独自の設定（custom.名前）だけを通す", () => {
    const file = "ui/screens/config/config.html";
    const html = `<template data-part="screen" data-version="1">
<div class="lm-screen lm-config">
  <button data-role="close"></button>
  <div class="lm-config-row" data-setting="bgm"><input></div>
  <div class="lm-config-row" data-setting="custom.sparkle"><button data-value="true"></button></div>
  <div class="lm-config-row" data-setting="bgmm"><input></div>
</div>
</template>
`;
    const list = run({ [file]: html }, { templates: { config: file } });
    expect(brief(list)).toEqual([`${file}:6 warning template-unknown-value`]);
    expect(list[0]!.message).toContain('data-setting="bgmm"');
    expect(list[0]!.hint).toContain("bgm");
    // ほかの画面では data-setting は働かない
    const other = run({ [FILE]: COPIED.replace('data-field="message"', 'data-field="message" data-setting="bgm"') });
    expect(brief(other)).toEqual([`${FILE}:8 warning template-unknown-value`]);
  });

  it("その画面に要る data-role が無い（確認なのに ok が無い、閉じる手段が無い）", () => {
    const noOk = COPIED.replace('data-role="ok" ', "");
    expect(brief(run({ [FILE]: noOk }))).toEqual([`${FILE}:5 error template-missing-role`]);
    expect(run({ [FILE]: noOk })[0]!.message).toContain('data-role="ok"');
    const none = noOk.replace('data-role="cancel" ', "");
    const list = run({ [FILE]: none });
    expect(brief(list)).toEqual([`${FILE}:5 error template-missing-role`, `${FILE}:5 error template-missing-role`]);
    expect(list[1]!.message).toMatch(/close.*cancel.*ok/);
  });

  it("部品の中の data-list に data-item が無い、data-item の部品が無い", () => {
    const html = COPIED.replace('<div class="lm-dialog-buttons">', '<ul data-list="rows"></ul><ol data-list="more" data-item="row"></ol><div class="lm-dialog-buttons">');
    const list = run({ [FILE]: html });
    expect(brief(list)).toEqual([`${FILE}:9 error template-list-item`, `${FILE}:9 error template-list-item`]);
    expect(list[0]!.message).toContain("rows");
    expect(list[1]!.message).toContain("row");
  });

  it("遊ぶ側が外すもの（script、on* の属性、外の URL、@import）は「動きません」と知らせる", () => {
    const html = COPIED.replace("<style>", "<style>\n  @import url(https://example.com/a.css);")
      .replace('<p class="lm-dialog-message" data-field="message"></p>', '<p class="lm-dialog-message" data-field="message" onclick="go()"></p><script>alert(1)</script><img src="https://example.com/a.png"><a href="https://example.com/">x</a><span style="background: url(https://example.com/b.png)"></span>');
    const list = run({ [FILE]: html });
    expect(list.every((d) => d.code === "template-unsafe" && d.severity === "warning")).toBe(true);
    expect(list.map((d) => d.line)).toEqual([3, 9, 9, 9, 9, 9]);
    expect(list.every((d) => d.message.includes("動きません"))).toBe(true);
    // 相対のパス、#、data: の絵は外さない
    const safe = COPIED.replace('<p class="lm-dialog-message" data-field="message"></p>', '<p class="lm-dialog-message" data-field="message"></p><img src="assets/image/a.png"><a href="#x">x</a><img src="data:image/png;base64,AAAA">');
    expect(run({ [FILE]: safe })).toEqual([]);
  });

  it("写した元の版が標準より古い、版が無い", () => {
    const now = rules.screens.confirm!;
    const version = Number(/data-part="screen" data-version="(\d+)"/.exec(now.template)![1]);
    const bumped: ScreenTemplateRules = { ...rules, screens: { ...rules.screens, confirm: { ...now, template: now.template.replace(`data-version="${version}"`, `data-version="${version + 1}"`) } } };
    const list = run({ [FILE]: COPIED }, { rules: bumped });
    expect(brief(list)).toEqual([`${FILE}:5 warning template-outdated`]);
    expect(list[0]!.message).toContain("screen");
    expect(list[0]!.message).toContain(`${version + 1}`);
    expect(brief(run({ [FILE]: COPIED.replace(' data-version="2"', "") }))).toEqual([`${FILE}:5 warning template-outdated`]);
  });

  it("同じ画面をプラグインの screens.* が差し替えていれば、テンプレートは使われない", () => {
    const list = run({ [FILE]: COPIED }, { plugins: [{ plugin: "./plugins/frame", replaces: ["screens.confirm"] }] });
    expect(brief(list)).toEqual(["liminalia.json:1 warning template-overridden"]);
    expect(list[0]!.message).toContain("./plugins/frame");
    // システム画面を丸ごと差し替えたプラグインも
    expect(brief(run({ [FILE]: COPIED }, { plugins: [{ plugin: "p", replaces: ["system"] }] }))).toEqual(["liminalia.json:1 warning template-overridden"]);
    // ほかの画面だけを差し替えるプラグイン、選んでいないテーマの screens.* は関係ない
    expect(run({ [FILE]: COPIED }, { plugins: [{ plugin: "p", replaces: ["screens.menu"], themes: { dark: ["screens.confirm"] } }] })).toEqual([]);
    // 選んだテーマ（ui.system.preset）の screens.* は先に立つ
    expect(brief(run({ [FILE]: COPIED }, { plugins: [{ plugin: "p", replaces: [], themes: { dark: ["screens.confirm"] } }], preset: "dark" }))).toEqual(["liminalia.json:1 warning template-overridden"]);
  });

  it("どの診断も英語になる（文とヒント）", () => {
    const broken = COPIED.replace("<style>", "<style>\n  @import url(x.css);").replace(' data-version="2"', "").replace('data-role="ok" ', 'data-role="okk" ').replace('<div class="lm-dialog-buttons">', '<ul data-list="rows"></ul><ol data-list="m" data-item="row"></ol><a href="https://example.com/" onclick="x()" style="color: red; background: url(https://example.com/a.png)">x</a><div class="lm-dialog-buttons" data-text="confirm.nope">');
    const all = [
      ...run({ [FILE]: `${broken}<template><p></p></template><template data-part="slott"></template>` }, { plugins: [{ plugin: "p", replaces: [], themes: { dark: ["screens.confirm"] } }], preset: "dark" }),
      ...run({}),
      ...run({}, { templates: { nope: FILE } }),
    ];
    expect(new Set(all.map((d) => d.code)).size).toBe(9);
    for (const d of all) {
      const en = englishDiagnostic(d);
      expect(en.message, d.message).not.toMatch(/[぀-ヿ㐀-鿿]/);
      if (en.hint) expect(en.hint, d.hint).not.toMatch(/[぀-ヿ㐀-鿿]/);
    }
  });

  it("liminalia.json の診断は ui.templates のその画面の行に出る", () => {
    const text = `{\n  "title": "x",\n  "ui": {\n    "templates": {\n      "confirm": "${FILE}"\n    }\n  }\n}\n`;
    expect(placeConfigLines(run({}), text, "liminalia.json")[0]!.line).toBe(5);
  });
});

/** 画面の JS（テンプレートと同じ場所の同じ名前の .js。登録が無ければ ui/screens/<画面>/<画面>.js）。 */
describe("画面の JS の検査", () => {
  const JS = "ui/screens/confirm/confirm.js";
  const GOOD = `export default function (screen, api) {\n  screen.dataset.kind = String(api.values.kind);\n  api.press("ok");\n  return () => api.close();\n}\n`;

  it("口の中だけを使う JS は何も出さない（テンプレートの登録が無くても、決まりの場所の JS を見る）", () => {
    expect(run({ [FILE]: COPIED, [JS]: GOOD })).toEqual([]);
    expect(run({ [JS]: GOOD }, { templates: undefined })).toEqual([]);
    expect(run({ "my/ask.html": COPIED, "my/ask.js": GOOD }, { templates: { confirm: "my/ask.html" } })).toEqual([]);
  });

  it("export default が無い", () => {
    const list = run({ [JS]: "function setup(screen, api) {}\n" }, { templates: undefined });
    expect(brief(list)).toEqual([`${JS}:1 warning template-script-export`]);
    expect(englishDiagnostic(list[0]!).message).not.toMatch(/[぀-ヿ㐀-鿿]/);
  });

  it("api の知らない口と、その画面で働かない api.press の値", () => {
    const list = run({ [JS]: `export default (screen, api) => {\n  api.vaules.kind;\n  api.answer(true);\n  api.press("okay");\n};\n` }, { templates: undefined });
    expect(brief(list)).toEqual([`${JS}:2 warning template-script-unknown`, `${JS}:3 warning template-script-unknown`, `${JS}:4 warning template-script-unknown`]);
    expect(list[0]!.hint).toContain("values");
    expect(list[2]!.hint).toContain("ok");
    for (const d of list) {
      expect(englishDiagnostic(d).message).not.toMatch(/[぀-ヿ㐀-鿿]/);
      expect(englishDiagnostic(d).hint ?? "").not.toMatch(/[぀-ヿ㐀-鿿]/);
    }
  });
});
