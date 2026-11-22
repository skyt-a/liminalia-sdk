import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MEDIA_TYPES } from "@liminalia/lang";
import { selectAssets } from "../src/commands/build.ts";
import { contentTypeOf } from "../src/content-types.ts";
import { mainActivity } from "../src/mobile/android.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("書き出しに入れる素材の種類", () => {
  it("制作画面が受ける音・動画（.aac .opus .mov .ogv）と、AVIF・シェーダーも入れ、表に無いものは入れない", () => {
    const dir = mkdtempSync(join(tmpdir(), "liminalia-media-"));
    dirs.push(dir);
    const files = ["bgm/a.aac", "voice/b.OPUS", "video/c.mov", "video/d.ogv", "image/e.avif", "others/shaders/f.frag", "others/g.eot", "bgimage/h.png", "others/notes.md", "fgimage/i.psd"];
    for (const f of files) {
      mkdirSync(join(dir, "assets", f, ".."), { recursive: true });
      writeFileSync(join(dir, "assets", f), "x");
    }
    const { files: selected, skipped } = selectAssets(join(dir, "assets"), [], []);
    expect(selected.map((f) => f.rel).sort()).toEqual(files.slice(0, 8).sort());
    for (const f of selected) expect(readFileSync(f.file, "utf8")).toBe("x");
    expect(Object.fromEntries(skipped)).toEqual({ ".md": 1, ".psd": 1 });
  });

  it("lim playtest と書き出しのあとの確かめ（content-types.ts）も、素材の表のどの拡張子にも中身の種類を答える", () => {
    for (const [ext, type] of Object.entries(MEDIA_TYPES)) expect(contentTypeOf(`assets/a${ext.toUpperCase()}`), ext).toBe(type);
    expect(contentTypeOf("index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeOf("README")).toBe("application/octet-stream");
  });

  it("デスクトップ版（main.cjs）と Android 版は、素材の表のどの拡張子にも中身の種類を答える", () => {
    const main = readFileSync(resolve(import.meta.dirname, "../../desktop/main.cjs"), "utf8");
    const mime = JSON.parse(/^const MIME = (\{.*\});$/m.exec(main)![1]!) as Record<string, string>;
    const java = mainActivity("com.example.game");
    for (const [ext, type] of Object.entries(MEDIA_TYPES)) {
      expect(mime[ext], ext).toBe(type);
      expect(java).toContain(`TYPES.put("${ext.slice(1)}", "${type.split(";")[0]}");`);
    }
  });
});
