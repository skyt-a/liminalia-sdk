import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProject } from "@liminalia/project";
import { DataStore } from "../src/server/data-store.ts";
import { applyThemeUndoable, setUiCssRules, writeUiCss, renameAsset, renameCast, restoreTrash, trashAsset, trashAssets } from "../src/server/manage.ts";
import { addScreenScript, copyScreenUndoable, resetScreenUndoable, writeScreenFile } from "../src/server/screen-files.ts";
import { setScreenTemplateRules } from "../src/server/screens.ts";
import { WRITE_ROUTES } from "../src/server/undo-routes.ts";
import { screenTemplateRules } from "@liminalia/screens/rules";
import { StudioWorkspace } from "../src/server/workspace.ts";

/**
 * ファイルを動かす・書き換える操作を ⌘Z で戻したとき（../src/server/file-undo.ts の控え）、設定とファイルの両方が操作の前と同じになり、
 * ⇧⌘Z でやり直すと操作のあとと同じになることを、作品のフォルダ全体を見比べて確かめる。
 *
 * 戻せる口（undo-routes.ts で journal にした口）は、ここの ROUND_TRIPS に戻し方の確かめを書く。書いていなければ落ちる。
 * 開発サーバーの書き換える口を足して undo-routes.ts に書かなければ、それも落ちる。
 */

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
setScreenTemplateRules(screenTemplateRules());
let dir: string;
let ws: StudioWorkspace;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-file-undo-"));
  cpSync(TEMPLATE, dir, { recursive: true });
  ws = await StudioWorkspace.open(loadProject(dir));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 比べないもの（書くたびに増える変更履歴と前の版、元に戻すの控えの置き場）。 */
const SKIP = [join(".liminalia", "history"), join(".liminalia", "backups"), join(".liminalia", "undo")];
/** 中身だけを比べ、それ自体があるかは比べないフォルダ（制作画面の控えの入れ物。空のまま残ってよい）。 */
const HOLDERS = new Set([".liminalia", join(".liminalia", "trash")]);

/** 作品のフォルダのファイル（中身の指紋）とフォルダ（空のフォルダの残りも見る）。 */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = relative(dir, p);
      if (SKIP.some((s) => rel === s || rel.startsWith(s + sep))) continue;
      if (e.isDirectory()) {
        if (!HOLDERS.has(rel)) out[`${rel.split(sep).join("/")}/`] = "dir";
        walk(p);
      } else out[rel.split(sep).join("/")] = createHash("sha1").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

/** 作品の素材の欠け（missing-asset）の検査の数。 */
const missingAssets = () => ws.check().diagnostics.filter((d) => d.code === "missing-asset").length;

/**
 * 操作を行い（返事の undo を返す）、戻すと前と同じ、やり直すとあとと同じになることを確かめる。
 * 戻したあと・やり直したあとの素材の欠けの数も、操作の前・あとと同じ。
 */
async function roundTrip(run: () => string | undefined | Promise<string | undefined>): Promise<{ before: Record<string, string>; after: Record<string, string> }> {
  const before = snapshot();
  const missingBefore = missingAssets();
  const id = await run();
  expect(id, "操作が ⌘Z で戻す控え（undo）を返していません").toBeTypeOf("string");
  const after = snapshot();
  expect(after).not.toEqual(before);
  const missingAfter = missingAssets();
  expect(ws.journals.state(id!)).toBe("applied");
  expect(ws.journals.apply(id!, "undone")).toEqual({ ok: true });
  expect(snapshot()).toEqual(before);
  expect(missingAssets()).toBe(missingBefore);
  expect(ws.journals.state(id!)).toBe("undone");
  expect(ws.journals.apply(id!, "applied")).toEqual({ ok: true });
  expect(snapshot()).toEqual(after);
  expect(missingAssets()).toBe(missingAfter);
  // もう一度戻して前と同じ（戻す・やり直すを繰り返せる）
  expect(ws.journals.apply(id!, "undone")).toEqual({ ok: true });
  expect(snapshot()).toEqual(before);
  return { before, after };
}

const data = () => new DataStore(ws.project);
const png = (n: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n]);

/** 戻せる口ごとの確かめ（undo-routes.ts の journal の口と同じ並び）。 */
const ROUND_TRIPS: Record<string, () => Promise<void>> = {
  "POST /ui/theme": async () => {
    // 洋館 → 近未来を当て、近未来を戻すと、洋館の素材がごみ箱から戻って欠けが出ない（S2）
    const mansion = applyThemeUndoable(ws, "mansion").undo!;
    expect(existsSync(join(dir, "assets/image/themes/mansion"))).toBe(true);
    const missing = missingAssets();
    const { before } = await roundTrip(() => applyThemeUndoable(ws, "future").undo);
    expect(before["assets/image/themes/mansion/"]).toBe("dir");
    expect(JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")).ui.system.preset).toBe("mansion");
    expect(missingAssets()).toBe(missing);
    // 洋館を当てる前まで戻すと、写した素材のフォルダも残らない
    expect(ws.journals.apply(mansion, "undone")).toEqual({ ok: true });
    expect(existsSync(join(dir, "assets/image/themes"))).toBe(false);
  },
  "POST /ui/css-rule": async () => {
    // ui.css が無ければ ui/screens.css を作って ui.css に足す。戻すとファイルもフォルダも ui.css も前のまま
    const { before } = await roundTrip(() => setUiCssRules(ws, [{ selector: ".lm-menu", property: "background-color", value: "#223344" }]).undo);
    expect(before["ui/"]).toBeUndefined();
    // もう一度書いて、同じ行を書き換える（ファイルはあるので中身だけ戻る）
    setUiCssRules(ws, [{ selector: ".lm-menu", property: "background-color", value: "#223344" }]);
    const r = await roundTrip(() => setUiCssRules(ws, [{ selector: ".lm-menu", property: "background-color", value: "#000000" }]).undo);
    expect(readFileSync(join(dir, "ui/screens.css"), "utf8")).toBe(".lm-menu { background-color: #223344; }\n");
    expect(r.after["ui/screens.css"]).not.toBe(r.before["ui/screens.css"]);
  },
  "PUT /ui/css": async () => {
    // CSS の欄から丸ごと書く。ui.css が無ければ ui/screens.css を作って足し、戻すとファイルもフォルダも ui.css も前のまま
    const write = (text: string, before: string) => {
      const r = writeUiCss(ws, text, before);
      return r.ok ? r.undo : undefined;
    };
    const { before } = await roundTrip(() => write(".lm-menu {\n  color: red;\n}\n", ""));
    expect(before["ui/"]).toBeUndefined();
    // 読んだあとにほかで変わっていれば書かない
    write(".a { color: red; }\n", "");
    expect(writeUiCss(ws, ".b {}\n", "")).toEqual({ ok: false, file: "ui/screens.css", text: ".a { color: red; }\n" });
    // 読んだときと書く先のファイルが替わっていれば（ui.css の一つ目を外で替えた）、中身が同じでも書かない
    expect(writeUiCss(ws, ".b {}\n", ".a { color: red; }\n", "ui/other.css")).toEqual({ ok: false, file: "ui/screens.css", text: ".a { color: red; }\n" });
    const r = await roundTrip(() => write(".a { color: blue; }\n", ".a { color: red; }\n"));
    expect(readFileSync(join(dir, "ui/screens.css"), "utf8")).toBe(".a { color: red; }\n");
    expect(r.after["liminalia.json"]).toBe(r.before["liminalia.json"]);
  },
  "POST /screens/copy": async () => {
    // 写すと ui/screens/confirm/ と元の文字と ui.templates ができる。戻すとフォルダも登録も残らない
    const { before, after } = await roundTrip(() => copyScreenUndoable(ws, "confirm", undefined).undo);
    expect(before["ui/"]).toBeUndefined();
    expect(after["ui/screens/confirm/confirm.html"]).toBeTypeOf("string");
    expect(after[".liminalia/screens/confirm/screen.2.html"]).toBeTypeOf("string");
    // 部品だけを写す
    await roundTrip(() => copyScreenUndoable(ws, "confirm", ["screen"]).undo);
  },
  "POST /screens/script": async () => {
    const { after } = await roundTrip(() => addScreenScript(ws, "confirm").undo);
    expect(after["ui/screens/confirm/confirm.js"]).toBeTypeOf("string");
  },
  "PUT /screens/file": async () => {
    copyScreenUndoable(ws, "confirm", undefined);
    const file = join(dir, "ui/screens/confirm/confirm.html");
    const text = readFileSync(file, "utf8");
    const write = (next: string, before: string) => {
      const r = writeScreenFile(ws, "confirm", "template", next, before);
      return r.ok ? r.undo : undefined;
    };
    await roundTrip(() => write(text.replace("lm-dialog-message", "lm-dialog-message mine"), text));
    // 読んだあとにほかで変わっていれば書かない
    expect(writeScreenFile(ws, "confirm", "template", "x", "y")).toMatchObject({ ok: false, file: "ui/screens/confirm/confirm.html", text });
    // 画面の JS も同じ口で書く（無ければ作る）
    await roundTrip(() => {
      const r = writeScreenFile(ws, "confirm", "script", "export default function () {}\n", "");
      return r.ok ? r.undo : undefined;
    });
  },
  "POST /screens/reset": async () => {
    copyScreenUndoable(ws, "confirm", undefined);
    addScreenScript(ws, "confirm");
    const { after } = await roundTrip(() => resetScreenUndoable(ws, "confirm").undo);
    // テンプレートと画面の JS は名前を変えて残り、登録が外れる
    expect(Object.keys(after).filter((f) => /\.reset-\d{8}-\d{6}\.(html|js)$/.test(f))).toHaveLength(2);
    expect(after["ui/screens/confirm/confirm.html"]).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")).ui?.templates).toEqual({ confirm: "ui/screens/confirm/confirm.html" });
  },
  "POST /assets/rename": async () => {
    // 立ち絵のフォルダの名前を変えると、cast.json と台本の参照も書き換わる。戻すと両方とも前のまま
    await roundTrip(() => renameAsset(ws, "fgimage", "akari", "heroine/akari").undo);
    await roundTrip(() => renameAsset(ws, "bgimage", "hill_dusk.webp", "dusk/hill.webp").undo);
  },
  "POST /assets/trash": async () => {
    await roundTrip(() => trashAsset(ws, "bgimage", "hill_night.webp").undo);
    await roundTrip(() => trashAsset(ws, "fgimage", "sou").undo);
  },
  "POST /assets/trash-many": async () => {
    await roundTrip(() => trashAssets(ws, [{ kind: "sound", path: "chime.wav" }, { kind: "fgimage", path: "akari/normal.webp" }]).undo);
  },
  "POST /asset": async () => {
    // 新しい素材（新しいフォルダの中）と、同じ名前の上書き
    const journals = { journals: ws.journals, after: () => ws.forgetAssets() };
    await roundTrip(() => {
      const r = data().upload("fgimage", "mio/smile.png", png(1), false, journals);
      return r.ok ? r.undo : undefined;
    });
    await roundTrip(() => {
      const r = data().upload("bgimage", "hill_dusk.webp", png(2), true, journals);
      return r.ok ? r.undo : undefined;
    });
  },
  "POST /cast/rename": async () => {
    await roundTrip(() => renameCast(ws, { kind: "cast", from: "アカリ", to: "akari" }).undo);
    await roundTrip(() => renameCast(ws, { kind: "speaker", from: "アカリ", to: "明里" }).undo);
    // ID と表示名を一緒に変えても、一つの控えで両方戻る
    await roundTrip(() => renameCast(ws, { kind: "cast", from: "アカリ", to: "明里", speakerToo: true }).undo);
  },
};

describe("ファイルを動かす操作を元に戻す", () => {
  const journalRoutes = Object.entries(WRITE_ROUTES)
    .filter(([, kind]) => kind === "journal")
    .map(([route]) => route);

  it("戻せる口には、戻して確かめる手順がある", () => {
    expect(journalRoutes.filter((r) => !ROUND_TRIPS[r])).toEqual([]);
    expect(Object.keys(ROUND_TRIPS).filter((r) => !journalRoutes.includes(r))).toEqual([]);
  });

  for (const route of journalRoutes) {
    it(`${route}: 戻すと設定もファイルも前と同じ、やり直すとあとと同じ`, async () => {
      await ROUND_TRIPS[route]!();
    });
  }

  it("操作のあとでほかに変わったものは戻さない（changed）。開発サーバーが覚えていないものは gone", () => {
    const id = trashAsset(ws, "bgimage", "hill_night.webp").undo!;
    // ごみ箱に入れたものと同じ名前のファイルを置いた
    writeFileSync(join(dir, "assets/bgimage/hill_night.webp"), "x");
    expect(ws.journals.state(id)).toBe("changed");
    expect(ws.journals.apply(id, "undone")).toEqual({ ok: false, state: "changed" });
    expect(readFileSync(join(dir, "assets/bgimage/hill_night.webp"), "utf8")).toBe("x");
    expect(ws.journals.state("u999")).toBe("gone");
  });

  it("ごみ箱から手で戻したあとの ⌘Z は、もう戻したものとして扱う", () => {
    const original = snapshot();
    const r = trashAsset(ws, "bgimage", "hill_night.webp");
    // 素材の画面の「元に戻す」（ごみ箱から戻す。restoreTrash と同じ）
    restoreTrash(ws, r.id);
    expect(snapshot()).toEqual(original);
    expect(ws.journals.state(r.undo!)).toBe("undone");
    expect(ws.journals.apply(r.undo!, "undone")).toEqual({ ok: true });
    expect(snapshot()).toEqual(original);
    // やり直すとまたごみ箱へ
    expect(ws.journals.apply(r.undo!, "applied")).toEqual({ ok: true });
    expect(existsSync(join(dir, "assets/bgimage/hill_night.webp"))).toBe(false);
  });
});

describe("書き換える口の一覧", () => {
  it("開発サーバーの書き換える口は、すべて undo-routes.ts に ⌘Z での戻し方を書いてある", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../src/server/index.ts"), "utf8");
    const routes = [...source.matchAll(/case "((?:POST|PUT|DELETE|PATCH) \/[^"]*)"/g)].map((m) => m[1]!);
    expect(routes.length).toBeGreaterThan(30);
    expect(routes.filter((r) => !(r in WRITE_ROUTES))).toEqual([]);
    expect(Object.keys(WRITE_ROUTES).filter((r) => !routes.includes(r))).toEqual([]);
  });
});
