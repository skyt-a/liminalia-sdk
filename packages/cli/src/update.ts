import { createRequire } from "node:module";
import { join } from "node:path";
import { desktopDir } from "./engine-paths.ts";

/**
 * デスクトップ版のアップデートの部品（packages/desktop/update.cjs）。書き出したゲームと同じものを、
 * lim update-manifest のマニフェストの確かめとテストに使う。
 */

export type Notes = string | Record<string, string>;
export interface UpdateFile {
  url: string;
  sha256: string;
  size?: number;
}
export interface UpdatePack extends UpdateFile {
  id: string;
  version: string;
  requires?: string;
  title?: string;
  notes?: Notes;
}
export interface UpdateManifest {
  format: "liminalia-update";
  formatVersion: 1;
  /** Ed25519 の署名（lim update-manifest --sign-key。signature を除いたものの canonicalJson に署名する）。 */
  signature?: { alg: "ed25519"; value: string };
  app?: { version: string; page?: string; notes?: Notes; files?: Partial<Record<"windows" | "mac" | "linux" | "mac-arm64" | "mac-x64", UpdateFile>> };
  packs?: UpdatePack[];
}
export interface UpdatePlan {
  app: { version: string; page?: string; notes?: Notes; file?: UpdateFile } | null;
  packs: UpdatePack[];
}

interface UpdateModule {
  FORMAT: "liminalia-update";
  canonicalJson(value: unknown): string;
  publicKeyFrom(text: string): unknown;
  generateSigningKey(): { privateKeyPem: string; publicKey: string };
  publicKeyOf(privateKeyPem: string): string;
  signManifest(manifest: UpdateManifest, privateKeyPem: string): UpdateManifest;
  verifyManifestSignature(json: unknown, publicKeys: string | string[] | undefined | null): { ok: boolean; problem: string | null };
  compareVersions(a: string, b: string): number;
  allowedUrl(url: string): boolean;
  validateManifest(json: unknown, base?: string): { manifest: UpdateManifest | null; problems: string[] };
  planUpdate(manifest: UpdateManifest, o: { appVersion: string; platform: "windows" | "mac" | "linux"; arch?: string; installed: Record<string, string> }): UpdatePlan;
  pickNotes(notes: Notes | undefined, language: string): string;
  sha256File(file: string): string;
  download(fetchImpl: typeof fetch, url: string, dest: string, expect: { sha256: string; size?: number }, onProgress?: (done: number, total: number) => void): Promise<string>;
  extractZip(zip: string, dir: string): number;
  safeEntryPath(name: string): string | null;
  installPack(zip: string, packsDir: string, id: string): { id: string; version?: string };
}

export const updateModule = createRequire(import.meta.url)(join(desktopDir(), "update.cjs")) as UpdateModule;
