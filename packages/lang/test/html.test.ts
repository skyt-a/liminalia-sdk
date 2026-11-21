import { describe, expect, it } from "vitest";
import {
  assetReferences,
  buildStoryMap,
  check,
  checkProject,
  CORE_COMMANDS,
  createRegistry,
  fillHtml,
  formatLim,
  parse,
  scanHtml,
  type CommandSpec,
  type Script,
} from "../src/index.ts";

// 実際の @html は @liminalia/std の命令。ここでは検査に要る形だけの仕様を置く
const HTML: CommandSpec = {
  name: "html",
  summary: "",
  positional: ["name"],
  params: {
    name: { type: { kind: "string" }, doc: "" },
    x: { type: { kind: "number" }, doc: "" },
    y: { type: { kind: "number" }, doc: "" },
    wait: { type: { kind: "bool" }, default: "false", doc: "" },
  },
  example: "",
};
const registry = createRegistry(CORE_COMMANDS, [HTML]);

const diagnostics = (src: string) => {
  const script = parse(src, "t.lim");
  return [...script.diagnostics, ...check(script, { registry })];
};
const codes = (src: string) => diagnostics(src).map((d) => d.code);
const block = (body: string, head = "@html card") => `${head}\n${body}\n@end\n# a\n# b\n`;

describe("@html の構文", () => {
  it("引数と、@end までの中身をそのまま持つ（中の # や 「 は行の規則で読まない）", () => {
    const script = parse("  @html card x=100 y=80\n    <div>ユイ「やあ」</div>\n    # これはラベルではない\n  @end\n", "t.lim", { speakers: ["ユイ"] });
    expect(script.diagnostics).toEqual([]);
    expect(script.body).toHaveLength(1);
    const node = script.body[0]!;
    expect(node.kind).toBe("command");
    if (node.kind !== "command") return;
    expect(node.name).toBe("html");
    expect(node.args.map((a) => [a.key, a.value])).toEqual([
      [null, { kind: "string", value: "card", quoted: false }],
      ["x", { kind: "number", value: 100 }],
      ["y", { kind: "number", value: 80 }],
    ]);
    expect(node.body).toEqual({ text: "<div>ユイ「やあ」</div>\n# これはラベルではない", line: 2, indent: 4 });
  });

  it("@end が無ければエラー", () => {
    expect(codes("@html card\n<div>a</div>\n")).toContain("unclosed-block");
  });

  it("lim fmt は引数の行だけ整え、中身は変えない", () => {
    const r = formatLim('@html   "card"  x=100\n  <div   class="a">  x </div>  \n@end\n', "t.lim", { registry });
    expect(r).toEqual({ ok: true, text: '@html card x=100\n  <div   class="a">  x </div>  \n@end\n', changed: true });
  });

  it("本文の中の {@html} はエラー", () => {
    expect(codes("あ{@html card}い")).toContain("html-inline");
  });
});

describe("@html の検査", () => {
  it("使えるタグと属性だけなら通る", () => {
    const html = [
      '<div class="card" style="color: #fff; width: 200px">',
      "  今日は <strong>{= game.day}</strong> 日目<br>",
      '  <img src="icon/sun.png" alt="晴れ" width="32">',
      "  <table><tr><th>名前</th><td>{= game.name}</td></tr></table>",
      "  <ruby>明日<rt>あした</rt></ruby>",
      '  <button data-jump="#a">行く</button>',
      "</div>",
    ].join("\n");
    expect(diagnostics(block(html, "@html card wait=true"))).toEqual([]);
  });

  it("<script>・<style>・<iframe>・on… の属性・javascript:・外の URL はエラー", () => {
    expect(codes(block("<script>alert(1)</script>"))).toEqual(["html-tag-not-allowed"]);
    expect(codes(block("<style>.a{}</style>"))).toEqual(["html-tag-not-allowed"]);
    expect(codes(block('<iframe src="https://example.com"></iframe>'))).toEqual(["html-tag-not-allowed"]);
    expect(codes(block('<div onclick="alert(1)">a</div>'))).toEqual(["html-event-attribute"]);
    expect(codes(block('<img src="javascript:alert(1)">'))).toEqual(["html-external-url"]);
    expect(codes(block('<img src="https://example.com/a.png">'))).toEqual(["html-external-url"]);
    expect(codes(block('<img src="//example.com/a.png">'))).toEqual(["html-external-url"]);
    expect(codes(block('<div style="background: url(https://example.com/a.png)">a</div>'))).toEqual(["html-external-url"]);
  });

  it("一覧にないタグ・属性と、崩れた入れ子はエラー", () => {
    expect(codes(block("<marquee>a</marquee>"))).toEqual(["html-tag-not-allowed"]);
    expect(codes(block('<div id="x">a</div>'))).toEqual(["html-attribute-not-allowed"]);
    expect(codes(block("<div><span>a</div></span>"))).toEqual(["html-bad-nesting", "html-bad-nesting"]);
    expect(codes(block("<div>a"))).toEqual(["html-bad-nesting"]);
    expect(codes(block("<div>a</div></p>"))).toEqual(["html-bad-nesting"]);
    expect(codes(block("<div class='a'"))).toEqual(["html-unclosed-tag"]);
  });

  it("位置は中身の行と桁で知らせる", () => {
    const d = diagnostics("@html card\n  <div>\n    <p onclick=\"x()\">a</p>\n  </div>\n@end\n").find((x) => x.code === "html-event-attribute")!;
    expect([d.line, d.column]).toEqual([3, 8]);
  });

  it("{= 式} は本文の式と同じく確かめる。src・data-jump には書けない", () => {
    expect(codes(block("<p>{= day}</p>"))).toEqual(["unknown-variable"]);
    expect(codes(block("<p>{= game.day +}</p>"))).toEqual(["bad-expression"]);
    expect(codes(block('<p class="{= game.cls}">a</p>'))).toEqual([]);
    expect(codes(block('<img src="{= game.icon}">'))).toEqual(["html-dynamic-attribute"]);
    expect(codes(block('<button data-jump="{= game.next}">a</button>', "@html card wait=true"))).toEqual(["html-dynamic-attribute", "html-wait-without-jump"]);
  });

  it("data-jump の同じファイルのラベルを確かめ、wait との組み合わせを知らせる", () => {
    expect(codes(block('<button data-jump="#nowhere">a</button>', "@html card wait=true"))).toEqual(["unknown-label"]);
    expect(codes(block('<button data-jump="north road">a</button>', "@html card wait=true"))).toEqual(["bad-target", "html-wait-without-jump"]);
    expect(diagnostics(block('<button data-jump="#a">a</button>')).map((d) => [d.code, d.severity])).toEqual([["html-jump-without-wait", "warning"]]);
    expect(diagnostics(block("<p>a</p>", "@html card wait=true")).map((d) => [d.code, d.severity])).toEqual([["html-wait-without-jump", "warning"]]);
  });

  it("別のファイルへの data-jump はプロジェクトの検査で確かめる", () => {
    const scripts = (files: Record<string, string>) => new Map<string, Script>(Object.entries(files).map(([f, src]) => [f, parse(src, f)]));
    const main = '@html card wait=true\n<button data-jump="town#market">a</button>\n<button data-jump="town#nowhere">b</button>\n<button data-jump="castle">c</button>\n@end\n';
    const found = checkProject(scripts({ main, town: "# market\n市場。\n" }), { registry }).map((d) => [d.code, d.line]);
    expect(found).toEqual([
      ["unknown-label", 3],
      ["unknown-file", 4],
    ]);
  });
});

describe("@html の中身から読むもの", () => {
  it("<img src> は image フォルダの素材として数える（行と桁つき）", () => {
    const script = parse('# a\n@html card\n  <p>a</p>\n  <img src="icon/sun.png">\n@end\n', "t.lim");
    expect(assetReferences(script, registry)).toEqual([{ folder: "image", path: "icon/sun.png", line: 4, column: 13, form: "html-image" }]);
  });

  it("引用の中で値の前に空白や改行があっても、桁はパスの頭を指す（2026-11-19 の rest-q）", () => {
    const script = parse('# a\n@html card\n  <img src=" icon/sun.png">\n  <img src="\ticon/moon.png ">\n@end\n', "t.lim");
    expect(assetReferences(script, registry)).toEqual([
      { folder: "image", path: "icon/sun.png", line: 3, column: 14, form: "html-image" },
      { folder: "image", path: "icon/moon.png", line: 4, column: 14, form: "html-image" },
    ]);
    const scan = scanHtml('<img src="\n  a.png">');
    expect(scan.sources).toEqual([{ path: "a.png", offset: 13 }]);
  });

  it("wait=true の data-jump は分岐の地図の矢印になる", () => {
    const text = '# start\n@html card wait=true\n<button data-jump="#north">北</button>\n<button data-jump="#south">南</button>\n@end\n# north\n北。\n# south\n南。\n';
    const map = buildStoryMap({ scripts: new Map([["main", { script: parse(text, "main"), text }]]), registry, entry: "main", hooks: new Map(), data: () => undefined });
    expect(map.edges.filter((e) => e.from === "main#start").map((e) => e.to)).toEqual(["main#north", "main#south"]);
  });

  it("押すものの見出しは中の文字。{= 式} は値を HTML として読まれない文字にして埋める", () => {
    const src = '<button data-jump="#a"><b>北</b>へ</button><p title="{= x}">{= y}</p>';
    const scan = scanHtml(src);
    expect(scan.jumps).toEqual([{ target: "#a", label: "北 へ", offset: 19 }]);
    expect(fillHtml(src, scan.values, (v) => (v.source === "x" ? '"><script>' : "<b>&"))).toBe('<button data-jump="#a"><b>北</b>へ</button><p title="&quot;&gt;&lt;script&gt;">&lt;b&gt;&amp;</p>');
  });
});
