/**
 * ゲームパッドのボタンの表記（操作説明とコンフィグの「操作」）。ボタンの名前は標準の配置（a は下、b は右、x は左、y は上）で、
 * 表記だけを機種に合わせる。コンフィグの「ボタンの表記」で選び、選んでいなければつないだゲームパッドの名前から決める。
 */
export const PAD_STYLES = ["xbox", "playstation", "nintendo"] as const;
export type PadStyle = (typeof PAD_STYLES)[number];

const NAMES: Record<PadStyle, Record<string, string>> = {
  xbox: { a: "A", b: "B", x: "X", y: "Y", lb: "LB", rb: "RB", lt: "LT", rt: "RT", start: "START", select: "SELECT", l3: "LS", r3: "RS" },
  playstation: { a: "✕", b: "○", x: "□", y: "△", lb: "L1", rb: "R1", lt: "L2", rt: "R2", start: "OPTIONS", select: "SHARE", l3: "L3", r3: "R3" },
  // Nintendo の配置は、下が B、右が A、左が Y、上が X
  nintendo: { a: "B", b: "A", x: "Y", y: "X", lb: "L", rb: "R", lt: "ZL", rt: "ZR", start: "+", select: "−", l3: "LS", r3: "RS" },
};

/** つないだゲームパッドの名前（Gamepad.id）から表記を決める（分からなければ Xbox）。 */
export function detectPadStyle(ids: readonly string[] = connectedPads()): PadStyle {
  for (const id of ids) {
    if (/054c|playstation|dualshock|dualsense|wireless controller/i.test(id)) return "playstation";
    if (/057e|nintendo|pro controller|joy-?con/i.test(id)) return "nintendo";
  }
  return "xbox";
}

function connectedPads(): string[] {
  try {
    return typeof navigator !== "undefined" && typeof navigator.getGamepads === "function" ? [...navigator.getGamepads()].flatMap((p) => (p ? [p.id] : [])) : [];
  } catch {
    return [];
  }
}

/** ボタンの表記。style が "" ならつないだゲームパッドから決める。 */
export function padLabel(button: string, style: string): string {
  const s: PadStyle = (PAD_STYLES as readonly string[]).includes(style) ? (style as PadStyle) : detectPadStyle();
  return NAMES[s][button] ?? button.toUpperCase();
}
