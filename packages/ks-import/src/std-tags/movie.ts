import type { TagMapping } from "../mapping.ts";

/**
 * 動画の変換表（TyranoScript 組み込みの [movie] [bgmovie] [stop_bgmovie] [wait_bgmovie] [layermode_movie]）。
 * 変換先は標準の命令（@liminalia/std）。
 */
export const MAPPINGS: TagMapping[] = [
  { command: "movie", tags: ["movie"], params: { file: "storage" } },
  { command: "bg-movie", tags: ["bgmovie"], params: { file: "storage", time: "time" }, ignore: ["stop"] },
  { command: "stop-bg-movie", tags: ["stop_bgmovie"], params: { time: "time" } },
  { command: "wait-bg-movie", tags: ["wait_bgmovie"], ignore: ["stop"] },
  {
    command: "blend-movie",
    tags: ["layermode_movie"],
    params: { file: "video", time: "time" },
    ignore: ["stop", "mute"],
    convert(pm, _tag, ctx) {
      // mute=true は無音（音量 0）と同じ。
      const rest = { ...pm };
      if (rest.mute === "true") rest.volume = "0";
      return ctx.mechanical(rest);
    },
  },
];
