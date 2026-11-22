import { join } from "node:path";
import { containedPath } from "@liminalia/project/contained-path";
import { StudioError } from "./workspace.ts";

/** 素材とデータの編集で使う、設定フォルダからの相対パス。 */
export function managedPath(root: string, rel: string, what: string): string {
  const parts = rel.split("/");
  const target = join(root, ...parts);
  if (parts.some((p) => !p || p.startsWith(".") || p.includes("\\")) || !containedPath(root, target)) {
    throw new StudioError(400, `${what}の名前として使えません: ${rel}`);
  }
  return target;
}
