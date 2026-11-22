import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { loadProject } from "@liminalia/project";
import { planScreenShot, screenList, type ScreenShotOptions, type ScreenShotResult } from "../src/commands/shot-screen.ts";
import { McpServer } from "../src/commands/mcp.ts";

/**
 * lim shot --screen（標準の画面を作り物の中身で撮る）と、lim mcp の screen_shot。
 * 撮る前の確かめはいつも、実際に撮るのは Chromium が要るので LIMINALIA_E2E_BROWSER=1 のときだけ動かす（lim を子のプロセスで動かす）。
 */

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
const LIM = resolve(import.meta.dirname, "../bin/lim.mjs");

describe("lim shot --screen の撮る前の確かめ", () => {
  const project = loadProject(TEMPLATE);
  const plan = (o: Partial<ScreenShotOptions>) => planScreenShot(project, { screen: "saveload", state: "filled", ...o });

  it("見本の URL の引数を作り、開く演出を待たずに終わりの姿で撮る", () => {
    const p = plan({ state: "long", language: "en", theme: "night" });
    expect(Object.fromEntries(new URLSearchParams(p.query))).toEqual({ "ui-preview": "screen", screen: "saveload", state: "long", lang: "en", theme: "night", still: "1" });
    expect({ width: p.width, height: p.height, orientation: p.orientation }).toEqual({ width: project.screen.width, height: project.screen.height, orientation: "landscape" });
  });

  it("作品と違う向きなら幅と高さを入れ替え、同じ向きなら引数を付けない", () => {
    const p = plan({ orientation: "portrait" });
    expect({ width: p.width, height: p.height, orientation: p.orientation }).toEqual({ width: project.screen.height, height: project.screen.width, orientation: "portrait" });
    expect(new URLSearchParams(p.query).get("orientation")).toBe("portrait");
    expect(new URLSearchParams(plan({ orientation: "landscape" }).query).has("orientation")).toBe(false);
    // 縦長専用のテーマは縦長にすれば撮れる
    expect(() => plan({ theme: "chat" })).toThrow(/--portrait/);
    expect(plan({ theme: "chat", orientation: "portrait" }).width).toBe(project.screen.height);
  });

  it("知らない画面、開けない画面、無い状態とテーマは、選べるものを挙げて止める", () => {
    expect(() => plan({ screen: "nothing" })).toThrow(/あるもの: .*saveload/);
    expect(() => plan({ screen: "rotate" })).toThrow(/見本で開けません: スマホを縦に/);
    expect(() => planScreenShot(project, { screen: "rotate", state: "filled" }, "en")).toThrow(/Only shown when a phone/);
    expect(() => plan({ screen: "config", state: "empty" })).toThrow(/選べるもの: filled/);
    expect(() => plan({ state: "full" as never })).toThrow(/filled、empty、long/);
    expect(() => plan({ theme: "nothing" })).toThrow(/あるもの: .*washi/);
  });

  it("一覧は標準の画面と共通の CSS の変数、作品を渡せば選べるテーマ", () => {
    const list = screenList(project);
    expect(list.screens.map((s) => s.id)).toEqual(expect.arrayContaining(["saveload", "config", "backlog", "ending", "title"]));
    expect(list.systemVars).toContain("--lm-fg");
    expect(list.themes!.map((t) => t.id)).toContain("default");
    expect(screenList(null).themes).toBeUndefined();
  });
});

/** PNG の幅と高さ（IHDR）。 */
function pngSize(file: string | Buffer): { width: number; height: number } {
  const b = typeof file === "string" ? readFileSync(file) : file;
  expect(b.subarray(1, 4).toString()).toBe("PNG");
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** 作品のファイルの中身（.liminalia/vite の開発サーバーの控えは除く）。 */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const rel = relative(dir, p).split("\\").join("/");
      if (rel === ".liminalia/vite") continue;
      if (statSync(p).isDirectory()) walk(p);
      else out[rel] = createHash("sha1").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

/**
 * 撮る前にページで評価する式（lim shot --eval）。セレクタごとの文と数と、遊ぶ人の記憶の場所（localStorage の liminalia の鍵と、
 * IndexedDB の liminalia の鍵。見本は作り物に替えるので、どちらも空のまま）と、窓の向きを返す。
 */
const LOOK = (selectors: string[]) => `(async () => {
  const look = {};
  for (const s of ${JSON.stringify(selectors)}) look[s] = { count: document.querySelectorAll(s).length, text: [...document.querySelectorAll(s)].map((e) => e.textContent).join("\\n") };
  const local = Object.keys(localStorage).filter((k) => k.startsWith("liminalia"));
  const idb = [];
  if ((await indexedDB.databases()).some((d) => d.name === "liminalia")) {
    const db = await new Promise((ok, ng) => { const r = indexedDB.open("liminalia"); r.onsuccess = () => ok(r.result); r.onerror = () => ng(r.error); });
    for (const store of [...db.objectStoreNames]) {
      const keys = await new Promise((ok, ng) => { const r = db.transaction(store).objectStore(store).getAllKeys(); r.onsuccess = () => ok(r.result); r.onerror = () => ng(r.error); });
      idb.push(...keys.map((k) => store + ":" + String(k)));
    }
    db.close();
  }
  return { look, store: { local, idb }, portrait: innerWidth < innerHeight };
})()`;

interface Looked {
  look: Record<string, { count: number; text: string }>;
  store: { local: string[]; idb: string[] };
  portrait: boolean;
}

/** 操作説明を差し替えるプラグイン（screen_shot が差し替えたことを添えるのを確かめる）。 */
const PLUGIN = `import { defineWebPlugin } from "@liminalia/web";
export default defineWebPlugin({ name: "look",
  screens: {
    help: (api) => {
      const el = document.createElement("div");
      el.className = "look-help";
      el.textContent = api.rows.map((r) => r.label).join(" / ");
      return el;
    },
  },
});
`;

describe.skipIf(!process.env.LIMINALIA_E2E_BROWSER)("lim shot --screen で撮る", { timeout: 180_000 }, () => {
  let root: string;
  let dir: string;
  let out: string;
  let before: Record<string, string>;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "liminalia-shot-screen-"));
    dir = join(root, "game");
    out = join(root, "shots");
    mkdirSync(out);
    cpSync(TEMPLATE, dir, { recursive: true });
    const plugin = join(dir, "plugins", "look");
    mkdirSync(join(plugin, "src"), { recursive: true });
    writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "look", version: "0.0.0", type: "module", exports: { "./web": "./src/web.ts" } }));
    writeFileSync(join(plugin, "src", "web.ts"), PLUGIN);
    const cfg = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown>;
    cfg.plugins = ["./plugins/look"];
    writeFileSync(join(dir, "liminalia.json"), `${JSON.stringify(cfg, null, 2)}\n`);
    before = snapshot(dir);
  });
  afterAll(() => {
    if (process.env.LIMINALIA_KEEP_SHOTS) console.log(`撮った画像: ${out}`);
    else rmSync(root, { recursive: true, force: true });
  });

  /** lim shot --screen --json で撮り、作り物の中身が DOM に出ていることと、遊ぶ人の記憶の場所が空のままであることを確かめる。 */
  function shoot(o: Partial<ScreenShotOptions> & { screen: string }, selectors: string[]): ScreenShotResult & { eval: Looked } {
    const file = join(out, `${o.screen}-${o.state ?? "filled"}${o.orientation ? `-${o.orientation}` : ""}${o.language ? `-${o.language}` : ""}${o.theme ? `-${o.theme}` : ""}.png`);
    const args = ["shot", dir, "--screen", o.screen, "--out", file, "--json", "--eval", LOOK(selectors)];
    if (o.state) args.push("--state", o.state);
    if (o.orientation) args.push(`--${o.orientation}`);
    if (o.language) args.push("--lang", o.language);
    if (o.theme) args.push("--theme", o.theme);
    const p = spawnSync(process.execPath, [LIM, ...args], { encoding: "utf8", timeout: 150_000, env: { ...process.env, NO_COLOR: "1" } });
    expect(p.status, `${p.stdout}${p.stderr}`).toBe(0);
    const r = JSON.parse(p.stdout.slice(p.stdout.search(/^\{/m))) as ScreenShotResult & { eval: Looked };
    expect(r, JSON.stringify(r.problems)).toMatchObject({ ok: true, out: file, problems: [] });
    expect(r.eval.store).toEqual({ local: [], idb: [] });
    expect(r.eval.portrait).toBe(r.orientation === "portrait");
    expect(pngSize(file)).toEqual({ width: r.width, height: r.height });
    return r;
  }
  const count = (r: { eval: Looked }, selector: string) => r.eval.look[selector]!.count;
  const text = (r: { eval: Looked }, selector: string) => r.eval.look[selector]!.text;

  it("セーブ: 入った状態と空。スロットに作り物のサムネイルと章の名前が出る", () => {
    const filled = shoot({ screen: "saveload" }, [".lm-slot:not(.lm-empty)", ".lm-slot-thumb img", ".lm-slot-chapter"]);
    expect(count(filled, ".lm-slot:not(.lm-empty)")).toBeGreaterThanOrEqual(5);
    expect(count(filled, ".lm-slot-thumb img")).toBeGreaterThan(0);
    expect(text(filled, ".lm-slot-chapter")).toContain("灯台へ");
    expect(filled).toMatchObject({ width: 1280, height: 720, orientation: "landscape" });
    expect(filled.replacedBy).toBeUndefined();
    const empty = shoot({ screen: "saveload", state: "empty" }, [".lm-slot:not(.lm-empty)"]);
    expect(count(empty, ".lm-slot:not(.lm-empty)")).toBe(0);
  });

  it("縦長にすると幅と高さを入れ替えて撮る。英語とテーマも当てる", () => {
    const r = shoot({ screen: "saveload", orientation: "portrait", language: "en", theme: "night", state: "long" }, [".lm-screen-title", ".lm-slot-chapter"]);
    expect(r).toMatchObject({ width: 720, height: 1280, orientation: "portrait", lang: "en", theme: "night" });
    expect(text(r, ".lm-screen-title")).toContain("Load");
    expect(text(r, ".lm-slot-chapter")).toContain("The long slope");
  });

  it("結末、履歴、タイトル: 作り物の中身が出る", () => {
    expect(text(shoot({ screen: "ending" }, [".lm-ending-name"]), ".lm-ending-name")).toContain("灯台の明かり");
    const log = text(shoot({ screen: "backlog" }, [".lm-backlog"]), ".lm-backlog");
    expect(log).toContain("案内人");
    expect(log).toContain("灯台へ行く");
    expect(text(shoot({ screen: "title", state: "long" }, [".lm-title"]), ".lm-title")).toContain("長い、見本の作品の題名");
  });

  it("プラグインが差し替えた画面は、差し替えたプラグインの名前を添えて撮る", () => {
    const r = shoot({ screen: "help" }, [".look-help"]);
    expect(r.replacedBy).toBe("look");
    expect(count(r, ".look-help")).toBe(1);
  });

  it("撮っても作品のファイルは変わらない", () => {
    expect(snapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, "screen-saveload.png"))).toBe(false);
  });

  it("MCP の screen_shot は画像と様子を返し、プラグインが差し替えた画面なら添える", async () => {
    const server = new McpServer([root]);
    try {
      const call = async (args: Record<string, unknown>) =>
        ((await server.handle({ id: 1, method: "tools/call", params: { name: "screen_shot", arguments: { project: "game", ...args } } })) as { result: { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean } }).result;
      const shot = await call({ screen: "config", orientation: "portrait" });
      expect(shot.isError).toBeUndefined();
      const image = shot.content.find((c) => c.type === "image")!;
      expect(image.mimeType).toBe("image/png");
      expect(pngSize(Buffer.from(image.data!, "base64"))).toEqual({ width: 720, height: 1280 });
      const about = JSON.parse(shot.content.find((c) => c.type === "text")!.text!) as Record<string, unknown>;
      expect(about).toMatchObject({ ok: true, screen: "config", state: "filled", orientation: "portrait", width: 720, height: 1280, problems: [] });
      expect(about.out).toBeUndefined();
      // プラグイン look が操作説明を差し替えている
      const help = await call({ screen: "help" });
      expect(help.isError).toBeUndefined();
      expect(JSON.parse(help.content.find((c) => c.type === "text")!.text!)).toMatchObject({ ok: true, screen: "help", replacedBy: "look" });
    } finally {
      server.close();
    }
    expect(snapshot(dir)).toEqual(before);
  });
});

/**
 * ロードの幕（transitions.load）を長く見せるプラグイン。cover で舞台を覆う幕を置き、reveal は幕を 3 秒見せてから外す
 * （見本はロードの道筋で作り物の状態を入れるので、幕を通すと画面の代わりに幕が写る）。
 */
const CURTAIN = `import { defineWebPlugin } from "@liminalia/web";
export default defineWebPlugin({ name: "curtain",
  transitions: {
    load: {
      cover: async (ctx) => {
        const el = document.createElement("div");
        el.className = "slow-curtain";
        el.style.cssText = "position:absolute;inset:0;z-index:9999;background:#204060;pointer-events:none";
        ctx.systemLayer.append(el);
        await new Promise((r) => setTimeout(r, 50));
      },
      reveal: () => {
        setTimeout(() => document.querySelectorAll(".slow-curtain").forEach((el) => el.remove()), 3000);
      },
    },
  },
});
`;

/** 起動したら舞台の上に全面の層を置いたまま外さないプラグイン（撮るときに覆うものが残っていれば ok にしないのを確かめる）。 */
const VEIL = `import { defineWebPlugin } from "@liminalia/web";
export default defineWebPlugin({ name: "veil",
  setup: (host) => {
    const el = document.createElement("div");
    el.className = "stuck-veil";
    el.style.cssText = "position:absolute;inset:0;z-index:99999;background:#402020;pointer-events:none";
    host.stage.append(el);
  },
});
`;

/** テンプレートを写し、プラグインを一つ入れた作品を作る。 */
function projectWith(root: string, name: string, source: string): string {
  const dir = join(root, name);
  cpSync(TEMPLATE, dir, { recursive: true });
  const plugin = join(dir, "plugins", name);
  mkdirSync(join(plugin, "src"), { recursive: true });
  writeFileSync(join(plugin, "package.json"), JSON.stringify({ name, version: "0.0.0", type: "module", exports: { "./web": "./src/web.ts" } }));
  writeFileSync(join(plugin, "src", "web.ts"), source);
  const cfg = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown>;
  cfg.plugins = [`./plugins/${name}`];
  writeFileSync(join(dir, "liminalia.json"), `${JSON.stringify(cfg, null, 2)}\n`);
  return dir;
}

/** 撮る直前に、幕と層が残っているか、画面の真ん中で押せる一番上のものが画面の中か、を返す式。 */
const COVERED = (selector: string) => `(() => {
  const target = document.querySelector(${JSON.stringify(selector)});
  const r = target?.getBoundingClientRect();
  const top = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
  return { curtain: document.querySelectorAll(".slow-curtain").length, veil: document.querySelectorAll(".stuck-veil").length, target: !!target, onTop: !!top && !!target && target.contains(top) };
})()`;

interface Covered {
  curtain: number;
  veil: number;
  target: boolean;
  onTop: boolean;
}

describe.skipIf(!process.env.LIMINALIA_E2E_BROWSER)("lim shot --screen と画面を覆うもの", { timeout: 300_000 }, () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "liminalia-shot-cover-"));
  });
  afterAll(() => {
    if (process.env.LIMINALIA_KEEP_SHOTS) console.log(`撮った画像: ${root}`);
    else rmSync(root, { recursive: true, force: true });
  });

  function shootJson(dir: string, screen: string, selector: string, extra: string[] = []): { status: number | null; r: ScreenShotResult & { eval?: Covered }; file: string } {
    const file = join(root, `${dir.split(/[\\/]/).pop()}-${screen}${extra.join("")}.png`);
    const p = spawnSync(process.execPath, [LIM, "shot", dir, "--screen", screen, "--out", file, "--json", "--eval", COVERED(selector), ...extra], { encoding: "utf8", timeout: 150_000, env: { ...process.env, NO_COLOR: "1" } });
    const at = p.stdout.search(/^\{/m);
    expect(at, `${p.stdout}${p.stderr}`).toBeGreaterThanOrEqual(0);
    return { status: p.status, r: JSON.parse(p.stdout.slice(at)) as ScreenShotResult & { eval?: Covered }, file };
  }

  it("ロードの幕を長く見せるプラグインでも、幕ではなく画面を撮る", () => {
    const dir = projectWith(root, "curtain", CURTAIN);
    const cases: [string, string, string[]][] = [
      ["ending", ".lm-ending", []],
      ["saveload", ".lm-saveload", []],
      ["choice", ".choices button", ["--state", "long", "--portrait"]],
    ];
    for (const [screen, selector, extra] of cases) {
      const { status, r, file } = shootJson(dir, screen, selector, extra);
      expect(r.eval, `${screen} ${JSON.stringify(r)}`).toEqual({ curtain: 0, veil: 0, target: true, onTop: true });
      expect(r, screen).toMatchObject({ ok: true, out: file, problems: [] });
      expect(status).toBe(0);
      expect(existsSync(file)).toBe(true);
    }
  });

  it("撮るときに画面を覆う層が残っていれば ok にせず、problems に理由を出す（画像は残す）", async () => {
    const dir = projectWith(root, "veil", VEIL);
    const { status, r, file } = shootJson(dir, "ending", ".lm-ending");
    expect(r.ok, JSON.stringify(r)).toBe(false);
    expect(status).not.toBe(0);
    expect(r.problems.join("\n")).toMatch(/覆/);
    expect(r.out).toBe(file);
    expect(existsSync(file)).toBe(true);

    // MCP の screen_shot も、画像は返しつつ道具のエラーにする
    const server = new McpServer([root]);
    try {
      const result = ((await server.handle({ id: 1, method: "tools/call", params: { name: "screen_shot", arguments: { project: "veil", screen: "ending" } } })) as { result: { content: { type: string; text?: string }[]; isError?: boolean } }).result;
      expect(result.isError).toBe(true);
      expect(result.content.some((c) => c.type === "image")).toBe(true);
      const about = JSON.parse(result.content.find((c) => c.type === "text")!.text!) as ScreenShotResult;
      expect(about.ok).toBe(false);
      expect(about.problems.join("\n")).toMatch(/覆/);
    } finally {
      server.close();
    }
  });
});
