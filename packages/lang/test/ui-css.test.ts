import { describe, expect, it } from "vitest";
import { englishDiagnostic } from "../src/diagnostics-en.ts";
import { applyUiTheme, checkUi, checkUiCss, cssRuleValue, resolveCssReference, rewriteCssReferences, scanCss, setCssRule, setCssRules, uiCssFiles, UI_CSS_DEFAULT, UI_THEMES, type ProjectFiles } from "../src/index.ts";

/** 作品のフォルダの作り物（パス → 字面。素材は空の字面）。 */
const project = (files: Record<string, string>): ProjectFiles => ({
  text: (p) => files[p] ?? null,
  exists: (p) => p in files,
});

describe("作品の CSS（ui.css）", () => {
  it("ui.css は作品のフォルダの中の .css のファイルの並び", () => {
    expect(checkUi({ css: ["ui/screens.css", "ui/more.css"] })).toEqual([]);
    expect(checkUi({ css: "ui/screens.css" }).map((d) => d.message)).toEqual(["ui.css は作品のフォルダからの CSS のファイルのパスの配列で書きます"]);
    expect(checkUi({ css: ["ui/screens.txt", "../outside.css", "/abs.css", "https://example.com/a.css", 3] }).map((d) => d.message)).toEqual([
      "ui.css[0] は .css のファイルを書きます",
      "ui.css[1] は作品のフォルダの中のファイルを、作品のフォルダからの相対のパスで書きます",
      "ui.css[2] は作品のフォルダの中のファイルを、作品のフォルダからの相対のパスで書きます",
      "ui.css[3] は作品のフォルダの中のファイルを、作品のフォルダからの相対のパスで書きます",
      "ui.css[4] は作品のフォルダの中のファイルを、作品のフォルダからの相対のパスで書きます",
    ]);
    expect(uiCssFiles({ css: ["ui/a.css", "../b.css", 3] })).toEqual(["ui/a.css"]);
    expect(uiCssFiles(undefined)).toEqual([]);
    expect(UI_CSS_DEFAULT).toBe("ui/screens.css");
    // テーマを替えても、作品の CSS はそのまま
    for (const theme of UI_THEMES) expect(applyUiTheme({ css: ["ui/screens.css"] }, theme).css, theme.id).toEqual(["ui/screens.css"]);
  });

  it("CSS の url() と @import を読み、コメントと文字列の中は数えない", () => {
    const css = [
      "/* url(comment.png) */",
      '@import "parts.css";',
      ".a { background: url(../assets/image/frame.png) no-repeat; }",
      '.b { background-image: url( "img/b c.png" ); content: "url(no.png)"; }',
      ".c { mask: url('data:image/svg+xml;utf8,<svg/>'); }",
    ].join("\n");
    const { references, problem } = scanCss(css);
    expect(problem).toBeNull();
    expect(references).toEqual([
      { kind: "import", value: "parts.css", line: 2 },
      { kind: "url", value: "../assets/image/frame.png", line: 3 },
      { kind: "url", value: "img/b c.png", line: 4 },
      { kind: "url", value: "data:image/svg+xml;utf8,<svg/>", line: 5 },
    ]);
    expect(scanCss(".a { color: red;\n.b { color: blue; }").problem).toEqual({ line: 1, reason: "brace" });
    expect(scanCss(".a { color: red; }\n/* 閉じない").problem).toEqual({ line: 2, reason: "comment" });
    expect(scanCss('.a { content: "閉じない; }').problem).toEqual({ line: 1, reason: "string" });
    expect(scanCss(".a { color: red; } }").problem).toEqual({ line: 1, reason: "brace" });
  });

  it("参照は CSS のファイルからの相対のパスで解き、作品の外は outside", () => {
    expect(resolveCssReference("ui/screens.css", "../assets/image/a.png")).toEqual({ path: "assets/image/a.png" });
    expect(resolveCssReference("ui/screens.css", "img/a%20b.png?v=1#x")).toEqual({ path: "ui/img/a b.png" });
    expect(resolveCssReference("screens.css", "a.png")).toEqual({ path: "a.png" });
    expect(resolveCssReference("ui/screens.css", "../../a.png")).toEqual({ outside: true });
    expect(resolveCssReference("ui/screens.css", "/assets/a.png")).toEqual({ outside: true });
    expect(resolveCssReference("ui/screens.css", "https://example.com/a.png")).toEqual({ outside: true });
    expect(resolveCssReference("ui/screens.css", "//example.com/a.png")).toEqual({ outside: true });
    expect(resolveCssReference("ui/screens.css", "data:image/png;base64,AAAA")).toEqual({ skip: true });
    expect(resolveCssReference("ui/screens.css", "#mask")).toEqual({ skip: true });
  });

  it("束ねずに渡すとき（スマホ版）は、作品の中を指す参照だけを配る URL に書き換える", () => {
    const css = '@import "parts.css";\n.a { background: url(../assets/image/a.png), url("data:image/png;base64,AA"), url(https://example.com/x.png); }';
    expect(rewriteCssReferences(css, "ui/screens.css", (p) => `/files/${p}`)).toBe('@import "/files/ui/parts.css";\n.a { background: url("/files/assets/image/a.png"), url("data:image/png;base64,AA"), url(https://example.com/x.png); }');
  });

  it("lim check: 無いファイル、読めない CSS、無い素材、作品の外を指す参照", () => {
    const files = project({
      "ui/screens.css": ['@import "parts.css";', ".a { background: url(../assets/image/frame.png); }", ".b { background: url(missing.png); }", ".c { background: url(https://example.com/x.png); }", ".d { background: url(../../up.png); }"].join("\n"),
      "ui/parts.css": ".e { color: red;\n",
      "assets/image/frame.png": "",
    });
    const list = checkUiCss({ css: ["ui/screens.css", "ui/gone.css"] }, files);
    expect(list.map((d) => `${d.file}:${d.line} ${d.severity} ${d.code}`)).toEqual([
      "ui/parts.css:1 error ui-css-syntax",
      "ui/screens.css:3 error ui-css-asset",
      "ui/screens.css:4 error ui-css-outside",
      "ui/screens.css:5 error ui-css-outside",
      "liminalia.json:1 error ui-css-missing",
    ]);
    expect(list.find((d) => d.code === "ui-css-missing")?.message).toBe("ui.css[1] の ui/gone.css がありません");
    expect(list.find((d) => d.code === "ui-css-asset")?.message).toBe("missing.png がありません（ui/missing.png）");
    // 英語の文がある
    for (const d of list) expect(englishDiagnostic(d).message, d.message).not.toMatch(/[ぁ-んァ-ン]/);
    // 書いていなければ何も見ない
    expect(checkUiCss({}, files)).toEqual([]);
  });

  it("部品の欄の一行: 同じセレクタと性質の行は書き換え、無ければ足し、外すと消す。ほかの行は変えない", () => {
    let css = "/* 手で書いたもの */\n.lm-menu { padding: 8px; color: red; }\n";
    css = setCssRule(css, ".lm-menu", "background-color", "#223344");
    expect(css).toBe("/* 手で書いたもの */\n.lm-menu { padding: 8px; color: red; }\n.lm-menu { background-color: #223344; }\n");
    expect(cssRuleValue(css, ".lm-menu", "background-color")).toBe("#223344");
    // 手で書いた二つの性質の規則は、部品の欄の行と見なさない
    expect(cssRuleValue(css, ".lm-menu", "color")).toBeUndefined();
    css = setCssRule(css, ".lm-menu", "background-color", "#000000");
    expect(css.match(/background-color/g)).toHaveLength(1);
    expect(cssRuleValue(css, ".lm-menu", "background-color")).toBe("#000000");
    css = setCssRules(css, [
      { selector: ".choices > button", property: "border-width", value: "2px" },
      { selector: ".choices > button", property: "border-style", value: "solid" },
    ]);
    expect(cssRuleValue(css, ".choices  >  button", "border-width")).toBe("2px");
    css = setCssRule(css, ".lm-menu", "background-color", undefined);
    expect(css).toBe("/* 手で書いたもの */\n.lm-menu { padding: 8px; color: red; }\n.choices > button { border-width: 2px; }\n.choices > button { border-style: solid; }\n");
    expect(setCssRule("", ".a", "color", "red")).toBe(".a { color: red; }\n");
    expect(setCssRule(".x {}", ".a", "color", "red")).toBe(".x {}\n.a { color: red; }\n");
    expect(setCssRule(".x {}", ".a", "color", undefined)).toBe(".x {}");
  });

  it("部品の欄の一行: 改行が CRLF のファイルは、CRLF のまま書き換え、足し、消す（空の行を残さない）", () => {
    const css = ".lm-menu { color: #fff; }\r\n.lm-title { color: #000; }\r\n";
    expect(cssRuleValue(css, ".lm-menu", "color")).toBe("#fff");
    expect(setCssRule(css, ".lm-menu", "color", "#123")).toBe(".lm-menu { color: #123; }\r\n.lm-title { color: #000; }\r\n");
    expect(setCssRule(css, ".lm-menu", "color", undefined)).toBe(".lm-title { color: #000; }\r\n");
    expect(setCssRule(css, ".lm-box", "color", "red")).toBe(`${css}.lm-box { color: red; }\r\n`);
    expect(setCssRule(".x {}\r\n.y {}", ".a", "color", "red")).toBe(".x {}\r\n.y {}\r\n.a { color: red; }\r\n");
  });

  it("部品の欄の一行: BOM 付きのファイルの一行目の規則も読み書きし、BOM は残す", () => {
    const css = "\uFEFF.lm-menu { color: #fff; }\n.lm-title { color: #000; }\n";
    expect(cssRuleValue(css, ".lm-menu", "color")).toBe("#fff");
    expect(setCssRule(css, ".lm-menu", "color", "#123")).toBe("\uFEFF.lm-menu { color: #123; }\n.lm-title { color: #000; }\n");
    expect(setCssRule(css, ".lm-menu", "color", undefined)).toBe("\uFEFF.lm-title { color: #000; }\n");
    expect(setCssRule(css, ".lm-title", "color", "#456")).toBe("\uFEFF.lm-menu { color: #fff; }\n.lm-title { color: #456; }\n");
  });
});
