import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectTranslatable, CORE_COMMANDS, createRegistry, parse, voiceLines, type Diagnostic } from "@liminalia/lang";
import { loadProject } from "@liminalia/project";
import { setScreenTemplateRules, StudioWorkspace } from "@liminalia/studio/server";
import { screenTemplateRules } from "@liminalia/web/screen-rules";
import { LimProject } from "../../vscode/src/model.ts";
import { buildInput, listAssets, loadCommands, readCastFile, readProjectInfo } from "../../vscode/src/project.ts";

/**
 * 同じ作品を、lim check（MCP の check も子のプロセスで同じものを動かす）、制作画面のチェック、MCP の check_text（制作画面の checkText）、
 * VS Code の拡張の検査に通し、診断の一覧（file、line、重さ、code）が同じになることを確かめる。
 * 前は呼び手ごとに検査の入力を組み立てていて、制作画面と VS Code が命令のデータからのジャンプ先を知らずに使われないラベルを出し、
 * 制作画面に訳と書式の版の検査が無かった。今は @liminalia/sdk の projectDiagnostics が一度だけ組み立てる。
 */

const REPO = resolve(import.meta.dirname, "../../..");
const LIM = join(REPO, "packages/cli/bin/lim.mjs");
const TEMPLATE = join(REPO, "templates/default");

const work = mkdtempSync(join(tmpdir(), "liminalia-check-parity-"));
const dir = join(work, "game");
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** 比べる形（並びは問わない）。 */
const brief = (list: readonly Pick<Diagnostic, "file" | "line" | "severity" | "code">[]) => list.map((d) => `${d.file}:${d.line} ${d.severity} ${d.code}`).sort();

beforeAll(() => {
  // 制作画面に標準の画面の決まりを渡す（開発サーバーを立てる側、スマホ版の Service Worker、lim mcp と同じ）
  setScreenTemplateRules(screenTemplateRules());
  cpSync(TEMPLATE, dir, { recursive: true });
  rmSync(join(dir, "scenario"), { recursive: true, force: true });
  mkdirSync(join(dir, "scenario"));
  const scenario = (name: string, lines: string[]) => writeFileSync(join(dir, "scenario", `${name}.lim`), `${lines.join("\n")}\n`);
  // 調べる場所のデータ（@investigate）だけから入るシーン（#shelf、#window、#done）と、ロードの直後に呼ぶシーン（#after_load）
  scenario("start", [
    "@use parts",
    "@use common",
    "# start",
    "@bg hill_dusk.webp",
    "@window show",
    "@banner",
    "　古い書庫に着いた。",
    // 標準のコマンドの書き損じと、章に入らないシナリオの章の扉、話者でない名前の表示名
    "@chapter-card",
    "@flash count=10",
    "@cutin-hide nobody",
    "カイ{name ？？？}「……」",
    // Git LFS のポインタのまま取り込んでいない背景
    "@bg lfs_room.webp",
    "@investigate library",
    "@stop",
    "# shelf",
    "　棚には古い本が並んでいる。",
    "@stop",
    "# window",
    "　窓の外は雨だ。",
    "@stop",
    "# done",
    "@if game.seen_shelf",
    "　本の題を覚えておいた。",
    "@end",
    "@jump epilogue",
    "# after_load",
    "@window show",
    "@return",
  ]);
  scenario("epilogue", ["# epilogue", "　おわり。", "{= double(2)}", "@stop", "@function double(n)", "@return n * 2", "@end"]);
  // commandDefaults でだけ使うマクロ
  scenario("parts", ["@define chime(volume: int = 50)", "@se chime.wav volume=(volume)", "@end"]);
  // 下書きを @use する（書き出しに入らない）
  scenario("common", ["// lim: draft", "@define banner()", "@window show", "@end"]);
  // 回想の target が下書き（書き出しに入らない）
  scenario("memory", ["// lim: draft", "# scene", "　昔のこと。", "@replay-end"]);
  // 頭に BOM のある台本（1 行目の命令の書き損じ）と、前の名前の fade=（本文の中の {@…} にも）
  writeFileSync(join(dir, "scenario", "bom.lim"), "\uFEFF@bgg hill_dusk.webp\n@bg hill_dusk.webp fade=1s\n　本文{@chara-hide-all fade=300ms}です。\n");
  mkdirSync(join(dir, "data"), { recursive: true });
  const rect = { x: 10, y: 10, width: 100, height: 100 };
  writeFileSync(
    join(dir, "data/investigation.json"),
    JSON.stringify({
      places: {
        library: {
          title: "書庫",
          file: "start",
          views: [
            {
              id: "main",
              label: "書庫",
              background: "hill_dusk.webp",
              spots: [
                { id: "shelf", label: "棚", rect, target: "#shelf", flag: "seen_shelf" },
                { id: "window", label: "窓", rect, target: "#window" },
              ],
            },
          ],
          done: "#done",
        },
      },
    }),
  );
  writeFileSync(join(dir, "assets/bgimage/lfs_room.webp"), "version https://git-lfs.github.com/spec/v1\noid sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\nsize 204800\n");
  // プラグインを入れていない Live2D の立ち絵
  const castFile = JSON.parse(readFileSync(join(dir, "cast.json"), "utf8")) as { cast: Record<string, Record<string, unknown>> };
  castFile.cast["アカリ"]!.model = { type: "live2d", src: "akari/akari.model3.json" };
  // 自動配置の定位置の誤り（left と right のほか）
  castFile.cast["ソウ"]!.side = "center";
  writeFileSync(join(dir, "cast.json"), JSON.stringify(castFile, null, 2));
  // 誤りのある画面のテンプレート（知らない部品と data-role、外される onclick、版の無い部品）と、同じ画面を screens.* で差し替えるプラグイン
  mkdirSync(join(dir, "ui/screens/confirm"), { recursive: true });
  writeFileSync(
    join(dir, "ui/screens/confirm/confirm.html"),
    [
      '<template data-part="screen">',
      '<div class="lm-dialog-backdrop"><div class="lm-dialog">',
      '  <p class="lm-dialog-message" data-field="message" onclick="go()"></p>',
      '  <button data-role="yes" data-field="yes"></button>',
      "</div></div>",
      "</template>",
      '<template data-part="row" data-version="1"><li></li></template>',
      "",
    ].join("\n"),
  );
  mkdirSync(join(dir, "plugins/frame/src"), { recursive: true });
  writeFileSync(join(dir, "plugins/frame/package.json"), JSON.stringify({ name: "frame", type: "module", exports: { "./web": "./src/web.ts" } }));
  writeFileSync(join(dir, "plugins/frame/src/web.ts"), 'export default { name: "frame", screens: { confirm: () => undefined } };\n');
  // 訳のファイル（en はあるが中身が空、ko は無い）、書式の版がエンジンより新しい、使えない名前の変数
  mkdirSync(join(dir, "lang"), { recursive: true });
  // パック（packs/extra）: パックだけにある台本の台詞の訳（本体の訳）とボイスの番号の固定（本体の voice-lock.json）。パックの訳には使われていない鍵
  mkdirSync(join(dir, "packs/extra/scenario"), { recursive: true });
  mkdirSync(join(dir, "packs/extra/lang"), { recursive: true });
  writeFileSync(join(dir, "packs/extra/pack.json"), JSON.stringify({ id: "extra", title: "おまけ" }));
  const bonus = '# bonus\n@voice-auto アカリ pattern="akari/{n:3}.wav"\nアカリ「おまけの台詞です」\n';
  writeFileSync(join(dir, "packs/extra/scenario/bonus.lim"), bonus);
  const said = parse(bonus, "bonus", { speakers: (JSON.parse(readFileSync(join(dir, "cast.json"), "utf8")) as { speakers: string[] }).speakers });
  const line = collectTranslatable(said, createRegistry(CORE_COMMANDS)).find((t) => t.kind === "line")!;
  const voice = voiceLines(said)[0]!;
  writeFileSync(join(dir, "lang/en.json"), JSON.stringify({ language: "en", lines: { [line.key]: { source: line.source, text: '"A bonus line"' } } }, null, 2));
  writeFileSync(join(dir, "packs/extra/lang/en.json"), JSON.stringify({ language: "en", lines: { "gone:l00000000": { source: "消した行", text: "Gone" } } }, null, 2));
  writeFileSync(join(dir, "voice-lock.json"), JSON.stringify({ lines: { [voice.key]: { speaker: "アカリ", n: 1, source: voice.source } } }, null, 2));
  // 作品の CSS（無いファイル、無い素材、作品の外を指す参照、閉じていない括弧）
  mkdirSync(join(dir, "ui"), { recursive: true });
  writeFileSync(join(dir, "ui/screens.css"), ".lm-menu { background: url(../assets/bgimage/hill_dusk.webp); }\n.lm-button { background: url(nothing.png); }\n.lm-tab { background: url(https://example.com/a.png); }\n.lm-screen { color: red;\n");
  const config = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(
    join(dir, "liminalia.json"),
    JSON.stringify(
      {
        ...config,
        format: 999,
        languages: ["ja", "en", "ko"],
        afterLoad: "start#after_load",
        variables: { "game.count": 0, flag: true },
        commandDefaults: { ...(config.commandDefaults as object), chime: { volume: 40 } },
        extra: { replay: [{ id: "r1", title: "回想", target: "memory#scene" }] },
        // start はどの章にも入らない
        chapters: [{ id: "end", title: "おわり", files: ["epilogue"] }],
        plugins: ["./plugins/frame"],
        // 自動配置の誤り（知らない enter、byCount の書いた側の綴り違い）
        autoLayout: { enter: "Start", byCount: { "2": { lefft: "center" } } },
        ui: { css: ["ui/screens.css", "ui/gone.css"], templates: { confirm: "ui/screens/confirm/confirm.html", confirmm: "ui/screens/confirm/confirm.html" } },
      },
      null,
      2,
    ),
  );
});

/** lim check --json（MCP の check はこれを子のプロセスで動かす）。 */
function limCheck(): Diagnostic[] {
  const r = spawnSync(process.execPath, [LIM, "check", dir, "--json"], { cwd: REPO, encoding: "utf8", timeout: 120_000 });
  return (JSON.parse(r.stdout) as { diagnostics: Diagnostic[] }).diagnostics;
}

/** VS Code の拡張の検査（言語サーバーと同じ読み方。開いているファイルは無い）。 */
async function vscodeCheck(): Promise<Diagnostic[]> {
  const info = readProjectInfo(dir);
  const commands = await loadCommands(info, { trusted: true, workspaceFolders: [dir], node: process.execPath });
  const { speakers, cast } = readCastFile(info.paths.cast);
  const textOf = (path: string) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  };
  return new LimProject(buildInput(info, { commands, speakers, cast }, textOf, (folder) => listAssets(join(info.paths.assets, folder)))).diagnostics();
}

describe("検査の結果が呼び手で同じ", { timeout: 180_000 }, () => {
  let cli: Diagnostic[];
  beforeAll(() => {
    cli = limCheck();
  });

  it("lim check は、命令のデータからのジャンプ先、commandDefaults のマクロ、訳、書式の版、下書きを見る", () => {
    const shown = brief(cli);
    // 届かないと誤って出さない
    expect(shown.filter((d) => /unused-label|unused-define|unset-variable/.test(d) && !d.startsWith("cast.json"))).toEqual([]);
    expect(shown).toEqual(expect.arrayContaining(["start:2 error draft-use", "lang/ko.json:1 warning missing-translation"]));
    const codes = cli.filter((d) => d.file === "liminalia.json").map((d) => `${d.severity} ${d.code}`);
    expect(codes).toEqual(expect.arrayContaining(["error draft-entry", "warning newer-format", "error bad-config"]));
    // 使えない名前の変数（loadProject が使わずに続けた項目）を、その項目の行に出す
    expect(cli.find((d) => d.code === "bad-config" && d.message.includes("variables の flag"))?.line).toBeGreaterThan(1);
    expect(cli.find((d) => d.code === "draft-entry")?.message).toContain("extra.replay r1");
    // 構文チェックで見つける書き損じ（標準のコマンド、章、表示名、ブロックの形の関数）
    expect(shown).toEqual(
      expect.arrayContaining([
        "start:8 warning chapter-card-empty",
        "start:9 warning flash-rate",
        "start:10 warning hide-name-unknown",
        "start:11 warning unknown-speaker",
        "start:12 error lfs-pointer",
        "start:1 info not-in-chapter",
        "epilogue:5 error bad-function",
      ]),
    );
    // 作品の画面のテンプレート（画面ごとの決まりは @liminalia/web の標準の画面の定義から。liminalia.json の診断は ui.templates の行）
    const html = "ui/screens/confirm/confirm.html";
    expect(shown).toEqual(
      expect.arrayContaining([
        `${html}:1 warning template-outdated`,
        `${html}:1 error template-missing-role`,
        `${html}:3 warning template-unsafe`,
        `${html}:4 warning template-unknown-value`,
        `${html}:7 warning template-unknown-part`,
      ]),
    );
    const templateConfig = cli.filter((d) => d.file === "liminalia.json" && d.code.startsWith("template-"));
    expect(templateConfig.map((d) => `${d.severity} ${d.code}`).sort()).toEqual(["warning template-overridden", "warning template-unknown-screen"]);
    expect(templateConfig.every((d) => d.line > 1)).toBe(true);
    expect(templateConfig.find((d) => d.code === "template-overridden")?.message).toContain("./plugins/frame");
    // 作品の CSS（ui.css）: 無いファイルは liminalia.json の ui.css の行、CSS の中のものはそのファイルのその行
    expect(shown).toEqual(expect.arrayContaining(["ui/screens.css:2 error ui-css-asset", "ui/screens.css:3 error ui-css-outside", "ui/screens.css:4 error ui-css-syntax"]));
    expect(cli.find((d) => d.code === "ui-css-missing")?.line).toBeGreaterThan(1);
    // cast.json の診断はその人物と話者の行（1 行目でない）
    expect(cli.filter((d) => d.file === "cast.json").map((d) => d.code).sort()).toEqual(["bad-cast", "model-plugin-missing", "unused-speaker", "unused-speaker", "unused-speaker"]);
    // 頭に BOM のある台本の 1 行目、前の名前の fade=、自動配置
    expect(shown).toEqual(expect.arrayContaining(["bom:1 error unknown-command", "bom:2 warning renamed-param", "bom:3 warning renamed-param"]));
    expect(cli.filter((d) => d.code === "bad-auto-layout").map((d) => d.file)).toEqual(["liminalia.json", "liminalia.json"]);
    expect(cli.filter((d) => d.file === "cast.json" && d.line === 1)).toEqual([]);
    // パック: パックだけが使う本体の訳とボイスの番号を「使われていない」にせず、パックの訳は確かめる
    expect(cli.filter((d) => d.code === "voice-lock-outdated" || (d.file === "lang/en.json" && d.code === "unused-translation"))).toEqual([]);
    expect(shown).toEqual(expect.arrayContaining(["packs/extra/lang/en.json:1 warning unused-translation"]));
  });

  it("制作画面のチェックは lim check と同じ", async () => {
    const ws = await StudioWorkspace.open(loadProject(dir));
    expect(brief(ws.check().diagnostics)).toEqual(brief(cli));
  });

  it("MCP の check_text（制作画面の checkText）は、そのファイルについて lim check と同じ。project なら全体", async () => {
    const ws = await StudioWorkspace.open(loadProject(dir));
    for (const name of readdirSync(join(dir, "scenario")).map((f) => f.replace(/\.lim$/, ""))) {
      const text = readFileSync(join(dir, "scenario", `${name}.lim`), "utf8");
      expect(brief(ws.checkText(name, text)), name).toEqual(brief(cli.filter((d) => d.file === name)));
    }
    expect(brief(ws.checkText("start", readFileSync(join(dir, "scenario/start.lim"), "utf8"), "project"))).toEqual(brief(cli));
  });

  it("VS Code の拡張の検査は lim check と同じ", async () => {
    expect(brief(await vscodeCheck())).toEqual(brief(cli));
  });
});

describe("検査の入力を組み立てるのは一か所", () => {
  const source = (path: string) => readFileSync(join(REPO, "packages", path), "utf8");

  it("lim check、制作画面、VS Code は @liminalia/sdk の projectDiagnostics を使い、checkProject を直に呼ばない", () => {
    for (const path of ["cli/src/commands/check.ts", "studio/src/server/workspace.ts", "vscode/src/model.ts"]) {
      const text = source(path);
      expect(text, path).toMatch(/\bprojectDiagnostics\(/);
      expect(text, path).not.toMatch(/\bcheckProject\(/);
    }
  });

  it("MCP は制作画面の checkText（check_text、apply_fixes、書く前の確かめ）と lim check（check）を使う", () => {
    const mcp = ["cli/src/commands/mcp.ts", "cli/src/commands/mcp-authoring.ts", "cli/src/commands/mcp-studio.ts", "cli/src/commands/mcp-tools.ts"].map(source).join("\n");
    expect(mcp).toMatch(/ws\.checkText\(/);
    expect(mcp).toMatch(/this\.lim\(\["check"/);
    expect(mcp).not.toMatch(/\bcheckProject\(|\bprojectDiagnostics\(/);
  });

  it("lang の外で checkProject を呼ぶのは projectDiagnostics だけ", () => {
    const callers: string[] = [];
    const walk = (folder: string) => {
      for (const e of readdirSync(join(REPO, "packages", folder), { withFileTypes: true })) {
        const rel = `${folder}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (rel.endsWith(".ts") && /\bcheckProject\(/.test(source(rel))) callers.push(rel);
      }
    };
    for (const pkg of readdirSync(join(REPO, "packages"))) if (pkg !== "lang" && existsSync(join(REPO, "packages", pkg, "src"))) walk(`${pkg}/src`);
    expect(callers).toEqual(["plugin-host/src/project-check.ts"]);
  });
});
