import type { Value } from "@liminalia/runtime";
import { t, type CommandDefinition } from "@liminalia/plugin-host";

/**
 * 立ち絵に付いて動く漫符（@emote・@emote-off）。汗、怒り、驚き、疑問、ハート、きらめき、音符と、作品の画像。
 * 置き場所は立ち絵の頭（絵から頭頂と顎を推し量る。頭の大きさを揃えるときと同じ測り方）からの位置で、立ち絵が動けば一緒に動く。
 * 状態は立ち絵の extra（"std.emote"）に持つので、表情を替えても残り、立ち絵を消すと一緒に消える。セーブとロードでも出し直す。
 * time= を書くと、その時間だけ出して消える一回きりの演出（状態に残さない。スキップ中は出さない）。
 */

export const EMOTE_TYPES = ["sweat", "anger", "surprise", "question", "heart", "sparkle", "music", "image"] as const;
export type EmoteType = (typeof EMOTE_TYPES)[number];
export const EMOTE_AT = ["auto", "head", "head-left", "head-right", "face"] as const;

/** 立ち絵の extra の鍵。 */
export const EMOTE_KEY = "std.emote";

/** 立ち絵に付けた漫符。 */
export interface Emote {
  type: EmoteType;
  at: (typeof EMOTE_AT)[number];
  /** 置き場所からのずれ（px）。 */
  x?: number;
  y?: number;
  /** 大きさ（px）。省くと頭の大きさから決める。 */
  size?: number;
  color?: string;
  /** 作品の画像（type=image。image フォルダからのパス）。 */
  image?: string;
}

/** 種類ごとの既定の置き場所。 */
export const EMOTE_DEFAULT_AT: Record<EmoteType, Exclude<Emote["at"], "auto">> = {
  sweat: "head-right",
  anger: "head-right",
  surprise: "head",
  question: "head",
  heart: "head-left",
  sparkle: "face",
  music: "head-left",
  image: "head",
};

export function emoteFrom(args: Record<string, Value>): Emote {
  const e: Emote = { type: (EMOTE_TYPES as readonly string[]).includes(String(args.type)) ? (args.type as EmoteType) : "sweat", at: (EMOTE_AT as readonly string[]).includes(String(args.at)) ? (args.at as Emote["at"]) : "auto" };
  if (typeof args.x === "number" && args.x !== 0) e.x = args.x;
  if (typeof args.y === "number" && args.y !== 0) e.y = args.y;
  if (typeof args.size === "number") e.size = args.size;
  if (typeof args.color === "string" && args.color !== "") e.color = args.color;
  if (typeof args.image === "string" && args.image !== "") e.image = args.image;
  return e;
}

const emoteCommand: CommandDefinition = {
  name: "emote",
  summary: "立ち絵に漫符を付ける（汗、怒り、驚き、疑問、ハート、きらめき、音符、作品の画像）。立ち絵と一緒に動き、表情を替えても残り、立ち絵を消すと消える。time= ならその時間だけ出して消す",
  positional: ["who", "type"],
  params: {
    who: { type: { kind: "cast", shown: true }, required: true, doc: "キャラクター ID（出ている立ち絵に付ける）" },
    type: t.required(t.enum([...EMOTE_TYPES], "漫符の種類（sweat 汗、anger 怒り、surprise 驚き、question 疑問、heart ハート、sparkle きらめき、music 音符、image は image= の画像）")),
    at: t.enum([...EMOTE_AT], "置き場所（head は頭の上、head-left と head-right は頭の横、face は顔。auto は種類ごとの決まった所。左右は画面から見た向き）", "auto"),
    x: t.number("置き場所からの横のずれ（px）", "0"),
    y: t.number("置き場所からの縦のずれ（px）", "0"),
    size: t.number("大きさ（px。省くと頭の大きさから決める）"),
    color: t.color("色（省くと種類ごとの色）"),
    image: t.asset("image", "作品の画像（type=image のとき）"),
    time: t.duration("この時間だけ出して消す（一回きりの演出。状態に残さない）。省くと @emote-off か立ち絵を消すまで"),
    wait: t.bool("time= のとき、消えるまで次に進まない", false),
    skip: t.skip(),
  },
  example: "@emote ユイ sweat at=head-right",
  exampleEn: "@emote Akari sweat at=head-right",
  waits: false,
  async run(args, ctx) {
    const who = String(args.who ?? "");
    const sprite = ctx.state.stage.sprites[who];
    // 出ていない人物には付けない（知らせて続ける）
    if (!sprite) {
      ctx.runtime.report("warning", "emote-hidden", `@emote ${who}: ${who} の立ち絵が出ていないので、漫符を付けません`);
      return;
    }
    if (typeof args.time !== "number") sprite.extra = { ...sprite.extra, [EMOTE_KEY]: emoteFrom(args) as unknown as Value };
    await ctx.present(args, typeof args.time === "number" && args.wait === true);
  },
};

const emoteOffCommand: CommandDefinition = {
  name: "emote-off",
  summary: "@emote で付けた漫符を外す（人物を省くとすべて）",
  positional: ["who"],
  params: {
    who: { type: { kind: "cast", shown: true }, doc: "キャラクター ID（省くとすべての立ち絵）" },
  },
  example: "@emote-off ユイ",
  exampleEn: "@emote-off Akari",
  async run(args, ctx) {
    const sprites = ctx.state.stage.sprites;
    for (const [who, sprite] of Object.entries(sprites)) {
      if (args.who !== undefined && who !== args.who) continue;
      if (!sprite.extra?.[EMOTE_KEY]) continue;
      const { [EMOTE_KEY]: _gone, ...rest } = sprite.extra;
      if (Object.keys(rest).length > 0) sprite.extra = rest;
      else delete sprite.extra;
    }
    await ctx.present(args, false);
  },
};

export const COMMANDS: CommandDefinition[] = [emoteCommand, emoteOffCommand];

/** 立ち絵に付いた漫符（無ければ null）。 */
export function emoteOf(sprite: { extra?: Record<string, Value> } | undefined): Emote | null {
  const v = sprite?.extra?.[EMOTE_KEY];
  return v && typeof v === "object" && !Array.isArray(v) && typeof (v as { type?: unknown }).type === "string" ? (v as unknown as Emote) : null;
}
