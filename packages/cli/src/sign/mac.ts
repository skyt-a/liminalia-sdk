import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ProjectConfig } from "@liminalia/project";

/**
 * Mac 版の配布用の署名と公証（build.mac）。
 *
 * - 署名の名前（環境変数 LIMINALIA_MAC_SIGN_IDENTITY → build.mac.signIdentity）が無ければ今までどおりアドホック署名
 * - あれば @electron/osx-sign で内側（ヘルパーのアプリ・フレームワーク・ネイティブのライブラリ）から順に、hardened runtime と
 *   entitlements とタイムスタンプを付けて署名する
 * - 公証の資格（notarytool のキーチェーンのプロファイル、App Store Connect の API キー、Apple ID とアプリ用パスワード）が
 *   あれば、zip にして notarytool で送り、通ったら staple する
 */

type MacConfig = NonNullable<NonNullable<ProjectConfig["build"]>["mac"]>;
type Env = Record<string, string | undefined>;

/** 公証の資格。 */
export type NotaryCredentials =
  | { kind: "profile"; profile: string }
  | { kind: "api-key"; key: string; keyId: string; issuer: string }
  | { kind: "apple-id"; appleId: string; password: string; teamId: string };

export interface MacSigning {
  /** 署名の名前（"Developer ID Application: …"）か、証明書の SHA-1。 */
  identity: string;
  /** entitlements の plist（無ければ書き出しが作る）。 */
  entitlements: string | null;
  /** 公証の資格（無ければ署名だけ）。 */
  notary: NotaryCredentials | null;
}

/**
 * この書き出しの Mac 版の署名の設定。署名の名前が無いか "-"（アドホック）なら null。
 * 公証の資格が半端に書かれていたら（API キーの ID だけなど）理由を投げる。
 */
export function macSigning(cfg: MacConfig | undefined, root: string, env: Env = process.env): MacSigning | null {
  const identity = (env.LIMINALIA_MAC_SIGN_IDENTITY ?? cfg?.signIdentity ?? "").trim();
  if (identity === "" || identity === "-") return null;
  const entitlements = cfg?.entitlements ? resolve(root, cfg.entitlements) : null;
  const notarize = envBool(env.LIMINALIA_NOTARIZE) ?? cfg?.notarize ?? true;
  return { identity, entitlements, notary: notarize ? notaryCredentials(cfg, env) : null };
}

function envBool(v: string | undefined): boolean | undefined {
  const s = (v ?? "").trim().toLowerCase();
  if (s === "") return undefined;
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  throw new Error("LIMINALIA_NOTARIZE には true か false を指定してください");
}

/**
 * 公証の資格。キーチェーンのプロファイル（LIMINALIA_NOTARY_PROFILE → build.mac.notaryProfile）、API キー
 * （LIMINALIA_NOTARY_KEY・LIMINALIA_NOTARY_KEY_ID・LIMINALIA_NOTARY_ISSUER）、Apple ID（LIMINALIA_NOTARY_APPLE_ID・
 * LIMINALIA_NOTARY_PASSWORD・LIMINALIA_NOTARY_TEAM_ID）の順に探す。どれも無ければ null。
 */
export function notaryCredentials(cfg: MacConfig | undefined, env: Env = process.env): NotaryCredentials | null {
  const v = (name: string) => (env[name] ?? "").trim();
  const profile = v("LIMINALIA_NOTARY_PROFILE") || (cfg?.notaryProfile ?? "").trim();
  if (profile) return { kind: "profile", profile };
  const group = (names: string[], what: "api-key" | "apple-id") => {
    const values = names.map(v);
    if (values.every((x) => x === "")) return null;
    const missing = names.filter((_, i) => values[i] === "");
    if (missing.length > 0) {
      const all = names.join("、");
      const lacking = missing.join("、");
      throw new Error(what === "api-key" ? `公証の API キーには ${all} のすべてが要ります（${lacking} がありません）` : `公証の Apple ID には ${all} のすべてが要ります（${lacking} がありません）`);
    }
    return values;
  };
  const key = group(["LIMINALIA_NOTARY_KEY", "LIMINALIA_NOTARY_KEY_ID", "LIMINALIA_NOTARY_ISSUER"], "api-key");
  if (key) return { kind: "api-key", key: key[0]!, keyId: key[1]!, issuer: key[2]! };
  const apple = group(["LIMINALIA_NOTARY_APPLE_ID", "LIMINALIA_NOTARY_PASSWORD", "LIMINALIA_NOTARY_TEAM_ID"], "apple-id");
  if (apple) return { kind: "apple-id", appleId: apple[0]!, password: apple[1]!, teamId: apple[2]! };
  return null;
}

/** notarytool に渡す資格の引数。 */
export function notaryAuthArgs(c: NotaryCredentials): string[] {
  switch (c.kind) {
    case "profile":
      return ["--keychain-profile", c.profile];
    case "api-key":
      return ["--key", c.key, "--key-id", c.keyId, "--issuer", c.issuer];
    case "apple-id":
      return ["--apple-id", c.appleId, "--password", c.password, "--team-id", c.teamId];
  }
}

/** 公証に送るコマンド（xcrun notarytool submit … --wait）。結果は JSON で受ける。 */
export function notarySubmitArgs(file: string, c: NotaryCredentials): string[] {
  return ["notarytool", "submit", file, ...notaryAuthArgs(c), "--wait", "--output-format", "json"];
}

/** 出力のログに資格を出さない（パスワードと API キーのパスを伏せる）。 */
export function maskNotaryArgs(args: string[]): string[] {
  return args.map((a, i) => (["--password", "--key"].includes(args[i - 1] ?? "") ? "***" : a));
}

/**
 * Electron のアプリに要る entitlements（hardened runtime で JIT を使う。Steam の部品など、Apple 以外が署名した
 * ネイティブのライブラリを読むなら、ライブラリの検証を外す）。
 */
export function entitlementsPlist(o: { thirdPartyLibraries: boolean }): string {
  const keys = ["com.apple.security.cs.allow-jit", "com.apple.security.cs.allow-unsigned-executable-memory", ...(o.thirdPartyLibraries ? ["com.apple.security.cs.disable-library-validation"] : [])];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${keys.map((k) => `\t<key>${k}</key>\n\t<true/>`).join("\n")}
</dict>
</plist>
`;
}

/** security find-identity の出力に、その名前（か SHA-1）の有効な署名の証明書があるか。 */
export function hasIdentity(findIdentityOutput: string, identity: string): boolean {
  for (const line of findIdentityOutput.split("\n")) {
    const m = /^\s*\d+\)\s+([0-9A-F]{40})\s+"(.+)"/.exec(line);
    if (!m) continue;
    if (m[1] === identity.toUpperCase() || m[2] === identity) return true;
  }
  return false;
}

/** 書き出す前に確かめる（Mac であること、署名の証明書がキーチェーンにあること）。問題があれば理由。 */
export function checkMacSigning(s: MacSigning): string | null {
  if (process.platform !== "darwin") return "Mac 版の配布用の署名と公証は Mac でのみできます（環境変数 LIMINALIA_MAC_SIGN_IDENTITY を外すとアドホック署名で書き出します）";
  let out = "";
  try {
    out = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
  } catch {
    // security が使えなければ、証明書が無いことにして下で止める
    out = "";
  }
  if (!hasIdentity(out, s.identity)) return `署名の証明書「${s.identity}」がキーチェーンにありません（security find-identity -v -p codesigning で確かめてください）`;
  if (s.entitlements && !existsSync(s.entitlements)) return `entitlements のファイル ${s.entitlements} がありません`;
  if (s.notary?.kind === "api-key" && !existsSync(s.notary.key)) return `公証の API キーのファイル ${s.notary.key} がありません`;
  return null;
}

/** 実行ファイルかネイティブのライブラリ（Mach-O）か。 */
export function isMachO(file: string): boolean {
  const head = Buffer.alloc(4);
  const fd = openSync(file, "r");
  try {
    if (readSync(fd, head, 0, 4, 0) < 4) return false;
  } finally {
    closeSync(fd);
  }
  return ["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca"].includes(head.toString("hex"));
}

/**
 * osx-sign の ignore に渡す、Mach-O でないファイルを外す判定（フォルダ（.app、.framework）は署名する）。
 * osx-sign は既定で「テキストでないファイル」をすべて署名するので、画像や書体を node_modules に持つアプリは、これで実行できるものだけにする。
 */
export function notMachO(path: string): boolean {
  return !statSync(path).isDirectory() && !isMachO(path);
}

/** アプリに署名する（内側から順に。@electron/osx-sign）。ignore は署名しないファイルの判定。 */
export async function signMacApp(app: string, s: MacSigning, work: string, o: { thirdPartyLibraries: boolean; ignore?: (path: string) => boolean }): Promise<void> {
  let entitlements = s.entitlements;
  if (!entitlements) {
    entitlements = join(work, "entitlements.plist");
    mkdirSync(dirname(entitlements), { recursive: true });
    writeFileSync(entitlements, entitlementsPlist(o));
  }
  const { sign } = await import("@electron/osx-sign");
  const ent = entitlements;
  await sign({
    app,
    identity: s.identity,
    platform: "darwin",
    type: "distribution",
    // 証明書の確かめは checkMacSigning で済ませている（osx-sign は名前の一部での一致も受けるため）
    identityValidation: false,
    preAutoEntitlements: false,
    ...(o.ignore ? { ignore: o.ignore } : {}),
    // タイムスタンプは Apple の既定のサーバー（codesign --timestamp）
    optionsForFile: () => ({ hardenedRuntime: true, entitlements: ent }),
  });
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], { stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * 公証して staple する。zip にして送り、通らなければ notarytool のログの要点を出して投げる。
 * 時間がかかる（数分〜）ので、進み具合は log に出す。
 */
export function notarizeMacApp(app: string, c: NotaryCredentials, work: string, log: (line: string) => void = console.log): void {
  const zip = join(work, `${basename(app, ".app")}-notarize.zip`);
  mkdirSync(work, { recursive: true });
  execFileSync("ditto", ["-c", "-k", "--keepParent", app, zip]);
  const args = notarySubmitArgs(zip, c);
  log(`  公証に送信（xcrun ${maskNotaryArgs(args).join(" ")}）`);
  const r = spawnSync("xcrun", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const result = parseNotaryResult(r.stdout ?? "");
  if (r.status !== 0 || result.status !== "Accepted") {
    let detail = (r.stderr || r.stdout || "").trim();
    if (result.id) {
      const logR = spawnSync("xcrun", ["notarytool", "log", result.id, ...notaryAuthArgs(c)], { encoding: "utf8" });
      detail = notaryIssues(logR.stdout ?? "") || detail;
    }
    const why = result.id ? `${result.status ?? "失敗"}、ID ${result.id}` : (result.status ?? "失敗");
    throw new Error(`公証が通りませんでした（${why}）\n${detail.split("\n").slice(0, 30).join("\n")}`);
  }
  log(`  公証が通りました（ID ${result.id}）。staple`);
  execFileSync("xcrun", ["stapler", "staple", app], { stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("xcrun", ["stapler", "validate", app], { stdio: ["ignore", "pipe", "pipe"] });
  // Gatekeeper が通すか（ダウンロードしたものとして）
  const gate = spawnSync("spctl", ["--assess", "--type", "execute", "--verbose=2", app], { encoding: "utf8" });
  if (gate.status !== 0) throw new Error(`Gatekeeper の確認が通りません\n${(gate.stderr || gate.stdout).trim()}`);
}

/** notarytool submit --output-format json の結果。 */
export function parseNotaryResult(stdout: string): { id?: string; status?: string; message?: string } {
  try {
    const json = JSON.parse(stdout.trim().split("\n").filter((l) => l.trim().startsWith("{")).at(-1) ?? stdout) as { id?: string; status?: string; message?: string };
    return { ...(json.id ? { id: json.id } : {}), ...(json.status ? { status: json.status } : {}), ...(json.message ? { message: json.message } : {}) };
  } catch {
    // notarytool の出力が読めなければ空（呼ぶ側が出力のまま知らせる）
    return {};
  }
}

/** notarytool log の JSON から、通らなかった理由（ファイルとメッセージ）を並べる。 */
export function notaryIssues(logJson: string): string {
  try {
    const json = JSON.parse(logJson) as { issues?: { path?: string; message?: string; severity?: string }[] | null; statusSummary?: string };
    const issues = (json.issues ?? []).map((i) => `- ${i.severity ?? "error"}: ${i.path ?? ""}: ${i.message ?? ""}`);
    return [json.statusSummary ?? "", ...issues].filter(Boolean).join("\n");
  } catch {
    // 記録が読めなければ空（呼ぶ側が公証の結果だけを知らせる）
    return "";
  }
}
