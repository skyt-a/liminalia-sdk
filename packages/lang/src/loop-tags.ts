/**
 * OGG（Vorbis・Opus）の頭のコメントから、ループの位置（LOOPSTART・LOOPLENGTH・LOOPEND。標本の数）を秒で読む。
 * ゲームの音楽で広く使われている書き方。標本の速さは Vorbis の識別のヘッダー、Opus は 48000。無ければ null。
 * プレイヤー（packages/web の AudioPlayer）と制作画面（BGM の波形）が同じものを使う。
 */
export function readLoopTags(data: ArrayBuffer): { start?: number; end?: number } | null {
  const bytes = new Uint8Array(data, 0, Math.min(data.byteLength, 256 * 1024));
  const text = new TextDecoder("latin1").decode(bytes);
  const tag = (name: string) => {
    const m = new RegExp(`${name}=(\\d+)`, "i").exec(text);
    return m ? Number(m[1]) : undefined;
  };
  const start = tag("LOOPSTART");
  const length = tag("LOOPLENGTH");
  const end = tag("LOOPEND");
  if (start === undefined && length === undefined && end === undefined) return null;
  let rate = 0;
  const vorbis = text.indexOf("\x01vorbis");
  if (vorbis >= 0 && vorbis + 16 <= bytes.length) rate = new DataView(bytes.buffer, bytes.byteOffset + vorbis + 12, 4).getUint32(0, true);
  else if (text.includes("OpusHead")) rate = 48000;
  if (!rate) return null;
  const out: { start?: number; end?: number } = {};
  if (start !== undefined) out.start = start / rate;
  if (end !== undefined) out.end = end / rate;
  else if (length !== undefined) out.end = ((start ?? 0) + length) / rate;
  return out;
}
