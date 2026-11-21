/**
 * 素材として扱うファイルの種類と拡張子。書き出し（lim build）はこの表にある拡張子の素材だけをゲームに入れ、
 * 制作画面は素材の画面で同じものを足せる。開発サーバーとデスクトップ版・スマホ版の書き出しは、同じ表で中身の種類（MIME）を答える。
 * 拡張子を足すときはここだけを書き換える（packages/desktop/main.cjs の MIME は CommonJS のため写しを持つ。並びを揃える）。
 */
export type MediaKind = "image" | "audio" | "video" | "subtitle" | "font" | "shader" | "model" | "script";

/** 種類 → 拡張子（小文字、. 付き）。 */
export const MEDIA_EXTENSIONS: Readonly<Record<MediaKind, readonly string[]>> = {
  image: [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".avif"],
  audio: [".mp3", ".ogg", ".m4a", ".wav", ".aac", ".opus"],
  video: [".mp4", ".webm", ".mov", ".ogv"],
  /** 字幕（WebVTT）。@movie の subtitles で video の中から読む。 */
  subtitle: [".vtt"],
  font: [".woff2", ".woff", ".ttf", ".otf", ".eot"],
  /** 作品のシェーダー（@effect shader の file。GLSL ES 1.0 のフラグメントシェーダー）。 */
  shader: [".frag", ".glsl"],
  /**
   * プラグインが描く立ち絵のモデル（cast.json の model）。Live2D の .moc3 と .model3.json・.motion3.json などの JSON、
   * Spine の骨格（.skel か .json）と .atlas。テクスチャは画像。
   */
  model: [".moc3", ".json", ".skel", ".atlas"],
  /** プラグインが読む外部のランタイム（作者が自分で入手して置く Live2D の Cubism Core、Spine のランタイム）。others に置く。 */
  script: [".js"],
};

/** 拡張子 → 中身の種類（MIME）。 */
export const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".aac": "audio/aac",
  ".opus": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".ogv": "video/ogg",
  ".vtt": "text/vtt",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".frag": "text/plain; charset=utf-8",
  ".glsl": "text/plain; charset=utf-8",
  ".moc3": "application/octet-stream",
  ".json": "application/json",
  ".skel": "application/octet-stream",
  ".atlas": "text/plain; charset=utf-8",
  ".js": "text/javascript",
};

const KIND_OF = new Map(Object.entries(MEDIA_EXTENSIONS).flatMap(([kind, list]) => list.map((ext) => [ext, kind as MediaKind] as const)));

/** ファイルの名前（かパス）の拡張子（小文字、. 付き。無ければ ""）。 */
export function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

/** 素材として扱えるファイルなら、その種類。扱えなければ null。 */
export function mediaKindOf(name: string): MediaKind | null {
  return KIND_OF.get(extensionOf(name)) ?? null;
}
