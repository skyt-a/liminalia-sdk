import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DESKTOP_LICENSE_FILES, desktopArch, desktopIconProblem, ELECTRON_LICENSE_FILES, macAppDmg, THIRD_PARTY_LICENSES_FILE, thirdPartyLicensesText, macAppZip, movePath, removeElectronLocales, storeBuildNumber, windowsIcon } from "../src/commands/build.ts";
import { imageSize } from "@liminalia/lang";
import { parseFlags } from "../src/context.ts";
import { zipContents } from "../src/zip.ts";

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "liminalia-packaging-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const has = (cmd: string, args: string[]) => {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** フレームワークのようなシンボリックリンクと、実行の許可のあるファイルを持つ、見かけだけのアプリ。 */
function fakeApp(dir: string): string {
  const app = join(dir, "ゲーム.app");
  mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
  mkdirSync(join(app, "Contents/Frameworks/X.framework/Versions/A"), { recursive: true });
  writeFileSync(join(app, "Contents/MacOS/ゲーム"), "#!/bin/sh\necho ok\n");
  chmodSync(join(app, "Contents/MacOS/ゲーム"), 0o755);
  writeFileSync(join(app, "Contents/Frameworks/X.framework/Versions/A/X"), "lib");
  symlinkSync("A", join(app, "Contents/Frameworks/X.framework/Versions/Current"));
  symlinkSync("Versions/Current/X", join(app, "Contents/Frameworks/X.framework/X"));
  return app;
}

describe("配る形", () => {
  it("ブラウザ版の zip は、フォルダの中身（index.html）が zip の一番上に来る", { skip: !has("unzip", ["-v"]) }, async () => {
    const dir = temp();
    const web = join(dir, "my_game");
    mkdirSync(join(web, "project/scenario/part1"), { recursive: true });
    writeFileSync(join(web, "index.html"), "<!doctype html>");
    writeFileSync(join(web, "project/scenario/part1/side.lim"), "本文\n");
    await zipContents(web, join(dir, "my_game.zip"));
    const names = execFileSync("unzip", ["-Z1", join(dir, "my_game.zip")], { encoding: "utf8" }).trim().split("\n");
    expect(names).toContain("index.html");
    expect(names).toContain("project/scenario/part1/side.lim");
    expect(names.some((n) => n.startsWith("my_game/"))).toBe(false);
  });

  it("Mac のアプリの zip は、シンボリックリンクと実行の許可を保つ（ditto）", { skip: process.platform !== "darwin" }, () => {
    const dir = temp();
    const app = fakeApp(dir);
    const zip = macAppZip(app, join(dir, "ゲーム.zip"));
    const out = join(dir, "out");
    execFileSync("ditto", ["-x", "-k", zip, out]);
    const link = join(out, "ゲーム.app/Contents/Frameworks/X.framework/Versions/Current");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe("A");
    expect(readFileSync(join(out, "ゲーム.app/Contents/Frameworks/X.framework/X"), "utf8")).toBe("lib");
    expect(statSync(join(out, "ゲーム.app/Contents/MacOS/ゲーム")).mode & 0o111).not.toBe(0);
  });

  it("Mac のアプリの dmg は、アプリと /Applications へのリンクを入れる（hdiutil）", { skip: process.platform !== "darwin", timeout: 120_000 }, () => {
    const dir = temp();
    const app = fakeApp(dir);
    const dmg = macAppDmg(app, join(dir, "ゲーム.dmg"), "ゲーム", join(dir, "stage"));
    expect(existsSync(join(dir, "stage"))).toBe(false);
    const mount = join(dir, "mount");
    mkdirSync(mount);
    execFileSync("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, dmg], { stdio: "ignore" });
    try {
      expect(readlinkSync(join(mount, "Applications"))).toBe("/Applications");
      expect(lstatSync(join(mount, "ゲーム.app/Contents/Frameworks/X.framework/Versions/Current")).isSymbolicLink()).toBe(true);
      expect(statSync(join(mount, "ゲーム.app/Contents/MacOS/ゲーム")).mode & 0o111).not.toBe(0);
    } finally {
      execFileSync("hdiutil", ["detach", mount], { stdio: "ignore" });
    }
  });

  it("Mac のアプリの zip と dmg に、.app と並べて Electron のライセンスの文書を入れる", { skip: process.platform !== "darwin", timeout: 120_000 }, () => {
    const dir = temp();
    const app = fakeApp(dir);
    const licenses = ELECTRON_LICENSE_FILES.map((f) => {
      writeFileSync(join(dir, f), `${f} の本文`);
      return join(dir, f);
    });
    // 無いものは飛ばす
    const zip = macAppZip(app, join(dir, "ゲーム.zip"), [...licenses, join(dir, "無い.txt")]);
    expect(existsSync(`${zip}.parts`)).toBe(false);
    const out = join(dir, "out");
    execFileSync("ditto", ["-x", "-k", zip, out]);
    expect(readdirSync(out).sort()).toEqual(["LICENSE", "LICENSES.chromium.html", "ゲーム.app"].sort());
    expect(readFileSync(join(out, "LICENSES.chromium.html"), "utf8")).toBe("LICENSES.chromium.html の本文");
    expect(lstatSync(join(out, "ゲーム.app/Contents/Frameworks/X.framework/Versions/Current")).isSymbolicLink()).toBe(true);
    expect(statSync(join(out, "ゲーム.app/Contents/MacOS/ゲーム")).mode & 0o111).not.toBe(0);

    const dmg = macAppDmg(app, join(dir, "ゲーム.dmg"), "ゲーム", join(dir, "stage"), licenses);
    const mount = join(dir, "mount");
    mkdirSync(mount);
    execFileSync("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, dmg], { stdio: "ignore" });
    try {
      expect(readFileSync(join(mount, "LICENSE"), "utf8")).toBe("LICENSE の本文");
      expect(existsSync(join(mount, "LICENSES.chromium.html"))).toBe(true);
      expect(existsSync(join(mount, "ゲーム.app/Contents/MacOS/ゲーム"))).toBe(true);
    } finally {
      execFileSync("hdiutil", ["detach", mount], { stdio: "ignore" });
    }
  });

  it("書き出したゲームの外部の部品のライセンスの文書は、使っている Vite の版と、Vite の LICENSE と同じ著作権の表記と MIT の本文を書き、デスクトップ版は Electron の文書と並べて配る", () => {
    const vite = dirname(createRequire(import.meta.url).resolve("vite/package.json"));
    const version = JSON.parse(readFileSync(join(vite, "package.json"), "utf8")).version as string;
    const text = thirdPartyLicensesText(version);
    expect(text).toContain(`Vite ${version}`);
    // Vite の LICENSE.md の頭（Vite 自身の MIT の表記）と同じ著作権の行。Vite が書き換えたら、ここで気づく
    const copyright = /^Copyright \(c\).*$/m.exec(readFileSync(join(vite, "LICENSE.md"), "utf8"))![0];
    expect(text).toContain(copyright);
    expect(text).toContain("Permission is hereby granted, free of charge");
    expect(text).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
    expect(DESKTOP_LICENSE_FILES).toEqual([...ELECTRON_LICENSE_FILES, THIRD_PARTY_LICENSES_FILE]);
  });

  // Electron 本体を落とさない環境（CI は ELECTRON_SKIP_BINARY_DOWNLOAD）では、本体の dist が無いので見ない
  const electronDist = join(dirname(createRequire(import.meta.url).resolve("electron/package.json")), "dist");
  it.skipIf(!existsSync(join(electronDist, "LICENSE")))("配るライセンスの文書は、Electron が直下に置くもの（FFmpeg と Node.js の表記は LICENSES.chromium.html にある）", () => {
    const dist = electronDist;
    for (const f of ELECTRON_LICENSE_FILES) expect(existsSync(join(dist, f)), f).toBe(true);
    const chromium = readFileSync(join(dist, "LICENSES.chromium.html"), "utf8");
    expect(chromium).toContain('<span class="title">ffmpeg</span>');
    expect(chromium).toContain('<span class="title">Node.js</span>');
  });

  it("--zip と --dmg は値を取らない（lim build --zip mac の mac を書き出し先として読む）", () => {
    const f = parseFlags(["--zip", "mac", "--dmg"]);
    expect(f.positional).toEqual(["mac"]);
    expect(f.flags.get("zip")).toBe(true);
    expect(f.flags.get("dmg")).toBe(true);
  });

  it("--旗=値 の形も値を取る旗として読む（--min-lines=80 が次の位置引数を飲まない）", () => {
    const f = parseFlags(["--min-lines=80", "pos"]);
    expect(f.flags.get("min-lines")).toBe("80");
    expect(f.positional).toEqual(["pos"]);
  });

  it("値を取らない旗に =false などを書くと付かない（--write=false で上書きしない）", () => {
    const f = parseFlags(["--write=false", "--force=off"]);
    expect(f.flags.has("write")).toBe(false);
    expect(f.flags.has("force")).toBe(false);
    const g = parseFlags(["--write=yes"]);
    expect(g.flags.has("write")).toBe(true);
  });

  it("書き出したアプリは mv を使わずに動かし、別のドライブ（EXDEV）なら写して消す。リンクと実行の許可を保つ", () => {
    const dir = temp();
    const app = fakeApp(dir);
    // 同じドライブ: 名前を変えるだけ
    const moved = join(dir, "out", "ゲーム.app");
    mkdirSync(dirname(moved), { recursive: true });
    movePath(app, moved);
    expect(existsSync(app)).toBe(false);
    expect(readFileSync(join(moved, "Contents/MacOS/ゲーム"), "utf8")).toContain("echo ok");
    // 別のドライブ: rename が EXDEV で失敗したら、写して元を消す
    const other = join(dir, "other", "ゲーム.app");
    mkdirSync(dirname(other), { recursive: true });
    const exdev = () => {
      throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
    };
    movePath(moved, other, exdev);
    expect(existsSync(moved)).toBe(false);
    expect(lstatSync(join(other, "Contents/Frameworks/X.framework/Versions/Current")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(other, "Contents/Frameworks/X.framework/X"))).toBe("Versions/Current/X");
    if (process.platform !== "win32") expect(statSync(join(other, "Contents/MacOS/ゲーム")).mode & 0o111).not.toBe(0);
    // それ以外の失敗はそのまま投げる
    const denied = () => {
      throw Object.assign(new Error("no"), { code: "ENOENT" });
    };
    expect(() => movePath(other, join(dir, "x"), denied)).toThrow("no");
  });

  it("デスクトップ版のアイコンが無い、見つからない、ひな形の仮のアイコンのまま、なら書き出しで知らせる", () => {
    const dir = temp();
    const template = join(import.meta.dirname, "../../../templates/default");
    // ひな形には仮のアイコン（1024px の PNG）があり、liminalia.json の build.icon が指す
    expect(JSON.parse(readFileSync(join(template, "liminalia.json"), "utf8")).build.icon).toBe("icon.png");
    expect(imageSize(readFileSync(join(template, "icon.png")))).toEqual({ width: 1024, height: 1024 });
    expect(desktopIconProblem(dir, undefined)).toContain("アイコン（build.icon）がありません");
    expect(desktopIconProblem(dir, undefined, "game.ico")).toContain("Mac 版は Electron のアイコン");
    expect(desktopIconProblem(dir, "nothing.png")).toContain("nothing.png が見つかりません");
    writeFileSync(join(dir, "icon.png"), readFileSync(join(template, "icon.png")));
    expect(desktopIconProblem(dir, "icon.png")).toContain("ひな形の仮のアイコンのまま");
    writeFileSync(join(dir, "mine.png"), Buffer.concat([readFileSync(join(template, "icon.png")), Buffer.from("x")]));
    expect(desktopIconProblem(dir, "mine.png")).toBeNull();
  });

  it("Electron の言語のファイルは、作品の言語と英語の分だけ残す（Windows と Linux の .pak、Mac の .lproj）", () => {
    const dir = temp();
    const locales = join(dir, "locales");
    const mac = join(dir, "Resources");
    mkdirSync(locales);
    mkdirSync(mac);
    for (const f of ["en-US.pak", "en-GB.pak", "ja.pak", "zh-CN.pak", "zh-TW.pak", "fr.pak", "pt-BR.pak", "es-419.pak"]) writeFileSync(join(locales, f), "");
    for (const f of ["en.lproj", "en_GB.lproj", "ja.lproj", "ja_FEMININE.lproj", "zh_CN.lproj", "fr.lproj", "Base.lproj"]) mkdirSync(join(mac, f));
    // Mac の Resources の .pak（言語のファイルではない）は残す
    writeFileSync(join(mac, "chrome_100_percent.pak"), "");
    expect(removeElectronLocales([locales, mac], ["ja", "zh-Hans"])).toBe(4);
    expect(readdirSync(locales).sort()).toEqual(["en-GB.pak", "en-US.pak", "ja.pak", "zh-CN.pak", "zh-TW.pak"]);
    expect(readdirSync(mac).sort()).toEqual(["Base.lproj", "chrome_100_percent.pak", "en.lproj", "en_GB.lproj", "ja.lproj", "ja_FEMININE.lproj", "zh_CN.lproj"]);
  });

  it("Mac 版の CPU は既定で universal。build.mac.arch で絞れ、環境変数が優先し、ほかの名前は止める", () => {
    expect(desktopArch("mac", {}, undefined)).toBe("universal");
    expect(desktopArch("mac", { LIMINALIA_ARCH: "" }, undefined)).toBe("universal");
    expect(desktopArch("mac", {}, "arm64")).toBe("arm64");
    expect(desktopArch("mac", { LIMINALIA_ARCH: "x64" }, "arm64")).toBe("x64");
    expect(desktopArch("mac", { LIMINALIA_ARCH: "x64", LIMINALIA_MAC_ARCH: "arm64" }, undefined)).toBe("arm64");
    expect(() => desktopArch("mac", {}, "ppc")).toThrow("Mac 版の CPU（build.mac.arch）は universal、arm64、x64 のどれかです: ppc");
    expect(() => desktopArch("mac", { LIMINALIA_MAC_ARCH: "ia32" }, undefined)).toThrow("Mac 版の CPU（LIMINALIA_MAC_ARCH）は universal、arm64、x64 のどれかです: ia32");
  });

  it("Windows 版と Linux 版の CPU は build.windows.arch と build.linux.arch で決め（既定 x64）、環境変数は先ごとに分け、どれも値を確かめる", () => {
    expect(desktopArch("windows", {}, undefined)).toBe("x64");
    expect(desktopArch("windows", {}, "ia32")).toBe("ia32");
    expect(desktopArch("linux", {}, "arm64")).toBe("arm64");
    expect(desktopArch("windows", { LIMINALIA_WINDOWS_ARCH: "arm64" }, "ia32")).toBe("arm64");
    expect(desktopArch("linux", { LIMINALIA_LINUX_ARCH: "x64" }, "arm64")).toBe("x64");
    // 前からの LIMINALIA_ARCH はどの先にも効く。Mac の universal は、Windows と Linux では書かないのと同じ
    expect(desktopArch("windows", { LIMINALIA_ARCH: "arm64" }, "ia32")).toBe("arm64");
    expect(desktopArch("linux", { LIMINALIA_ARCH: "universal" }, "arm64")).toBe("arm64");
    expect(desktopArch("windows", { LIMINALIA_ARCH: "universal" }, undefined)).toBe("x64");
    // 先ごとの環境変数を使えば、一度の書き出しで別々の CPU にできる
    const env = { LIMINALIA_ARCH: "ia32", LIMINALIA_MAC_ARCH: "arm64" };
    expect([desktopArch("mac", env, undefined), desktopArch("windows", env, undefined)]).toEqual(["arm64", "ia32"]);
    expect(() => desktopArch("windows", {}, "universal")).toThrow("Windows 版の CPU（build.windows.arch）は x64、arm64、ia32 のどれかです: universal");
    expect(() => desktopArch("linux", { LIMINALIA_LINUX_ARCH: "ia32" }, undefined)).toThrow("Linux 版の CPU（LIMINALIA_LINUX_ARCH）は x64、arm64 のどれかです: ia32");
    // LIMINALIA_ARCH が合わない先では、先ごとの環境変数を案内する
    expect(() => desktopArch("mac", { LIMINALIA_ARCH: "ia32" }, undefined)).toThrow(
      "Mac 版の CPU（LIMINALIA_ARCH）は universal、arm64、x64 のどれかです: ia32。LIMINALIA_ARCH はどの書き出し先にも効くので、先ごとに決めるなら LIMINALIA_MAC_ARCH、LIMINALIA_WINDOWS_ARCH、LIMINALIA_LINUX_ARCH に書きます",
    );
    expect(() => desktopArch("linux", { LIMINALIA_ARCH: "ia32" }, undefined)).toThrow("Linux 版の CPU（LIMINALIA_ARCH）は x64、arm64 のどれかです: ia32。");
  });

  it("Mac 以外（CI の Linux など）でも、1024px の PNG から 16〜256px の Windows のアイコンを作る", () => {
    const dir = temp();
    const template = join(import.meta.dirname, "../../../templates/default");
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux" });
    let ico: string | null;
    try {
      ico = windowsIcon(dir, template, undefined, "icon.png");
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
    const data = readFileSync(ico!);
    expect(data.readUInt16LE(2)).toBe(1);
    const count = data.readUInt16LE(4);
    const sizes = Array.from({ length: count }, (_, i) => data[6 + i * 16] || 256);
    expect(sizes).toEqual([16, 24, 32, 48, 64, 128, 256]);
    // 中の絵は PNG（Windows Vista 以降が読む形）
    const offset = data.readUInt32LE(6 + 12);
    expect(data.subarray(offset, offset + 4).toString("latin1")).toBe("\x89PNG");
  });

  it("ストアの版の番号は、書いたものか version から作る。version から作ると重なるとき（1.0.100 と 1.1.0）は止める", () => {
    expect(storeBuildNumber("1.2.3", undefined)).toBe(10203);
    expect(storeBuildNumber("2.0", undefined)).toBe(20000);
    expect(storeBuildNumber("1.0.99", undefined)).toBe(10099);
    expect(storeBuildNumber("1.0.100", undefined)).toMatchObject({ problem: expect.stringContaining("1.0.100 と 1.1.0 がどちらも 10100") });
    expect(storeBuildNumber("1.100.0", undefined)).toMatchObject({ problem: expect.stringContaining("LIMINALIA_BUILD_NUMBER") });
    // 書いた番号（環境変数か build.buildNumber）が先
    expect(storeBuildNumber("1.0.100", "4567")).toBe(4567);
    expect(storeBuildNumber("1.0.0", 12)).toBe(12);
    expect(storeBuildNumber("1.0.0", "abc")).toMatchObject({ problem: expect.stringContaining("1 から 2100000000 の整数") });
    expect(storeBuildNumber("1.0.0", "")).toBe(10000);
  });
});
