import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** 書き出したデスクトップ版の殻（packages/desktop）のうち、Electron に頼らない部品。 */
const req = createRequire(import.meta.url);
const desktop = (name: string) => req(resolve(import.meta.dirname, "../../desktop", name)) as unknown;

type WriteResult = { ok: true } | { ok: false; code: string; message: string };
type FileOps = { mkdir(p: string, o: object): Promise<unknown>; writeFile(p: string, v: string): Promise<void>; rename(a: string, b: string): Promise<void>; rm(p: string, o: object): Promise<void> };
const saves = desktop("saves.cjs") as {
  writeSafely(file: string, value: string, o?: { delays?: number[]; retry?: string[]; fs?: FileOps }): Promise<WriteResult>;
  removeSafely(file: string, o?: { delays?: number[]; retry?: string[]; fs?: FileOps }): Promise<WriteResult>;
  createQueue(): { run<T>(task: () => Promise<T>): Promise<T>; idle(): Promise<void> };
  fileOf(dir: string, key: string, prefix: string | null): string;
  readSaves(dir: string, prefix: string | null): Record<string, string>;
  carrySaves(from: { dir: string; prefix: string | null }, to: { dir: string; prefix: string | null }): number;
};
const recovery = desktop("recovery.cjs") as {
  writeCrashLog(dir: string, text: string, o?: { keep?: number; now?: Date }): string | null;
  crashCounter(o?: { limit?: number; within?: number; now?: () => number }): { record(): boolean; reset(): void };
  gpuOff(file: string, version: string): boolean;
  turnGpuOff(file: string, version: string, reason: string): boolean;
};
type Rect = { x: number; y: number; width: number; height: number };
const windowState = desktop("window-state.cjs") as {
  readWindowState(file: string): { bounds: Rect; display?: number; fullscreen?: boolean; maximized?: boolean } | null;
  writeWindowState(file: string, state: object): void;
  placeWindow(saved: { bounds: Rect; display?: number } | null, displays: { id: number; workArea: Rect }[]): { bounds: Rect; display: number; scaled: boolean } | null;
};
type MenuItem = { label?: string; role?: string; type?: string; submenu?: MenuItem[] };
const menus = desktop("menu.cjs") as {
  textLanguage(language: string, system: string[]): "ja" | "en";
  menuTemplate(title: string, o: { fullscreen: boolean }, lang: "ja" | "en"): MenuItem[];
};

describe("デスクトップ版の殻の部品", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "liminalia-desktop-"));
  });
  afterEach(() => {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });

  it("セーブの書き込み: 掴まれているあいだは試し直し、書けなければ理由を返す", async () => {
    const file = join(dir, "saves", "slot%3A0.json");
    expect(await saves.writeSafely(file, '{"a":1}')).toEqual({ ok: true });
    expect(readFileSync(file, "utf8")).toBe('{"a":1}');
    // 入れ替えが 2 回 EBUSY で失敗してから通る（Windows でウイルス対策がファイルを掴んでいるとき）
    const real = await import("node:fs/promises");
    let busy = 2;
    const flaky: FileOps = {
      mkdir: (p, o) => real.mkdir(p, o),
      writeFile: (p, v) => real.writeFile(p, v),
      rename: async (a, b) => {
        if (busy-- > 0) throw Object.assign(new Error("busy"), { code: "EBUSY" });
        await real.rename(a, b);
      },
      rm: (p, o) => real.rm(p, o),
    };
    expect(await saves.writeSafely(file, '{"a":2}', { fs: flaky, delays: [1, 1, 1], retry: ["EBUSY"] })).toEqual({ ok: true });
    expect(readFileSync(file, "utf8")).toBe('{"a":2}');
    // 試し直しても掴まれたまま: 理由を返し、書きかけを残さない
    busy = 10;
    const r = await saves.writeSafely(file, '{"a":3}', { fs: flaky, delays: [1, 1], retry: ["EBUSY"] });
    expect(r).toMatchObject({ ok: false, code: "EBUSY" });
    expect(readFileSync(file, "utf8")).toBe('{"a":2}');
    expect(existsSync(`${file}.tmp`)).toBe(false);
    // 書けないフォルダ（権限が無い）は試し直さずに理由を返す
    const locked = join(dir, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    try {
      expect(await saves.writeSafely(join(locked, "x.json"), "{}", { retry: ["EBUSY"] })).toMatchObject({ ok: false, code: "EACCES" });
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it("書き込みは送られた順に一つずつ（試し直しの間に後のものが先に済まない）", async () => {
    const q = saves.createQueue();
    const order: string[] = [];
    const slow = q.run(async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push("first");
      return 1;
    });
    const fast = q.run(async () => {
      order.push("second");
      return 2;
    });
    // 投げたものがあっても列は止まらない
    const bad = q.run(async () => {
      throw new Error("x");
    });
    const after = q.run(async () => order.push("third"));
    expect(await slow).toBe(1);
    expect(await fast).toBe(2);
    await expect(bad).rejects.toThrow("x");
    await after;
    await q.idle();
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("前の版の既定（実行ファイルの横）のセーブを、今の標準の場所へ名前を直して写す（写すのは一度、前の場所は残す）", () => {
    const prefix = "liminalia:game:";
    const old = join(dir, "savedata");
    mkdirSync(old, { recursive: true });
    writeFileSync(saves.fileOf(old, `${prefix}slot:0`, prefix), '{"s":0}');
    writeFileSync(saves.fileOf(old, `${prefix}read_set`, prefix), "[]");
    expect(readdirSync(old).sort()).toEqual(["read%5Fset.json", "slot_0.json"]);
    const now = join(dir, "user", "saves");
    expect(saves.carrySaves({ dir: old, prefix }, { dir: now, prefix: null })).toBe(2);
    expect(saves.readSaves(now, null)).toEqual({ [`${prefix}slot:0`]: '{"s":0}', [`${prefix}read_set`]: "[]" });
    expect(existsSync(join(old, "slot_0.json"))).toBe(true);
    // 今の場所にもうセーブがあれば写さない
    writeFileSync(saves.fileOf(old, `${prefix}slot:1`, prefix), "{}");
    expect(saves.carrySaves({ dir: old, prefix }, { dir: now, prefix: null })).toBe(0);
  });

  it("止まったときの記録は新しいものから決めた数だけ残す", () => {
    const logs = join(dir, "logs");
    for (let i = 0; i < 5; i++) recovery.writeCrashLog(logs, `log ${i}`, { keep: 3, now: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) });
    const names = readdirSync(logs).sort();
    expect(names).toHaveLength(3);
    expect(names.map((n) => readFileSync(join(logs, n), "utf8"))).toEqual(["log 2", "log 3", "log 4"]);
  });

  it("描画のプロセスが 1 分の間に 3 回落ちたら諦め、次の起動から GPU を使わない（版が変われば使い直す）", () => {
    let t = 0;
    const c = recovery.crashCounter({ limit: 3, within: 60_000, now: () => t });
    expect(c.record()).toBe(false);
    t = 70_000;
    expect(c.record()).toBe(false);
    t = 80_000;
    expect(c.record()).toBe(false);
    t = 90_000;
    expect(c.record()).toBe(true);
    const mark = join(dir, "gpu.json");
    expect(recovery.gpuOff(mark, "1.0.0")).toBe(false);
    expect(recovery.turnGpuOff(mark, "1.0.0", "crashed")).toBe(true);
    expect(recovery.gpuOff(mark, "1.0.0")).toBe(true);
    expect(recovery.gpuOff(mark, "1.1.0")).toBe(false);
    expect(existsSync(mark)).toBe(false);
  });

  it("ウィンドウの位置と大きさ: 同じ画面ならそのまま、外した画面や画面の外なら真ん中、大きすぎれば縮める", () => {
    const file = join(dir, "window.json");
    expect(windowState.readWindowState(file)).toBeNull();
    windowState.writeWindowState(file, { bounds: { x: 100, y: 80, width: 1280, height: 748 }, display: 2, fullscreen: true });
    const saved = windowState.readWindowState(file);
    expect(saved).toEqual({ bounds: { x: 100, y: 80, width: 1280, height: 748 }, display: 2, fullscreen: true });
    const main = { id: 1, workArea: { x: 0, y: 25, width: 1920, height: 1055 } };
    const right = { id: 2, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } };
    // 主の画面の中ならそのまま（画面の番号は起動し直すと変わることがあるので、位置のある画面に置く）
    expect(windowState.placeWindow(saved, [main, right])).toEqual({ bounds: { x: 100, y: 80, width: 1280, height: 748 }, display: 1, scaled: false });
    // 右の画面に置いていた
    expect(windowState.placeWindow({ bounds: { x: 2100, y: 200, width: 1280, height: 748 }, display: 2 }, [main, right])).toEqual({ bounds: { x: 2100, y: 200, width: 1280, height: 748 }, display: 2, scaled: false });
    // 右の画面を外した: どの画面とも重ならないので、主の画面の真ん中
    expect(windowState.placeWindow({ bounds: { x: 2100, y: 200, width: 1280, height: 748 }, display: 2 }, [main])).toEqual({ bounds: { x: 320, y: 179, width: 1280, height: 748 }, display: 1, scaled: false });
    // 上の端が画面の外（題名の帯をつかめない）: その画面の真ん中
    expect(windowState.placeWindow({ bounds: { x: 100, y: -500, width: 1280, height: 748 } }, [main])?.bounds).toEqual({ x: 320, y: 179, width: 1280, height: 748 });
    // 少しはみ出しているだけなら、はみ出した分を戻す
    expect(windowState.placeWindow({ bounds: { x: 1000, y: 600, width: 1280, height: 748 } }, [main])?.bounds).toEqual({ x: 656, y: 348, width: 1280, height: 748 });
    // 画面より大きい: 縦横比を保って縮める
    const small = { id: 3, workArea: { x: 0, y: 0, width: 1280, height: 720 } };
    const big = windowState.placeWindow({ bounds: { x: 0, y: 0, width: 2560, height: 1440 }, display: 3 }, [small]);
    expect(big).toMatchObject({ scaled: true, bounds: { width: 1280, height: 720 } });
  });

  it("Mac のメニュー: 編集のメニューに役目の付いた項目を置き、遊ぶ言語（無ければ OS の言語）の文言にする", () => {
    expect(menus.textLanguage("", ["ja-JP"])).toBe("ja");
    expect(menus.textLanguage("en", ["ja-JP"])).toBe("en");
    expect(menus.textLanguage("ja", ["en-US"])).toBe("ja");
    expect(menus.textLanguage("fr", ["ja-JP"])).toBe("en");
    const roles = (items: MenuItem[]): string[] => items.flatMap((i) => [...(i.role ? [i.role] : []), ...roles(i.submenu ?? [])]);
    const en = menus.menuTemplate("Star Hill", { fullscreen: true }, "en");
    expect(roles(en)).toEqual(expect.arrayContaining(["undo", "redo", "cut", "copy", "paste", "selectAll", "togglefullscreen", "quit"]));
    expect(en.map((m) => m.label)).toEqual(["Star Hill", "Edit", "View", "Window"]);
    expect(en[0]!.submenu!.at(-1)!.label).toBe("Quit Star Hill");
    const ja = menus.menuTemplate("星を待つ丘", { fullscreen: false }, "ja");
    expect(ja.map((m) => m.label)).toEqual(["星を待つ丘", "編集", "ウインドウ"]);
    expect(ja[1]!.submenu!.map((i) => i.label).filter(Boolean)).toEqual(["元に戻す", "やり直す", "切り取り", "コピー", "貼り付け", "すべて選択"]);
  });
});
