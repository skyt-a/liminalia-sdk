import { describe, expect, it, vi } from "vitest";
import { createState, toSaveData, type TextStyle } from "@liminalia/runtime";
import { Backlog, plainText } from "../src/system/backlog.ts";
import { ReadSet } from "../src/system/read-set.ts";
import { autoDelay, AUTO_PER_CHAR, DEFAULT_SETTINGS, mergeSettings, normalizeSettings } from "../src/system/settings.ts";
import { Storage, type KeyValueStore, type SlotRecord } from "../src/system/storage.ts";

/** localStorage の代わり。limit を超える値は書けない（容量不足のまね）。 */
class MemoryStore implements KeyValueStore {
  readonly data = new Map<string, string>();
  constructor(private readonly limit = Infinity) {}
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (value.length > this.limit) throw new Error("QuotaExceededError");
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  get length(): number {
    return this.data.size;
  }
  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }
}

const plain: TextStyle = { bold: false, italic: false, color: null, perChar: null, size: null, mark: null };
const record = (date: string, extra: Partial<SlotRecord> = {}): SlotRecord => ({
  version: 1,
  save: toSaveData(createState("chapter1")),
  date,
  title: "本文",
  ...extra,
});

describe("設定", () => {
  it("足りない項目は既定値、幅の外は幅に収める", () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ textSpeed: 500, autoWait: -3, bgm: 42.4, se: "x", skipUnread: true })).toEqual({
      ...DEFAULT_SETTINGS,
      textSpeed: 80,
      autoWait: 500,
      bgm: 42,
      skipUnread: true,
    });
  });

  it("変更を重ねる: 幅の外は収め、作品独自の値（custom）は名前ごとに重ねて undefined で消す", () => {
    const now = mergeSettings(DEFAULT_SETTINGS, { bgm: 120, custom: { alpha: 0.8, effects: false } });
    expect(now).toMatchObject({ bgm: 100, custom: { alpha: 0.8, effects: false } });
    const next = mergeSettings(now, { se: 10, custom: { alpha: undefined, font: "serif" } });
    expect(next).toMatchObject({ bgm: 100, se: 10, custom: { effects: false, font: "serif" } });
    expect(next.custom).not.toHaveProperty("alpha");
    // 保存した値を読み戻しても残る。JSON にできない値は捨てる
    expect(normalizeSettings({ ...next, custom: { ...next.custom, f: () => 1 } }).custom).toEqual({ effects: false, font: "serif" });
  });

  it("文字サイズは 80〜200%", () => {
    expect([normalizeSettings({ textScale: 260 }).textScale, normalizeSettings({ textScale: 50 }).textScale, normalizeSettings({ textScale: 180 }).textScale]).toEqual([200, 80, 180]);
  });

  it("オートの待ちは設定の時間＋文字数ぶん", () => {
    expect(autoDelay({ ...DEFAULT_SETTINGS, autoWait: 1000 }, 10)).toBe(1000 + 10 * AUTO_PER_CHAR);
  });
});

describe("既読の集合", () => {
  it("ファイルとページの鍵で持ち、JSON にして戻せる", () => {
    const set = new ReadSet();
    expect(set.add({ file: "chapter1", line: 3, key: "pa" })).toBe(true);
    expect(set.add({ file: "chapter1", line: 3, key: "pa" })).toBe(false);
    set.add({ file: "chapter1", line: 1, key: "pb" });
    set.add({ file: "chapter2", line: 7, key: "pc" });
    // 行がずれても鍵が同じなら既読、行が同じでも鍵が違えば未読
    expect(set.has({ file: "chapter1", line: 30, key: "pa" })).toBe(true);
    expect(set.has({ file: "chapter1", line: 3, key: "px" })).toBe(false);
    expect(set.has({ file: "chapter2", line: 7, key: "pa" })).toBe(false);
    // 鍵の分からないページは覚えない
    expect(set.add({ file: "chapter1", line: 9 })).toBe(false);
    expect(set.toJSON()).toEqual({ version: 2, pages: { chapter1: ["pa", "pb"], chapter2: ["pc"] } });
    const back = ReadSet.from(JSON.parse(JSON.stringify(set)));
    expect(back.size).toBe(3);
    expect(back.has({ file: "chapter2", line: 1, key: "pc" })).toBe(true);
    expect(back.dirty).toBe(false);
  });

  it("前のバージョンの行の既読は、そのファイルの鍵に移すまで行で見て、移したら鍵で見る", () => {
    const set = ReadSet.from({ chapter1: [1, 3], chapter2: [7] });
    expect(set.size).toBe(3);
    expect(set.hasLegacy("chapter1")).toBe(true);
    expect(set.has({ file: "chapter1", line: 3, key: "pa" })).toBe(true);
    // 移していない行も、保存して読み戻せる
    expect(ReadSet.from(JSON.parse(JSON.stringify(set))).has({ file: "chapter2", line: 7 })).toBe(true);
    // 今のシナリオで本文でない行（もうずれた行）は捨てる
    set.adopt("chapter1", new Map([[1, "pa"], [2, "pb"]]));
    expect(set.hasLegacy("chapter1")).toBe(false);
    expect(set.dirty).toBe(true);
    expect(set.has({ file: "chapter1", line: 40, key: "pa" })).toBe(true);
    expect(set.has({ file: "chapter1", line: 3, key: "pc" })).toBe(false);
    expect(set.toJSON()).toEqual({ version: 2, pages: { chapter1: ["pa"] }, lines: { chapter2: [7] } });
  });

  it("インポートは鍵と前のバージョンの行のどちらも足せる", () => {
    const set = new ReadSet();
    set.merge("a", ["pa", 4, "", 2.5, null]);
    expect(set.has({ file: "a", line: 1, key: "pa" })).toBe(true);
    expect(set.has({ file: "a", line: 4 })).toBe(true);
    expect(set.size).toBe(2);
  });

  it("壊れた値は無視する", () => {
    expect(ReadSet.from({ a: [1, "x", 2.5], b: "no" }).toJSON()).toEqual({ version: 2, pages: {}, lines: { a: [1] } });
    expect(ReadSet.from({ version: 2, pages: { a: ["pa", 3, ""], b: "no" }, lines: { c: ["x"] } }).toJSON()).toEqual({ version: 2, pages: { a: ["pa"] } });
    expect(ReadSet.from("x").size).toBe(0);
  });
});

describe("履歴", () => {
  it("ページごとに話者と本文（ルビ・装飾・改行）を溜め、上限で古いものを捨てる", () => {
    const log = new Backlog(2);
    log.page("ユイ", { file: "c", line: 1 });
    log.text("黄昏", "たそがれ", { ...plain, bold: true });
    log.br();
    log.text("です", null, plain);
    expect(log.current).toEqual({
      speaker: "ユイ",
      at: { file: "c", line: 1 },
      parts: [{ text: "黄昏", ruby: "たそがれ", bold: true }, { br: true }, { text: "です" }],
    });
    expect(plainText(log.current)).toBe("黄昏 です");
    log.page(null, { file: "c", line: 2 });
    log.page(null, { file: "c", line: 3 });
    expect(log.entries.map((e) => e.at.line)).toEqual([2, 3]);
  });

  it("選んだ選択肢を印つきで足す（@backlog off の間と、文の無いものは足さない）", () => {
    const log = new Backlog();
    log.page(null, { file: "c", line: 1 });
    log.choice("北へ行く", { file: "c", line: 2 });
    log.choice("", { file: "c", line: 2 });
    log.paused = true;
    log.choice("南へ行く", { file: "c", line: 2 });
    expect(log.entries.slice(1)).toEqual([{ speaker: null, at: { file: "c", line: 2 }, parts: [{ text: "北へ行く" }], choice: true }]);
  });

  it("セーブから戻すと、最初のページが最後の項目と同じなら積まずに置き換える", () => {
    const log = new Backlog();
    log.page("ユイ", { file: "c", line: 1 });
    log.text("一", null, plain);
    log.page(null, { file: "c", line: 2 });
    log.text("二", null, plain);
    const saved = log.tail(50);

    log.clear();
    log.restore(saved);
    log.page(null, { file: "c", line: 2 });
    log.text("二", null, plain);
    expect(log.entries.map((e) => plainText(e))).toEqual(["一", "二"]);
    // 置き換えるのはロード直後の一度だけ
    log.page(null, { file: "c", line: 2 });
    expect(log.entries).toHaveLength(3);
  });

  it("壊れた履歴は戻さない", () => {
    const log = new Backlog();
    log.restore([{ speaker: 1 } as never, { speaker: null, at: { file: "c", line: 1 }, parts: [] }]);
    expect(log.entries).toHaveLength(1);
  });
});

describe("保存", () => {
  it("作品ごとのキーにスロットを書き、読み戻す", () => {
    const store = new MemoryStore();
    const s = new Storage("game", store);
    expect(s.saveSlot(3, record("2026-01-01T00:00:00Z"))).toBe(true);
    expect([...store.data.keys()]).toEqual(["liminalia:game:slot:3", "liminalia:game:last-slot"]);
    expect(s.loadSlot(3)?.title).toBe("本文");
    expect(s.lastSlot()).toBe(3);
    expect(new Storage("other", store).loadSlot(3)).toBeNull();
    s.deleteSlot(3);
    expect(s.loadSlot(3)).toBeNull();
  });

  it("作品のメタ情報をスロットと一緒に書き、読み戻す", () => {
    const s = new Storage("game", new MemoryStore());
    s.saveSlot(2, { ...record("2026-01-01T00:00:00Z"), meta: { chapter: 3, date: "4月1日" } });
    expect(s.loadSlot(2)?.meta).toEqual({ chapter: 3, date: "4月1日" });
  });

  it("クイックセーブは最後のスロットを変えない", () => {
    const s = new Storage("game", new MemoryStore());
    s.saveSlot(1, record("2026-01-01T00:00:00Z"));
    s.saveSlot("quick", record("2026-01-02T00:00:00Z"));
    expect(s.lastSlot()).toBe(1);
  });

  it("いちばん新しいセーブ", () => {
    const s = new Storage("game", new MemoryStore());
    expect(s.latestSlot(10)).toBeNull();
    s.saveSlot(5, record("2026-01-03T00:00:00Z"));
    s.saveSlot(2, record("2026-01-01T00:00:00Z"));
    s.saveSlot("quick", record("2026-01-02T00:00:00Z"));
    expect(s.latestSlot(10)).toBe(5);
    expect(s.latestSlot(4)).toBe("quick");
  });

  it("クイックセーブは枠を回し、クイックロードはいちばん新しい枠から読む", () => {
    const s = new Storage("game", new MemoryStore());
    expect(s.latestQuick(3)).toBeNull();
    expect(s.saveQuick(3, record("2026-01-01T00:00:00Z"))).toBe("quick");
    expect(s.saveQuick(3, record("2026-01-02T00:00:00Z"))).toBe("quick:1");
    expect(s.saveQuick(3, record("2026-01-03T00:00:00Z"))).toBe("quick:2");
    // 埋まったら、いちばん古い枠を置き換える（同じ位置でも新しい枠に書く）
    expect(s.saveQuick(3, record("2026-01-04T00:00:00Z"))).toBe("quick");
    expect(s.latestQuick(3)).toBe("quick");
    expect(s.lastSlot()).toBeNull();
    // 枠が一つなら、前の版と同じく "quick" を上書きし続ける
    expect(s.saveQuick(1, record("2026-01-05T00:00:00Z"))).toBe("quick");
    expect(s.latestQuick(1)).toBe("quick");
    // 「つづきから」の候補にはクイックセーブの枠も入る
    s.saveSlot(1, record("2026-01-04T12:00:00Z"));
    expect(s.latestSlot(8, 0, 3)).toBe("quick");
    s.saveQuick(3, record("2026-01-06T00:00:00Z"));
    expect(s.latestSlot(8, 0, 3)).toBe("quick:1");
  });

  it("オートセーブは枠を回し、同じ位置なら同じ枠に書き直す。最後のスロットは変えない", () => {
    const store = new MemoryStore();
    const s = new Storage("game", store);
    const at = (index: number, date: string) => {
      const r = record(date);
      r.save.position = { unit: "chapter1", index };
      return r;
    };
    expect(s.saveAuto(0, at(1, "2026-01-01T00:00:00Z"))).toBeNull();
    expect(s.saveAuto(3, at(1, "2026-01-01T00:00:00Z"))).toBe("auto:0");
    expect(s.saveAuto(3, at(2, "2026-01-02T00:00:00Z"))).toBe("auto:1");
    // 同じ位置（裏へ回るのを繰り返したなど）は、いちばん新しい枠に書き直す
    expect(s.saveAuto(3, at(2, "2026-01-03T00:00:00Z"))).toBe("auto:1");
    expect(s.saveAuto(3, at(3, "2026-01-04T00:00:00Z"))).toBe("auto:2");
    // 埋まったら、いちばん古い枠を置き換える
    expect(s.saveAuto(3, at(4, "2026-01-05T00:00:00Z"))).toBe("auto:0");
    expect(s.latestAuto(3)).toBe("auto:0");
    expect(s.loadSlot("auto:1")?.date).toBe("2026-01-03T00:00:00Z");
    expect(s.lastSlot()).toBeNull();
    expect(store.data.has("liminalia:game:slot:auto:0")).toBe(true);
    // 「つづきから」の候補にはオートセーブも入る（数を渡したときだけ）
    s.saveSlot(1, record("2026-01-02T12:00:00Z"));
    expect(s.latestSlot(8)).toBe(1);
    expect(s.latestSlot(8, 3)).toBe("auto:0");
  });

  it("「前の選択肢へ」の控えをスロットと一緒に書き、容量が足りなければ先に諦める", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const choices = [{ save: toSaveData(createState("chapter1")), log: 3, at: "chapter1:5" }];
    const s = new Storage("game", new MemoryStore());
    expect(s.saveSlot(0, record("2026-01-01T00:00:00Z", { choices }))).toBe(true);
    expect(s.loadSlot(0)?.choices).toEqual(choices);
    const base = JSON.stringify(record("2026-01-01T00:00:00Z", { thumb: "t" })).length;
    const small = new Storage("game", new MemoryStore(base + 20));
    expect(small.saveSlot(0, record("2026-01-01T00:00:00Z", { thumb: "t", choices }))).toBe(true);
    expect(small.loadSlot(0)?.choices).toBeUndefined();
    expect(small.loadSlot(0)?.thumb).toBe("t");
    warn.mockRestore();
  });

  it("容量が足りなければ履歴、次に縮小画像を諦める", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const base = JSON.stringify(record("2026-01-01T00:00:00Z")).length;
    const store = new MemoryStore(base + 200);
    const s = new Storage("game", store);
    const log = Array.from({ length: 20 }, (_, i) => ({ speaker: null, at: { file: "c", line: i }, parts: [{ text: "あ".repeat(20) }] }));
    expect(s.saveSlot(0, record("2026-01-01T00:00:00Z", { thumb: "data:image/jpeg;base64,AAAA", log }))).toBe(true);
    expect(s.loadSlot(0)?.log).toEqual([]);
    expect(s.loadSlot(0)?.thumb).toBe("data:image/jpeg;base64,AAAA");
    expect(s.saveSlot(1, record("2026-01-01T00:00:00Z", { thumb: "x".repeat(400), log }))).toBe(true);
    expect(s.loadSlot(1)?.thumb).toBe("");
    expect(new Storage("game", new MemoryStore(10)).saveSlot(2, record("2026-01-01T00:00:00Z"))).toBe(false);
    warn.mockRestore();
  });

  it("壊れたスロット・設定・既読は読まない", () => {
    const store = new MemoryStore();
    const s = new Storage("game", store);
    store.setItem("liminalia:game:slot:0", "{not json");
    store.setItem("liminalia:game:slot:1", JSON.stringify({ version: 2 }));
    store.setItem("liminalia:game:config", JSON.stringify({ bgm: 999 }));
    store.setItem("liminalia:game:read", "[]");
    expect(s.loadSlot(0)).toBeNull();
    expect(s.loadSlot(1)).toBeNull();
    expect(s.loadSettings().bgm).toBe(100);
    expect(s.loadReadSet().size).toBe(0);
  });

  it("設定と既読は全セーブ共通の場所に保存する", () => {
    const store = new MemoryStore();
    const s = new Storage("game", store);
    s.saveSettings({ ...DEFAULT_SETTINGS, textSpeed: 10 });
    const read = new ReadSet();
    read.add({ file: "c", line: 4, key: "pa" });
    s.saveReadSet(read);
    expect(read.dirty).toBe(false);
    const again = new Storage("game", store);
    expect(again.loadSettings().textSpeed).toBe(10);
    expect(again.loadReadSet().has({ file: "c", line: 9, key: "pa" })).toBe(true);
  });

  it("保存先が無い環境では何もしない", () => {
    const s = new Storage("game", undefined);
    // node には localStorage が無い（または使えない）ので書けないが、例外は出さない
    expect(() => s.loadSettings()).not.toThrow();
  });
});

describe("セーブを丸ごと書き出す・読み込む", () => {
  it("作品のものだけを書き出し、同じ作品になら読み込める（今のものは置き換わる）", () => {
    const from = new MemoryStore();
    const a = new Storage("game", from);
    a.write("system", { cleared: true });
    a.write("last-slot", 2);
    new Storage("other", from).write("system", { x: 1 });
    const backup = a.exportAll();
    expect(Object.keys(backup.entries).sort()).toEqual(["last-slot", "system"]);
    const to = new MemoryStore();
    const b = new Storage("game", to);
    b.write("config", { bgm: 10 });
    expect(b.importAll(JSON.parse(JSON.stringify(backup)))).toBeNull();
    expect(b.read("system")).toEqual({ cleared: true });
    expect(b.read("config")).toBeNull();
    expect(new Storage("other", to).importAll(backup)).toBe("other-project");
    expect(b.importAll({ format: "x" })).toBe("invalid");
  });
});

describe("セーブを守る（saves.protect）", () => {
  it("読めない形で書き、そのまま読み戻せる。書き換えたもの・封をしていないものは読まない", () => {
    const store = new MemoryStore();
    const s = new Storage("game", store, { protect: true });
    s.write("system", { cleared: true, name: "アカリ" });
    const raw = store.getItem("liminalia:game:system")!;
    expect(raw.startsWith("lm1:")).toBe(true);
    expect(raw).not.toContain("cleared");
    expect(s.read("system")).toEqual({ cleared: true, name: "アカリ" });
    // 中身を一文字変える
    const body = raw.slice(raw.lastIndexOf(":") + 1);
    const flipped = body[4] === "A" ? `${body.slice(0, 4)}B${body.slice(5)}` : `${body.slice(0, 4)}A${body.slice(5)}`;
    store.setItem("liminalia:game:system", raw.slice(0, raw.lastIndexOf(":") + 1) + flipped);
    expect(s.read("system")).toBeNull();
    // 平文で入れたもの
    store.setItem("liminalia:game:system", JSON.stringify({ cleared: true }));
    expect(s.read("system")).toBeNull();
    // 別の作品の id では開けない
    s.write("system", { cleared: true });
    store.setItem("liminalia:other:system", store.getItem("liminalia:game:system")!);
    expect(new Storage("other", store, { protect: true }).read("system")).toBeNull();
  });

  it("守るのをやめた作品でも封をしたものは読め、書き出したものも読み込める（書き換えたものは断る）", () => {
    const store = new MemoryStore();
    new Storage("game", store, { protect: true }).write("system", { cleared: true });
    expect(new Storage("game", store).read("system")).toEqual({ cleared: true });
    const backup = new Storage("game", store, { protect: true }).exportAll();
    const to = new Storage("game", new MemoryStore(), { protect: true });
    expect(to.importAll(backup)).toBeNull();
    expect(to.read("system")).toEqual({ cleared: true });
    expect(to.importAll({ ...backup, entries: { system: JSON.stringify({ cleared: false }) } })).toBe("invalid");
  });
});

describe("色覚の補正", () => {
  it("灰色はそのままで、見分けにくい色の差をほかの色の向きへ移す", async () => {
    const { colorVisionMatrix } = await import("../src/system/color-vision.ts");
    const apply = (m: number[], c: number[]) => [0, 1, 2].map((r) => m[r * 5]! * c[0]! + m[r * 5 + 1]! * c[1]! + m[r * 5 + 2]! * c[2]!);
    for (const kind of ["protan", "deutan", "tritan"] as const) {
      const m = colorVisionMatrix(kind);
      for (const v of apply(m, [0.5, 0.5, 0.5])) expect(v).toBeCloseTo(0.5, 1);
      expect(m.slice(15)).toEqual([0, 0, 0, 1, 0]);
    }
    // 1 型: 赤と緑の差が青にも出る
    const p = colorVisionMatrix("protan");
    expect(apply(p, [1, 0, 0])[2]! - apply(p, [0, 1, 0])[2]!).toBeGreaterThan(0.3);
  });
});

describe("コンプリート率", () => {
  it("項目ごとに解放したもの / 全体を数え、全体の数がある項目の割合を平均する（CG は画像、数える実績は解放したら目標の数）", async () => {
    const { extraCompletion, extraState } = await import("../src/system/extra.ts");
    const extra = {
      cg: [{ id: "a", images: ["a1.png", "a2.png"] }, { id: "b", images: ["b.png"] }],
      replay: [{ id: "r", target: "x" }],
      achievements: [{ id: "star", title: "星" }, { id: "reads", title: "読書家", goal: 10 }],
    };
    const system = { cg_unlocked: { "a1.png": true }, achievements: { star: "2026-11-06T00:00:00Z" }, achievement_progress: { reads: 4 } };
    const c = extraCompletion(extra, system, { read: { done: 1, total: 4 }, endings: { done: 0, total: 2 } });
    expect(c).toMatchObject({ cg: { done: 1, total: 3 }, replay: { done: 0, total: 1 }, achievements: { done: 1, total: 2 }, read: { done: 1, total: 4 }, endings: { done: 0, total: 2 }, music: { total: 0 } });
    // (1/3 + 0 + 1/2 + 1/4 + 0) / 5
    expect(c.rate).toBeCloseTo((1 / 3 + 0 + 1 / 2 + 1 / 4 + 0) / 5);
    expect(extraCompletion(undefined, {}).rate).toBe(0);
    const s = extraState(extra, system);
    expect(s.achievementProgress(extra.achievements[1]!)).toBe(4);
    expect(extraState(extra, { achievements: { reads: "x" } }).achievementProgress(extra.achievements[1]!)).toBe(10);
  });
});
