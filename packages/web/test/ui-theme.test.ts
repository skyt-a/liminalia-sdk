import { afterEach, describe, expect, it, vi } from "vitest";
import { checkUi, uiAssetReferences, type UiConfig } from "@liminalia/lang";
import { applyUiStyle } from "../src/ui-style.ts";
import { themeRootClasses, withActiveTheme, type WebPlugin } from "../src/plugin.ts";
import { UI_THEMES, applyUiTheme, uiThemeLook, uiThemeValues } from "@liminalia/lang";

/** 要素の style の代わり（CSS 変数を名前 → 値で持つ）。 */
function fakeElement() {
  const vars = new Map<string, string>();
  const classes = new Set<string>();
  return {
    vars,
    classes,
    offsetWidth: 1280,
    offsetHeight: 720,
    style: {
      cursor: "",
      left: "",
      top: "",
      setProperty: (k: string, v: string) => void vars.set(k, v),
      removeProperty: (k: string) => void vars.delete(k),
      getPropertyValue: (k: string) => vars.get(k) ?? "",
    },
    classList: { toggle: (c: string, on: boolean) => void (on ? classes.add(c) : classes.delete(c)) },
  };
}

/** 設定を当てて、舞台に書いた CSS 変数を返す。 */
function stageVars(ui: UiConfig | undefined, stage = fakeElement()) {
  vi.stubGlobal("document", { getElementById: () => null });
  const asset = (kind: string, path: string) => `/assets/${kind}/${path}`;
  applyUiStyle({ stage: stage as unknown as HTMLElement, message: fakeElement() as unknown as HTMLElement, name: fakeElement() as unknown as HTMLElement, asset }, ui);
  return { vars: Object.fromEntries(stage.vars), classes: stage.classes };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("チャットの画面（ui.chat）を CSS 変数に写す", () => {
  it("書かなければ変数を書かない（@chat の見た目は既定のまま）", () => {
    const { vars } = stageVars({ text: { size: 30 } });
    expect(Object.keys(vars).filter((k) => k.startsWith("--chat-") || k === "--lm-text-font")).toEqual([]);
  });

  it("色と形と絵を写す", () => {
    const { vars } = stageVars({ chat: { background: "#010203", image: "a.svg", headBackground: "#040506", otherBackground: "#070809", otherColor: "#0a0b0c", meBackground: "#0d0e0f", meColor: "#101112", radius: 20, tailRadius: 2, faceSize: 48, size: 25, font: "serif", typing: 300 } });
    expect(vars).toMatchObject({
      "--chat-bg": "#010203",
      "--chat-image": expect.stringContaining("/assets/image/a.svg"),
      "--chat-head-bg": "#040506",
      "--chat-other-bg": "#070809",
      "--chat-other-fg": "#0a0b0c",
      "--chat-me-bg": "#0d0e0f",
      "--chat-me-fg": "#101112",
      "--chat-radius": "20px",
      "--chat-tail-radius": "2px",
      "--chat-face-size": "48px",
      "--chat-size": "25px",
      "--chat-font": "serif",
    });
    // 吹き出しにしない作品のシステム画面の書体は変えない
    expect(vars["--lm-text-font"]).toBeUndefined();
  });

  it("吹き出しの作品は、システム画面の見出しの書体も揃える", () => {
    expect(stageVars({ chat: { dialogue: true, font: "serif" } }).vars["--lm-text-font"]).toBe("serif");
    expect(stageVars({ chat: { dialogue: true } }).vars["--lm-text-font"]).toBe("var(--font)");
  });
});

describe("システム画面のテーマ（ui.system）を CSS 変数に写す", () => {
  it("色と形を写し、薄い文字・細い線・触れたときの地は決めた色から作る", () => {
    const { vars, classes } = stageVars({ system: { theme: "light", fg: "#112233", screenBg: "#fefefe", controlBg: "#eeeeee", border: "#999999", radius: 12, titleBg: "linear-gradient(#fff, #eee)", accent: "#cc0000" } });
    expect(classes.has("lm-theme-light")).toBe(true);
    expect(vars).toMatchObject({
      "--lm-fg": "#112233",
      "--lm-fg-muted": "color-mix(in srgb, #112233 60%, transparent)",
      "--lm-screen-bg": "#fefefe",
      "--lm-control-bg": "#eeeeee",
      "--lm-control-hover": "color-mix(in srgb, #eeeeee, var(--lm-accent) 22%)",
      "--lm-border": "#999999",
      "--lm-border-faint": "color-mix(in srgb, #999999 45%, transparent)",
      "--lm-radius": "12px",
      "--lm-title-bg": "linear-gradient(#fff, #eee)",
      "--lm-accent": "#cc0000",
    });
    expect(vars["--lm-screen-image"]).toBeUndefined();
  });

  it("画像は素材の URL にし、ボタンと枠の画像があれば地の色と線を透明にする", () => {
    const { vars } = stageVars({ system: { controlBg: "#eee", images: { screen: "sys/bg.png", button: "sys/b.png", frame: "sys/f.png" } } });
    expect(vars).toMatchObject({
      "--lm-screen-image": 'url("/assets/bgimage/sys/bg.png")',
      "--lm-button-image": 'url("/assets/image/sys/b.png")',
      // 触れたときの画像を決めていなければ、ふだんの画像のまま
      "--lm-button-hover-image": 'url("/assets/image/sys/b.png")',
      "--lm-control-bg": "transparent",
      "--lm-control-hover": "transparent",
      "--lm-button-border": "transparent",
      "--lm-frame-image": 'url("/assets/image/sys/f.png")',
      "--lm-frame-bg": "transparent",
      "--lm-frame-border": "transparent",
    });
  });

  it("設定を外すと、前に書いた変数も消える（既定の CSS に戻る）", () => {
    const stage = fakeElement();
    stageVars({ system: { fg: "#fff", radius: 0, images: { screen: "a.png" } } }, stage);
    const { vars, classes } = stageVars(undefined, stage);
    expect(Object.keys(vars).filter((k) => k.startsWith("--lm-"))).toEqual([]);
    expect(classes.has("lm-theme-light")).toBe(false);
  });
});

describe("用意したテーマ", () => {
  it("名前が重ならず、日本語と英語の名前があり、中身は ui の形の確かめを通る", () => {
    expect(new Set(UI_THEMES.map((t) => t.id)).size).toBe(UI_THEMES.length);
    expect(UI_THEMES[0]!.id).toBe("default");
    for (const t of UI_THEMES) {
      expect(t.name, t.id).not.toBe("");
      expect(t.nameEn, t.id).toMatch(/^[\x20-\x7e]+$/);
      expect(checkUi(applyUiTheme({}, t)), t.id).toEqual([]);
      // 全テーマがゲーム中の見た目まで決める（既定は何も決めない）
      if (t.id !== "default") for (const key of ["text", "message", "name", "glyph", "choice", "system", "menuBar"] as const) expect(t.ui[key], `${t.id}.${key}`).toBeDefined();
      // 参照している素材は、テーマの assets にある
      for (const r of uiAssetReferences(applyUiTheme({}, t))) {
        expect(r.path.startsWith(`themes/${t.id}/`), r.path).toBe(true);
        expect(t.assets?.[r.path.slice(`themes/${t.id}/`.length)], r.path).toBeDefined();
      }
      // 素材は SVG だけ（解像度に縛られず、配布も軽い）
      for (const [name, content] of Object.entries(t.assets ?? {})) {
        expect(name).toMatch(/\.svg$/);
        expect(content).toContain("<svg");
      }
    }
  });

  it("選ぶと見た目を置き換えて preset を書き、書体と画像は決めていなければ残す", () => {
    const ui: UiConfig = { system: { fg: "#123456", font: "serif", images: { screen: "bg.png" } } };
    const night = UI_THEMES.find((t) => t.id === "night")!;
    const out = applyUiTheme(ui, night);
    expect(out.system).toEqual({ preset: "night", ...night.ui.system, font: "serif", images: { screen: "bg.png" } });
    expect(out.message).toEqual(night.ui.message);
    // 書体を決めているテーマは、その書体にする
    const washi = UI_THEMES.find((t) => t.id === "washi")!;
    expect(applyUiTheme(ui, washi).system?.font).toBe(washi.ui.system!.font);
    // 既定に戻すと、色と形は外れる
    const back = applyUiTheme(out, UI_THEMES[0]!);
    expect(back.system).toEqual({ preset: "default", font: "serif", images: { screen: "bg.png" } });
    expect(back.message).toBeUndefined();
    expect(back.choice).toBeUndefined();
    // 元の ui は書き換えない
    expect(ui.system?.fg).toBe("#123456");
  });

  it("操作の設定・タイトルの絵と音・本文の組み方・帯のボタンは、テーマを替えても残る", () => {
    const ui: UiConfig = {
      keys: { menu: ["Escape"] },
      saveSlots: 50,
      title: { bgm: "a.mp3", background: "t.png", logo: "l.png" },
      text: { size: 40, color: "#000", lineChars: 30, rubySize: 0.5 },
      message: { scroll: true, background: "#111" },
      menuBar: { items: ["save"], position: "top-left", color: "#111" },
    };
    for (const t of UI_THEMES) {
      const out = applyUiTheme(ui, t);
      expect(out.keys).toEqual(ui.keys);
      expect(out.saveSlots).toBe(50);
      expect(out.title).toMatchObject(ui.title!);
      expect(out.text).toMatchObject({ lineChars: 30, rubySize: 0.5 });
      expect(out.message?.scroll).toBe(true);
      expect(out.menuBar).toMatchObject({ items: ["save"], position: "top-left" });
      // 見た目は持ち越さない
      expect(out.message?.background).toBe(t.ui.message?.background);
      expect(out.text?.size).toBe(t.ui.text?.size);
    }
  });

  it("もう一度同じテーマを当てても変わらず、ほかのテーマを経由しても戻せる", () => {
    for (const t of UI_THEMES) {
      const once = applyUiTheme({}, t);
      expect(applyUiTheme(once, t)).toEqual(once);
      expect(applyUiTheme(applyUiTheme(once, UI_THEMES.at(-1)!), t).message).toEqual(once.message);
    }
  });

  it("テーマを替えても、前のテーマの書体と画像を持ち越さない（どの順で替えても、初めて選んだときと同じ）", () => {
    for (const from of UI_THEMES) {
      for (const to of UI_THEMES) {
        expect(applyUiTheme(applyUiTheme({}, from), to), `${from.id} → ${to.id}`).toEqual(applyUiTheme({}, to));
      }
    }
  });

  it("前のテーマの画像が残ったままの作品も、選び直せば外れ、作品が決めた画像は残る", () => {
    const school = UI_THEMES.find((t) => t.id === "school")!;
    const stale: UiConfig = { system: { preset: "school", images: { button: "themes/mansion/button.svg", buttonSlice: 8, frame: "my/frame.png", frameSlice: 12 } } };
    expect(applyUiTheme(stale, school).system?.images).toEqual({ frame: "my/frame.png", frameSlice: 12 });
  });

  it("作品の中のテーマも、一覧を渡せば前のテーマとして見分ける", () => {
    const local = { id: "mine", name: "m", nameEn: "m", local: true, ui: { system: { font: "Mine", images: { button: "ui/b.png" } }, text: { font: "Mine", fontFile: "m.woff2" } } };
    const night = UI_THEMES.find((t) => t.id === "night")!;
    const out = applyUiTheme(applyUiTheme({}, local), night, [...UI_THEMES, local]);
    expect(out).toEqual(applyUiTheme({}, night));
  });

  it("札の色は、決めていない項目を既定の配色（暗い・明るい）で埋める", () => {
    expect(uiThemeLook(undefined).fg).toBe("#ecebe6");
    expect(uiThemeLook({ theme: "light" }).fg).toBe("#23242a");
    expect(uiThemeLook({ theme: "light", fg: "#000" }).fg).toBe("#000");
  });
});

describe("ゲーム中の見た目の項目を CSS 変数に写す", () => {
  it("未設定なら、新しい変数を一つも書かない（今の見た目のまま）", () => {
    const { vars, classes } = stageVars({});
    expect(vars).toEqual({});
    expect([...classes]).toEqual([]);
  });

  it("画像の切り分けは border-image にし、ふだんの画像の変数は使わない", () => {
    const { vars } = stageVars({ choice: { image: "b.svg", hoverImage: "h.svg", imageSlice: [1, 2, 3, 4] }, message: { image: "f.svg", imageSlice: 8 } });
    expect(vars["--choice-border-image"]).toBe('url("/assets/image/b.svg") 1 2 3 4 fill / 1px 2px 3px 4px stretch');
    expect(vars["--choice-hover-border-image"]).toContain("h.svg");
    expect(vars["--choice-image"]).toBeUndefined();
    expect(vars["--message-border-image"]).toBe('url("/assets/image/f.svg") 8 8 8 8 fill / 8px 8px 8px 8px stretch');
    expect(vars["--message-image"]).toBeUndefined();
  });

  it("線の色 none は線の太さを 0 にし、グラデーションの地は背景の画像として書く", () => {
    const { vars } = stageVars({ message: { borderColor: "none" }, name: { borderColor: "none" }, choice: { borderColor: "none", background: "linear-gradient(#000, #111)", hoverBackground: "#222" } });
    expect(vars).toMatchObject({ "--message-border-width": "0px", "--name-border-width": "0px", "--choice-border-width": "0px" });
    expect(vars["--choice-gradient"]).toBe("linear-gradient(#000, #111)");
    expect(vars["--choice-bg"]).toBe("transparent");
    expect(vars["--choice-hover-bg"]).toBe("#222");
  });

  it("飾りと選択肢の間の枠の扱いは舞台のクラスにする", () => {
    const { classes } = stageVars({ choice: { ornament: "brackets", hideMessage: true } });
    expect(classes.has("lm-choice-brackets")).toBe(true);
    expect(classes.has("lm-choice-hide-message")).toBe(true);
  });
});

describe("結末の画面（ui.ending）と、本文の上の枠と知らせを CSS 変数に写す", () => {
  it("結末の画面の値を --lm-ending-* と舞台のクラスにする", () => {
    const { vars, classes } = stageVars({ ending: { background: "#010203", image: "end.webp", font: "serif", color: "#040506", size: 56, letterSpacing: "0.3em", kindColor: "#070809", rule: "#0a0b0c", markColor: "#0d0e0f", markSize: 30, mark: "above" } });
    expect(vars).toMatchObject({
      "--lm-ending-bg": "#010203",
      "--lm-ending-image": expect.stringContaining("/assets/bgimage/end.webp"),
      "--lm-ending-font": "serif",
      "--lm-ending-fg": "#040506",
      "--lm-ending-size": "56px",
      "--lm-ending-letter-spacing": "0.3em",
      "--lm-ending-kind-fg": "#070809",
      "--lm-ending-rule": "#0a0b0c",
      "--lm-ending-mark-fg": "#0d0e0f",
      "--lm-ending-mark-size": "30px",
    });
    expect([...classes].filter((c) => c.startsWith("lm-ending"))).toEqual(["lm-ending-mark-above"]);
    const none = stageVars({ ending: { mark: "none", rule: "none" } });
    expect(none.vars["--lm-ending-rule"]).toBeUndefined();
    expect([...none.classes].filter((c) => c.startsWith("lm-ending")).sort()).toEqual(["lm-ending-mark-none", "lm-ending-no-rule"]);
    // 書体を書いていなければ本文の書体。吹き出しの作品はチャットの書体（--lm-text-font）のまま
    expect(stageVars({ text: { font: "monospace" } }).vars["--lm-ending-font"]).toBe("monospace, var(--font-fallback)");
    expect(stageVars({ text: { font: "monospace" }, ending: { font: "serif" } }).vars["--lm-ending-font"]).toBe("serif");
    expect(stageVars({ text: { font: "monospace" }, chat: { dialogue: true } }).vars["--lm-ending-font"]).toBeUndefined();
  });

  it("確かめと入力の枠、通知、短い知らせの色は ui.system から取る（書かなければ変数を書かない）", () => {
    const { vars } = stageVars({ system: { fg: "#111", screenBg: "#eee", controlBg: "#ddd", border: "#999", accent: "#a00" } });
    expect(vars).toMatchObject({ "--lm-dialog-border": "#999", "--lm-dialog-button-bg": "#ddd", "--lm-dialog-button-fg": "#111", "--lm-notice-bg": "#eee", "--lm-notice-fg": "#111", "--lm-notice-theme-accent": "#a00", "--lm-toast-bg": "#eee" });
    expect(Object.keys(stageVars({ system: { theme: "light" } }).vars).filter((k) => /dialog|notice|toast/.test(k))).toEqual([]);
  });

  it("テーマを当てると結末の画面の値も置き換わり、今の見た目をテーマにするときも入る", () => {
    const theme = { id: "t", name: "t", nameEn: "t", ui: { ending: { color: "#123456", mark: "none" as const } } };
    const applied = applyUiTheme({ ending: { background: "#000", size: 40 } }, theme, [theme]);
    expect(applied.ending).toEqual({ color: "#123456", mark: "none" });
    expect(applyUiTheme({ ending: { background: "#000" } }, UI_THEMES[0]!).ending).toBeUndefined();
    expect(uiThemeValues({ ending: { rule: "none" }, keys: { menu: ["x"] } })).toEqual({ ending: { rule: "none" } });
    expect(checkUi({ ending: { mark: "left", size: "big" } }).map((d) => d.message)).toEqual([expect.stringContaining("ui.ending.mark"), expect.stringContaining("ui.ending.size")]);
    expect(uiAssetReferences({ ending: { image: "end.webp" } })).toEqual([{ folder: "bgimage", path: "end.webp", where: "ui.ending.image" }]);
  });
});

describe("章の扉と章末（ui.chapter）を CSS 変数に写す", () => {
  it("章の扉の値を --lim-chapter-* と舞台のクラスにする", () => {
    const { vars, classes } = stageVars({ chapter: { background: "#010203", image: "door.webp", font: "serif", color: "#040506", size: 60, letterSpacing: "0.3em", accent: "#070809", numberSize: 26, subtitleColor: "#0a0b0c", subtitleSize: 20, rule: "#0d0e0f", endColor: "#101112", endSize: 50 } });
    expect(vars).toMatchObject({
      "--lim-chapter-bg": "#010203",
      "--lim-chapter-image": expect.stringContaining("/assets/bgimage/door.webp"),
      "--lim-chapter-font": "serif",
      "--lim-chapter-fg": "#040506",
      "--lim-chapter-size": "60px",
      "--lim-chapter-letter-spacing": "0.3em",
      "--lim-chapter-accent": "#070809",
      "--lim-chapter-number-size": "26px",
      "--lim-chapter-subtitle-fg": "#0a0b0c",
      "--lim-chapter-subtitle-size": "20px",
      "--lim-chapter-rule": "#0d0e0f",
      "--lim-chapter-end-fg": "#101112",
      "--lim-chapter-end-size": "50px",
    });
    expect([...classes].filter((c) => c.startsWith("lm-chapter"))).toEqual([]);
    const none = stageVars({ chapter: { rule: "none" } });
    expect(none.vars["--lim-chapter-rule"]).toBeUndefined();
    expect([...none.classes].filter((c) => c.startsWith("lm-chapter"))).toEqual(["lm-chapter-no-rule"]);
    expect(Object.keys(stageVars({}).vars).filter((k) => k.startsWith("--lim-chapter"))).toEqual([]);
  });

  it("テーマを当てると章の扉の値も置き換わり、今の見た目をテーマにするときも入る。確かめと素材の参照", () => {
    const theme = { id: "t", name: "t", nameEn: "t", ui: { chapter: { color: "#123456", rule: "none" } } };
    expect(applyUiTheme({ chapter: { background: "#000", size: 40 } }, theme, [theme]).chapter).toEqual({ color: "#123456", rule: "none" });
    expect(applyUiTheme({ chapter: { background: "#000" } }, UI_THEMES[0]!).chapter).toBeUndefined();
    expect(uiThemeValues({ chapter: { accent: "#fff" }, keys: { menu: ["x"] } })).toEqual({ chapter: { accent: "#fff" } });
    expect(checkUi({ chapter: { size: "big", numberSize: 22, color: 3 } }).map((d) => d.message)).toEqual([expect.stringContaining("ui.chapter.size"), expect.stringContaining("ui.chapter.color")]);
    expect(checkUi({ languages: { en: { chapter: { font: "serif" } } } })).toEqual([]);
    expect(uiAssetReferences({ chapter: { image: "door.webp" } })).toEqual([{ folder: "bgimage", path: "door.webp", where: "ui.chapter.image" }]);
  });
});

describe("プラグインのテーマの出し分け", () => {
  const screens = { config: () => document.createElement("div") };
  const text = { glyph: () => document.createElement("span") };
  const plugin: WebPlugin = {
    name: "p",
    texts: { a: "1", b: "2" },
    extensions: { renderers: {} },
    themes: { mine: { screens, text, texts: { b: "3" }, title: () => document.createElement("div"), rootClass: "mine-root" } },
  };

  it("preset が合うときだけ、画面と本文の見た目を重ねる", () => {
    const on = withActiveTheme(plugin, "mine");
    expect(on.screens?.config).toBe(screens.config);
    expect(on.extensions?.text).toBe(text);
    expect(on.extensions?.renderers).toEqual({});
    expect(on.texts).toEqual({ a: "1", b: "3" });
    expect(on.title).toBeDefined();
    for (const preset of ["washi", undefined]) {
      const off = withActiveTheme(plugin, preset);
      expect(off.screens).toBeUndefined();
      expect(off.title).toBeUndefined();
      expect(off.extensions?.text).toBeUndefined();
      expect(off.texts).toEqual({ a: "1", b: "2" });
    }
  });

  it("舞台のクラスは preset が合うプラグインのものだけ", () => {
    expect(themeRootClasses([plugin], "mine")).toEqual(["mine-root"]);
    expect(themeRootClasses([plugin], "washi")).toEqual([]);
    expect(themeRootClasses([plugin], undefined)).toEqual([]);
  });
});
