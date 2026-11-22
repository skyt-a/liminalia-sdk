import type { UiSplash } from "@liminalia/lang";
import { el } from "./ui.ts";

/**
 * 起動の演出（liminalia.json の ui.splash）。ロゴを順に出し、注意書きを出して、タイトルへ渡す。
 * 押す（クリック・Enter・Space）と次へ進む（skip が false なら進まない）。見た目は CSS（.lm-splash・.lm-splash-logo・
 * .lm-splash-notice・.lm-splash-block）で変える。作品のプラグインが splash を持てば、そちらを使う。
 */
export interface SplashHost {
  asset(path: string): string;
}

const FADE_IN = 500;
const FADE_OUT = 400;
/** 段が替わってすぐの押しは、前の段の押しの続きとして無視する。 */
const GUARD = 300;

export function playSplash(layer: HTMLElement, splash: UiSplash, host: SplashHost): Promise<void> {
  const root = el("div", "lm-splash");
  root.setAttribute("role", "presentation");
  layer.append(root);
  const skippable = splash.skip !== false;
  let advance: (() => void) | null = null;
  /** 最後の段の地の色（消えるまで残す）。 */
  let last = "";
  let since = 0;
  const press = () => {
    if (!skippable || performance.now() - since < GUARD) return;
    advance?.();
  };
  const onPointer = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
    press();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    e.stopPropagation();
    press();
  };
  root.addEventListener("pointerdown", onPointer);
  root.addEventListener("click", (e) => e.stopPropagation());
  window.addEventListener("keydown", onKey, true);

  /** 一つの段を出し、時間が来るか押されるまで待ち、消す。time が null なら押すまで待つ。 */
  const stage = async (screen: HTMLElement, time: number | null): Promise<void> => {
    root.append(screen);
    since = performance.now();
    requestAnimationFrame(() => requestAnimationFrame(() => screen.classList.add("lm-splash-shown")));
    await new Promise<void>((resolve) => {
      const timer = time === null ? undefined : setTimeout(done, FADE_IN + time);
      function done() {
        clearTimeout(timer);
        advance = null;
        resolve();
      }
      advance = done;
    });
    screen.classList.remove("lm-splash-shown");
    await new Promise((r) => setTimeout(r, FADE_OUT));
    screen.remove();
  };

  return (async () => {
    try {
      for (const logo of splash.logos ?? []) {
        if (!logo?.image) continue;
        const screen = el("div", "lm-splash-screen lm-splash-logo");
        if (logo.background) screen.style.background = last = logo.background;
        const img = el("img", "lm-splash-logo-image");
        img.src = host.asset(logo.image);
        img.alt = "";
        img.draggable = false;
        screen.append(img);
        await stage(screen, Math.max(0, logo.time ?? 2500));
      }
      const n = splash.notice;
      if (n && (n.title || (n.blocks ?? []).length > 0)) {
        const screen = el("div", "lm-splash-screen lm-splash-notice");
        if (n.background) screen.style.background = last = n.background;
        if (n.color) screen.style.color = n.color;
        if (n.title) screen.append(el("h2", "lm-splash-title", n.title));
        for (const [i, b] of (n.blocks ?? []).entries()) {
          const block = el("div", "lm-splash-block");
          block.style.setProperty("--lm-splash-index", String(i));
          if (b.label) block.append(el("div", "lm-splash-label", b.label));
          block.append(el("div", "lm-splash-text", ...b.text.split("\n").map((line) => el("div", "", line))));
          screen.append(block);
        }
        // 押して進めないなら、押さなくても進む
        const auto = n.auto !== false || !skippable;
        const time = Math.max(0, n.time ?? 6000);
        if (auto) {
          const rule = el("div", "lm-splash-rule");
          rule.style.animationDuration = `${time}ms`;
          screen.append(rule);
        }
        await stage(screen, auto ? time : null);
      }
    } finally {
      window.removeEventListener("keydown", onKey, true);
      if (last) root.style.background = last;
      root.classList.add("lm-splash-leaving");
      root.style.transitionDuration = `${Math.max(0, splash.fade ?? 600)}ms`;
      setTimeout(() => root.remove(), Math.max(0, splash.fade ?? 600));
    }
  })();
}
