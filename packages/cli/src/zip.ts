import { createWriteStream, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import yazl from "yazl";

/**
 * フォルダを zip にする（dir の中の name を、zip の中でも name のフォルダとして入れる）。
 * ファイル名は UTF-8 の印（一般目的フラグの 11 ビット目）を付けて書く。Mac の zip コマンドは印を付けないため、
 * 日本語のフォルダ名やファイル名が Windows のエクスプローラーで文字化けしていた。どの OS でも同じように作れる。
 */
export async function zipFolder(dir: string, name: string, zipPath: string): Promise<void> {
  await writeZip(dir, [name], zipPath);
}

/**
 * フォルダの中身を zip にする（dir の中のものが zip の一番上に来る）。ブラウザ版を itch.io などに上げるときは、
 * index.html が zip の一番上に無いと遊べないため。
 */
export async function zipContents(dir: string, zipPath: string): Promise<void> {
  await writeZip(dir, readdirSync(dir).sort(), zipPath);
}

async function writeZip(dir: string, top: string[], zipPath: string): Promise<void> {
  const zip = new yazl.ZipFile();
  const walk = (rel: string) => {
    const full = join(dir, rel);
    const stat = lstatSync(full);
    if (stat.isDirectory()) {
      zip.addEmptyDirectory(rel, { mtime: stat.mtime, mode: stat.mode });
      for (const child of readdirSync(full).sort()) walk(`${rel}/${child}`);
    } else if (stat.isFile()) {
      zip.addFile(full, rel, { mtime: stat.mtime, mode: stat.mode });
    }
  };
  for (const name of top) walk(name);
  zip.end();
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(zipPath);
    out.on("close", () => resolve());
    out.on("error", reject);
    zip.outputStream.on("error", reject).pipe(out);
  });
}
