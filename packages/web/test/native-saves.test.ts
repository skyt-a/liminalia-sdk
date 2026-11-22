import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * スマホのアプリのセーブの置き場所（window.LiminaliaSaves。アプリのファイル）。localStorage の代わりに使い、
 * はじめて使うときは前の版が localStorage に書いたものを移す。
 */
describe("スマホのアプリのセーブの置き場所", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("書くたびにアプリへ渡し、起動したときにアプリから全部読む。前の版の localStorage は移す", async () => {
    const prefs = new Map<string, string>();
    const calls: string[] = [];
    const legacy = new Map([["liminalia:game:slot:3", '{"old":true}'], ["other", "x"]]);
    vi.stubGlobal("localStorage", {
      get length() {
        return legacy.size;
      },
      key: (i: number) => [...legacy.keys()][i] ?? null,
      getItem: (k: string) => legacy.get(k) ?? null,
      setItem: () => calls.push("localStorage"),
      removeItem: () => undefined,
    });
    vi.stubGlobal("window", {
      LiminaliaSaves: {
        load: () => JSON.stringify(Object.fromEntries(prefs)),
        set: (k: string, v: string) => (calls.push(`set ${k}`), prefs.set(k, v)),
        remove: (k: string) => (calls.push(`remove ${k}`), prefs.delete(k)),
      },
    });
    const { Storage } = await import("../src/system/storage.ts");
    const s = new Storage("game");
    // 前の版の localStorage のセーブを移した
    expect(prefs.get("liminalia:game:slot:3")).toBe('{"old":true}');
    expect(prefs.has("other")).toBe(false);
    s.write("config", { a: 1 });
    expect(prefs.get("liminalia:game:config")).toBe('{"a":1}');
    expect(s.read("config")).toEqual({ a: 1 });
    s.remove("config");
    expect(prefs.has("liminalia:game:config")).toBe(false);
    expect(calls).not.toContain("localStorage");
  });

  it("アプリが書けなかったと答えたら（false）、セーブできなかったことにする（持っている写しも変えない）", async () => {
    const prefs = new Map<string, string>();
    let full = false;
    vi.stubGlobal("localStorage", undefined);
    vi.stubGlobal("window", {
      LiminaliaSaves: {
        load: () => JSON.stringify(Object.fromEntries(prefs)),
        set: (k: string, v: string) => (full ? false : (prefs.set(k, v), true)),
        remove: (k: string) => prefs.delete(k),
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { Storage } = await import("../src/system/storage.ts");
    const s = new Storage("game");
    expect(s.write("config", { a: 1 })).toBe(true);
    full = true;
    expect(s.write("config", { a: 2 })).toBe(false);
    expect(s.read("config")).toEqual({ a: 1 });
    warn.mockRestore();
  });
});
