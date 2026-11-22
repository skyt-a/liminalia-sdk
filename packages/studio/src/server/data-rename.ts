import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renameInData, type DataRename } from "@liminalia/lang";
import { jsonIndent } from "@liminalia/editor/label-follow";
import type { StudioWorkspace } from "./workspace.ts";
import { HISTORY_DIR, hashText } from "./workspace.ts";
import { keepVersion, writeAtomic } from "./versions.ts";
import { textStep } from "./file-undo.ts";
import type { Remember } from "./undo.ts";

/**
 * シーン・ファイル・素材・変数・キャストの名前を変えたとき、プラグインが形を宣言した作品のデータ（data/*.json）の中の参照も書き換える。
 * 書き換えたファイルの名前を返す。前の版は .liminalia/history/@data/ に残し、remember に戻し方を渡す（名前の変更が途中で失敗したら戻す）。
 * 字下げは元のファイルに合わせる（タブか空白の数。分からなければ空白二つ）。
 */
export function renameInDeclaredData(ws: StudioWorkspace, change: DataRename, remember?: Remember): string[] {
  const out: string[] = [];
  for (const decl of ws.dataDeclarations()) {
    const path = join(ws.project.paths.data, ...decl.file.split("/"));
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      continue;
    }
    const r = renameInData(decl, value, change);
    if (r.count === 0) continue;
    const next = `${JSON.stringify(r.value, null, jsonIndent(text))}${text.endsWith("\n") ? "\n" : ""}`;
    keepVersion(join(ws.project.root, HISTORY_DIR, "@data", ...decl.file.split("/")), ".json", text);
    writeAtomic(path, next);
    const step = textStep(`data/${decl.file}`, path, text, next);
    remember?.(
      `data/${decl.file}`,
      () => {
        // 書いたあとにほかで変わっていれば戻さない
        if (hashText(readFileSync(path, "utf8")) !== hashText(next)) throw new Error(`data/${decl.file} がほかで変更されました`);
        writeAtomic(path, text);
      },
      step,
    );
    out.push(decl.file);
  }
  if (out.length > 0) ws.targetsChanged();
  return out;
}
