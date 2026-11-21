import type { Diagnostic, Script, Statement } from "./ast.ts";
import type { UiTone } from "./ui.ts";

/**
 * 立ち絵の色調（@tone）。色調は「彩度 → 色を掛ける → コントラスト → 明るさ」の順にかける色の行列（SVG の feColorMatrix の 4×5）になる。
 * 組み込みのものは liminalia.json の ui.tones で同じ名前を書けば置き換えられる。
 *
 * 背景も色調を持てる（@bg の tone= か、liminalia.json の ui.backgroundTones）。その背景が出ている間は、@tone を書いていない立ち絵に掛ける。
 * 立ち絵に掛ける色調は、@tone の人物ごとのもの → @tone のすべての立ち絵のもの → 背景の色調 の順に決める。@tone none は @tone の色調を外して
 * 背景の色調に戻し、@tone plain は背景の色調も掛けない。
 */

export const BUILTIN_TONES: Readonly<Record<string, UiTone>> = {
  sepia: { saturation: 0, color: "#f2d4a6" },
  mono: { saturation: 0 },
  night: { color: "#8090d0", saturation: 0.7, brightness: 0.8 },
  evening: { color: "#ffb88a", amount: 0.85, saturation: 0.9 },
  dark: { brightness: 0.55 },
  // 色を変えない（背景に色調があっても掛けない）
  plain: {},
};

/** @bg の tone= で決めた、背景の色調（image はその背景。背景がほかの命令で替わったら効かない）。 */
export interface GivenBackgroundTone {
  image: string;
  tone: string;
}

/** 背景が立ち絵に掛ける色調の名前（@bg の tone= → ui.backgroundTones の順）。掛けないなら null。 */
export function backgroundToneName(background: string | null | undefined, given: GivenBackgroundTone | undefined, map: Readonly<Record<string, string>> | undefined): string | null {
  if (!background) return null;
  const name = given && given.image === background ? given.tone : map?.[background];
  return typeof name === "string" && name !== "" && name !== "none" ? name : null;
}

/** 立ち絵 who に掛ける色調の名前（@tone の人物ごと → @tone のすべての立ち絵 → 背景の色調 → none）。 */
export function spriteToneName(tones: Readonly<Record<string, string>> | undefined, who: string, background: string | null): string {
  return tones?.[who] ?? tones?.[""] ?? background ?? "none";
}

/** 何もしない行列。 */
export const IDENTITY_MATRIX: readonly number[] = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];

/** 名前の色調（ui.tones → 組み込み）。none は null、無い名前は undefined。 */
export function findTone(name: string, tones?: Readonly<Record<string, UiTone>>): UiTone | null | undefined {
  if (name === "none") return null;
  return tones?.[name] ?? BUILTIN_TONES[name];
}

/** 色調の行列（feColorMatrix の values の 20 個。行は R・G・B・A、列は R・G・B・A・足す値）。 */
export function toneMatrix(tone: UiTone | null | undefined): number[] {
  if (!tone) return [...IDENTITY_MATRIX];
  // 彩度（輝度を保つ）
  const s = tone.saturation ?? 1;
  const lr = 0.2126;
  const lg = 0.7152;
  const lb = 0.0722;
  const sat = [
    [lr * (1 - s) + s, lg * (1 - s), lb * (1 - s)],
    [lr * (1 - s), lg * (1 - s) + s, lb * (1 - s)],
    [lr * (1 - s), lg * (1 - s), lb * (1 - s) + s],
  ];
  // 色を掛ける（amount だけ混ぜる）
  const hex = /^#([0-9a-f]{6})$/i.exec(tone.color ?? "")?.[1];
  const n = hex ? parseInt(hex, 16) : 0xffffff;
  const amount = hex ? (tone.amount ?? 1) : 0;
  const mul = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => 1 - amount + (amount * c) / 255);
  const c = tone.contrast ?? 1;
  const b = tone.brightness ?? 1;
  const out: number[] = [];
  for (let row = 0; row < 3; row++) {
    const k = mul[row]! * c * b;
    out.push(sat[row]![0]! * k, sat[row]![1]! * k, sat[row]![2]! * k, 0, 0.5 * (1 - c) * b);
  }
  out.push(0, 0, 0, 1, 0);
  return out;
}

/** 二つの行列の途中（t は 0〜1）。 */
export function mixMatrix(from: readonly number[], to: readonly number[], t: number): number[] {
  return to.map((v, i) => from[i]! + (v - from[i]!) * t);
}

/** 色調の名前を tone の引数に書く命令（値は位置引数でも書けるか。@tone だけ）。 */
const TONE_ARGS = new Map([
  ["tone", true],
  ["bg", false],
  ["scene-change", false],
]);

/** シナリオの @tone と @bg・@scene-change の tone= の色調の名前、ui.backgroundTones の色調の名前が、組み込みか ui.tones にあるか。 */
export function checkTones(scripts: ReadonlyMap<string, Script>, ui: unknown): Diagnostic[] {
  const out: Diagnostic[] = [];
  const u = ui && typeof ui === "object" ? (ui as { tones?: unknown; backgroundTones?: unknown }) : undefined;
  const raw = u?.tones;
  const tones = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, UiTone>) : undefined;
  const known = [...new Set([...Object.keys(BUILTIN_TONES), ...Object.keys(tones ?? {}), "none"])];
  const visit = (file: string, body: Statement[]) => {
    for (const s of body) {
      if (s.kind === "command" && TONE_ARGS.has(s.name)) {
        const a = s.args.find((x) => x.key === "tone") ?? (TONE_ARGS.get(s.name) ? s.args.find((x) => x.key === null) : undefined);
        if (a?.value.kind === "string" && findTone(a.value.value, tones) === undefined) {
          out.push({ severity: "error", code: "unknown-tone", message: `色調 ${a.value.value} はありません`, file, line: s.line, column: a.column, hint: known.join(" / ") });
        }
      }
      if (s.kind === "if") for (const b of s.branches) visit(file, b.body);
      if (s.kind === "define") visit(file, s.body);
    }
  };
  for (const [file, script] of scripts) visit(file, script.body);
  const map = u?.backgroundTones;
  if (map && typeof map === "object" && !Array.isArray(map)) {
    for (const [image, name] of Object.entries(map as Record<string, unknown>)) {
      if (typeof name === "string" && findTone(name, tones) === undefined) {
        out.push({ severity: "error", code: "unknown-tone", message: `ui.backgroundTones の ${image} の色調 ${name} はありません`, file: "liminalia.json", line: 1, hint: known.join(" / ") });
      }
    }
  }
  return out;
}
