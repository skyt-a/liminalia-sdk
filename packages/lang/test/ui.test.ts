import { describe, expect, it } from "vitest";
import { englishDiagnostic } from "../src/diagnostics-en.ts";
import { applyUiTheme, autosaveSlotCount, autosaveTimings, backlogPages, chatDialogueOption, checkUi, keysFor, quickSlotCount, resolveKeys, saveSlotCount, themeFitsScreen, themesForScreen, UI_THEMES, uiAssetReferences, uiThemeLook, uiThemeValues, uiForLanguage } from "../src/index.ts";

describe("ゲームの設定（liminalia.json の ui）", () => {
  it("正しい形なら誤りなし", () => {
    expect(
      checkUi({
        text: { size: 28, color: "#fff", decoration: "edge", readColor: "#aaa" },
        message: { x: 40, height: 180, image: "frame.png" },
        menuBar: { items: ["save", "load"], position: "top-left" },
        keys: { backlog: ["b"], rollback: ["ArrowUp"] },
        saveSlots: 30,
        rollback: { enabled: true, fixChoices: true },
        input: { wheelUp: "rollback" },
      }),
    ).toEqual([]);
    expect(checkUi({ rollback: { fixChoices: "yes" }, input: { wheelUp: "jump" } }).map((d) => d.message)).toEqual(["ui.rollback.fixChoices は true か false で書きます", "ui.input.wheelUp は backlog、rollback のどれかを指定します"]);
    expect(keysFor(undefined, "rollback")).toEqual(["PageUp"]);
  });

  it("クイックメニューの左端と上端（menuBar.x・y。制作画面の配置の編集が書く）", () => {
    expect(checkUi({ menuBar: { position: "top-left", x: 120, y: -4 } })).toEqual([]);
    expect(checkUi({ menuBar: { x: "120" } }).map((d) => d.message)).toEqual(["ui.menuBar.x は数値で書きます"]);
    // テーマを替えても、置く場所は作り手の決めたまま残す
    for (const theme of UI_THEMES) expect(applyUiTheme({ menuBar: { x: 120, y: 8 } }, theme).menuBar, theme.id).toMatchObject({ x: 120, y: 8 });
  });

  it("選択肢の置き方（choice.position）", () => {
    for (const position of ["center", "top", "bottom", "avoid-faces", "inline"]) expect(checkUi({ choice: { position } }), position).toEqual([]);
    expect(checkUi({ choice: { position: "auto" } }).map((d) => d.message)).toEqual(["ui.choice.position は center、top、bottom、avoid-faces、inline のどれかを指定します"]);
  });

  it("オートセーブ・オート中の表示・横になぞる操作", () => {
    expect(checkUi({ autosave: { slots: 5, leave: false }, indicator: "bottom-right", input: { swipeSide: "none" }, screen: { textScale: "message" } })).toEqual([]);
    expect(checkUi({ screen: { textScale: "name" } }).map((d) => d.message)).toEqual(["ui.screen.textScale は all、message のどれかを指定します"]);
    expect(checkUi({ autosave: { slots: "3", every: 1 }, indicator: "middle", input: { swipeSide: "back" } }).map((d) => d.message)).toEqual([
      "ui.autosave.slots は数値で書きます",
      "ui.autosave.every という項目はありません",
      "ui.indicator は top-left、top-right、bottom-left、bottom-right、hidden のどれかを指定します",
      "ui.input.swipeSide は rollback、none のどれかを指定します",
    ]);
    // 帯には作品の画面（screen:<名前>）も置ける
    expect(checkUi({ menuBar: { items: ["save", "screen:town.map"], labels: { "screen:town.map": "地図" } } })).toEqual([]);
    expect(checkUi({ menuBar: { items: ["screen:"] } }).map((d) => d.message)).toEqual([expect.stringMatching(/screen:<作品の画面の名前> の配列で書きます$/)]);
    expect([autosaveSlotCount(undefined), autosaveSlotCount({ autosave: { slots: 0 } }), autosaveSlotCount({ autosave: { slots: 40 } })]).toEqual([3, 0, 10]);
  });

  it("オートセーブの時機、タイトルの「つづきから」、システム画面の効果音、音量の試聴", () => {
    expect(checkUi({ autosave: { on: { choice: false, chapter: true, pages: 20 } }, title: { resume: true }, sound: { ui: { hover: "ui/h.ogg", cancel: "ui/c.ogg" } }, settings: { samples: { bgm: "a.ogg", se: "b.ogg", voice: "c.ogg" } } })).toEqual([]);
    expect(checkUi({ autosave: { on: { pages: -1, every: 2 } }, title: { resume: "yes" }, sound: { ui: { click: "a.ogg", open: 1 } }, settings: { samples: { music: "a.ogg" } } }).map((d) => d.message)).toEqual([
      "ui.autosave.on.pages は 0 以上の整数で書きます",
      "ui.autosave.on.every という項目はありません",
      "ui.title.resume は true か false で書きます",
      "ui.sound.ui.click という項目はありません",
      "ui.sound.ui.open は文字列で書きます",
      "ui.settings.samples.music という項目はありません",
    ]);
    expect([autosaveTimings(undefined), autosaveTimings({ autosave: { on: { choice: false, chapter: true, pages: 15 } } })]).toEqual([
      { choice: true, chapter: false, pages: 0 },
      { choice: false, chapter: true, pages: 15 },
    ]);
    expect(uiAssetReferences({ sound: { ui: { open: "ui/open.ogg" } }, settings: { samples: { bgm: "s.ogg", voice: "v.ogg" } } }).map((r) => `${r.folder}/${r.path} ${r.where}`)).toEqual([
      "sound/ui/open.ogg ui.sound.ui.open",
      "bgm/s.ogg ui.settings.samples.bgm",
      "voice/v.ogg ui.settings.samples.voice",
    ]);
  });

  it("知らない項目・型の誤り・選べない値を知らせる", () => {
    const messages = checkUi({ text: { size: "大", weigth: 3 }, glyph: { motion: "spin" }, menuBar: { items: ["fly"] }, keys: { jump: ["j"] }, colour: 1 }).map((d) => d.message);
    expect(messages).toEqual([
      "ui.text.size は数値で書きます",
      "ui.text.weigth という項目はありません",
      "ui.glyph.motion は bounce、blink、breathe、none のどれかを指定します",
      expect.stringMatching(/^ui\.menuBar\.items は /),
      expect.stringMatching(/^ui\.keys\.jump という操作はありません/),
      "ui.colour という項目はありません",
    ]);
  });

  it("セーブの枠は 8 の倍数に切り上げて幅に収め、履歴とキーは既定を持つ", () => {
    expect(saveSlotCount(undefined)).toBe(48);
    expect(saveSlotCount({ saveSlots: 30 })).toBe(32);
    expect(saveSlotCount({ saveSlots: 999 })).toBe(200);
    expect(backlogPages({ backlog: 5 })).toBe(10);
    expect(keysFor(undefined, "advance")).toEqual(["Enter", " "]);
    expect(keysFor({ keys: { advance: ["z"] } }, "advance")).toEqual(["z"]);
    expect(quickSlotCount(undefined)).toBe(3);
    expect(quickSlotCount({ quickSave: { slots: 0 } })).toBe(1);
    expect(checkUi({ quickSave: { slots: 2 }, input: { middleClick: "none", numberKeys: false } })).toEqual([]);
  });

  it("既定のキーは、遊ぶ人か作品がほかの操作に割り当てたキーを除く", () => {
    const keys = resolveKeys({ keys: { hide: [" "], advance: ["Enter"] } });
    expect(keys.hide).toEqual([" "]);
    expect(keys.skip).toEqual(["Tab"]);
    expect(keys.auto).toEqual(["a", "A"]);
    // 遊ぶ人が a をバックログにすると、オートの既定から a が外れる
    const mine = resolveKeys(undefined, { backlog: ["a"] });
    expect(mine.backlog).toEqual(["a"]);
    expect(mine.auto).toEqual(["A"]);
    // 空の配列で止める
    expect(resolveKeys({ keys: { skip: [] } }).skip).toEqual([]);
  });

  it("参照する素材（書き出しと素材の確かめに使う）", () => {
    expect(uiAssetReferences({ text: { fontFile: "font.woff2" }, title: { background: "t.png", bgm: "t.ogg" } })).toEqual([
      { folder: "others", path: "font.woff2", where: "ui.text.fontFile" },
      { folder: "bgimage", path: "t.png", where: "ui.title.background" },
      { folder: "bgm", path: "t.ogg", where: "ui.title.bgm" },
    ]);
  });

  it("システム画面のテーマ: 色と形と画像を受け、画像は素材として数える", () => {
    const system = { preset: "night", theme: "dark", fg: "#fff", screenBg: "#000", controlBg: "#111", border: "#333", radius: 8, titleBg: "linear-gradient(#000, #111)", images: { screen: "sys/bg.png", button: "sys/b.png", buttonHover: "sys/bh.png", frame: "sys/f.png" } } as const;
    expect(checkUi({ system })).toEqual([]);
    expect(uiAssetReferences({ system }).map((r) => `${r.folder}/${r.path}`)).toEqual(["bgimage/sys/bg.png", "image/sys/b.png", "image/sys/bh.png", "image/sys/f.png"]);
    expect(checkUi({ system: { radius: "8px", images: { back: "a.png", frame: 1 } } }).map((d) => d.message)).toEqual([
      "ui.system.radius は数値で書きます",
      "ui.system.images.back という項目はありません",
      "ui.system.images.frame は文字列で書きます",
    ]);
  });
});

describe("クリアの状況で変わるタイトル", () => {
  it("if が真の最初のものが、書いた項目だけ置き換える", async () => {
    const { resolveTitle, checkUi } = await import("../src/index.ts");
    const title = { background: "a.png", bgm: "a.ogg", variants: [{ if: "(system.x)", background: "b.png" }, { if: "(system.y)", bgm: "c.ogg" }] };
    expect(resolveTitle(title, () => false)).toEqual({ background: "a.png", bgm: "a.ogg" });
    expect(resolveTitle(title, (c) => c === "(system.x)")).toEqual({ background: "b.png", bgm: "a.ogg" });
    expect(resolveTitle(title, (c) => c === "(system.y)")).toEqual({ background: "a.png", bgm: "c.ogg" });
    expect(checkUi({ title: { variants: [{ if: "(system.x", logo: 1 }, { background: "x.png" }] } }).map((d) => d.message)).toEqual([
      expect.stringContaining("ui.title.variants[0].if の式が読めません"),
      "ui.title.variants[0].logo は文字列で書きます",
      expect.stringContaining("ui.title.variants[1].if がありません"),
    ]);
  });
});

describe("ui.chat", () => {
  it("項目の型と選べる値を確かめる", () => {
    expect(checkUi({ chat: { dialogue: true, me: "ソウ", radius: 12, showName: "first", typing: 300, showFace: true, image: "a.svg" } })).toEqual([]);
    expect(checkUi({ chat: { dialogue: "yes", radius: "12", showName: "sometimes", nope: 1 } }).map((d) => d.message)).toEqual([
      "ui.chat.dialogue は true か false で書きます",
      "ui.chat.radius は数値で書きます",
      "ui.chat.showName は always、first、none のどれかを指定します",
      "ui.chat.nope という項目はありません",
    ]);
  });

  it("絵は素材の参照に数える", () => {
    expect(uiAssetReferences({ chat: { image: "themes/chat/pattern.svg" } })).toEqual([{ folder: "image", path: "themes/chat/pattern.svg", where: "ui.chat.image" }]);
  });

  it("dialogue のときだけ実行器の設定を返す", () => {
    expect(chatDialogueOption({ chat: { me: "ソウ" } })).toBeUndefined();
    expect(chatDialogueOption(undefined)).toBeUndefined();
    expect(chatDialogueOption({ chat: { dialogue: true } })).toEqual({});
    expect(chatDialogueOption({ chat: { dialogue: true, me: "ソウ", title: "ユイ" } })).toEqual({ me: "ソウ", title: "ユイ" });
  });
});

describe("テーマの向き", () => {
  const chat = UI_THEMES.find((t) => t.id === "chat")!;
  const portrait = { width: 720, height: 1280 };
  const landscape = { width: 1280, height: 720 };

  it("チャットのテーマは縦長専用で、ほかの用意したテーマは向きを問わない", () => {
    expect(chat.orientation).toBe("portrait");
    expect(UI_THEMES.filter((t) => t.orientation).map((t) => t.id)).toEqual(["chat"]);
    expect(themeFitsScreen(chat, portrait)).toBe(true);
    expect(themeFitsScreen(chat, landscape)).toBe(false);
    expect(themeFitsScreen({}, landscape)).toBe(true);
  });

  it("並べる順: 横長の作品には出さず、縦長の作品では縦長専用を別にする", () => {
    expect(themesForScreen(UI_THEMES, landscape)).toEqual({ portrait: [], other: UI_THEMES.filter((t) => t !== chat) });
    expect(themesForScreen(UI_THEMES, portrait)).toEqual({ portrait: [chat], other: UI_THEMES.filter((t) => t !== chat) });
  });

  it("チャットのテーマの値は確かめに通り、素材を参照する", () => {
    expect(checkUi(applyUiTheme({}, chat))).toEqual([]);
    const image = chat.ui.chat?.image;
    expect(image).toBe("themes/chat/pattern.svg");
    expect(Object.keys(chat.assets ?? {})).toContain("pattern.svg");
  });

  it("別のテーマへ替えると ui.chat の見た目は残らず、話者と題は残る。戻すと元と同じ", () => {
    const applied = applyUiTheme({ chat: { me: "ソウ", title: "ユイ" }, keys: { save: ["s"] } }, chat);
    expect(applied.chat?.dialogue).toBe(true);
    expect(applied.chat?.me).toBe("ソウ");
    const night = applyUiTheme(applied, UI_THEMES.find((t) => t.id === "night")!);
    expect(night.chat).toEqual({ me: "ソウ", title: "ユイ" });
    expect(night.keys).toEqual({ save: ["s"] });
    expect(chatDialogueOption(night)).toBeUndefined();
    expect(applyUiTheme(night, chat)).toEqual(applied);
    // テーマに書く値には、作品の話者と題を入れない
    expect(uiThemeValues(applied).chat?.me).toBeUndefined();
    expect(uiThemeValues(applied).chat?.dialogue).toBe(true);
  });

  it("見本の札の色: 吹き出しのテーマだけ chat を持つ", () => {
    expect(uiThemeLook(chat.ui.system, chat.ui).chat).toMatchObject({ me: chat.ui.chat!.meBackground, other: chat.ui.chat!.otherBackground });
    const night = UI_THEMES.find((t) => t.id === "night")!;
    expect(uiThemeLook(night.ui.system, night.ui).chat).toBeUndefined();
  });

  it("起動の演出（ui.splash）: 正しい形なら誤りなし、誤りは場所付きで（英語の表示も）、ロゴは素材として数える", () => {
    const splash = {
      logos: [{ image: "brand/logo.png", background: "#fff", time: 2000 }],
      notice: { title: "はじめにお読みください", blocks: [{ label: "01", text: "この物語はフィクションです。" }], time: 6000, auto: true },
      skip: true,
      fade: 600,
    };
    expect(checkUi({ splash })).toEqual([]);
    expect(uiAssetReferences({ splash }).map((r) => `${r.folder}:${r.path}:${r.where}`)).toEqual(["image:brand/logo.png:ui.splash.logos[0].image"]);
    const bad = checkUi({ splash: { logos: [{ time: -1 }, { image: "a.png", size: 2 }], notice: { blocks: [{ label: 1 }], auto: "yes" }, skip: 1, foo: true } });
    expect(bad.map((d) => d.message)).toEqual([
      "ui.splash.logos[0] に image がありません",
      "ui.splash.logos[1].size という項目はありません",
      "ui.splash.notice.blocks[0] に text がありません",
      "ui.splash.notice.auto は true か false で書きます",
      "ui.splash.skip は true か false で書きます",
      "ui.splash.foo という項目はありません",
    ]);
    expect(englishDiagnostic(bad[0]!).message).toBe("ui.splash.logos[0] has no image");
  });
});

describe("言語ごとの見た目（ui.languages）", () => {
  const ui = {
    fonts: [{ family: "Base", file: "fonts/base.woff2" }],
    text: { font: "Base", size: 26, color: "#fff" },
    languages: { en: { fonts: [{ family: "Latin", file: "fonts/latin.woff2" }], text: { font: "Latin", size: 22 }, choice: { size: 20 } } },
  };

  it("遊んでいる言語のものを項目ごとに重ね、書いていない項目と言語はそのまま。fonts は足す", () => {
    const en = uiForLanguage(ui, "en")!;
    expect(en.text).toEqual({ font: "Latin", size: 22, color: "#fff" });
    expect(en.choice).toEqual({ size: 20 });
    expect(en.fonts!.map((f) => f.family)).toEqual(["Base", "Latin"]);
    expect(uiForLanguage(ui, "ja")).toBe(ui);
    expect(uiForLanguage(undefined, "en")).toBeUndefined();
  });

  it("形を確かめ、言語ごとに書けない項目を断る。書体のファイルは素材の参照に入る", () => {
    expect(checkUi(ui)).toEqual([]);
    const bad = checkUi({ languages: { en: { title: { logo: "x.png" }, text: { size: "big" } }, ko: 1 } });
    expect(bad.map((d) => d.message)).toEqual([
      "ui.languages.en.title は言語ごとに書けません（書けるのは fonts、text、message、name、glyph、choice、chat、system、ending、chapter）",
      "ui.languages.en.text.size は数値で書きます",
      "ui.languages.ko はオブジェクトで書きます",
    ]);
    expect(uiAssetReferences(ui).map((r) => r.where)).toEqual(["ui.fonts[0].file", "ui.languages.en.fonts[0].file"]);
  });
});
