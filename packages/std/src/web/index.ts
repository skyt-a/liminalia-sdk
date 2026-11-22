import { defineWebPlugin, type DialogueView, type DomHost, type Renderer, type Restorer, type SystemController } from "@liminalia/web";
import type { StageState } from "@liminalia/runtime";
import { readChat } from "../commands/chat.ts";
import { CODEX_FILE } from "../commands/codex.ts";
import { readEffects } from "../commands/effect.ts";
import { emoteOf } from "../commands/emote.ts";
import { readHud } from "../commands/hud.ts";
import { bgMovie } from "../commands/movie.ts";
import { readCutins, readFlipbookLoops } from "../commands/oneshot.ts";
import { readParticles } from "../commands/particles.ts";
import { STD_WEB_FEATURE_NAMES, STD_WEB_FEATURES, type StdWebFeature } from "../features.ts";
import * as anim from "./anim.ts";
// 部品に分けた描画（下の LOADERS）の CSS は分けずに、前と同じ並びで始めに読む（テーマと作品の CSS が上書きする順を変えない）
import "./chapter.css";
import "./chat.css";
import "./emote.css";
import * as html from "./html.ts";
import "./hud.css";
import "./codex.css";
import * as image from "./image.ts";
import * as notify from "./notify.ts";
import "./oneshot.css";
import "./investigate.css";
import "./map-choice.css";
import "./manga.css";
import "./movie.css";
import * as screen from "./screen.ts";
import * as text from "./text.ts";
import "./staff-roll.css";

/** 部品に分けた描画の一つ（命令の描画と、ロード・言語の切り替えでの組み立て直し）。 */
interface Part {
  renderers: Record<string, Renderer>;
  restorers?: Restorer[];
  relocalizers?: Restorer[];
  dialogue?: DialogueView;
  setupCodex?(host: DomHost, system: SystemController): Promise<void>;
}

/**
 * 使う作品だけが読む描画（部品の名前と命令は ../features.ts の STD_WEB_FEATURES）。書き出しでは部品ごとに別のファイルになり、
 * 作品が使う部品は遊び始める前に読み（preloadStd）、ほかは初めて描くときに読む。いつも使う描画（画像・立ち絵の動き・画面・文字・HTML・知らせ）は分けない。
 */
const LOADERS: Record<StdWebFeature, () => Promise<Part>> = {
  chapter: () => import("./chapter.ts"),
  chat: () => import("./chat.ts"),
  codex: () => import("./codex.ts"),
  effect: () => import("./effect.ts"),
  emote: () => import("./emote.ts"),
  hud: () => import("./hud.ts"),
  investigate: () => import("./investigate.ts"),
  manga: () => import("./manga.ts"),
  "map-choice": () => import("./map-choice.ts"),
  movie: () =>
    import("./movie.ts").then((m) => ({
      renderers: { ...m.bgMovieRenderers, movie: (ctx, a, wait) => m.movie(ctx, a, wait) },
      restorers: [...m.bgMovieRestorers, () => m.removeMovie()],
    })),
  oneshot: () => import("./oneshot.ts"),
  particles: () => import("./particles.ts"),
  "staff-roll": () => import("./staff-roll.ts"),
};

/** 読み終えた部品と、読んでいる（読み終えた）部品。 */
const parts = new Map<StdWebFeature, Part>();
const loading = new Map<StdWebFeature, Promise<Part>>();

/** 部品を読む（一度だけ。読めなければ、次に描くときに読み直す）。 */
function load(feature: StdWebFeature): Promise<Part> {
  let p = loading.get(feature);
  if (!p) {
    p = LOADERS[feature]().then(
      (part) => {
        parts.set(feature, part);
        return part;
      },
      (e: unknown) => {
        loading.delete(feature);
        throw e;
      },
    );
    loading.set(feature, p);
  }
  return p;
}

/** 遊び始める前に読んでおく部品（setup で待つ）。 */
const preloads: Promise<void>[] = [];

/**
 * 部品を遊び始める前に読んでおく（書き出しのエンジンは作品が使う部品、開発サーバーはすべて。virtual:liminalia/project が呼ぶ）。
 * 知らない名前は飛ばす。読み終えるのはプラグインの setup で待つ。
 */
export function preloadStd(features: readonly string[] | "all"): void {
  for (const f of features === "all" ? STD_WEB_FEATURE_NAMES : features) {
    if (!(f in LOADERS)) continue;
    preloads.push(
      load(f as StdWebFeature).then(
        () => undefined,
        (e: unknown) => console.warn(`標準の命令の描画（${f}）を読み込めません。描くときに読み直します`, e),
      ),
    );
  }
}

/** 部品の命令の描画。読んであればそのまま描き、まだなら読んでから描く（実行器は描き終えるのを待つので、命令の順は変わらない）。 */
function lazyRenderer(feature: StdWebFeature, name: string): Renderer {
  return (ctx, a, wait, stage) => {
    const part = parts.get(feature);
    if (part) return part.renderers[name]!(ctx, a, wait, stage);
    return load(feature).then((p) => p.renderers[name]!(ctx, a, wait, stage));
  };
}

/** ロードの組み立て直し。読んでいない部品は、状態にその部品のものがあるとき（needs）だけ読む（無ければ片付けるものも無い）。 */
function lazyRestorer(feature: StdWebFeature, needs: (stage: StageState) => boolean): Restorer {
  return async (ctx, stage) => {
    const pending = loading.get(feature) ?? (needs(stage) ? load(feature) : null);
    if (!pending) return;
    for (const restore of (await pending).restorers ?? []) await restore(ctx, stage);
  };
}

/** 言語を替えたときの出し直し（読んでいない部品は、出しているものが無い）。 */
function lazyRelocalizer(feature: StdWebFeature): Restorer {
  return async (ctx, stage) => {
    const pending = loading.get(feature);
    if (!pending) return;
    for (const relocalize of (await pending).relocalizers ?? []) await relocalize(ctx, stage);
  };
}

/** 本文をチャットの画面に積む口（ui.chat.dialogue。chat の部品）。ページの始まりで読み、それより前の呼び出しは読み終えてから渡す。 */
const dialogue: DialogueView = {
  page: async (ctx, page, stage) => (await load("chat")).dialogue!.page(ctx, page, stage),
  follow: (ctx) => parts.get("chat")?.dialogue?.follow(ctx),
  choosing: (ctx, on, layer) => {
    const part = parts.get("chat");
    if (part) part.dialogue?.choosing(ctx, on, layer);
    else void load("chat").then((p) => p.dialogue?.choosing(ctx, on, layer));
  },
  clear: (ctx) => parts.get("chat")?.dialogue?.clear(ctx),
};

const lazyRenderers: Record<string, Renderer> = Object.fromEntries(STD_WEB_FEATURE_NAMES.flatMap((f) => STD_WEB_FEATURES[f].map((name) => [name, lazyRenderer(f, name)] as const)));

/** 標準の命令の描画。どのプロジェクトにも組み込みで入る。 */
export default defineWebPlugin({
  name: "std",
  extensions: {
    renderers: {
      ...image.renderers,
      ...anim.renderers,
      ...screen.renderers,
      ...text.renderers,
      ...html.renderers,
      ...notify.renderers,
      ...lazyRenderers,
    },
    dialogue,
    // 前景の項目（image）→ 立ち絵の姿（anim）の順。画面全体（screen）はレイヤーを組み立て終えてから。
    restorers: [
      ...image.restorers,
      ...anim.restorers,
      ...screen.restorers,
      lazyRestorer("movie", (stage) => bgMovie(stage.extra) !== undefined),
      lazyRestorer("particles", (stage) => Object.keys(readParticles(stage.extra)).length > 0),
      lazyRestorer("effect", (stage) => Object.keys(readEffects(stage.extra)).length > 0),
      lazyRestorer("chat", (stage) => readChat(stage.extra) !== null),
      lazyRestorer("oneshot", (stage) => readFlipbookLoops(stage.extra).length > 0 || readCutins(stage.extra).length > 0),
      lazyRestorer("hud", (stage) => readHud(stage.extra).length > 0),
      lazyRestorer("emote", (stage) => Object.values(stage.sprites).some((s) => emoteOf(s) !== null)),
    ],
    // 言語を替えたとき、置いたままの文字（@layer-text・チャット・常駐の表示）を出し直す
    relocalizers: [...text.relocalizers, lazyRelocalizer("chat"), lazyRelocalizer("hud")],
  },
  // 遊び始める前に、読んでおく部品（preloadStd）を読み終える
  setup: async () => {
    await Promise.all(preloads);
  },
  // 図鑑（data/codex.json がある作品だけ、画面 codex を登録し、開いたものを知らせる）
  ready: async ({ host, system }) => {
    if (!loading.has("codex")) {
      // 図鑑の部品を読んでいなければ、データがあるときだけ読む（書き出しは作品のデータの一覧に無いものを取りに行かない。無ければ図鑑は無い）
      const has = await host.context.loadData(CODEX_FILE).then(
        () => true,
        () => false,
      );
      if (!has) return;
    }
    await (await load("codex")).setupCodex!(host, system);
  },
});

export { fadeIn, fadeOutAndRemove, imageLayer, loadElement, registerLayerItem } from "./image.ts";

// プラグインの約束（@liminalia/sdk/web の registerLayerItem）が呼ぶ実装を登録する
import { provide as provideToSdk } from "@liminalia/sdk/host";
import { registerLayerItem as registerLayerItemForSdk } from "./image.ts";
provideToSdk("std-web", { registerLayerItem: registerLayerItemForSdk });
