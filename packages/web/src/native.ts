/**
 * スマホのアプリ（packages/cli の mobile/android.ts・ios.ts）とデスクトップ版が置く口のうち、遊ぶ側の振る舞いに関わるもの
 * （アプリを閉じる・外のブラウザで開く・スリープを止める・振動）。口が無ければブラウザの機能で行う。
 */

/** Android のアプリの口（window.LiminaliaApp。@JavascriptInterface）。 */
interface AndroidApp {
  quit?(): void;
  openUrl?(url: string): void;
  keepAwake?(on: boolean): void;
  /** 振動と休みのミリ秒の並び（JSON の配列。空なら止める）。 */
  vibrate?(pattern: string): void;
}

function androidApp(): AndroidApp | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { LiminaliaApp?: AndroidApp }).LiminaliaApp ?? null;
}

/** iOS のアプリの口（window.webkit.messageHandlers.liminaliaApp。{"method", ...} の JSON を送る）。 */
function iosApp(): { postMessage(message: string): void } | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { webkit?: { messageHandlers?: { liminaliaApp?: { postMessage(message: string): void } } } }).webkit?.messageHandlers?.liminaliaApp ?? null;
}

/** iOS のアプリへ頼む（口が無ければ false）。 */
function askIos(message: Record<string, unknown>): boolean {
  const ios = iosApp();
  if (!ios) return false;
  ios.postMessage(JSON.stringify(message));
  return true;
}

/**
 * URL を外のブラウザで開く（@open-url）。スマホのアプリはゲームの WebView の中で開かず、端末のブラウザに渡す
 * （アプリが受けるのは http・https・mailto だけ）。デスクトップ版とブラウザ版は新しいウィンドウ（タブ）で開く。
 */
export function openExternal(url: string): void {
  const android = androidApp();
  if (typeof android?.openUrl === "function") return android.openUrl(url);
  if (askIos({ method: "open-url", url })) return;
  window.open(url, "_blank", "noopener");
}

/** ゲームからアプリを閉じられるか（デスクトップ版と Android のアプリ。iOS のアプリとブラウザは閉じられない）。 */
export function canQuitApp(): boolean {
  if (typeof window === "undefined") return false;
  return !!window.liminaliaDesktop || typeof androidApp()?.quit === "function";
}

/** アプリを閉じる（Android のアプリは LiminaliaApp.quit、ほかは window.close）。 */
export function quitApp(): void {
  const android = androidApp();
  if (typeof android?.quit === "function") android.quit();
  else window.close();
}

// ---- スリープを止める（オート中・動画の再生中） ----

/** スリープを止めている理由（"auto"・"movie" など）。一つでもあれば画面を消さない。 */
const awake = new Set<string>();
/** アプリとデスクトップ版に伝えた今の状態。 */
let told = false;
/** ブラウザの Screen Wake Lock。 */
let lock: { released: boolean; release(): Promise<void> } | null = null;
let watching = false;

type WakeLockApi = { request(type: "screen"): Promise<{ released: boolean; release(): Promise<void> }> };

/**
 * スリープ（画面が消えるの）を止める・戻す。reason ごとに数え、一つでも止めていれば止める。
 * Android のアプリは FLAG_KEEP_SCREEN_ON、iOS のアプリは isIdleTimerDisabled、デスクトップ版は preload の keepAwake（あれば。powerSaveBlocker）、
 * ブラウザは Screen Wake Lock（裏へ回ると外れるので、戻ったら取り直す）。
 */
export function keepAwake(reason: string, on: boolean): void {
  if (on) awake.add(reason);
  else awake.delete(reason);
  const want = awake.size > 0;
  if (want === told) return;
  told = want;
  const android = androidApp();
  if (typeof android?.keepAwake === "function") return android.keepAwake(want);
  if (askIos({ method: "keep-awake", on: want })) return;
  const desktop = typeof window === "undefined" ? undefined : window.liminaliaDesktop?.keepAwake;
  if (desktop) return desktop(want);
  void browserLock(want);
}

/** スリープを止めているか（テストと開発の道具）。 */
export function keepingAwake(): string[] {
  return [...awake];
}

async function browserLock(on: boolean): Promise<void> {
  if (typeof navigator === "undefined" || typeof document === "undefined") return;
  const api = (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock;
  if (!api) return;
  if (!watching) {
    watching = true;
    // 裏へ回ると外れるので、戻ったときにまだ要るなら取り直す
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && awake.size > 0) void browserLock(true);
    });
  }
  if (!on) {
    const held = lock;
    lock = null;
    await held?.release().catch(() => undefined);
    return;
  }
  if ((lock && !lock.released) || document.visibilityState !== "visible") return;
  try {
    const got = await api.request("screen");
    // 取っている間に要らなくなった
    if (awake.size === 0) await got.release().catch(() => undefined);
    else lock = got;
  } catch {
    // 許されない（電池の節約の設定など）。止められなくても遊べる
    lock = null;
  }
}

// ---- 振動（@vibrate） ----

type Actuator = { playEffect(type: "dual-rumble", params: { duration: number; startDelay?: number; strongMagnitude?: number; weakMagnitude?: number }): Promise<unknown>; reset?(): Promise<unknown> };

/** 振動のために置いたタイマー（止めるときに消す）。 */
const rumbleTimers: ReturnType<typeof setTimeout>[] = [];

/**
 * 端末を振動させる（pattern は振動と休みのミリ秒の並び。空なら止める）。Android のアプリは端末の振動（VIBRATE の許可を持つ）、
 * iOS のアプリは触覚（Core Haptics）、ブラウザは Vibration API。つないでいるゲームパッドがあれば、ゲームパッドも振動させる。
 */
export function vibrate(pattern: readonly number[]): void {
  const times = pattern.map((n) => Math.max(0, Math.round(n)));
  const stop = !times.some((n, i) => i % 2 === 0 && n > 0);
  rumble(stop ? [] : times);
  const android = androidApp();
  if (typeof android?.vibrate === "function") return android.vibrate(JSON.stringify(stop ? [] : times));
  if (askIos({ method: "haptic", pattern: stop ? [] : times })) return;
  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate(stop ? 0 : times);
}

/** つないでいるゲームパッド（振動できるもの）を、並びの振動の分だけ振動させる（空なら止める）。 */
function rumble(times: readonly number[]): void {
  for (const t of rumbleTimers.splice(0)) clearTimeout(t);
  if (typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") return;
  const actuators = [...navigator.getGamepads()].flatMap((p) => {
    const a = (p as (Gamepad & { vibrationActuator?: Actuator | null }) | null)?.vibrationActuator;
    return a && typeof a.playEffect === "function" ? [a] : [];
  });
  if (actuators.length === 0) return;
  if (times.length === 0) {
    for (const a of actuators) void a.reset?.().catch(() => undefined);
    return;
  }
  // 続けて頼むと前の振動が打ち切られるので、振動ごとに時間を置いて頼む
  let at = 0;
  times.forEach((ms, i) => {
    if (i % 2 === 0 && ms > 0) rumbleTimers.push(setTimeout(() => actuators.forEach((a) => void a.playEffect("dual-rumble", { duration: Math.min(ms, 5000), strongMagnitude: 1, weakMagnitude: 1 }).catch(() => undefined)), at));
    at += ms;
  });
}
