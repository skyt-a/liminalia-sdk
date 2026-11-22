import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, writeFileSync, writeSync } from "node:fs";
import { join, posix, relative, sep, win32 } from "node:path";
import { getRawHeader } from "@electron/asar";
import { flipFuses, FuseState, FuseV1Options, FuseVersion, getCurrentFuseWire } from "@electron/fuses";
import { NtExecutable, NtExecutableResource } from "resedit";

/**
 * 書き出したゲーム（と制作アプリ）の Electron の Fuses。Electron の実行ファイルに焼き込まれた機能の切り替えで、
 * 組み立てたあと、署名の前に切る（切ると実行ファイルが変わるので、署名はその後）。
 *
 * - RunAsNode: ELECTRON_RUN_AS_NODE で、ゲームの実行ファイルをただの Node として動かせる（ゲームを踏み台にされる）
 * - EnableNodeOptionsEnvironmentVariable: NODE_OPTIONS でコードを差し込める
 * - EnableNodeCliInspectArguments: --inspect で中を調べられる（暗号の鍵も取れる）
 * - EnableEmbeddedAsarIntegrityValidation: app.asar（と assets.asar）が書き換えられていたら起動しない（Mac と Windows）
 * - OnlyLoadAppFromAsar: app.asar からだけ読む（resources/app のフォルダを置いて差し替えられない）
 */

/** 書き出しが切り替える Fuses の名前（Electron の FuseV1Options の名前）。 */
export const GAME_FUSE_NAMES = ["RunAsNode", "EnableNodeOptionsEnvironmentVariable", "EnableNodeCliInspectArguments", "EnableEmbeddedAsarIntegrityValidation", "OnlyLoadAppFromAsar"] as const;
export type GameFuseName = (typeof GAME_FUSE_NAMES)[number];
export type GameFuses = Record<GameFuseName, boolean>;

/**
 * 書き出すゲームの Fuses。Node として動かす口（RunAsNode、NODE_OPTIONS、--inspect）は切り、app.asar に入れるなら
 * app.asar からだけ読み、Mac と Windows では asar の完全性を確かめる。overrides（build.desktop.fuses）で一つずつ替えられる。
 * asar に入れない（build.asar が false）のに asar の Fuses を入れようとしたら、起動できないので理由を返す。
 */
export function gameFuses(o: { platform: "darwin" | "win32" | "linux"; asar: boolean; overrides?: Partial<Record<string, boolean>> }): { fuses: GameFuses; problem: string | null } {
  const fuses: GameFuses = {
    RunAsNode: false,
    EnableNodeOptionsEnvironmentVariable: false,
    EnableNodeCliInspectArguments: false,
    // Linux の Electron は asar の完全性を確かめない
    EnableEmbeddedAsarIntegrityValidation: o.asar && o.platform !== "linux",
    OnlyLoadAppFromAsar: o.asar,
  };
  for (const [name, value] of Object.entries(o.overrides ?? {})) {
    if (!(GAME_FUSE_NAMES as readonly string[]).includes(name)) return { fuses, problem: `build.desktop.fuses の ${name} は切り替えられません（${GAME_FUSE_NAMES.join("、")}）` };
    if (typeof value !== "boolean") return { fuses, problem: `build.desktop.fuses の ${name} は true か false で書きます` };
    fuses[name as GameFuseName] = value;
  }
  if (!o.asar && (fuses.OnlyLoadAppFromAsar || fuses.EnableEmbeddedAsarIntegrityValidation)) return { fuses, problem: "build.asar が false のときは、build.desktop.fuses の OnlyLoadAppFromAsar と EnableEmbeddedAsarIntegrityValidation を true にできません" };
  return { fuses, problem: null };
}

/**
 * Fuses を焼き込む。electron は Mac なら .app、Windows なら .exe、Linux なら実行ファイル。
 * Mac の universal（二つの CPU の実行ファイルを一つにしたもの）は、両方に焼き込む。
 */
export async function applyFuses(electron: string, fuses: Partial<GameFuses>): Promise<void> {
  const config: Record<number, boolean> = {};
  for (const [name, value] of Object.entries(fuses)) if (value !== undefined) config[FuseV1Options[name as GameFuseName]] = value;
  await flipFuses(electron, { version: FuseVersion.V1, ...config });
}

/** 焼き込まれた Fuses（名前 → 有効か）。確かめに使う。 */
export async function readFuses(electron: string): Promise<Partial<Record<GameFuseName, boolean>>> {
  const wire = (await getCurrentFuseWire(electron)) as unknown as Record<number, FuseState>;
  const out: Partial<Record<GameFuseName, boolean>> = {};
  for (const name of GAME_FUSE_NAMES) {
    const state = wire[FuseV1Options[name]];
    if (state === FuseState.ENABLE || state === FuseState.DISABLE) out[name] = state === FuseState.ENABLE;
  }
  return out;
}

/** asar の頭（中身の一覧）の SHA-256。Electron が起動するときに比べる値（@electron/packager と同じ）。 */
export function asarHeaderHash(asar: string): string {
  return createHash("sha256").update(getRawHeader(asar).headerString).digest("hex");
}

// ---- Mac: Info.plist の ElectronAsarIntegrity と、Electron Framework の中の要約 ----

/** Electron 41 から、Info.plist の ElectronAsarIntegrity の要約を Electron Framework の中に置く（書き換えを見抜く）。その印。 */
const DIGEST_SENTINEL = Buffer.from("AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A");

type MacIntegrity = Record<string, { algorithm: string; hash: string }>;

/** ElectronAsarIntegrity の要約（Electron の integrity_digest.mm と同じ。名前の順に、名前、方式、ハッシュを続けて SHA-256）。 */
export function macIntegrityDigest(integrity: MacIntegrity): Buffer {
  const h = createHash("sha256");
  for (const key of Object.keys(integrity).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    h.update(key);
    h.update(integrity[key]!.algorithm);
    h.update(integrity[key]!.hash);
  }
  return h.digest();
}

/** ファイルの中の印の位置（universal なら二つ）。 */
function findAll(file: string, needle: Buffer): number[] {
  const data = readFileSync(file);
  const out: number[] = [];
  for (let at = data.indexOf(needle); at !== -1; at = data.indexOf(needle, at + 1)) out.push(at);
  return out;
}

/** Electron Framework の中の要約の置き場（印の後ろ: 使う 1 バイト、版 1 バイト、要約 32 バイト）を読む。 */
function readDigestSlots(framework: string): { at: number; used: number; version: number; digest: Buffer }[] {
  const fd = openSync(framework, "r");
  try {
    return findAll(framework, DIGEST_SENTINEL).map((at) => {
      const slot = Buffer.alloc(34);
      readSync(fd, slot, 0, 34, at + DIGEST_SENTINEL.length);
      return { at, used: slot[0]!, version: slot[1]!, digest: slot.subarray(2) };
    });
  } finally {
    closeSync(fd);
  }
}

/**
 * Mac のアプリに、後から入れた asar（assets.asar）を完全性の一覧に足す。完全性を確かめる Fuse を入れると、
 * アプリの中の asar はすべて一覧に無いと起動しない（Electron の archive.cc）。
 * Info.plist の ElectronAsarIntegrity に足し、Electron Framework の中の要約を書き直す（@electron/packager が書いた要約が、
 * この計算と合うことを先に確かめる）。足せなければ理由を返す（そのときは完全性の Fuse を入れない）。
 */
export function addMacAsarIntegrity(app: string, asars: string[]): string | null {
  const plist = join(app, "Contents", "Info.plist");
  let integrity: MacIntegrity;
  try {
    integrity = JSON.parse(execFileSync("plutil", ["-extract", "ElectronAsarIntegrity", "json", "-o", "-", plist], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as MacIntegrity;
  } catch {
    // 無いことを理由の文にして返す
    return "Info.plist に app.asar の完全性（ElectronAsarIntegrity）がありません";
  }
  const framework = join(app, "Contents", "Frameworks", "Electron Framework.framework", "Electron Framework");
  const slots = readDigestSlots(framework);
  // 組み立てが書いた要約と、ここでの計算が合うこと（合わなければ書き直せない）
  const before = macIntegrityDigest(integrity);
  for (const s of slots) if (s.used === 1 && (s.version !== 1 || !s.digest.equals(before))) return "Electron Framework 内の整合性ハッシュが、このバージョンの書き出し計算と一致しません";
  for (const asar of asars) {
    const key = relative(join(app, "Contents"), asar).split(sep).join(posix.sep);
    const value = { algorithm: "SHA256", hash: asarHeaderHash(asar) };
    integrity[key] = value;
    spawnSync("/usr/libexec/PlistBuddy", ["-c", `Delete :ElectronAsarIntegrity:${key}`, plist], { stdio: "ignore" });
    for (const cmd of [`Add :ElectronAsarIntegrity:${key} dict`, `Add :ElectronAsarIntegrity:${key}:algorithm string ${value.algorithm}`, `Add :ElectronAsarIntegrity:${key}:hash string ${value.hash}`]) {
      execFileSync("/usr/libexec/PlistBuddy", ["-c", cmd, plist], { stdio: "ignore" });
    }
  }
  if (slots.length > 0) {
    const slot = Buffer.concat([Buffer.from([1, 1]), macIntegrityDigest(integrity)]);
    const fd = openSync(framework, "r+");
    try {
      for (const s of slots) writeSync(fd, slot, 0, slot.length, s.at + DIGEST_SENTINEL.length);
    } finally {
      closeSync(fd);
    }
  }
  return null;
}

// ---- Windows: 実行ファイルの資源 INTEGRITY/ELECTRONASAR ----

interface WindowsIntegrityEntry {
  file: string;
  alg: string;
  value: string;
}

/** Windows の実行ファイルの完全性の一覧（資源 INTEGRITY/ELECTRONASAR の JSON）。無ければ null。 */
export function windowsAsarIntegrity(exe: string): WindowsIntegrityEntry[] | null {
  const res = NtExecutableResource.from(NtExecutable.from(readFileSync(exe)));
  const entry = res.entries.find((e) => e.type === "INTEGRITY" && e.id === "ELECTRONASAR");
  return entry ? (JSON.parse(Buffer.from(entry.bin).toString("utf8")) as WindowsIntegrityEntry[]) : null;
}

/**
 * Windows の実行ファイルに、後から入れた asar（resources/assets.asar）を完全性の一覧に足す（@electron/packager が app.asar を書いた
 * 資源 INTEGRITY/ELECTRONASAR に並べる。Electron は実行ファイルのフォルダからの相対パスを小文字にして引く）。
 * 足せなければ理由を返す（そのときは完全性の Fuse を入れない）。
 */
export function addWindowsAsarIntegrity(exe: string, folder: string, asars: string[]): string | null {
  const executable = NtExecutable.from(readFileSync(exe));
  const res = NtExecutableResource.from(executable);
  const entry = res.entries.find((e) => e.type === "INTEGRITY" && e.id === "ELECTRONASAR");
  if (!entry) return "実行ファイルに app.asar の完全性（INTEGRITY の資源）がありません";
  const list = JSON.parse(Buffer.from(entry.bin).toString("utf8")) as WindowsIntegrityEntry[];
  for (const asar of asars) {
    const file = relative(folder, asar).split(sep).join(win32.sep);
    const at = list.findIndex((e) => e.file.toLowerCase() === file.toLowerCase());
    const item = { file, alg: "SHA256", value: asarHeaderHash(asar) };
    if (at === -1) list.push(item);
    else list[at] = item;
  }
  const json = Buffer.from(JSON.stringify(list), "utf8");
  entry.bin = json.buffer.slice(json.byteOffset, json.byteOffset + json.length);
  res.outputResource(executable);
  writeFileSync(exe, Buffer.from(executable.generate()));
  return null;
}
