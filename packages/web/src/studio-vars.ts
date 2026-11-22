import { FORBIDDEN_PROPERTIES, VARIABLE_PATH } from "@liminalia/lang";
import type { SaveData, Value } from "@liminalia/runtime";

/**
 * 制作画面のプレビュー（`?studio=1`）で、動いている実行器の変数の値を変える（stage-set-var）。main.ts の connectStudio だけが使うので、書き出しには入らない。
 * ファイルや初期値には書かない。値を入れた行として知らせない（`Runtime.setVariable` を通さず、onAssign を呼ばない）。
 * game・temp は実行器ごと捨てるので組み立て直せば元に戻るが、system は実行器をまたいで残るので、元の値を覚えておいて restore で戻す。
 */

/** 実行器のうち、ここで使うところ。 */
export interface VariableScopes {
  state: { game: Record<string, Value>; temp: Record<string, Value> };
  system: Record<string, Value>;
}

function scopeOf(rt: VariableScopes, name: string): Record<string, Value> | null {
  return name === "game" ? rt.state.game : name === "temp" ? rt.state.temp : name === "system" ? rt.system : null;
}

function read(root: Record<string, Value>, keys: readonly string[]): Value | undefined {
  let at: Value | undefined = root;
  for (const key of keys) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<string, Value>)[key];
  }
  return at;
}

function write(root: Record<string, Value>, keys: readonly string[], value: Value | undefined): void {
  let at = root;
  for (const key of keys.slice(0, -1)) {
    const next = at[key];
    at = (next !== null && typeof next === "object" ? next : (at[key] = {})) as Record<string, Value>;
  }
  const last = keys.at(-1)!;
  if (value === undefined) delete at[last];
  else at[last] = value;
}

export class StageVariables {
  /** system の変数の元の値（戻すときに使う）。 */
  private readonly systemWas = new Map<string, { root: Record<string, Value>; keys: string[]; value: Value | undefined }>();
  /** 変えた game の変数（ページの途中のセーブは、ページの頭の値を持っているので足して返す）。 */
  private readonly game = new Set<string>();

  /** 値を入れる。入れられないパスなら理由を返す。 */
  set(rt: VariableScopes, path: string, value: Value): string | null {
    if (!VARIABLE_PATH.test(path)) return `bad-path: ${path}`;
    const [scope = "", ...keys] = path.split(".");
    if (keys.some((k) => FORBIDDEN_PROPERTIES.has(k))) return `bad-path: ${path}`;
    const root = scopeOf(rt, scope);
    if (!root) return `bad-path: ${path}`;
    if (scope === "system" && !this.systemWas.has(path)) this.systemWas.set(path, { root, keys, value: read(root, keys) });
    if (scope === "game") this.game.add(path);
    write(root, keys, value);
    return null;
  }

  /** プレイヤーへ返すセーブに、変えた game の今の値を足す（ページの頭で作ったセーブには入っていない）。 */
  patch(rt: VariableScopes, save: SaveData): SaveData {
    if (this.game.size === 0) return save;
    const game = structuredClone(save.game) as Record<string, Value>;
    for (const path of this.game) {
      const keys = path.split(".").slice(1);
      write(game, keys, read(rt.state.game, keys));
    }
    return { ...save, game };
  }

  /** 組み立て直すとき: system の変数を元に戻し、覚えを空にする。 */
  restore(): void {
    for (const { root, keys, value } of this.systemWas.values()) write(root, keys, value);
    this.systemWas.clear();
    this.game.clear();
  }
}
