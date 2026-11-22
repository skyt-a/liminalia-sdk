import { describe, expect, it } from "vitest";
import { check, checkProject, CORE_COMMANDS, createRegistry, parse, parseExpr, parseInline, plainText, printInline, type CastEntry, type Script } from "../src/index.ts";
import { formatLim } from "../src/format.ts";

const speakers = ["ユイ", "レン", "ハル", "？？？"];
const body = (src: string) => parse(src, "t.lim", { speakers }).body;
const codes = (src: string) => {
  const script = parse(src, "t.lim", { speakers });
  return [...script.diagnostics, ...check(script, { cast: new Set(["ユイカ", "レン"]) })].map((d) => d.code);
};

describe("行の種類", () => {
  it("台詞・地の文・ラベル・コメント", () => {
    expect(body("# start\n// メモ\nユイ「おはよう、今日は早いのね」\nユイの声で、眠気が消える。")).toEqual([
      { kind: "label", name: "start", line: 1 },
      { kind: "say", speaker: "ユイ", content: [{ kind: "text", text: "「おはよう、今日は早いのね」" }], line: 3 },
      { kind: "prose", content: [{ kind: "text", text: "ユイの声で、眠気が消える。" }], line: 4 },
    ]);
  });

  it("登録されていない名前＋括弧は地の文", () => {
    expect(body("それは「愛」だった")[0]?.kind).toBe("prose");
  });

  it("『』と（）も台詞、長い名前を優先", () => {
    const b = body("ハル（……間に合え！）\n？？？「誰？」");
    expect(b.map((s) => (s.kind === "say" ? s.speaker : s.kind))).toEqual(["ハル", "？？？"]);
  });

  it("英語の台詞: 話者名の後ろの \" か “ で始まる本文。半角の空白を一つ挟んでもよく、空白は本文に入れない。引用符は本文に残す", () => {
    const en = (src: string) => parse(src, "t.lim", { speakers: ["Yui", "Ren", "ユイ"] });
    expect(en('Yui "Hello."\nYui"Hi."\nRen “Wait for me!”\nRen“Wait!”').body).toEqual([
      { kind: "say", speaker: "Yui", content: [{ kind: "text", text: '"Hello."' }], line: 1 },
      { kind: "say", speaker: "Yui", content: [{ kind: "text", text: '"Hi."' }], line: 2 },
      { kind: "say", speaker: "Ren", content: [{ kind: "text", text: "“Wait for me!”" }], line: 3 },
      { kind: "say", speaker: "Ren", content: [{ kind: "text", text: "“Wait!”" }], line: 4 },
    ]);
    // 閉じの引用符は見ない（日本語の括弧と同じく、行の頭で決まる）。本文の中の書き方も読む
    expect(en('Yui "Hello, {b you}').body[0]).toMatchObject({ kind: "say", speaker: "Yui" });
    // 日本語の名前でも引用符の台詞にできる
    expect(en('ユイ "Hello."').body[0]).toMatchObject({ kind: "say", speaker: "ユイ", content: [{ kind: "text", text: '"Hello."' }] });
    // {name …} の形も同じ
    expect(en('Yui{name ???} "Who?"\nYui{name ???}“Who?”').body).toMatchObject([
      { kind: "say", speaker: "Yui", name: [{ kind: "text", text: "???" }], content: [{ kind: "text", text: '"Who?"' }] },
      { kind: "say", speaker: "Yui", name: [{ kind: "text", text: "???" }], content: [{ kind: "text", text: "“Who?”" }] },
    ]);
    expect(en('Yui{name ???} "Who?"').diagnostics).toEqual([]);
    // 本文の中の位置（診断の桁）は引用符から数える
    expect(en('Yui "a{nope"').diagnostics[0]).toMatchObject({ code: "unknown-inline", column: 7 });
  });

  it("英語の台詞にならない行: 登録していない名前、空白が二つ以上か全角、一重の引用符、名前の後ろの記号、日本語の括弧の前の空白", () => {
    const en = (src: string) => parse(src, "t.lim", { speakers: ["Yui", "ユイ"] }).body.map((s) => s.kind);
    expect(en('Ken "Hello."')).toEqual(["prose"]);
    expect(en('Yui  "Hello."\nYui　"Hello."\nYui\t"Hello."')).toEqual(["prose", "prose", "prose"]);
    expect(en("Yui 'Hello.'\nYui‘Hello.’")).toEqual(["prose", "prose"]);
    expect(en('Note: "x"\nYui: "Hello."\nYuiko "Hello."')).toEqual(["prose", "prose", "prose"]);
    expect(en("ユイ 「はい」")).toEqual(["prose"]);
    expect(en("ユイ「はい」\nユイ『はい』\nユイ（はい）\nユイ(はい)")).toEqual(["say", "say", "say", "say"]);
    // {name …} の後ろも同じ（空白二つは台詞にならない）
    expect(parse('Yui{name ???}  "Who?"', "t.lim", { speakers: ["Yui"] }).diagnostics.map((d) => d.code)).toEqual(["bad-speaker-name"]);
  });

  it("行頭の \\ で記号を本文にできる", () => {
    expect(body("\\# 見出しではない\n\\@本文")).toEqual([
      { kind: "prose", content: [{ kind: "text", text: "# 見出しではない" }], line: 1 },
      { kind: "prose", content: [{ kind: "text", text: "@本文" }], line: 2 },
    ]);
  });

  it("全角空白の字下げは本文に残る", () => {
    expect(body("　字下げ")[0]).toMatchObject({ content: [{ kind: "text", text: "　字下げ" }] });
  });

  it("# のあとに空白がないとエラーで、直し方を示す", () => {
    const d = parse("#start", "t.lim").diagnostics[0];
    expect(d).toMatchObject({ code: "bad-label", hint: "本文なら \\#start、ラベルなら # start" });
  });
});

describe("本文の書き方", () => {
  it("ルビ・値・クリック待ち・装飾", () => {
    const { content, errors } = parseInline("{r 黄昏|たそがれ}の{c #c33 {b 声}}{click}、{br}{= game.name}");
    expect(errors).toEqual([]);
    expect(content.map((n) => n.kind)).toEqual(["ruby", "text", "color", "click", "text", "br", "value"]);
    expect(plainText(content)).toBe("黄昏の声、\n");
  });

  it("& % [ ] # : はただの文字", () => {
    expect(parseInline("50% & [注] #1: 了解").content).toEqual([{ kind: "text", text: "50% & [注] #1: 了解" }]);
  });

  it("書いて読み戻すと同じになる", () => {
    const src = "{r 黄昏|たそがれ}の\\{括弧\\}と{c #cc3333 {b 声}}{click}";
    expect(printInline(parseInline(src).content)).toBe(src);
  });

  it("傍点 {dot …} と本文の中の画像 {img パス 高さ}。書いて読み戻すと同じ、表示される文字に画像は数えない", () => {
    const { content, errors } = parseInline("これは{dot 大事}なこと{img icons/heart.png}と{img a/b.png 32}");
    expect(errors).toEqual([]);
    expect(content).toEqual([
      { kind: "text", text: "これは" },
      { kind: "emphasis", children: [{ kind: "text", text: "大事" }] },
      { kind: "text", text: "なこと" },
      { kind: "image", path: "icons/heart.png", column: 20 },
      { kind: "text", text: "と" },
      { kind: "image", path: "a/b.png", height: 32, column: 42 },
    ]);
    expect(printInline(content)).toBe("これは{dot 大事}なこと{img icons/heart.png}と{img a/b.png 32}");
    expect(plainText(content)).toBe("これは大事なことと");
    expect(parseInline("{img }").errors.map((e) => e.code)).toEqual(["bad-image"]);
    expect(parseInline("{img a.png 0}").errors.map((e) => e.code)).toEqual(["bad-image"]);
  });

  it("知らない { はエラーにして直し方を示す", () => {
    const { errors } = parseInline("{ruby 漢字}");
    expect(errors[0]).toMatchObject({ code: "unknown-inline", offset: 0 });
    expect(errors[0]?.hint).toContain("{r 漢字|かんじ}");
  });

  it("閉じていない { と、対応のない }", () => {
    expect(parseInline("{b 太字").errors.map((e) => e.code)).toEqual(["unclosed-inline"]);
    expect(parseInline("a}b").errors.map((e) => e.code)).toEqual(["stray-brace"]);
  });

  it("話者{name 表示名}「…」は、この行だけ名前欄の名前を替える台詞（話者はそのまま）。文字と {= 式} だけ書ける", async () => {
    const { displayNames } = await import("../src/index.ts");
    expect(body("ユイ{name ？？？}「……誰？」")).toMatchObject([{ kind: "say", speaker: "ユイ", name: [{ kind: "text", text: "？？？" }], content: [{ kind: "text", text: "「……誰？」" }] }]);
    expect(body("レン{name {= game.player}}「よう」")).toMatchObject([{ kind: "say", speaker: "レン", name: [{ kind: "value", source: "game.player" }] }]);
    // 本文の鍵（訳・ボイスの固定・既読）は本文だけで決まるので、表示名を付けても変わらない
    expect(printInline((body("ユイ{name ？？？}「……」")[0] as { content: Parameters<typeof printInline>[0] }).content)).toBe("「……」");
    expect(codes("ユイ{name ？？？}「……」")).toEqual([]);
    expect(codes("ユイ{name {b 太字}}「……」")).toEqual(["bad-speaker-name"]);
    expect(codes("ユイ{name }「……」")).toEqual(["bad-speaker-name"]);
    expect(codes("ユイ{name ？？？}……")).toEqual(["bad-speaker-name"]);
    expect(codes("ユイ{name {= nope}}「……」")).toEqual(["unknown-variable"]);
    expect(codes("@name ユイ as=？？？\n@name ユイ as=(game.player)\n@name-off ユイ\n@name-off")).toEqual([]);
    expect(displayNames(parse("ユイ{name ？？？}「……」\nレン{name {= game.p}}「……」\n@name レン as=少年\n@name ユイ as=(game.p)", "t.lim", { speakers }))).toEqual(["？？？", "少年"]);
  });

  it("{noclick} は行の最後にだけ書け、書いて読み戻すと同じ。選択肢の文と、途中や飾りの中はエラー", () => {
    expect(body("ユイ「どっちにする？」{noclick}")).toMatchObject([{ kind: "say", speaker: "ユイ", content: [{ kind: "text", text: "「どっちにする？」" }, { kind: "noclick" }] }]);
    expect(printInline(parseInline("問い{click}かけ{noclick}").content)).toBe("問い{click}かけ{noclick}");
    expect(plainText(parseInline("問いかけ{noclick}").content)).toBe("問いかけ");
    expect(codes("問いかけ{noclick}")).toEqual([]);
    expect(codes("問い{noclick}かけ")).toEqual(["noclick-not-last"]);
    expect(codes("{b 問いかけ{noclick}}")).toEqual(["noclick-not-last"]);
    expect(codes("@choice\n- 行く{noclick} -> #a\n@end\n# a")).toEqual(["noclick-in-option"]);
  });
});

describe("命令", () => {
  it("引数はタブでも区切る（整形、lim migrate、VS Code と同じ読み方。2026-11-19 の疑い）", () => {
    const [cmd] = body("@bg hill_dusk.webp\tfade=1s");
    expect(cmd).toMatchObject({ kind: "command", name: "bg", args: [{ key: null, value: { value: "hill_dusk.webp" } }, { key: "fade", column: 20 }] });
    // 整えても同じ構文木（タブを空白一つにする）
    const formatted = formatLim("@bg hill_dusk.webp\tfade=1s\n", "a");
    expect(formatted).toMatchObject({ ok: true, text: "@bg hill_dusk.webp fade=1s\n" });
  });

  it("位置引数と key=value、値の型", () => {
    expect(body(`@chara ユイカ serious at=left time=300ms wait=true`)[0]).toEqual({
      kind: "command",
      name: "chara",
      args: [
        { key: null, value: { kind: "string", value: "ユイカ", quoted: false }, column: 8, text: "ユイカ" },
        { key: null, value: { kind: "string", value: "serious", quoted: false }, column: 12, text: "serious" },
        { key: "at", value: { kind: "string", value: "left", quoted: false }, column: 20, text: "at=left" },
        { key: "time", value: { kind: "duration", ms: 300, source: "300ms" }, column: 28, text: "time=300ms" },
        { key: "wait", value: { kind: "bool", value: true }, column: 39, text: "wait=true" },
      ],
      line: 1,
    });
  });

  it("引数の検査", () => {
    expect(codes("@chara ユイカ smile time=300")).toEqual(["bad-value"]);
    // @chara の差分は省ける（基準の差分か、覚えている前の差分）
    expect(codes("@chara ユイカ")).toEqual([]);
    expect(codes("@chara-hide")).toEqual(["missing-param"]);
    expect(codes("@chara ユイカ smile who=レン")).toEqual(["positional-by-name"]);
    expect(codes("@chara ユイカ serious wait")).toEqual([]);
    expect(codes("@chara 知らない人 normal")).toEqual(["bad-value"]);
    expect(codes("@shwo レン")).toEqual(["unknown-command"]);
    expect(codes("@bg")).toEqual(["missing-param"]);
    // 単色の背景は color= で書き、image の代わりになる（両方は書かない）
    expect(codes("@bg color=#000000")).toEqual([]);
    expect(codes("@bg room.png color=#000000")).toEqual(["redundant-param"]);
    expect(codes("@scene-change bg-color=#ffffff color=#ffffff")).toEqual([]);
    expect(codes("@scene-change room.png bg-color=#ffffff")).toEqual(["redundant-param"]);
    // x と y を両方書くと at は意味を持たない（書き方を一通りにする）
    expect(codes("@chara ユイカ smile at=left x=10 y=20")).toEqual(["redundant-param"]);
    expect(codes("@chara ユイカ smile at=auto y=20")).toEqual([]);
    expect(codes("@chara ユイカ replace=レン")).toEqual([]);
    expect(codes("@chara ユイカ replace=left at=right")).toEqual(["chara-replace-conflict"]);
    expect(codes("@chara ユイカ replace=存在しない")).toEqual(["chara-replace-unknown"]);
    // 立ち絵の枠の立ち位置の名前（autoLayout の positions に書く名前）は位置として読む
    const frame = { positions: { near: { left: 0, top: 0 } } };
    const castEntries = { ユイカ: { appearances: { default: { variants: { normal: { image: "a.png", frame } } } } } };
    const script = parse("@chara レン replace=near", "t.lim", { speakers });
    expect(check(script, { cast: new Set(["ユイカ", "レン"]), castEntries }).map((d) => d.code)).not.toContain("chara-replace-unknown");
  });

  it("キャストの定義があれば、立ち絵セット・差分・立ち位置も確かめて候補を出す", () => {
    const castEntries: Record<string, CastEntry> = {
      ユイカ: {
        defaultAppearance: "uniform",
        appearances: {
          uniform: { variants: { smile: { image: "y/smile.png", frame: { positions: { stage: { left: 1, top: 2 } } } }, normal: { image: "y/normal.png" } } },
          casual: { variants: { smile: { image: "y/casual_smile.png" } } },
        },
      },
      レン: { appearances: {} },
    };
    const run = (src: string) => check(parse(src, "t.lim"), { castEntries }).map((d) => [d.code, d.hint ?? ""]);
    expect(run("@chara ユイカ smile at=stage\n@chara ユイカ smile appearance=casual at=auto\n@chara ユイカ smile at=right")).toEqual([]);
    expect(run("@chara ユイカ smiel")).toEqual([["unknown-variant", "smile のことですか？"]]);
    expect(run("@chara ユイカ normal appearance=casual")).toEqual([["unknown-variant", "appearance=uniform を書きます"]]);
    expect(run("@chara ユイカ normal appearance=casul")).toEqual([["unknown-appearance", "casual のことですか？"]]);
    // 枠のない差分の名前の立ち位置は center だけ
    expect(run("@chara ユイカ normal at=left")).toEqual([["unknown-position", ""]]);
    expect(run("@chara ユイカ smile at=stag")).toEqual([["unknown-position", "stage のことですか？"]]);
    expect(run("@chara レン normal")).toEqual([["unknown-appearance", ""]]);
    expect(run("@chara ハル normal")).toEqual([["bad-value", "レン のことですか？"]]);
  });

  it("近い綴りを候補として出す", () => {
    const script = parse("@chrar レン\n@chara レン normal tiem=1s", "t.lim");
    expect(check(script).map((d) => d.hint)).toEqual(["@chara のことですか？", "time= のことですか？"]);
  });
});

describe("制御", () => {
  it("@if / @elif / @else / @end", () => {
    const [node] = body("@if game.trust >= 2\nユイ「なら、話は早いわ」\n@elif game.trust == 1\nA\n@else\nB\n@end");
    expect(node).toMatchObject({ kind: "if", branches: [{ line: 1 }, { line: 3 }, { condition: null, line: 5 }] });
  });

  it("@while は loop の付いた @if、@with は with の付いた @if（@elif・@else は書けない）", () => {
    const [loop, call] = body("@while game.n < 3\nA\n@end\n@with frame title=x\nB\n@end");
    expect(loop).toMatchObject({ kind: "if", loop: true, branches: [{ line: 1, body: [{ kind: "prose" }] }] });
    expect(call).toMatchObject({ kind: "if", with: { name: "frame", args: [{ key: "title" }] }, branches: [{ condition: null, body: [{ kind: "prose" }] }] });
    expect(codes("@while game.n < 3\n@else\n@end")).toEqual(["orphan-branch"]);
    expect(codes("@while game.n < 3\n# in\n@end")).toEqual(["label-in-if"]);
    expect(codes("@while game.n < 3\n本文")).toEqual(["unclosed-block"]);
  });

  it("@staff-roll は @end までの中身を持つ（file= なら持たない）。中身が無ければ警告", async () => {
    const { parseCredits, formatLim } = await import("../src/index.ts");
    const [roll, data, after] = body("@staff-roll time=30s\n# 制作\n  ユイ\n\n{img logo.png 80}\n@end\n@staff-roll file=credits\n本文");
    expect(roll).toMatchObject({ kind: "command", name: "staff-roll", body: { text: "# 制作\n  ユイ\n\n{img logo.png 80}", line: 2 } });
    expect(data).toMatchObject({ kind: "command", name: "staff-roll", args: [{ key: "file" }] });
    expect(after).toMatchObject({ kind: "prose" });
    expect(parseCredits(["# 制作", "ユイ", "", "{img logo.png 80}", "\\# 番号"])).toEqual([
      { kind: "heading", text: "制作" },
      { kind: "text", text: "ユイ" },
      { kind: "gap" },
      { kind: "image", path: "logo.png", height: 80 },
      { kind: "text", text: "# 番号" },
    ]);
    // （この検査は組み込みのコマンドだけなので @staff-roll は無いコマンドにもなる）
    expect(codes("@staff-roll\n@end")).toContain("staff-roll-empty");
    expect(codes("@staff-roll\n本文")).toContain("unclosed-block");
    // 整形は中身を変えず、@while・@with も壊さない
    const src = "@staff-roll   time=30s\n  # 制作\n@end\n@while   game.n < 3\n@set game.n += 1\n@end\n@define f(a: string)\n@content\n@end\n@with   f   a=x\n本文\n@end\n";
    const formatted = formatLim(src, "t");
    expect(formatted.ok ? formatted.text : formatted.reason).toBe("@staff-roll time=30s\n  # 制作\n@end\n@while game.n < 3\n@set game.n += 1\n@end\n@define f(a: string)\n@content\n@end\n@with f a=x\n本文\n@end\n");
  });

  it("@staff-roll の文字列や式の中の file= は中身を持つかどうかに効かない", () => {
    // 文字列の中の ` file=` は引数ではないので、@end までを中身として持つ（そのまま読むと中身を台本と読み違える）
    const [roll, after] = body('@staff-roll title="私の file=1"\n# 制作\n@end\n本文');
    expect(roll).toMatchObject({ kind: "command", name: "staff-roll", body: { text: "# 制作" } });
    expect(after).toMatchObject({ kind: "prose" });
    // 式の中の file= も同じ（(式) の引数）
    const [roll2] = body('@staff-roll note=(x ? " file=a" : "")\n# 制作\n@end');
    expect(roll2).toMatchObject({ kind: "command", name: "staff-roll", body: { text: "# 制作" } });
    // 本物の file= 引数は今までどおり中身を持たない
    const [data] = body('@staff-roll title="x" file=credits\n本文');
    expect(data).toMatchObject({ kind: "command", name: "staff-roll", args: [{ key: "title" }, { key: "file" }] });
  });

  it("@with・@content・@return (式) の検査", () => {
    const define = "@define frame(title: string)\n【{= title}】\n@content\n@end\n";
    expect(codes(`${define}@with frame title=x\n本文\n@end\n@frame title=y`)).toEqual([]);
    expect(codes("@define plain(title: string)\n本文\n@end\n@with plain title=x\nB\n@end")).toEqual(["with-without-content"]);
    expect(codes("@with bg a.png\nB\n@end")).toEqual(["bad-with"]);
    expect(codes("@with nothing\nB\n@end")).toEqual(["unknown-command"]);
    expect(codes(`${define}@with frame\nB\n@end`)).toEqual(["missing-param"]);
    expect(codes("@content")).toEqual(["bad-content"]);
    expect(codes(`${define}@define outer()\n@with frame title=x\n@content\n@end\n@end`)).toEqual(["bad-content"]);
    expect(codes("@define d(x: number, into: variable)\n@return (x * 2)\n@end\n@d x=1 into=temp.r")).toEqual([]);
    expect(codes("@define d(x: number)\n@return (x)\n@end")).toEqual(["bad-return"]);
    expect(codes("@return (1)")).toEqual(["bad-return"]);
    expect(codes("@return 1")).toEqual(["bad-return"]);
    expect(codes(`${define}@define e()\n@with frame title=x\n@return\n@end\n@end`)).toEqual(["bad-return"]);
    expect(codes("@define d(a: variable, b: variable)\n@end")).toEqual(["bad-param"]);
  });

  it("@choice", () => {
    const [node] = body("@choice\n- 北の道を行く -> #north_road\n- 南の道を行く -> chapter2#start\n@end\n# north_road");
    expect(node).toMatchObject({
      kind: "choice",
      options: [
        { content: [{ kind: "text", text: "北の道を行く" }], target: { file: null, label: "north_road" } },
        { content: [{ kind: "text", text: "南の道を行く" }], target: { file: "chapter2", label: "start" } },
      ],
    });
  });

  it("@set / @let と変数の検査", () => {
    expect(codes("@set game.trust += 1\n@let n = game.trust * 2\n@if n > 3\n@end")).toEqual([]);
    expect(codes("@set trust = 1")).toEqual(["unknown-variable"]);
    // セーブを作った作品の版（読むだけ）
    expect(codes('@if save.version == "1.0.0"\n@end')).toEqual([]);
    expect(codes("@if game.a = 1\n@end")).toEqual(["bad-expression"]);
    expect(codes("@if rand(3) > 1\n@end")).toEqual(["unknown-function"]);
  });

  it("__proto__、constructor、prototype は変数の名前やキーに使えない（forbidden-property）", () => {
    expect(codes("@set game.__proto__.x = 1")).toEqual(["forbidden-property"]);
    expect(codes('@set game["constructor"]["prototype"].x = 1')).toEqual(["forbidden-property", "forbidden-property"]);
    expect(codes("@if game.a.constructor\n@end")).toEqual(["forbidden-property"]);
    expect(codes("@let __proto__ = 1")).toEqual(["forbidden-property"]);
    expect(codes("@set game.x = __proto__")).toEqual(["forbidden-property"]);
    expect(codes("@define f(prototype: string)\n@end")).toEqual(["forbidden-property"]);
    expect(codes("@text-input game.__proto__.name")).toEqual(["forbidden-property"]);
    // ふつうの名前と、式で決まる添字は今までどおり
    expect(codes('@set game.proto = 1\n@set game.list["key"] = 2\n@let k = "a"\n@set game.map[k] = 3')).toEqual([]);
    expect(codes("@text-input game.name")).toEqual([]);
  });

  it("@define と呼び出し。引数は (式) で命令に渡す", () => {
    const src = "@define title-card(text: string, time: duration = 1s)\n@wait (time)\n@end\n@title-card text=第一章";
    expect(codes(src)).toEqual([]);
    // 括弧なしだと文字列 "time" になり、型が合わない
    expect(codes("@define pause(time: duration)\n@wait time\n@end")).toEqual(["bad-value"]);
    // 定義の外では引数名は使えない
    expect(codes("@define pause(time: duration)\n@end\n@wait (time)")).toEqual(["unknown-variable"]);
    expect(codes("@title-card")).toEqual(["unknown-command"]);
  });

  it("@script は @end まで中身をそのまま持つ", () => {
    const [node] = body("@script\n  const a = { b: 1 };\n  // # これはラベルではない\n@end");
    expect(node).toEqual({ kind: "script", code: "const a = { b: 1 };\n// # これはラベルではない", line: 1 });
  });

  it("@script の中身は実行しないので、allowScript を書いた作品でも書いた所で知らせる", () => {
    const src = "はじめ\n@script\n  const a = 1;\n@end";
    const diagnostics = (allowScript: boolean) => {
      const script = parse(src, "t.lim", { speakers });
      return check(script, { allowScript }).map((d) => `${d.severity} ${d.code}:${d.line}`);
    };
    expect(diagnostics(false)).toEqual(["error script-not-allowed:2"]);
    expect(diagnostics(true)).toEqual(["warning script-skipped:2"]);
  });

  it("構造のエラー", () => {
    expect(codes("@if game.a\n")).toEqual(["unclosed-block"]);
    expect(codes("@end")).toEqual(["orphan-end"]);
    expect(codes("@else")).toEqual(["orphan-branch"]);
    expect(codes("@jump #nowhere")).toEqual(["unknown-label"]);
    expect(codes("# a\n# a")).toEqual(["duplicate-label"]);
  });
});

describe("式", () => {
  it("優先順位", () => {
    expect(parseExpr("1 + 2 * 3 == 7 && !game.done")).toMatchObject({
      kind: "binary",
      op: "&&",
      left: { kind: "binary", op: "==", left: { kind: "binary", op: "+" } },
      right: { kind: "unary", op: "!" },
    });
  });

  it("日本語の変数名", () => {
    expect(parseExpr("game.好感度 >= 3")).toMatchObject({ left: { kind: "member", property: "好感度" } });
  });

  it("非 BMP の文字を含む変数名", () => {
    for (const property of ["𠮷", "𠮷野家", "a𠮷", "a𝟘"]) {
      expect(parseExpr(`game.${property} + 1`)).toMatchObject({
        left: { kind: "member", property },
        right: { kind: "literal", value: 1 },
      });
    }
    expect(parseExpr("𠮷")).toEqual({ kind: "name", name: "𠮷" });
  });

  it("非 BMP の変数名の後でも位置は UTF-16 のオフセット", () => {
    expect(() => parseExpr("game.𠮷 + @")).toThrow(expect.objectContaining({ offset: 10 }));
    for (const src of ["game.𝟘", "game.😀", "game.\ud842", ""]) {
      expect(() => parseExpr(src)).toThrow();
    }
  });
});

describe("取り込みのために足した書き方", () => {
  it("{size} と {mark}", () => {
    const { content, errors } = parseInline("{size 32 大きな{mark #ff0 印}}");
    expect(errors).toEqual([]);
    expect(content).toEqual([{ kind: "size", size: 32, children: [{ kind: "text", text: "大きな" }, { kind: "mark", color: "#ff0", children: [{ kind: "text", text: "印" }] }] }]);
    expect(printInline(content)).toBe("{size 32 大きな{mark #ff0 印}}");
    expect(plainText(content)).toBe("大きな印");
    expect(parseInline("{size 大きい}").errors.map((e) => e.code)).toEqual(["bad-size"]);
  });

  it("{fx} は文字の動き（中に他の書き方を入れられる）", () => {
    const { content, errors } = parseInline("{fx wave 波{c #f00 赤}}");
    expect(errors).toEqual([]);
    expect(content).toEqual([{ kind: "fx", effect: "wave", children: [{ kind: "text", text: "波" }, { kind: "color", color: "#f00", children: [{ kind: "text", text: "赤" }] }] }]);
    expect(printInline(content)).toBe("{fx wave 波{c #f00 赤}}");
    expect(plainText(content)).toBe("波赤");
    expect(parseInline("{fx spin 回る}").errors.map((e) => e.code)).toEqual(["bad-fx"]);
  });

  it("{fx} は名前のあとに動きの大きさ（strength=）と速さ（speed=）を書ける", () => {
    const { content, errors } = parseInline("{fx wave strength=2 speed=0.5 波}{fx shake speed=3 震}");
    expect(errors).toEqual([]);
    expect(content).toEqual([
      { kind: "fx", effect: "wave", strength: 2, speed: 0.5, children: [{ kind: "text", text: "波" }] },
      { kind: "fx", effect: "shake", speed: 3, children: [{ kind: "text", text: "震" }] },
    ]);
    expect(printInline(content)).toBe("{fx wave strength=2 speed=0.5 波}{fx shake speed=3 震}");
    expect(parseInline("{fx wave strength=0 波}").errors.map((e) => e.message)).toEqual(["{fx の strength= には正の数（1 で標準）を書きます"]);
    expect(parseInline("{fx wave speed=fast 波}").errors.map((e) => e.code)).toEqual(["bad-fx"]);
  });

  it("選択肢の行の飛び先のあとに見た目を書ける。文のない選択肢は画像か押せる範囲だけ", () => {
    const [node] = body("@choice\n- 北 -> #a image=n.png x=10\n- -> #a width=30 height=40\n@end\n# a");
    expect(node).toMatchObject({
      kind: "choice",
      options: [
        { content: [{ kind: "text", text: "北" }], args: [{ key: "image" }, { key: "x" }] },
        { content: [], args: [{ key: "width" }, { key: "height" }] },
      ],
    });
    expect(codes("@choice\n- -> #a\n- 北 -> #a size=3\n@end\n# a")).toEqual(["empty-option", "unknown-param"]);
  });

  it("選択肢の行の if= は出す条件で、式でだけ書ける。式の変数と関数も検査する", () => {
    const [node] = body('@choice\n- 北 -> #a if=(game.door == "open" && len(game.items) > 0) x=10\n@end\n# a');
    expect(node).toMatchObject({ kind: "choice", options: [{ target: { label: "a" }, args: [{ key: "if", value: { kind: "expr", source: 'game.door == "open" && len(game.items) > 0' } }, { key: "x" }] }] });
    expect(codes("@choice\n- 北 -> #a if=(game.ok)\n- 南 -> #a\n@end\n# a")).toEqual([]);
    // どの選択肢にも条件があると、すべて偽のときに止まるので知らせる
    expect(codes("@choice\n- 北 -> #a if=(game.ok)\n@end\n# a")).toEqual(["all-options-conditional"]);
    // 条件を組み合わせてどれかが必ず真になるなら知らせない（最後の選択肢がほかをすべて済ませたときだけ出る、など）
    const asked = (last: string) =>
      codes(`@choice\n- 一 -> #a if=(game.a==false)\n- 二 -> #a if=(game.b == false)\n- 終わり -> #a if=(${last})\n@end\n# a`);
    expect(asked("game.a==true&&game.b==true")).toEqual([]);
    expect(asked("game.a && game.b")).toEqual([]);
    expect(asked("game.a==true&&game.b==true&&game.c==true")).toEqual(["all-options-conditional"]);
    expect(codes('@choice\n- 北 -> #a if=(game.dir == "n")\n- 南 -> #a if=(game.dir != "n")\n@end\n# a')).toEqual([]);
    expect(codes('@choice\n- 北 -> #a if=(game.dir == "n")\n- 南 -> #a if=(game.dir == "s")\n@end\n# a')).toEqual(["all-options-conditional"]);
    expect(codes("@choice\n- 北 -> #a if=(game.n > 1)\n- 南 -> #a if=(game.n <= 1)\n@end\n# a")).toEqual(["all-options-conditional"]);
    expect(codes("@choice\n- 北 -> #a if=true\n- 南 -> #a if=game.ok\n@end\n# a")).toEqual(["all-options-conditional", "bad-value", "bad-value"]);
    expect(codes("@choice\n- 北 -> #a if=(ok) if=(game.ok)\n- 南 -> #a if=(nope(1))\n@end\n# a")).toEqual(["all-options-conditional", "unknown-variable", "duplicate-param", "unknown-function"]);
  });

  it("@choice の行の timeout と default、選択肢の行の locked", () => {
    expect(codes("@choice timeout=10s default=2\n- 北 -> #a locked=(game.key == false)\n- 南 -> #a\n@end\n# a")).toEqual([]);
    expect(codes("@choice nope=1\n- 北 -> #a\n@end\n# a")).toEqual(["unknown-param"]);
    expect(codes("@choice default=0\n- 北 -> #a\n@end\n# a")).toEqual(["bad-value"]);
  });

  it("飛び先と変数の型の引数", () => {
    expect(codes("@sleep-game #gallery\n# gallery\n@text-input game.name")).toEqual([]);
    expect(codes("@sleep-game #nowhere")).toEqual(["unknown-label"]);
    expect(codes("@text-input name")).toEqual(["bad-value"]);
  });

  it("@define の引数名の - は、中の式では _ で参照する。既定値の文字列に , を書ける", () => {
    expect(codes('@define greet(first-name: string = "a, b")\n{= first_name}\n@end\n@greet first-name=ハル')).toEqual([]);
    expect(body('@define greet(first-name: string = "a, b")\n@end')[0]).toMatchObject({ params: [{ name: "first-name", defaultValue: { kind: "string", value: "a, b" } }] });
  });

  it("別のファイルの @define は @use したときだけ呼べる", () => {
    const scripts = (files: Record<string, string>) => new Map<string, Script>(Object.entries(files).map(([f, src]) => [f, parse(src, f)]));
    const lib = "@define beat(time: duration = 1s)\n@wait (time)\n@end";
    expect(checkProject(scripts({ lib, a: "@use lib\n@beat time=300ms" }))).toEqual([]);
    // 呼び出し側の台本を編集しなくても、@use 先の型を変えたら検査し直す。
    const project = scripts({ lib, a: "@use lib\n@beat time=300ms" });
    const context = { registry: createRegistry(CORE_COMMANDS) };
    const cache = new WeakMap();
    expect(checkProject(project, context, cache)).toEqual([]);
    const previous = cache.get(project.get("a")!);
    checkProject(project, context, cache);
    expect(cache.get(project.get("a")!)).toBe(previous);
    project.set("lib", parse("@define beat(time: number = 1)\n@end", "lib"));
    expect(checkProject(project, context, cache)).toEqual(checkProject(project, context));
    expect(cache.get(project.get("a")!)).not.toBe(previous);
    const missing = checkProject(scripts({ lib, a: "@beat" }));
    expect(missing.map((d) => [d.code, d.hint])).toEqual([["unknown-command", "ファイルの先頭に @use lib を書きます"]]);
    expect(checkProject(scripts({ a: "@use nowhere" })).map((d) => d.code)).toEqual(["unknown-file"]);
    expect(codes("@if true\n@use lib\n@end")).toEqual(["nested-use"]);
  });
});

describe("見えない空白", () => {
  const warn = (src: string) => parse(src, "t").diagnostics.filter((d) => d.code === "invisible-space").map((d) => `${d.line}:${d.column} ${d.message}`);
  it("命令の行のノーブレークスペースと全角スペース、どの行の幅ゼロの文字も知らせる", () => {
    expect(warn("@bg room.png")).toEqual(["1:4 見えない文字（ノーブレークスペース）があります"]);
    expect(warn("@chara a smile　at=left")).toEqual(["1:15 見えない文字（全角スペース）があります"]);
    expect(warn("　地の文​です")).toEqual(["1:5 見えない文字（幅ゼロの空白）があります"]);
  });
  it("地の文の全角スペース・命令の \"…\" の中・選択肢の文の中は知らせない", () => {
    expect(warn("　地の文の　全角スペース")).toEqual([]);
    expect(warn('@chara a smile\n@wait 1s'.replace("smile", 'smile') + '\n@bg "a　b.png"')).toEqual([]);
    expect(warn("@choice\n  - 北へ　行く -> #x\n@end\n# x")).toEqual([]);
  });
  it("書き逃しの \\\\ の直後の \" は本物の引用符（\"…\" の外の \" も同じ）", () => {
    // `"a\\"` のあと（\" は書き逃しのバックスラッシュで、閉じる " は本物）の全角スペースは文字列の外
    expect(warn('@bg "a\\\\"　b.png"')).toEqual(["1:10 見えない文字（全角スペース）があります"]);
    // "…" の外の \ はそのままの文字なので、\" の " は文字列を開く（中の全角スペースは知らせない）
    expect(warn('@bg x=\\"a　b\\"')).toEqual([]);
    // "…" の中の \" は書き逃し（閉じない）ので、中の全角スペースは知らせない（これまでどおり）
    expect(warn('@bg "a\\"　b"')).toEqual([]);
  });
});

describe("飛び先の式と @if の中のラベル", () => {
  it("`(式)` の飛び先は式として読み、選択肢でも空白を含められる", () => {
    const s = parse('@jump (game.next)\n@choice\n- 行く -> ("b" + "#x") call=true\n@end', "a");
    expect(s.diagnostics).toEqual([]);
    const jump = s.body[0] as { target: { expr?: unknown; file: null } };
    expect(jump.target.expr).toBeTruthy();
    const choice = s.body[1] as { options: { target: { expr?: unknown }; args: { key: string }[] }[] };
    expect(choice.options[0]!.target.expr).toBeTruthy();
    expect(choice.options[0]!.args.map((a) => a.key)).toEqual(["call"]);
  });

  it("@if の中のラベルは警告（入れ子は一度だけ）", () => {
    const s = parse("@if (game.a)\n# inner\n　x\n@if (game.b)\n# deeper\n@end\n@end", "a");
    const codes = check(s).filter((d) => d.code === "label-in-if").map((d) => d.line);
    expect(codes.sort()).toEqual([2, 5]);
  });

  it("@define の中だけにあるラベルへのジャンプはエラー（@jump・@call・選択肢。実行単位が別なので実行時に止まる）", () => {
    const s = parse("@define f()\n# inner\nx\n@end\n@jump #inner\n@call #inner\n@choice\n- 行く -> #inner\n@end", "a");
    expect(check(s).map((d) => d.code)).toEqual(["label-in-define", "label-in-define", "label-in-define"]);
  });

  it("@define の中から同じ @define のラベルへもジャンプできない（実行器のジャンプは本体のラベルだけを見る）", () => {
    const s = parse("@define f()\n# inner\n@jump #inner\n@end", "a");
    expect(check(s).map((d) => d.code)).toEqual(["label-in-define"]);
  });

  it("@define の中と外に同じ名前のラベルがあるときは外のラベルへ飛べる（label-in-define は出ない）", () => {
    const s = parse("@define f()\n# inner\nx\n@end\n# inner\n@jump #inner", "a");
    expect(check(s).filter((d) => d.code === "label-in-define")).toEqual([]);
  });

  it("作品の検査で label-in-define を二つに数えない（同じファイルの字面はファイル単位の検査が知らせ、式の候補は作品側が知らせる）", () => {
    const d = checkProject(new Map([["a", parse("@define f()\n# inner\nx\n@end\n@jump #inner\n@jump (game.n) to=#inner\n# outer\n@jump other#inner", "a")], ["other", parse("@define g()\n# inner\n@end", "other")]]));
    expect(d.filter((x) => x.code === "label-in-define").map((x) => `${x.file}:${x.line}`)).toEqual(["a:5", "a:6", "a:8"]);
  });
});

describe("台詞の形なのに地の文になった行", () => {
  const warn = (src: string, speakers = ["ユイ", "白石ミナ"]) =>
    check(parse(src, "t.lim", { speakers }), { speakers })
      .filter((d) => d.code === "unknown-speaker")
      .map((d) => `${d.line} ${d.hint}`);

  it("話者にない名前・名前と括弧のあいだの空白を知らせ、近い話者を候補に出す", () => {
    expect(warn("ユイ「はい」\nユイィ「はい」\nユイ 「はい」\nミナ「はい」\n店員「いらっしゃい」")).toEqual([
      "2 ユイ のことですか？（別の人物なら ユイィ を話者に追加します）",
      "3 ユイ「… と詰めて書きます",
      "4 白石ミナ のことですか？（別の人物なら ミナ を話者に追加します）",
      "5 店員 を話者（cast.json の speakers）に追加するか、名前の綴りを直します。地の文なら行頭を全角スペースで字下げします",
    ]);
  });

  it("括弧が行末で閉じない行・字下げした地の文・記号だけの頭・名前のない括弧は台詞の形と見ない", () => {
    expect(warn("それは「愛」だった。\n　地の文の「中」の括弧。\n――『遠い声』\n「名前のない声」\nユイ「a」と「b」")).toEqual([]);
  });

  it("英語の台詞の形: 登録していない名前と、引用符の前の空白が半角の一つでない行を知らせる", () => {
    expect(warn('Yui "Hi."\nYuii "Hi."\nYui  "Hi."\nYui　“Hi.”\nKen“Hi.”', ["Yui"])).toEqual([
      "2 Yui のことですか？（別の人物なら Yuii を話者に追加します）",
      '3 Yui "… と書きます（空白は半角の一つまで）',
      "4 Yui “… と書きます（空白は半角の一つまで）",
      "5 Ken を話者（cast.json の speakers）に追加するか、名前の綴りを直します。地の文なら行頭を全角スペースで字下げします",
    ]);
  });

  it("英語の地の文は台詞の形と見ない（行末で閉じない引用符、途中で閉じる引用符、名前の後ろの記号）", () => {
    expect(warn('He said "hi" and left.\nNote: "x"\nThen "a" and "b"\nShe whispered, "Run."\n"No name."', ["Yui"])).toEqual([]);
  });
});

describe("式の飛び先の候補", () => {
  const diagnostics = (a: string, b = "# east") =>
    checkProject(new Map([["a", parse(a, "a")], ["b", parse(b, "b")]]))
      // 届かない行と使われないラベル（flow-check.test.ts）は見ない
      .filter((d) => d.code !== "unreachable-line" && d.code !== "unused-label")
      .map((d) => `${d.line} ${d.code}`);

  it("変数に入れる文字列・条件式の両側から候補を割り出し、実在を確かめる。割り出せなければ to= を求める", () => {
    const src = [
      "# start",
      '@set game.next = "#north"',
      "@if (game.x)",
      '@set game.next = "b#east"',
      "@end",
      "@jump (game.next)",
      '@jump (game.ok ? "#north" : "#nowhere")',
      '@jump ("ch" + game.n)',
      '@jump ("x" + game.n) to=#north,b#nowhere',
      "# north",
    ].join("\n");
    expect(diagnostics(src)).toEqual(["7 unknown-label", "8 unknown-targets", "9 unknown-label"]);
  });

  it("変数に式や命令の結果を入れていれば割り出さない", () => {
    expect(diagnostics('# start\n@set game.next = "#a"\n@set game.next = game.other\n@jump (game.next)\n# a')).toEqual(["4 unknown-targets"]);
  });
});

describe("本文の中の画像の素材", () => {
  it("台詞、地の文、選択肢の文の {img …} を image の素材として集める", async () => {
    const { assetReferences, createRegistry, CORE_COMMANDS } = await import("../src/index.ts");
    const script = parse("ユイ「{img a.png}」\n地の文{b {img b.png 24}}\n@choice\n- {img c.png}行く -> #x\n@end\n# x", "t");
    expect(assetReferences(script, createRegistry(CORE_COMMANDS)).map((r) => `${r.folder}/${r.path}`)).toEqual(["image/a.png", "image/b.png", "image/c.png"]);
  });
});
