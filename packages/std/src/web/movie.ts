import type { StageState, Value } from "@liminalia/runtime";
import { keepAwake, type Renderer, type RenderContext, type Restorer } from "@liminalia/web";
import { bgMovie as bgMovieState, type BgMovie } from "../commands/movie.ts";
import "./movie.css";

/**
 * 動画の再生。TyranoScript 組み込みの [movie]（bgmode=false）を移したもの。
 * 黒地の全画面に置き、終わったら取り除いて進む。skip=true の動画と、skip-seen（既定 true）で一度最後まで見た動画
 * （全セーブ共通の変数 movies_watched）は飛ばせる: 送り（クリック、決定キー、タップ）で終わり、スキップ中は流さず、流している途中で
 * スキップが始まっても終わる。飛ばせない動画はスキップ中も流す（TyranoScript と同じ）。開発用の早送り（?skip=N）の間は、飛ばせない動画も流さない。
 * 自動確認（lim playtest・lim shot）では、命令の autoplay で描かずに進む（commands/movie.ts）。
 * 再生中はクイックメニューを出さない（menu=true なら出したまま）。画面を消さない（スリープさせない）。
 */
let active: { video: HTMLVideoElement; end: () => void } | null = null;

/** 最後まで見た動画を覚える、全セーブ共通の変数の名前（動画のファイル → true）。 */
export const MOVIES_WATCHED = "movies_watched";

function watched(ctx: RenderContext): Record<string, Value> | null {
  const vars = ctx.host.system?.systemVariables;
  if (!vars) return null;
  const v = vars[MOVIES_WATCHED];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Value>) : null;
}

export async function movie(ctx: RenderContext, a: Record<string, Value>, wait: boolean): Promise<void> {
  removeMovie();
  const file = String(a.file ?? "");
  const skippable = a.skip === true || (a["skip-seen"] !== false && watched(ctx)?.[file] === true);
  if (ctx.skipping && (skippable || ctx.host.devSkipping)) return;
  const video = document.createElement("video");
  video.className = "lim-movie";
  video.src = ctx.asset("video", file);
  video.muted = a.mute === true;
  // 音量は volume × コンフィグの BGM の音量（ui.sound.movie）× 全体の音量。ミュートも効く
  ctx.audio.bindMedia(video, typeof a.volume === "number" ? a.volume : 100);
  video.playsInline = true;
  Object.assign(video.style, { position: "absolute", inset: "0", width: "100%", height: "100%", background: "#000", display: "none", opacity: "0" });
  // 字幕（WebVTT）。mode が disabled のままだとブラウザはファイルを取りに行かず、load も来ない。
  // WebKit は default を付けて後から足した track を showing にしないので、load のあとで showing にする。
  const subtitles = typeof a.subtitles === "string" && a.subtitles !== "" ? a.subtitles : "";
  if (subtitles) {
    const track = document.createElement("track");
    track.kind = "subtitles";
    track.default = true;
    track.src = ctx.asset("video", subtitles);
    video.append(track);
  }
  ctx.layers.overlay.append(video);
  const uncover = a.menu === true ? () => undefined : ctx.host.coverUi();

  keepAwake("movie", true);
  let offSkip: () => void = () => undefined;
  let ended = false;
  const done = new Promise<void>((resolve) => {
    const end = () => {
      if (ended) return;
      ended = true;
      if (active?.video === video) active = null;
      offSkip();
      keepAwake("movie", false);
      uncover();
      video.pause();
      video.remove();
      resolve();
    };
    active = { video, end };
    video.addEventListener(
      "ended",
      () => {
        // 最後まで見た（次からは skip-seen で飛ばせる）
        const system = ctx.host.system;
        if (system) {
          const seen = watched(ctx) ?? ((system.systemVariables[MOVIES_WATCHED] = {}) as Record<string, Value>);
          if (seen[file] !== true) {
            seen[file] = true;
            system.saveSystemVariables();
          }
        }
        end();
      },
      { once: true },
    );
    video.addEventListener("error", () => {
      console.warn(`動画を再生できません: ${video.src}`);
      end();
    });
    if (skippable) {
      video.addEventListener("click", (e) => {
        e.stopPropagation();
        end();
      });
      // 決定キー・host.advance() の送りと、スキップの始まりでも終える
      offSkip = ctx.host.onSkipRequest(end);
    } else {
      // 舞台のクリック（本文送り）には流さない
      video.addEventListener("click", (e) => e.stopPropagation());
    }
  });

  video.addEventListener(
    "canplay",
    () => {
      video.style.display = "";
      void ctx.fade(video, 1, typeof a.time === "number" ? a.time : 0);
      video.play().catch(() => {
        // 自動再生が音つきで拒まれたら、音を消して流す
        video.muted = true;
        void video.play().catch(() => active?.end());
      });
    },
    { once: true },
  );
  video.load();
  const track = video.querySelector("track");
  if (track) track.track.mode = "showing";
  if (wait) await done;
}

/** ロード時は止めて取り除く。 */
export function removeMovie(): void {
  active?.end();
  active = null;
}

// ---- @bg-movie ----

/**
 * 背景の動画。背景画像の上・立ち絵の下に置く（TyranoScript の [bgmovie] は z-index 0 で base の上に重なる）。
 * 流している途中に次の @bg-movie が来たら、今の動画の繰り返しをやめ、終わったところで次に替える。
 */
let queued: BgMovie | null = null;

function bgMovieLayer(ctx: RenderContext): HTMLDivElement {
  let layer = ctx.camera.querySelector<HTMLDivElement>(":scope > .lim-bgmovie");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "lim-bgmovie";
    ctx.layers.background.after(layer);
  }
  return layer;
}

function currentBgVideo(ctx: RenderContext): HTMLVideoElement | null {
  return bgMovieLayer(ctx).querySelector<HTMLVideoElement>(":scope > video:not([data-transient])");
}

function startBgMovie(ctx: RenderContext, m: BgMovie, fade: number): HTMLVideoElement {
  const layer = bgMovieLayer(ctx);
  const video = document.createElement("video");
  video.src = ctx.asset("video", m.file);
  video.loop = m.loop;
  video.muted = m.mute;
  ctx.audio.bindMedia(video, m.volume);
  video.playsInline = true;
  video.style.opacity = "0";
  layer.append(video);
  video.addEventListener("ended", () => {
    if (!queued) return;
    const next = queued;
    queued = null;
    const after = startBgMovie(ctx, next, 0);
    // 次の動画が描けるようになってから古い動画を外す。
    after.addEventListener("canplay", () => video.remove(), { once: true });
  });
  // 自動再生が止められたら、音を消して鳴らし直す。それでも鳴らせなければ（読めない形式など）作る人に分かるように残す
  video.play().catch(() => {
    video.muted = true;
    void video.play().catch((e: unknown) => console.warn(`背景の動画を再生できません: ${m.file}`, e));
  });
  void ctx.fade(video, 1, fade);
  return video;
}

function bgMovieArgs(a: Record<string, Value>): BgMovie {
  return { file: String(a.file ?? ""), volume: typeof a.volume === "number" ? a.volume : 100, loop: a.loop !== false, mute: a.mute === true };
}

function bgMovie(ctx: RenderContext, a: Record<string, Value>): void {
  const current = currentBgVideo(ctx);
  if (current && !current.ended) {
    current.loop = false;
    queued = bgMovieArgs(a);
    return;
  }
  current?.remove();
  startBgMovie(ctx, bgMovieArgs(a), ctx.time(typeof a.time === "number" ? a.time : 300));
}

async function stopBgMovie(ctx: RenderContext, a: Record<string, Value>, wait: boolean): Promise<void> {
  queued = null;
  const videos = [...bgMovieLayer(ctx).querySelectorAll("video")];
  for (const v of videos) v.dataset.transient = "";
  const done = Promise.all(videos.map((v) => ctx.fade(v, 0, ctx.time(typeof a.time === "number" ? a.time : 300)))).then(() => {
    for (const v of videos) {
      v.pause();
      v.remove();
    }
  });
  if (wait) await done;
}

/** 繰り返しをやめて終わりを待つ。スキップ中は待たない（TyranoScript は最後まで待つ）。 */
async function waitBgMovie(ctx: RenderContext): Promise<void> {
  const video = currentBgVideo(ctx);
  if (!video || video.ended) return;
  video.loop = false;
  if (ctx.skipping) return;
  await new Promise<void>((resolve) => {
    video.addEventListener("ended", () => resolve(), { once: true });
    video.addEventListener("error", () => resolve(), { once: true });
  });
}

/** ロード時。状態にある背景の動画を頭から流し直す。 */
function restoreBgMovie(ctx: RenderContext, stage: StageState): void {
  queued = null;
  for (const v of bgMovieLayer(ctx).querySelectorAll("video")) {
    v.pause();
    v.remove();
  }
  const m = bgMovieState(stage.extra);
  if (m) startBgMovie(ctx, m, 0);
}

export const bgMovieRenderers: Record<string, Renderer> = {
  "bg-movie": (ctx, a) => bgMovie(ctx, a),
  "stop-bg-movie": (ctx, a, wait) => stopBgMovie(ctx, a, wait),
  "wait-bg-movie": (ctx) => waitBgMovie(ctx),
};

export const bgMovieRestorers: Restorer[] = [restoreBgMovie];
