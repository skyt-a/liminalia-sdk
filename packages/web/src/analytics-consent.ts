/**
 * 遊ばれ方の統計（analytics.ts）を送ってよいかの、遊ぶ人の答え。システム画面（尋ねる、コンフィグの「遊び方の統計を送信」）が使うので、
 * 送る部品（analytics.ts。build.analytics を書いた作品の書き出しにだけ入る）とは分けて、いつも束に入る小さなものにする。
 */

/**
 * 答えを覚える鍵。"liminalia:<id>:" で始めない（その鍵はセーブの置き場所が起動のたびに localStorage から IndexedDB へ移して消すため。
 * system/idb-store.ts）。
 */
const consentKey = (projectId: string) => `liminalia-analytics:${projectId}`;

/** 尋ねて送ってよい場か（自動の確かめ（ブラウザの自動操作と、自動で進める遊び方）では尋ねず、送らない）。 */
export function analyticsAskable(host: { automated?: boolean }): boolean {
  if (typeof navigator !== "undefined" && navigator.webdriver) return false;
  return !host.automated;
}

/** 遊ぶ人の答え（送る true、送らない false、まだ尋ねていない null）。 */
export function analyticsConsent(projectId: string): boolean | null {
  try {
    const v = localStorage.getItem(consentKey(projectId));
    return v === "on" ? true : v === "off" ? false : null;
  } catch {
    // 端末に覚えられない（プライベートの窓など）ときは、まだ答えていないものとして扱う
    return null;
  }
}

export function setAnalyticsConsent(projectId: string, on: boolean): void {
  try {
    localStorage.setItem(consentKey(projectId), on ? "on" : "off");
  } catch {
    // 覚えられなければ、次の起動でまた尋ねる
  }
}
