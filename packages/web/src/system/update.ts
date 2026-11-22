import { TEXT } from "./strings.ts";

/**
 * アップデートの確認（デスクトップ版で liminalia.json の build.update があるとき）。
 * デスクトップ版の main.cjs がマニフェストを取り寄せて何を更新できるかを決め、ここではプレイヤーに尋ねて、
 * 答えに合わせて更新させる（パックは入れて再起動を促す、本体はインストーラーか入れ替え（Mac・Linux）かダウンロードのページへ）。
 * 尋ねるのは標準のシステム画面の確認のダイアログ（作品が差し替えていればそれ）。
 */

/** 説明（文字列か、言語 → 文字列）。 */
export type UpdateNotes = string | Record<string, string>;

export interface UpdatePlan {
  app: { version: string; page?: string; notes?: UpdateNotes; file?: { url: string; sha256: string; size?: number } } | null;
  packs: { id: string; version: string; title?: string; notes?: UpdateNotes; size?: number }[];
}

/** デスクトップ版の preload が置く口（window.liminaliaDesktop.update）。 */
export interface DesktopUpdate {
  /** 起動したときに確かめるか（build.update.checkOnStartup）。 */
  startup: boolean;
  /** 確かめる（fresh なら取り寄せ直す）。plan は更新が無ければ null。 */
  check(fresh?: boolean): Promise<{ ok: true; plan: UpdatePlan | null } | { ok: false; error: string }>;
  /** 確かめた更新を行う。 */
  apply(what: "packs" | "app"): Promise<{ ok: true; action: "packs" | "page" | "installer" | "opened" | "restart" } | { ok: false; error: string }>;
  /** 取り寄せの進み具合。 */
  onProgress?(listener: (p: { name: string; done: number; total: number }) => void): void;
  /** ゲームを再起動する。 */
  relaunch(): void;
}

export interface UpdateUi {
  /** はい／いいえを尋ねる。 */
  ask(message: string, kind: string): Promise<boolean>;
  /** 短く知らせる。 */
  toast(message: string): void;
  /** 遊ぶ人の言語（説明を選ぶ）。 */
  language: string;
  /** 起動したときに断った更新を覚える（同じ更新は二度尋ねない）。 */
  declined?: { get(): string | null; set(key: string): void };
}

/** 言語に合う説明（文字列ならそのまま。無ければ英語、それも無ければ最初のもの）。 */
export function pickNotes(notes: UpdateNotes | undefined, language: string): string {
  if (notes === undefined) return "";
  if (typeof notes === "string") return notes;
  const lang = language.toLowerCase();
  return notes[lang] ?? notes[lang.split("-")[0]!] ?? notes.en ?? Object.values(notes)[0] ?? "";
}

/** 更新の中身の鍵（断ったものを覚える）。 */
export function planKey(plan: UpdatePlan): string {
  return [plan.app ? `app@${plan.app.version}` : "", ...plan.packs.map((p) => `${p.id}@${p.version}`)].filter(Boolean).join(",");
}

/** 進み具合を受けている口（一度だけ受ける）と、今の受け手。 */
const listening = new WeakSet<DesktopUpdate>();
let onProgress: ((p: { name: string; done: number; total: number }) => void) | null = null;

/** 大きさ（MB）。 */
function megabytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * 確かめて、あれば尋ねて更新する。manual はプレイヤーがメニューから確かめたとき（結果を必ず知らせ、断ったものも尋ねる）。
 * 何かを行ったら true。
 */
export async function runUpdate(update: DesktopUpdate, ui: UpdateUi, manual: boolean): Promise<boolean> {
  const r = await update.check(manual);
  if (!r.ok) {
    if (manual) ui.toast(TEXT.update.checkFailed);
    return false;
  }
  const plan = r.plan;
  if (!plan || (!plan.app && plan.packs.length === 0)) {
    if (manual) ui.toast(TEXT.update.latest);
    return false;
  }
  const key = planKey(plan);
  if (!manual && ui.declined?.get() === key) return false;
  let progress = -1;
  if (!listening.has(update)) {
    listening.add(update);
    update.onProgress?.((p) => onProgress?.(p));
  }
  onProgress = (p) => {
    const percent = p.total > 0 ? Math.floor((p.done / p.total) * 100) : 0;
    // 10% ごとに知らせる
    if (Math.floor(percent / 10) !== Math.floor(progress / 10)) ui.toast(TEXT.update.progress(p.name, percent));
    progress = percent;
  };
  if (plan.app) {
    if (await ui.ask(TEXT.update.app(plan.app.version, pickNotes(plan.app.notes, ui.language)), "update")) {
      const done = await update.apply("app");
      if (!done.ok) ui.toast(`${TEXT.update.failed}: ${done.error}`);
      else ui.toast(done.action === "page" ? TEXT.update.page : done.action === "installer" ? TEXT.update.installer : done.action === "restart" ? TEXT.update.swapping : TEXT.update.opened);
      return done.ok;
    }
    // 本体を更新しないなら、今の本体に合うパックだけを尋ねる
  }
  if (plan.packs.length > 0) {
    const names = plan.packs.map((p) => `${p.title ?? p.id} ${p.version}`).join("、");
    const size = plan.packs.reduce((n, p) => n + (p.size ?? 0), 0);
    const notes = plan.packs.map((p) => pickNotes(p.notes, ui.language)).filter(Boolean).join("\n");
    if (await ui.ask(TEXT.update.packs(size > 0 ? `${names}、${megabytes(size)}` : names, notes), "update")) {
      progress = -1;
      const done = await update.apply("packs");
      if (!done.ok) {
        ui.toast(`${TEXT.update.failed}: ${done.error}`);
        return false;
      }
      if (await ui.ask(TEXT.update.restart, "update-restart")) update.relaunch();
      else ui.toast(TEXT.update.nextLaunch);
      return true;
    }
  }
  ui.declined?.set(key);
  return false;
}
