import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HeadlessHost, migrateSave, migrateWith, Runtime, SAVE_VERSION, saveProblem, type SaveData } from "../src/index.ts";

/** 版ごとのセーブの見本。版を上げたら、前の版の見本は消さずに残し、新しい版の見本を足す。 */
const sample = (version: number) => JSON.parse(readFileSync(new URL(`./fixtures/save-v${version}.json`, import.meta.url), "utf8")) as SaveData;
const SOURCE = '@bg room\n@chara ユイ smile at=left\n@set game.n = 1\n@set game.name = "ゆい"\n一\n@set game.n += 1\n二\n三は{= game.n}';

describe("NVL の読み終えた段落", () => {
  const SCRIPT = "@nvl on\n一の{r 段|だん}\n二\n三\n@clear\n四\n";
  /** clicks 回目のクリック待ちの時点のセーブ（遊んでいてセーブするのと同じ）。 */
  const saveAt = async (clicks: number) => {
    const host = new HeadlessHost({ loadSource: async () => SCRIPT });
    const runtime = new Runtime(host);
    let n = 0, saved: SaveData | null = null;
    host.waitClick = async () => {
      if (++n === clicks) saved = JSON.parse(JSON.stringify(runtime.save())) as SaveData;
    };
    await runtime.start("a");
    return saved! as SaveData;
  };
  const texts = (save: SaveData) => (save.stage.nvlPages ?? []).map((p) => p.parts.flatMap((x) => ("text" in x ? [x.text] : [])).join(""));

  it("読み終えた段落を状態に積み、今のページは積まない", async () => {
    const save = await saveAt(3);
    expect(texts(save)).toEqual(["一の段", "二"]);
    expect(save.stage.nvlPages?.[0]?.parts.find((x) => "ruby" in x && x.ruby)).toMatchObject({ text: "段", ruby: "だん" });
  });

  it("@clear で消える", async () => {
    expect(texts(await saveAt(4))).toEqual([]);
  });
});

describe("立ち絵の大きさ・顔窓・枠の絵の状態", () => {
  const run = async (script: string) => {
    const host = new HeadlessHost({ loadSource: async () => script, maxPages: 5 });
    const runtime = new Runtime(host, { speakers: ["ユイ"] });
    await runtime.start("a");
    return runtime.state.stage;
  };

  it("@chara の width・height は書き直すまで保つ", async () => {
    const stage = await run("@chara ユイ a width=10 height=20\n@chara ユイ b\n本文");
    expect(stage.sprites.ユイ).toMatchObject({ variant: "b", width: 10, height: 20 });
  });

  it("@face で faceShown が決まり、@face-off で消える", async () => {
    expect((await run("@face ユイ a\n本文")).faceShown).toMatchObject({ who: "ユイ", variant: "a" });
    expect((await run("@face ユイ a\n@face-off\n本文")).faceShown).toBeUndefined();
  });

  it("@window-image は省くと戻す", async () => {
    expect((await run("@window-image a.png\n本文")).windowImage).toBe("a.png");
    expect((await run("@window-image a.png\n@window-image\n本文")).windowImage).toBeUndefined();
  });
});

describe("セーブの版", () => {
  it("どの版の見本も今の版にして続きから遊べる", async () => {
    for (let v = 1; v <= SAVE_VERSION; v++) {
      const host = new HeadlessHost({ loadSource: async () => SOURCE });
      const runtime = new Runtime(host, { speakers: ["ユイ"] });
      expect(await runtime.load(sample(v))).toMatchObject({ reason: "end" });
      expect(runtime.state.version).toBe(SAVE_VERSION);
      expect(host.trace.flatMap((t) => (t.type === "page" ? [t.text] : []))).toEqual(["二", "三は2"]);
      expect(runtime.state.stage.sprites.ユイ).toMatchObject({ variant: "smile", at: "left" });
    }
  });

  it("新しい版のセーブ・壊れたセーブは読まずに知らせる", async () => {
    const newer = { ...sample(1), version: SAVE_VERSION + 1 };
    expect(saveProblem(newer)).toBe("newer");
    expect(saveProblem({ version: 1 })).toBe("broken");
    expect(saveProblem(null)).toBe("broken");
    expect(saveProblem(sample(1))).toBeNull();

    const host = new HeadlessHost({ loadSource: async () => SOURCE });
    const result = await new Runtime(host).load(newer as SaveData);
    expect(result.reason).toBe("error");
    expect(host.trace.some((t) => t.type === "diagnostic" && t.diagnostic.code === "save-version")).toBe(true);
    expect(host.trace.some((t) => t.type === "page")).toBe(false);
  });

  it("変換は版の順にたどり、元のセーブを変えない", () => {
    const raw = { version: 1, position: { unit: "a", index: 0 }, game: { hp: 3 } };
    const migrations = [(s: Record<string, unknown>) => ({ ...s, game: { life: (s.game as { hp: number }).hp } }), (s: Record<string, unknown>) => ({ ...s, added: true })];
    expect(migrateWith(raw, migrations, 3)).toEqual({ version: 3, position: { unit: "a", index: 0 }, game: { life: 3 }, added: true });
    expect(raw).toEqual({ version: 1, position: { unit: "a", index: 0 }, game: { hp: 3 } });
    expect(migrateWith({ ...raw, version: 2 }, migrations, 3)).toMatchObject({ version: 3, game: { hp: 3 }, added: true });
    expect(() => migrateWith(raw, migrations.slice(0, 1), 3)).toThrow("変換する処理がありません");
    expect(migrateSave(sample(1))).toEqual(sample(1));
  });
});

describe("状態の写し（clonePlain）", () => {
  it("structuredClone と同じ値で、元とつながらない。ふつうでないものも写す", async () => {
    const { clonePlain } = await import("../src/state.ts");
    const date = new Date(0);
    const v = { a: [1, { b: "x", c: null }], d: { e: true, f: [[2]] }, g: date, h: undefined };
    const c = clonePlain(v);
    expect(c).toEqual(structuredClone(v));
    c.a.push(3);
    (c.d.f[0] as number[]).push(9);
    expect(v.a).toHaveLength(2);
    expect(v.d.f[0]).toEqual([2]);
    expect(c.g).not.toBe(date);
    expect(c.g.getTime()).toBe(0);
  });
});
