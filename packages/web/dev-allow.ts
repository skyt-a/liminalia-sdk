import { readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

/**
 * 開発サーバー（Vite）が配ってよい場所（server.fs.allow）に足す、作品のフォルダと素材のフォルダの本当の場所。
 *
 * Vite は読み込むファイルのシンボリックリンクをたどり、本当の場所で fs.allow を見る。素材のフォルダを作品の外へのリンクにした作品
 * （大きな素材を別のディスクや別の作業場に置くなど）では、プラグインの CSS の url() や import が素材を指すと、`/@fs/<本当の場所>` が
 * 403 になる（/assets の配信はリンクをたどるので、プレイヤーと制作画面の素材は読める）。
 *
 * 足すのは、作者が置いたものだけ: 作品のフォルダ（/tmp のように親がリンクのとき）、素材のフォルダそのもの、素材のフォルダの中の
 * シンボリックリンクの行き先（リンクがフォルダならその中すべて、ファイルならそのファイル）。ほかの場所は足さないので、
 * /assets で読めないものは /@fs でも読めない。リンクの先のフォルダの中のリンクはたどらない（そのフォルダごと足してあるため）。
 * 読めないもの、壊れたリンクは飛ばす。数えるのは素材のフォルダの中だけで、深さは depth まで（大きな作品でも起動を遅くしない）。
 */
export function linkedAllowDirs(o: { root: string; assets: string; depth?: number }): string[] {
  const out = new Set<string>();
  const real = (path: string): string | null => {
    try {
      return realpathSync.native(path);
    } catch {
      // 無い場所は許す場所に足さない
      return null;
    }
  };
  const add = (path: string, real: string | null) => {
    if (real && real !== path) out.add(real);
  };
  add(o.root, real(o.root));
  add(o.assets, real(o.assets));
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // 読めないフォルダは、許す場所を探さない
      return;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isSymbolicLink()) {
        const target = real(path);
        if (target) out.add(target);
      } else if (e.isDirectory() && depth > 0) walk(path, depth - 1);
    }
  };
  walk(o.assets, o.depth ?? 6);
  return [...out];
}
