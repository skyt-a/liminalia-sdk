import { createHash } from "node:crypto";

/**
 * 書き出したゲーム（ブラウザ版とデスクトップ版）の Content Security Policy。index.html の <meta http-equiv="Content-Security-Policy"> に書く。
 * ゲームの中で読むものはゲームと同じ場所（'self'）からだけにし、外のページのスクリプトやプラグインの書いた HTML の中のスクリプトを動かさない。
 * - スクリプトはエンジンのファイルと、書き出しが index.html に書いた Service Worker を入れるスクリプト（中身のハッシュで許す）だけ
 * - 見た目（style）はエンジンが要素に直接書くので 'unsafe-inline'
 * - 絵、音、書体、取り寄せは data: と blob: も（セーブの縮小画像、パーツを重ねた立ち絵など）。SVG は <object> で読むので object-src も 'self'
 * - 止まったときの記録を送る先（build.crashReport.url）は connect-src に足す
 * 作品の設定（build.csp）で、指示ごとに許すものを足す（{ "connect-src": ["https://api.example.com"] }）か、false でその指示を外す。
 * build.csp を false にすると入れない（前の書き出しと同じ）。
 */
export type CspConfig = false | Record<string, string[] | false>;

export const DEFAULT_CSP: Readonly<Record<string, readonly string[]>> = {
  "default-src": ["'self'"],
  "script-src": ["'self'"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:", "blob:"],
  "media-src": ["'self'", "data:", "blob:"],
  "font-src": ["'self'", "data:", "blob:"],
  "connect-src": ["'self'", "data:", "blob:"],
  "worker-src": ["'self'", "blob:"],
  "object-src": ["'self'"],
  "frame-src": ["'self'"],
  "manifest-src": ["'self'"],
  "base-uri": ["'self'"],
  "form-action": ["'none'"],
};

/** HTML の中の、src の無い <script> の中身（ハッシュで許すもの）。 */
export function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]!).filter((s) => s.trim() !== "");
}

/** index.html の中のスクリプト（<script> と </script> の間）を許す、script-src の項目（'sha256-…'）。 */
export function scriptHashSource(script: string): string {
  return `'sha256-${createHash("sha256").update(script, "utf8").digest("base64")}'`;
}

/** 指示の並び（指示 → 許すもの）を作る。config が false なら null。 */
export function cspDirectives(config: CspConfig | undefined, o: { inline?: string[]; connect?: string[] } = {}): Record<string, string[]> | null {
  if (config === false) return null;
  const out: Record<string, string[]> = Object.fromEntries(Object.entries(DEFAULT_CSP).map(([k, v]) => [k, [...v]]));
  const add = (directive: string, sources: string[]) => {
    const list = (out[directive] ??= []);
    for (const s of sources) if (!list.includes(s)) list.push(s);
  };
  add("script-src", (o.inline ?? []).map(scriptHashSource));
  add("connect-src", o.connect ?? []);
  for (const [directive, sources] of Object.entries(config ?? {})) {
    if (sources === false) delete out[directive];
    else add(directive, sources);
  }
  return out;
}

/** 指示の並びを、CSP の文字列にする。 */
export const cspString = (directives: Record<string, string[]>): string =>
  Object.entries(directives)
    .map(([k, v]) => [k, ...v].join(" "))
    .join("; ");

/**
 * index.html に CSP を入れる（<meta charset> のすぐ後。前の CSP があれば置き換える）。index.html の中のスクリプトは中身のハッシュで許す。
 * connect は取り寄せを許す先（止まったときの記録の送り先など）。
 */
export function injectCsp(html: string, config: CspConfig | undefined, o: { connect?: string[] } = {}): string {
  const without = html.replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>/i, "");
  const directives = cspDirectives(config, { inline: inlineScripts(without), ...(o.connect ? { connect: o.connect } : {}) });
  if (!directives) return without;
  const meta = `<meta http-equiv="Content-Security-Policy" content="${cspString(directives).replace(/"/g, "&quot;")}" />`;
  const charset = /<meta charset="[^"]*"\s*\/?>/i.exec(without);
  if (!charset) throw new Error("index.html に <meta charset> が見つかりません");
  return without.replace(charset[0], `${charset[0]}\n    ${meta}`);
}

/** URL の場所（https://example.com）。読めなければ null。 */
export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    // URL として読めないものは null（呼ぶ側が設定の誤りとして出す）
    return null;
  }
}
