import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyTyranoAssets, isTyranoProject, readTyranoConfig, tyranoStartScenario } from "../src/node.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");
let out: string | null = null;
afterEach(() => {
  if (out) rmSync(out, { recursive: true, force: true });
  out = null;
});

describe("TyranoScript の作品のフォルダ", () => {
  it("data/scenario に .ks があるものを TyranoScript の作品とみなす", () => {
    expect(isTyranoProject(join(FIXTURES, "builder-project"))).toBe(true);
    expect(isTyranoProject(join(FIXTURES, "builder-project/data"))).toBe(false);
    expect(isTyranoProject(FIXTURES)).toBe(false);
  });

  it("題名と画面の大きさを data/system/Config.tjs から読む", () => {
    expect(readTyranoConfig(join(FIXTURES, "builder-project"))).toEqual({ title: "雨の日の部屋", id: "rainy_room", width: 1024, height: 768 });
  });

  it("遊び始める .ks は、タイトル画面の *start の飛び先。タイトル画面が無ければ first.ks の飛び先", () => {
    expect(tyranoStartScenario(join(FIXTURES, "builder-project"))).toBe("room");
    expect(tyranoStartScenario(join(FIXTURES, "chara-project"))).toBe("scene1");
    // 飛び先が無いか、無いファイルを指すなら分からない
    out = mkdtempSync(join(tmpdir(), "liminalia-tyrano-start-"));
    mkdirSync(join(out, "data/scenario"), { recursive: true });
    writeFileSync(join(out, "data/scenario/first.ks"), '[jump storage="gone.ks"]\n[s]\n');
    expect(tyranoStartScenario(out)).toBe(null);
  });

  it("素材を同じ名前のフォルダへ写し、TyranoScript のプラグイン（others/plugin）は写さない", () => {
    out = mkdtempSync(join(tmpdir(), "liminalia-tyrano-assets-"));
    const r = copyTyranoAssets(join(FIXTURES, "builder-project"), out);
    expect(r.copied.sort()).toEqual(["bgimage/room.png", "bgm/morning.ogg", "fgimage/chara/akari/normal.png"]);
    expect(existsSync(join(out, "others/plugin/sample/button.png"))).toBe(false);
    // 二回目は同じものとして数え、写し直さない
    expect(copyTyranoAssets(join(FIXTURES, "builder-project"), out)).toMatchObject({ copied: [], same: 3 });
  });
});
