import { describe, expect, it } from "vitest";
import { HeadlessHost, Runtime, type PresentEvent, type SaveData, type VoiceCue } from "../src/index.ts";

/** 音のフィルター（@bgm・@se・@voice の filter、@voice-filter）と、二人の同時のボイス（@voice の channel・who、二つ目の @voice）。 */

const speakers = ["ユイ", "ミカ"];

class Host extends HeadlessHost {
  readonly voices: (VoiceCue | null)[] = [];
  readonly commands: { name: string; args: Record<string, unknown> }[] = [];
  onPage: (() => void) | null = null;
  override async present(event: PresentEvent) {
    if (event.type === "page") {
      this.voices.push(event.voice ?? null);
      this.onPage?.();
    }
    if (event.type === "command") this.commands.push({ name: event.name, args: event.args });
    return super.present(event);
  }
}

function setup(source: string) {
  const host = new Host({ loadSource: async () => source });
  const runtime = new Runtime(host, { speakers });
  return { host, runtime };
}

describe("音のフィルター", () => {
  it("@bgm と繰り返す @se のフィルターは状態に残り、同じ曲に掛け直せる", async () => {
    const { host, runtime } = setup(["@bgm rain.ogg filter=muffled filter-strength=60", "@se room.ogg loop=true channel=2 filter=hall", "一", "@bgm rain.ogg", "二"].join("\n"));
    let saved: SaveData | null = null;
    host.onPage = () => {
      saved ??= structuredClone(runtime.save());
    };
    await runtime.start("a");
    expect(saved!.stage.bgm).toMatchObject({ file: "rain.ogg", filter: { type: "muffled", strength: 60 } });
    expect(saved!.stage.loopingSe["2"]).toMatchObject({ filter: { type: "hall", strength: 100 } });
    // 同じ曲を filter なしで鳴らし直すと外れる
    expect(runtime.state.stage.bgm?.filter).toBeUndefined();
  });

  it("@voice-filter は話者ごとに掛け続け、セーブに残る。@voice の filter=none はそのボイスだけ外す", async () => {
    const src = [
      "@voice-filter phone who=ミカ filter-strength=70",
      "@voice m1.ogg",
      "ミカ「もしもし」",
      "@voice y1.ogg",
      "ユイ「聞こえる」",
      "@voice m2.ogg filter=none",
      "ミカ「直接」",
      "@voice-filter radio",
      "@voice y2.ogg",
      "ユイ「無線」",
      "@voice-filter none who=ミカ",
      "@voice m3.ogg",
      "ミカ「無線へ」",
    ].join("\n");
    const { host, runtime } = setup(src);
    await runtime.start("a");
    expect(host.voices.map((v) => v?.filter ?? null)).toEqual([{ type: "phone", strength: 70 }, null, null, { type: "radio", strength: 100 }, { type: "radio", strength: 100 }]);
    expect(runtime.state.stage.voiceFilter).toEqual({ "": { type: "radio", strength: 100 } });
    // 鳴っているボイスにも掛けるよう、描画側へ送る
    expect(host.commands.filter((c) => c.name === "voice-filter").map((c) => c.args.filter)).toEqual(["phone", "radio", "none"]);
  });
});

describe("二人の同時のボイス", () => {
  it("話者の違う二つ目の @voice と channel=2 は同じ台詞で同時に鳴らす。同じ話者の二つ目は置き換える", async () => {
    const src = [
      "@voice y1.ogg",
      "@voice m1.ogg who=ミカ",
      "ユイ「せーの」",
      "@voice y2.ogg",
      "@voice y3.ogg",
      "ユイ「置き換え」",
      "@voice y4.ogg",
      "@voice bg.ogg channel=3 volume=50",
      "ユイ「重ねる」",
    ].join("\n");
    const { host, runtime } = setup(src);
    await runtime.start("a");
    expect(host.voices[0]).toMatchObject({ file: "y1.ogg", also: [{ file: "m1.ogg", who: "ミカ", channel: 2 }] });
    expect(host.voices[1]).toEqual({ file: "y3.ogg", volume: 100, folder: "voice" });
    expect(host.voices[2]).toMatchObject({ file: "y4.ogg", also: [{ file: "bg.ogg", channel: 3, volume: 50 }] });
  });

  it("同じ話者の @voice を書き直しても、ほかの話者の @voice は残る", async () => {
    const src = [
      "@voice y1.ogg",
      "@voice m1.ogg who=ミカ",
      "@voice y2.ogg",
      "ユイ「せーの」",
      // 話者を書いた @voice が先にあっても、台詞の話者（who を省いたもの）の @voice は別に鳴らす。書き直しは省いたものの所へ入る
      "@voice m2.ogg who=ミカ",
      "@voice y3.ogg",
      "@voice y4.ogg",
      "ユイ「二回目」",
    ].join("\n");
    const { host, runtime } = setup(src);
    await runtime.start("a");
    expect(host.voices[0]).toMatchObject({ file: "y2.ogg", also: [{ file: "m1.ogg", who: "ミカ", channel: 2 }] });
    expect(host.voices[1]).toMatchObject({ file: "m2.ogg", who: "ミカ", also: [{ file: "y4.ogg", channel: 2 }] });
  });

  it("同時のボイスにも話者ごとのフィルターを掛ける（who を省いたものは台詞の話者のもの）", async () => {
    const src = [
      "@voice-filter phone who=ミカ",
      "@voice y1.ogg",
      "@voice m1.ogg who=ミカ",
      "ユイ「電話の向こうと」",
      "@voice-filter radio who=ユイ",
      "@voice m2.ogg who=ミカ",
      "@voice y2.ogg",
      "ユイ「無線の向こうと」",
    ].join("\n");
    const { host, runtime } = setup(src);
    await runtime.start("a");
    expect(host.voices[0]!.filter).toBeUndefined();
    expect(host.voices[0]!.also![0]!.filter).toEqual({ type: "phone", strength: 100 });
    // who を省いた also のボイスは台詞の話者（ユイ）のフィルターを掛ける
    expect(host.voices[1]!.filter).toEqual({ type: "phone", strength: 100 });
    expect(host.voices[1]!.also![0]!.filter).toEqual({ type: "radio", strength: 100 });
  });

  it("ページに同時に話すほかの話者を載せる（名前欄の名前は @name を通す。話者と同じ人と who の無いものは入れない）", async () => {
    const src = ["@voice y1.ogg", "@voice m1.ogg who=ミカ", "ユイ「せーの」", "@name ミカ as=少女", "@voice y2.ogg", "@voice m2.ogg who=ミカ", "@voice bg.ogg channel=3", "ユイ「もう一回」", "@voice y3.ogg", "@voice y4.ogg channel=2 who=ユイ", "ユイ「ひとり」"].join("\n");
    const pages: unknown[] = [];
    const host = new (class extends Host {
      override async present(event: PresentEvent) {
        if (event.type === "page") pages.push(event.with ?? null);
        return super.present(event);
      }
    })({ loadSource: async () => src });
    await new Runtime(host, { speakers }).start("a");
    expect(pages).toEqual([[{ speaker: "ミカ" }], [{ speaker: "ミカ", label: "少女" }], null]);
  });
});
