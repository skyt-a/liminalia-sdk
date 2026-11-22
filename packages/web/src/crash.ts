/**
 * 止まったときの記録（書き出したゲームだけ）。捕まえていない例外と Promise の拒否を、版・遊んでいた位置・環境と一緒に一つだけ残す
 * （デスクトップ版は保存先の logs/ にファイルでも残す）。次に起動したとき、liminalia.json の build.crashReport.url があれば、
 * 遊ぶ人に尋ねてから作者へ送る（送らなくても、次の記録で上書きする）。
 * 何が起きたか（例外の文と、出た所のプログラムの位置）と、どの行か（最後に出したページ、実行中の命令、その直前に出したページと実行時の診断）を残す。
 * プログラムの位置は書き出した束の中の位置なので、元の位置は書き出しのソースマップ（build.sourcemap）で戻す（docs/distribution.md）。
 */
export interface CrashRecord {
  message: string;
  stack: string;
  /** 遊んでいた .lim の位置（最後に出したページ。分かれば）。 */
  at: string;
  version: string;
  userAgent: string;
  date: string;
  /** error: 捕まえていない例外、rejection: 捕まえていない Promise の拒否。 */
  kind?: "error" | "rejection";
  /** 例外が出たプログラムの位置（束のファイル:行:桁。error のときだけ分かる）。 */
  source?: string;
  /** 実行中の命令の位置（ページの途中の命令で止まったとき。at と同じなら書かない）。 */
  step?: string;
  /** 止まる前に出したページ（古い順。最後の TRAIL_SIZE ページ）。 */
  trail?: string[];
  /** 止まる前の実行時の診断（古い順。最後の TRAIL_SIZE 件。「ファイル:行 [code] 文」）。 */
  diagnostics?: string[];
  /** どこで遊んでいたか（browser、desktop、ios、android）。 */
  platform?: PlayPlatform;
  /** 遊んでいた言語（原文なら空）。 */
  language?: string;
  /** 書き出した日時（project/build.json）。 */
  build?: string;
  /** 書き出したエンジンの版（project/build.json の engine）。 */
  engine?: string;
  /** 画面の大きさ（CSS の画素。幅x高さ）。 */
  screen?: string;
}

/** 遊んでいる環境（デスクトップ版、スマホのアプリ、ブラウザ）。 */
export type PlayPlatform = "browser" | "desktop" | "ios" | "android";

export function playPlatform(): PlayPlatform {
  if (typeof window === "undefined") return "browser";
  const w = window as unknown as { liminaliaDesktop?: unknown; LiminaliaApp?: unknown; webkit?: { messageHandlers?: { liminaliaApp?: unknown } } };
  if (w.liminaliaDesktop) return "desktop";
  if (w.LiminaliaApp) return "android";
  if (w.webkit?.messageHandlers?.liminaliaApp) return "ios";
  return "browser";
}

/** 控えておくページと診断の数。 */
export const TRAIL_SIZE = 10;

/** 止まる前の様子（ページと診断）を控える。 */
export class CrashTrail {
  readonly pages: string[] = [];
  readonly diagnostics: string[] = [];
  page(at: { file: string; line: number }): void {
    const key = `${at.file}:${at.line}`;
    if (this.pages.at(-1) === key) return;
    this.pages.push(key);
    if (this.pages.length > TRAIL_SIZE) this.pages.shift();
  }
  diagnostic(d: { file: string; line: number; code: string; message: string }): void {
    this.diagnostics.push(`${d.file}:${d.line} [${d.code}] ${d.message}`);
    if (this.diagnostics.length > TRAIL_SIZE) this.diagnostics.shift();
  }
}

/**
 * 記録の鍵。"liminalia:<id>:" で始めない（その鍵はセーブの置き場所が起動のたびに localStorage から IndexedDB へ移して消すので、
 * 次の起動で記録を読めなかった。system/idb-store.ts）。前の鍵 OLD_KEY に残ったものも読む。
 */
const key = (projectId: string) => `liminalia-crash:${projectId}`;
const OLD_KEY = (projectId: string) => `liminalia:${projectId}:crash`;

/** 記録に足す、止まったときの様子（遊ぶ側が渡す）。 */
export interface CrashContext {
  /** 実行中の命令の位置。 */
  step?: string | null;
  trail?: CrashTrail;
  language?: string;
  build?: string;
  engine?: string;
}

/** 記録を作る（テストのために分けてある）。 */
export function crashRecord(o: { version: string; where(): string; context?(): CrashContext }, error: { message: string; stack: string; kind: "error" | "rejection"; source?: string }): CrashRecord {
  let c: CrashContext = {};
  try {
    c = o.context?.() ?? {};
  } catch {
    // 様子を集められなくても、例外の文は残す
  }
  const at = o.where();
  return {
    message: error.message,
    stack: error.stack,
    at,
    version: o.version,
    userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
    date: new Date().toISOString(),
    kind: error.kind,
    ...(error.source ? { source: error.source } : {}),
    ...(c.step && c.step !== at ? { step: c.step } : {}),
    ...(c.trail && c.trail.pages.length > 0 ? { trail: [...c.trail.pages] } : {}),
    ...(c.trail && c.trail.diagnostics.length > 0 ? { diagnostics: [...c.trail.diagnostics] } : {}),
    platform: playPlatform(),
    ...(c.language !== undefined ? { language: c.language } : {}),
    ...(c.build ? { build: c.build } : {}),
    ...(c.engine ? { engine: c.engine } : {}),
    ...(typeof window !== "undefined" ? { screen: `${window.innerWidth}x${window.innerHeight}` } : {}),
  };
}

export function installCrashRecorder(o: { projectId: string; version: string; where(): string; context?(): CrashContext }): void {
  let written = false;
  const record = (error: Parameters<typeof crashRecord>[1]) => {
    // 同じ起動の中では最初の一つだけ（後の例外は最初のものから続いて起きることが多い）
    if (written) return;
    written = true;
    const r = crashRecord(o, error);
    try {
      localStorage.setItem(key(o.projectId), JSON.stringify(r));
    } catch {
      // 残せなくても遊ぶのは続ける
    }
    window.liminaliaDesktop?.crash?.(JSON.stringify(r, null, 2));
  };
  window.addEventListener("error", (e) => {
    // 読み込めなかった素材（img などの error）は例外ではないので残さない
    if (!(e instanceof ErrorEvent)) return;
    record({ message: e.message, stack: e.error instanceof Error ? (e.error.stack ?? "") : "", kind: "error", ...(e.filename ? { source: `${e.filename}:${e.lineno}:${e.colno}` } : {}) });
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason as unknown;
    record({ message: reason instanceof Error ? reason.message : String(reason), stack: reason instanceof Error ? (reason.stack ?? "") : "", kind: "rejection" });
  });
}

/** 前の起動で残した記録（読んだら消す）。 */
export function takeCrashRecord(projectId: string): CrashRecord | null {
  try {
    const raw = localStorage.getItem(key(projectId)) ?? localStorage.getItem(OLD_KEY(projectId));
    if (!raw) return null;
    localStorage.removeItem(key(projectId));
    localStorage.removeItem(OLD_KEY(projectId));
    return JSON.parse(raw) as CrashRecord;
  } catch {
    return null;
  }
}

/** 記録を作者へ送る（尋ねて、遊ぶ人が「はい」と答えたときだけ呼ぶ）。 */
export async function sendCrashRecord(url: string, projectId: string, r: CrashRecord): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: projectId, ...r }) });
    return res.ok;
  } catch {
    return false;
  }
}
