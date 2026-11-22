import { checkScreenTemplates, checkUi } from "@liminalia/lang";
import { describe, expect, it } from "vitest";
import { SCREEN_CATALOG } from "../src/system/screen-catalog.ts";
import { STANDARD_TEMPLATES } from "@liminalia/screens";
import { screenTemplateRules, STANDARD_SCREENS } from "@liminalia/screens/rules";

/**
 * 標準の画面の型（src/system/screens）の決まりを確かめる（docs/design/screen-templates.md）。
 * - 部品の一覧（screen-catalog.ts の classes と parts）のクラス名を、型が持ち続ける（写した画面にも作品の CSS が効くように）
 * - 部品はどれも data-part と data-version を持つ（写した型に、元の標準の版を残すため）
 * 型の読み方と印の働き（ブラウザが要る）は test/e2e/confirm-template.test.ts と screen-template-binder.test.ts。
 */

/**
 * 型に書かず、エンジンが付けるクラス（画面ごと）。状態に合わせて付けるもの（前からの CSS のため。型の側は data-lm-* で当てられる）と、舞台に付くもの。
 * ここに足すのは、型に書くと意味が変わるものだけ。
 */
const ENGINE_CLASSES: Readonly<Record<string, readonly string[]>> = {
  // 既読と押せない選択肢（data-lm-read と data-lm-disabled も付く）。作品の screens.choice を出している間の層
  choice: ["is-read", "is-locked", "lm-choices-custom"],
  // 終わりの表記の置き方（ui.ending.mark）は舞台に付く
  ending: ["lm-ending-mark-above", "lm-ending-mark-none"],
};

/** 型の中のクラス名（class="…" の語）。 */
const classesOf = (html: string): Set<string> => new Set([...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1]!.split(/\s+/)).filter(Boolean));

describe("標準の画面の型", () => {
  for (const [name, html] of Object.entries(STANDARD_TEMPLATES)) {
    it(`${name}: 部品の一覧のクラス名をすべて持つ`, () => {
      const entry = SCREEN_CATALOG.find((s) => s.id === name);
      expect(entry, `${name} が screen-catalog.ts に無い`).toBeDefined();
      const have = classesOf(html);
      const wanted = [...entry!.classes, ...entry!.parts.map((p) => p.selector)].flatMap((s) => [...s.matchAll(/\.([\w-]+)/g)].map((m) => m[1]!));
      expect(wanted.filter((c) => !have.has(c) && !ENGINE_CLASSES[name]?.includes(c))).toEqual([]);
    });

    it(`${name}: 部品はどれも名前と版を持ち、screen がある`, () => {
      // <template data-list> は部品でなく、一覧を置く場所
      const parts = [...html.matchAll(/<template\b([^>]*)>/g)].map((m) => m[1]!).filter((a) => !a.includes("data-list="));
      expect(parts.length).toBeGreaterThan(0);
      for (const attrs of parts) {
        expect(attrs).toMatch(/data-part="[\w-]+"/);
        expect(attrs).toMatch(/data-version="\d+"/);
      }
      expect(parts.some((a) => a.includes('data-part="screen"'))).toBe(true);
    });
  }
});

describe("標準の画面の決まり（lim check がテンプレートを確かめるのに読む。screens/rules.ts）", () => {
  const rules = screenTemplateRules();
  it("テンプレートのある画面には、どれも決まりがあり、同じ字面を持つ", () => {
    expect(Object.keys(rules.screens).sort()).toEqual(Object.keys(STANDARD_TEMPLATES).sort());
    for (const [name, html] of Object.entries(STANDARD_TEMPLATES)) expect(rules.screens[name]!.template, name).toBe(html);
  });

  for (const [name, screen] of Object.entries(STANDARD_SCREENS)) {
    it(`${name}: 標準のテンプレートをそのまま写したものは、検査で何も出ない（使う値は決まりにあり、要る data-role を持つ）`, () => {
      const file = `ui/screens/${name}/${name}.html`;
      expect(checkScreenTemplates({ templates: { [name]: file }, rules, read: (f) => (f === file ? screen.template : null) })).toEqual([]);
    });
  }

  it("data-text に書ける鍵は、標準の文言の文字の鍵", () => {
    expect(rules.textKeys).toEqual(expect.arrayContaining(["confirm.yes", "confirm.no", "close"]));
    // 関数の文言（confirm.overwrite など）は書けない
    expect(rules.textKeys).not.toContain("confirm.overwrite");
  });
});

describe("liminalia.json の ui.templates", () => {
  const messages = (ui: unknown) => checkUi(ui).map((d) => d.message);
  it("画面の名前 → 作品のフォルダの中の .html", () => {
    expect(messages({ templates: { confirm: "ui/screens/confirm/confirm.html" } })).toEqual([]);
  });
  it("形の誤りを知らせる", () => {
    expect(messages({ templates: "ui/screens" })).toHaveLength(1);
    expect(messages({ templates: { confirm: "ui/screens/confirm/confirm.css" } })).toEqual(["ui.templates.confirm は .html のファイルのパスで書きます"]);
    expect(messages({ templates: { confirm: "../other/confirm.html" } })).toHaveLength(1);
    expect(messages({ templates: { confirm: "/abs/confirm.html" } })).toHaveLength(1);
    expect(messages({ templates: { confirm: 1 } })).toHaveLength(1);
  });
});
