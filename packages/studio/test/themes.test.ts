import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLUGIN_API_VERSION, UI_THEMES, type UiConfig } from "@liminalia/lang";
import { listUiThemes, loadProject, themeManifestDiagnostics } from "@liminalia/project";
import { applyTheme, restoreTrash } from "../src/server/manage.ts";
import { saveTheme, themeIdFor, trashTheme } from "../src/server/themes.ts";
import { StudioWorkspace } from "../src/server/workspace.ts";

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
let dir: string;
let ws: StudioWorkspace;

/** liminalia.json の ui を書いて読み直す。 */
async function setUi(ui: UiConfig): Promise<void> {
  const path = join(dir, "liminalia.json");
  const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  config.ui = ui;
  writeFileSync(path, JSON.stringify(config));
  ws = await StudioWorkspace.open(loadProject(dir));
}

const themeFile = (id: string) => JSON.parse(readFileSync(join(dir, "themes", id, "theme.json"), "utf8")) as { name: string; ui: UiConfig; engines?: unknown };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-themes-"));
  cpSync(TEMPLATE, dir, { recursive: true });
  ws = await StudioWorkspace.open(loadProject(dir));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("今の見た目をテーマとして保存", () => {
  it("見た目の項目だけを書き、操作の項目・作品固有の値・テーマの名前を入れない", async () => {
    await setUi({
      keys: { save: ["s"] },
      defaults: { bgm: 30 },
      text: { color: "#112233", rubySize: 0.4 },
      message: { background: "#000000", scroll: true },
      menuBar: { position: "top-left", items: ["auto"], color: "#abcdef" },
      title: { bgm: "theme.ogg", logo: "logo.png", menu: { align: "left" } },
      system: { preset: "night", accent: "#ff0000", images: { button: "my/button.png" } },
    });
    const saved = saveTheme(ws, "私のテーマ", false);
    expect(saved).toEqual({ ok: true, id: "theme" });
    const file = themeFile("theme");
    expect(file.name).toBe("私のテーマ");
    // 合うエンジンの宣言（今の口の版から。古いエンジンでは lim check が theme-engine-version で知らせる）
    expect(file.engines).toEqual({ liminalia: `>=${PLUGIN_API_VERSION}` });
    expect(file.ui).toEqual({
      text: { color: "#112233" },
      message: { background: "#000000" },
      menuBar: { color: "#abcdef" },
      title: { menu: { align: "left" } },
      system: { accent: "#ff0000", images: { button: "my/button.png" } },
    });
    // 一覧に並ぶ
    expect(listUiThemes(dir).find((t) => t.id === "theme")).toMatchObject({ name: "私のテーマ", local: true });
    expect(themeManifestDiagnostics(dir)).toEqual([]);
    // 新しいエンジン向けのテーマは知らせる
    writeFileSync(join(dir, "themes", "theme", "theme.json"), JSON.stringify({ ...file, engines: { liminalia: `>=${PLUGIN_API_VERSION + 1}` } }));
    expect(themeManifestDiagnostics(dir).map((d) => [d.code, d.file])).toEqual([["theme-engine-version", "themes/theme/theme.json"]]);
    // 保存は ui を変えない（選んでいるテーマの名前もそのまま）
    expect(ws.readUi()?.system?.preset).toBe("night");
  });

  it("保存したテーマを当てると見た目が戻り、残す項目はそのまま", async () => {
    await setUi({ text: { color: "#112233", rubySize: 0.4 }, system: { accent: "#ff0000" }, title: { bgm: "a.ogg" } });
    saveTheme(ws, "mine", false);
    await setUi({ text: { color: "#ffffff", rubySize: 0.6 }, system: { accent: "#00ff00" }, title: { bgm: "b.ogg" } });
    const ui = applyTheme(ws, "mine");
    expect(ui.text).toEqual({ rubySize: 0.6, color: "#112233" });
    expect(ui.system).toEqual({ preset: "mine", accent: "#ff0000" });
    expect(ui.title?.bgm).toBe("b.ogg");
  });

  it("同じ名前は上書きを頼むまで書かず、頼めば同じフォルダへ書く（素材は残す）", async () => {
    await setUi({ system: { accent: "#111111" } });
    expect(saveTheme(ws, "mine", false)).toEqual({ ok: true, id: "mine" });
    writeFileSync(join(dir, "themes/mine/keep.txt"), "x");
    await setUi({ system: { accent: "#222222" } });
    expect(saveTheme(ws, "mine", false)).toEqual({ ok: false, exists: "mine" });
    expect(themeFile("mine").ui.system?.accent).toBe("#111111");
    expect(saveTheme(ws, "mine", true)).toEqual({ ok: true, id: "mine" });
    expect(themeFile("mine").ui.system?.accent).toBe("#222222");
    expect(existsSync(join(dir, "themes/mine/keep.txt"))).toBe(true);
  });

  it("用意されたテーマの名前と空の名前は使えない", () => {
    expect(() => saveTheme(ws, UI_THEMES[1]!.name, false)).toThrow(/用意されたテーマ/);
    expect(() => saveTheme(ws, UI_THEMES[1]!.nameEn, false)).toThrow(/用意されたテーマ/);
    expect(() => saveTheme(ws, "   ", false)).toThrow(/名前/);
  });

  it("ID は英数字にし、用意されたテーマの ID とほかのテーマの ID を避ける", () => {
    expect(themeIdFor("My Theme!", new Set())).toBe("my-theme");
    expect(themeIdFor("夜", new Set())).toBe("theme");
    expect(themeIdFor("夜", new Set(["theme"]))).toBe("theme-2");
    expect(themeIdFor("Night", new Set())).toBe("night-2");
  });
});

describe("作品のテーマを外す", () => {
  it("ごみ箱に入れると一覧から消え、戻せる。ui はそのまま", async () => {
    await setUi({ system: { accent: "#111111" } });
    saveTheme(ws, "mine", false);
    const ui = applyTheme(ws, "mine");
    const { id } = trashTheme(ws, "mine");
    expect(existsSync(join(dir, "themes/mine"))).toBe(false);
    expect(listUiThemes(dir).some((t) => t.id === "mine")).toBe(false);
    expect(ws.readUi()).toEqual(ui);
    expect(restoreTrash(ws, id).restored).toEqual(["@themes/mine"]);
    expect(themeFile("mine").name).toBe("mine");
  });

  it("用意されたテーマは消せない", () => {
    expect(() => trashTheme(ws, "night")).toThrow(/用意されたテーマは削除できません/);
    expect(() => trashTheme(ws, "無い")).toThrow();
    expect(() => trashTheme(ws, "../x")).toThrow();
  });
});

describe("縦長専用のテーマ", () => {
  const setScreen = async (screen: { width: number; height: number }) => {
    const path = join(dir, "liminalia.json");
    const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    config.screen = screen;
    writeFileSync(path, JSON.stringify(config));
    ws = await StudioWorkspace.open(loadProject(dir));
  };

  it("横長の作品には当てられず、理由を返す。何も書かない", () => {
    const before = readFileSync(join(dir, "liminalia.json"), "utf8");
    expect(() => applyTheme(ws, "chat")).toThrowError(/縦長の作品専用/);
    expect(readFileSync(join(dir, "liminalia.json"), "utf8")).toBe(before);
    expect(existsSync(join(dir, "assets/image/themes/chat"))).toBe(false);
  });

  it("縦長の作品には当てられ、素材を写す。ほかのテーマはどちらの向きにも当てられる", async () => {
    expect(applyTheme(ws, "night").system?.preset).toBe("night");
    await setScreen({ width: 720, height: 1280 });
    const ui = applyTheme(ws, "chat");
    expect(ui.chat?.dialogue).toBe(true);
    expect(existsSync(join(dir, "assets/image/themes/chat/pattern.svg"))).toBe(true);
    expect(applyTheme(ws, "night").chat).toBeUndefined();
  });

  it("今の見た目の保存: 縦長の作品で保存したものは縦長専用になり、横長の作品のものには書かない", async () => {
    await setUi({ text: { color: "#112233" } });
    expect(saveTheme(ws, "横のテーマ", false)).toMatchObject({ ok: true });
    expect((themeFile("theme") as { orientation?: string }).orientation).toBeUndefined();
    expect(listUiThemes(dir).find((t) => t.name === "横のテーマ")?.orientation).toBeUndefined();

    await setScreen({ width: 720, height: 1280 });
    expect(saveTheme(ws, "縦のテーマ", false)).toMatchObject({ ok: true });
    expect(listUiThemes(dir).find((t) => t.name === "縦のテーマ")?.orientation).toBe("portrait");
    // チャットの設定もテーマに入る（作品の話者は入らない）
    await setUi({ chat: { dialogue: true, me: "ソウ", meBackground: "#123456" } });
    const saved = saveTheme(ws, "縦のチャット", false);
    expect(saved).toMatchObject({ ok: true });
    const id = (saved as { id: string }).id;
    expect(themeFile(id).ui).toEqual({ chat: { dialogue: true, meBackground: "#123456" } });
  });

  it("現在地の状態にも吹き出しの列が入り、テーマを替えると作り直す", async () => {
    await setScreen({ width: 720, height: 1280 });
    writeFileSync(join(dir, "scenario", "chatty.lim"), "アカリ「一」\nソウ「二」\nアカリ「三」\n");
    applyTheme(ws, "chat");
    const chatOf = async () => {
      const { sweep } = await ws.sweep("chatty");
      const last = sweep.lines[3]?.save.stage;
      return last?.extra["std.chat"] as unknown as { messages: unknown[] } | undefined;
    };
    expect((await chatOf())?.messages.length).toBeGreaterThan(0);
    applyTheme(ws, "night");
    expect(await chatOf()).toBeUndefined();
  });
});

describe("テーマ素材の整理", () => {
  it("適用後、以前の未使用素材だけをごみ箱へ移す", () => {
    applyTheme(ws, "mansion");
    const old = join(dir, "assets/image/themes/mansion/button.svg");
    expect(existsSync(old)).toBe(true);
    applyTheme(ws, "school");
    expect(existsSync(old)).toBe(false);
    expect(existsSync(join(dir, "assets/image/themes/mansion"))).toBe(false);
    expect(existsSync(join(dir, "assets/image/themes/school/button.svg"))).toBe(true);
    const trash = join(dir, ".liminalia/trash");
    const id = readdirSync(trash)[0]!;
    expect(existsSync(join(trash, id, "image/themes/mansion/button.svg"))).toBe(true);
    expect(restoreTrash(ws, id).restored).toContain("image/themes/mansion");
    expect(existsSync(old)).toBe(true);
  });

  it("作品で参照する素材と手を加えた素材を残す", async () => {
    writeFileSync(join(dir, "scenario/own.lim"), '@image "themes/mansion/panel.svg"\n');
    ws = await StudioWorkspace.open(loadProject(dir));
    applyTheme(ws, "mansion");
    const base = join(dir, "assets/image/themes/mansion");
    writeFileSync(join(base, "button.svg"), "作品で変更した素材");
    applyTheme(ws, "school");
    expect(readFileSync(join(base, "button.svg"), "utf8")).toBe("作品で変更した素材");
    expect(existsSync(join(base, "panel.svg"))).toBe(true);
    expect(existsSync(join(base, "button-hover.svg"))).toBe(false);
  });
});
