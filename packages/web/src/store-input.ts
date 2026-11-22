import { SYSTEM_ACTIONS, type SystemAction, type SystemController } from "./plugin.ts";
import type { PadButton } from "./system/navigation.ts";
import { pressPadButton } from "./system/input.ts";

/**
 * 店のコントローラーの操作（Steam Input。liminalia.json の build.steam.input）を、ゲームの操作にする。
 * デスクトップ版の main.cjs が、結んだアクションを押したときと離したときに知らせる。
 * ゲームパッドのボタン（a、b、start など。advance は a、back は b）は標準のゲームパッドと同じ動き、
 * システム画面の操作（auto、quick-save など）は押したときに SystemController.perform で行う。
 */

const PAD_BUTTONS: readonly PadButton[] = ["a", "b", "x", "y", "lb", "rb", "lt", "rt", "select", "start", "l3", "r3", "up", "down", "left", "right"];
const ALIASES: Record<string, PadButton> = { advance: "a", back: "b" };

/** アクションに結んだ操作の行き先。 */
export function inputActionTarget(action: string): { pad: PadButton } | { system: SystemAction } | null {
  const pad = ALIASES[action] ?? (PAD_BUTTONS as readonly string[]).find((b) => b === action);
  if (pad) return { pad: pad as PadButton };
  if ((SYSTEM_ACTIONS as readonly string[]).includes(action)) return { system: action as SystemAction };
  return null;
}

/** デスクトップ版の店のコントローラーの操作を受ける（無ければ何もしない）。 */
export function bindStoreInput(system: SystemController): void {
  window.liminaliaDesktop?.onInputAction?.((action, pressed) => {
    const target = inputActionTarget(action);
    if (!target) return;
    if ("pad" in target) pressPadButton(target.pad, pressed);
    else if (pressed) void system.perform?.(target.system);
  });
}
