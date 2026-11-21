import { describe, expect, it } from "vitest";
import {
  applyTranslationTable,
  checkTranslation,
  collectProjectTexts,
  collectTranslatable,
  contextAt,
  CORE_COMMANDS,
  createRegistry,
  displayNames,
  mapProjectTexts,
  parse,
  projectTextKey,
  translationKey,
  translationKeyKind,
  translationCount,
  translationToCsv,
  translationToXliff,
  updateTranslation,
  type CommandSpec,
  type Script,
} from "../src/index.ts";

const speakers = ["ユイ"];
const scripts = (files: Record<string, string>) => new Map<string, Script>(Object.entries(files).map(([n, s]) => [n, parse(s, n, { speakers })]));

describe("多言語", () => {
  it("訳すのは本文の行（台詞・地の文）と選択肢の文。同じ原文は一度だけ", () => {
    const s = scripts({ a: "ユイ「おはよう」\n　朝だ。\n　朝だ。\n@choice\n  - 行く -> #x\n@end\n# x\n{r 黄昏|たそがれ}の{@wait 1s}声" }).get("a")!;
    const items = collectTranslatable(s);
    expect(items.map((t) => [t.kind, t.source, t.speaker])).toEqual([
      ["line", "「おはよう」", "ユイ"],
      ["line", "　朝だ。", null],
      ["option", "行く", null],
      ["line", "{r 黄昏|たそがれ}の{@wait 1s}声", null],
    ]);
    expect(items[0]!.key).toBe(translationKey("a", "line", "「おはよう」"));
  });

  it("`@set 変数 = \"文字\"` の文字はコマンドの文字として訳す（式で作る文字、+= で足す文字、文字の無いものは訳さない）", () => {
    const s = scripts({ a: '@set game.name = "ユイカ"\n@set game.full = "名前は" + "ユイカ"\n@set game.log += "あ"\n@set game.code = "42"\n@set game.empty = ""\n@let here = "部屋"\n@set name = "Yuika"' }).get("a")!;
    expect(collectTranslatable(s).map((t) => [t.kind, t.source, t.note, t.line])).toEqual([
      ["arg", "ユイカ", "@set game.name", 1],
      ["arg", "Yuika", "@set name", 7],
    ]);
    expect(collectTranslatable(s)[0]!.key).toBe(translationKey("a", "arg", "ユイカ"));
  });

  it("訳のファイルを合わせると、今ある訳は残り、新しい行は空で足し、訳が空のまま使われなくなった行は外す", () => {
    const before = updateTranslation(null, "en", scripts({ a: "ユイ「おはよう」\n　朝だ。" }), speakers).file;
    before.lines![translationKey("a", "line", "「おはよう」")]!.text = "“Morning.”";
    before.speakers!.ユイ = "Yui";
    const r = updateTranslation(before, "en", scripts({ a: "ユイ「おはよう」\n　夜だ。" }), speakers);
    expect(r).toMatchObject({ added: 1, removed: 1, translated: 1, total: 2 });
    expect(r.file.lines![translationKey("a", "line", "「おはよう」")]).toEqual({ source: "「おはよう」", text: "“Morning.”", speaker: "ユイ" });
    expect(r.file.lines![translationKey("a", "line", "　夜だ。")]).toEqual({ source: "　夜だ。", text: "" });
    expect(r.file.speakers).toEqual({ ユイ: "Yui" });
  });

  it("使われなくなった訳は捨てない: 同じ原文へ引き継ぐ・近い原文に添える・取っておく", () => {
    const k = (file: string, src: string) => translationKey(file, "line", src);
    const before = updateTranslation(null, "en", scripts({ a: "　朝の光が窓から差しこんでいた。\n　犬が鳴いた。\n　雨。", b: "　移る行。" }), speakers).file;
    before.lines![k("a", "　朝の光が窓から差しこんでいた。")]!.text = "Morning light came through the window.";
    before.lines![k("a", "　犬が鳴いた。")]!.text = "A dog barked.";
    before.lines![k("b", "　移る行。")]!.text = "A moving line.";
    // b を c に名前を変え、a の一行を少し書き換え、一行を消す
    const r = updateTranslation(before, "en", scripts({ a: "　朝の光が窓から差しこんでいる。\n　雨。", c: "　移る行。" }), speakers);
    expect(r).toMatchObject({ carried: 1, suggested: 1, kept: 1, removed: 0, translated: 1 });
    expect(r.file.lines![k("c", "　移る行。")]!.text).toBe("A moving line.");
    expect(r.file.lines![k("a", "　朝の光が窓から差しこんでいる。")]).toMatchObject({ text: "", previous: { source: "　朝の光が窓から差しこんでいた。", text: "Morning light came through the window." } });
    expect(r.file.stale).toEqual({ [k("a", "　犬が鳴いた。")]: { source: "　犬が鳴いた。", text: "A dog barked." } });
    // 消した行を戻すと、取っておいた訳に戻る
    const back = updateTranslation(r.file, "en", scripts({ a: "　朝の光が窓から差しこんでいる。\n　犬が鳴いた。\n　雨。", c: "　移る行。" }), speakers);
    expect(back.file.lines![k("a", "　犬が鳴いた。")]!.text).toBe("A dog barked.");
    expect(back.file.stale).toBeUndefined();
  });

  it("近い原文は同じファイルの最も近い訳を添え、同点なら先の訳を一度だけ使う", () => {
    const k = (file: string, src: string) => translationKey(file, "line", src);
    const before = updateTranslation(null, "en", scripts({ a: "　abcdefghXX\n　abcdefghijY\n　abcdefghijZ", b: "　abcdefghijXY" }), speakers).file;
    for (const entry of Object.values(before.lines!)) entry.text = `訳: ${entry.source}`;
    const r = updateTranslation(before, "en", scripts({ a: "　abcdefghijX\n　abcdefghijW\n　無関係。", c: "　abcdefghijV" }), speakers);
    expect(r.file.lines![k("a", "　abcdefghijX")]!.previous).toEqual({ source: "　abcdefghijY", text: "訳: 　abcdefghijY" });
    expect(r.file.lines![k("a", "　abcdefghijW")]!.previous).toEqual({ source: "　abcdefghijZ", text: "訳: 　abcdefghijZ" });
    expect(r.file.lines![k("a", "　無関係。")]!.previous).toBeUndefined();
    expect(r.file.lines![k("c", "　abcdefghijV")]!.previous).toBeUndefined();
    expect(Object.keys(r.file.stale!)).toEqual([k("a", "　abcdefghXX"), k("b", "　abcdefghijXY")]);
  });

  it("検査: 訳の書き方の誤りはエラー、本文中の命令を落とした訳と使われていない訳は警告", () => {
    const s = scripts({ a: "ユイ「待って{@voice y.ogg}」\n　朝。" });
    const k1 = translationKey("a", "line", "「待って{@voice y.ogg}」");
    const k2 = translationKey("a", "line", "　朝。");
    const file = { language: "en", lines: { [k1]: { source: "", text: "“Wait.”" }, [k2]: { source: "", text: "Morning{" }, "a:lffffffff": { source: "old", text: "old" } } };
    expect(checkTranslation(file, "lang/en.json", s).map((d) => `${d.severity} ${d.code}`)).toEqual(["warning translation-lost-command", "error bad-translation", "warning unused-translation"]);
  });
});

describe("多言語: 場面ごとの訳し分け", () => {
  it("ファイル名を変えても場面だけの訳を同じ原文の選択肢に渡さない", () => {
    const source = "@choice\n  - Same sentence. -> #first\n@end\n# first\nSame sentence.\n# second\nSame sentence.";
    const file = updateTranslation(null, "en", scripts({ a: source }), speakers).file;
    file.lines![translationKey("a", "line", "Same sentence.")]!.contexts!.first = "場面の訳";
    const moved = updateTranslation(file, "en", scripts({ b: source }), speakers);
    expect(moved.file.lines![translationKey("b", "line", "Same sentence.")]!.contexts).toEqual({ first: "場面の訳", second: "" });
    expect(moved.file.lines![translationKey("b", "option", "Same sentence.")]).not.toHaveProperty("contexts");
    expect(moved).toMatchObject({ carried: 1, added: 1, kept: 0, removed: 1 });
  });

  it("同じ原文の場面だけの stale より共通の訳を優先して引き継ぐ", () => {
    const source = "Same sentence.";
    const staleKey = translationKey("old", "line", source);
    const file = updateTranslation(null, "en", scripts({ a: source }), speakers).file;
    file.lines![translationKey("a", "line", source)]!.text = "共通の訳";
    file.stale = { [staleKey]: { source, text: "", contexts: { first: "場面の訳" } } };
    const moved = updateTranslation(file, "en", scripts({ b: source }), speakers);
    expect(moved.file.lines![translationKey("b", "line", source)]!.text).toBe("共通の訳");
    expect(moved.file.stale).toEqual(file.stale);
    expect(moved).toMatchObject({ carried: 1, kept: 1, removed: 0 });
  });

  it("共通の訳が空でも場面の訳は stale に残し、行を戻すと復元する", () => {
    const s = scripts({ a: "# first\nSame sentence.\n# second\nSame sentence." });
    const key = translationKey("a", "line", "Same sentence.");
    const file = updateTranslation(null, "en", s, speakers).file;
    file.lines![key]!.contexts!.first = "同じ文。";
    const removed = updateTranslation(file, "en", scripts({ a: "" }), speakers);
    expect(removed).toMatchObject({ kept: 1, removed: 0, suggested: 0 });
    expect(removed.file.stale![key]).toEqual(file.lines![key]);
    const restored = updateTranslation(removed.file, "en", s, speakers);
    expect(restored.file.lines![key]).toEqual(file.lines![key]);
    expect(restored.file.stale).toBeUndefined();
  });

  it("空の場面の訳は外し、場面だけの訳は近い原文に添えず、同じ原文の移動では引き継ぐ", () => {
    const s = scripts({ a: "# first\nSame sentence.\n# second\nSame sentence." });
    const key = translationKey("a", "line", "Same sentence.");
    const file = updateTranslation(null, "en", s, speakers).file;
    expect(updateTranslation(file, "en", scripts({ a: "" }), speakers)).toMatchObject({ kept: 0, removed: 1 });
    file.lines![key]!.contexts!.first = "同じ文。";
    const near = updateTranslation(file, "en", scripts({ a: "Same sentence!" }), speakers);
    expect(near).toMatchObject({ added: 1, suggested: 0, kept: 1, removed: 0 });
    expect(Object.values(near.file.lines!)[0]).not.toHaveProperty("previous");
    const moved = updateTranslation(file, "en", scripts({ b: "# first\nSame sentence.\n# second\nSame sentence." }), speakers);
    expect(moved).toMatchObject({ carried: 1, kept: 0, removed: 0 });
    expect(moved.file.lines![translationKey("b", "line", "Same sentence.")]).toEqual(file.lines![key]);
  });

  it("固定 ID の古い訳は削除と復元を経ても訳したときの原文を保つ", () => {
    const file = updateTranslation(null, "en", scripts({ a: "Original sentence. #line:12345678" }), speakers).file;
    const key = "a:l@12345678";
    file.lines![key]!.text = "元の文。";
    const edited = scripts({ a: "Edited sentence. #line:12345678" });
    const changed = updateTranslation(file, "en", edited, speakers).file;
    const removed = updateTranslation(changed, "en", scripts({ a: "" }), speakers);
    expect(removed.file.stale![key]).toEqual(changed.lines![key]);
    const restored = updateTranslation(removed.file, "en", edited, speakers);
    expect(restored.file.lines![key]!.translatedFrom).toBe("Original sentence.");
    expect(restored.outdated).toBe(1);
    expect(translationToXliff(restored.file, "ja", { changed: true })).toContain(key);
  });

  const src = "　はい。\n# a\n　はい。\n@choice\n  - はい -> #b\n@end\n# b\n　はい。\n　一度だけ。\n@define m\n　はい。\n@end";

  it("同じ原文が二つ以上の場面に出る項目に、出る場面（ラベル）を並べる（最初のラベルの前と @define の中は場面なし）", () => {
    const items = collectTranslatable(scripts({ f: src }).get("f")!);
    expect(items.map((t) => [t.kind, t.source, t.contexts])).toEqual([
      ["line", "　はい。", ["a", "b"]],
      ["option", "はい", undefined],
      ["line", "　一度だけ。", undefined],
    ]);
    // 実行している位置の場面は、その番号より前でいちばん近いラベル
    expect(contextAt({ a: 2, b: 7 }, 1)).toBe("");
    expect(contextAt({ a: 2, b: 7 }, 2)).toBe("a");
    expect(contextAt({ a: 2, b: 7 }, 9)).toBe("b");
  });

  it("訳のファイルに場面を空の訳で並べ、書いた訳は残す。鍵は変えない。表は 鍵#場面 の行で書き出し、読み戻す", () => {
    const s = scripts({ f: src });
    const key = translationKey("f", "line", "　はい。");
    const first = updateTranslation(null, "en", s, speakers).file;
    expect(first.lines![key]).toEqual({ source: "　はい。", text: "", contexts: { a: "", b: "" } });
    first.lines![key]!.text = "Yes.";
    first.lines![key]!.contexts!.b = "Sure.";
    // 場面 a を無くしても、書いた訳（b）は残る
    const next = updateTranslation(first, "en", scripts({ f: "# x\n　はい。\n# b\n　はい。" }), speakers).file;
    expect(next.lines![key]).toEqual({ source: "　はい。", text: "Yes.", contexts: { x: "", b: "Sure." } });
    const csv = translationToCsv(next);
    expect(csv).toContain(`${key}#b,line,,　はい。,Sure.`);
    // 場面の行は数えない（数えるのは話者名と本文の行）
    expect(translationCount(next)).toMatchObject({ lines: 2, untranslatedLines: 1 });
    const back = applyTranslationTable(next, csv.replace(`${key}#x,line,,　はい。,,`, `${key}#x,line,,　はい。,Yes!,`));
    expect(back).toMatchObject({ applied: 1, unknown: 0 });
    expect(back.file.lines![key]!.contexts).toEqual({ x: "Yes!", b: "Sure." });
    // 場面の訳も検査する
    back.file.lines![key]!.contexts!.x = "Yes{";
    expect(checkTranslation(back.file, "lang/en.json", scripts({ f: "# x\n　はい。\n# b\n　はい。" })).map((d) => d.message)).toEqual([`${key}#x（　はい。）の訳の書き方が正しくありません: { のあとを解釈できません: {`]);
  });
});

describe("多言語: コマンドの文字と作品の設定の文字", () => {
  const chat: CommandSpec = {
    name: "chat",
    summary: "",
    positional: ["speaker"],
    params: { speaker: { type: { kind: "string", translate: "name" }, required: true, doc: "" }, text: { type: { kind: "string", translate: "text" }, doc: "" } },
    example: "",
  };
  const registry = createRegistry(CORE_COMMANDS, [chat]);

  it("訳す印のある引数に字面で書いた文字を集める（式・本文の中のコマンドは集めない）。名前の印の引数は話者名に並べる", () => {
    const s = scripts({ a: '@dialog "本当に？" ok-label=はい\n@dialog (game.x)\n@chat ユイ text="いまどこ？"\n@choice\n  - 扉 -> #x tip="古い扉"\n@end\n# x\n　{@backlog-add "本文の中"}朝。' }).get("a")!;
    const items = collectTranslatable(s, registry).filter((t) => t.kind === "arg");
    expect(items.map((t) => [t.source, t.note, t.line])).toEqual([
      ["本当に？", "@dialog", 1],
      ["はい", "@dialog", 1],
      ["いまどこ？", "@chat", 3],
      ["古い扉", "@choice", 5],
    ]);
    expect(items[0]!.key).toBe(translationKey("a", "arg", "本当に？"));
    expect(translationKeyKind(items[0]!.key)).toBe("arg");
    // registry を渡さなければ今までどおり（本文の行と選択肢だけ）
    expect(collectTranslatable(s).every((t) => t.kind === "line" || t.kind === "option")).toBe(true);
    expect(displayNames(s, registry)).toEqual(["ユイ"]);
    expect(displayNames(s)).toEqual([]);
  });

  it("作品の設定の文字（題・章・おまけ・持ち物・ui）を集め、訳に置き換えた写しを作る（元は変えない、id とパスはそのまま）", () => {
    const config = {
      title: "星の丘",
      chapters: [{ id: "ep1", number: "第一章", title: "坂道", files: ["ep1_*"] }],
      extra: {
        cg: [{ id: "a", title: "夜明け", images: ["a.png"] }],
        achievements: [{ id: "star", title: "流れ星", description: "見つけた" }],
        glossary: [{ id: "g", term: "坂道", aliases: ["さかみち"], description: "線" }],
      },
      items: { key: { name: "鍵", image: "key.png" } },
      ui: { contentWarning: { text: "注意" }, chapterNames: { ep1: "一章" } },
    };
    const texts = collectProjectTexts(config);
    expect(texts.map((t) => [t.source, t.note])).toEqual([
      ["星の丘", "title"],
      ["坂道", "chapters"],
      ["第一章", "chapters"],
      ["夜明け", "extra.cg"],
      ["流れ星", "extra.achievements"],
      ["見つけた", "extra.achievements"],
      ["線", "extra.glossary"],
      ["さかみち", "extra.glossary"],
      ["鍵", "items"],
      ["一章", "ui.chapterNames"],
      ["注意", "ui.contentWarning"],
    ]);
    expect(texts[0]!.key).toBe(projectTextKey("星の丘"));
    const en: Record<string, string> = { 星の丘: "Starry Hill", 坂道: "Slope", 流れ星: "Shooting Star", 鍵: "Key" };
    const out = mapProjectTexts(config, (s) => en[s] ?? s);
    expect(out.title).toBe("Starry Hill");
    expect(out.chapters![0]).toEqual({ id: "ep1", number: "第一章", title: "Slope", files: ["ep1_*"] });
    expect(out.extra!.glossary![0]!.term).toBe("Slope");
    expect(out.extra!.achievements![0]).toEqual({ id: "star", title: "Shooting Star", description: "見つけた" });
    expect(out.items!.key).toEqual({ name: "Key", image: "key.png" });
    expect(config.chapters[0]!.title).toBe("坂道");
  });

  it("訳のファイルに並べ、表に書き出す。検査は集める元を渡したときだけ使われていない訳を数え、訳し漏れを情報で知らせる", () => {
    const s = scripts({ a: '　朝。\n@dialog "本当に？"' });
    const project = { extra: { achievements: [{ id: "star", title: "流れ星" }] } };
    const r = updateTranslation(null, "en", s, speakers, { registry, project });
    expect(r.total).toBe(3);
    expect(r.file.lines![translationKey("a", "arg", "本当に？")]).toEqual({ source: "本当に？", text: "", note: "@dialog" });
    expect(r.file.lines![projectTextKey("流れ星")]).toEqual({ source: "流れ星", text: "", note: "extra.achievements" });
    expect(translationToCsv(r.file)).toContain(`${translationKey("a", "arg", "本当に？")},command,@dialog,本当に？`);
    expect(translationToCsv(r.file)).toContain(`${projectTextKey("流れ星")},setting,extra.achievements,流れ星`);
    // 集める元を渡さない検査（古い呼び方）は、コマンドの文字と作品の設定の文字を使われていない訳にしない
    expect(checkTranslation(r.file, "lang/en.json", s).map((d) => d.code)).toEqual(["untranslated"]);
    r.file.lines![projectTextKey("流れ星")]!.text = "Shooting Star";
    const all = checkTranslation(r.file, "lang/en.json", s, { registry, project: {} });
    expect(all.map((d) => `${d.code} ${d.message}`)).toEqual(["untranslated 訳のない項目が 2 件あります（原文を表示します）", "unused-translation 使われていない訳が 1 件あります（原文が変わったか削除された行）"]);
  });

  describe("パック（packs/<id>/scenario）の台本が使う訳（2026-11-19 の r1）", () => {
    // パックの台本 bonus は、パックに訳が無ければ本体の訳を使う
    const main = scripts({ a: "ユイ「本体」" });
    const pack = scripts({ bonus: "ユイ「おまけ{@wait 1s}」" });
    const bonusKey = collectTranslatable(pack.get("bonus")!)[0]!.key;
    const mainKey = collectTranslatable(main.get("a")!)[0]!.key;

    it("検査は、パックの台本だけが使う訳を「使われていない訳」にしない。訳の書き方は確かめ、訳し漏れには数えない", () => {
      const file = { language: "en", lines: { [mainKey]: { source: "「本体」", text: "\"Main\"" }, [bonusKey]: { source: "「おまけ{@wait 1s}」", text: "\"Bonus{r 間違い\"" } } };
      expect(checkTranslation(file, "lang/en.json", main).map((d) => d.code)).toEqual(["unused-translation"]);
      expect(checkTranslation(file, "lang/en.json", main, { alsoUsedBy: [pack] }).map((d) => `${d.severity} ${d.code}`)).toEqual(["error bad-translation", "warning translation-lost-command"]);
    });

    it("一緒に遊ばれてこの訳で出る台本（alsoShown。訳を持たないパックなど）は、訳し漏れにも数える", () => {
      const file = { language: "en", lines: { [mainKey]: { source: "「本体」", text: "\"Main\"" } } };
      expect(checkTranslation(file, "lang/en.json", main, { alsoUsedBy: [pack] }).map((d) => d.code)).toEqual([]);
      expect(checkTranslation(file, "lang/en.json", main, { alsoShown: [pack] }).map((d) => `${d.code} ${d.message}`)).toEqual(["untranslated 訳のない項目が 1 件あります（原文を表示します）"]);
    });

    it("lim i18n は、パックの台本だけが使う訳を stale に移さずに残す", () => {
      const existing = { language: "en", lines: { [bonusKey]: { source: "「おまけ{@wait 1s}」", text: "\"Bonus{@wait 1s}\"" } } };
      const r = updateTranslation(existing, "en", main, speakers, { alsoUsedBy: [pack] });
      expect(r.file.lines![bonusKey]).toEqual({ source: "「おまけ{@wait 1s}」", text: "\"Bonus{@wait 1s}\"" });
      expect(r.file.stale).toBeUndefined();
      expect(r.file.lines![mainKey]).toMatchObject({ source: "「本体」", text: "" });
      // パックを数えなければ、前と同じく stale に取っておく
      expect(updateTranslation(existing, "en", main, speakers).file.stale?.[bonusKey]).toBeDefined();
    });

    it("lim i18n は、この訳で出る台本（alsoShown。訳を持たないパック）の行も一覧に足す", () => {
      const r = updateTranslation(null, "en", main, speakers, { alsoShown: [pack] });
      expect(Object.keys(r.file.lines!)).toEqual([mainKey, bonusKey]);
      expect(r.file.lines![bonusKey]).toMatchObject({ source: "「おまけ{@wait 1s}」", text: "" });
      expect(r.total).toBe(2);
    });
  });
});
