import { argOrigin, CHAT_KEEP, CHAT_KEY, readChat, textOrigins, type Chat, type ChatMessage, type Value } from "@liminalia/runtime";
import { t, type CommandDefinition } from "@liminalia/sdk";
import { text } from "./image.ts";

/**
 * チャットアプリ風の画面（スマホのメッセージのやり取り）。@chat-open で開き、@chat で吹き出しを足し（クリックを待つ）、@chat-close で閉じる。
 * 開いている画面と吹き出しは stage.extra の "std.chat" に持ち、ロード時に組み立て直す。吹き出しは履歴にも残す。
 * ui.chat.dialogue の作品では、ふだんの台詞も同じ列に積む（実行器が積む。@liminalia/runtime の chat.ts）。
 */

export { readChat, type Chat, type ChatMessage };

export const COMMANDS: CommandDefinition[] = [
  {
    name: "chat-open",
    summary: "チャットアプリ風の画面を開く。@chat で吹き出しを追加し、@chat-close で閉じる。ui.chat.dialogue の作品では舞台いっぱいに開き、ふだんの台詞も同じ列に積む",
    positional: ["title"],
    params: {
      title: t.text("画面の上に表示する名前（相手の名前やグループ名など）。省略時は ui.chat.title", ""),
      me: t.name("自分の名前（この話者の吹き出しを右に表示する）。省略時は ui.chat.me", ""),
      clear: t.bool("前の吹き出しを消して開く", true),
    },
    example: '@chat-open ユイ me=ソウ',
    async run(args, ctx) {
      const extra = ctx.state.stage.extra;
      const now = readChat(extra);
      const dialogue = ctx.runtime.chatDialogue;
      const origins = textOrigins({ title: text(args.title) ? argOrigin(args, "title") : undefined });
      const chat: Chat = { title: text(args.title) || (dialogue?.title ?? ""), me: text(args.me) || (dialogue?.me ?? ""), messages: args.clear === false && now ? now.messages : [], ...(origins ? { i18n: origins } : {}) };
      extra[CHAT_KEY] = chat as unknown as Value;
      await ctx.present(args, false);
    },
  },
  {
    name: "chat",
    summary: "チャットに吹き出しを追加し、クリックを待つ（バックログにも残す）",
    positional: ["speaker"],
    params: {
      speaker: t.required(t.name("話者")),
      text: t.text("テキスト", ""),
      image: t.asset("image", "画像（スタンプや写真）"),
      wait: t.bool("クリックを待つ", true),
    },
    example: '@chat ユイ text="いまどこ？"',
    waits: true,
    // クリックを待っている間にセーブしたら、この吹き出しからやり直す（もう足してあれば足さない）
    async run(args, ctx) {
      ctx.resumeHere();
      const extra = ctx.state.stage.extra;
      const chat = readChat(extra) ?? { title: "", me: ctx.runtime.chatDialogue?.me ?? "", messages: [] };
      const at = `${ctx.state.position.unit}:${ctx.state.position.index}`;
      if (chat.messages.at(-1)?.at !== at) {
        const speaker = text(args.speaker);
        // 多言語: 見せる名前は訳（話者の判定は原文の名前のまま）
        const label = ctx.runtime.translator?.speaker(speaker);
        // 言語を替えたときに出し直す元（字面で書いた文字と、名前）
        const i18n = textOrigins({ text: argOrigin(args, "text"), label: speaker ? { kind: "speaker", source: speaker } : undefined });
        const messages = [...chat.messages, { speaker, ...(label && label !== speaker ? { label } : {}), text: text(args.text), image: text(args.image), me: speaker === chat.me, at, ...(i18n ? { i18n } : {}) }].slice(-CHAT_KEEP);
        extra[CHAT_KEY] = { ...chat, messages } as unknown as Value;
      }
      await ctx.present(args, typeof args.wait === "boolean" ? args.wait : true);
    },
  },
  {
    name: "chat-close",
    summary: "チャットアプリ風の画面を閉じる",
    params: {},
    example: "@chat-close",
    apply(_args, extra) {
      delete extra[CHAT_KEY];
    },
  },
];
