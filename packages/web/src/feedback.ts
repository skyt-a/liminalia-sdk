import { saveFile } from "./system/download.ts";
import { TEXT } from "./system/strings.ts";
import { captureStage } from "./system/thumbnail.ts";
import { button, el, swallow, toast } from "./system/ui.ts";

/**
 * テスト版の指摘（テスターや依頼主が、遊びながらその場面に指摘を残す口）。テスト版（lim build --feedback、
 * 制作アプリの書き出しの「テスト版」、build.variants の feedback: true のエディション）にだけ入る。製品の書き出しでは
 * main.ts の __LIMINALIA_FEEDBACK__ が false になり、このモジュールは束に入らない。
 *
 * 舞台の隅の「指摘」（と F8）で、そのページのスクリーンショットを撮ってから欄を開く。書いた指摘は、liminalia.json の
 * build.feedback.url があれば POST の JSON で送り、無ければファイル（.liminalia-feedback.json）に保存してもらう。
 * Studio のコメントの画面の「指摘を取り込む」で、そのシナリオの行のコメントになる（ページの鍵で行を探し直す）。
 */

/** 指摘の記録（送る JSON とファイルの中身。Studio の server/reviews.ts の importFeedback が読む）。 */
export interface FeedbackRecord {
  kind: "liminalia-feedback";
  format: 1;
  project: string;
  version: string;
  variant?: string;
  /** 書き出した日時（ISO 8601）。 */
  build?: string;
  /** そのページの台本の位置と、ページの鍵（行を足しても変わらない。@liminalia/lang の pageKeys）。 */
  at: { file: string; line: number; key?: string } | null;
  body: string;
  author: string;
  time: string;
  /** スクリーンショット（data:image/jpeg;base64,…）。 */
  shot?: string;
  userAgent: string;
}

export interface FeedbackOptions {
  stage: HTMLElement;
  project: { id: string; version?: string; variant?: { name: string }; feedback?: { url?: string } };
  build: { date?: string } | null;
  where(): { file: string; line: number; key?: string } | null;
}

/** ファイルの拡張子（Studio はこの名前のファイルを取り込む）。 */
export const FEEDBACK_SUFFIX = ".liminalia-feedback.json";
const NAME_KEY = "liminalia:feedback-author";
/** スクリーンショットの長い辺。 */
const SHOT_SIZE = 960;

function rememberedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

function rememberName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // 覚えられなくても送るのは続ける
  }
}

/** ファイルの名前（作品の ID と日時。Windows でも使える文字だけ）。 */
export function feedbackFileName(projectId: string, time: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${time.getFullYear()}${p(time.getMonth() + 1)}${p(time.getDate())}-${p(time.getHours())}${p(time.getMinutes())}${p(time.getSeconds())}`;
  return `${projectId.replace(/[^\w-]/g, "_")}-${stamp}${FEEDBACK_SUFFIX}`;
}

/** 送る（url があれば POST、無ければファイルに保存してもらう）。送れたら true。 */
export async function deliverFeedback(record: FeedbackRecord, url: string | undefined, save: (name: string, data: Blob) => Promise<boolean> = saveFile): Promise<"sent" | "saved" | false> {
  if (url) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(record) });
      return res.ok ? "sent" : false;
    } catch {
      return false;
    }
  }
  const ok = await save(feedbackFileName(record.project, new Date(record.time)), new Blob([`${JSON.stringify(record, null, 2)}\n`], { type: "application/json" }));
  return ok ? "saved" : false;
}

/** 置く場所（標準のシステム画面の層。無ければ舞台）。システム画面と同じ文字と色になる。 */
function layerOf(stage: HTMLElement): HTMLElement {
  return stage.querySelector<HTMLElement>(":scope > .lm-sys") ?? stage;
}

/** 舞台の隅のボタンと F8 を置く。 */
export function installFeedback(o: FeedbackOptions): void {
  const T = TEXT.feedback;
  const open = () => {
    if (o.stage.querySelector(".lm-feedback-backdrop")) return;
    // 欄を開く前に撮る（欄が写らないように）
    const w = o.stage.offsetWidth || 1280;
    const h = o.stage.offsetHeight || 720;
    const scale = Math.min(1, SHOT_SIZE / Math.max(w, h));
    let shot = "";
    try {
      shot = captureStage(o.stage, Math.round(w * scale), Math.round(h * scale), "image/jpeg");
    } catch {
      // 撮れなくても文だけで送れる
    }
    showDialog(o, shot);
  };
  const trigger = button("lm-button lm-feedback-button", T.button, open);
  trigger.title = T.buttonTitle;
  swallow(trigger);
  layerOf(o.stage).append(trigger);
  window.addEventListener("keydown", (e) => {
    if (e.key === "F8" && !e.repeat) {
      e.preventDefault();
      open();
    }
  });
  installStyle();
}

function showDialog(o: FeedbackOptions, shot: string): void {
  const T = TEXT.feedback;
  const at = o.where();
  const body = el("textarea", "lm-feedback-body");
  body.rows = 4;
  body.placeholder = T.placeholder;
  body.setAttribute("aria-label", T.placeholder);
  const name = el("input", "lm-feedback-name");
  name.type = "text";
  name.value = rememberedName();
  name.placeholder = T.namePlaceholder;
  name.setAttribute("aria-label", T.name);
  const status = el("p", "lm-feedback-status");
  const send = button("lm-button lm-primary", o.project.feedback?.url ? T.send : T.save, () => void submit());
  const cancel = button("lm-button", T.cancel, () => close(), "cancel");
  const img = shot ? Object.assign(el("img", "lm-feedback-shot"), { src: shot, alt: T.shot }) : null;
  const box = el(
    "div",
    "lm-dialog lm-feedback",
    el("h2", "lm-screen-title", T.title),
    el("p", "lm-feedback-where", at ? T.where(at.file, at.line) : T.nowhere),
    ...(img ? [img] : []),
    body,
    el("label", "lm-feedback-label", T.name, name),
    status,
    el("div", "lm-dialog-buttons", cancel, send),
  );
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", T.title);
  const root = el("div", "lm-dialog-backdrop lm-feedback-backdrop", box);
  swallow(root);
  // 書いている文字で本文を送ったり、ショートカットが動いたりしないように
  root.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") close();
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.isComposing) void submit();
  });
  root.addEventListener("keyup", (e) => e.stopPropagation());
  const close = () => root.remove();
  let sending = false;
  const submit = async () => {
    if (sending) return;
    const text = body.value.trim();
    if (text === "") {
      status.textContent = T.empty;
      body.focus();
      return;
    }
    sending = true;
    send.disabled = true;
    rememberName(name.value.trim());
    const record: FeedbackRecord = {
      kind: "liminalia-feedback",
      format: 1,
      project: o.project.id,
      version: o.project.version ?? "",
      ...(o.project.variant ? { variant: o.project.variant.name } : {}),
      ...(o.build?.date ? { build: o.build.date } : {}),
      at,
      body: text,
      author: name.value.trim(),
      time: new Date().toISOString(),
      ...(shot ? { shot } : {}),
      userAgent: navigator.userAgent,
    };
    const done = await deliverFeedback(record, o.project.feedback?.url);
    sending = false;
    send.disabled = false;
    if (!done) {
      status.textContent = o.project.feedback?.url ? T.sendFailed : T.saveFailed;
      return;
    }
    close();
    toast(layerOf(o.stage), done === "sent" ? T.sent : T.saved, 2400);
  };
  layerOf(o.stage).append(root);
  // 置いたらすぐに文の欄へフォーカスを移す（次の描画まで待つと、その間に押した Esc が本文の側へ行き、メニューが開く）
  body.focus({ preventScroll: true });
}

/** 指摘の欄の見た目（テスト版にだけ入るので、標準の CSS には書かない）。 */
function installStyle(): void {
  if (document.getElementById("lm-feedback-style")) return;
  const style = document.createElement("style");
  style.id = "lm-feedback-style";
  style.textContent = `
.lm-feedback-button, .lm-feedback { color: var(--lm-fg, #ecebe6); font-family: var(--lm-ui-font, sans-serif); }
.lm-feedback button { color: inherit; font-family: inherit; }
.lm-feedback-button { position: absolute; top: 8px; left: 8px; z-index: 60; padding: 2px 10px; font-size: 14px; opacity: 0.72; }
.lm-feedback-button:hover, .lm-feedback-button:focus-visible { opacity: 1; }
.lm-feedback-backdrop { z-index: 70; }
.lm-feedback { display: flex; flex-direction: column; gap: 8px; width: min(560px, 90%); max-height: 92%; overflow: auto; text-align: left; }
.lm-feedback .lm-screen-title { margin: 0; font-size: 18px; }
.lm-feedback-where, .lm-feedback-status { margin: 0; font-size: 14px; color: var(--lm-fg-muted); }
.lm-feedback-status:empty { display: none; }
.lm-feedback-shot { width: 100%; max-height: 180px; object-fit: contain; background: var(--lm-thumb-bg, #000); border: 0.5px solid var(--lm-border); }
.lm-feedback-body, .lm-feedback-name { width: 100%; box-sizing: border-box; font: inherit; font-size: 16px; color: var(--lm-fg); background: var(--lm-control-bg); border: 0.5px solid var(--lm-border); border-radius: var(--lm-radius); padding: 6px 8px; }
.lm-feedback-body { resize: vertical; }
.lm-feedback-label { display: flex; flex-direction: column; gap: 4px; font-size: 14px; }
`;
  document.head.append(style);
}
