import { describe, expect, it } from "vitest";
import {
  applyTranslationTable,
  checkTranslation,
  collectTranslatable,
  exchangeContext,
  lineIdKey,
  moveTranslationKeys,
  moveVoiceLockKeys,
  parse,
  parseCsv,
  stampLineIds,
  toCsv,
  translationKey,
  translationKeyMoves,
  translationToCsv,
  translationToXliff,
  updateTranslation,
  updateVoiceLock,
  voiceKeyMoves,
  voiceLines,
  type Script,
  type TranslationFile,
} from "../src/index.ts";

const speakers = ["ユイ"];
const one = (text: string, file = "a") => parse(text, file, { speakers });
const scripts = (files: Record<string, string>) => new Map<string, Script>(Object.entries(files).map(([n, s]) => [n, one(s, n)]));

describe("固定の行 ID（#line:ID）", () => {
  it("台詞、地の文、選択肢の行末の #line:ID は本文に入れず、鍵を原文によらないものにする", () => {
    const s = one("ユイ「おはよう」 #line:g1\n朝だ。\t#line:p-2\n@choice\n  - 行く -> #x #line:c_3\n@end\n# x\n本文{noclick} #line:n4");
    expect(s.diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
    const [say, prose, choice, , last] = s.body;
    expect(say).toMatchObject({ kind: "say", id: "g1", content: [{ kind: "text", text: "「おはよう」" }] });
    expect(prose).toMatchObject({ kind: "prose", id: "p-2", content: [{ kind: "text", text: "朝だ。" }] });
    expect(choice).toMatchObject({ kind: "choice", options: [{ id: "c_3", target: { label: "x" }, content: [{ kind: "text", text: "行く" }] }] });
    expect(last).toMatchObject({ kind: "prose", id: "n4" });
    expect(collectTranslatable(s).map((t) => t.key)).toEqual([lineIdKey("a", "line", "g1"), lineIdKey("a", "line", "p-2"), lineIdKey("a", "option", "c_3"), lineIdKey("a", "line", "n4")]);
    expect(lineIdKey("a", "option", "c_3")).toBe("a:c@c_3");
  });

  it("使えない文字の ID は警告して本文に残し、同じファイルで二度使った ID はエラー。\\# は本文", () => {
    const s = one("朝だ。 #line:あ\nユイ「a」 #line:x1\nユイ「b」 #line:x1\n文字 \\#line:x2");
    expect(s.diagnostics.map((d) => [d.code, d.line])).toEqual([
      ["bad-line-id", 1],
      ["duplicate-line-id", 3],
    ]);
    expect(s.body[0]).toMatchObject({ kind: "prose", content: [{ kind: "text", text: "朝だ。 #line:あ" }] });
    expect(s.body[3]).not.toHaveProperty("id");
  });

  it("ID のある行は、原文を書き換えても訳を使い続け、訳したときの原文を残す（元に戻せば消える）。ID の無い行は今までどおり前の訳を添える", () => {
    const before = scripts({ a: "ユイ「おはよう」 #line:g1\n窓の外では、雨が上がりかけていた。" });
    const made = updateTranslation(null, "en", before, speakers).file;
    made.lines![lineIdKey("a", "line", "g1")]!.text = "“Morning.”";
    made.lines![translationKey("a", "line", "窓の外では、雨が上がりかけていた。")]!.text = "The rain was stopping.";
    const after = scripts({ a: "ユイ「おはよう！」 #line:g1\n窓の外では、雨がもう上がりかけていた。" });
    const r = updateTranslation(made, "en", after, speakers);
    expect(r.file.lines![lineIdKey("a", "line", "g1")]).toEqual({ source: "「おはよう！」", text: "“Morning.”", translatedFrom: "「おはよう」", speaker: "ユイ" });
    expect(r.file.lines![translationKey("a", "line", "窓の外では、雨がもう上がりかけていた。")]).toMatchObject({ text: "", previous: { source: "窓の外では、雨が上がりかけていた。", text: "The rain was stopping." } });
    expect([r.outdated, r.translated]).toEqual([1, 1]);
    // 検査は、原文が変わった訳を情報で知らせる
    expect(checkTranslation(r.file, "lang/en.json", after).map((d) => d.code)).toContain("outdated-translation");
    // 元の原文に戻せば印は消える
    const back = updateTranslation(r.file, "en", before, speakers);
    expect(back.file.lines![lineIdKey("a", "line", "g1")]).not.toHaveProperty("translatedFrom");
  });

  it("同じ ID の行をほかのファイルへ移して少し書き換えても、訳を引き継ぐ", () => {
    const made = updateTranslation(null, "en", scripts({ a: "ユイ「おはよう、今日は早いのね」 #line:g1" }), speakers).file;
    made.lines!["a:l@g1"]!.text = "“Morning, you're early.”";
    const r = updateTranslation(made, "en", scripts({ a: "", b: "ユイ「おはよう、今日は早いのね！」 #line:g1" }), speakers);
    expect(r.file.lines!["b:l@g1"]).toMatchObject({ text: "“Morning, you're early.”", translatedFrom: "「おはよう、今日は早いのね」" });
    expect(r.carried).toBe(1);
  });

  it("lim i18n --stamp-ids: ID の無い行に振り、訳の鍵を付け替える（同じ原文の行は行ごとの鍵に分かれ、場面ごとの訳はその行の場面のもの）", () => {
    const source = "# shop\nユイ「はい」\n# roof\nユイ「はい」\n@choice\n  - 行く -> #shop\n@end\n朝だ。 #line:keep\n@bg x\n";
    const before = one(source);
    const taken = new Set(["keep"]);
    const r = stampLineIds(source, before, taken);
    expect(r.stamped).toBe(3);
    const after = one(r.text);
    expect(after.diagnostics.filter((d) => d.code === "duplicate-line-id")).toEqual([]);
    const ids = r.text.split("\n").map((l) => /#line:(\S+)$/.exec(l)?.[1] ?? null);
    expect(ids.filter((x) => x !== null)).toHaveLength(4);
    expect(ids[7]).toBe("keep");
    expect(r.text.split("\n")[8]).toBe("@bg x");
    // 行 ID を振ったあとも、構文の誤りは増えない
    expect(after.diagnostics).toEqual(before.diagnostics);

    const file: TranslationFile = { language: "en", lines: { [translationKey("a", "line", "「はい」")]: { source: "「はい」", text: "“Yes.”", speaker: "ユイ", contexts: { shop: "“Sure.”", roof: "" } } } };
    const moved = moveTranslationKeys(file, translationKeyMoves(before, after));
    const texts = Object.entries(moved.lines!).map(([k, e]) => [k.includes("@"), e.text, e.contexts]);
    expect(texts).toEqual([
      [true, "“Sure.”", undefined],
      [true, "“Yes.”", undefined],
    ]);
  });

  it("ボイスの番号の固定: ID のある台詞は ID の鍵。ID を振っても番号はそのまま（録り直しにしない）、原文を書き換えたら要再収録", () => {
    const before = one("@voice-auto ユイ pattern=yui_{n}.ogg\nユイ「おはよう」\nユイ「またね」");
    const lock = updateVoiceLock(null, new Map([["a", before]]), new Set(["ユイ"])).lock;
    const stamped = stampLineIds("@voice-auto ユイ pattern=yui_{n}.ogg\nユイ「おはよう」\nユイ「またね」", before, new Set());
    const after = one(stamped.text);
    expect(voiceLines(after).every((l) => l.key.startsWith("a:v@"))).toBe(true);
    const moved = moveVoiceLockKeys(lock, voiceKeyMoves(before, after));
    const kept = updateVoiceLock(moved, new Map([["a", after]]), new Set(["ユイ"]));
    expect([kept.kept, kept.rerecord.length]).toEqual([2, 0]);
    expect(Object.values(kept.lock.lines).map((e) => e.n)).toEqual([1, 2]);
    const edited = one(stamped.text.replace("おはよう", "おはよう！"));
    const r = updateVoiceLock(kept.lock, new Map([["a", edited]]), new Set(["ユイ"]));
    expect(r.rerecord.map((l) => l.source)).toEqual(["「おはよう！」"]);
    expect(Object.values(r.lock.lines).map((e) => [e.n, e.rerecord ?? false])).toEqual([
      [1, true],
      [2, false],
    ]);
  });
});

describe("システム画面の文言（ui）", () => {
  const ui = [
    { key: "title.start", source: "New Game" },
    { key: "menu.save", source: "Save" },
  ];
  it("日本語と英語以外の言語には英語の原文を添えて並べる。英語には並べない。訳した文字列は残し、英語が変わった訳は印を付けて使い続ける", () => {
    const s = scripts({ a: "朝だ。" });
    expect(updateTranslation(null, "en", s, [], { ui }).file.ui).toBeUndefined();
    const fr = updateTranslation({ language: "fr", ui: { "title.start": "Nouvelle partie", "custom.key": "x" } }, "fr", s, [], { ui });
    expect(fr.file.ui).toEqual({ "title.start": { source: "New Game", text: "Nouvelle partie" }, "menu.save": { source: "Save", text: "" }, "custom.key": "x" });
    expect(fr.ui).toEqual({ total: 2, translated: 1, added: 1, outdated: 0 });
    const changed = updateTranslation(fr.file, "fr", s, [], { ui: [{ key: "title.start", source: "Start" }, ui[1]!] });
    expect(changed.file.ui!["title.start"]).toEqual({ source: "Start", text: "Nouvelle partie", translatedFrom: "New Game" });
  });

  it("表と XLIFF に ui:鍵 の行で書き出し、読み戻す（英語が変わっていれば書かない）", () => {
    const fr = updateTranslation(null, "fr", scripts({ a: "朝だ。" }), [], { ui }).file;
    const rows = parseCsv(translationToCsv(fr));
    expect(rows.filter((r) => r[1] === "ui").map((r) => [r[0], r[3]])).toEqual([
      ["ui:title.start", "New Game"],
      ["ui:menu.save", "Save"],
    ]);
    const edited = rows.map((r) => (r[0] === "ui:title.start" ? [...r.slice(0, 4), "Nouvelle partie", ...r.slice(5)] : r[0] === "ui:menu.save" ? [r[0]!, r[1]!, r[2]!, "Save game", "Sauver"] : r));
    const back = applyTranslationTable(fr, toCsv(edited));
    expect(back.file.ui!["title.start"]).toEqual({ source: "New Game", text: "Nouvelle partie" });
    expect(back.changedKeys).toEqual(["ui:menu.save"]);
    expect(translationToXliff(fr, "ja")).toContain('<trans-unit id="ui:title.start" xml:space="preserve">\n        <source>New Game</source>');
  });
});

describe("訳の受け渡しの実務", () => {
  const files = scripts({ a: "# north\n朝だ。\nユイ「{r 黄昏|たそがれ}の{b 空}だ{br}きれい{@wait 1s}」\n@choice\n  - 行く -> #north\n@end" });
  const base = updateTranslation(null, "fr", files, speakers).file;
  const sayKey = translationKey("a", "line", "「{r 黄昏|たそがれ}の{b 空}だ{br}きれい{@wait 1s}」");

  it("XLIFF: 書き方を <ph>・<x/>・<g> にし、note に話者、場面、位置、前後の行、長さの目安を書く", () => {
    const xliff = translationToXliff(base, "ja", { context: exchangeContext(files) });
    expect(xliff).toContain(
      '<source>「<ph id="1" ctype="x-ruby">{r 黄昏|たそがれ}</ph>の<g id="2" ctype="bold">空</g>だ<x id="3" ctype="lb" equiv-text="{br}"/>きれい<ph id="4" ctype="x-command">{@wait 1s}</ph>」</source>',
    );
    expect(xliff).toContain("<note>話者: ユイ\n場面: north\n位置: a.lim 3 行目\n前の行: 朝だ。\n次の行: - 行く\n長さの目安: 原文 11 字</note>");
    const en = translationToXliff(base, "ja", { context: exchangeContext(files), noteLanguage: "en" });
    expect(en).toContain("<note>Speaker: ユイ\nScene: north\nPosition: a.lim line 3\nPrevious line: 朝だ。\nNext line: - 行く\nLength: 11 characters in the source</note>");
  });

  it("XLIFF の訳を読み戻すと、要素を .lim の書き方に戻す。訳の書き方が読めないものは書かずに位置を返す", () => {
    const xliff = translationToXliff(base, "ja");
    const filled = xliff
      .replace(/(<source>「<ph[\s\S]*?<\/source>\n\s*<target)[^>]*><\/target>/, '$1>“The <g id="2" ctype="bold">sky</g> at <ph id="1">{r dusk|tasogare}</ph><x id="3"/>so pretty<ph id="4">{@wait 1s}</ph>”</target>')
      .replace(/(<source>朝だ。<\/source>\n\s*<target)[^>]*><\/target>/, "$1>Morning {b came.</target>");
    const back = applyTranslationTable(base, filled);
    expect(back.file.lines![sayKey]!.text).toBe("“The {b sky} at {r dusk|tasogare}{br}so pretty{@wait 1s}”");
    expect(back.rejected).toHaveLength(1);
    expect(back.rejected[0]).toMatchObject({ key: translationKey("a", "line", "朝だ。"), column: 9 });
    expect("line" in back.rejected[0]!.at && back.rejected[0]!.at.line).toBe(filled.split("\n").findIndex((l) => l.includes(`id="${translationKey("a", "line", "朝だ。")}"`)) + 1);
    expect(back.file.lines![translationKey("a", "line", "朝だ。")]!.text).toBe("");
  });

  it("訳に入れた原文に無い囲み（<bpt>/<ept>）も戻し、原文に無い <g> は書かない", () => {
    const withBold = { ...base, lines: { ...base.lines, [translationKey("a", "line", "朝だ。")]: { source: "朝だ。", text: "It's {i morning}." } } };
    const xliff = translationToXliff(withBold, "ja");
    expect(xliff).toContain('It&apos;s'.replace("&apos;", "'") + ' <bpt id="1">{i </bpt>morning<ept id="1">}</ept>.');
    expect(applyTranslationTable(withBold, xliff).file.lines![translationKey("a", "line", "朝だ。")]!.text).toBe("It's {i morning}.");
    const bad = xliff.replace("It's <bpt", 'It\'s <g id="9">x</g><bpt');
    expect(applyTranslationTable(withBold, bad).rejected.map((x) => x.message)).toEqual(['<g id="9"> は原文にない要素です']);
  });

  it("表: 書き方の読めない訳は書かず、表の行と訳の何文字目かを返す。原文が変わった行の鍵を返す。文脈の列に場所と前後の行", () => {
    const rows = parseCsv(translationToCsv(base, { context: exchangeContext(files) }));
    const say = rows.find((r) => r[0] === sayKey)!;
    expect(say[7]).toBe("場面: north\n位置: a.lim 3 行目\n前の行: 朝だ。\n次の行: - 行く\n長さの目安: 原文 11 字");
    const edited = rows.map((r) => (r[0] === sayKey ? [...r.slice(0, 4), "“Dusk {r }”", ...r.slice(5)] : r[1] === "choice" ? [r[0]!, r[1]!, r[2]!, "行こう", "Go"] : r));
    const back = applyTranslationTable(base, toCsv(edited));
    expect(back.rejected).toEqual([{ key: sayKey, at: { row: rows.findIndex((r) => r[0] === sayKey) + 1 }, column: 7, message: expect.any(String) }]);
    expect(back.changedKeys).toEqual([translationKey("a", "option", "行く")]);
  });

  it("--untranslated と --changed で、訳の無いものと原文が変わったものだけを書き出す", () => {
    const file: TranslationFile = {
      language: "fr",
      lines: {
        done: { source: "済み", text: "Fait" },
        empty: { source: "まだ", text: "" },
        prev: { source: "新しい", text: "", previous: { source: "古い", text: "Vieux" } },
        moved: { source: "直した", text: "Corrigé", translatedFrom: "直す前" },
      },
    };
    const keys = (o: Parameters<typeof translationToCsv>[1]) => parseCsv(translationToCsv(file, o)).slice(1).map((r) => r[0]);
    expect(keys({ untranslated: true })).toEqual(["empty", "prev"]);
    expect(keys({ changed: true })).toEqual(["prev", "moved"]);
    expect(keys({ untranslated: true, changed: true })).toEqual(["empty", "prev", "moved"]);
    const xliff = translationToXliff(file, "ja", { changed: true });
    expect(xliff).toContain('<target state="needs-review-translation">Corrigé</target>');
    expect(xliff).toContain("訳したときの原文: 直す前");
    // 訳し直して取り込むと印が消える
    const back = applyTranslationTable(file, xliff.replace(">Corrigé<", ">Corrigé !<"));
    expect(back.file.lines!.moved).toEqual({ source: "直した", text: "Corrigé !" });
  });
});
