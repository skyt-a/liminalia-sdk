import { checkScreenTemplates } from "@liminalia/lang";
import { screenTemplateRules } from "@liminalia/screens/rules";
import { describe, expect, it } from "vitest";
import { STANDARD_TEMPLATES } from "@liminalia/screens";
import { pageLink, safeCss, safeUrl, unsafeUrl } from "../src/system/template.ts";

/**
 * 画面の型の URL の関門（src/system/template.ts の safeUrl、pageLink、unsafeUrl）。
 * ブラウザは URL を解くとき、先頭と末尾の制御文字と空白、途中のタブと改行を捨てる。どの形で書いても javascript: などが通らないこと。
 * 要素と属性で確かめるもの（<area>、SVG の <a xlink:href>、data-attr-href）は test/e2e/screen-template-binder.test.ts。
 */

const BASE = "http://localhost:5173/game/index.html";

/** 通るべき正しい値。 */
const GOOD = ["assets/image/a.png", "./a.png", "../a.png", "/assets/a.png", "a.png?x=1", "#top", "", "data:image/png;base64,AAAA", "DATA:image/webp;base64,AAAA", "blob:http://localhost:5173/0b6f", "a b.png"];

/** 通らない値（外のもの、動くもの）。 */
const BAD = [
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "\u0001javascript:alert(1)",
  "\u0000\u001fjavascript:alert(1)",
  " javascript:alert(1)",
  "java\tscript:alert(1)",
  "java\nscript:alert(1)",
  "java\rscript:alert(1)",
  "javascript\t:alert(1)",
  "\u0001 java\tscript:alert(1) \u0001",
  "vbscript:msgbox(1)",
  "data:text/html,<script>alert(1)</script>",
  "data:image/svg+xml,<svg onload=alert(1)>",
  "data:image/s\tvg+xml,<svg/>",
  "\u0001data:text/html,x",
  "http://example.com/a.png",
  "https://example.com/a.png",
  "//example.com/a.png",
  " //example.com/a.png",
  "\\\\example.com/a.png",
  "/\\example.com/a.png",
  "\\/example.com/a.png",
  "\u0001//example.com/a.png",
  "/\t/example.com/a.png",
  "file:///etc/passwd",
];

describe("型の URL の関門", () => {
  it("正しい値は通る", () => {
    for (const v of GOOD) expect(safeUrl(v), JSON.stringify(v)).toBe(true);
  });

  it("外のもの、動くものは、制御文字、空白、途中のタブと改行、大文字と小文字の混ざりがあっても通らない", () => {
    for (const v of BAD) expect(safeUrl(v), JSON.stringify(v)).toBe(false);
  });

  it("ブラウザの読み方を物差しにして: 通した値は、解くと同じオリジンの相対か、絵の data: か blob: になる", () => {
    const heads = ["", " ", "\u0001", "\u0000", "\u001f", "\t", "\n", "\u0001 \u0002"];
    const tails = ["", " ", "\u0001", "\n"];
    const schemes = ["javascript", "JavaScript", "JAVASCRIPT", "vbscript", "VBScript", "data", "http", "https", "file", "blob"];
    const splits = (s: string) => [s, ...[1, 4].filter((i) => i < s.length).flatMap((i) => ["\t", "\n", "\r"].map((c) => s.slice(0, i) + c + s.slice(i)))];
    const rests = [":alert(1)", ":text/html,x", ":image/svg+xml,x", "://example.com/a"];
    let checked = 0;
    for (const head of heads)
      for (const tail of tails)
        for (const scheme of schemes)
          for (const s of splits(scheme))
            for (const rest of rests) {
              const v = head + s + rest + tail;
              const url = new URL(v, BASE);
              const ok = url.origin === new URL(BASE).origin || (url.protocol === "data:" && /^image\/(?!svg)/i.test(url.pathname)) || url.protocol === "blob:";
              if (safeUrl(v)) expect(ok, JSON.stringify(v)).toBe(true);
              if (url.protocol === "javascript:" || url.protocol === "vbscript:") expect(unsafeUrl(v), JSON.stringify(v)).toBe(true);
              checked++;
            }
    // 外を読む形（// と \）も、同じ物差しで
    for (const v of ["//example.com/a", "\\\\example.com/a", "/\\example.com/a", "\\/example.com/a", "\u0001/\t/example.com/a"]) {
      expect(new URL(v, BASE).host, JSON.stringify(v)).toBe("example.com");
      expect(safeUrl(v), JSON.stringify(v)).toBe(false);
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it("リンク（href、xlink:href）はページの中の # だけ。NBSP など、ブラウザが捨てない文字の後の # は通らない", () => {
    for (const v of ["#top", " #top", "\u0001#top", "\t#top\n"]) expect(pageLink(v), JSON.stringify(v)).toBe(true);
    for (const v of ["\u00a0#top", "other.html", "other.html#top", "\u0001javascript:alert(1)", "java\tscript:alert(1)", "", "//example.com/#x"]) expect(pageLink(v), JSON.stringify(v)).toBe(false);
  });

  it("data-attr-* で書く値: 動くもの（javascript:、vbscript:、絵でない data:）は、どの形でも書かない。素材の URL は書く", () => {
    for (const v of ["javascript:alert(1)", "\u0001javascript:alert(1)", " JavaScript:alert(1)", "java\tscript:alert(1)", "vb\nscript:x", "data:text/html,x", "\u0001data:image/svg+xml,x", "data:image/sv\rg+xml,x"]) expect(unsafeUrl(v), JSON.stringify(v)).toBe(true);
    for (const v of ["assets/image/a.png", "/assets/a.png", "http://localhost:5173/assets/a.png", "liminalia://game/assets/a.png", "blob:http://localhost/x", "data:image/png;base64,AAAA"]) expect(unsafeUrl(v), JSON.stringify(v)).toBe(false);
  });
});

describe("標準の画面の型の見た目", () => {
  it("<style> と style 属性は、安全にしても直す前と同じ（外す url() が無い）", () => {
    for (const [name, html] of Object.entries(STANDARD_TEMPLATES)) {
      const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g), ...html.matchAll(/\sstyle="([^"]*)"/g)].map((m) => m[1]!);
      for (const c of css) expect(safeCss(c), name).toBe(c);
    }
  });
});

describe("lim check の写し（@liminalia/lang）と、遊ぶ側の判定がそろう", () => {
  const rules = screenTemplateRules();
  const FILE = "ui/screens/confirm/confirm.html";
  /** 値を属性に書くときの形（制御文字は数値の文字参照、" は &quot;）。 */
  const attr = (v: string) => v.replace(/[\u0000-\u001f"&<>]/g, (c) => `&#${c.charCodeAt(0)};`);
  const warned = (tag: string) => {
    const html = `<template data-part="screen" data-version="2">
<div class="lm-dialog-backdrop"><div class="lm-dialog" role="alertdialog"><p class="lm-dialog-message" data-field="message"></p>${tag}<div class="lm-dialog-buttons"><button class="lm-button" data-role="cancel" data-field="no"></button><button class="lm-button lm-primary" data-role="ok" data-field="yes" data-autofocus></button></div></div></div>
</template>`;
    return checkScreenTemplates({ templates: { confirm: FILE }, rules, read: (f) => (f === FILE ? html : null) }).some((d) => d.code === "template-unsafe");
  };

  it("src の値", () => {
    for (const v of [...GOOD.filter((g) => g !== ""), ...BAD]) expect(warned(`<img src="${attr(v)}">`), JSON.stringify(v)).toBe(!safeUrl(v));
  });

  it("href と xlink:href は、どの要素でも # だけ（名前つきの文字参照も解く）", () => {
    for (const v of ["#top", "\u0001#top", "other.html", "\u0001javascript:alert(1)", "java\tscript:alert(1)", "https://example.com/"]) {
      expect(warned(`<map name="m"><area href="${attr(v)}"></map>`), `area ${JSON.stringify(v)}`).toBe(!pageLink(v));
      expect(warned(`<svg><a xlink:href="${attr(v)}"><text>x</text></a></svg>`), `svg a ${JSON.stringify(v)}`).toBe(!pageLink(v));
      expect(warned(`<a href="${attr(v)}">x</a>`), `a ${JSON.stringify(v)}`).toBe(!pageLink(v));
    }
    expect(warned(`<area href="java&Tab;script&colon;alert(1)">`)).toBe(true);
    expect(warned(`<img src="java&NewLine;script&colon;alert(1)">`)).toBe(true);
    expect(warned(`<img src="&sol;&bsol;example.com/a.png">`)).toBe(true);
    expect(warned(`<area href="&num;top">`)).toBe(false);
    // ブラウザは名前の大文字と小文字を区別する（&NUM; は解かれず、# にならない）
    expect(warned(`<area href="&NUM;top">`)).toBe(true);
  });
});
