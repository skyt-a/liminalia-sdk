import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SAMPLE_ASSETS_NOTE } from "../src/commands/new.ts";

/**
 * ひな形を lim new で作り、lim の各コマンドを実際のプロセスとして動かして確かめる。
 */

const LIM = resolve(import.meta.dirname, "../bin/lim.mjs");
const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");

function lim(args: string[], cwd?: string, timeout = 60_000) {
  const r = spawnSync(process.execPath, [LIM, ...args], { cwd, encoding: "utf8", timeout });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function files(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) files(p, out);
    else out.push(p);
  }
  return out;
}

interface TraceJson {
  result: { reason: string; at: { unit: string } };
  trace: ({ type: "page"; file: string; line: number; text: string } | { type: "diagnostic" } | { type: "choice" } | { type: "command" })[];
  game: Record<string, unknown>;
}

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "liminalia-template-"));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("lim new", { timeout: 60_000 }, () => {
  it("ひな形を写し、id と title を差し替える", () => {
    const r = lim(["new", "story", "--title", "テストの話", "--id", "test_story"], work);
    expect(r.code, r.err).toBe(0);
    const dir = join(work, "story");
    const config = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown>;
    expect(config).toMatchObject({ id: "test_story", title: "テストの話", entry: "start", titleScreen: true, screen: { width: 1280, height: 720 } });
    for (const f of ["cast.json", "scenario/start.lim", ".gitignore", "assets/bgimage/hill_dusk.webp"]) expect(existsSync(join(dir, f)), f).toBe(true);
    expect(existsSync(join(dir, "gitignore"))).toBe(false);
  });

  it("サンプル素材の説明（CC0 1.0、AI で作った絵、申告と差し替えの勧め）をプロジェクトの直下に置く", () => {
    const note = readFileSync(join(work, "story", SAMPLE_ASSETS_NOTE), "utf8");
    for (const text of ["CC0 1.0", "https://creativecommons.org/publicdomain/zero/1.0/deed.ja", "OpenAI の画像生成（Codex）", "申告してください", "差し替えることを勧めます", "https://liminalia.skyta.dev/license/#samples"]) expect(note, text).toContain(text);
  });

  it("id と title を省くとフォルダ名から作る（かなはローマ字にし、漢字ばかりなら --id を求めて止める）", () => {
    expect(lim(["new", "my-game"], work).code).toBe(0);
    expect(JSON.parse(readFileSync(join(work, "my-game/liminalia.json"), "utf8"))).toMatchObject({ id: "my-game", title: "my-game" });
    expect(lim(["new", "ほしのおか"], work).code).toBe(0);
    expect(JSON.parse(readFileSync(join(work, "ほしのおか/liminalia.json"), "utf8"))).toMatchObject({ id: "hoshinooka", title: "ほしのおか" });
    // 漢字ばかりの名前は、黙って my_game にせず止める（何も作らない）
    const kanji = lim(["new", "物語"], work);
    expect(kanji.code).toBe(2);
    expect(kanji.err).toContain("フォルダ名「物語」からはプロジェクト ID を作れません");
    expect(kanji.err).toContain("--id");
    expect(existsSync(join(work, "物語"))).toBe(false);
    // 題名から作れればそれを使う
    expect(lim(["new", "星の丘", "--title", "Hoshi no Oka"], work).code).toBe(0);
    expect(JSON.parse(readFileSync(join(work, "星の丘/liminalia.json"), "utf8"))).toMatchObject({ id: "hoshi_no_oka" });
    // 一部だけ読めたときは、作ったことと変え方を知らせる
    const part = lim(["new", "はじめての物語"], work);
    expect(part.code).toBe(0);
    expect(part.out).toContain("ID の hajimeteno は、名前のうちローマ字にできた部分だけから作りました");
    // 空白のあるフォルダは、次の手順の命令を引用符で囲む
    expect(lim(["new", "my game"], work).out).toContain('lim dev "my game"');
  });

  it("作ったあとの案内の一行目に、制作画面（lim studio と制作アプリ）を出す", () => {
    const r = lim(["new", "first-story"], work);
    expect(r.code).toBe(0);
    const steps = r.out.split("\n").filter((l) => l.startsWith("  "));
    expect(steps[0]).toContain("Studio:");
    expect(steps[0]).toContain("lim studio first-story");
    expect(r.out).toContain("Liminalia Studio");
    expect(r.out).toContain("lim dev first-story");
  });

  it("空のフォルダには作れる", () => {
    mkdirSync(join(work, "empty"));
    expect(lim(["new", "empty"], work).code).toBe(0);
    expect(existsSync(join(work, "empty/liminalia.json"))).toBe(true);
  });

  it("中身のあるフォルダには書かない", () => {
    mkdirSync(join(work, "used"));
    writeFileSync(join(work, "used/memo.txt"), "大事なメモ");
    const r = lim(["new", "used"], work);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("空ではありません");
    expect(readdirSync(join(work, "used"))).toEqual(["memo.txt"]);
  });

  it("--lang で原文の言語を languages に書く。日本語は書かない。使えない言語はエラー", () => {
    expect(lim(["new", "english", "--blank", "--lang", "en"], work).code).toBe(0);
    expect((JSON.parse(readFileSync(join(work, "english", "liminalia.json"), "utf8")) as { languages?: string[] }).languages).toEqual(["en"]);
    expect(lim(["new", "japanese", "--blank", "--lang", "ja"], work).code).toBe(0);
    expect(JSON.parse(readFileSync(join(work, "japanese", "liminalia.json"), "utf8"))).not.toHaveProperty("languages");
    const r = lim(["new", "bad-lang", "--lang", "English"], work);
    expect(r.code).not.toBe(0);
    expect(existsSync(join(work, "bad-lang"))).toBe(false);
  });

  it("lim shot --lang は作品の言語でなければエラー（撮らない）", () => {
    expect(lim(["new", "shot-lang", "--blank", "--lang", "en"], work).code).toBe(0);
    const r = lim(["shot", "shot-lang", "--title", "--lang", "fr", "--out", join(work, "fr.png")], work);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("fr はこの作品の言語ではありません");
    expect(existsSync(join(work, "fr.png"))).toBe(false);
  });

  it("使えない id はエラー", () => {
    const r = lim(["new", "bad", "--id", "bad id"], work);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("使えません");
    expect(existsSync(join(work, "bad"))).toBe(false);
  });

  it("画面の大きさ・サウンドノベル・タイトル画面なしを選べる。見本の立ち絵の枠は画面に合わせる", () => {
    const r = lim(["new", "wide", "--size", "1920x1080", "--novel", "--no-title-screen"], work);
    expect(r.code, r.err).toBe(0);
    const dir = join(work, "wide");
    expect(JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8"))).toMatchObject({ titleScreen: false, screen: { width: 1920, height: 1080 } });
    const start = readFileSync(join(dir, "scenario/start.lim"), "utf8").split("\n");
    expect(start[start.indexOf("# start") + 1]).toBe("@nvl on");
    const frame = (JSON.parse(readFileSync(join(dir, "cast.json"), "utf8")) as { cast: Record<string, { appearances: Record<string, { variants: Record<string, { frame: { width: number; height: number; positions: Record<string, { left: number; top: number }> } }> }> }> }).cast["アカリ"]!.appearances.default!.variants.normal!.frame;
    expect(frame).toMatchObject({ width: 701, height: 1050, positions: { center: { left: 610, top: 45 } } });
    expect(lim(["check", dir]).code).toBe(0);
  });

  it("縦長のひな形: 立ち絵を画面の高さの 7 割ほどにして下にそろえ、背景の焦点を書く", () => {
    const r = lim(["new", "tall", "--size", "720x1280"], work);
    expect(r.code, r.err).toBe(0);
    const dir = join(work, "tall");
    expect(JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8"))).toMatchObject({ screen: { width: 720, height: 1280 }, ui: { backgroundFocus: { "*": "62% 50%" } } });
    const frame = (JSON.parse(readFileSync(join(dir, "cast.json"), "utf8")) as { cast: Record<string, { appearances: Record<string, { variants: Record<string, { frame: { width: number; height: number; positions: Record<string, { left: number; top: number }> } }> }> }> }).cast["アカリ"]!.appearances.default!.variants.normal!.frame;
    expect(frame).toMatchObject({ width: 615, height: 922, positions: { left: { left: -91, top: 358 }, center: { left: 53, top: 358 }, right: { left: 196, top: 358 } } });
    expect(lim(["check", dir]).code).toBe(0);
  });

  it("白紙の縦長のひな形には背景の焦点を書かない", () => {
    const r = lim(["new", "tall-blank", "--blank", "--size", "720x1280"], work);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(readFileSync(join(work, "tall-blank", "liminalia.json"), "utf8")).ui).toBeUndefined();
  });

  it("白紙から作れる（見本の物語・素材・キャストを入れない）", () => {
    const r = lim(["new", "blank", "--blank"], work);
    expect(r.code, r.err).toBe(0);
    const dir = join(work, "blank");
    expect(readdirSync(join(dir, "scenario"))).toEqual(["start.lim"]);
    expect(files(join(dir, "assets"))).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "cast.json"), "utf8"))).toEqual({ $schema: "https://liminalia.skyta.dev/schemas/cast.schema.json", speakers: [], cast: {} });
    // サンプル素材が無いので、その説明も置かない
    expect(existsSync(join(dir, SAMPLE_ASSETS_NOTE))).toBe(false);
    // 見本の物語の決まり（場面転換の時間）も持ち込まない
    expect(JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")).commandDefaults).toBeUndefined();
    expect(lim(["check", dir]).code).toBe(0);
  });

  it("見本の物語は場面転換に @scene-change と commandDefaults を使い、頭のコメントはサイトを指す", () => {
    const start = readFileSync(join(work, "story", "scenario/start.lim"), "utf8");
    expect(start).not.toContain("@define");
    expect(start).toContain("@scene-change hill_night.webp\n");
    expect(start).toContain("https://liminalia.skyta.dev/tutorial/");
    expect(start).not.toContain("docs/design/format.md");
    expect(JSON.parse(readFileSync(join(work, "story", "liminalia.json"), "utf8")).commandDefaults).toEqual({ "scene-change": { time: "1200ms" } });
  });

  it("--lang en の白紙は、台本の文とコメントを英語にし、原文の言語を英語にする", () => {
    const r = lim(["new", "blank-en", "--blank", "--lang", "en", "--title", "Starlit Hill"], work);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('Created "Starlit Hill"');
    const dir = join(work, "blank-en");
    const text = readFileSync(join(dir, "scenario", "start.lim"), "utf8");
    expect(text).toBe("// Starlit Hill\n// New Game starts at the top of this file (entry in liminalia.json).\n\n# start\nYour story starts here.\n");
    expect(JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")).languages).toEqual(["en"]);
    expect(lim(["check", dir]).code).toBe(0);
  });

  it("使えない画面の大きさはエラー（何も書かない）", () => {
    const r = lim(["new", "tiny", "--size", "10x10"], work);
    expect(r.code).not.toBe(0);
    expect(existsSync(join(work, "tiny"))).toBe(false);
  });

  it("フォルダを指定しないとエラー", () => {
    const r = lim(["new"], work);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("フォルダを指定");
  });

  it("--template で人が配るひな形から作る。合うエンジンの宣言と書式の版はひな形のまま残し、合わなければ知らせる", () => {
    const shared = join(work, "shared-template");
    mkdirSync(join(shared, "scenario"), { recursive: true });
    mkdirSync(join(shared, "dist"), { recursive: true });
    mkdirSync(join(shared, ".liminalia"), { recursive: true });
    writeFileSync(join(shared, "dist", "old.txt"), "");
    writeFileSync(join(shared, ".liminalia", "state.json"), "{}");
    writeFileSync(join(shared, "scenario", "start.lim"), "# start\n　はじまり。\n");
    writeFileSync(join(shared, "cast.json"), `${JSON.stringify({ speakers: [], cast: {} })}\n`);
    const config = { id: "shared", title: "配るひな形", format: 1, engines: { liminalia: ">=1" }, entry: "start", screen: { width: 1920, height: 1080 } };
    writeFileSync(join(shared, "liminalia.json"), `${JSON.stringify(config)}\n`);

    const ok = lim(["new", "from-shared", "--template", shared, "--id", "from_shared"], work);
    expect(ok.code, ok.err).toBe(0);
    expect(ok.err).not.toContain("注意");
    const made = JSON.parse(readFileSync(join(work, "from-shared", "liminalia.json"), "utf8")) as Record<string, unknown>;
    expect(made).toMatchObject({ id: "from_shared", title: "from-shared", format: 1, engines: { liminalia: ">=1" }, screen: { width: 1920, height: 1080 } });
    expect(readFileSync(join(work, "from-shared", "scenario", "start.lim"), "utf8")).toContain("はじまり");
    // 書き出しと制作画面の控えは写さない
    expect(existsSync(join(work, "from-shared", "dist"))).toBe(false);
    expect(existsSync(join(work, "from-shared", ".liminalia"))).toBe(false);

    // このエンジンより新しい口と書式のひな形は、知らせて作る（作った作品の lim check も知らせ続ける）
    writeFileSync(join(shared, "liminalia.json"), `${JSON.stringify({ ...config, format: 999, engines: { liminalia: ">=999" } })}\n`);
    const newer = lim(["new", "from-newer", "--template", shared], work);
    expect(newer.code, newer.err).toBe(0);
    expect(newer.err).toContain("エンジン API バージョン >=999 向け");
    expect(newer.err).toContain("format: 999");
    const check = lim(["check", join(work, "from-newer"), "--json"], work);
    const codes = (JSON.parse(check.out) as { diagnostics: { code: string }[] }).diagnostics.map((d) => d.code);
    expect(codes).toContain("engine-version");
    expect(codes).toContain("newer-format");

    expect(lim(["new", "no-config", "--template", join(work, "no-such-template")], work).err).toContain("liminalia.json がありません");
    expect(lim(["new", "blank-template", "--template", shared, "--blank"], work).err).toContain("--template と --blank");
  });

  it("--template は、ひな形の作者の識別子と送り先を外して知らせ、版を 1.0.0 にし、.gitignore に書いたものと書き出し先と鍵を写さない", () => {
    const shared = join(work, "owner-template");
    for (const d of ["scenario", "exports/translation", "out/browser", "keys", "notes"]) mkdirSync(join(shared, d), { recursive: true });
    writeFileSync(join(shared, "scenario", "start.lim"), "# start\n　はじまり。\n");
    writeFileSync(join(shared, "cast.json"), `${JSON.stringify({ speakers: [], cast: {} })}\n`);
    writeFileSync(join(shared, "gitignore"), "# 書き出し\nexports/\n*.log\nnotes/*.tmp\n!keep.log\n");
    writeFileSync(join(shared, "exports", "translation", "en.csv"), "a");
    writeFileSync(join(shared, "out", "browser", "index.html"), "a");
    writeFileSync(join(shared, "keys", "release.keystore"), "secret");
    writeFileSync(join(shared, "build.log"), "a");
    writeFileSync(join(shared, "keep.log"), "a");
    writeFileSync(join(shared, "notes", "a.tmp"), "a");
    writeFileSync(join(shared, "notes", "a.md"), "a");
    const config = {
      id: "owner",
      title: "作者のひな形",
      version: "2.3.0",
      author: "Template Author",
      entry: "start",
      paths: { out: "out" },
      saves: { carryFrom: { owner_demo: "体験版" } },
      build: {
        icon: "icon.png",
        bundleId: "com.owner.game",
        executableName: "OwnerGame",
        buildNumber: 42,
        crashReport: { url: "https://owner.example/crash" },
        analytics: { url: "https://owner.example/stats" },
        feedback: { url: "https://owner.example/feedback" },
        update: { url: "https://owner.example/update.json", publicKey: "abc" },
        steam: { appId: 480, depots: { windows: 481 } },
        itch: { target: "owner/game" },
        store: { products: { full: { ios: "com.owner.full" } } },
        mac: { signIdentity: "Developer ID Application: Owner (TEAM)", notaryProfile: "owner", dmg: true },
        windows: { sign: { pfx: "keys/sign.pfx" }, installer: true },
        android: { keystore: "keys/release.keystore", alias: "owner", storePasswordEnv: "OWNER_PW" },
        ios: { team: "OWNERTEAM", audioSession: "playback" },
        variants: { demo: { feedback: true } },
      },
    };
    writeFileSync(join(shared, "liminalia.json"), `${JSON.stringify(config, null, 2)}\n`);

    const r = lim(["new", "mine", "--template", shared, "--id", "mine"], work);
    expect(r.code, r.err).toBe(0);
    const made = JSON.parse(readFileSync(join(work, "mine", "liminalia.json"), "utf8")) as Record<string, unknown>;
    // ひな形の作者のものは残らない（どこにも書かれていない）
    const text = readFileSync(join(work, "mine", "liminalia.json"), "utf8");
    for (const owner of ["owner.example", "com.owner", "Template Author", "OwnerGame", "480", "owner/game", "OWNERTEAM", "Developer ID", "release.keystore", "owner_demo"]) expect(text, owner).not.toContain(owner);
    expect(made).toMatchObject({ id: "mine", version: "1.0.0", paths: { out: "out" }, build: { icon: "icon.png", mac: { dmg: true }, windows: { installer: true }, ios: { audioSession: "playback" }, variants: { demo: { feedback: true } } } });
    expect(made.author).toBeUndefined();
    expect(r.out).toContain("ひな形の作者のものなので写さなかった設定: author、saves.carryFrom、build.bundleId、build.executableName、build.buildNumber、build.crashReport、build.analytics、build.feedback、build.update、build.steam、build.itch、build.store");
    expect(r.out).toContain("build.android.keystore");
    expect(r.out).toContain("バージョンは 1.0.0 から始めます（ひな形は 2.3.0）");
    // .gitignore に書いたもの、書き出し先、署名の鍵は写さない
    const mine = (p: string) => existsSync(join(work, "mine", p));
    expect(mine("exports")).toBe(false);
    expect(mine("out")).toBe(false);
    expect(mine("keys/release.keystore")).toBe(false);
    // 鍵だけが入っていたフォルダも残さない
    expect(mine("keys")).toBe(false);
    expect(mine("build.log")).toBe(false);
    expect(mine("notes/a.tmp")).toBe(false);
    expect(mine("keep.log")).toBe(true);
    expect(mine("notes/a.md")).toBe(true);
    expect(mine(".gitignore")).toBe(true);
    expect(r.out).toContain("テンプレートからコピーしなかったファイル");
    expect(r.out).toContain("exports/");
    // 英語でも知らせる
    const en = lim(["new", "mine-en", "--template", shared, "--id", "mine_en", "--lang", "en"], work);
    expect(en.out).toContain("Not copied from the template because they belong to its author: author, saves.carryFrom, build.bundleId");
  });
});

describe("ひな形", { timeout: 120_000 }, () => {
  let dir: string;
  beforeAll(() => {
    dir = join(work, "play");
    const r = lim(["new", "play"], work);
    if (r.code !== 0) throw new Error(r.err);
  });

  it("検査でエラーも警告も出ない", () => {
    const r = lim(["check", dir, "--json"]);
    expect(r.code, r.out).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ files: 2, errors: 0, warnings: 0 });
  });

  it("検査は無い素材も見つける（制作画面の点検・書き出しと同じ）", () => {
    const broken = join(work, "broken-asset");
    expect(lim(["new", "broken-asset"], work).code).toBe(0);
    const start = join(broken, "scenario/start.lim");
    writeFileSync(start, readFileSync(start, "utf8").replace("@bg hill_dusk.webp", "@bg hill_dask.webp"));
    const r = lim(["check", broken, "--json"]);
    expect(r.code).toBe(1);
    expect((JSON.parse(r.out) as { diagnostics: { code: string; message: string }[] }).diagnostics.map((d) => [d.code, d.message])).toEqual([["missing-asset", "素材 bgimage/hill_dask.webp がありません"]]);
  });

  it("選び方を変えても最後まで流れ、選び方によって結末が変わる", () => {
    // 望遠鏡 → ラジオ → 外へ → 願う / 外へ → 願う / ラジオ → 外へ → 見ている
    const routes: [number[], Record<string, unknown>][] = [
      [[0, 1, 2, 0], { looked: true, wished: true }],
      [[2, 0], { looked: false, wished: true }],
      [[1, 2, 1], { looked: false, wished: false }],
    ];
    const endings = new Set<string>();
    for (const [choose, game] of routes) {
      const r = lim(["trace", dir, "start", "--choose", choose.join(","), "--json"]);
      expect(r.code, r.err).toBe(0);
      const t = JSON.parse(r.out) as TraceJson;
      expect(t.result.reason).toBe("end");
      expect(t.game).toEqual(game);
      expect(t.trace.filter((e) => e.type === "diagnostic")).toEqual([]);
      const pages = t.trace.flatMap((e) => (e.type === "page" ? [e] : []));
      expect(pages.at(-1)?.file).toBe("epilogue");
      // 結末の分岐（start の最後の本文）
      endings.add(pages.filter((p) => p.file === "start").at(-1)!.text);
    }
    expect(endings.size).toBe(3);
  });

  it("全ファイルを流すと本文の網羅率が高く、実行時の診断が出ない", () => {
    const r = lim(["coverage", dir]);
    expect(r.code, r.out).toBe(0);
    const m = /到達した本文: (\d+)\/(\d+) 行/.exec(r.out);
    expect(m, r.out).not.toBeNull();
    expect(Number(m![1]) / Number(m![2])).toBeGreaterThanOrEqual(0.95);
    expect(r.out).toContain("エラーと警告: 0 種類");
  });

  it("素材は書き出せる形式だけで、合わせて 2MB 以下", () => {
    const assets = files(join(TEMPLATE, "assets"));
    expect(assets.length).toBeGreaterThan(0);
    for (const f of assets) expect([".png", ".webp", ".wav"], f).toContain(extname(f));
    // 描いた背景と立ち絵（WebP）を入れても、npm で配るひな形が重くなりすぎないように
    expect(assets.reduce((n, f) => n + statSync(f).size, 0)).toBeLessThanOrEqual(2 * 1024 * 1024);
  });
});

describe("ひな形の書き出し", () => {
  it("素材が一つも無い白紙のプロジェクトも、ブラウザ版に書き出せる", () => {
    const r0 = lim(["new", "blank-build", "--blank", "--id", "empty_build"], work);
    expect(r0.code, r0.err).toBe(0);
    const dir = join(work, "blank-build");
    const r = lim(["build", dir, "browser", "--no-verify"], undefined, 300_000);
    expect(r.code, `${r.out}\n${r.err}`).toBe(0);
    expect(existsSync(join(dir, "dist/browser/empty_build/index.html"))).toBe(true);
  }, 300_000);
});
