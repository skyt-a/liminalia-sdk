import { castForSpeaker } from "@liminalia/lang";
import { CHAT_KEEP, type Chat, type ChatMessage, type StageState, type Value } from "@liminalia/runtime";
import type { DialogueView, Renderer, RenderContext, Restorer } from "@liminalia/web";
import * as C from "../commands/chat.ts";
import "./chat.css";

/**
 * チャットアプリ風の画面の描画。
 * - @chat-open・@chat だけの作品は、メッセージ枠の上の overlay に端末の形の画面を置く
 * - ui.chat.dialogue の作品は、舞台いっぱいの画面をメッセージ枠の手前（暗転と選択肢の下）に置き、台詞と地の文もここに積む（dialogue）
 */

type Args = Record<string, Value>;

/** 舞台いっぱいに出す作品か。 */
const fills = (ctx: RenderContext) => ctx.ui?.chat?.dialogue === true;

/** 開いている画面（閉じる途中で消えていくものは入れない。次の本文を消えていく画面に足さないように）。 */
function panel(ctx: RenderContext): HTMLElement | null {
  return ctx.stage.querySelector<HTMLElement>(":scope > .lim-chat:not(.is-closing), :scope > .overlay > .lim-chat:not(.is-closing)");
}

const listOf = (root: HTMLElement) => root.querySelector<HTMLElement>(".lim-chat-list")!;

function appear(ctx: RenderContext, row: HTMLElement): void {
  if (!ctx.skipping) row.animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], { duration: 220, easing: "ease-out" });
}

/** 列の終わりが見えるように送る。 */
function toEnd(root: HTMLElement | null): void {
  if (!root) return;
  const list = listOf(root);
  list.scrollTop = list.scrollHeight;
}

/** 新しい吹き出しを足す（古いものは状態と同じ数で捨てる。読んでいるページの分を一つ多く持つ）。 */
function add(list: HTMLElement, row: HTMLElement): void {
  list.append(row);
  while (list.childElementCount > CHAT_KEEP + 1) list.firstElementChild!.remove();
}

/** 顔の丸（キャストの顔。無ければ名前の一文字目）。 */
function faceOf(ctx: RenderContext, m: Pick<ChatMessage, "speaker" | "label" | "face">): HTMLElement {
  const el = document.createElement("span");
  el.className = "lim-chat-face";
  el.textContent = [...(m.label ?? m.speaker)][0] ?? "";
  const color = ctx.host.nameColor(m.speaker);
  if (color) el.style.backgroundColor = color;
  // 姿が分からなければ、そのキャストの既定の姿
  const who = m.face?.who ?? castForSpeaker(ctx.cast, m.speaker);
  if (who) {
    void ctx.host.castFace(who, m.face ?? { appearance: "", variant: "" }).then(
      (url) => {
        if (!url) return;
        const img = document.createElement("img");
        img.src = url;
        img.alt = "";
        el.replaceChildren(img);
        el.style.removeProperty("background-color");
      },
      () => undefined,
    );
  }
  return el;
}

/** 吹き出しの行（中身は入れない）。前の行と同じ話者なら、作品の設定によって名前と顔を省く。 */
function rowFor(ctx: RenderContext, m: ChatMessage, list: HTMLElement | null): { row: HTMLElement; bubble: HTMLElement } {
  const row = document.createElement("div");
  row.className = `lim-chat-row${m.me ? " is-me" : ""}`;
  if (m.at) row.dataset.at = m.at;
  const c = ctx.ui?.chat;
  const last = list?.lastElementChild as HTMLElement | null | undefined;
  const same = !m.me && last?.dataset.speaker === m.speaker;
  if (!m.me) {
    row.dataset.speaker = m.speaker;
    if (c?.showFace) {
      row.classList.add("has-face");
      if (same) row.classList.add("is-next");
      row.append(faceOf(ctx, m));
    }
    if (c?.showName !== "none" && !(c?.showName === "first" && same)) {
      const name = document.createElement("span");
      name.className = "lim-chat-name";
      name.textContent = m.label ?? m.speaker;
      // ふだんの台詞の名前は、枠の名前と同じくキャストの色
      if (fills(ctx)) name.style.color = ctx.host.nameColor(m.speaker);
      row.append(name);
    }
  }
  const bubble = document.createElement("div");
  bubble.className = `lim-chat-bubble${m.image ? " has-image" : ""}`;
  row.append(bubble);
  return { row, bubble };
}

/** 吹き出しの中身。 */
function fill(ctx: RenderContext, bubble: HTMLElement, m: ChatMessage): void {
  if (m.parts) ctx.host.writeParts(bubble, m.parts, !m.note);
  else if (m.text) bubble.append(m.text);
  if (m.image) {
    const img = document.createElement("img");
    img.src = ctx.asset("image", m.image);
    img.alt = "";
    bubble.append(img);
  }
}

function noteRow(): HTMLElement {
  const el = document.createElement("div");
  el.className = "lim-chat-note";
  return el;
}

/** 読み終えた吹き出し。 */
function messageRow(ctx: RenderContext, m: ChatMessage, list: HTMLElement | null): HTMLElement {
  if (m.note) {
    const note = noteRow();
    fill(ctx, note, m);
    return note;
  }
  const { row, bubble } = rowFor(ctx, m, list);
  fill(ctx, bubble, m);
  return row;
}

/** 相手の吹き出しの前の「…」。出す長さのあいだ待ってから、吹き出しを空に戻す。 */
async function showTyping(ctx: RenderContext, root: HTMLElement, bubble: HTMLElement): Promise<void> {
  const ms = ctx.ui?.chat?.typing ?? 0;
  if (ms <= 0 || ctx.skipping || ctx.studio) return;
  bubble.classList.add("is-typing");
  bubble.append(...[0, 1, 2].map(() => Object.assign(document.createElement("i"), { className: "lim-chat-dot" })));
  toEnd(root);
  await ctx.host.pause(ms);
  bubble.classList.remove("is-typing");
  bubble.replaceChildren();
}

/** 画面を今の状態に合わせて組み直す。 */
function build(ctx: RenderContext, chat: Chat): HTMLElement {
  for (const old of ctx.stage.querySelectorAll(":scope > .lim-chat, :scope > .overlay > .lim-chat")) old.remove();
  const root = document.createElement("div");
  root.className = "lim-chat";
  const head = document.createElement("div");
  head.className = "lim-chat-head";
  head.textContent = chat.title;
  const list = document.createElement("div");
  list.className = "lim-chat-list";
  for (const m of chat.messages) list.append(messageRow(ctx, m, list));
  root.append(head, list);
  if (fills(ctx)) {
    root.classList.add("is-dialogue");
    // @chat-open で開いた画面は @window hide でも隠さない（今までの書き方の @window hide → @chat-open）
    if (!chat.auto) root.classList.add("is-opened");
    ctx.message.root.before(root);
  } else ctx.layers.overlay.append(root);
  list.scrollTop = list.scrollHeight;
  return root;
}

export const renderers: Record<string, Renderer> = {
  "chat-open": (ctx, _a, _wait, stage) => {
    const chat = C.readChat(stage.extra);
    if (!chat) return;
    const root = build(ctx, chat);
    if (ctx.skipping) return;
    const from = fills(ctx) ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: "translate(-50%, -46%)" }, { opacity: 1, transform: "translate(-50%, -50%)" }];
    root.animate(from, { duration: 260, easing: "ease-out" });
  },
  chat: async (ctx, a: Args, wait, stage) => {
    const chat = C.readChat(stage.extra);
    if (!chat) return;
    const root = panel(ctx) ?? build(ctx, { ...chat, messages: chat.messages.slice(0, -1) });
    const list = listOf(root);
    const m = chat.messages.at(-1)!;
    const last = list.lastElementChild as HTMLElement | null;
    // ロードで組み直した画面には、この吹き出しがもうある（その命令からやり直したとき）
    if (!m.at || last?.dataset.at !== m.at) {
      const { row, bubble } = rowFor(ctx, m, list);
      add(list, row);
      appear(ctx, row);
      if (!m.me) await showTyping(ctx, root, bubble);
      fill(ctx, bubble, m);
      if (fills(ctx)) ctx.host.setTextTarget(bubble);
    } else if (fills(ctx)) ctx.host.setTextTarget(last.querySelector<HTMLElement>(".lim-chat-bubble") ?? ctx.message.text);
    list.scrollTo({ top: list.scrollHeight, behavior: ctx.skipping ? "auto" : "smooth" });
    // バックログに残す
    void ctx.host.systemRequest?.({ name: "backlog-add", args: { text: `${m.label ?? m.speaker}「${m.text || "（画像）"}」` } });
    if (wait && a.wait !== false) await ctx.waitClick();
  },
  // 選択肢で選んだ文（実行器が列に積んだもの）を、自分の吹き出しとして足す
  "chat-chosen": (ctx, _a, _wait, stage) => {
    const chat = C.readChat(stage.extra);
    const m = chat?.messages.at(-1);
    if (!chat || !m) return;
    const root = panel(ctx) ?? build(ctx, { ...chat, messages: chat.messages.slice(0, -1) });
    const list = listOf(root);
    const row = messageRow(ctx, m, list);
    add(list, row);
    appear(ctx, row);
    toEnd(root);
  },
  "chat-close": (ctx) => {
    const root = panel(ctx);
    if (!root) return;
    if (ctx.skipping) return root.remove();
    root.classList.add("is-closing");
    void root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200 }).finished.then(() => root.remove());
  },
};

/** まだ何も積んでいない画面（ふだんの台詞から始める）。 */
function emptyChat(ctx: RenderContext): Chat {
  const c = ctx.ui?.chat;
  return { title: c?.title ?? "", me: c?.me ?? "", messages: [], auto: true };
}

export const dialogue: DialogueView = {
  async page(ctx, p, stage: StageState) {
    const chat = C.readChat(stage.extra);
    const c = ctx.ui?.chat;
    const root = panel(ctx) ?? build(ctx, chat ?? emptyChat(ctx));
    const list = listOf(root);
    if (p.speaker === null) {
      const note = noteRow();
      add(list, note);
      appear(ctx, note);
      toEnd(root);
      return note;
    }
    const me = p.speaker === (chat?.me || c?.me);
    const who = castForSpeaker(ctx.cast, p.speaker);
    const pose = who ? (stage.sprites[who] ?? stage.faces?.[who]) : undefined;
    const { row, bubble } = rowFor(ctx, { speaker: p.speaker, text: "", image: "", me, ...(p.label ? { label: p.label } : {}), ...(who && pose ? { face: { who, appearance: pose.appearance, variant: pose.variant } } : {}) }, list);
    row.classList.toggle("is-read", p.read);
    add(list, row);
    appear(ctx, row);
    toEnd(root);
    if (!me && !p.read && !p.instant) await showTyping(ctx, root, bubble);
    return bubble;
  },
  follow(ctx) {
    toEnd(panel(ctx));
  },
  choosing(ctx, on, layer) {
    const style = ctx.stage.style;
    const first = layer.firstElementChild;
    if (!on || !first) {
      style.removeProperty("--chat-reply-h");
      return;
    }
    // 本文より先に選択肢が出ても、チャットの画面の上に並べる
    if (!panel(ctx)) build(ctx, emptyChat(ctx));
    // 帯の高さ（舞台の拡大と、文字と枠の拡大を除いた長さ）。列はその分だけ下を空ける
    const scale = (ctx.stage.getBoundingClientRect().width / (ctx.stage.offsetWidth || 1)) * ctx.uiScale || 1;
    const top = first.getBoundingClientRect().top;
    style.setProperty("--chat-reply-h", `${Math.ceil((layer.getBoundingClientRect().bottom - top) / scale) + 18}px`);
    toEnd(panel(ctx));
  },
  clear(ctx) {
    panel(ctx)?.querySelector(".lim-chat-list")?.replaceChildren();
  },
};

/**
 * 言語を替えたとき、出している画面の題と吹き出しを今の言語で作り直す。読んでいる途中のページの吹き出し（列の終わりの、状態にまだ無いもの）は
 * 同じ要素のまま残す（本文がそこへ出ているため）。
 */
export const relocalizers: Restorer[] = [
  (ctx: RenderContext, stage: StageState) => {
    const root = panel(ctx);
    const chat = C.readChat(stage.extra);
    if (!root || !chat) return;
    const head = root.querySelector<HTMLElement>(".lim-chat-head");
    if (head) head.textContent = chat.title;
    const list = listOf(root);
    const reading = [...list.children].slice(chat.messages.length);
    const top = list.scrollTop;
    const atEnd = list.scrollTop + list.clientHeight >= list.scrollHeight - 4;
    list.replaceChildren();
    for (const m of chat.messages) list.append(messageRow(ctx, m, list));
    list.append(...reading);
    list.scrollTop = atEnd ? list.scrollHeight : top;
  },
];

export const restorers: Restorer[] = [
  (ctx: RenderContext, stage: StageState) => {
    panel(ctx)?.remove();
    const chat = C.readChat(stage.extra);
    // ふだんの台詞から始めた画面は、ui.chat.dialogue を外した作品には出さない（端末の形の画面が閉じられずに残るので）
    if (chat && (!chat.auto || fills(ctx))) build(ctx, chat);
  },
];
