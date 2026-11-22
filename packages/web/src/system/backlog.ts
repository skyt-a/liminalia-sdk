import type { CoSpeaker, SaveData, TextStyle, VoiceCue } from "@liminalia/runtime";
import { packSave, unpackSave, type SaveDelta } from "./rewind.ts";

/** 履歴の本文の一片。文字（ルビ・装飾つき）か改行。 */
export type LogPart = { text: string; ruby?: string; bold?: true; italic?: true; color?: string; emphasis?: true; image?: string; imageHeight?: number } | { br: true };

/** 履歴の一項目（一ページ）。 */
export interface LogEntry {
  speaker: string | null;
  /** そのページの .lim の位置。ロードで同じページを出し直したときに二重にしないため。 */
  at: { file: string; line: number };
  parts: LogPart[];
  /** そのページで鳴らしたボイス（履歴から鳴らし直す）。 */
  voice?: VoiceCue;
  /** 話者名の訳（多言語）。出すのはこちら。 */
  label?: string;
  /** 同時に話したほかの話者（二つ目のボイスの who）。名前は entryName で名前欄と同じにつなぐ。 */
  with?: CoSpeaker[];
  /** 選んだ選択肢（parts はその文）。 */
  choice?: true;
  /** そのページから読み直すセーブ（履歴から戻るとき）。新しい JUMP_KEEP 件だけが持ち、スロットのセーブには差分（rewind）にして入れる。 */
  resume?: SaveData;
  /** スロットのセーブに入れた resume（そのスロットのセーブとの差分）。ロードしたら resume に戻す。 */
  rewind?: SaveDelta;
}

/** 二人が同時に話すページの名前のつなぎ（名前欄と履歴で同じ。英語は " & "、ほかは「、」）。 */
export function joinSpeakerNames(names: readonly string[]): string {
  const english = typeof document !== "undefined" && (document.documentElement.lang || "").toLowerCase().startsWith("en");
  return names.filter((n) => n !== "").join(english ? " & " : "、");
}

/** 履歴の項目に出す名前（訳した名前と、同時に話したほかの話者を名前欄と同じにつないだもの）。地の文なら null。 */
export function entryName(e: Pick<LogEntry, "speaker" | "label" | "with">): string | null {
  const main = e.label ?? e.speaker;
  if (!e.with?.length) return main;
  return joinSpeakerNames([main ?? "", ...e.with.map((w) => w.label ?? w.speaker)]) || null;
}

/** ボイスで声を聞いた話者（ページの話者か who と、同時に鳴らしたボイスの who）。コンフィグの話者ごとの音量に出す。 */
export function voiceSpeakers(voice: VoiceCue | undefined, speaker: string | null): string[] {
  if (!voice) return [];
  const all = [voice.who ?? speaker, ...(voice.also ?? []).map((c) => c.who ?? null)];
  return [...new Set(all.filter((w): w is string => w !== null && w !== ""))];
}

/** 履歴から戻れるページの数（新しいものから。セーブを持つので多くは持たない）。 */
export const JUMP_KEEP = 100;
/** スロットのセーブに入れる、読み直すセーブの数（新しいページから。ロードしたあとも「一つ戻る」と「ここに戻る」が使える）。 */
export const REWIND_IN_SAVE = 20;

/**
 * 履歴（バックログ）。ページごとに話者と本文を溜め、上限を超えたら古いものから捨てる。
 * セーブには SlotRecord.log として末尾の一部を入れる（SaveData には入れない）。
 */
export class Backlog {
  private list: LogEntry[] = [];
  /** ロード直後。最初のページが履歴の最後と同じ位置なら、出し直しなので積まずに置き換える。 */
  private resuming = false;
  /** true の間は本文を履歴に残さない（@backlog off）。 */
  paused = false;

  constructor(readonly limit = 300) {}

  get entries(): readonly LogEntry[] {
    return this.list;
  }

  /** 今のページ（最後の項目）。 */
  get current(): LogEntry | null {
    return this.list.at(-1) ?? null;
  }

  clear(): void {
    this.list = [];
    this.resuming = false;
  }

  /**
   * セーブから戻す。次に来るページが最後の項目と同じなら置き換える。base はそのスロットのセーブで、
   * 差分にして入れた読み直すセーブ（rewind）を元に戻す（前の版のセーブには無く、そのページへは戻れない）。
   */
  restore(entries: readonly LogEntry[] | undefined, base?: SaveData): void {
    this.list = (entries ?? []).filter(isEntry).slice(-this.limit).map((e) => {
      const { rewind, resume: _, ...entry } = structuredClone(e);
      const resume = rewind && base ? unpackSave(base, rewind) : null;
      return resume ? { ...entry, resume } : entry;
    });
    this.resuming = this.list.length > 0;
  }

  page(speaker: string | null, at: { file: string; line: number }, voice?: VoiceCue, label?: string, together?: readonly CoSpeaker[]): void {
    if (this.paused) return;
    const last = this.list.at(-1);
    if (this.resuming && last && last.at.file === at.file && last.at.line === at.line) this.list.pop();
    this.resuming = false;
    this.list.push({ speaker, at: { ...at }, parts: [], ...(voice ? { voice: { ...voice } } : {}), ...(label ? { label } : {}), ...(together?.length ? { with: together.map((w) => ({ ...w })) } : {}) });
    if (this.list.length > this.limit) this.list.splice(0, this.list.length - this.limit);
  }

  text(text: string, ruby: string | null, style: TextStyle): void {
    if (this.paused) return;
    const entry = this.list.at(-1);
    if (!entry) return;
    const part: LogPart = { text };
    if (ruby !== null) part.ruby = ruby;
    if (style.bold) part.bold = true;
    if (style.italic) part.italic = true;
    if (style.color) part.color = style.color;
    if (style.emphasis) part.emphasis = true;
    if (style.image) {
      part.text = "";
      part.image = style.image;
      if (style.imageHeight) part.imageHeight = style.imageHeight;
    }
    entry.parts.push(part);
  }

  br(): void {
    if (this.paused) return;
    this.list.at(-1)?.parts.push({ br: true });
  }

  /** 本文の中で鳴らしたボイスを今のページに付ける（後から鳴らしたものが勝つ）。 */
  voice(cue: VoiceCue): void {
    if (this.paused) return;
    const entry = this.list.at(-1);
    if (entry) entry.voice = { ...cue };
  }

  /** 本文とは別に文を足す（@backlog-add）。join なら直前の項目につなげる。 */
  add(text: string, join: boolean, at: { file: string; line: number }): void {
    const last = this.list.at(-1);
    if (join && last) last.parts.push({ text });
    else this.list.push({ speaker: null, at: { ...at }, parts: [{ text }] });
    if (this.list.length > this.limit) this.list.splice(0, this.list.length - this.limit);
  }

  /** 選んだ選択肢を足す（ui.backlogChoices。@backlog off の間は足さない）。at は選択肢の位置。 */
  choice(text: string, at: { file: string; line: number }): void {
    if (this.paused || text === "") return;
    this.list.push({ speaker: null, at: { ...at }, parts: [{ text }], choice: true });
    if (this.list.length > this.limit) this.list.splice(0, this.list.length - this.limit);
  }

  /** 今のページから読み直すセーブを付ける。古いページのものは JUMP_KEEP 件を超えたら外す。 */
  attachResume(save: SaveData): void {
    const entry = this.list.at(-1);
    if (!entry || this.paused) return;
    entry.resume = save;
    const old = this.list.length - JUMP_KEEP - 1;
    if (old >= 0) delete this.list[old]!.resume;
  }

  /** 今のプレイの履歴として、そのまま入れ直す（履歴・前の選択肢から戻ったとき。戻った先のページはプレイが積み直す）。 */
  restoreKeeping(entries: readonly LogEntry[]): void {
    this.list = [...entries];
    this.resuming = false;
  }

  /** index の項目より前だけを残す（履歴から戻ったとき。戻った先のページはプレイが積み直す）。 */
  truncate(index: number): void {
    this.list = this.list.slice(0, index);
    this.resuming = false;
  }

  /**
   * セーブに入れる分（末尾から count 件）。読み直すセーブは、新しい rewind 件だけを base（そのスロットのセーブ）との差分にして入れる。
   */
  tail(count: number, rewind = 0, base?: SaveData): LogEntry[] {
    const list = this.list.slice(-count);
    const from = list.length - rewind;
    return list.map(({ resume, rewind: _, ...e }, i) => {
      const entry: LogEntry = structuredClone(e);
      if (resume && base && i >= from) entry.rewind = packSave(base, resume);
      return entry;
    });
  }
}

/** 本文の文字列（ルビは親文字だけ、改行は空白）。セーブ一覧の見出しやオートの待ち時間に使う。 */
export function plainText(entry: LogEntry | null): string {
  if (!entry) return "";
  return entry.parts.map((p) => ("br" in p ? " " : p.text)).join("");
}

/**
 * 読み上げる文（テキスト読み上げ）。ルビのある字はルビの読みで読む（傍点代わりの「・」だけのルビは親文字のまま）。
 */
export function spokenText(entry: LogEntry | null): string {
  if (!entry) return "";
  return entry.parts.map((p) => ("br" in p ? " " : p.ruby && !/^[\s・･.·]*$/.test(p.ruby) ? p.ruby : p.text)).join("");
}

function isEntry(e: unknown): e is LogEntry {
  if (!e || typeof e !== "object") return false;
  const o = e as Partial<LogEntry>;
  return Array.isArray(o.parts) && !!o.at && typeof o.at.file === "string" && typeof o.at.line === "number" && (o.speaker === null || typeof o.speaker === "string");
}
