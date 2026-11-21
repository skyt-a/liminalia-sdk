import type { TextOrigin } from "./retranslate.ts";
import type { NvlPart, StageState } from "./state.ts";
import type { Value } from "./value.ts";

/**
 * チャットの画面の状態（stage.extra の "std.chat"）。描くのと @chat-open・@chat は @liminalia/std だが、ふだんの台詞を吹き出しにするとき
 * （ui.chat.dialogue）は、読み終えたページと選んだ選択肢を実行器が積む（NVL の段落と同じく、セーブとロード、画面なしで流す道筋の探索でも同じになるように）。
 */
export interface ChatMessage {
  speaker: string;
  text: string;
  /** 画像（image からのパス。スタンプ・写真）。 */
  image: string;
  /** 自分の吹き出し（右に出す）。 */
  me: boolean;
  /** 足した命令の位置（その命令からやり直したとき、二度足さないため）。 */
  at?: string;
  /** 地の文（中央の小さな一行）。 */
  note?: boolean;
  /** 話者名の訳（多言語）。出すのはこちら。 */
  label?: string;
  /** 本文の一片（ルビ・装飾つき。あれば text の代わりに描く）。 */
  parts?: NvlPart[];
  /** そのときの顔（キャスト名と姿）。 */
  face?: { who: string; appearance: string; variant: string };
  /** 言語を替えたときに出し直す元（text・label。retranslate.ts）。 */
  i18n?: Record<string, TextOrigin>;
}

export interface Chat {
  title: string;
  /** 自分の名前（この話者の吹き出しを右に出す）。 */
  me: string;
  messages: ChatMessage[];
  /** @chat-open を使わず、ふだんの台詞から始めた画面（ui.chat.dialogue を外した作品では出さない）。 */
  auto?: boolean;
  /** 言語を替えたときに出し直す元（title。retranslate.ts）。 */
  i18n?: Record<string, TextOrigin>;
}

/** ふだんの台詞を吹き出しにする設定（ui.chat.dialogue のとき。me と title は ui.chat の値）。 */
export interface ChatDialogue {
  me?: string;
  title?: string;
}

export const CHAT_KEY = "std.chat";
/** 残す吹き出しの数（古いものから捨てる。セーブを小さく保つ）。 */
export const CHAT_KEEP = 60;

export function readChat(extra: Record<string, Value>): Chat | null {
  return (extra[CHAT_KEY] as unknown as Chat | undefined) ?? null;
}

/** 本文をチャットに出す状態か（@nvl on・@vertical on・@balloon on の間は、いつものメッセージ枠に戻す）。 */
export function chatDialogueActive(stage: StageState): boolean {
  return stage.nvl !== true && stage.vertical !== true && !stage.balloon;
}

/** 列の終わりに吹き出しを足す（無ければ画面ごと作る）。 */
export function pushChatMessage(extra: Record<string, Value>, o: ChatDialogue | null, message: (chat: Chat) => ChatMessage): void {
  const chat = readChat(extra) ?? { title: o?.title ?? "", me: o?.me ?? "", messages: [], auto: true };
  extra[CHAT_KEY] = { ...chat, messages: [...chat.messages, message(chat)].slice(-CHAT_KEEP) } as unknown as Value;
}

/** 列を空にする（@clear）。 */
export function clearChatMessages(extra: Record<string, Value>): void {
  const chat = readChat(extra);
  if (chat) extra[CHAT_KEY] = { ...chat, messages: [] } as unknown as Value;
}

/**
 * 台詞を包む鉤括弧（「…」『…』）を、本文を出す順に外す関数を作る（吹き出しが括弧の代わりなので。入れ子の括弧は残し、（…）は心の声として残す）。
 * 本文は装飾やルビの切れ目で分かれて届くので、ページ全体を通して一つ使う。
 */
export function chatQuoteStripper(): (text: string) => string {
  let state: "start" | "inside" | "done" = "start";
  let open = "";
  let close = "";
  let depth = 0;
  return (text) => {
    let out = "";
    for (const ch of text) {
      if (state === "start") {
        state = "done";
        if (ch === "「" || ch === "『") {
          state = "inside";
          open = ch;
          close = ch === "「" ? "」" : "』";
          depth = 1;
          continue;
        }
      } else if (state === "inside") {
        if (ch === open) depth++;
        else if (ch === close && --depth === 0) {
          state = "done";
          continue;
        }
      }
      out += ch;
    }
    return out;
  };
}

/** 本文の一片の文字列（ルビは親文字だけ。絵は数えない）。 */
export function chatPartsText(parts: readonly NvlPart[]): string {
  return parts.map((p) => ("br" in p ? "\n" : p.style.image ? "" : p.text)).join("");
}
