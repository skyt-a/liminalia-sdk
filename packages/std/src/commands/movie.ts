import type { Value } from "@liminalia/runtime";
import { t, type CommandDefinition } from "@liminalia/plugin-host";
import { BLEND_MODES, num, readExtra, text, writeExtra, type Blend } from "./image.ts";
import { SCREEN_KEYS } from "./screen.ts";

/**
 * 動画（TyranoScript 組み込みの [movie] [bgmovie] [stop_bgmovie] [wait_bgmovie] [layermode_movie]）。
 * 背景の動画は stage.extra の "screen.bgMovie" に持ち、ロード時は頭から流し直す（TyranoScript も同じ）。
 * 合成の動画は @blend の一覧に積む（@blend-off で消える）。繰り返さない合成の動画は流し終えれば消えるので状態に残さない。
 */

/** @bg-movie で流している背景の動画。 */
export interface BgMovie {
  file: string;
  /** 0〜100。 */
  volume: number;
  loop: boolean;
  mute: boolean;
}

export function bgMovie(extra: Record<string, Value>): BgMovie | undefined {
  return extra[SCREEN_KEYS.bgMovie] as unknown as BgMovie | undefined;
}

const blendMovieCommand: CommandDefinition = {
  name: "blend-movie",
  summary: "動画を画面全体に合成モードで重ねる（メッセージウィンドウの下）。@blend-off で消す",
  positional: ["file"],
  params: {
    file: t.required(t.asset("video", "動画")),
    name: t.string("名前（@blend-off で個別に消すのに使う）"),
    mode: t.enum(BLEND_MODES, "合成モード（CSS の mix-blend-mode）", "multiply"),
    opacity: t.int("不透明度（0〜255）", "255"),
    volume: t.int("音量（0〜100。既定は無音。コンフィグの BGM の音量と全体の音量を掛ける）", "0"),
    loop: t.bool("繰り返す（false なら再生し終えたら消える）", true),
    speed: t.number("再生の速さ（1 で等速）", "1"),
    fit: t.bool("画面を覆う大きさに広げる（false なら高さを画面に合わせる）", true),
    left: t.number("左端（px）"),
    top: t.number("上端（px）"),
    width: t.number("幅（px）"),
    height: t.number("高さ（px）"),
    time: t.duration("表示にかける時間", "500ms"),
    wait: t.bool("表示し終わるまで（loop=false なら再生し終わるまで）次に進まない", false),
    skip: t.skip(),
  },
  example: "@blend-movie effects/dust.webm name=dust mode=screen",
  apply(args, extra) {
    if (args.loop === false) return;
    const blend: Blend = {
      name: text(args.name),
      graphic: "",
      folder: "image",
      color: "",
      mode: text(args.mode, "multiply"),
      opacity: Math.max(0, Math.min(1, (num(args.opacity) ?? 255) / 255)),
      movie: {
        file: text(args.file),
        volume: num(args.volume) ?? 0,
        speed: num(args.speed) ?? 1,
        fit: args.fit !== false,
        left: num(args.left),
        top: num(args.top),
        width: num(args.width),
        height: num(args.height),
      },
    };
    writeExtra(extra, "blends", [...(readExtra(extra, "blends") ?? []), blend]);
  },
};

export const COMMANDS: CommandDefinition[] = [
  {
    name: "movie",
    summary: "動画を全画面で再生し、終わるまで待つ",
    positional: ["file"],
    params: {
      file: t.required(t.asset("video", "動画")),
      volume: t.int("音量（0〜100。コンフィグの BGM の音量と全体の音量を掛ける。ui.sound.movie で替えられる）", "100"),
      skip: t.bool("クリック（決定キー、タップ）とスキップで飛ばせる。false にした動画はスキップ中も流す", false),
      "skip-seen": t.bool("一度最後まで見た動画は、skip=false でもクリックとスキップで飛ばせる（既読と同じ考え。作品全体で外すなら commandDefaults の movie に false を書く）", true),
      mute: t.bool("ミュートする", false),
      time: t.duration("フェードインにかける時間", "0ms"),
      menu: t.bool("再生中もクイックメニューを表示する", false),
      subtitles: t.asset("video", "字幕（WebVTT の .vtt。歌詞や訳など。動画の下に重ねて出す）"),
    },
    example: "@movie opening.mp4 skip=true subtitles=opening.vtt",
    waits: true,
    // 自動確認（lim playtest・lim shot）では、skip=false の動画も流さずに進む
    autoplay: () => undefined,
  },
  {
    name: "bg-movie",
    summary: "動画を背景（背景画像の上、立ち絵の下）で再生する。再生中に次の動画を指定すると、今の動画が終わってから切り替わる",
    positional: ["file"],
    params: {
      file: t.required(t.asset("video", "動画")),
      volume: t.int("音量（0〜100。コンフィグの BGM の音量と全体の音量を掛ける。ui.sound.movie で替えられる）", "100"),
      loop: t.bool("繰り返す", true),
      mute: t.bool("ミュートする", false),
      time: t.duration("表示にかける時間", "300ms"),
    },
    example: "@bg-movie rain_loop.webm mute=true",
    apply(args, extra) {
      const movie: BgMovie = { file: text(args.file), volume: num(args.volume) ?? 100, loop: args.loop !== false, mute: args.mute === true };
      extra[SCREEN_KEYS.bgMovie] = movie as unknown as Value;
    },
  },
  {
    name: "stop-bg-movie",
    summary: "@bg-movie の動画を消す",
    bare: "time",
    params: {
      time: t.duration("消すのにかける時間。名前なしでも書ける（@stop-bg-movie 1s）", "300ms"),
      wait: t.bool("消し終わるまで次に進まない", true),
      skip: t.skip(),
    },
    example: "@stop-bg-movie time=1s",
    waits: true,
    apply(_args, extra) {
      delete extra[SCREEN_KEYS.bgMovie];
    },
  },
  {
    name: "wait-bg-movie",
    summary: "@bg-movie の動画の繰り返しをやめ、最後まで再生し終わるのを待つ",
    params: {},
    example: "@wait-bg-movie",
    waits: true,
    apply(_args, extra) {
      const movie = bgMovie(extra);
      if (movie) extra[SCREEN_KEYS.bgMovie] = { ...movie, loop: false } as unknown as Value;
    },
  },
  blendMovieCommand,
];
