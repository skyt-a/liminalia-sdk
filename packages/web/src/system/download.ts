/**
 * ファイルを遊ぶ人に渡す（スクリーンショットとセーブデータのエクスポート）。
 * ブラウザは <a download> で保存させる。スマホ版のアプリ（lim build android・ios）の WebView は <a download> を受けないので、
 * アプリが置く口へ中身（base64）を渡し、アプリが共有のシートを開く（端末に保存する、ファイルに保存する、ほかのアプリへ送る）。
 * - Android: window.LiminaliaFiles.save(名前, MIME, base64) → 開けたら true（packages/cli の mobile/android.ts）
 * - iOS: window.webkit.messageHandlers.liminaliaFiles.postMessage(JSON) （mobile/ios.ts）
 */
interface FilesWindow {
  LiminaliaFiles?: { save(name: string, mime: string, base64: string): boolean };
  webkit?: { messageHandlers?: { liminaliaFiles?: { postMessage(message: string): void } } };
}

/** アプリの口があるか（スマホ版のアプリの中か）。 */
export function nativeFiles(w: Window = window): boolean {
  const f = w as unknown as FilesWindow;
  return !!f.LiminaliaFiles || !!f.webkit?.messageHandlers?.liminaliaFiles;
}

/** data URL か Blob の中身を、MIME と base64 にする。 */
export async function toBase64(data: Blob | string): Promise<{ mime: string; base64: string }> {
  const url = typeof data === "string" ? data : await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("read"));
    r.readAsDataURL(data);
  });
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url);
  if (!m) throw new Error("data URL ではありません");
  const mime = m[1] || (typeof data === "string" ? "application/octet-stream" : data.type || "application/octet-stream");
  const base64 = m[2] ? m[3]! : btoa(unescape(encodeURIComponent(decodeURIComponent(m[3]!))));
  return { mime, base64 };
}

/** ファイルを保存させる（data は data URL か Blob）。渡せたら true。 */
export async function saveFile(name: string, data: Blob | string, w: Window = window): Promise<boolean> {
  const f = w as unknown as FilesWindow;
  if (f.LiminaliaFiles || f.webkit?.messageHandlers?.liminaliaFiles) {
    try {
      const { mime, base64 } = await toBase64(data);
      if (f.LiminaliaFiles) return f.LiminaliaFiles.save(name, mime, base64) !== false;
      f.webkit!.messageHandlers!.liminaliaFiles!.postMessage(JSON.stringify({ name, mime, data: base64 }));
      return true;
    } catch (e) {
      console.warn("ファイルを渡せません", e);
      return false;
    }
  }
  const a = w.document.createElement("a");
  const url = typeof data === "string" ? data : URL.createObjectURL(data);
  a.href = url;
  a.download = name;
  a.click();
  if (typeof data !== "string") setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
