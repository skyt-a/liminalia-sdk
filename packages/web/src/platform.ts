import type { Platform } from "@liminalia/runtime";

/**
 * 遊んでいる機種（式の platform()・app()）。
 * - device: スマホとタブレット（iPhone・iPad・Android。タッチが主で、マウスの無い iPad も）は mobile、ほかは pc
 * - app: デスクトップ版（window.liminaliaDesktop）か、スマホ版のアプリ（iOS の WKWebView・Android の WebView）なら true
 */
export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return { device: "pc", app: false };
  const ua = navigator.userAgent;
  const data = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  // iPadOS の Safari は Mac を名乗るので、タッチの点の数で見分ける
  const ipad = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  const mobile = data?.mobile === true || /Android|iPhone|iPad|iPod|Mobile/.test(ua) || ipad;
  const w = typeof window === "undefined" ? undefined : (window as Window & { liminaliaDesktop?: unknown; webkit?: { messageHandlers?: unknown } });
  // スマホ版のアプリ: iOS は Safari を名乗らない WebView、Android は WebView の印（; wv)）
  const iosApp = /iPhone|iPad|iPod/.test(ua) || ipad ? !/Safari\//.test(ua) && !!w?.webkit?.messageHandlers : false;
  const androidApp = /Android/.test(ua) && /; wv\)/.test(ua);
  return { device: mobile ? "mobile" : "pc", app: !!w?.liminaliaDesktop || iosApp || androidApp };
}
