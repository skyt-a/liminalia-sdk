import type { CastModel } from "@liminalia/sdk";

/**
 * cast.json の model（type が "live2d"）の項目。人物に書いたものに、差分に書いたものが重なる（同じ type のとき。エンジンの attachPart）。
 *
 * - src: .model3.json（fgimage からのパス）。必須
 * - expression: この差分の表情（.model3.json の Expressions の Name）。省くと差分と同じ名前の表情（無ければ表情なし）。"" で表情なし
 * - motion: この差分で流すモーションのグループ（"グループ" か "グループ:番号"）。省くと差分と同じ名前のグループ（無ければ流さない）。"" で流さない
 * - idle: 待機のモーションのグループ（省くと Idle、"" で待機の動きなし）
 * - breath: 呼吸と体のわずかな揺れ（既定 true）
 * - blink: まばたき（既定 true）
 * - lipSync、eyeBlink: 口パクとまばたきのパラメーターの ID（省くと .model3.json の Groups の LipSync と EyeBlink）
 * - lipGain: 口の開きに掛ける大きさ（既定 1）
 * - scale、x、y: 枠の中での大きさ（既定 1）と、ずらす量（枠の幅と高さを 1 とした割合。右と下が正）
 * - core: Cubism Core のファイル（others からのパス。既定 live2d/live2dcubismcore.min.js）
 */
export interface Live2dOptions {
  src: string;
  expression: string | undefined;
  motion: string | undefined;
  idle: string | undefined;
  breath: boolean;
  blink: boolean;
  lipSync: string[] | undefined;
  eyeBlink: string[] | undefined;
  lipGain: number;
  scale: number;
  x: number;
  y: number;
  core: string;
}

export const DEFAULT_CORE = "live2d/live2dcubismcore.min.js";

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const ids = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined);

export function readOptions(model: CastModel | undefined): Live2dOptions {
  const m = (model ?? {}) as Record<string, unknown>;
  return {
    src: str(m.src) ?? "",
    expression: str(m.expression),
    motion: str(m.motion),
    idle: str(m.idle),
    breath: m.breath !== false,
    blink: m.blink !== false,
    lipSync: ids(m.lipSync),
    eyeBlink: ids(m.eyeBlink),
    lipGain: num(m.lipGain, 1),
    scale: num(m.scale, 1),
    x: num(m.x, 0),
    y: num(m.y, 0),
    core: str(m.core) || DEFAULT_CORE,
  };
}

/**
 * 差分の名前から、表情とモーションを選ぶ。書いたものが先、無ければ差分と同じ名前のもの（大文字と小文字は区別しない）。
 */
export function pickState(name: string, o: { expression?: string | undefined; motion?: string | undefined }, expressions: readonly string[], motions: readonly string[]): { expression: string | null; motion: string | null } {
  const same = (list: readonly string[]) => list.find((x) => x === name) ?? list.find((x) => x.toLowerCase() === name.toLowerCase()) ?? null;
  const expression = o.expression !== undefined ? o.expression || null : name ? same(expressions) : null;
  const motion = o.motion !== undefined ? o.motion || null : name ? same(motions) : null;
  return { expression, motion };
}

/** 待機のモーションのグループ。書いていなければ Idle（大文字と小文字は区別しない）。"" なら待機の動きなし。 */
export function pickIdle(idle: string | undefined, motions: readonly string[]): string | null {
  if (idle !== undefined) return idle || null;
  return motions.find((g) => g.toLowerCase() === "idle") ?? null;
}

/** .model3.json のあるフォルダからの相対パスを、fgimage からのパスにする（../ もたどる）。 */
export function resolvePath(base: string, rel: string): string {
  const dir = base.includes("/") ? base.slice(0, base.lastIndexOf("/") + 1) : "";
  const out: string[] = [];
  for (const part of `${dir}${rel}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/** 枠（幅 bw、高さ bh）の中に、縦横比を保って収めた範囲（左上と大きさ）。scale と x・y でずらす。 */
export function fitRect(canvas: { width: number; height: number }, box: { x: number; y: number; width: number; height: number }, o: Pick<Live2dOptions, "scale" | "x" | "y">): { x: number; y: number; width: number; height: number } {
  const s = Math.min(box.width / canvas.width, box.height / canvas.height) * o.scale;
  const width = canvas.width * s;
  const height = canvas.height * s;
  return { x: box.x + (box.width - width) / 2 + o.x * box.width, y: box.y + (box.height - height) / 2 + o.y * box.height, width, height };
}
