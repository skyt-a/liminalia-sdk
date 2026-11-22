import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { entitlementsPlist, hasIdentity, macSigning, maskNotaryArgs, notaryIssues, notarySubmitArgs, parseNotaryResult } from "../src/sign/mac.ts";
import { DEFAULT_TIMESTAMP, parseSignCommand, signCommand, windowsSigning } from "../src/sign/windows.ts";
import { wrapCommand } from "../src/commands/build.ts";

describe("Windows の実行ファイルを包むコマンド（build.windows.wrap）", () => {
  it("{file} のあるコマンドを使い、環境変数が優先する（off なら行わない）", () => {
    expect(wrapCommand(["drm", "{file}"], {})).toEqual(["drm", "{file}"]);
    expect(wrapCommand(["drm", "{file}"], { LIMINALIA_WIN_WRAP_COMMAND: "other --in {file}" })).toEqual(["other", "--in", "{file}"]);
    expect(wrapCommand(["drm", "{file}"], { LIMINALIA_WIN_WRAP_COMMAND: "off" })).toBeNull();
    expect(wrapCommand(undefined, {})).toBeNull();
    expect(() => wrapCommand(["drm"], {})).toThrow(/\{file\}/);
  });
});

describe("Mac 版の署名と公証（build.mac）", () => {
  it("署名の名前が無いか - ならアドホック署名のまま（null）", () => {
    expect(macSigning(undefined, "/p", {})).toBeNull();
    expect(macSigning({ signIdentity: "-" }, "/p", {})).toBeNull();
  });

  it("環境変数の署名の名前が設定より優先し、公証の資格はキーチェーンのプロファイル → API キー → Apple ID の順", () => {
    const s = macSigning({ signIdentity: "Developer ID Application: A (TEAM1)", notaryProfile: "conf" }, "/p", { LIMINALIA_MAC_SIGN_IDENTITY: "Developer ID Application: B (TEAM2)" });
    expect(s).toEqual({ identity: "Developer ID Application: B (TEAM2)", entitlements: null, notary: { kind: "profile", profile: "conf" } });
    const key = macSigning({ signIdentity: "X" }, "/p", { LIMINALIA_NOTARY_KEY: "/k/AuthKey.p8", LIMINALIA_NOTARY_KEY_ID: "KID", LIMINALIA_NOTARY_ISSUER: "ISS" });
    expect(key?.notary).toEqual({ kind: "api-key", key: "/k/AuthKey.p8", keyId: "KID", issuer: "ISS" });
    const apple = macSigning({ signIdentity: "X", entitlements: "e.plist" }, "/p", { LIMINALIA_NOTARY_APPLE_ID: "a@b", LIMINALIA_NOTARY_PASSWORD: "pw", LIMINALIA_NOTARY_TEAM_ID: "T" });
    expect(apple).toEqual({ identity: "X", entitlements: "/p/e.plist", notary: { kind: "apple-id", appleId: "a@b", password: "pw", teamId: "T" } });
    // 資格が無ければ署名だけ。notarize: false なら資格があっても公証しない
    expect(macSigning({ signIdentity: "X" }, "/p", {})?.notary).toBeNull();
    expect(macSigning({ signIdentity: "X", notaryProfile: "conf", notarize: false }, "/p", {})?.notary).toBeNull();
    expect(macSigning({ signIdentity: "X", notaryProfile: "conf" }, "/p", { LIMINALIA_NOTARIZE: "0" })?.notary).toBeNull();
  });

  it("API キーの資格が半端なら足りないものを知らせる", () => {
    expect(() => macSigning({ signIdentity: "X" }, "/p", { LIMINALIA_NOTARY_KEY_ID: "KID" })).toThrow(/LIMINALIA_NOTARY_KEY、LIMINALIA_NOTARY_ISSUER がありません/);
  });

  it("notarytool のコマンドを組み立て、ログではパスワードを伏せる", () => {
    const args = notarySubmitArgs("/w/App.zip", { kind: "apple-id", appleId: "a@b", password: "secret", teamId: "T" });
    expect(args).toEqual(["notarytool", "submit", "/w/App.zip", "--apple-id", "a@b", "--password", "secret", "--team-id", "T", "--wait", "--output-format", "json"]);
    expect(maskNotaryArgs(args)).not.toContain("secret");
    expect(notarySubmitArgs("/w/App.zip", { kind: "profile", profile: "conf" })).toEqual(["notarytool", "submit", "/w/App.zip", "--keychain-profile", "conf", "--wait", "--output-format", "json"]);
  });

  it("notarytool の結果とログを読む", () => {
    expect(parseNotaryResult('Conducting pre-submission checks...\n{"id":"abc","status":"Accepted","message":"Processing complete"}')).toEqual({ id: "abc", status: "Accepted", message: "Processing complete" });
    expect(parseNotaryResult("not json")).toEqual({});
    expect(notaryIssues(JSON.stringify({ statusSummary: "Archive contains critical validation errors", issues: [{ severity: "error", path: "App.zip/App.app/Contents/MacOS/App", message: "The binary is not signed." }] }))).toContain("The binary is not signed.");
  });

  it("entitlements は JIT を許し、Steam の部品があるときだけライブラリの検証を外す", () => {
    expect(entitlementsPlist({ thirdPartyLibraries: false })).toContain("com.apple.security.cs.allow-jit");
    expect(entitlementsPlist({ thirdPartyLibraries: false })).not.toContain("disable-library-validation");
    expect(entitlementsPlist({ thirdPartyLibraries: true })).toContain("com.apple.security.cs.disable-library-validation");
  });

  it("キーチェーンの証明書の一覧から、名前か SHA-1 で探す", () => {
    const out = '  1) 2D54FEE3E86251486AFC17D3456164CA897D6DB6 "Developer ID Application: Example (ABCDE12345)"\n     1 valid identities found\n';
    expect(hasIdentity(out, "Developer ID Application: Example (ABCDE12345)")).toBe(true);
    expect(hasIdentity(out, "2d54fee3e86251486afc17d3456164ca897d6db6")).toBe(true);
    expect(hasIdentity(out, "Developer ID Application: Example")).toBe(false);
  });
});

describe("Windows 版の署名（build.windows.sign）", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "liminalia-sign-test-"));
    writeFileSync(join(dir, "cert.pfx"), "x");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const found = () => "/opt/homebrew/bin/osslsigncode";
  const none = () => null;

  it("書かなければ署名しない", () => {
    expect(windowsSigning(undefined, dir, { env: {}, findTool: found })).toBeNull();
  });

  it("Mac と Linux では osslsigncode、Windows では signtool で署名する", () => {
    const mac = windowsSigning({ pfx: "cert.pfx" }, dir, { env: { LIMINALIA_WIN_PFX_PASSWORD: "pw" }, platform: "darwin", findTool: found });
    expect(mac).toEqual({ signer: { kind: "osslsigncode", tool: "/opt/homebrew/bin/osslsigncode", pfx: join(dir, "cert.pfx"), passwordEnv: "LIMINALIA_WIN_PFX_PASSWORD", timestamp: DEFAULT_TIMESTAMP }, problem: null, ifMissing: "fail" });
    const c = signCommand(mac!.signer!, "/out/Game.exe", { name: "星を待つ丘", passwordFile: "/tmp/pass", out: "/out/Game.exe.signed" });
    expect(c).toEqual({ cmd: "/opt/homebrew/bin/osslsigncode", args: ["sign", "-pkcs12", join(dir, "cert.pfx"), "-readpass", "/tmp/pass", "-n", "星を待つ丘", "-h", "sha256", "-ts", DEFAULT_TIMESTAMP, "-in", "/out/Game.exe", "-out", "/out/Game.exe.signed"] });
    // パスワードはコマンドの引数に出さない（ファイルで渡す）
    expect(c.args).not.toContain("pw");
    const win = windowsSigning({ pfx: "cert.pfx", passwordEnv: "MY_PW", timestampUrl: "http://ts.example" }, dir, { env: { MY_PW: "pw" }, platform: "win32", findTool: () => "C:\\signtool.exe" });
    expect(signCommand(win!.signer!, "C:\\out\\Game.exe", { name: "Game", password: "pw" }).args).toEqual(["sign", "/f", join(dir, "cert.pfx"), "/p", "pw", "/fd", "SHA256", "/tr", "http://ts.example", "/td", "SHA256", "/d", "Game", "C:\\out\\Game.exe"]);
  });

  it("環境変数の証明書が設定より優先する", () => {
    writeFileSync(join(dir, "other.pfx"), "x");
    const s = windowsSigning({ pfx: "cert.pfx" }, dir, { env: { LIMINALIA_WIN_PFX: join(dir, "other.pfx"), LIMINALIA_WIN_PFX_PASSWORD: "" }, platform: "linux", findTool: found });
    expect(s?.signer).toMatchObject({ pfx: join(dir, "other.pfx") });
  });

  it("道具・証明書・パスワードが無ければ理由を返し、ifMissing で止めるか続けるかを選ぶ", () => {
    const noTool = windowsSigning({ pfx: "cert.pfx", ifMissing: "skip" }, dir, { env: { LIMINALIA_WIN_PFX_PASSWORD: "pw" }, platform: "darwin", findTool: none });
    expect(noTool?.signer).toBeNull();
    expect(noTool?.ifMissing).toBe("skip");
    expect(noTool?.problem).toMatch(/osslsigncode が見つかりません.*brew install osslsigncode/);
    expect(windowsSigning({ pfx: "cert.pfx" }, dir, { env: {}, platform: "darwin", findTool: found })?.problem).toMatch(/LIMINALIA_WIN_PFX_PASSWORD/);
    expect(windowsSigning({ pfx: "missing.pfx" }, dir, { env: { LIMINALIA_WIN_PFX_PASSWORD: "pw" }, platform: "darwin", findTool: found })?.problem).toMatch(/missing\.pfx がありません/);
  });

  it("外部の署名コマンドは {file} を置き換えて実行する（環境変数が優先。JSON の配列か空白区切り）", () => {
    const s = windowsSigning({ command: ["jsign", "--storetype", "TRUSTEDSIGNING", "{file}"] }, dir, { env: {}, findTool: none });
    expect(signCommand(s!.signer!, "/out/Setup.exe", { name: "Game" })).toEqual({ cmd: "jsign", args: ["--storetype", "TRUSTEDSIGNING", "/out/Setup.exe"] });
    const env = windowsSigning(undefined, dir, { env: { LIMINALIA_WIN_SIGN_COMMAND: '["AzureSignTool", "sign", "-kvu", "https://v.example", "{file}"]' }, findTool: none });
    expect(env?.signer).toEqual({ kind: "command", command: ["AzureSignTool", "sign", "-kvu", "https://v.example", "{file}"] });
    expect(parseSignCommand("my-sign --file {file}")).toEqual(["my-sign", "--file", "{file}"]);
    expect(() => windowsSigning({ command: ["jsign"] }, dir, { env: {} })).toThrow(/\{file\}/);
  });
});
