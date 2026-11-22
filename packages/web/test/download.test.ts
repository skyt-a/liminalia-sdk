import { describe, expect, it } from "vitest";
import { nativeFiles, saveFile, toBase64 } from "../src/system/download.ts";

/** ファイルを渡す（スクリーンショットとセーブデータのエクスポート）。スマホ版のアプリの口へは中身を base64 で渡す。 */
describe("ファイルを渡す", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";

  it("data URL を MIME と base64 にする（base64 でない data URL も）", async () => {
    expect(await toBase64(png)).toEqual({ mime: "image/png", base64: "iVBORw0KGgo=" });
    expect(await toBase64("data:text/plain,%E3%81%82")).toEqual({ mime: "text/plain", base64: Buffer.from("あ").toString("base64") });
  });

  it("Android のアプリの口（LiminaliaFiles）があれば、そこへ名前と MIME と base64 を渡す", async () => {
    const saved: string[][] = [];
    const w = { LiminaliaFiles: { save: (n: string, m: string, b: string) => (saved.push([n, m, b]), true) } } as unknown as Window;
    expect(nativeFiles(w)).toBe(true);
    expect(await saveFile("shot.png", png, w)).toBe(true);
    expect(saved).toEqual([["shot.png", "image/png", "iVBORw0KGgo="]]);
  });

  it("iOS のアプリの口（webkit.messageHandlers.liminaliaFiles）があれば、JSON で渡す", async () => {
    const posted: string[] = [];
    const w = { webkit: { messageHandlers: { liminaliaFiles: { postMessage: (m: string) => posted.push(m) } } } } as unknown as Window;
    expect(await saveFile("saves.json", "data:application/json;base64,e30=", w)).toBe(true);
    expect(JSON.parse(posted[0]!)).toEqual({ name: "saves.json", mime: "application/json", data: "e30=" });
  });

  it("アプリの口が断ったら false", async () => {
    const w = { LiminaliaFiles: { save: () => false } } as unknown as Window;
    expect(await saveFile("shot.png", png, w)).toBe(false);
  });
});
