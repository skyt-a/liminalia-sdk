/**
 * 店の実績へ送る口。デスクトップ版は preload の liminaliaDesktop（Steam など。store.cjs）へ、スマホ版はアプリが置く口
 * （iOS は window.webkit.messageHandlers.liminaliaAchievements の Game Center、Android は window.LiminaliaAchievements の
 * Google Play Games。packages/cli の mobile/achievements.ts）へ送る。送り先が無ければ何も返さない（ブラウザ版は送らない）。
 */
export interface AchievementSink {
  onAchievement?(id: string): void;
  onAchievementProgress?(id: string, value: number, goal: number): void;
}

/** スマホ版のアプリが置く口。 */
interface NativeWindow {
  webkit?: { messageHandlers?: { liminaliaAchievements?: { postMessage(message: string): void } } };
  LiminaliaAchievements?: { call(message: string): void };
}

/** スマホ版のアプリへ {"method", "id", "value", "goal"} の JSON を送る関数（口が無ければ null）。 */
export function nativeAchievements(w: NativeWindow): ((message: { method: "unlock" | "progress"; id: string; value?: number; goal?: number }) => void) | null {
  const ios = w.webkit?.messageHandlers?.liminaliaAchievements;
  const android = w.LiminaliaAchievements;
  if (ios) return (m) => ios.postMessage(JSON.stringify(m));
  if (android) return (m) => android.call(JSON.stringify(m));
  return null;
}

export function achievementSink(): AchievementSink {
  if (typeof window === "undefined") return {};
  const desktop = window.liminaliaDesktop;
  if (desktop?.achievement) {
    const out: AchievementSink = { onAchievement: (id) => desktop.achievement!(id) };
    if (desktop.achievementProgress) out.onAchievementProgress = (id, value, goal) => desktop.achievementProgress!(id, value, goal);
    return out;
  }
  const send = nativeAchievements(window as unknown as NativeWindow);
  if (!send) return {};
  return {
    onAchievement: (id) => send({ method: "unlock", id }),
    onAchievementProgress: (id, value, goal) => send({ method: "progress", id, value, goal }),
  };
}
