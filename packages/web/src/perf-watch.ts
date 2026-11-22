/**
 * 重さの計測（開発サーバーだけ。F10 で出し入れ）。遊びながら次の数値を見る。lim profile も同じ数値を読む（window.__liminaliaPerf）。
 * - フレームレート（直近 1 秒）と、長いフレーム（LONG_FRAME ミリ秒を超えたもの）の数と一番長いもの。Long Tasks API があれば長いタスクの数も
 * - JS のメモリ（performance.memory がある Chromium だけ）
 * - 読み込んだ素材の数と大きさ（画像・音・動画・フォント・そのほか。Resource Timing から。開発サーバーは毎回確かめ直すので、同じ素材も数える）
 * - 読み込みにかかった時間の長い素材
 * - DOM の要素の数
 * 書き出したゲームには入れない（main.ts が import.meta.hot のときだけ読み込む）。
 */
import { devEnglish, devText } from "./dev-language.ts";

/** 長いフレームとみなす間隔（ミリ秒）。60fps の 3 フレーム分ほど。 */
export const LONG_FRAME = 50;

export type ResourceKind = "image" | "audio" | "video" | "font" | "other";

export interface ResourceTotal {
  count: number;
  /** 転送した大きさ（取れなければ中身の大きさ）。バイト。 */
  bytes: number;
}

export interface SlowResource {
  name: string;
  kind: ResourceKind;
  ms: number;
  bytes: number;
}

export interface PerfSnapshot {
  /** 計り始めてからのミリ秒。 */
  elapsed: number;
  /** 直近 1 秒のフレームレート（計っていなければ null）。 */
  fps: number | null;
  frames: { count: number; long: number; longest: number };
  longTasks: { count: number; total: number } | null;
  memory: { used: number; total: number; limit: number } | null;
  resources: Record<ResourceKind, ResourceTotal>;
  slowest: SlowResource[];
  dom: number;
}

const IMAGE = /\.(png|jpe?g|webp|gif|avif|svg|bmp)$/i;
const AUDIO = /\.(ogg|mp3|m4a|wav|opus|aac|flac)$/i;
const VIDEO = /\.(mp4|webm|ogv|mov)$/i;
const FONT = /\.(woff2?|ttf|otf)$/i;

/** 素材の種類（assets/<フォルダ>/ のフォルダか、拡張子から）。 */
export function resourceKind(url: string): ResourceKind {
  let path = url;
  try {
    path = decodeURIComponent(new URL(url, "http://localhost/").pathname);
  } catch {
    // そのまま
  }
  const folder = /\/assets\/([^/]+)\//.exec(path)?.[1];
  if (folder === "bgimage" || folder === "fgimage" || folder === "image") return "image";
  if (folder === "bgm" || folder === "sound" || folder === "voice") return "audio";
  if (folder === "video") return "video";
  if (IMAGE.test(path)) return "image";
  if (AUDIO.test(path)) return "audio";
  if (VIDEO.test(path)) return "video";
  if (FONT.test(path)) return "font";
  return "other";
}

/** 素材の名前（assets/ からのパス。無ければ URL のパス）。 */
function shortName(url: string): string {
  try {
    const path = decodeURIComponent(new URL(url, "http://localhost/").pathname);
    const at = path.indexOf("/assets/");
    return at >= 0 ? path.slice(at + "/assets/".length) : path;
  } catch {
    return url;
  }
}

const SLOWEST = 10;

/** フレームと素材の読み込みを数える。start で計り始め、snapshot で今の数値を返す。 */
export class PerfMonitor {
  private running = false;
  private startedAt = performance.now();
  private last = 0;
  /** 直近 1 秒のフレームの時刻。 */
  private recent: number[] = [];
  private frames = { count: 0, long: 0, longest: 0 };
  private longTasks: { count: number; total: number } | null = null;
  private resources: SlowResource[] = [];
  private readonly users = new Set<string>();

  constructor() {
    try {
      performance.setResourceTimingBufferSize(10000);
    } catch {
      // 決められないブラウザは既定の数まで
    }
    // 計り始める前のものも含めて、読み込んだ素材をすべて集める
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as PerformanceResourceTiming[]) this.addResource(e);
      }).observe({ type: "resource", buffered: true });
    } catch {
      for (const e of performance.getEntriesByType("resource") as PerformanceResourceTiming[]) this.addResource(e);
    }
    try {
      if (PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
        this.longTasks = { count: 0, total: 0 };
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            this.longTasks!.count++;
            this.longTasks!.total += e.duration;
          }
        }).observe({ type: "longtask", buffered: false });
      }
    } catch {
      this.longTasks = null;
    }
  }

  private addResource(e: PerformanceResourceTiming): void {
    // 開発サーバーのモジュール（.ts や /@vite/ など）は素材ではないので数えない
    if (/\/(@vite|@fs|@id|node_modules|src|project)\//.test(e.name) || /\.(ts|tsx|mjs|js|css|map|json)(\?|$)/.test(e.name)) return;
    this.resources.push({ name: shortName(e.name), kind: resourceKind(e.name), ms: e.duration, bytes: e.transferSize > 0 ? e.transferSize : e.encodedBodySize || e.decodedBodySize || 0 });
  }

  /** 計り始める（user は計っているものの名前。どれかが計っている間はフレームを数える）。 */
  start(user: string): void {
    this.users.add(user);
    if (this.running) return;
    this.running = true;
    this.last = 0;
    const tick = (now: number) => {
      if (!this.running) return;
      if (this.last > 0) {
        const delta = now - this.last;
        this.frames.count++;
        if (delta > LONG_FRAME) this.frames.long++;
        this.frames.longest = Math.max(this.frames.longest, delta);
      }
      this.last = now;
      this.recent.push(now);
      while (this.recent.length > 0 && now - this.recent[0]! > 1000) this.recent.shift();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  stop(user: string): void {
    this.users.delete(user);
    if (this.users.size === 0) this.running = false;
  }

  /** フレームと長いタスクの数を 0 に戻す（素材の数は戻さない）。 */
  reset(): void {
    this.startedAt = performance.now();
    this.frames = { count: 0, long: 0, longest: 0 };
    this.recent = [];
    this.last = 0;
    if (this.longTasks) this.longTasks = { count: 0, total: 0 };
  }

  snapshot(): PerfSnapshot {
    const resources: Record<ResourceKind, ResourceTotal> = { image: { count: 0, bytes: 0 }, audio: { count: 0, bytes: 0 }, video: { count: 0, bytes: 0 }, font: { count: 0, bytes: 0 }, other: { count: 0, bytes: 0 } };
    for (const r of this.resources) {
      resources[r.kind].count++;
      resources[r.kind].bytes += r.bytes;
    }
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    const span = this.recent.length > 1 ? this.recent.at(-1)! - this.recent[0]! : 0;
    return {
      elapsed: performance.now() - this.startedAt,
      fps: this.running && span > 0 ? Math.round(((this.recent.length - 1) * 1000) / span) : null,
      frames: { ...this.frames, longest: Math.round(this.frames.longest) },
      longTasks: this.longTasks ? { count: this.longTasks.count, total: Math.round(this.longTasks.total) } : null,
      memory: memory ? { used: memory.usedJSHeapSize, total: memory.totalJSHeapSize, limit: memory.jsHeapSizeLimit } : null,
      resources,
      slowest: [...this.resources].sort((a, b) => b.ms - a.ms).slice(0, SLOWEST).map((r) => ({ ...r, ms: Math.round(r.ms) })),
      dom: document.getElementsByTagName("*").length,
    };
  }
}

declare global {
  interface Window {
    /** 重さの計測（開発サーバーだけ。lim profile が読む）。 */
    __liminaliaPerf?: PerfMonitor;
  }
}

/** 大きさを読みやすく。 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const KIND_NAMES: Record<ResourceKind, string> = devEnglish
  ? { image: "Images", audio: "Audio", video: "Video", font: "Fonts", other: "Other" }
  : { image: "画像", audio: "音", video: "動画", font: "フォント", other: "そのほか" };

/** 見た目（変数の監視 .lm-var-watch にそろえる。開発用なので style.css には置かず、ここで足す）。 */
const CSS = `
.lm-perf-watch { position: absolute; top: 12px; left: 12px; z-index: 50; display: flex; flex-direction: column; gap: 6px; width: 320px; max-height: 70%; overflow: auto;
  padding: 10px; box-sizing: border-box; font: 12px/1.5 ui-monospace, Menlo, monospace; color: #e8e8e8; background: rgba(10, 12, 16, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.18); border-radius: 6px; }
.lm-perf-watch[hidden] { display: none; }
.lm-perf-row { display: flex; justify-content: space-between; gap: 12px; }
.lm-perf-row span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #b8b8c0; }
.lm-perf-row b { font-weight: 500; white-space: nowrap; }
.lm-perf-row b.is-bad { color: #f0a040; }
.lm-perf-head { margin-top: 4px; color: #8c8c96; }
.lm-perf-watch button { align-self: flex-end; font: inherit; color: inherit; background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 4px; padding: 2px 8px; cursor: pointer; }
`;

/** 計測の表示を舞台に置き、F10 で出し入れする。 */
export function installPerfWatch(stage: HTMLElement): PerfMonitor {
  const monitor = (window.__liminaliaPerf ??= new PerfMonitor());
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
  const panel = document.createElement("div");
  panel.className = "lm-perf-watch";
  panel.hidden = true;
  const body = document.createElement("div");
  const reset = document.createElement("button");
  reset.type = "button";
  reset.textContent = devText("リセット", "Reset");
  reset.onclick = () => {
    monitor.reset();
    render();
  };
  panel.append(body, reset);
  for (const type of ["click", "wheel", "pointerdown", "keydown"]) panel.addEventListener(type, (e) => e.stopPropagation());
  stage.append(panel);

  const row = (label: string, value: string, bad = false) => {
    const r = document.createElement("div");
    r.className = "lm-perf-row";
    const a = document.createElement("span");
    a.textContent = label;
    const b = document.createElement("b");
    b.textContent = value;
    if (bad) b.className = "is-bad";
    r.append(a, b);
    return r;
  };
  const head = (text: string) => {
    const h = document.createElement("div");
    h.className = "lm-perf-head";
    h.textContent = text;
    return h;
  };
  const render = () => {
    if (panel.hidden) return;
    const s = monitor.snapshot();
    const rows: HTMLElement[] = [
      row(devText("フレームレート", "Frame rate"), s.fps === null ? "—" : `${s.fps} fps`, s.fps !== null && s.fps < 50),
      row(devText(`長いフレーム（${LONG_FRAME}ms 超）`, `Long frames (over ${LONG_FRAME}ms)`), `${s.frames.long} / ${s.frames.count}`, s.frames.long > 0),
      row(devText("一番長いフレーム", "Longest frame"), `${s.frames.longest} ms`, s.frames.longest > LONG_FRAME),
    ];
    if (s.longTasks) rows.push(row(devText("長いタスク", "Long tasks"), devText(`${s.longTasks.count}（${s.longTasks.total} ms）`, `${s.longTasks.count} (${s.longTasks.total} ms)`), s.longTasks.count > 0));
    rows.push(row(devText("JS のメモリ", "JS memory"), s.memory ? `${formatBytes(s.memory.used)} / ${formatBytes(s.memory.limit)}` : devText("取得できません", "Not available")));
    rows.push(row(devText("DOM の要素", "DOM elements"), String(s.dom)));
    rows.push(head(devText("読み込んだ素材", "Loaded assets")));
    for (const k of ["image", "audio", "video", "font", "other"] as ResourceKind[]) {
      const n = s.resources[k].count;
      if (n > 0 || k === "image" || k === "audio") rows.push(row(KIND_NAMES[k], `${devText(`${n} 個`, `${n} ${n === 1 ? "file" : "files"}`)} ${formatBytes(s.resources[k].bytes)}`));
    }
    if (s.slowest.length > 0) {
      rows.push(head(devText("読み込みが遅い素材", "Slowest assets")));
      for (const r of s.slowest.slice(0, 5)) rows.push(row(r.name, `${r.ms} ms`, r.ms > 500));
    }
    body.replaceChildren(...rows);
  };

  let timer = 0;
  window.addEventListener("keydown", (e) => {
    if (e.key !== "F10") return;
    e.preventDefault();
    panel.hidden = !panel.hidden;
    if (panel.hidden) {
      monitor.stop("panel");
      clearInterval(timer);
    } else {
      monitor.start("panel");
      render();
      timer = window.setInterval(render, 500);
    }
  });
  return monitor;
}
