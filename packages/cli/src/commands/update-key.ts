import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadProject } from "@liminalia/project";
import { updateModule } from "../update.ts";

/**
 * lim update-key [プロジェクト] [--out <秘密鍵.pem>] [--force] — アップデートのマニフェストに署名する鍵の組（Ed25519）を作る。
 * 秘密鍵は既定で ~/.liminalia/update-keys/<作品の id>.pem（本人だけが読める。作品のフォルダや版の管理には入れない）。
 * 公開鍵は liminalia.json の build.update.publicKey に書く（ゲームに入り、署名の通ったマニフェストだけを使うようになる）。
 */
export function defaultKeyPath(id: string): string {
  return join(homedir(), ".liminalia", "update-keys", `${id.replace(/[^A-Za-z0-9_.-]/g, "_")}.pem`);
}

export function runUpdateKey(dir: string, o: { out?: string; force?: boolean }): boolean {
  const project = loadProject(dir);
  const file = resolve(o.out ?? defaultKeyPath(project.config.id));
  if (existsSync(file) && !o.force) {
    console.error(`${file} はもうあります。鍵を作り直すと、前の公開鍵を入れて配ったゲームが新しいマニフェストを受けなくなります（作り直すなら --force）`);
    return false;
  }
  if (file.startsWith(project.root + "/")) console.warn("警告: 秘密鍵をプロジェクトフォルダの中に置きます。バージョン管理（git など）に含めないでください");
  const { privateKeyPem, publicKey } = updateModule.generateSigningKey();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, privateKeyPem, { mode: 0o600 });
  chmodSync(file, 0o600);
  console.log(`秘密鍵: ${file}（本人だけが読める。なくすと同じ公開鍵で署名できなくなるので、ほかの秘密と同じく控えてください）`);
  console.log(`公開鍵: ${publicKey}\n`);
  console.log("liminalia.json に公開鍵を書いて書き出すと、ゲームは署名の通ったマニフェストだけを使います:");
  console.log(`  "build": { "update": { "url": "https://…/update.json", "publicKey": ${JSON.stringify(publicKey)} } }`);
  console.log("\nマニフェストを作るときに秘密鍵を渡します:");
  console.log(`  lim update-manifest --base-url https://…/ --sign-key ${JSON.stringify(file)}   （か環境変数 LIMINALIA_UPDATE_SIGN_KEY）`);
  return true;
}
