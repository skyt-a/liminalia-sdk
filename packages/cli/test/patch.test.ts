import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withoutServiceWorker } from "../src/commands/patch.ts";
import { injectCsp } from "../src/csp.ts";
import { injectServiceWorkerLoader, injectServiceWorkerRegister } from "../src/encrypt.ts";

/**
 * lim patch を実際のプロセスとして動かす。前の版をブラウザ版で書き出し、作品を変えてからパッチを作る。
 * 書き出しに時間がかかるので LIMINALIA_E2E_BROWSER=1 のときだけ。
 */

const LIM = resolve(import.meta.dirname, "../bin/lim.mjs");
const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
const e2e = !!process.env.LIMINALIA_E2E_BROWSER;

function lim(args: string[]) {
  const r = spawnSync(process.execPath, [LIM, ...args], { encoding: "utf8", timeout: 300_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("本体の比べ方", () => {
  // 前の書き出しはオフライン（既定でオン）か暗号化で Service Worker を入れ、比べるための書き出しは入れないので、差し込みを外して比べる
  const html = '<!doctype html>\n<html>\n<head>\n<script type="module" crossorigin src="./engine/index-abc.js"></script>\n</head>\n<body>\n<div id="app"></div>\n</body>\n</html>\n';
  it("オフラインの登録と、暗号化のときのエンジンの読み込みを外すと、元の index.html に戻る", () => {
    expect(withoutServiceWorker(injectServiceWorkerRegister(html))).toBe(html);
    expect(withoutServiceWorker(injectServiceWorkerLoader(html))).toBe(html);
    expect(withoutServiceWorker(html)).toBe(html);
  });
  it("作品が index.html に書いたほかのスクリプトは残す", () => {
    const own = html.replace("</body>", "<script>\nconsole.log(1);\n</script>\n</body>");
    expect(withoutServiceWorker(injectServiceWorkerRegister(own))).toBe(own);
  });
  // CSP は index.html の中のスクリプトを中身のハッシュで許すので、差し込みのハッシュも外して比べる（外さないと毎回「本体が違う」で止まっていた）
  const page = html.replace("<head>\n", '<head>\n<meta charset="utf-8" />\n');
  it("CSP から差し込みのスクリプトのハッシュだけを外す", () => {
    expect(withoutServiceWorker(injectCsp(injectServiceWorkerRegister(page), undefined))).toBe(injectCsp(page, undefined));
    expect(withoutServiceWorker(injectCsp(injectServiceWorkerLoader(page), undefined))).toBe(injectCsp(page, undefined));
    const own = page.replace("</body>", "<script>\nconsole.log(1);\n</script>\n</body>");
    const kept = withoutServiceWorker(injectCsp(injectServiceWorkerRegister(own), undefined));
    expect(kept).toBe(injectCsp(own, undefined));
    expect(kept).toContain("'sha256-");
  });
  it("CSP の設定（build.csp）が変わったら、違うものとして残る", () => {
    const wider = withoutServiceWorker(injectCsp(injectServiceWorkerRegister(page), { "connect-src": ["https://api.example.com"] }));
    expect(wider).not.toBe(injectCsp(page, undefined));
    expect(wider).toBe(injectCsp(page, { "connect-src": ["https://api.example.com"] }));
  });
});

describe.skipIf(!e2e)("lim patch", { timeout: 600_000 }, () => {
  let dir: string;
  let base: string;
  const config = () => join(dir, "liminalia.json");
  const edit = (file: string, f: (s: string) => string) => writeFileSync(file, f(readFileSync(file, "utf8")));
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "liminalia-patch-test-"));
    cpSync(TEMPLATE, join(dir, "game"), { recursive: true });
    dir = join(dir, "game");
    expect(lim(["build", dir, "browser", "--no-verify"]).code).toBe(0);
    base = join(dir, "..", "base");
    renameSync(join(dir, "dist"), base);
  });
  afterAll(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

  it("版を上げて本文・キャスト・素材を変えると、変わったものだけのパックを作る", () => {
    edit(config(), (s) => s.replace('"version": "1.0.0"', '"version": "1.0.1"'));
    edit(join(dir, "scenario", "start.lim"), (s) => s.replace("小さな天文台がある。", "直した天文台がある。"));
    edit(join(dir, "cast.json"), (s) => s.replace('"アカリ": {', '"アカリ": {\n      "color": "#e05a7a",'));
    cpSync(join(dir, "assets/bgimage/hill_morning.webp"), join(dir, "assets/bgimage/hill_dusk.webp"));
    const r = lim(["patch", dir, "--base", base]);
    expect(r.code, r.out).toBe(0);
    const out = join(dir, "dist/patches/patch-1_0_1");
    const pack = JSON.parse(readFileSync(join(out, "pack.json"), "utf8"));
    expect(pack).toMatchObject({ id: "patch-1_0_1", version: "1.0.1", requires: "1.0.0", files: { scenario: ["start"], data: [], assets: ["bgimage/hill_dusk.webp"], cast: true } });
    expect(readFileSync(join(out, "scenario/start.lim"), "utf8")).toContain("直した天文台");
    expect(existsSync(join(dir, "dist/patches/patch-1_0_1-browser.zip"))).toBe(true);
  });

  it("本体の設定（liminalia.json の ui）が変わったら止め、--force なら中身だけで作る", () => {
    edit(config(), (s) => s.replace('"titleScreen": true', '"titleScreen": true, "ui": { "text": { "size": 30 } }'));
    const r = lim(["patch", dir, "--base", base, "--id", "fix2"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("本体");
    expect(lim(["patch", dir, "--base", base, "--id", "fix2", "--force"]).code).toBe(0);
    expect(existsSync(join(dir, "dist/patches/fix2/pack.json"))).toBe(true);
  });
});
