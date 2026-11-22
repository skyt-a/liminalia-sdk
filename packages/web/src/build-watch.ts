import { TEXT } from "./system/strings.ts";
import "./build-watch.css";

/**
 * 遊んでいる途中に置かれた新しい版を見つけて知らせる（書き出したブラウザ版。開発サーバー、デスクトップ版、スマホ版のアプリでは使わない）。
 * - 起動したときの版（project/build.json の date）と、配信元の今の版（project/build.json?lm-latest。Service Worker の控えを通さない）を比べる
 * - Service Worker（lm-sw.js）があれば、新しい版の Service Worker が入って待っていることでも知る（待っている間、前の版のエンジンと
 *   project/ がそろったまま遊べる）
 * - 知ったら舞台の上に「新しいバージョンがあります」と「読み直す」を出す。読み直すと、待っている Service Worker に替えてからページを読み直す
 *   （ページを離れるときのオートセーブは、ふだんどおりシステム画面がする）
 * 確かめるのは、起動して少したってから、ページへ戻ったとき（visibilitychange）、決めた間隔ごと。
 */
export interface BuildWatchOptions {
  /** 起動したときの版。 */
  stamp: string;
  /** 知らせを置く要素（舞台）。 */
  parent: HTMLElement;
  /** 配信元の今の版（テストで差し替える）。読めなければ null。 */
  latest?(): Promise<string | null>;
  /** 決めた間隔（ミリ秒。既定 10 分）。 */
  every?: number;
}

export interface BuildWatch {
  /** 今すぐ確かめる。新しい版があれば知らせて true。 */
  check(): Promise<boolean>;
  dispose(): void;
}

async function latestStamp(): Promise<string | null> {
  try {
    const r = await fetch("project/build.json?lm-latest", { cache: "no-store" });
    if (!r.ok) return null;
    const json = (await r.json()) as { date?: unknown };
    return typeof json.date === "string" ? json.date : null;
  } catch {
    return null;
  }
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  try {
    return (await navigator.serviceWorker?.getRegistration()) ?? null;
  } catch {
    return null;
  }
}

export function watchBuild(o: BuildWatchOptions): BuildWatch {
  let shown = false;
  let banner: HTMLElement | null = null;
  const show = () => {
    if (shown) return;
    shown = true;
    const text = document.createElement("span");
    text.textContent = TEXT.update.web;
    const reload = document.createElement("button");
    reload.type = "button";
    reload.className = "lm-update-reload";
    reload.textContent = TEXT.update.reload;
    reload.addEventListener("click", () => void restart());
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = TEXT.close;
    close.addEventListener("click", () => banner?.remove());
    banner = document.createElement("div");
    banner.className = "lm-update";
    banner.setAttribute("role", "status");
    banner.append(text, reload, close);
    // 押したクリックとホイールは本文の送りにしない
    for (const type of ["click", "wheel", "pointerdown"] as const) banner.addEventListener(type, (e) => e.stopPropagation());
    o.parent.append(banner);
  };
  /** 待っている Service Worker に替えてから読み直す（替わるのを長くは待たない）。 */
  const restart = async () => {
    const reg = await registration();
    // 入れている途中（WebKit は確かめ直すと入れ直すことがある）なら、入れ終えるのを待つ
    const next = reg?.waiting ?? reg?.installing ?? null;
    if (next) {
      const reached = (states: readonly string[], ms: number) =>
        Promise.race([
          new Promise<void>((resolve) => {
            const done = () => states.includes(next.state) && resolve();
            next.addEventListener("statechange", done);
            done();
          }),
          new Promise((r) => setTimeout(r, ms)),
        ]);
      await reached(["installed", "activating", "activated", "redundant"], 10_000);
      // 新しい版が動き始める（activated）まで待つ（controllerchange が来ない WebKit でも）
      next.postMessage("lm-skip-waiting");
      await reached(["activated", "redundant"], 3000);
      // 知らせが届かなかったときは、外してから読み直す（ページが新しい版を入れ直す）
      if (next.state !== "activated") await reg?.unregister().catch(() => false);
    }
    location.reload();
  };
  const check = async (): Promise<boolean> => {
    if (shown) return true;
    const reg = await registration();
    // 新しい版の Service Worker を探させる（入ったら updatefound で知る）
    void reg?.update().catch(() => undefined);
    const latest = await (o.latest ?? latestStamp)();
    if ((latest !== null && latest !== o.stamp) || (reg?.waiting && navigator.serviceWorker?.controller)) {
      show();
      return true;
    }
    return false;
  };
  // 新しい版の Service Worker が入り終えて待ち始めたら（前の版が動いているとき）
  void registration().then((reg) => {
    reg?.addEventListener("updatefound", () => {
      const next = reg.installing;
      next?.addEventListener("statechange", () => {
        if (next.state === "installed" && navigator.serviceWorker?.controller) show();
      });
    });
  });
  const onVisible = () => {
    if (document.visibilityState === "visible") void check();
  };
  document.addEventListener("visibilitychange", onVisible);
  const first = setTimeout(() => void check(), 30_000);
  const timer = setInterval(() => void check(), o.every ?? 10 * 60_000);
  return {
    check,
    dispose() {
      clearTimeout(first);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      banner?.remove();
    },
  };
}
