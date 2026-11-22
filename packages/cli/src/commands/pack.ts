import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { buildPack, loadProject, type Project } from "@liminalia/project";
import { encryptContent, encryptionKey, type KeyKind } from "../encrypt.ts";

/**
 * lim pack [プロジェクト] <パックのフォルダ> [--out フォルダ] [--encrypt desktop|browser|off] — 追加の中身・修正（パック）を書き出す
 * （@liminalia/project の buildPack）。パックのフォルダ（作品の packs/<id>/。pack.json・scenario・data・assets）を out（既定 dist/packs/<id>）へ写し、
 * 中身の一覧と本体に重ねたフローチャートを足す。書き出したフォルダを、ゲームの packs/ （デスクトップ版は Resources/packs/）に置けば読み込む。
 *
 * 暗号化: 本体を暗号にして書き出す作品（build.encrypt）は、パックのシナリオ・データ・訳・キャスト・素材も同じ鍵で暗号にする
 * （pack.json はそのまま）。ブラウザ版だけを暗号にする作品（build.browser.encrypt）はブラウザ版の鍵。--encrypt で選び直せる。
 */
export type PackEncryption = KeyKind | "off";

/** 作品の設定から決まる、パックの暗号の既定（build.encrypt ならデスクトップ版の鍵、build.browser.encrypt だけならブラウザ版の鍵）。 */
export function defaultPackEncryption(project: Project): PackEncryption {
  const b = project.config.build;
  return b?.encrypt ? "desktop" : b?.browser?.encrypt ? "browser" : "off";
}

/** 書き出したパックのフォルダを暗号にする（off なら何もしない）。 */
export function encryptPack(project: Project, dest: string, how: PackEncryption): void {
  if (how === "off") return;
  encryptContent(dest, encryptionKey(project.root, how), true);
}

export async function runPack(dir: string, pack: string, out?: string, o: { encrypt?: PackEncryption } = {}): Promise<boolean> {
  const project = loadProject(dir);
  const packDir = resolve(project.root, pack);
  const manifest = JSON.parse(readFileSync(resolve(packDir, "pack.json"), "utf8")) as { id: string };
  const dest = resolve(out ?? resolve(project.paths.out, "packs", manifest.id));
  const r = await buildPack(project, packDir, dest);
  for (const p of r.problems) console.error(`  ${p}`);
  const how = o.encrypt ?? defaultPackEncryption(project);
  encryptPack(project, dest, how);
  const files = r.manifest.files!;
  const at = relative(process.cwd(), dest);
  console.log(
    how === "off"
      ? `${at}: ${r.manifest.id}（シナリオ ${files.scenario.length}、データ ${files.data.length}、素材 ${files.assets.length}）`
      : how === "desktop"
        ? `${at}: ${r.manifest.id}（シナリオ ${files.scenario.length}、データ ${files.data.length}、素材 ${files.assets.length}。デスクトップ版の鍵で暗号化）`
        : `${at}: ${r.manifest.id}（シナリオ ${files.scenario.length}、データ ${files.data.length}、素材 ${files.assets.length}。ブラウザ版の鍵で暗号化）`,
  );
  return r.problems.length === 0;
}
