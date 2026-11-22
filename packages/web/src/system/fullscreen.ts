/**
 * 全画面の切り替え。デスクトップ版はウィンドウを全画面にし（Alt+Enter・F11 でも切り替わる）、ブラウザは Fullscreen API を使う
 * （ブラウザでは押したときにしか全画面にできないので、起動したときには戻さない）。
 * 作品が全画面を許さない（ui.screen.fullscreen が false）なら、切り替えられないものとして扱う。
 */
let allowed = true;

export const fullscreen = {
  /** 作品が全画面を許すか（ui.screen.fullscreen）。許さないなら、全画面になっていれば戻す。 */
  allow(on: boolean): void {
    const was = allowed;
    allowed = on;
    if (was && !on) fullscreen.set(false);
  },

  allowed(): boolean {
    return allowed;
  },

  /** この環境で切り替えられるか（作品が許さないときも false）。 */
  supported(): boolean {
    return allowed && (!!window.liminaliaDesktop?.setFullscreen || (typeof document !== "undefined" && document.fullscreenEnabled === true));
  },

  /** 起動したときに戻せるか（デスクトップ版だけ）。 */
  restorable(): boolean {
    return !!window.liminaliaDesktop?.setFullscreen;
  },

  set(on: boolean): void {
    if (on && !allowed) return;
    const desktop = window.liminaliaDesktop;
    if (desktop?.setFullscreen) return desktop.setFullscreen(on);
    if (on && !document.fullscreenElement) void document.documentElement.requestFullscreen?.().catch(() => undefined);
    if (!on && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  },

  /** 全画面になった・戻った（Esc・F11・Alt+Enter など、ゲームの外から変わったときも）。 */
  onChange(listener: (on: boolean) => void): void {
    const desktop = window.liminaliaDesktop;
    if (desktop?.onFullscreen) desktop.onFullscreen(listener);
    else if (typeof document !== "undefined") document.addEventListener("fullscreenchange", () => listener(!!document.fullscreenElement));
  },
};
