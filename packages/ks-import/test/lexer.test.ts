import { describe, expect, it } from "vitest";
import { compile, lex, parseTag } from "../src/index.ts";

const names = (src: string) => lex(src, "t.ks").commands.map((c) => c.name);

describe("parseTag", () => {
  it("引用符あり・なし・値なしの引数", () => {
    expect(parseTag(`bg storage="a b.png"  time=1000 wait`, 1).pm).toEqual({ storage: "a b.png", time: "1000", wait: "" });
  });

  it("シングルクォートとバッククォート", () => {
    expect(parseTag(`eval exp='f.a = "x"'`, 1).pm).toEqual({ exp: 'f.a = "x"' });
    expect(parseTag("eval exp=`a b`", 1).pm).toEqual({ exp: "a b" });
  });

  it("文字列の undefined が空文字になるのは KeepSpaceInParameterValue=3 のときだけ", () => {
    expect(parseTag(`chara_show name=undefined`, 1).pm).toEqual({ name: "undefined" });
    expect(parseTag(`chara_show name=undefined`, 1, "3").pm).toEqual({ name: "" });
  });

  it("KeepSpaceInParameterValue=1 は引用符内の空白を詰める（バッククォートは除く）", () => {
    expect(parseTag(`x a="p q" b=\`p q\``, 1, "1").pm).toEqual({ a: "pq", b: "p q" });
  });

  it("エスケープ状態は次の終端文字まで続く", () => {
    // 期待値は TyranoScript のパーサの実際の出力
    expect(parseTag(`x a="p\\q" r"`, 1).pm).toEqual({ a: 'pq" r' });
    expect(parseTag(`x a="p\\qr s" t="u"`, 1).pm).toEqual({ a: 'pqr s" t=', 'u"': "" });
  });
});

describe("lex", () => {
  it("地の文とタグの混在", () => {
    const { commands } = lex("こんにちは[r]世界[p]", "t.ks");
    expect(commands.map((c) => [c.name, c.val])).toEqual([
      ["text", "こんにちは"],
      ["r", ""],
      ["text", "世界"],
      ["p", ""],
    ]);
  });

  it("コメント・ラベル・@タグ・話者名", () => {
    const src = [";コメント", "/*", "[p]", "*/", "*start|開始", "@bg storage=a.png", "#ソウ:smile"].join("\n");
    const { commands } = lex(src, "t.ks");
    expect(commands).toEqual([
      { name: "label", pm: { label_name: "start", val: "開始" }, val: "開始", line: 5 },
      { name: "bg", pm: { storage: "a.png" }, val: "", line: 6 },
      { name: "chara_ptext", pm: { name: "ソウ", face: "smile" }, val: "", line: 7 },
    ]);
  });

  it("バックスラッシュで [ を地の文にできる", () => {
    expect(lex("\\[注\\]", "t.ks").commands[0]?.val).toBe("[注]");
  });

  it("引用符内の ] はタグを閉じない", () => {
    expect(lex(`[eval exp="f.a=[1]"]`, "t.ks").commands[0]?.pm).toEqual({ exp: "f.a=[1]" });
  });

  it("閉じていないタグは補ったうえで診断を出す", () => {
    const { commands, diagnostics } = lex("[bg storage=a.png", "t.ks");
    expect(commands[0]?.name).toBe("bg");
    expect(diagnostics.map((d) => d.code)).toEqual(["unclosed-tag"]);
  });

  it("[iscript] 内は [ を含めて地の文として拾う", () => {
    expect(names("[iscript]\nvar a = [1, 2];\n[endscript]")).toEqual(["iscript", "text", "endscript"]);
  });

  it("[iscript] 内の * 行はラベルになり、警告を出す", () => {
    const { commands, diagnostics } = lex("[iscript]\n/**\n * doc\n */\n[endscript]", "t.ks");
    // `/**` は "/*" と完全一致しないので地の文、` * doc` と ` */` はラベルになる
    expect(commands.map((c) => c.name)).toEqual(["iscript", "text", "label", "label", "endscript"]);
    expect(diagnostics.map((d) => d.code)).toEqual(["label-in-iscript", "label-in-iscript"]);
  });
});

describe("compile", () => {
  it("if / elsif / else / endif の分岐先を解決する", () => {
    const { commands, diagnostics } = compile("[if exp=a]\nA\n[elsif exp=b]\nB\n[else]\nC\n[endif]", "t.ks");
    expect(diagnostics).toEqual([]);
    const at = (name: string) => commands.findIndex((c) => c.name === name);
    expect(commands[at("if")]).toMatchObject({ next: at("elsif"), end: at("endif") });
    expect(commands[at("elsif")]).toMatchObject({ next: at("else"), end: at("endif") });
    expect(commands[at("else")]).toMatchObject({ next: at("endif"), end: at("endif") });
  });

  it("入れ子の if", () => {
    const { commands } = compile("[if exp=a][if exp=b]x[endif][else]y[endif]", "t.ks");
    expect(commands[0]).toMatchObject({ next: 4, end: 6 });
    expect(commands[1]).toMatchObject({ next: 3, end: 3 });
  });

  it("対応の取れない構造をエラーにする", () => {
    const codes = compile("[if exp=a]\n[endif]\n[endif]\n[macro name=m]", "t.ks").diagnostics.map((d) => d.code);
    expect(codes).toEqual(["orphan-endif", "missing-endmacro"]);
  });

  it("iscript の本文をまとめる", () => {
    const { commands } = compile("[iscript]\nf.a = 1;\nf.b = 2;\n[endscript]", "t.ks");
    expect(commands[0]).toMatchObject({ name: "iscript", next: 3, body: "f.a = 1;\nf.b = 2;\n" });
  });

  it("ラベルの重複は先勝ちで警告", () => {
    const ir = compile("*a\n*a", "t.ks");
    expect(ir.labels).toEqual({ a: 0 });
    expect(ir.diagnostics.map((d) => d.code)).toEqual(["duplicate-label"]);
  });
});
