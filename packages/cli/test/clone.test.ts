import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyFiles, copyMethod, existingDir, planCopy, SPACE_RESERVE, type CopyMethod, type CopyProbe } from "../src/clone.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "liminalia-clone-"));
  dirs.push(d);
  return d;
};

/** 写し方と空きを決めた道具（ファイルの大きさは名前の数字、ディスクは名前の頭の文字）。 */
function fakeProbe(methods: Record<string, CopyMethod>, free: number): CopyProbe & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    method: (from) => {
      asked.push(from);
      return methods[from[0]!]!;
    },
    space: () => ({ free, block: 4096 }),
    size: (file) => Number(/\d+/.exec(file)![0]),
    device: (file) => file.charCodeAt(0),
  };
}

describe("書き出しの素材の写し（複製と空き）", () => {
  it("中身を写すなら、ブロックに切り上げた大きさとゆとりの分の空きを求め、足りなければ足りないと答える", () => {
    const pairs = [
      { from: "a1", to: "/out/x" },
      { from: "a5000", to: "/out/y" },
    ];
    const short = planCopy(pairs, "/out", fakeProbe({ a: "copy" }, SPACE_RESERVE));
    expect(short.needed).toBe(4096 + 8192 + SPACE_RESERVE);
    expect(short.enough).toBe(false);
    expect(planCopy(pairs, "/out", fakeProbe({ a: "copy" }, 12288 + SPACE_RESERVE)).enough).toBe(true);
  });

  it("複製できるものは空きを数えず、写し方は元のディスクごとに一度だけ確かめる", () => {
    const probe = fakeProbe({ a: "cp", b: "copy" }, 0);
    const plan = planCopy(
      [
        { from: "a100", to: "/o/1" },
        { from: "a200", to: "/o/2" },
        { from: "b4096", to: "/o/3" },
      ],
      "/o",
      probe,
    );
    expect(probe.asked).toEqual(["a100", "b4096"]);
    expect(plan.needed).toBe(4096 + SPACE_RESERVE);
    expect(planCopy([{ from: "a100", to: "/o/1" }], "/o", fakeProbe({ a: "clone" }, 0))).toMatchObject({ needed: 0, enough: true });
  });

  it("Mac の同じディスクの中は cp -c で複製する（Node の COPYFILE_FICLONE は Mac では中身を写すため）", () => {
    const d = temp();
    writeFileSync(join(d, "a.png"), "x");
    const method = copyMethod(join(d, "a.png"), join(d, "out", "deep"));
    if (process.platform === "darwin") expect(method).toBe("cp");
    else expect(["clone", "copy"]).toContain(method);
    // 試しに写したファイルは残さない
    expect(readdirSync(d)).toEqual(["a.png"]);
    expect(existingDir(join(d, "out", "deep"))).toBe(d);
  });

  // 千を超えるファイルを cp で写す
  it("フォルダごとにまとめて写し、名前の変わるもの・- で始まる名前・空白のある名前・千を超える数も写す", { timeout: 30_000 }, () => {
    const d = temp();
    const src = join(d, "assets");
    mkdirSync(join(src, "bgimage", "sub dir"), { recursive: true });
    mkdirSync(join(src, "sound"), { recursive: true });
    const pairs = [];
    for (let i = 0; i < 1200; i++) {
      writeFileSync(join(src, "sound", `s${i}.ogg`), `s${i}`);
      pairs.push({ from: join(src, "sound", `s${i}.ogg`), to: join(d, "out", "sound", `s${i}.ogg`) });
    }
    writeFileSync(join(src, "bgimage", "sub dir", "-a b.png"), "png");
    pairs.push({ from: join(src, "bgimage", "sub dir", "-a b.png"), to: join(d, "out", "bgimage", "sub dir", "-a b.png") });
    pairs.push({ from: join(src, "bgimage", "sub dir", "-a b.png"), to: join(d, "out", "renamed.png") });
    copyFiles(pairs, planCopy(pairs, join(d, "out")));
    expect(readdirSync(join(d, "out", "sound"))).toHaveLength(1200);
    expect(readFileSync(join(d, "out", "sound", "s1199.ogg"), "utf8")).toBe("s1199");
    expect(readFileSync(join(d, "out", "bgimage", "sub dir", "-a b.png"), "utf8")).toBe("png");
    expect(readFileSync(join(d, "out", "renamed.png"), "utf8")).toBe("png");
    // 写したものを書き換えても、元は変わらない（複製は書き換えたところから別のものになる）
    writeFileSync(join(d, "out", "renamed.png"), "changed");
    expect(readFileSync(join(src, "bgimage", "sub dir", "-a b.png"), "utf8")).toBe("png");
  });
});
