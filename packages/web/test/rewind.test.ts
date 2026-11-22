import { describe, expect, it } from "vitest";
import { createState, toSaveData, type SaveData } from "@liminalia/runtime";
import { Backlog } from "../src/system/backlog.ts";
import { packSave, unpackSave } from "../src/system/rewind.ts";

/** ページの頭のセーブのまね（位置、変数、背景、立ち絵）。 */
function save(index: number, o: { bg?: string; vars?: Record<string, number>; who?: string } = {}): SaveData {
  const s = toSaveData(createState("a"));
  s.position = { unit: "a", index, anchor: { line: index + 1, key: `k${index}` } };
  s.game = { ...(o.vars ?? {}) };
  s.stage.background = o.bg ?? null;
  if (o.who) s.stage.sprites[o.who] = { variant: "normal", appearance: "", at: "center", flip: false };
  s.checkpoints = { big: { position: { unit: "a", index: 0 }, locals: {}, callStack: [], game: { long: "x".repeat(2000) }, stage: s.stage, seed: 1 } };
  return s;
}

describe("セーブに入れる巻き戻しの記録", () => {
  it("差分は違うところだけを持ち、当てると元のセーブに戻る（消えた立ち絵、変わった変数も）", () => {
    const base = save(9, { bg: "night.png", vars: { a: 1, b: 2 } });
    const page = save(3, { bg: "day.png", vars: { a: 1 }, who: "ユイ" });
    const delta = packSave(base, page);
    // 大きくて同じところ（@checkpoint の控え）は入れない
    expect(JSON.stringify(delta).length).toBeLessThan(600);
    expect(JSON.stringify(delta)).not.toContain("xxxx");
    expect(unpackSave(base, delta)).toEqual(page);
    expect(unpackSave(page, packSave(page, base))).toEqual(base);
    // 形の崩れた差分は読まない
    expect(unpackSave(base, { set: [[["__proto__", "x"], 1]] })).toBeNull();
    expect(unpackSave(base, "x")).toBeNull();
  });

  it("新しい N ページだけの読み直すセーブを差分にして入れ、ロードで戻す。前の版のセーブ（差分なし）も読める", () => {
    const log = new Backlog();
    for (let i = 0; i < 5; i++) {
      log.page(null, { file: "a", line: i + 1 });
      log.text(`p${i}`, null, { bold: false, italic: false, color: null, perChar: null, size: null, mark: null });
      log.attachResume(save(i, { vars: { n: i } }));
    }
    const base = save(4, { vars: { n: 4 } });
    const tail = log.tail(50, 3, base);
    expect(tail.map((e) => !!e.rewind)).toEqual([false, false, true, true, true]);
    expect(tail.some((e) => "resume" in e)).toBe(false);

    const loaded = new Backlog();
    loaded.restore(JSON.parse(JSON.stringify(tail)), base);
    expect(loaded.entries.map((e) => !!e.resume)).toEqual([false, false, true, true, true]);
    expect(loaded.entries[3]!.resume).toEqual(save(3, { vars: { n: 3 } }));
    expect(loaded.entries.some((e) => "rewind" in e)).toBe(false);

    // 前の版のセーブ（rewind の無い履歴）
    const old = new Backlog();
    old.restore(JSON.parse(JSON.stringify(log.tail(50))), base);
    expect(old.entries.map((e) => !!e.resume)).toEqual([false, false, false, false, false]);
    expect(old.entries.map((e) => e.parts)).toEqual(loaded.entries.map((e) => e.parts));
  });
});
