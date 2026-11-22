import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkProject, CORE_COMMANDS, createRegistry, parse, type Cast, type Script } from "@liminalia/lang";
import { englishBuildLine } from "@liminalia/project/build-lines-en";
import { HeadlessHost, Runtime } from "@liminalia/runtime";
import { importTyrano, readTatieSettings, type ImportReport } from "../src/node.ts";

/** 合成の TyranoScript プロジェクト（fixtures/ の下）を一時フォルダに取り込む。first.ks は変換しない。 */
function useImport(project: string) {
  const ctx = { out: "", report: null as unknown as ImportReport };
  beforeAll(async () => {
    ctx.out = mkdtempSync(join(tmpdir(), "liminalia-import-"));
    ctx.report = await importTyrano({
      source: join(import.meta.dirname, "fixtures", project),
      scenarioOut: join(ctx.out, "scenario"),
      dataOut: join(ctx.out, "data"),
      castOut: join(ctx.out, "cast.json"),
      reportOut: join(ctx.out, "import-report.md"),
      registry: createRegistry(CORE_COMMANDS),
      profile: { skipFiles: ["first"] },
    });
  });
  afterAll(() => rmSync(ctx.out, { recursive: true, force: true }));
  const read = (path: string) => readFileSync(join(ctx.out, path), "utf8");
  const castFile = () => JSON.parse(read("cast.json")) as { speakers: string[]; cast: Cast };
  /** 書き出した .lim をキャスト込みでプロジェクト検査する。 */
  const checkAll = (files: string[]) => {
    const { speakers, cast } = castFile();
    const scripts = new Map<string, Script>(files.map((f) => [f, parse(read(`scenario/${f}.lim`), f, { speakers })]));
    return checkProject(scripts, { castEntries: cast });
  };
  /** 画面なしで流す（maxPages ページ目で止める）。 */
  const play = async (entry: string, maxPages?: number) => {
    const host = new HeadlessHost({ loadSource: async (f) => read(`scenario/${f}.lim`), ...(maxPages ? { maxPages } : {}) });
    const runtime = new Runtime(host, { speakers: castFile().speakers });
    host.onLimit = () => runtime.stop();
    const result = await runtime.start(entry);
    return { result, sprites: runtime.state.stage.sprites };
  };
  return { ctx, read, castFile, checkAll, play };
}

describe("TyranoScript 標準の立ち絵の取り込み（fixtures/chara-project）", () => {
  const { ctx, read, castFile, checkAll, play } = useImport("chara-project");

  it("未対応・手作業・エラーがなく、本文が一字一句同じ", () => {
    expect(ctx.report.totals.generic).toBe(0);
    expect(ctx.report.totals.manual).toBe(0);
    expect(ctx.report.syntaxErrors).toEqual([]);
    expect(ctx.report.checkErrors).toEqual([]);
    expect(ctx.report.fidelity).toEqual([
      { file: "scene1.ks", pages: 4, mismatch: null },
      { file: "scene2.ks", pages: 2, mismatch: null },
    ]);
    expect(ctx.report.ok).toBe(true);
  });

  it("報告の頭（lim import が出す 14 行）は、英語の表で日本語を残さずに読み替えられる（lim import --lang en）", () => {
    const head = ctx.report.markdown.split("\n").slice(0, 14);
    expect(head[0]).toMatch(/^# 取り込みの報告/);
    expect(head.map(englishBuildLine).filter((l) => /[぀-ヿ㐀-鿿]/.test(l))).toEqual([]);
  });

  it("[chara_show] / [chara_mod] / `#名前:表情` を @chara に、話者は jname にする", () => {
    expect(read("scenario/scene1.lim")).toBe(
      [
        "# start",
        "@bg room.jpg",
        "@chara ユイカ default at=auto time=1s wait=true if-hidden=true",
        "@chara ren default at=auto flip=true time=500ms if-hidden=true",
        "",
        "ユイ「おはよう、今日は早いのね」",
        // [chara_mod] の time の既定は first.ks の [chara_config time=400]。位置と反転は変えないので書く
        "@chara ren angry time=400ms wait=true",
        "レン「……別に」",
        "窓の外では、雨が上がりかけていた。",
        "@chara ユイカ smile time=300ms wait=true",
        "",
        "ユイ「ふふ」",
        "@chara-hide ren wait=true",
        "@jump scene2",
        "",
      ].join("\n"),
    );
    expect(read("scenario/scene2.lim")).toBe(
      [
        "# start",
        "@chara ユイカ smile x=100 y=40 wait=true if-hidden=true",
        "@chara ユイカ surprised cross=false time=400ms wait=true",
        "",
        "ユイ「えっ」",
        "@chara-hide-all time=500ms wait=true",
        // ファイルの途中の [chara_config pos_mode=false] からは自動配置しない。反転は [chara_new] の reflect を覚えている
        "@chara ren default x=0 y=60 flip=true time=1s wait=true",
        "",
        "レン「じゃあな」",
        "@stop",
        "",
      ].join("\n"),
    );
  });

  it("cast.json を [chara_new] / [chara_face] と storage の直接指定から作る。width だけなら画像の縦横比で枠を決める", () => {
    const { speakers, cast } = castFile();
    expect(speakers).toEqual(["ユイ", "レン"]);
    // ren は width=300 だけを書き、画像は 10×20
    const renFrame = { width: 300, height: 600 };
    expect(cast).toEqual({
      ren: {
        appearances: {
          default: {
            variants: {
              default: { image: "chara/ren/normal.png", frame: renFrame },
              angry: { image: "chara/ren/angry.png", frame: renFrame },
            },
          },
        },
      },
      ユイカ: {
        appearances: {
          default: {
            variants: {
              default: { image: "chara/yuika/normal.png" },
              smile: { image: "chara/yuika/smile.png" },
              surprised: { image: "chara/yuika/surprised.png" },
            },
          },
        },
      },
    });
  });

  it("書き出した .lim はキャスト込みの検査を通り、流すと立ち絵の状態が TyranoScript と同じになる", async () => {
    // 背景のある scene1 から移る scene2 の初めに背景が無いのは、書き方の提案（情報。元の .ks も背景を替えない）
    expect(checkAll(["scene1", "scene2"]).map((d) => `${d.file}:${d.line} ${d.severity} ${d.code}`)).toEqual(["scene2:1 info scene-start-no-bg"]);
    // 表情だけ変えた立ち絵は自動配置のまま
    expect((await play("scene1", 3)).sprites).toEqual({
      ユイカ: { variant: "default", appearance: "", at: "auto", flip: false },
      ren: { variant: "angry", appearance: "", at: "auto", flip: true },
    });
    const all = await play("scene1");
    expect(all.result).toMatchObject({ reason: "stopped" });
    expect(all.sprites).toEqual({ ren: { variant: "default", appearance: "", at: "center", flip: true, x: 0, y: 60 } });
  });
});

describe("立ち絵プラグイン tatie の取り込み（fixtures/tatie-project）", () => {
  const { ctx, read, castFile, checkAll, play } = useImport("tatie-project");

  it("未対応・手作業・エラーがなく、本文が一字一句同じ", () => {
    expect(ctx.report.totals.generic).toBe(0);
    expect(ctx.report.totals.manual).toBe(0);
    expect(ctx.report.fidelity).toEqual([{ file: "scene.ks", pages: 3, mismatch: null }]);
    expect(ctx.report.ok).toBe(true);
    expect(ctx.report.markdown).toContain("tatie の設定から 2 人のキャストを読みました");
  });

  it("[tatie] を既定値（time=500・wait=false・cross=true・position=center）を引き継いだ @chara にする", () => {
    expect(read("scenario/scene.lim")).toBe(
      [
        "# start",
        "@chara mio normal at=left time=400ms wait=true if-hidden=true",
        "@chara sora normal appearance=default at=right flip=false time=500ms",
        "",
        "ミオ「おはよう」",
        "@chara mio smile time=500ms",
        "@chara mio normal appearance=casual at=center flip=true cross=false time=500ms",
        "",
        "ソラ「着替えたの？」",
        // mode=show は表示中なら何もしない
        "@chara mio normal at=right time=500ms if-hidden=true",
        // [chara_mod] は tatie で出した立ち絵セット・立ち位置のまま
        "@chara mio normal flip=false time=200ms wait=true",
        "",
        "ミオ「……少しね」",
        "@chara-hide sora time=300ms wait=true",
        "@stop",
        "",
      ].join("\n"),
    );
  });

  it("cast.json は [chara_new] 由来のキャストに tatie の設定を重ねたもの（tatie が優先、旧形式も読む）", () => {
    const { speakers, cast } = castFile();
    expect(speakers).toEqual(["ソラ", "ミオ"]);
    const mio = cast.mio!;
    expect(mio.defaultAppearance).toBe("uniform");
    expect(Object.keys(mio.appearances)).toEqual(["default", "uniform", "casual"]);
    expect(mio.appearances.default!.variants).toEqual({ default: { image: "mio/default.png" }, sad: { image: "mio/sad.png" } });
    expect(mio.appearances.uniform!.variants.smile).toEqual({
      image: "mio/uniform_smile.png",
      cacheKey: "2",
      frame: { width: 400, height: 700, positions: { left: { left: 80, top: 20 }, center: { left: 440, top: 20 }, right: { left: 800, top: 20 } } },
    });
    expect(cast.sora!.appearances.default).toEqual({
      label: "標準",
      variants: {
        default: { image: "sora/normal.png" },
        normal: {
          image: "sora/normal.png",
          frame: { width: 380, height: 680, positions: { left: { left: 0, top: 0 }, center: { left: 0, top: 0 }, right: { left: 820, top: 40 } } },
        },
      },
    });
  });

  it("書き出した .lim はキャスト込みの検査を通り、流した状態は TyranoScript と同じ", async () => {
    expect(checkAll(["scene"])).toEqual([]);
    expect((await play("scene")).sprites).toEqual({ mio: { variant: "normal", appearance: "casual", at: "center", flip: false } });
  });

  it("settings.js だけを評価して読む（無ければ空）", () => {
    expect(Object.keys(readTatieSettings(join(import.meta.dirname, "fixtures/tatie-project")).cast)).toEqual(["mio", "sora"]);
    expect(readTatieSettings(join(import.meta.dirname, "fixtures/chara-project"))).toEqual({ cast: {}, notes: [] });
  });
});

describe("サブフォルダの .ks（fixtures/subfolder-project）", () => {
  const { ctx, read, checkAll } = useImport("subfolder-project");

  it("data/scenario のサブフォルダの .ks を part1/chapter2 の名前で取り込み、system/ と変換しないファイルからだけ呼ばれるものは除く", () => {
    expect(ctx.report.fidelity.map((f) => f.file)).toEqual(["part1/chapter2/scene2.ks", "part1/common.ks", "part1/end.ks", "scene1.ks"]);
    expect(ctx.report.skipped).toEqual(["first.ks", "menu_data/items.ks"]);
    expect(ctx.report.ok).toBe(true);
    expect(read("scenario/scene1.lim")).toContain("@jump part1/chapter2/scene2#inside");
    expect(read("scenario/part1/chapter2/scene2.lim")).toContain("@call part1/common");
    expect(read("scenario/part1/chapter2/scene2.lim")).toContain("@jump part1/end");
    expect(existsSync(join(ctx.out, "scenario/menu_data/items.lim"))).toBe(false);
    expect(existsSync(join(ctx.out, "scenario/system/settings.lim"))).toBe(false);
    expect(ctx.report.sourceMap.files["part1/chapter2/scene2.lim"]!.source).toBe("part1/chapter2/scene2.ks");
  });

  it("書き出した .lim は lim check と同じ検査を通り、フォルダをまたいで流れる", async () => {
    expect(checkAll(["scene1", "part1/chapter2/scene2", "part1/common", "part1/end"])).toEqual([]);
    const host = new HeadlessHost({ loadSource: async (f) => read(`scenario/${f}.lim`) });
    const runtime = new Runtime(host, { speakers: [] });
    await runtime.start("scene1");
    expect(host.trace.flatMap((e) => (e.type === "page" ? [e.text] : []))).toEqual(["町の入り口に着いた。", "扉を開けて中に入った。", "古い時計が鳴った。", "そこで目が覚めた。"]);
  });
});
