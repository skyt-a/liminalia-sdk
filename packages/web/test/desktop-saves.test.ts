import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * デスクトップ版のセーブの置き場所（window.liminaliaDesktop.storage。殻の main.cjs がファイルに書く）。
 * 書くのと消すのは殻が済んでから結果を返し、書けなければ「セーブできませんでした」の知らせ（onSaveStoreError）を呼ぶ。
 */
describe("デスクトップ版のセーブの置き場所", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("書けなかった結果を知らせ、閉じる前の flushSaveStore は書き終わるまで待つ", async () => {
    const files = new Map<string, string>();
    const pending: (() => void)[] = [];
    let fail = false;
    vi.stubGlobal("localStorage", { length: 0, key: () => null, getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
    vi.stubGlobal("window", {
      liminaliaDesktop: {
        platform: "test",
        storage: {
          load: () => Object.fromEntries(files),
          set: (k: string, v: string) =>
            new Promise((resolve) => {
              pending.push(() => {
                if (fail) return resolve({ ok: false, code: "EPERM", message: "operation not permitted" });
                files.set(k, v);
                resolve({ ok: true });
              });
            }),
          remove: (k: string) => {
            files.delete(k);
            return Promise.resolve({ ok: true });
          },
        },
      },
    });
    const { Storage, flushSaveStore, onSaveStoreError } = await import("../src/system/storage.ts");
    const errors: unknown[] = [];
    onSaveStoreError((e) => errors.push(e));
    const s = new Storage("game");
    expect(s.write("config", { a: 1 })).toBe(true);
    // 書き終わるまで flushSaveStore は済まない
    let flushed = false;
    const flush = flushSaveStore().then(() => (flushed = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(flushed).toBe(false);
    pending.shift()!();
    await flush;
    expect(files.get("liminalia:game:config")).toBe('{"a":1}');
    expect(errors).toEqual([]);
    // 書けない（Windows で掴まれたまま、容量が足りないなど）: 知らせる。続けて書けなくても、知らせは重ねない
    fail = true;
    s.write("config", { a: 2 });
    s.write("system", { b: 1 });
    for (const p of pending.splice(0)) p();
    await flushSaveStore();
    expect(errors).toEqual([{ ok: false, code: "EPERM", message: "operation not permitted" }]);
    // 読むのはメモリの写し（このプレイの間は書いた値のまま）
    expect(s.read("config")).toEqual({ a: 2 });
  });

  it("前の版の殻（結果を返さない）でもそのまま書ける", async () => {
    const files = new Map<string, string>();
    vi.stubGlobal("localStorage", { length: 0, key: () => null, getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
    vi.stubGlobal("window", { liminaliaDesktop: { platform: "test", storage: { load: () => ({}), set: (k: string, v: string) => void files.set(k, v), remove: (k: string) => void files.delete(k) } } });
    const { Storage, flushSaveStore } = await import("../src/system/storage.ts");
    const s = new Storage("game");
    s.write("config", { a: 1 });
    await flushSaveStore();
    expect(files.get("liminalia:game:config")).toBe('{"a":1}');
  });
});
