import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CORE_COMMANDS, createRegistry, parse, projectMacros, type CommandDefaults, type ExtraConfig } from "@liminalia/lang";
import { HeadlessHost, Runtime } from "@liminalia/runtime";
import { backportTyrano, importTyrano } from "../src/node.ts";
import { lowerLim } from "../src/backport/lower.ts";

/**
 * 書き戻しの前の直し（lower.ts）と、取り込みで要らない @cg-unlock を書き出さないこと。
 * Liminalia は CG の一覧にある画像を @bg で出すと解放するが、TyranoScript の [bg] は解放しないので、.ks には [tb_cg] を残す。
 */
const registry = createRegistry(CORE_COMMANDS);
const profile = { skipFiles: ["first"] };
const source = join(import.meta.dirname, "fixtures", "cg-project");
const extra: ExtraConfig = { cg: [{ id: "cg_a", images: ["cg/a.png"] }, { id: "cg_b", images: ["cg/b.png"] }] };
const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

async function importTo(dir: string, withExtra: boolean) {
  return importTyrano({
    source,
    scenarioOut: join(dir, "lim"),
    dataOut: join(dir, "data"),
    castOut: join(dir, "cast.json"),
    reportOut: join(dir, "import-report.md"),
    sourceMapOut: join(dir, "import-sourcemap.json"),
    registry,
    profile,
    ...(withExtra ? { extra } : {}),
  });
}

describe("取り込みの要らない @cg-unlock", () => {
  it("CG の一覧にある画像を [bg] で出したすぐあとの [tb_cg] は書き出さない（一覧が無ければ書き出す）", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "liminalia-cg-import-"));
    temps.push(tmp);
    const report = await importTo(join(tmp, "with"), true);
    await importTo(join(tmp, "without"), false);
    const withExtra = readFileSync(join(tmp, "with/lim/scene.lim"), "utf8");
    expect(withExtra).not.toContain("@cg-unlock");
    expect(readFileSync(join(tmp, "without/lim/scene.lim"), "utf8")).toContain("@cg-unlock cg/a.png");
    expect(report.markdown).toContain("[tb_cg] 1 個は、@cg-unlock を書き出していません");
    // 対応表の行数は書き出した .lim と同じ
    expect(report.sourceMap.files["scene.lim"]!.lines.length).toBe(withExtra.replace(/\n$/, "").split("\n").length);
  });
});

describe("書き戻しの CG の解放", () => {
  it("一覧にある画像を出した行のあとに @cg-unlock が無ければ足す（同じ並びにあれば足さない。cgAuto だけの画像は足さない）", () => {
    const text = "@bg cg/a.png\n@stop-bgm\n本文\n@bg cg/b.png\n@cg-unlock cg/b.png\n  @bg stills/c.png\n";
    const l = lowerLim(text, "s", { registry, speakers: [], extra: { ...extra, cgAuto: { folder: "stills" } }, cgUnlocks: true });
    expect(l.text).toBe("@bg cg/a.png\n@cg-unlock cg/a.png\n@stop-bgm\n本文\n@bg cg/b.png\n@cg-unlock cg/b.png\n  @bg stills/c.png\n");
    expect(l.origin).toEqual([1, 1, 2, 3, 4, 5, 6, 7]);
    expect(l.added).toEqual([false, true, false, false, false, false, false, false]);
  });

  it("本文の中のコマンドで一覧の CG を出したら、同じ行にその直後の {@cg-unlock} を足す（あれば足さない。行の数は変えない）", () => {
    const text = "ユイ「またね。{click}{@bg cg/a.png time=1s}ありがとう」\n地の文{@bg cg/b.png}{@cg-unlock cg/b.png}\n";
    const l = lowerLim(text, "s", { registry, speakers: ["ユイ"], extra, cgUnlocks: true });
    expect(l.text).toBe("ユイ「またね。{click}{@bg cg/a.png time=1s}{@cg-unlock cg/a.png}ありがとう」\n地の文{@bg cg/b.png}{@cg-unlock cg/b.png}\n");
    expect(l.added).toEqual([false, false, false]);
  });

  it("要らない @cg-unlock を消しても [tb_cg] は残し、一覧の CG を出す行を足せば [tb_cg] も足す（id は一覧のもの）", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "liminalia-cg-backport-"));
    temps.push(tmp);
    // 基準は一覧を知らない取り込み（@cg-unlock を書き出していたころの基準）
    await importTo(join(tmp, "base"), false);
    cpSync(join(tmp, "base/lim"), join(tmp, "cur"), { recursive: true });
    const path = join(tmp, "cur/scene.lim");
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => !l.startsWith("@cg-unlock"));
    const room = lines.findIndex((l) => l.startsWith("@bg room.png"));
    lines.splice(room + 1, 0, "@bg cg/b.png");
    writeFileSync(path, lines.join("\n"));
    const report = await backportTyrano({
      baseKs: join(source, "data/scenario"),
      baseLim: join(tmp, "base/lim"),
      sourceMap: join(tmp, "base/import-sourcemap.json"),
      currentLim: join(tmp, "cur"),
      source,
      out: join(tmp, "out/scenario"),
      registry,
      profile,
      extra,
    });
    expect(report.files.flatMap((f) => f.issues.filter((i) => i.severity === "error"))).toEqual([]);
    expect(report.files.flatMap((f) => f.mismatches)).toEqual([]);
    expect(report.verified).toBe(true);
    const ks = readFileSync(join(tmp, "out/scenario/scene.ks"), "utf8");
    expect(ks).toContain('[tb_cg id="cg_a" storage="cg/a.png"]');
    expect(ks).toMatch(/\[bg [^\]]*storage="cg\/b\.png"[^\]]*\]\n\[tb_cg {2}id="cg_b" {2}storage="cg\/b\.png" {2}\]/);
  });
});

describe("書き戻しのコマンドの既定値", () => {
  it("今の .lim の省いたパラメータに既定値を書く（コマンドの行と本文の中のコマンド。名前なしで書いたものは書かない）", () => {
    const text = "@bg a.png\n@bg b.png time=0ms\n  @chara ユイ smile\nユイ「{@bg c.png}やあ」\n@mask\n";
    const defaults: CommandDefaults = { bg: { fade: "1s" }, chara: { variant: "normal", appearance: "school uniform" } };
    const l = lowerLim(text, "s", { registry, speakers: ["ユイ"], commandDefaults: defaults, defaults: true });
    expect(l.text).toBe('@bg a.png time=1s\n@bg b.png time=0ms\n  @chara ユイ smile appearance="school uniform"\nユイ「{@bg c.png time=1s}やあ」\n@mask\n');
    expect(l.origin).toEqual([1, 2, 3, 4, 5, 6]);
    // マクロの呼び出しにも書く（マクロの仕様を渡したとき）
    const macros = projectMacros([["m", parse("@define scene(image: string, time: duration = 800ms)\n@bg (image)\n@end", "m")]]);
    expect(lowerLim("@scene image=a.png\n", "s", { registry, speakers: [], commandDefaults: { scene: { time: "2s" } }, macros, defaults: true }).text).toBe("@scene image=a.png time=2s\n");
    // 既定値を書かない（基準の .lim）
    expect(lowerLim(text, "s", { registry, speakers: ["ユイ"], commandDefaults: defaults }).text).toBe(text);
  });

  async function backportWith(edit: (lines: string[]) => void, commandDefaults: CommandDefaults) {
    const tmp = mkdtempSync(join(tmpdir(), "liminalia-defaults-backport-"));
    temps.push(tmp);
    await importTo(join(tmp, "base"), true);
    cpSync(join(tmp, "base/lim"), join(tmp, "cur"), { recursive: true });
    const path = join(tmp, "cur/scene.lim");
    const lines = readFileSync(path, "utf8").split("\n");
    edit(lines);
    writeFileSync(path, lines.join("\n"));
    const report = await backportTyrano({
      baseKs: join(source, "data/scenario"),
      baseLim: join(tmp, "base/lim"),
      sourceMap: join(tmp, "base/import-sourcemap.json"),
      currentLim: join(tmp, "cur"),
      source,
      out: join(tmp, "out/scenario"),
      registry,
      profile,
      extra,
      commandDefaults,
    });
    expect(report.files.flatMap((f) => [...f.issues.filter((i) => i.severity === "error").map((i) => i.message), ...f.mismatches])).toEqual([]);
    expect(report.verified).toBe(true);
    return readFileSync(join(tmp, "out/scenario/scene.ks"), "utf8");
  }

  it("既定値と同じ値を消しても .ks は変わらず、既定値で決めた値は .ks のタグに書き戻る", async () => {
    const same = await backportWith((lines) => {
      const i = lines.findIndex((l) => l.startsWith("@bg room.png"));
      lines[i] = "@bg room.png";
    }, { bg: { fade: "100ms" } });
    expect(same).toBe(readFileSync(join(source, "data/scenario/scene.ks"), "utf8"));
    const changed = await backportWith((lines) => {
      const i = lines.findIndex((l) => l.startsWith("@bg room.png"));
      lines[i] = "@bg room.png";
    }, { bg: { fade: "1s" } });
    expect(changed).toContain('[bg storage="room.png" time="1000"]');
  });
});

describe("書き戻しの一人ずつ出す立ち絵（@chara solo=true）", () => {
  it("solo の省略形も全消しに開く", () => {
    const registry = createRegistry(CORE_COMMANDS);
    expect(lowerLim("@chara ユイ solo time=500ms", "s", { registry, speakers: [] }).text).toBe("@chara-hide-all time=500ms\n@chara ユイ time=500ms");
  });
  it("clear は消す時間を保って全消しと表示に開く", () => {
    const registry = createRegistry(CORE_COMMANDS);
    expect(lowerLim("@chara ユイ clear=300ms time=500ms", "s", { registry, speakers: [] }).text).toBe("@chara-hide-all time=300ms\n@chara ユイ time=500ms");
  });
  it("@chara-hide-all と solo を外した @chara の二行にする（作品の既定値で決めたものも。本文の中のものも）", () => {
    const text = "@chara ユイ smile solo=true time=300ms\n@chara ユイ normal\nユイ「{@chara ユイ angry solo=true}やあ」\n";
    expect(lowerLim(text, "s", { registry, speakers: ["ユイ"] }).text.split("\n")).toEqual([
      "@chara-hide-all time=300ms",
      "@chara ユイ smile time=300ms",
      "@chara ユイ normal",
      "ユイ「{@chara-hide-all}{@chara ユイ angry}やあ」",
      "",
    ]);
    const l = lowerLim("@chara ユイ smile\n", "s", { registry, speakers: ["ユイ"], commandDefaults: { chara: { solo: "true", fade: "400ms" } }, defaults: true });
    expect(l.text).toBe("@chara-hide-all time=400ms\n@chara ユイ smile time=400ms\n");
    expect(l.origin).toEqual([1, 1, 2]);
  });
});

describe("書き戻しの場面転換（@scene-change）", () => {
  it("立ち絵を残す指定は全消しを追加せず、暗転開始時の枠非表示は勝手に変換しない", () => {
    expect(lowerLim("@scene-change hide-chara=false time=1s", "s", { registry, speakers: [] }).text).toBe("@mask time=1s\n@mask-off time=1s");
    expect(lowerLim("@scene-change hide-window-at=start", "s", { registry, speakers: [] }).text).toBe("@scene-change hide-window-at=start");
  });
  it("旧名の作品既定値より新しい名前の明示を優先して書き戻す", () => {
    const text = "@scene-change hide-chara-at=covered hide-window-at=covered";
    const l = lowerLim(text, "s", { registry, speakers: [], defaults: true, commandDefaults: { "scene-change": { "hide-at": "start" } } });
    expect(l.text).toBe("@mask time=1s\n@chara-hide-all\n@mask-off time=1s");
  });
  it("暗転と同時の全消しや一人だけの退場を、時間を保って開く", () => {
    const text = "@scene-change time=1s hold=500ms hide-at=start hide-fade=300ms\n@scene-change hide-who=ユイ hide-fade=200ms\n";
    expect(lowerLim(text, "s", { registry, speakers: [] }).text.split("\n")).toEqual([
      "@chara-hide-all time=300ms", "@mask time=1s", "@wait 500ms", "@mask-off time=1s",
      "@mask time=1s", "@chara-hide ユイ time=200ms", "@mask-off time=1s", "",
    ]);
  });
  it("暗転の後ろの BGM は @mask のすぐ後ろの @stop-bgm・@bgm にする", () => {
    const l = lowerLim("@scene-change a.png stop-bgm=true bgm-fade=300ms\n@scene-change bgm=night.ogg\n", "s", { registry, speakers: [] });
    expect(l.text.split("\n")).toEqual(["@mask time=1s", "@stop-bgm time=300ms", "@chara-hide-all", "@bg a.png", "@mask-off time=1s", "@mask time=1s", "@bgm night.ogg", "@chara-hide-all", "@mask-off time=1s", ""]);
  });

  it("流す BGM の音量（bgm-volume）は @bgm の volume にする（100 なら書かない）", () => {
    const l = lowerLim("@scene-change bgm=night.ogg bgm-volume=40 bgm-fade=1s\n", "s", { registry, speakers: [] });
    expect(l.text.split("\n")).toEqual(["@mask time=1s", "@bgm night.ogg volume=40 time=1s", "@chara-hide-all", "@mask-off time=1s", ""]);
  });

  it("同じ並びの @mask・@chara-hide-all・@bg・@mask-off に開く（作品の既定値を先に書く。本文の中のものも）", () => {
    const text = [
      "@scene-change a.png",
      "  @scene-change b.png time=1500ms hold=100ms color=#ffffff fade-in=500ms",
      "@scene-change hold=200ms",
      "@scene-change c.png",
      "ユイ「{@scene-change d.png time=0ms}やあ」",
      "",
    ].join("\n");
    const l = lowerLim(text, "s", { registry, speakers: ["ユイ"], commandDefaults: { "scene-change": { fade: "2s" } }, defaults: true });
    expect(l.text.split("\n")).toEqual([
      "@mask time=2s",
      "@chara-hide-all",
      "@bg a.png",
      "@mask-off time=2s",
      "  @mask time=1500ms color=#ffffff",
      "  @chara-hide-all",
      "  @bg b.png time=100ms",
      "  @mask-off time=500ms",
      "@mask time=2s",
      "@chara-hide-all",
      "@wait 200ms",
      "@mask-off time=2s",
      "@mask time=2s",
      "@chara-hide-all",
      "@bg c.png",
      "@mask-off time=2s",
      "ユイ「{@mask time=0ms}{@chara-hide-all}{@bg d.png}{@mask-off time=0ms}やあ」",
      "",
    ]);
    expect(l.origin).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 6]);
    // 作品の既定値が無ければ @scene-change の仕様の既定値（1s）
    expect(lowerLim("@scene-change a.png", "s", { registry, speakers: [] }).text).toBe("@mask time=1s\n@chara-hide-all\n@bg a.png\n@mask-off time=1s");
  });

  it("@scene-change に置き換えた塊を .ks の同じ並びに書き戻し、取り込み直すと同じになる", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "liminalia-scene-backport-"));
    temps.push(tmp);
    await importTo(join(tmp, "base"), true);
    cpSync(join(tmp, "base/lim"), join(tmp, "cur"), { recursive: true });
    const path = join(tmp, "cur/scene.lim");
    const lines = readFileSync(path, "utf8").split("\n");
    const i = lines.findIndex((l) => l.startsWith("@bg room.png"));
    lines[i] = "@scene-change room.png hold=100ms";
    writeFileSync(path, lines.join("\n"));
    const report = await backportTyrano({
      baseKs: join(source, "data/scenario"),
      baseLim: join(tmp, "base/lim"),
      sourceMap: join(tmp, "base/import-sourcemap.json"),
      currentLim: join(tmp, "cur"),
      source,
      out: join(tmp, "out/scenario"),
      registry,
      profile,
      extra,
      commandDefaults: { "scene-change": { time: "1500ms" } },
    });
    expect(report.files.flatMap((f) => [...f.issues.filter((x) => x.severity === "error").map((x) => `${x.limLine} ${x.message}`), ...f.mismatches])).toEqual([]);
    expect(report.verified).toBe(true);
    const ks = readFileSync(join(tmp, "out/scenario/scene.ks"), "utf8").split("\n");
    const at = ks.findIndex((l) => l.startsWith("[mask"));
    expect(ks.slice(at, at + 4).map((l) => /^\[([a-z_]+)/.exec(l)?.[1])).toEqual(["mask", "chara_hide_all", "bg", "mask_off"]);
    expect(ks[at]).toMatch(/time="1500"/);
    // 元の塊に [chara_hide_all] は無いが、@scene-change は立ち絵をすべて消すので足す。覆っている間に消すので time は 0
    // （[chara_hide_all] の既定の 1000 ミリ秒にしない）
    expect(ks[at + 1]).toMatch(/time="0"/);
    expect(ks[at + 2]).toMatch(/storage="room.png"/);
  });

  it("開いた並びは、@scene-change と同じに立ち絵をすべて消す（引数によらない。消すのは覆っている間で、時間は 0）", async () => {
    const stageAfter = async (text: string) => {
      const host = new HeadlessHost({ loadSource: async () => text });
      const runtime = new Runtime(host, { speakers: ["ユイ", "ソウ"] });
      await runtime.start("s");
      const hides = host.trace.flatMap((t) => (t.type === "command" && t.name === "chara-hide-all" ? [t.args.time] : []));
      const { sprites, background, mask } = runtime.state.stage;
      return { sprites, background, mask, hides };
    };
    const before = "@bg a.png\n@chara ユイ\n@chara ソウ at=right\n";
    expect(Object.keys((await stageAfter(before)).sprites)).toEqual(["ユイ", "ソウ"]);
    for (const scene of ["@scene-change b.png", "@scene-change", "@scene-change b.png time=0ms hold=200ms", "@scene-change b.png stop-bgm=true hide-window=false"]) {
      const lowered = lowerLim(before + scene, "s", { registry, speakers: ["ユイ", "ソウ"] }).text;
      const original = await stageAfter(before + scene);
      const backported = await stageAfter(lowered);
      expect(original.sprites, scene).toEqual({});
      expect({ ...backported, hides: undefined }, scene).toEqual({ ...original, hides: undefined });
      expect(backported.hides, scene).toEqual([0]);
    }
  });
});
