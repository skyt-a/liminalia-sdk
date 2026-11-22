import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectTranslatable, CORE_COMMANDS, createRegistry, parse, voiceLines } from "@liminalia/lang";
import { runCheck } from "../src/commands/check.ts";
import { runI18n } from "../src/commands/i18n.ts";
import { runVoiceLock } from "../src/commands/voice-lock.ts";
import { runVoiceScript } from "../src/commands/voice-script.ts";

/**
 * パック（packs/<id>/scenario）の台本が使う訳の鍵とボイスの番号の固定の鍵（2026-11-19 の r1）。
 * 遊ぶ側は、パックに訳が無ければ本体の訳を、ボイスの番号はいつも本体の voice-lock.json を使う。
 * lim check はパックだけが使う鍵を「使われていない」にせず、lim voice-lock は retired に移さず、lim i18n は stale に移さない。
 * パックの訳（packs/<id>/lang/<言語>.json）も、本体にパックを重ねた台本で確かめる。
 */

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
let dir: string;
const packDir = () => join(dir, "packs", "extra");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-pack-keys-"));
  cpSync(TEMPLATE, dir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function quiet<T>(run: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const value = await run();
    return { value, lines: log.mock.calls.map((c) => String(c[0])) };
  } finally {
    log.mockRestore();
  }
}

/** パックの台本 bonus（パックだけにある台本）の台詞の、訳の鍵とボイスの番号の固定の鍵。 */
function setup(): { key: string; source: string; voice: string; said: string } {
  mkdirSync(join(packDir(), "scenario"), { recursive: true });
  mkdirSync(join(packDir(), "lang"), { recursive: true });
  mkdirSync(join(dir, "lang"), { recursive: true });
  writeFileSync(join(packDir(), "pack.json"), JSON.stringify({ id: "extra", title: "おまけ" }));
  const text = '# bonus\n@voice-auto アカリ pattern="akari/{n:3}.wav"\nアカリ「おまけの台詞です」\n';
  writeFileSync(join(packDir(), "scenario", "bonus.lim"), text);
  const config = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ ...config, languages: ["ja", "en"] }, null, 2));
  const speakers = (JSON.parse(readFileSync(join(dir, "cast.json"), "utf8")) as { speakers: string[] }).speakers;
  const script = parse(text, "bonus", { speakers });
  const item = collectTranslatable(script, createRegistry(CORE_COMMANDS)).find((t) => t.kind === "line")!;
  const voice = voiceLines(script)[0]!;
  return { key: item.key, source: item.source, voice: voice.key, said: voice.source };
}

const diagnostics = async () => (JSON.parse((await quiet(() => runCheck(dir, true, "ja"))).lines.join("\n")) as { diagnostics: { code: string; file: string; message: string }[] }).diagnostics;

describe("パックの台本が使う訳とボイスの鍵", () => {
  it("lim check は、パックだけが使う本体の訳と番号の固定を「使われていない」にしない。パックの訳は本体にパックを重ねた台本で確かめる", async () => {
    const bonus = setup();
    writeFileSync(join(dir, "lang", "en.json"), JSON.stringify({ language: "en", lines: { [bonus.key]: { source: bonus.source, text: '"A bonus line"' } } }, null, 2));
    // パックの訳: 使われていない鍵と、書き方の誤り
    writeFileSync(
      join(packDir(), "lang", "en.json"),
      JSON.stringify({ language: "en", lines: { [bonus.key]: { source: bonus.source, text: '"A bonus{r line"' }, "gone:l00000000": { source: "消した行", text: "Gone" } } }, null, 2),
    );
    writeFileSync(join(dir, "voice-lock.json"), JSON.stringify({ lines: { [bonus.voice]: { speaker: "アカリ", n: 1, source: bonus.said } } }, null, 2));
    const found = await diagnostics();
    expect(found.filter((d) => d.file === "lang/en.json" && d.code === "unused-translation")).toEqual([]);
    expect(found.filter((d) => d.code === "voice-lock-outdated")).toEqual([]);
    expect(found.filter((d) => d.file === "packs/extra/lang/en.json").map((d) => d.code).sort()).toEqual(["bad-translation", "untranslated", "unused-translation"]);
  });

  it("lim voice-lock は、パックの台詞にも番号を振り、作り直してもパックの台詞の番号を retired に移さない", async () => {
    const bonus = setup();
    // 本体にも連番のボイスの台詞がある（固定に無いので、新しい番号を振る）
    const start = join(dir, "scenario", "start.lim");
    writeFileSync(start, `${readFileSync(start, "utf8")}\n# vo\n@voice-auto アカリ pattern="akari/{n:3}.wav"\nアカリ「本体の台詞です」\n`);
    writeFileSync(join(dir, "voice-lock.json"), JSON.stringify({ lines: { [bonus.voice]: { speaker: "アカリ", n: 5, source: bonus.said } } }, null, 2));
    const done = await quiet(() => runVoiceLock(dir, 1));
    expect(done.value).toBe(true);
    const lock = JSON.parse(readFileSync(join(dir, "voice-lock.json"), "utf8")) as { lines: Record<string, { n: number; source: string }>; retired?: Record<string, unknown> };
    expect(lock.lines[bonus.voice]?.n).toBe(5);
    expect(lock.retired?.[bonus.voice]).toBeUndefined();
    expect(Object.values(lock.lines).find((e) => e.source === "「本体の台詞です」")?.n).toBe(6);
    // パックの台詞が番号を引けるので、検査も知らせない
    expect((await diagnostics()).filter((d) => d.code === "voice-lock-outdated" || d.code === "voice-unlocked")).toEqual([]);
  });

  it("lim i18n は、パックだけが使う本体の訳を stale に移さずに残す", async () => {
    const bonus = setup();
    writeFileSync(join(dir, "lang", "en.json"), JSON.stringify({ language: "en", lines: { [bonus.key]: { source: bonus.source, text: '"A bonus line"' } } }, null, 2));
    expect((await quiet(() => runI18n(dir, "en"))).value).toBe(true);
    const en = JSON.parse(readFileSync(join(dir, "lang", "en.json"), "utf8")) as { lines: Record<string, { text: string }>; stale?: Record<string, unknown> };
    expect(en.lines[bonus.key]?.text).toBe('"A bonus line"');
    expect(en.stale?.[bonus.key]).toBeUndefined();
  });

  it("二つのパック（訳のあるものと無いもの）: 訳の無いパックの台詞は、本体の訳と、一緒に入れたときのもう一方のパックの訳の訳し漏れに数え、lim i18n は本体の訳に並べる", async () => {
    const bonus = setup();
    writeFileSync(join(dir, "lang", "en.json"), JSON.stringify({ language: "en", lines: {} }, null, 2));
    writeFileSync(join(packDir(), "lang", "en.json"), JSON.stringify({ language: "en", lines: { [bonus.key]: { source: bonus.source, text: '"A bonus line"' } } }, null, 2));
    const untranslated = async (file: string) => Number(/(\d+) 件/.exec((await diagnostics()).find((d) => d.file === file && d.code === "untranslated")?.message ?? "")?.[1] ?? 0);
    const mainBefore = await untranslated("lang/en.json");
    const packBefore = await untranslated("packs/extra/lang/en.json");
    // 訳を持たない二つ目のパック（並びは後ろ）
    const more = join(dir, "packs", "more");
    mkdirSync(join(more, "scenario"), { recursive: true });
    writeFileSync(join(more, "pack.json"), JSON.stringify({ id: "more", title: "もっと", order: 5 }));
    writeFileSync(join(more, "scenario", "more.lim"), "# more\nアカリ「もう一つのおまけです」\n");
    expect(await untranslated("lang/en.json")).toBe(mainBefore + 1);
    expect(await untranslated("packs/extra/lang/en.json")).toBe(packBefore + 1);
    expect((await quiet(() => runI18n(dir, "en"))).value).toBe(true);
    const en = JSON.parse(readFileSync(join(dir, "lang", "en.json"), "utf8")) as { lines: Record<string, { source: string }> };
    expect(Object.values(en.lines).map((l) => l.source)).toContain("「もう一つのおまけです」");
    // 訳のあるパック extra の台詞は、本体の訳には並べない（extra を入れると extra の訳で出る）
    expect(Object.values(en.lines).map((l) => l.source)).not.toContain(bonus.source);
  });

  it("lim voice-script（収録用の台本）は、パックの台詞も並べ、本体の番号の固定からボイスのファイルを決める。位置はパックのフォルダから書く", async () => {
    const bonus = setup();
    writeFileSync(join(dir, "voice-lock.json"), JSON.stringify({ lines: { [bonus.voice]: { speaker: "アカリ", n: 5, source: bonus.said } } }, null, 2));
    const out = join(dir, "exports", "vs");
    expect((await quiet(() => runVoiceScript(dir, out))).value).toBe(true);
    const all = readFileSync(join(out, "全体.csv"), "utf8");
    expect(all).toContain("akari/005.wav,アカリ,「おまけの台詞です」");
    expect(all).toContain("packs/extra/scenario/bonus:3");
  });

  it("lim voice-lock を初めて流すとき（固定が無いとき）、パックの台詞の番号は、本体にパックを重ねて遊んだときに鳴る番号を写す", async () => {
    mkdirSync(join(packDir(), "scenario"), { recursive: true });
    writeFileSync(join(packDir(), "pack.json"), JSON.stringify({ id: "extra", title: "おまけ" }));
    writeFileSync(join(dir, "scenario", "start.lim"), '# start\n@voice-auto アカリ pattern="akari/{n:3}.wav"\nアカリ「一」\n@jump side\n');
    writeFileSync(join(dir, "scenario", "side.lim"), "# side\nアカリ「本体の脇」\n");
    // パックの side は本体の side を差し替え、bonus へ進む。パックを入れて遊ぶと、一 1、脇一 2、脇二 3、おまけ 4 が鳴る
    writeFileSync(join(packDir(), "scenario", "side.lim"), "# side\nアカリ「パックの脇一」\nアカリ「パックの脇二」\n@jump bonus\n");
    writeFileSync(join(packDir(), "scenario", "bonus.lim"), "# bonus\nアカリ「おまけ」\n");
    expect((await quiet(() => runVoiceLock(dir, 2))).value).toBe(true);
    const lock = JSON.parse(readFileSync(join(dir, "voice-lock.json"), "utf8")) as { lines: Record<string, { n: number; source: string }> };
    const n = (source: string) => Object.values(lock.lines).find((e) => e.source === source)?.n;
    expect([n("「一」"), n("「本体の脇」")]).toEqual([1, 2]);
    // パックを重ねて鳴る番号のうち、本体の台詞と重ならないものはそのまま写す（脇一の 2 は本体の脇と重なるので、新しい番号）
    expect(n("「おまけ」")).toBe(4);
    expect(n("「パックの脇二」")).toBe(3);
    expect(n("「パックの脇一」")).toBeGreaterThan(4);
  });

  it("lim voice-lock の出力（要再収録など）は、パックの台詞の位置を packs/<フォルダ>/scenario/<台本>:<行> で出し、本体の台詞と見分けられる（2026-11-19 の rest-p）", async () => {
    mkdirSync(join(packDir(), "scenario"), { recursive: true });
    writeFileSync(join(packDir(), "pack.json"), JSON.stringify({ id: "extra", title: "おまけ" }));
    writeFileSync(join(dir, "scenario", "start.lim"), '# start\n@voice-auto アカリ pattern="akari/{n:3}.wav"\n@jump side\n');
    writeFileSync(join(dir, "scenario", "side.lim"), "# side\nアカリ「朝の光が窓から差しこんでいた」\n");
    writeFileSync(join(packDir(), "scenario", "side.lim"), "# side\nアカリ「夜の雨が窓を打ちつけていた」\n");
    expect((await quiet(() => runVoiceLock(dir, 1))).value).toBe(true);
    // 本体とパックの同じ名前の台本の台詞を、どちらも少し書き換える（前の番号を引き継いで要再収録）
    writeFileSync(join(dir, "scenario", "side.lim"), "# side\nアカリ「朝の光が窓から差しこんでいる」\n");
    writeFileSync(join(packDir(), "scenario", "side.lim"), "# side\nアカリ「夜の雨が窓を打ちつけている」\n");
    const out = (await quiet(() => runVoiceLock(dir, 1))).lines.join("\n");
    expect(out).toContain("  side:2 アカリ");
    expect(out).toContain("  packs/extra/scenario/side:2 アカリ");
  });
});
