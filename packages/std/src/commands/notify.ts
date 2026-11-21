import { t, type CommandDefinition } from "@liminalia/sdk";

/**
 * 積み上げる通知（@notify）。描画側の RenderContext.notify に渡す。出した通知は状態（セーブ）に残さず、ロードで消える。
 * when=scene-break は場面の切れ目まで待たせる（実行器の ctx.atSceneBreak。待っている間はセーブに入り、切れ目を過ぎた次の本文か選択肢の前に出す）。
 * 見た目は CSS（.lm-notice）か WebPlugin.screens.toast で変える。
 */
const notifyCommand: CommandDefinition = {
  name: "notify",
  summary: "通知を出す（右上に積み上げる。同じ文が出ていれば一つにまとめ、全画面の演出の間は出すのを待つ）。終わりを待たない。when=scene-break なら場面の切れ目まで待って出す",
  positional: ["text"],
  params: {
    text: t.required(t.string("通知の文")),
    kind: t.string("種類（見た目を分ける。info・success・warning・error か、作品の CSS で決めた名前）", "info", ["info", "success", "warning", "error"]),
    title: t.string("見出し"),
    time: t.duration("出しておく時間", "3s"),
    delay: t.duration("出すまでの時間", "0ms"),
    se: t.asset("sound", "出すときに鳴らす効果音"),
    max: t.int("同時に積む上限（超えたら古いものから下げる）", "3"),
    key: t.string("重なりを一つにする鍵（省くと文。同じ鍵の通知は出し直して時間を延ばす）"),
    when: t.enum(["now", "scene-break"], "出す時機。now はすぐ出す。scene-break は場面の切れ目（@scene-change、別の背景の @bg、@mask、@jump と選択肢でほかのファイルへ移る）を過ぎたあと、次の本文か選択肢の前に出す。出すのを待っている間にセーブとロードをしても消えない", "now"),
  },
  example: "@notify 手帳に新しい頁が加わった kind=success when=scene-break",
  run: async (args, ctx) => {
    if (args.when === "scene-break") ctx.atSceneBreak(args);
    else await ctx.present(args, false);
  },
};

export const COMMANDS: CommandDefinition[] = [notifyCommand];
