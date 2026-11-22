import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { STANDARD_TEMPLATES } from "@liminalia/screens";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/**
 * 画面の型の読み方と印の働き（src/system/template.ts）を、実際のブラウザで確かめる（DOM が要るので）。
 * 一覧と一行の部品、部品一つだけの差し替え、状態の印、標準より古い部品、安全にすること。
 */

const SCENARIO = `@window show
はじめ。
`;

/** 標準の役の型（一覧と、一行の部品）。 */
const STANDARD = `<template data-part="screen" data-version="2">
<section class="lm-x">
  <h2 class="lm-x-title" data-text="confirm.yes"></h2>
  <ol class="lm-x-list" data-list="rows" data-item="row"></ol>
  <button class="lm-x-close" data-role="close">x</button>
</section>
</template>
<template data-part="row" data-version="3">
<li class="lm-x-row"><span class="lm-x-name" data-field="name"></span><button class="lm-x-pick" data-role="pick" data-field="label"></button></li>
</template>`;

/** 一行だけを写して直した型（古い版から写した）。 */
const ROW_ONLY = `<style>.my-row { color: rgb(1, 2, 3); }</style>
<template data-part="row" data-version="2">
<li class="lm-x-row my-row"><style>.my-row b { background: url(http://example.com/b.png); }</style><b data-field="name"></b> <a href="javascript:alert(1)" data-role="pick">選ぶ</a><a class="away" href="other.html">外</a><a class="here" href="#top">上</a></li>
</template>`;

const run = (p: Page, code: string) => p.evaluate(`(async () => { const t = await import("/src/system/template.ts"); ${code} })()`);

describe.skipIf(!e2e)("画面の型の読み方と印（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({ scenario: { a: SCENARIO }, config: { entry: "a" } });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("一覧は一行の部品を並べ、印に値と働きと状態を付ける", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      const out = await run(
        p,
        `const picked = [];
        const reg = new t.ScreenTemplates({ x: ${JSON.stringify(STANDARD)} });
        const v = reg.render("x", "screen", {
          roles: { close: () => picked.push("close") },
          lists: { rows: [
            { fields: { name: "一", label: "A" }, roles: { pick: () => picked.push("一") }, state: { read: true } },
            { fields: { name: "二", label: "B" }, roles: { pick: () => picked.push("二") }, state: { disabled: true, current: "page" } },
          ] },
        });
        document.body.append(v.el);
        const rows = [...v.el.querySelectorAll(".lm-x-row")];
        rows[0].querySelector("button").click();
        v.el.querySelector(".lm-x-close").click();
        const shape = {
          title: v.el.querySelector(".lm-x-title").textContent,
          rows: rows.map((r) => [r.querySelector(".lm-x-name").textContent, r.querySelector("button").textContent, r.hasAttribute("data-lm-read"), r.hasAttribute("data-lm-disabled"), r.getAttribute("data-lm-current")]),
          types: [...v.el.querySelectorAll("button")].map((b) => b.type),
          picked,
          stale: t.staleParts(t.parseTemplate(${JSON.stringify(STANDARD)}), t.parseTemplate(${JSON.stringify(STANDARD)})),
        };
        v.el.remove();
        return shape;`,
      );
      expect(out, name).toEqual({
        title: "はい",
        rows: [
          ["一", "A", true, false, null],
          ["二", "B", false, true, "page"],
        ],
        types: ["button", "button", "button"],
        picked: ["一", "close"],
        stale: [],
      });
      await p.close();
    }
  });

  it("部品一つだけを差し替えた型は残りを標準のまま使い、古い版を知らせ、安全にする", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      const out = await run(
        p,
        `const picked = [];
        const reg = new t.ScreenTemplates({ x: ${JSON.stringify(STANDARD)} });
        reg.setAuthor({ x: ${JSON.stringify(ROW_ONLY)} });
        const v = reg.render("x", "screen", { lists: { rows: [{ fields: { name: "一" }, roles: { pick: () => picked.push("一") } }] } });
        document.body.append(v.el);
        const row = v.el.querySelector(".lm-x-row");
        const link = row.querySelector("a[data-role]");
        link.click();
        const shape = {
          screen: !!v.el.querySelector(".lm-x-close"),
          row: row.className,
          name: row.querySelector("b").textContent,
          href: [link.hasAttribute("href"), row.querySelector(".away").hasAttribute("href"), row.querySelector(".here").getAttribute("href")],
          innerStyle: row.querySelector("style").textContent,
          color: getComputedStyle(row).color,
          picked,
          stale: t.staleParts(t.parseTemplate(${JSON.stringify(STANDARD)}), t.parseTemplate(${JSON.stringify(ROW_ONLY)})),
          css: t.safeCss("a { background: url('https://example.com/a.png'); } @import url(x.css); b { background: url(assets/image/b.png); }"),
        };
        v.el.remove();
        return shape;`,
      );
      expect(out, name).toEqual({
        screen: true,
        row: "lm-x-row my-row",
        name: "一",
        href: [false, false, "#top"],
        innerStyle: ".my-row b { background: none; }",
        color: "rgb(1, 2, 3)",
        picked: ["一"],
        stale: [{ part: "row", from: 2, now: 3 }],
        css: "a { background: none; }  b { background: url(assets/image/b.png); }",
      });
      await p.close();
    }
  });

  it("data-if、data-attr-*、data-sound、包まない一覧、使えない働き、押せない働き、一覧の作り直し（フォーカスを同じ番目に残す）", async () => {
    const shapes = `<template data-part="screen" data-version="1">
<div class="lm-y" data-attr-data-kind="kind">
  <p class="lm-y-note" data-if="note" data-field="note"></p>
  <p class="lm-y-gone" data-if="none">x</p>
  <img class="lm-y-img" data-attr-src="image" data-attr-alt="label" data-attr-onclick="label">
  <a class="lm-y-link" data-attr-href="bad">a</a>
  <button class="lm-y-off" data-role="off">off</button>
  <button class="lm-y-lock" data-role="lock">lock</button>
  <button class="lm-y-quiet" data-role="close" data-sound="none">q</button>
  <template data-list="rows" data-item="row"></template>
</div>
</template>
<template data-part="row" data-version="1">
<button class="lm-y-row" data-role="pick" data-field="label"></button>
</template>
<template data-part="wide" data-version="1">
<button class="lm-y-row lm-y-wide" data-role="pick" data-field="label"></button>
</template>`;
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      const out = await run(
        p,
        `const picked = [];
        const reg = new t.ScreenTemplates({ y: ${JSON.stringify(shapes)} });
        const row = (label, part) => ({ ...(part ? { part } : {}), fields: { label }, roles: { pick: () => picked.push(label) } });
        const v = reg.render("y", "screen", {
          fields: { kind: "bad", note: "メモ", image: "assets/image/a.png", label: "絵", bad: "javascript:alert(1)" },
          roles: { off: null, lock: () => picked.push("lock"), close: () => picked.push("close") },
          disabled: { lock: true },
          lists: { rows: [row("一"), row("二", "wide"), row("三")] },
        });
        document.body.append(v.el);
        v.el.querySelector(".lm-y-lock").click();
        const before = [...v.el.children].map((e) => e.className || e.localName);
        v.items("rows")[1].focus();
        v.list("rows", [row("甲"), row("乙")]);
        const img = v.el.querySelector(".lm-y-img");
        const shape = {
          before,
          after: [...v.el.children].map((e) => e.textContent),
          kind: v.el.getAttribute("data-kind"),
          img: [img.getAttribute("src"), img.getAttribute("alt"), img.hasAttribute("onclick")],
          href: v.el.querySelector(".lm-y-link").hasAttribute("href"),
          lock: [v.el.querySelector(".lm-y-lock").disabled, v.el.querySelector(".lm-y-lock").hasAttribute("data-lm-disabled")],
          focused: document.activeElement.textContent,
          picked,
        };
        v.el.remove();
        return shape;`,
      );
      expect(out, name).toEqual({
        // data-if の空のもの、使えない働き（off）は外れ、包まない一覧は外の要素の子に並ぶ（部品を混ぜられる）
        before: ["lm-y-note", "lm-y-img", "lm-y-link", "lm-y-lock", "lm-y-quiet", "lm-y-row", "lm-y-row lm-y-wide", "lm-y-row"],
        after: ["メモ", "", "a", "lock", "q", "甲", "乙"],
        kind: "bad",
        img: ["assets/image/a.png", "絵", false],
        href: false,
        lock: [true, true],
        focused: "乙",
        picked: [],
      });
      await p.close();
    }
  });

  it("値だけを書き直す（update）: 渡した名前の data-field と data-attr-* だけを替え、一覧の一行の中と data-if で外した要素はそのまま", async () => {
    const shape = `<template data-part="screen" data-version="1">
<div class="lm-z">
  <span class="lm-z-count" data-field="count"></span>
  <span class="lm-z-name" data-field="name" data-attr-title="name"></span>
  <p class="lm-z-gone" data-if="none" data-field="count"></p>
  <ul data-list="rows" data-item="row"></ul>
</div>
</template>
<template data-part="row" data-version="1">
<li class="lm-z-row" data-field="count"></li>
</template>`;
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      const out = await run(
        p,
        `const reg = new t.ScreenTemplates({ z: ${JSON.stringify(shape)} });
        const v = reg.render("z", "screen", { fields: { count: "", name: "甲" }, lists: { rows: [{ fields: { count: "行" } }] } });
        v.update({ count: "3 件" });
        const read = () => [v.el.querySelector(".lm-z-count").textContent, v.el.querySelector(".lm-z-name").textContent, v.el.querySelector(".lm-z-name").getAttribute("title"), v.el.querySelector(".lm-z-row").textContent, v.el.querySelectorAll(".lm-z-gone").length];
        const first = read();
        v.update({ name: "" });
        return [first, read()];`,
      );
      expect(out, name).toEqual([
        ["3 件", "甲", "甲", "行", 0],
        ["3 件", "", null, "行", 0],
      ]);
      await p.close();
    }
  });

  it("URL の関門: 制御文字、途中のタブと改行、大文字と小文字の混ざりでも javascript: を残さない。リンクはどの要素でも # だけ", async () => {
    // 値は型の文字に文字参照のまま書く（ブラウザが解いてから sanitize に渡る）
    const links = [
      ["area", '<map name="m"><area class="u" shape="rect" coords="0,0,10,10" href="&#1;javascript:document.documentElement.dataset.m3=1"></map>'],
      ["area-tab", '<map name="m2"><area class="u" href="java&#9;script:document.documentElement.dataset.m3=1"></map>'],
      ["area-named", '<map name="m3"><area class="u" href="java&Tab;script&colon;document.documentElement.dataset.m3=1"></map>'],
      ["area-space", '<map name="m4"><area class="u" href=" JaVaScRiPt:document.documentElement.dataset.m3=1"></map>'],
      ["svg-a", '<svg><a class="u" xlink:href="&#1;javascript:document.documentElement.dataset.m3=1"><text>x</text></a></svg>'],
      ["svg-a-href", '<svg><a class="u" href="&#10;javascript:document.documentElement.dataset.m3=1"><text>x</text></a></svg>'],
      ["svg-a-page", '<svg><a class="u" href="other.html"><text>x</text></a></svg>'],
      ["a-nl", '<a class="u" href="java&#13;script:document.documentElement.dataset.m3=1">x</a>'],
      ["a-nbsp", '<a class="u" href="&nbsp;#top">x</a>'],
      ["img-ctrl", '<img class="u" src="&#1;//example.com/a.png">'],
      ["img-bsol", '<img class="u" src="/\\example.com/a.png">'],
      ["img-data-svg", '<img class="u" src="data:image/sv&#9;g+xml,%3Csvg/%3E">'],
    ];
    const kept = [
      ["area-page", '<map name="k"><area class="u" href="&#1;#top"></map>'],
      ["svg-a-page", '<svg><a class="u" xlink:href="#top"><text>x</text></a></svg>'],
      ["img-rel", '<img class="u" src="assets/image/a.png">'],
      ["img-data", '<img class="u" src="data:image/png;base64,AAAA">'],
      ["img-blob", '<img class="u" src="blob:http://localhost/x">'],
    ];
    const part = (body: string) => `<template data-part="screen" data-version="1"><div class="lm-u">${body}</div></template>`;
    const attrs = `<template data-part="screen" data-version="1"><div class="lm-v">
<a class="h1" data-attr-href="bad1">a</a><a class="h2" data-attr-href="bad2">a</a><a class="h3" data-attr-href="page">a</a><a class="h4" data-attr-href="away">a</a>
<img class="s1" data-attr-src="bad3"><img class="s2" data-attr-src="bad4"><img class="s3" data-attr-src="asset"><img class="s4" data-attr-src="abs">
</div></template>`;
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      const out = (await run(
        p,
        `const one = (html) => {
          const v = t.renderPart(t.parseTemplate(html), "screen");
          const el = v.el.querySelector(".u");
          return el ? (el.getAttribute("href") ?? el.getAttribute("xlink:href") ?? el.getAttribute("src")) : "(none)";
        };
        const links = Object.fromEntries(${JSON.stringify(links.map(([k, b]) => [k, part(b!)]))}.map(([k, h]) => [k, one(h)]));
        const kept = Object.fromEntries(${JSON.stringify(kept.map(([k, b]) => [k, part(b!)]))}.map(([k, h]) => [k, one(h)]));
        // 残った値は、ページの読み方でも javascript: にならない
        const protocols = Object.values(kept).filter((u) => typeof u === "string").map((u) => new URL(u, location.href).protocol);
        const v = t.renderPart(t.parseTemplate(${JSON.stringify(attrs)}), "screen", { fields: {
          bad1: "\\u0001javascript:document.documentElement.dataset.m3=1", bad2: "java\\tscript:x", page: "#top", away: "https://example.com/",
          bad3: "\\u0001 JavaScript:x", bad4: "data:image/sv\\ng+xml,x", asset: "assets/image/a.png", abs: location.origin + "/assets/a.png",
        } });
        const at = (c, a) => v.el.querySelector("." + c).getAttribute(a);
        // 押しても動かない（残っていれば動く形）
        document.body.append(v.el);
        for (const a of v.el.querySelectorAll("a")) a.click();
        v.el.remove();
        return { links, kept, protocols, attrs: [at("h1", "href"), at("h2", "href"), at("h3", "href"), at("h4", "href"), at("s1", "src"), at("s2", "src"), at("s3", "src"), at("s4", "src") === location.origin + "/assets/a.png"], ran: document.documentElement.dataset.m3 ?? null };`,
      )) as Record<string, unknown>;
      expect(out, name).toEqual({
        links: Object.fromEntries(links.map(([k]) => [k, null])),
        kept: { "area-page": "\u0001#top", "svg-a-page": "#top", "img-rel": "assets/image/a.png", "img-data": "data:image/png;base64,AAAA", "img-blob": "blob:http://localhost/x" },
        protocols: ["http:", "http:", "http:", "data:", "blob:"],
        attrs: [null, null, "#top", null, null, null, "assets/image/a.png", true],
        ran: null,
      });
      await p.close();
    }
  });

  it("標準の画面の型は、安全にしても要素も属性も一つも外れない（直す前と同じ）", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      const out = await run(
        p,
        `const count = (node) => {
          let n = 0;
          for (const el of node.querySelectorAll("*")) {
            n += 1 + el.attributes.length;
            if (el instanceof HTMLTemplateElement) n += count(el.content);
          }
          return n;
        };
        const out = {};
        for (const [screen, html] of Object.entries(${JSON.stringify(STANDARD_TEMPLATES)})) {
          const raw = document.createElement("template");
          raw.innerHTML = html;
          const before = [...raw.content.children].filter((e) => e instanceof HTMLTemplateElement && e.dataset.part).map((e) => count(e.content));
          const after = [...t.parseTemplate(html).parts.values()].map((e) => count(e.content));
          out[screen] = before.length > 0 && before.join() === after.join();
        }
        return out;`,
      );
      expect(out, name).toEqual(Object.fromEntries(Object.keys(STANDARD_TEMPLATES).map((k) => [k, true])));
      await p.close();
    }
  });
});
