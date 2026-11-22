import type { Cast, CastModel } from "@liminalia/sdk";
import { defineCommandPlugin, type PluginCheckProject, type PluginDiagnostic } from "@liminalia/sdk";
import { DEFAULT_CORE } from "./model.ts";

/** cast.json の、type が live2d の model（人物の model に差分の model を重ねたもの）と、その場所。 */
export function live2dModels(cast: Readonly<Cast>): { where: string; model: CastModel }[] {
  const out: { where: string; model: CastModel }[] = [];
  for (const [who, entry] of Object.entries(cast)) {
    const own = entry.model?.type === "live2d" ? entry.model : undefined;
    if (own) out.push({ where: who, model: own });
    for (const [app, set] of Object.entries(entry.appearances ?? {})) {
      for (const [name, v] of Object.entries(set.variants ?? {})) {
        if (v.model?.type !== "live2d") continue;
        out.push({ where: `${who} / ${app} / ${name}`, model: own ? { ...own, ...v.model } : v.model });
      }
    }
  }
  return out;
}

/**
 * Live2D の立ち絵の作品全体の確かめ: model の src（.model3.json）があるか、Cubism Core を置いてあるか。
 * Core は同梱しないので、無ければ置き方を知らせる（遊ぶ画面では静止画のまま出る）。
 */
export function checkLive2d(project: Pick<PluginCheckProject, "cast" | "assetExists">): PluginDiagnostic[] {
  const out: PluginDiagnostic[] = [];
  const models = live2dModels(project.cast);
  const cores = new Set<string>();
  for (const { where, model } of models) {
    const src = typeof model.src === "string" ? model.src : "";
    if (!src) {
      out.push({ severity: "error", code: "live2d-no-src", message: `${where} の Live2D の model に src（.model3.json）がありません`, messageEn: `The Live2D model of ${where} has no src (.model3.json)`, file: "cast.json" });
      continue;
    }
    if (!src.endsWith(".model3.json"))
      out.push({ severity: "warning", code: "live2d-src-kind", message: `${where} の Live2D の src は .model3.json を指してください（${src}）`, messageEn: `The Live2D src of ${where} should point to a .model3.json file (${src})`, file: "cast.json" });
    else if (!project.assetExists("fgimage", src))
      out.push({ severity: "error", code: "live2d-missing-model", message: `${where} の Live2D のモデル ${src} が fgimage にありません`, messageEn: `The Live2D model ${src} of ${where} isn't in fgimage`, file: "cast.json" });
    cores.add(typeof model.core === "string" && model.core ? model.core : DEFAULT_CORE);
  }
  for (const core of cores) {
    if (project.assetExists("others", core)) continue;
    out.push({
      severity: "warning",
      code: "live2d-no-core",
      message: `Live2D の Cubism Core（others/${core}）がありません。無いあいだ、Live2D の立ち絵は静止画で出ます`,
      messageEn: `The Live2D Cubism Core (others/${core}) is missing. Until you add it, Live2D characters are shown as still images`,
      hint: "Live2D の公式のページから Cubism SDK for Web を入手し、使用許諾に同意してから、Core/live2dcubismcore.min.js を assets/others/live2d/ に置きます（docs/live2d-spine.md）",
      hintEn: "Download the Cubism SDK for Web from the official Live2D site, accept its license agreements, and put Core/live2dcubismcore.min.js in assets/others/live2d/ (docs/live2d-spine.md)",
      file: "cast.json",
    });
  }
  return out;
}

export default defineCommandPlugin({
  name: "live2d",
  apiVersion: 3,
  commands: [],
  check: (project) => checkLive2d(project),
});
