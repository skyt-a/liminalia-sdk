import { fillHtml, scanHtml } from "@liminalia/lang";
import { display, type Args } from "@liminalia/runtime";
import { t, type CommandDefinition } from "@liminalia/sdk";
import { IMAGE_LAYERS, num, readExtra, text, writeExtra, type ImageLayer, type LayerItem } from "./image.ts";

/**
 * JS なしの HTML を前景レイヤーに置く（@html … @end）と、消す（@html-hide）。
 *
 * 中身の `{= 式}` は出すときに評価し、評価し終えた HTML を前景レイヤーの項目（kind "html"）として stage.extra の
 * 画像の一覧に積む。だからロードで同じ表示に組み立て直せ、@free-image でも消える。JS は書けない
 * （実行の前に確かめられず、セーブに残らない形で画面を変えてしまうため）。使えるタグと属性は @liminalia/lang の html.ts。
 *
 * 押して飛ぶ要素（data-jump="#ラベル"）は wait=true のときだけ押せる。押すまで次へ進まず、押したらそこへ飛ぶ
 * （選択肢と同じ。data-jump の要素が無ければ、表示し終わるのを待つだけ）。待っている間にセーブすると、この @html から再開する。画面なしで流すとき（道筋の探索・網羅・lim trace）は、
 * data-jump の要素を選択肢として選ばせる。wait=false の @html は表示だけで、data-jump は押せない（検査が警告する）。
 */

/** レイヤーに置いた HTML。html は `{= 式}` を評価し終えたもの。 */
export interface HtmlItem {
  kind: "html";
  name: string;
  html: string;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
}

export function htmlItem(args: Args, html: string): HtmlItem {
  return { kind: "html", name: text(args.name), html, x: num(args.x) ?? 0, y: num(args.y) ?? 0, width: num(args.width), height: num(args.height) };
}

/** 同じ名前の HTML をどのレイヤーからも外す（name が空なら HTML をすべて）。 */
function removeHtml(images: Partial<Record<ImageLayer, LayerItem[]>>, name: string): void {
  for (const l of IMAGE_LAYERS) {
    const list = images[l];
    if (!list) continue;
    const left = list.filter((i) => i.kind !== "html" || (name !== "" && i.name !== name));
    if (left.length > 0) images[l] = left;
    else delete images[l];
  }
}

const htmlCommand: CommandDefinition = {
  name: "html",
  summary: "JS なしの HTML（カード・表・押して飛ぶボタンなど）を前景レイヤーに置く。@html の行と @end の行のあいだに HTML を書く。@html-hide で消すまで残る",
  positional: ["name"],
  params: {
    name: t.string("名前（@html-hide で消すときや、@anim で動かすときに使う。同じ名前の @html は置き換える）"),
    x: t.number("左端（px）", "0"),
    y: t.number("上端（px）", "0"),
    width: t.number("幅（px）。省略時は中身の幅"),
    height: t.number("高さ（px）。省略時は中身の高さ"),
    layer: t.enum([...IMAGE_LAYERS], "置くレイヤー（fg0〜fg2）", "fg2"),
    time: t.duration("表示にかける時間", "0ms"),
    wait: t.bool("押して飛ぶ要素（data-jump）が押されるまで次に進まず、押されたらそこへ飛ぶ（選択肢と同じ）", false),
    skip: t.skip(),
  },
  example: '@html notice x=100 y=80 width=600 time=300ms wait=true\n<div class="card">今日は {= game.day} 日目</div>\n<button data-jump="#market">市場へ</button>\n@end',
  async run(args, ctx) {
    const body = ctx.body ?? "";
    const scan = scanHtml(body);
    const html = fillHtml(body, scan.values, (v) => display(ctx.runtime.eval(v.expr)));
    const extra = ctx.state.stage.extra;
    const images = { ...(readExtra(extra, "images") ?? {}) };
    const item = htmlItem(args, html);
    // 同じ名前のものは置き換える（待っている間のセーブから再開したときに二つにならないように）
    if (item.name !== "") removeHtml(images, item.name);
    const layer = text(args.layer, "fg2") as ImageLayer;
    images[layer] = [...(images[layer] ?? []), item as unknown as LayerItem];
    writeExtra(extra, "images", images);
    const presented = { ...args, html };
    // 押して飛ぶ要素が無ければ、wait=true は表示し終わるのを待つだけ（検査が警告する）
    if (args.wait !== true || scan.jumps.length === 0) {
      await ctx.present(presented, args.wait === true);
      return;
    }
    ctx.resumeHere();
    const file = ctx.state.position.unit.split("::")[0]!;
    const outcomes = scan.jumps.map((j) => ({ label: j.label, target: j.target.startsWith("#") ? `${file}${j.target}` : j.target, value: j.target }));
    // 描画側は押した要素の data-jump を返す。画面なしなら一覧を選択肢として選ばせる
    const answer = await ctx.present(presented, true);
    const target = await ctx.pick(outcomes, typeof answer === "string" && outcomes.some((o) => o.value === answer) ? answer : null);
    if (target === null) {
      ctx.runtime.stop();
      return;
    }
    await ctx.runtime.jump(target);
  },
  // 押して飛ぶ先は引数ではなく中身にあるので、地図には lang の story-map が中身から読んで矢印を引く
};

const htmlHideCommand: CommandDefinition = {
  name: "html-hide",
  summary: "@html で置いた HTML を消す（名前を省くと @html で置いたものをすべて）",
  positional: ["name"],
  params: {
    name: t.string("消す @html の名前。省くとすべて"),
    time: t.duration("消すのにかける時間", "0ms"),
    wait: t.bool("消し終わるまで次に進まない", true),
    skip: t.skip(),
  },
  example: "@html-hide notice time=300ms",
  apply(args, extra) {
    const images = { ...(readExtra(extra, "images") ?? {}) };
    removeHtml(images, text(args.name));
    writeExtra(extra, "images", images);
  },
};

export const COMMANDS: CommandDefinition[] = [htmlCommand, htmlHideCommand];
