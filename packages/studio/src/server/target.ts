import { isAbsolute, relative, resolve } from "node:path";
import { projectScripts, type Project } from "@liminalia/project";

/**
 * 開始位置（ファイル[#ラベル]）を、シナリオの名前（拡張子なし）に直す（lim shot・lim profile・制作画面の「重さを計る」）。
 * 「start」「start.lim」「scenario/start.lim」（シナリオのフォルダからのパス）のどれでもよい。
 * 無いファイル・ラベルなら、あるものを挙げて止める（status 400。制作画面はそのまま出す）。
 */
export function resolveShotTarget(project: Project, target: string): string {
  const hash = target.indexOf("#");
  const file = hash < 0 ? target : target.slice(0, hash);
  const label = hash < 0 ? null : target.slice(hash + 1);
  const rel = relative(project.paths.scenario, resolve(project.root, file));
  const path = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) ? rel : file;
  const name = path.replaceAll("\\", "/").replace(/\.lim$/, "");
  const scripts = projectScripts(project);
  const hit = scripts.get(name);
  if (!hit) {
    const names = [...scripts.keys()];
    throw new TargetError(`シナリオ ${file} がありません（${names.length > 0 ? `あるのは ${names.join("・")}` : "シナリオのフォルダに .lim がありません"}）`);
  }
  if (label !== null) {
    const labels = hit.script.body.flatMap((s) => (s.kind === "label" ? [s.name] : []));
    if (!labels.includes(label)) throw new TargetError(`${name} にラベル #${label} がありません（${labels.length > 0 ? `あるのは ${labels.map((l) => `#${l}`).join("・")}` : "ラベルがありません"}）`);
    return `${name}#${label}`;
  }
  return name;
}

/** 開始位置が見つからない（頼み方の誤りなので 400）。 */
export class TargetError extends Error {
  readonly status = 400;
}
