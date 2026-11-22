import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Cast } from "@liminalia/lang";
import { applyCastToTatieSettings, readTatieSettings, TATIE_SETTINGS, writeTatieSettings } from "../src/node.ts";

const frame = (width: number, height: number, left = 0, top = 0) => ({
  width,
  height,
  positions: { left: { left, top }, center: { left: left + 360, top }, right: { left: left + 720, top } },
});

describe("キャストを tatie の設定に書き戻す（applyCastToTatieSettings）", () => {
  it("storage と frame だけを書き、知らない項目・label・cacheKey・defaultCharacter・frameReference は保つ", () => {
    const settings = {
      schemaVersion: 2,
      defaultCharacter: "yuika",
      frameReference: { character: "yuika", appearance: "uniform", variant: "normal" },
      extra: { keep: true },
      characters: {
        yuika: {
          defaultAppearance: "uniform",
          folder: "yuika",
          appearances: {
            uniform: {
              label: "制服",
              folder: "yuika",
              variants: { normal: { storage: "yuika/a.png", cacheKey: "7", note: "x", frame: { width: 1, height: 2, anchor: "bottom", positions: { left: { left: 0, top: 0 } } } } },
            },
          },
        },
      },
    };
    const cast: Cast = {
      yuika: {
        defaultAppearance: "uniform",
        appearances: { uniform: { label: "べつの名前", variants: { normal: { image: "yuika/b.png", cacheKey: "9", frame: frame(400, 700, 10, 20) } } } },
      },
    };
    const { settings: out, written, skipped } = applyCastToTatieSettings(settings, cast);
    expect(written).toBe(1);
    expect(skipped).toEqual([]);
    expect(out).toEqual({
      schemaVersion: 2,
      defaultCharacter: "yuika",
      frameReference: { character: "yuika", appearance: "uniform", variant: "normal" },
      extra: { keep: true },
      characters: {
        yuika: {
          defaultAppearance: "uniform",
          folder: "yuika",
          appearances: {
            uniform: {
              label: "制服",
              folder: "yuika",
              variants: { normal: { storage: "yuika/b.png", cacheKey: "7", note: "x", frame: { anchor: "bottom", ...frame(400, 700, 10, 20) } } },
            },
          },
        },
      },
    });
  });

  it("無いキャスト・立ち絵セット・差分は足す（足した差分には cacheKey を写す）", () => {
    const settings = { characters: { yuika: { defaultAppearance: "a", appearances: { a: { label: "A", variants: { normal: { storage: "y/n.png" } } } } } } };
    const cast: Cast = {
      yuika: {
        appearances: {
          a: { variants: { normal: { image: "y/n.png", frame: frame(100, 200) }, smile: { image: "y/s.png", cacheKey: "k1", frame: frame(110, 210) } } },
          b: { label: "私服", variants: { normal: { image: "y/b.png", frame: frame(120, 220) } } },
        },
      },
      ren: { defaultAppearance: "default", appearances: { default: { variants: { normal: { image: "ren/n.png", frame: frame(300, 600) } } } } },
    };
    const { settings: out, written } = applyCastToTatieSettings(settings, cast);
    expect(written).toBe(4);
    expect(out.characters.yuika).toEqual({
      defaultAppearance: "a",
      appearances: {
        a: { label: "A", variants: { normal: { storage: "y/n.png", frame: frame(100, 200) }, smile: { storage: "y/s.png", cacheKey: "k1", frame: frame(110, 210) } } },
        b: { label: "私服", variants: { normal: { storage: "y/b.png", frame: frame(120, 220) } } },
      },
    });
    expect(out.characters.ren).toEqual({ defaultAppearance: "default", appearances: { default: { variants: { normal: { storage: "ren/n.png", frame: frame(300, 600) } } } } });
  });

  it("枠のない差分は書かない。消した差分は消さない", () => {
    const settings = { characters: { yuika: { appearances: { a: { variants: { gone: { storage: "y/g.png" } } } } } } };
    const cast: Cast = {
      yuika: { appearances: { a: { variants: { plain: { image: "y/p.png" } } } } },
      ren: { appearances: { default: { variants: { normal: { image: "ren/n.png" } } } } },
    };
    const { settings: out, written, skipped } = applyCastToTatieSettings(settings, cast);
    expect(written).toBe(0);
    expect(skipped).toEqual(["yuika / a / plain", "ren / default / normal"]);
    expect(out).toEqual({ characters: { yuika: { appearances: { a: { variants: { gone: { storage: "y/g.png" } } } } } } });
  });

  it("旧形式（差分だけ）のキャストは、同じ立ち絵セットだけならそのまま、ほかを足すなら appearances の形に移す", () => {
    const legacy = () => ({ characters: { ren: { variants: { normal: { storage: "ren/n.png", frame: frame(1, 1) } } } } });
    const one: Cast = { ren: { appearances: { default: { variants: { normal: { image: "ren/n.png", frame: frame(300, 600) } } } } } };
    expect(applyCastToTatieSettings(legacy(), one).settings.characters.ren).toEqual({ variants: { normal: { storage: "ren/n.png", frame: frame(300, 600) } } });

    const two: Cast = { ren: { appearances: { ...one.ren!.appearances, coat: { variants: { normal: { image: "ren/c.png", frame: frame(310, 610) } } } } } };
    expect(applyCastToTatieSettings(legacy(), two).settings.characters.ren).toEqual({
      appearances: {
        default: { label: "標準", variants: { normal: { storage: "ren/n.png", frame: frame(300, 600) } } },
        coat: { variants: { normal: { storage: "ren/c.png", frame: frame(310, 610) } } },
      },
    });
  });
});

describe("settings.js への書き戻し（writeTatieSettings、fixtures/tatie-project）", () => {
  let dir = "";
  let source = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "liminalia-tatie-"));
    source = join(dir, "tyrano");
    cpSync(join(import.meta.dirname, "fixtures/tatie-project"), source, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("同じ形の代入文で書き、前の版を残し、読み直すと書いた枠になる", () => {
    const before = readFileSync(join(source, TATIE_SETTINGS), "utf8");
    const cast = readTatieSettings(source).cast;
    cast.mio!.appearances.uniform!.variants.smile!.frame = frame(420, 735, 70, 5);
    cast.sora!.appearances.default!.variants.normal!.frame!.positions!.right = { left: 830, top: 30 };
    const result = writeTatieSettings(source, cast, { backupDir: join(dir, "backups") })!;
    expect(result.written).toBe(4);

    const text = readFileSync(join(source, TATIE_SETTINGS), "utf8");
    expect(text.startsWith("window.TYRANO_TATIE_SETTINGS = {\n    ")).toBe(true);
    expect(text.endsWith("};\n")).toBe(true);
    expect(readFileSync(result.backup, "utf8")).toBe(before);

    const reread = readTatieSettings(source).cast;
    expect(reread.mio!.appearances.uniform!.variants.smile).toEqual({ image: "mio/uniform_smile.png", cacheKey: "2", frame: frame(420, 735, 70, 5) });
    expect(reread.sora!.appearances.default!.variants.normal!.frame!.positions!.right).toEqual({ left: 830, top: 30 });
    // 旧形式のまま、defaultCharacter と frameReference も残る
    const window: { TYRANO_TATIE_SETTINGS?: Record<string, unknown> } = {};
    new Function("window", text)(window);
    expect(window.TYRANO_TATIE_SETTINGS).toMatchObject({ schemaVersion: 2, defaultCharacter: "mio", frameReference: { character: "mio", appearance: "uniform", variant: "normal" } });
    expect(Object.keys((window.TYRANO_TATIE_SETTINGS!.characters as Record<string, object>).sora!)).toEqual(["variants"]);
  });

  it("前の版は最新 keep 件まで", () => {
    const cast = readTatieSettings(source).cast;
    const backups = join(dir, "backups");
    for (let i = 0; i < 5; i++) {
      writeTatieSettings(source, cast, { backupDir: backups, keep: 3 });
    }
    // 同じミリ秒の写しは一つになるので、3 件以下
    const n = readdirSync(backups).filter((f) => f.startsWith("tatie-settings-")).length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(3);
  });

  it("settings.js が無ければ null、読めなければ書かずにエラー", () => {
    expect(writeTatieSettings(join(import.meta.dirname, "fixtures/chara-project"), {}, { backupDir: join(dir, "b") })).toBeNull();
    writeFileSync(join(source, TATIE_SETTINGS), "window.TYRANO_TATIE_SETTINGS = {");
    expect(() => writeTatieSettings(source, {}, { backupDir: join(dir, "b") })).toThrow(/tatie の設定を読めません/);
    expect(readFileSync(join(source, TATIE_SETTINGS), "utf8")).toBe("window.TYRANO_TATIE_SETTINGS = {");
  });
});

describe("同じ形の設定を別の場所・別の名前で持つ作品にも書き戻せる", () => {
  it("file と global を渡すと、そのファイルのその変数に書く", () => {
    const dir = mkdtempSync(join(tmpdir(), "tatie-other-"));
    try {
      const rel = "data/others/plugin/my_sprites/settings.js";
      const file = join(dir, rel);
      mkdirSync(join(dir, "data/others/plugin/my_sprites"), { recursive: true });
      writeFileSync(file, 'window.MY_SPRITES = {"characters":{"ユイカ":{"appearances":{"default":{"variants":{"normal":{"storage":"a.png","frame":{"width":10,"height":20,"positions":{"center":{"left":1,"top":2}}}}}}}}}};\n');
      const cast: Cast = { ユイカ: { appearances: { default: { variants: { normal: { image: "a.png", frame: { width: 30, height: 40, positions: { center: { left: 5, top: 6 } } } } } } } } };
      const r = writeTatieSettings(dir, cast, { backupDir: join(dir, ".bak"), file: rel, global: "MY_SPRITES" });
      expect(r?.file).toBe(file);
      const text = readFileSync(file, "utf8");
      expect(text.startsWith("window.MY_SPRITES = ")).toBe(true);
      expect(text).toContain('"width": 30');
      expect(readdirSync(join(dir, ".bak"))).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
