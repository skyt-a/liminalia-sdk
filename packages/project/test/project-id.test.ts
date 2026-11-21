import { describe, expect, it } from "vitest";
import { chooseProjectId, projectIdFromName } from "../src/project-id.ts";

/** 題名とフォルダ名から作品の ID を作る（lim new と制作アプリの新規作成）。 */

describe("作品の ID", () => {
  it("英数字は小文字にし、空白と記号は _ にする（全角も）", () => {
    expect(projectIdFromName("My Game 2")).toEqual({ id: "my_game_2", complete: true, usable: true });
    expect(projectIdFromName("my-game")).toMatchObject({ id: "my-game", usable: true });
    expect(projectIdFromName("ＡＢＣ　ゲーム！").id).toBe("abc_gemu");
  });

  it("ひらがなとカタカナはヘボン式のローマ字にする（拗音、促音、長音、外来音）", () => {
    expect(projectIdFromName("ほしのおか")).toEqual({ id: "hoshinooka", complete: true, usable: true });
    expect(projectIdFromName("きょうのしゃしん").id).toBe("kyounoshashin");
    expect(projectIdFromName("ちょっと").id).toBe("chotto");
    expect(projectIdFromName("まっちゃ").id).toBe("matcha");
    expect(projectIdFromName("ラーメン").id).toBe("ramen");
    expect(projectIdFromName("ファンタジー").id).toBe("fantaji");
    expect(projectIdFromName("ティータイム").id).toBe("titaimu");
    expect(projectIdFromName("ウィンター").id).toBe("winta");
    expect(projectIdFromName("ﾎｼ").id).toBe("hoshi");
    expect(projectIdFromName("ほしをまつおか").id).toBe("hoshiwomatsuoka");
  });

  it("漢字は読めないので落とす。読めた部分が多ければ一部から作り（complete は false）、少なければ使わない", () => {
    expect(projectIdFromName("はじめての物語")).toEqual({ id: "hajimeteno", complete: false, usable: true });
    expect(projectIdFromName("ＡＢＣ物語")).toEqual({ id: "abc", complete: false, usable: true });
    expect(projectIdFromName("星の丘")).toMatchObject({ id: "no", usable: false });
    expect(projectIdFromName("星を待つ丘").usable).toBe(false);
    expect(projectIdFromName("第1話").usable).toBe(false);
    expect(projectIdFromName("物語").usable).toBe(false);
    expect(projectIdFromName("").usable).toBe(false);
  });

  it("候補のうち、全部ローマ字にできたものを先に選ぶ。どれも使えなければ null", () => {
    expect(chooseProjectId(["星の丘", "Hoshi no Oka"])).toMatchObject({ id: "hoshi_no_oka", complete: true });
    expect(chooseProjectId(["はじめての物語", "はじめてのものがたり"])?.id).toBe("hajimetenomonogatari");
    expect(chooseProjectId(["はじめての物語", "星"])?.id).toBe("hajimeteno");
    expect(chooseProjectId(["星の丘", undefined, "雨"])).toBeNull();
  });

  it("40 字まで、英数字で始まる", () => {
    const id = projectIdFromName("あ".repeat(60)).id;
    expect(id).toHaveLength(40);
    expect(projectIdFromName("__x_y--").id).toBe("x_y");
  });
});
