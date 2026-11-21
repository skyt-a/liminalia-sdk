import { t, type CommandDefinition } from "@liminalia/sdk";

/**
 * 漫画的な一回きりの演出（@speedlines・@burst）。状態には残さず、描画側が出して片付ける（RenderContext.scope）。
 * クリックの早送りで終わり、スキップ中は出さない。
 * ヒットストップは @flash hitstop=、行って戻るカメラは @camera yoyo=true。
 */

const LAYER_DOC = "置く層（fx はメッセージ枠の下、overlay はメッセージ枠も覆う）";

const speedlinesCommand: CommandDefinition = {
  name: "speedlines",
  summary: "集中線（中心へ向かう線）か流線（一方向へ流れる線）をしばらく出す。勢い、驚き、走る、迫る場面に使う",
  positional: ["type"],
  params: {
    type: t.enum(["focus", "flow"], "線の種類（focus は中心へ向かう集中線、flow は一方向へ流れる流線）", "focus"),
    dir: t.enum(["left", "right", "up", "down"], "流線の流れる向き（flow のとき）", "left"),
    x: t.number("集中線の中心の横の位置（px。省くと画面の中央）"),
    y: t.number("集中線の中心の縦の位置（px。省くと画面の中央）"),
    inner: t.number("集中線の真ん中の、線の無い所の大きさ（画面の小さいほうの辺に対する割合。0〜0.9）", "0.35"),
    density: t.number("線の多さ（0〜1）", "0.5"),
    color: t.color("線の色", "#000000"),
    opacity: t.number("不透明度（0〜1）", "0.8"),
    time: t.duration("出しておく時間（出入りを含む）", "800ms"),
    layer: t.enum(["fx", "overlay"], LAYER_DOC, "fx"),
    wait: t.bool("消えるまで次に進まない", false),
    skip: t.skip(),
  },
  example: "@speedlines focus x=640 y=300 time=700ms",
  waits: false,
};

const burstCommand: CommandDefinition = {
  name: "burst",
  summary: "衝撃のギザギザ（爆発の吹き出しの形）を弾けるように出して消す。text= で擬音（ドン、バン）を載せられる",
  params: {
    x: t.number("中心の横の位置（px。省くと画面の中央）"),
    y: t.number("中心の縦の位置（px。省くと画面の中央）"),
    size: t.number("大きさ（px）", "360"),
    spikes: t.int("とげの数", "14"),
    color: t.color("塗りの色", "#ffffff"),
    edge: t.color("縁の色", "#000000"),
    text: t.text("載せる擬音（ドン、バン など）"),
    "text-color": t.color("擬音の色", "#000000"),
    rotate: t.number("傾き（度）", "-8"),
    time: t.duration("出しておく時間（弾けてから消え始めるまで）", "500ms"),
    layer: t.enum(["fx", "overlay"], LAYER_DOC, "overlay"),
    wait: t.bool("消えるまで次に進まない", false),
    skip: t.skip(),
  },
  example: "@burst x=900 y=260 text=ドン！ size=300",
  exampleEn: "@burst x=900 y=260 text=BAM! size=300",
  waits: false,
};

export const COMMANDS: CommandDefinition[] = [speedlinesCommand, burstCommand];
