import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPackage } from "@electron/asar";
import { NtExecutable, NtExecutableResource } from "resedit";
import { afterEach, describe, expect, it } from "vitest";
import { addMacAsarIntegrity, addWindowsAsarIntegrity, applyFuses, asarHeaderHash, gameFuses, macIntegrityDigest, readFuses, windowsAsarIntegrity } from "../src/fuses.ts";

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "liminalia-fuses-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 中身が一つの asar を作る。 */
async function asar(dir: string, name: string, file: string): Promise<string> {
  const src = join(dir, `${name}-src`);
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, file), "x");
  const out = join(dir, name);
  await createPackage(src, out);
  return out;
}

/** Fuses の印と線（Electron の実行ファイルの中と同じ形。9 本、どれも元は有効）を持つファイル。 */
function fakeElectron(file: string): void {
  const wire = Buffer.from([1, 9, ...Array<number>(9).fill(0x31)]);
  writeFileSync(file, Buffer.concat([Buffer.alloc(64, 7), Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"), wire, Buffer.alloc(64, 7)]));
}

describe("書き出したゲームの Fuses", () => {
  it("既定は Node として動かす口を切り、asar ならそこからだけ読む。完全性は Mac と Windows だけ", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const { fuses, problem } = gameFuses({ platform, asar: true });
      expect(problem).toBeNull();
      expect(fuses).toEqual({
        RunAsNode: false,
        EnableNodeOptionsEnvironmentVariable: false,
        EnableNodeCliInspectArguments: false,
        EnableEmbeddedAsarIntegrityValidation: platform !== "linux",
        OnlyLoadAppFromAsar: true,
      });
    }
    // asar に入れないなら、asar の Fuses は入れない（入れると起動しない）
    expect(gameFuses({ platform: "darwin", asar: false }).fuses).toMatchObject({ EnableEmbeddedAsarIntegrityValidation: false, OnlyLoadAppFromAsar: false });
  });

  it("build.desktop.fuses で一つずつ替えられ、書き間違いと asar なしで asar の Fuse を入れるのは止める", () => {
    expect(gameFuses({ platform: "win32", asar: true, overrides: { EnableEmbeddedAsarIntegrityValidation: false } }).fuses.EnableEmbeddedAsarIntegrityValidation).toBe(false);
    expect(gameFuses({ platform: "win32", asar: true, overrides: { RunAsNode: true } }).fuses.RunAsNode).toBe(true);
    expect(gameFuses({ platform: "win32", asar: true, overrides: { CookieEncryption: true } }).problem).toContain("CookieEncryption は切り替えられません");
    expect(gameFuses({ platform: "win32", asar: true, overrides: { RunAsNode: "no" as unknown as boolean } }).problem).toContain("true か false");
    expect(gameFuses({ platform: "darwin", asar: false, overrides: { OnlyLoadAppFromAsar: true } }).problem).toContain("build.asar が false");
  });

  it("実行ファイルの Fuses の線を書き換え、読み戻せる", async () => {
    const file = join(temp(), "game");
    fakeElectron(file);
    await applyFuses(file, gameFuses({ platform: "linux", asar: true }).fuses);
    expect(await readFuses(file)).toEqual({ RunAsNode: false, EnableNodeOptionsEnvironmentVariable: false, EnableNodeCliInspectArguments: false, EnableEmbeddedAsarIntegrityValidation: false, OnlyLoadAppFromAsar: true });
  });

  // asar を作り、plutil を起こして Info.plist を読み書きする
  it("Mac: assets.asar を Info.plist の完全性の一覧に足し、Electron Framework の中の要約を書き直す", { skip: process.platform !== "darwin", timeout: 30_000 }, async () => {
    const dir = temp();
    const app = join(dir, "Game.app");
    const resources = join(app, "Contents", "Resources");
    const frameworkDir = join(app, "Contents", "Frameworks", "Electron Framework.framework");
    mkdirSync(resources, { recursive: true });
    mkdirSync(frameworkDir, { recursive: true });
    const appAsar = await asar(dir, "app.asar", "main.cjs");
    copyFileSync(appAsar, join(resources, "app.asar"));
    const assets = await asar(dir, "assets.asar", "a.png");
    copyFileSync(assets, join(resources, "assets.asar"));
    // 組み立て（@electron/packager）が書いた形: app.asar だけの一覧と、その要約
    const before = { "Resources/app.asar": { algorithm: "SHA256", hash: asarHeaderHash(join(resources, "app.asar")) } };
    const plist = join(app, "Contents", "Info.plist");
    writeFileSync(plist, JSON.stringify({ CFBundleName: "Game", ElectronAsarIntegrity: before }));
    execFileSync("plutil", ["-convert", "xml1", plist]);
    const sentinel = Buffer.from("AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A");
    const framework = join(frameworkDir, "Electron Framework");
    const slot = (digest: Buffer) => Buffer.concat([sentinel, Buffer.from([1, 1]), digest]);
    // universal は印が二つ
    writeFileSync(framework, Buffer.concat([Buffer.alloc(16), slot(macIntegrityDigest(before)), Buffer.alloc(16), slot(macIntegrityDigest(before)), Buffer.alloc(16)]));

    expect(addMacAsarIntegrity(app, [join(resources, "assets.asar")])).toBeNull();
    const after = JSON.parse(execFileSync("plutil", ["-extract", "ElectronAsarIntegrity", "json", "-o", "-", plist], { encoding: "utf8" })) as Record<string, { algorithm: string; hash: string }>;
    expect(after["Resources/assets.asar"]).toEqual({ algorithm: "SHA256", hash: asarHeaderHash(join(resources, "assets.asar")) });
    expect(after["Resources/app.asar"]).toEqual(before["Resources/app.asar"]);
    const data = readFileSync(framework);
    const want = slot(macIntegrityDigest(after));
    expect(data.indexOf(want)).toBeGreaterThan(-1);
    expect(data.lastIndexOf(want)).toBeGreaterThan(data.indexOf(want));

    // 要約が計算と合わない（書き出しが知らない版の Electron）なら、書き換えずに理由を返す
    writeFileSync(framework, slot(Buffer.alloc(32, 9)));
    expect(addMacAsarIntegrity(app, [join(resources, "assets.asar")])).toContain("一致しません");
  });

  it("Windows: assets.asar を実行ファイルの資源 INTEGRITY/ELECTRONASAR に、app.asar と同じ形で並べる", async () => {
    const dir = temp();
    const folder = join(dir, "Game");
    mkdirSync(join(folder, "resources"), { recursive: true });
    const assets = await asar(dir, "assets.asar", "a.png");
    copyFileSync(assets, join(folder, "resources", "assets.asar"));
    // 組み立て（@electron/packager の resedit）が書いた形の、app.asar だけの一覧を持つ実行ファイル
    const exe = NtExecutable.createEmpty();
    const res = NtExecutableResource.from(exe);
    const list = Buffer.from(JSON.stringify([{ file: "resources\\app.asar", alg: "SHA256", value: "abc" }]));
    res.entries.push({ type: "INTEGRITY", id: "ELECTRONASAR", bin: list.buffer.slice(list.byteOffset, list.byteOffset + list.length), lang: 1033, codepage: 1200 });
    res.outputResource(exe);
    const file = join(folder, "Game.exe");
    writeFileSync(file, Buffer.from(exe.generate()));

    expect(addWindowsAsarIntegrity(file, folder, [join(folder, "resources", "assets.asar")])).toBeNull();
    expect(windowsAsarIntegrity(file)).toEqual([
      { file: "resources\\app.asar", alg: "SHA256", value: "abc" },
      { file: "resources\\assets.asar", alg: "SHA256", value: asarHeaderHash(join(folder, "resources", "assets.asar")) },
    ]);
    // 二度目は足さずに置き換える
    expect(addWindowsAsarIntegrity(file, folder, [join(folder, "resources", "assets.asar")])).toBeNull();
    expect(windowsAsarIntegrity(file)).toHaveLength(2);
    // 一覧の無い実行ファイル（asar に入れていない）には足せない
    const bare = join(dir, "Bare.exe");
    writeFileSync(bare, Buffer.from(NtExecutable.createEmpty().generate()));
    expect(addWindowsAsarIntegrity(bare, folder, [join(folder, "resources", "assets.asar")])).toContain("INTEGRITY");
  });
});
