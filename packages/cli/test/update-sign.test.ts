import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signIfAsked } from "../src/commands/update-manifest.ts";
import { runUpdateKey } from "../src/commands/update-key.ts";
import { updateFor } from "../src/commands/build.ts";
import { updateModule as u, type UpdateManifest } from "../src/update.ts";

const SHA = "a".repeat(64);
const manifest = (): UpdateManifest => ({ format: "liminalia-update", formatVersion: 1, app: { version: "1.1.0", files: { mac: { url: "https://example.com/g.zip", sha256: SHA, size: 3 } } } });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-update-sign-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("アップデートの一覧の署名（Ed25519）", () => {
  it("署名したものは公開鍵で通り、中身を一文字でも変えると通らない", () => {
    const { privateKeyPem, publicKey } = u.generateSigningKey();
    expect(u.publicKeyOf(privateKeyPem)).toBe(publicKey);
    const signed = u.signManifest(manifest(), privateKeyPem);
    expect(signed.signature?.alg).toBe("ed25519");
    // 鍵の並びや空白が違っても同じ中身なら通る（JSON にして読み直す）
    const reread = JSON.parse(JSON.stringify(signed, null, 2)) as UpdateManifest;
    expect(u.verifyManifestSignature(reread, publicKey)).toEqual({ ok: true, problem: null });
    const tampered = { ...reread, app: { ...reread.app!, version: "9.9.9" } };
    expect(u.verifyManifestSignature(tampered, [publicKey]).ok).toBe(false);
    expect(u.verifyManifestSignature(manifest(), publicKey).problem).toMatch(/署名（signature）がありません/);
    // 鍵の入れ替え: 前の鍵と新しい鍵を並べた版は、どちらの署名も受ける
    const next = u.generateSigningKey();
    expect(u.verifyManifestSignature(u.signManifest(manifest(), next.privateKeyPem), [publicKey, next.publicKey]).ok).toBe(true);
    expect(u.verifyManifestSignature(u.signManifest(manifest(), next.privateKeyPem), [publicKey]).ok).toBe(false);
    // 公開鍵を入れていないゲームは確かめない
    expect(u.verifyManifestSignature(manifest(), undefined).ok).toBe(true);
    // 署名を付けても、形の確かめは今までどおり通る
    expect(u.validateManifest(signed, "https://example.com/update.json").problems).toEqual([]);
  });

  it("lim update-manifest の署名: 公開鍵があるのに秘密鍵が無い・組にならないときは止める", () => {
    const a = u.generateSigningKey();
    const b = u.generateSigningKey();
    const key = join(dir, "a.pem");
    writeFileSync(key, a.privateKeyPem);
    expect(signIfAsked(manifest(), undefined, undefined).signature).toBeUndefined();
    expect(() => signIfAsked(manifest(), a.publicKey, undefined)).toThrow(/秘密鍵が要ります/);
    expect(() => signIfAsked(manifest(), b.publicKey, key)).toThrow(/組になっていません/);
    expect(u.verifyManifestSignature(signIfAsked(manifest(), a.publicKey, key), a.publicKey).ok).toBe(true);
  });

  it("lim update-key は本人だけが読める秘密鍵を作り、上書きしない", () => {
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ id: "g", title: "G", entry: "start" }));
    const out = join(dir, "..", `${dir.split("/").pop()}-key.pem`);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(runUpdateKey(dir, { out })).toBe(true);
      expect(statSync(out).mode & 0o777).toBe(0o600);
      const pub = String(log.mock.calls.find((c) => String(c[0]).startsWith("公開鍵: "))![0]).slice("公開鍵: ".length).trim();
      expect(u.publicKeyOf(readFileSync(out, "utf8"))).toBe(pub);
      expect(runUpdateKey(dir, { out })).toBe(false);
    } finally {
      log.mockRestore();
      err.mockRestore();
      rmSync(out, { force: true });
    }
  });

  it("書き出しは公開鍵を game.json に入れ、読めない鍵なら止める", () => {
    const { publicKey } = u.generateSigningKey();
    expect(updateFor({ url: "https://example.com/u.json", publicKey }, null, {})).toEqual({ url: "https://example.com/u.json", startup: true, publicKey: [publicKey] });
    expect(() => updateFor({ url: "https://example.com/u.json", publicKey: "short" }, null, {})).toThrow(/publicKey/);
  });
});
