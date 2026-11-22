import { describe, expect, it } from "vitest";
import { checkUi, systemVoiceEntries, uiAssetReferences } from "@liminalia/lang";
import { pickSystemVoice, systemVoiceCharacters } from "../src/system/system-voice.ts";

describe("システムボイス", () => {
  const list = [{ file: "a1.ogg", character: "A" }, { file: "b1.ogg", character: "B" }, { file: "after.ogg", if: "system.cleared" }, "common.ogg"];

  it("担当と if で候補を絞り、残りから一つ選ぶ", () => {
    // 担当の指定なし・クリア前: a1、b1、common から
    expect(pickSystemVoice(list, "", {}, () => 0)).toBe("a1.ogg");
    expect(pickSystemVoice(list, "", {}, () => 0.99)).toBe("common.ogg");
    // 担当 B: b1 と担当の無い common（クリア後は after も）
    expect(pickSystemVoice(list, "B", {}, () => 0)).toBe("b1.ogg");
    expect(pickSystemVoice(list, "B", { cleared: true }, () => 0.5)).toBe("after.ogg");
    expect(pickSystemVoice(list, "off", {})).toBeNull();
    expect(pickSystemVoice([], "", {})).toBeNull();
    // 読めない式の候補は除く
    expect(pickSystemVoice([{ file: "x.ogg", if: "(((" }], "", {})).toBeNull();
  });

  it("担当のキャラクター、書き出しに入れる素材、設定の形の確かめ", () => {
    const v = { title: [{ file: "t.ogg", character: "A" }], actions: { save: ["s.ogg", { file: "s2.ogg", character: "B" }] }, confirm: ["c.ogg"] };
    expect(systemVoiceCharacters(systemVoiceEntries(v))).toEqual(["A", "B"]);
    expect(uiAssetReferences({ systemVoice: v }).map((r) => `${r.folder}/${r.path}`)).toEqual(["voice/t.ogg", "voice/s.ogg", "voice/s2.ogg", "voice/c.ogg"]);
    expect(checkUi({ systemVoice: v })).toEqual([]);
    expect(checkUi({ systemVoice: { title: "t.ogg" } }).map((d) => d.message)).toEqual([expect.stringContaining("systemVoice.title")]);
    expect(checkUi({ systemVoice: { nope: [] } }).length).toBe(1);
  });
});
