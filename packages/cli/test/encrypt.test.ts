import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptBuffer, encryptAsset, encryptAssetFile, encryptContent, encryptionKey, hashFile, injectServiceWorkerLoader, injectServiceWorkerRegister, isEncrypted, keyFromServiceWorker, precacheAtInstall, serviceWorkerSource, SERVICE_WORKER } from "../src/encrypt.ts";
import { runPack } from "../src/commands/pack.ts";

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-encrypt-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("暗号化", () => {
  it("書き出しの暗号は WebCrypto の AES-CTR（カウンター 128 ビット）で戻せる（ブラウザ版の Service Worker と同じ戻し方）", async () => {
    const key = Buffer.alloc(32, 7);
    // カウンターの下の桁があふれる IV でも、Node と同じに戻ること
    const data = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
    const enc = encryptAsset(data, key);
    enc.fill(0xff, 4, 20);
    const { createCipheriv } = await import("node:crypto");
    const c = createCipheriv("aes-256-ctr", key, enc.subarray(4, 20));
    const fixed = Buffer.concat([enc.subarray(0, 20), c.update(data), c.final()]);
    const k = await crypto.subtle.importKey("raw", key, "AES-CTR", false, ["decrypt"]);
    const back = Buffer.from(await crypto.subtle.decrypt({ name: "AES-CTR", counter: fixed.subarray(4, 20), length: 128 }, k, fixed.subarray(20)));
    expect(back.equals(data)).toBe(true);
    expect(decryptBuffer(fixed, key).equals(data)).toBe(true);
  });

  it("IV は鍵、名前、中身で決まる（書き出すたびに同じ。名前か中身が違えば別の IV）。読む側は IV をファイルから読む", () => {
    const key = Buffer.alloc(32, 3);
    const data = Buffer.from("同じ中身");
    const a = encryptAsset(data, key, "bgimage/a.png");
    expect(encryptAsset(data, key, "bgimage/a.png").equals(a)).toBe(true);
    const iv = (b: Buffer) => b.subarray(4, 20).toString("hex");
    expect(iv(encryptAsset(data, key, "bgimage/b.png"))).not.toBe(iv(a));
    expect(iv(encryptAsset(Buffer.from("違う中身"), key, "bgimage/a.png"))).not.toBe(iv(a));
    expect(iv(encryptAsset(data, Buffer.alloc(32, 4), "bgimage/a.png"))).not.toBe(iv(a));
    expect(decryptBuffer(a, key).equals(data)).toBe(true);
    // フォルダごと暗号にしても、同じ中身なら二度とも同じ
    const once = join(dir, "once");
    const twice = join(dir, "twice");
    for (const d of [once, twice]) {
      mkdirSync(join(d, "scenario"), { recursive: true });
      writeFileSync(join(d, "scenario", "a.lim"), "本文");
      writeFileSync(join(d, "scenario", "b.lim"), "本文");
      encryptContent(d, key, true);
    }
    expect(readFileSync(join(once, "scenario", "a.lim")).equals(readFileSync(join(twice, "scenario", "a.lim")))).toBe(true);
    // 中身が同じでも名前が違えば、暗号にしたものは違う
    expect(readFileSync(join(once, "scenario", "a.lim")).equals(readFileSync(join(once, "scenario", "b.lim")))).toBe(false);
  });

  it("二重には暗号にせず、pack.json はそのまま", () => {
    const key = Buffer.alloc(32, 1);
    mkdirSync(join(dir, "scenario"), { recursive: true });
    writeFileSync(join(dir, "scenario", "a.lim"), "本文");
    writeFileSync(join(dir, "pack.json"), "{}");
    encryptContent(dir, key, true);
    const once = readFileSync(join(dir, "scenario", "a.lim"));
    encryptContent(dir, key, true);
    expect(readFileSync(join(dir, "scenario", "a.lim")).equals(once)).toBe(true);
    expect(decryptBuffer(once, key).toString()).toBe("本文");
    expect(readFileSync(join(dir, "pack.json"), "utf8")).toBe("{}");
  });

  it("ブラウザ版の鍵はデスクトップ版と別に控え、Service Worker から読み戻せる", () => {
    const desktop = encryptionKey(dir);
    const browser = encryptionKey(dir, "browser");
    expect(browser.equals(desktop)).toBe(false);
    expect(encryptionKey(dir, "browser").equals(browser)).toBe(true);
    writeFileSync(join(dir, SERVICE_WORKER), serviceWorkerSource(browser));
    expect(keyFromServiceWorker(dir)?.equals(browser)).toBe(true);
  });

  it("オフラインだけの Service Worker は鍵を持たず、控えるものを持つ。index.html は読み終えてから入れる（エンジンは待たない）", () => {
    const offline = { cache: "lm-g-1", prefix: "lm-g-", precache: ["./", "index.html", "engine/index-abc.js"] };
    const sw = serviceWorkerSource(null, offline);
    expect(sw).toContain("const KEY = null;");
    expect(sw).toContain(`const OFFLINE = ${JSON.stringify(offline)};`);
    writeFileSync(join(dir, SERVICE_WORKER), sw);
    expect(keyFromServiceWorker(dir)).toBeNull();
    // 暗号化とオフラインは一つの Service Worker
    const both = serviceWorkerSource(encryptionKey(dir, "browser"), offline);
    expect(both).toMatch(/const KEY = "[A-Za-z0-9+/=]+";/);
    expect(both).toContain("const OFFLINE = {");
    const html = '<head>\n<script type="module" crossorigin src="./engine/index-abc.js"></script>\n</head><body></body>';
    const out = injectServiceWorkerRegister(html);
    expect(out).toContain('<script type="module" crossorigin src="./engine/index-abc.js"></script>');
    expect(out).toContain('register("./lm-sw.js")');
    // 入れられなかったら（https でない、容量が無いなど）黙らずに記録に残す
    expect(out).toContain('.catch(function (e) { console.warn("Service Worker を入れられませんでした');
  });

  it("入れたときに控えるのは、エンジン、台本、データ。素材、zip、Service Worker 自身、書体の分割ファイルは使ったときに控える", () => {
    const files = [
      "index.html",
      "lm-sw.js",
      "engine/index-abc.js",
      "engine/index-abc.css",
      "engine/noto-serif-jp-japanese-400-normal-a1.woff2",
      "engine/noto-serif-jp-japanese-400-normal-a1.woff",
      "engine/files/Font-Bold.TTF",
      "engine/files/x.otf",
      "project/start.lim",
      "project/build.json",
      "assets/bgimage/hill.webp",
      "assets/fonts/title.woff2",
      "game.zip",
    ];
    expect(files.filter(precacheAtInstall)).toEqual(["index.html", "engine/index-abc.js", "engine/index-abc.css", "project/start.lim", "project/build.json"]);
  });

  it("index.html は Service Worker を入れてからエンジンを読む", () => {
    const html = '<head>\n<script type="module" crossorigin src="./engine/index-abc.js"></script>\n</head>';
    const out = injectServiceWorkerLoader(html);
    expect(out).not.toContain('<script type="module"');
    expect(out).toContain('var src = "./engine/index-abc.js"');
    expect(out).toContain('register("./lm-sw.js")');
    expect(() => injectServiceWorkerLoader("<head></head>")).toThrow();
  });

  it("lim pack は build.encrypt の作品のパックをデスクトップ版の鍵で暗号にし、--encrypt off で止める", async () => {
    cpSync(TEMPLATE, dir, { recursive: true });
    const config = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as { build?: Record<string, unknown> };
    config.build = { encrypt: true };
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify(config));
    mkdirSync(join(dir, "packs", "dlc1", "scenario"), { recursive: true });
    writeFileSync(join(dir, "packs", "dlc1", "pack.json"), JSON.stringify({ id: "dlc1", version: "1.0.0" }));
    writeFileSync(join(dir, "packs", "dlc1", "scenario", "extra.lim"), "おまけの本文\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await runPack(dir, "packs/dlc1", join(dir, "out1"))).toBe(true);
      expect(await runPack(dir, "packs/dlc1", join(dir, "out2"), { encrypt: "off" })).toBe(true);
    } finally {
      log.mockRestore();
    }
    const enc = readFileSync(join(dir, "out1", "scenario", "extra.lim"));
    expect(isEncrypted(enc)).toBe(true);
    expect(decryptBuffer(enc, encryptionKey(dir)).toString()).toBe("おまけの本文\n");
    expect(JSON.parse(readFileSync(join(dir, "out1", "pack.json"), "utf8")).id).toBe("dlc1");
    expect(readFileSync(join(dir, "out2", "scenario", "extra.lim"), "utf8")).toBe("おまけの本文\n");
  });
});

describe("少しずつ読む暗号化（大きな素材を丸ごとメモリに持たない）", () => {
  it("encryptAssetFile は encryptAsset と同じ中身を書き、読む区切りをまたぐ大きさでも戻せる", () => {
    const dir = mkdtempSync(join(tmpdir(), "liminalia-encrypt-file-"));
    try {
      const key = Buffer.alloc(32, 9);
      // 読む区切り（4MB）をまたぐ大きさと、空のファイル
      for (const size of [0, 1, 4 * 1024 * 1024 + 123]) {
        const data = Buffer.alloc(size);
        for (let i = 0; i < size; i++) data[i] = (i * 31 + 7) & 0xff;
        const from = join(dir, `a-${size}.bin`);
        const to = join(dir, `b-${size}.bin`);
        writeFileSync(from, data);
        encryptAssetFile(from, to, key, "bgimage/a.png");
        expect(readFileSync(to).equals(encryptAsset(data, key, "bgimage/a.png"))).toBe(true);
        expect(decryptBuffer(readFileSync(to), key).equals(data)).toBe(true);
        expect(hashFile(from, "sha256").equals(createHash("sha256").update(data).digest())).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
