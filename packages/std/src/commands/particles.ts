import type { Value } from "@liminalia/runtime";
import { t, type CommandDefinition } from "@liminalia/plugin-host";
import { num, text } from "./image.ts";

/**
 * パーティクル（雨・雪・桜・光の粒・ちり、または好きな画像を降らせる）。
 * 出しているものは stage.extra の "std.particles"（名前 → 設定）に持ち、ロード時は画面いっぱいに散らした状態から流し直す。
 */

export const PARTICLE_PRESETS = ["rain", "snow", "sakura", "sparkle", "dust"] as const;
export const PARTICLE_LAYERS = ["back", "front", "fx"] as const;

export interface Particles {
  preset: (typeof PARTICLE_PRESETS)[number];
  /** 画像（image からのパス）。空なら種類ごとの形を描く。 */
  image: string;
  /** 数。0 なら種類ごとの既定。 */
  count: number;
  /** 速さの倍率。 */
  speed: number;
  /** 横風（px/秒。正で右へ流れる）。null なら種類ごとの既定。 */
  wind: number | null;
  /** 大きさの倍率。 */
  size: number;
  /** 色。空なら種類ごとの既定。 */
  color: string;
  /** 0〜100。 */
  opacity: number;
  /** back（背景と立ち絵の間）/ front（立ち絵の前）/ fx（画面全体。メッセージ枠の下）。 */
  layer: (typeof PARTICLE_LAYERS)[number];
}

const KEY = "std.particles";

export function readParticles(extra: Record<string, Value>): Record<string, Particles> {
  return (extra[KEY] as unknown as Record<string, Particles> | undefined) ?? {};
}

function writeParticles(extra: Record<string, Value>, value: Record<string, Particles>): void {
  if (Object.keys(value).length === 0) delete extra[KEY];
  else extra[KEY] = value as unknown as Value;
}

export const COMMANDS: CommandDefinition[] = [
  {
    name: "particles",
    summary: "雨、雪、桜、光の粒、ちりを降らせる（画像を降らせることもできる）。@particles-off で止める",
    positional: ["preset"],
    params: {
      preset: t.required(t.enum([...PARTICLE_PRESETS], "種類（rain 雨 / snow 雪 / sakura 桜 / sparkle 光の粒 / dust ちり）")),
      name: t.string("名前（@particles-off で個別に止めるのに使う。同じ名前は置き換える）。省略時は種類の名前"),
      image: t.asset("image", "降らせる画像（省略時は種類ごとの形）"),
      count: t.int("数（省略時は種類ごとの既定）"),
      speed: t.number("速さの倍率", "1"),
      wind: t.number("横風（px/秒。正で右へ流れる。省略時は種類ごとの既定）"),
      size: t.number("大きさの倍率", "1"),
      color: t.color("色（省略時は種類ごとの既定）"),
      opacity: t.int("不透明度（0〜100）", "100"),
      layer: t.enum([...PARTICLE_LAYERS], "置く場所（back 背景と立ち絵の間 / front 立ち絵の前 / fx 画面全体）", "fx"),
      time: t.duration("フェードインにかける時間", "500ms"),
    },
    example: "@particles snow wind=20 layer=front",
    apply(args, extra) {
      const preset = text(args.preset, "snow") as Particles["preset"];
      const all = { ...readParticles(extra) };
      all[text(args.name, preset)] = {
        preset,
        image: text(args.image),
        count: num(args.count) ?? 0,
        speed: num(args.speed) ?? 1,
        wind: num(args.wind),
        size: num(args.size) ?? 1,
        color: text(args.color),
        opacity: num(args.opacity) ?? 100,
        layer: text(args.layer, "fx") as Particles["layer"],
      };
      writeParticles(extra, all);
    },
  },
  {
    name: "particles-off",
    summary: "パーティクルを止める",
    positional: ["name"],
    params: {
      name: t.string("止める名前（省略するとすべて）"),
      time: t.duration("消えるまでの時間", "500ms"),
    },
    example: "@particles-off snow time=2s",
    apply(args, extra) {
      if (args.name === undefined) writeParticles(extra, {});
      else {
        const all = { ...readParticles(extra) };
        delete all[text(args.name)];
        writeParticles(extra, all);
      }
    },
  },
];
