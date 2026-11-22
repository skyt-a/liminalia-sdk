import type { CastEntry } from "@liminalia/lang";
import { applySpeakerText } from "../ui-style.ts";
import { entryName, type LogEntry, type LogPart } from "./backlog.ts";
import { TEXT } from "./strings.ts";
import type { ScreenTemplates, TemplateItem } from "./template.ts";
import { el } from "./ui.ts";

/**
 * 履歴画面を、型（標準か、作品が写して直した ui.templates.backlog。screens/backlog.ts）から作る。
 * 話者と本文（ルビ、装飾、改行込み）を古い順に並べ、開いたら一番下（最新）を見せる。一番下でさらにホイールを下へ回すと閉じる。
 * ボイスのあるページには再生のボタンを付ける（play を渡したとき）。
 * 上の欄で話者と本文を探せる（当たったページだけで一覧を作り直し、当たったページに印を付ける）。
 * 作品の画面の JS（ui/screens/backlog/backlog.js）があれば呼ぶ。閉じるときに dispose を呼ぶ。
 */
export interface BacklogViewOptions {
  /** 話者の名前の色（キャストの color）。 */
  color?(speaker: string): string;
  /** 話者の台詞の文字の見た目（cast.json の text。本文に当てる）。 */
  textStyle?(speaker: string): CastEntry["text"];
  /** そのページへ戻る操作（戻れなければ null）。 */
  jump?(entry: LogEntry, index: number): (() => void) | null;
  /** 本文の中の画像（{img …}）の URL（image フォルダからのパス）。無ければ画像は出さない。 */
  image?(path: string): string;
}

export function createBacklogView(templates: ScreenTemplates, entries: readonly LogEntry[], close: () => void, play?: (entry: LogEntry) => void, o: BacklogViewOptions = {}): { el: HTMLElement; dispose(): void } {
  const T = TEXT.backlog;
  const plain = (e: LogEntry) => e.parts.map((p) => ("br" in p ? "\n" : p.text)).join("");
  /** 探す文字（話者と本文。小文字にしたもの）。 */
  const haystack = entries.map((e) => `${e.choice ? "" : (entryName(e) ?? "")}\u0000${plain(e)}`.toLowerCase());
  /** 今並べているページの番号。 */
  let shown = entries.map((_, i) => i);
  let query = "";

  const row = (index: number): TemplateItem => {
    const e = entries[index]!;
    const jump = o.jump?.(e, index) ?? null;
    return {
      // 選んだ選択肢は、話者の欄に「選択肢」と出す
      fields: { name: e.choice ? T.choice : (entryName(e) ?? T.narration), text: plain(e), "voice-label": T.playVoice, "jump-title": T.jumpTitle },
      roles: { voice: e.voice && play ? () => play(e) : null, jump },
      state: { choice: !!e.choice, narration: !e.choice && !e.speaker, hit: query !== "" },
    };
  };
  const rows = (): TemplateItem[] => (entries.length === 0 ? [{ part: "empty" }] : shown.map(row));

  const view = templates.screen("backlog", {
    fields: { "search-label": T.search, count: "" },
    roles: { close },
    lists: { entries: rows() },
  });
  const root = view.el;
  const list = root.querySelector<HTMLElement>("[data-list=entries]") ?? view.items("entries")[0]?.parentElement ?? root;

  /** 本文（ルビ、装飾、絵）、話者の色、人物ごとの文字の見た目、前からの CSS のためのクラスを付ける。 */
  function decorate(): void {
    if (entries.length === 0) return;
    view.items("entries").forEach((r, i) => {
      const e = entries[shown[i]!]!;
      const text = r.querySelector<HTMLElement>("[data-field=text]");
      if (text) {
        // 人物ごとの台詞の文字の見た目（メッセージ枠と同じ。本文の中の飾りが先）
        if (e.speaker && o.textStyle && !e.choice) applySpeakerText(text, o.textStyle(e.speaker));
        text.replaceChildren(...e.parts.map((p) => renderPart(p, o.image)));
      }
      // 選んだ選択肢は本文をアクセントカラーにする（CSS）。話者の名前は話者の色
      const name = r.querySelector<HTMLElement>("[data-field=name]");
      if (name && e.speaker && o.color && !e.choice) name.style.color = o.color(e.speaker);
      if (e.choice) r.classList.add("lm-log-choice");
      else if (!e.speaker) r.classList.add("lm-narration");
      if (query !== "") r.classList.add("is-hit");
    });
  }
  decorate();

  // 探す（話者と本文。当たったページだけ並べる）
  const search = root.querySelector<HTMLInputElement>("input[data-input=search]");
  search?.addEventListener("input", () => {
    query = search.value.trim().toLowerCase();
    shown = entries.map((_, i) => i).filter((i) => query === "" || haystack[i]!.includes(query));
    view.list("entries", rows());
    decorate();
    view.update({ count: query === "" ? "" : T.hits(shown.length) });
    list.scrollTop = list.scrollHeight;
  });
  search?.addEventListener("keydown", (e) => {
    // 入力中の Esc は探す文字を消すだけ（二度目で閉じる）
    if (e.key === "Escape" && search.value !== "") {
      e.stopPropagation();
      search.value = "";
      search.dispatchEvent(new Event("input"));
    }
  });

  const openedAt = performance.now();
  list.addEventListener("wheel", (e) => {
    const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 2;
    // 開いた直後のホイール（開くのに使った分の慣性）では閉じない
    if (e.deltaY > 0 && atBottom && performance.now() - openedAt > 400) close();
  });
  const first = view.autofocus;
  requestAnimationFrame(() => {
    list.scrollTop = list.scrollHeight;
    first?.focus({ preventScroll: true });
  });
  return { el: root, dispose: view.dispose };
}

function renderPart(p: LogPart, image?: (path: string) => string): Node {
  if ("br" in p) return el("br");
  let node: HTMLElement;
  if (p.image !== undefined) {
    if (!image) return document.createTextNode("");
    const img = el("img", "lm-inline-image") as HTMLImageElement;
    img.src = image(p.image);
    img.alt = "";
    if (p.imageHeight) img.style.height = `${p.imageHeight}px`;
    return img;
  }
  if (p.ruby !== undefined) {
    node = el("ruby", "", p.text, el("rt", "", p.ruby));
  } else {
    node = el("span", "", p.text);
  }
  if (p.bold) node.style.fontWeight = "bold";
  if (p.italic) node.style.fontStyle = "italic";
  if (p.color) node.style.color = p.color;
  if (p.emphasis) node.classList.add("lm-emphasis");
  return node;
}
