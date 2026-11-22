import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findChromium } from "../src/chromium.ts";

/**
 * 濁点などの合成だけが違う名前（NFD と NFC）の素材を、名前を字のとおりにしか返さないサーバー（Linux のサーバーや多くの配信の場所と同じ）で
 * 遊べるか（2026-11-20）。Mac のファイルの仕組みは名前の形の違いを吸収するので、Mac の lim build の確かめでは見つからない。
 * 台本は NFC（「ガード」）で書き、素材のファイルは NFD の名前で置く。書き出しは台本に書いた形の名前で写す（alignAssetNames）。
 * ブラウザが要るので、LIMINALIA_E2E_BROWSER=1 のときだけ動かす。
 */
const e2e = !!process.env.LIMINALIA_E2E_BROWSER;
const LIM = resolve(import.meta.dirname, "../bin/lim.mjs");
const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
const NAME = "ガード.webp";

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webp": "image/webp", ".png": "image/png", ".wav": "audio/wav", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

/** パスの一つ一つを、フォルダの中の名前と字のとおりに（正規化せずに）照らして探す。無ければ null。 */
function strictPath(root: string, url: string): string | null {
  let at = root;
  for (const part of url.split("/").filter(Boolean)) {
    if (!existsSync(at) || !statSync(at).isDirectory()) return null;
    if (!readdirSync(at).includes(part)) return null;
    at = join(at, part);
  }
  return at;
}

describe.skipIf(!e2e)("NFD の名前の素材を、名前を字のとおりに返すサーバーで遊ぶ", { timeout: 300_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "liminalia-nfd-"));
  let server: Server;
  let browser: Browser;
  let base = "";
  beforeAll(async () => {
    cpSync(TEMPLATE, dir, { recursive: true });
    copyFileSync(join(dir, "assets/bgimage/hill_dusk.webp"), join(dir, "assets/bgimage", NAME.normalize("NFD")));
    const start = join(dir, "scenario/start.lim");
    writeFileSync(start, readFileSync(start, "utf8").replace("# start\n", `# start\n@bg ${NAME.normalize("NFC")}\n`));
    const built = spawnSync(process.execPath, [LIM, "build", dir, "browser", "--no-verify", "--only-used"], { encoding: "utf8", timeout: 240_000, env: { ...process.env, LIMINALIA_LANG: "ja" } });
    expect(built.status, built.stdout + built.stderr).toBe(0);
    const out = join(dir, "dist/browser", readdirSync(join(dir, "dist/browser")).find((n) => statSync(join(dir, "dist/browser", n)).isDirectory())!);
    server = createServer((req, res) => {
      const url = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
      let file = strictPath(out, url);
      if (file && statSync(file).isDirectory()) file = strictPath(out, `${url.replace(/\/$/, "")}/index.html`);
      if (!file) {
        res.statusCode = 404;
        return res.end("Not Found");
      }
      res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
      res.end(readFileSync(file));
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ executablePath: findChromium() ?? undefined, args: ["--mute-audio"] });
  });
  afterAll(async () => {
    await browser?.close();
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("台本に NFC で書いた背景が、NFD の名前で置いた素材から写した名前で読める（404 にならない）", async () => {
    const page = await browser.newPage();
    const missing: string[] = [];
    const loaded: string[] = [];
    page.on("response", (r) => {
      const path = decodeURIComponent(new URL(r.url()).pathname);
      if (r.status() === 404) missing.push(path);
      else if (path.includes("ガ") || path.includes("ガ".normalize("NFD"))) loaded.push(path);
    });
    await page.goto(`${base}/index.html?autostart=1&start=start`);
    await page.waitForFunction(() => (window as unknown as { __liminalia?: { host?: { waiting?: boolean } } }).__liminalia?.host?.waiting === true, null, { timeout: 60_000 });
    expect(missing).toEqual([]);
    expect(loaded.length).toBeGreaterThan(0);
    // このサーバーは名前を字のとおりにしか返さない（同じ素材を NFD の形で頼むと 404）。Mac の上でも Linux の配信と同じに確かめられている
    const asked = loaded[0]!;
    expect(asked.normalize("NFC")).toBe(asked);
    const other = await fetch(`${base}${asked.split("/").map((p) => encodeURIComponent(p.normalize("NFD"))).join("/")}`);
    expect(other.status).toBe(404);
    await page.close();
  });
});
