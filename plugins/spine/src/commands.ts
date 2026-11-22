import type { Cast, CastModel } from "@liminalia/sdk";
import { defineCommandPlugin, type PluginCheckProject, type PluginDiagnostic } from "@liminalia/sdk";
import { atlasFor, DEFAULT_RUNTIME } from "./model.ts";

/** cast.json の、type が spine の model（人物の model に差分の model を重ねたもの）と、その場所。 */
export function spineModels(cast: Readonly<Cast>): { where: string; model: CastModel }[] {
  const out: { where: string; model: CastModel }[] = [];
  for (const [who, entry] of Object.entries(cast)) {
    const own = entry.model?.type === "spine" ? entry.model : undefined;
    if (own) out.push({ where: who, model: own });
    for (const [app, set] of Object.entries(entry.appearances ?? {})) {
      for (const [name, v] of Object.entries(set.variants ?? {})) {
        if (v.model?.type !== "spine") continue;
        out.push({ where: `${who} / ${app} / ${name}`, model: own ? { ...own, ...v.model } : v.model });
      }
    }
  }
  return out;
}

/**
 * Spine の立ち絵の作品全体の確かめ: 骨格（src）と .atlas があるか、ランタイムを置いてあるか。
 * ランタイムは同梱しないので、無ければ置き方を知らせる（遊ぶ画面では静止画のまま出る）。
 */
export function checkSpine(project: Pick<PluginCheckProject, "cast" | "assetExists">): PluginDiagnostic[] {
  const out: PluginDiagnostic[] = [];
  const runtimes = new Set<string>();
  const seen = new Set<string>();
  for (const { where, model } of spineModels(project.cast)) {
    const src = typeof model.src === "string" ? model.src : "";
    if (!src) {
      out.push({ severity: "error", code: "spine-no-src", message: `${where} の Spine の model に src（骨格の .skel か .json）がありません`, messageEn: `The Spine model of ${where} has no src (a .skel or .json skeleton)`, file: "cast.json" });
      continue;
    }
    const atlas = typeof model.atlas === "string" && model.atlas ? model.atlas : atlasFor(src);
    for (const [path, what, whatEn] of [[src, "骨格", "skeleton"], [atlas, ".atlas", ".atlas"]] as const) {
      if (seen.has(path)) continue;
      seen.add(path);
      if (!project.assetExists("fgimage", path))
        out.push({ severity: "error", code: "spine-missing-file", message: `${where} の Spine の${what} ${path} が fgimage にありません`, messageEn: `The Spine ${whatEn} ${path} of ${where} isn't in fgimage`, file: "cast.json" });
    }
    runtimes.add(typeof model.runtime === "string" && model.runtime ? model.runtime : DEFAULT_RUNTIME);
  }
  for (const runtime of runtimes) {
    if (project.assetExists("others", runtime)) continue;
    out.push({
      severity: "warning",
      code: "spine-no-runtime",
      message: `Spine のランタイム（others/${runtime}）がありません。無いあいだ、Spine の立ち絵は静止画で出ます`,
      messageEn: `The Spine runtime (others/${runtime}) is missing. Until you add it, Spine characters are shown as still images`,
      hint: "Spine のライセンスを持つ人が、骨格を書き出した Spine の版に合う spine-webgl の dist/iife/spine-webgl.min.js を入手し、assets/others/spine/ に置きます（docs/live2d-spine.md）",
      hintEn: "A Spine licensee gets dist/iife/spine-webgl.min.js of the spine-webgl version that matches the Spine version the skeleton was exported with, and puts it in assets/others/spine/ (docs/live2d-spine.md)",
      file: "cast.json",
    });
  }
  return out;
}

export default defineCommandPlugin({
  name: "spine",
  apiVersion: 3,
  commands: [],
  check: (project) => checkSpine(project),
});
