import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadContext } from "../src/context.ts";
import { buildSeedSave } from "../src/seed.ts";

/**
 * lim build --seed のテスト用セーブ。道筋の探索は @liminalia/runtime の findRoute に移したが、作るセーブは変えない
 * （移す前の lim build --seed がひな形で作ったものと同じ位置・変数・演出の状態になること）。
 */

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");

describe("テスト用セーブ（lim build --seed）", () => {
  it("successful_route は開始位置から道筋を探し、指定の場所の最初のページの状態にする", async () => {
    const ctx = await loadContext(TEMPLATE);
    const night = await buildSeedSave(ctx, { file: "start", label: "night", mode: "successful_route" });
    expect(night.position).toMatchObject({ unit: "start", index: 31 });
    expect(night.game).toEqual({ looked: false, wished: false });
    expect(night.stage.background).toBe("hill_night.webp");
    expect(Object.keys(night.stage.sprites)).toEqual(["アカリ", "ソウ"]);
    expect(night.stage.bgm).toEqual({ file: "quiet_night.wav", volume: 60, loop: true });

    // 選択肢を通る: 望遠鏡 → ラジオ → 外へ → 願う、のあと epilogue
    const epilogue = await buildSeedSave(ctx, { file: "epilogue", label: null, mode: "successful_route" });
    expect(epilogue.position).toMatchObject({ unit: "epilogue", index: 7 });
    expect(epilogue.game).toEqual({ looked: true, wished: true });
    expect(epilogue.stage.bgm).toBeNull();

    const wish = await buildSeedSave(ctx, { file: "start", label: "wish", mode: "successful_route" });
    expect(wish.position).toMatchObject({ unit: "start", index: 127 });
    expect(wish.game).toEqual({ looked: true, wished: false });
  });

  it("fresh は指定の場所から何もない状態で始める", async () => {
    const ctx = await loadContext(TEMPLATE);
    const save = await buildSeedSave(ctx, { file: "epilogue", label: null, mode: "fresh" });
    expect(save.position).toMatchObject({ unit: "epilogue", index: 7 });
    expect(save.game).toEqual({});
    expect(save.stage.background).toBe("hill_morning.webp");
  });

  it("無いラベル・着かない場所はエラー", async () => {
    const ctx = await loadContext(TEMPLATE);
    await expect(buildSeedSave(ctx, { file: "start", label: "nowhere", mode: "successful_route" })).rejects.toThrow("ラベル #nowhere");
  });

  it("台本は lim test と同じ読み方で読む（無いファイルは台本が無いと言い、UTF-8 で読めなければ化けたまま流さない）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "liminalia-seed-"));
    try {
      cpSync(TEMPLATE, dir, { recursive: true });
      writeFileSync(join(dir, "scenario/sjis.lim"), Buffer.concat([Buffer.from("# sjis\n"), Buffer.from([0x82, 0xa0]), Buffer.from("\n@stop\n")]));
      const ctx = await loadContext(dir);
      await expect(buildSeedSave(ctx, { file: "nowhere", label: "x", mode: "fresh" })).rejects.toThrow("ファイル nowhere.lim が見つかりません");
      await expect(buildSeedSave(ctx, { file: "sjis", label: "sjis", mode: "fresh" })).rejects.toThrow("sjis.lim: このファイルは UTF-8 で読めません（Shift_JIS で保存されているようです）");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
