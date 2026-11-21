import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { DataDeclaration } from "@liminalia/lang";
import { assetTextFilesIn, assetTextWhere } from "@liminalia/project/asset-uses";
import { URI } from "vscode-uri";
import type { TextFile } from "./actions.ts";
import type { ProjectInfo } from "./project.ts";
import type { NameRenameFiles } from "./rename.ts";

/**
 * 名前の変更で、台本のほかに付け替えるもの（制作画面の名前の変更と同じ）と、名前を変えるファイルの URI を集める。
 * openText は開いているファイルの保存前の中身（開いていなければ undefined。ディスクから読む）。言語サーバーとテストが使う。
 */
export function renameFiles(info: ProjectInfo, data: readonly DataDeclaration[], openText: (path: string) => string | undefined = () => undefined): NameRenameFiles {
  /** ファイルの今の中身（開いていれば保存前のもの）。無い・読めなければ null。 */
  const textFile = (path: string): TextFile | null => {
    const open = openText(path);
    if (open !== undefined) return { uri: URI.file(path).toString(), text: open };
    try {
      return { uri: URI.file(path).toString(), text: readFileSync(path, "utf8") };
    } catch {
      // 無いか読めないファイルは書き換えない
      return null;
    }
  };
  /** フォルダの中の .json（無ければ空）。 */
  const jsonFiles = (dir: string): TextFile[] => {
    let names: string[];
    try {
      names = readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      // フォルダが無い（訳やレビューが無い作品）
      return [];
    }
    return names.flatMap((n) => textFile(join(dir, n)) ?? []);
  };
  const baseline = join(info.root, ".liminalia", "regress", "baseline");
  let names: string[] = [];
  try {
    names = readdirSync(baseline);
  } catch {
    // 基準の画像が無い
  }
  const pick = (path: string) => textFile(path) ?? undefined;
  const config = pick(info.configFile);
  const cast = pick(info.paths.cast);
  const voiceLock = pick(info.paths.voiceLock);
  const studioState = pick(join(info.root, ".liminalia", "studio.json"));
  const history = join(info.root, ".liminalia", "history");
  const isFile = (path: string) => {
    try {
      return statSync(path).isFile();
    } catch {
      // 無いものはファイルでない
      return false;
    }
  };
  return {
    ...(config ? { config } : {}),
    ...(cast ? { cast } : {}),
    translations: jsonFiles(info.paths.lang),
    ...(voiceLock ? { voiceLock } : {}),
    reviews: jsonFiles(join(info.root, "reviews")),
    ...(studioState ? { studioState } : {}),
    ...(names.length > 0 ? { baselines: { folder: URI.file(baseline).toString(), names } } : {}),
    data: data.flatMap((decl) => {
      const file = textFile(join(info.paths.data, ...decl.file.split("/")));
      return file ? [{ decl, file }] : [];
    }),
    scenarioUri: (name) => URI.file(join(info.paths.scenario, ...`${name}.lim`.split("/"))).toString(),
    assetUri: (folder, path) => URI.file(join(info.paths.assets, folder, ...path.split("/"))).toString(),
    assetExists: (folder, path) => isFile(join(info.paths.assets, folder, ...path.split("/"))),
    history: { uri: (name) => URI.file(join(history, ...name.split("/"))).toString(), has: (name) => existsSync(join(history, ...name.split("/"))) },
    // 素材の名前を文字として探す所（lim unused、lim rename asset と同じ。作品の CSS を書き換え、手で直す所を探す）。素材の名前の変更のときだけ読む
    assetTexts: () =>
      assetTextFilesIn({ root: info.root, paths: info.paths, ui: info.config.ui, plugins: info.plugins }).flatMap(({ source, file }) => {
        const text = textFile(file);
        return text ? [{ source, where: assetTextWhere(info.root, file), rel: relative(info.root, file).split(sep).join("/"), file: text }] : [];
      }),
    assetsDir: relative(info.root, info.paths.assets).split(sep).join("/"),
  };
}
