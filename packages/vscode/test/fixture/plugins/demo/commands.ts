import { defineCommandPlugin, t } from "@liminalia/sdk";

// 拡張機能のテストの見本のプラグイン。画面を光らせる命令だけを持つ。
export default defineCommandPlugin({
  name: "demo",
  commands: [
    {
      name: "glint",
      summary: "画面を一瞬光らせる",
      params: {
        color: t.color("光の色", "#ffffff"),
        time: t.duration("光っている時間", "200ms"),
      },
      example: "@glint color=#ffeeaa time=300ms",
    },
  ],
});
