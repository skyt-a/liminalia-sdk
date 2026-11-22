import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import type { WindowsSignConfig } from "@liminalia/project";

/**
 * Windows 版（実行ファイルとインストーラー）の Authenticode 署名（build.windows.sign）。
 *
 * - 証明書（PFX）とパスワード: Windows では signtool、Mac と Linux では osslsigncode で署名する
 * - 外部の署名コマンド（Azure Trusted Signing の jsign、AzureSignTool、ハードウェアトークンの道具など）: "{file}" を
 *   ファイルのパスに置き換えて実行する
 * - 道具が無いとき: ifMissing が "skip" なら理由を出して署名せずに続け、既定（"fail"）なら書き出しの前に止める
 */

type Env = Record<string, string | undefined>;

export const DEFAULT_TIMESTAMP = "http://timestamp.digicert.com";
export const DEFAULT_PASSWORD_ENV = "LIMINALIA_WIN_PFX_PASSWORD";

/** 署名のしかた。 */
export type WindowsSigner =
  | { kind: "signtool"; tool: string; pfx: string; passwordEnv: string; timestamp: string }
  | { kind: "osslsigncode"; tool: string; pfx: string; passwordEnv: string; timestamp: string }
  | { kind: "command"; command: string[] };

/** 書き出しの前に決める署名の設定。signer が無く problem があれば、道具か資格が足りない（ifMissing で止めるか続けるか）。 */
export interface WindowsSigning {
  signer: WindowsSigner | null;
  problem: string | null;
  ifMissing: "fail" | "skip";
}

/**
 * 環境変数 LIMINALIA_WIN_SIGN_COMMAND の値（JSON の文字列の配列か、空白で区切ったもの）。
 */
export function parseSignCommand(value: string): string[] {
  const v = value.trim();
  if (v.startsWith("[")) {
    const parsed = JSON.parse(v) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string") || parsed.length === 0) throw new Error("LIMINALIA_WIN_SIGN_COMMAND は文字列の配列（JSON）か、空白で区切ったコマンドで書きます");
    return parsed;
  }
  return v.split(/\s+/).filter(Boolean);
}

/**
 * この書き出しの署名の設定（署名しないなら null）。道具を探す（findTool は差し替えられる。テスト用）。
 */
export function windowsSigning(
  cfg: WindowsSignConfig | undefined,
  root: string,
  o: { env?: Env; platform?: NodeJS.Platform; findTool?: (name: "signtool" | "osslsigncode") => string | null } = {},
): WindowsSigning | null {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const find = o.findTool ?? ((name) => findSignTool(name, env, platform));
  const ifMissing = cfg?.ifMissing ?? "fail";
  const commandEnv = (env.LIMINALIA_WIN_SIGN_COMMAND ?? "").trim();
  const command = commandEnv ? parseSignCommand(commandEnv) : cfg?.command;
  if (command && command.length > 0) {
    if (!command.some((a) => a.includes("{file}"))) throw new Error('署名のコマンドには、署名するファイルの場所に "{file}" を書いてください');
    return { signer: { kind: "command", command }, problem: null, ifMissing };
  }
  const pfxRaw = (env.LIMINALIA_WIN_PFX ?? cfg?.pfx ?? "").trim();
  if (!pfxRaw) return null;
  const pfx = resolve(root, pfxRaw);
  const passwordEnv = cfg?.passwordEnv ?? DEFAULT_PASSWORD_ENV;
  const timestamp = cfg?.timestampUrl ?? DEFAULT_TIMESTAMP;
  if (!existsSync(pfx)) return { signer: null, problem: `証明書 ${pfx} がありません`, ifMissing };
  if (env[passwordEnv] === undefined) return { signer: null, problem: `証明書のパスワードを環境変数 ${passwordEnv} に設定してください`, ifMissing };
  const kind = platform === "win32" ? "signtool" : "osslsigncode";
  const tool = find(kind);
  if (!tool) {
    const how =
      kind === "signtool"
        ? "Windows SDK（Visual Studio Installer の「Windows SDK」）を入れるか、環境変数 LIMINALIA_SIGNTOOL で signtool.exe の場所を指定してください"
        : platform === "darwin"
          ? "brew install osslsigncode で入れるか、環境変数 LIMINALIA_OSSLSIGNCODE で場所を指定してください"
          : "apt install osslsigncode などで入れるか、環境変数 LIMINALIA_OSSLSIGNCODE で場所を指定してください";
    return { signer: null, problem: `Windows 版の署名に使う ${kind} が見つかりません。${how}`, ifMissing };
  }
  return { signer: { kind, tool, pfx, passwordEnv, timestamp }, problem: null, ifMissing };
}

/** 署名の道具を探す（環境変数 → PATH → よくある場所）。 */
export function findSignTool(name: "signtool" | "osslsigncode", env: Env = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const given = env[name === "signtool" ? "LIMINALIA_SIGNTOOL" : "LIMINALIA_OSSLSIGNCODE"];
  if (given) return existsSync(given) ? given : null;
  const exe = platform === "win32" ? `${name}.exe` : name;
  const candidates = (env.PATH ?? "").split(platform === "win32" ? ";" : delimiter).filter(Boolean).map((d) => join(d, exe));
  if (name === "osslsigncode") candidates.push("/opt/homebrew/bin/osslsigncode", "/usr/local/bin/osslsigncode", "/usr/bin/osslsigncode");
  if (name === "signtool" && platform === "win32") {
    // Windows SDK の bin/<版>/x64/signtool.exe（新しい版から）
    const kits = join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Windows Kits", "10", "bin");
    try {
      for (const v of readdirSync(kits).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) candidates.push(join(kits, v, "x64", "signtool.exe"));
    } catch {
      // SDK が無い
    }
  }
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * 署名のコマンド（実行するもの）。password はパスワードを書いたファイル（osslsigncode の -readpass）か値（signtool の /p）。
 * name と url は署名に入れる説明（エクスプローラーの「デジタル署名」と UAC の画面に出る）。
 */
export function signCommand(s: WindowsSigner, file: string, o: { name: string; url?: string; passwordFile?: string; password?: string; out?: string }): { cmd: string; args: string[] } {
  switch (s.kind) {
    case "command": {
      const [cmd, ...args] = s.command.map((a) => a.replaceAll("{file}", file));
      return { cmd: cmd!, args };
    }
    case "signtool":
      return {
        cmd: s.tool,
        args: ["sign", "/f", s.pfx, ...(o.password !== undefined ? ["/p", o.password] : []), "/fd", "SHA256", "/tr", s.timestamp, "/td", "SHA256", "/d", o.name, ...(o.url ? ["/du", o.url] : []), file],
      };
    case "osslsigncode":
      return {
        cmd: s.tool,
        args: ["sign", "-pkcs12", s.pfx, ...(o.passwordFile ? ["-readpass", o.passwordFile] : []), "-n", o.name, ...(o.url ? ["-i", o.url] : []), "-h", "sha256", "-ts", s.timestamp, "-in", file, "-out", o.out ?? `${file}.signed`],
      };
  }
}

/** ファイルに署名する（その場で差し替える）。 */
export function signWindowsFile(s: WindowsSigner, file: string, o: { name: string; url?: string; env?: Env }): void {
  const env = o.env ?? process.env;
  if (s.kind === "command") {
    const c = signCommand(s, file, o);
    execFileSync(c.cmd, c.args, { stdio: ["ignore", "pipe", "pipe"], env: env as NodeJS.ProcessEnv });
    return;
  }
  const password = env[s.passwordEnv] ?? "";
  if (s.kind === "signtool") {
    const c = signCommand(s, file, { ...o, password });
    execFileSync(c.cmd, c.args, { stdio: ["ignore", "pipe", "pipe"] });
    return;
  }
  // osslsigncode: パスワードはコマンドの引数に出さず、本人だけが読めるファイルで渡す
  const dir = mkdtempSync(join(tmpdir(), "liminalia-sign-"));
  try {
    const passwordFile = join(dir, "pass");
    writeFileSync(passwordFile, password, { mode: 0o600 });
    chmodSync(passwordFile, 0o600);
    // 署名したものは同じフォルダに書いてから差し替える（別のドライブへは名前の変更で動かせないため）
    const out = `${file}.signed`;
    const c = signCommand(s, file, { ...o, passwordFile, out });
    try {
      execFileSync(c.cmd, c.args, { stdio: ["ignore", "pipe", "pipe"] });
      renameSync(out, file);
    } finally {
      rmSync(out, { force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 署名の失敗を読める形に（道具の出力の要点）。 */
export function signError(e: unknown): string {
  const err = e as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
  const text = `${err.stderr?.toString() ?? ""}${err.stdout?.toString() ?? ""}`.trim() || err.message || String(e);
  return text.split("\n").slice(0, 15).join("\n");
}
