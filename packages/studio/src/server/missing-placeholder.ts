import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, normalize, sep } from "node:path";
import type { Project } from "@liminalia/project";
import { STUDIO_PAGE } from "../protocol.ts";

/**
 * 無い画像の札（開発サーバーだけ。プレビューとテストプレイ）。シナリオやキャラクターが使っている画像がまだ無くても止めずに書き進められるよう、
 * プレイヤーが /assets/<種類>/<パス> を頼んで見つからなければ、素材の名前を書いた SVG を返す（背景は画面の大きさ、立ち絵は人の高さ）。
 * 書き出し（lim build）は今までどおり無い素材をエラーにして止める。制作画面そのもの（サムネイル、キャラクターの画面）には返さない
 * （無いことをそのまま見せる）。
 */

/** 札を返す画像の種類と拡張子。 */
const FOLDERS = new Set(["bgimage", "fgimage", "image"]);
const IMAGE = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;

/** 頼みがプレイヤーからの無い画像なら札を返して true。 */
export function servePlaceholder(project: Project, req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/assets/")) return false;
  // 制作画面そのものの頼み（サムネイルなど）には札を返さない
  const referer = req.headers.referer ? new URL(req.headers.referer, "http://localhost").pathname : "";
  if (referer.startsWith(STUDIO_PAGE)) return false;
  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname.slice("/assets/".length));
  } catch {
    return false;
  }
  const [folder = "", ...rest] = rel.split("/");
  const path = rest.join("/");
  if (!FOLDERS.has(folder) || !IMAGE.test(path) || rest.some((p) => p === ".." || p === "")) return false;
  const file = normalize(join(project.paths.assets, folder, ...rest));
  if (!file.startsWith(project.paths.assets + sep) || existsSync(file)) return false;
  const svg = placeholderSvg(folder, path.replace(/^@[^/]+\//, ""), project.screen, project.config.languages?.[0] === "en" ? "en" : "ja");
  res.statusCode = 200;
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  // 素材を足したらすぐ本物が出るように、覚えさせない
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Liminalia-Placeholder", "1");
  res.end(req.method === "HEAD" ? undefined : svg);
  return true;
}

const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** 札の SVG（背景は画面の大きさ、立ち絵は画面の高さの 9 割の人の形、画像は 16:9 の枠）。 */
export function placeholderSvg(folder: string, path: string, screen: { width: number; height: number }, language: "ja" | "en"): string {
  const note = language === "en" ? "Missing asset" : "素材がありません";
  const name = `${folder}/${path}`;
  const font = "font-family=\"system-ui, -apple-system, 'Hiragino Sans', 'Yu Gothic', sans-serif\"";
  if (folder === "fgimage") {
    const h = Math.round(screen.height * 0.9);
    const w = Math.round(h * 0.5);
    const size = Math.max(14, Math.round(h / 36));
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<g fill="rgba(201,196,212,0.55)" stroke="rgba(143,136,158,0.9)" stroke-width="${Math.max(2, h / 300)}" stroke-dasharray="${size / 2} ${size / 3}">
<ellipse cx="${w / 2}" cy="${h * 0.13}" rx="${w * 0.16}" ry="${h * 0.095}"/>
<path d="M ${w * 0.14} ${h * 0.33} Q ${w * 0.14} ${h * 0.27} ${w * 0.3} ${h * 0.27} L ${w * 0.7} ${h * 0.27} Q ${w * 0.86} ${h * 0.27} ${w * 0.86} ${h * 0.33} L ${w * 0.94} ${h} L ${w * 0.06} ${h} Z"/>
</g>
<g ${font} text-anchor="middle" fill="#1d1b22">
<text x="${w / 2}" y="${h * 0.5}" font-size="${size}" font-weight="700">${escape(path)}</text>
<text x="${w / 2}" y="${h * 0.5 + size * 1.6}" font-size="${Math.round(size * 0.8)}">${escape(note)}</text>
</g>
</svg>`;
  }
  const [w, h] = folder === "bgimage" ? [screen.width, screen.height] : [480, 270];
  const size = Math.max(14, Math.round(h / 20));
  const inset = Math.round(size / 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<rect width="${w}" height="${h}" fill="#3a3f4a"/>
<rect x="${inset}" y="${inset}" width="${w - inset * 2}" height="${h - inset * 2}" fill="none" stroke="#8a93a3" stroke-width="2" stroke-dasharray="${size} ${size / 2}"/>
<g ${font} text-anchor="middle" fill="#e8eaf0">
<text x="${w / 2}" y="${h / 2}" font-size="${size}" font-weight="700">${escape(name)}</text>
<text x="${w / 2}" y="${h / 2 + size * 1.6}" font-size="${Math.round(size * 0.75)}">${escape(note)}</text>
</g>
</svg>`;
}
