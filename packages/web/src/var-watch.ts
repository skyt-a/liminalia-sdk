import type { Value } from "@liminalia/runtime";
import { devText } from "./dev-language.ts";
import type { SystemController } from "./plugin.ts";

/**
 * 変数の監視（開発サーバーだけ。F9 で出し入れ）。遊びながら game・temp・system の変数を見て、値を書き換えられる。
 * - 一覧はページを進めるたび・様子が変わるたびに描き直す。名前で絞り込め、☆で留めたものは上に並べる（留めたものはこのブラウザに覚える）
 * - 値を押すと書き換えられる（JSON の書き方。文字は "…"）。書き換えは今のプレイの変数に入れるだけで、セーブはしない
 */
export function installVarWatch(stage: HTMLElement, system: SystemController): void {
  const PIN_KEY = "liminalia:var-watch:pins";
  let pins = new Set<string>();
  try {
    pins = new Set(JSON.parse(localStorage.getItem(PIN_KEY) ?? "[]") as string[]);
  } catch {
    pins = new Set();
  }
  const panel = document.createElement("div");
  panel.className = "lm-var-watch";
  panel.hidden = true;
  const filter = document.createElement("input");
  filter.type = "search";
  filter.placeholder = devText("変数を絞り込む", "Filter variables");
  filter.setAttribute("aria-label", filter.placeholder);
  const list = document.createElement("div");
  list.className = "lm-var-list";
  panel.append(filter, list);
  // 中の操作は本文の送りにしない
  for (const type of ["click", "wheel", "pointerdown", "keydown"]) panel.addEventListener(type, (e) => e.stopPropagation());
  stage.append(panel);

  const scopes = (): [string, Record<string, Value>][] => {
    const rt = system.runtime;
    return [
      ["game", (rt?.state.game ?? {}) as Record<string, Value>],
      ["temp", (rt?.state.temp ?? {}) as Record<string, Value>],
      ["system", system.systemVariables as Record<string, Value>],
    ];
  };

  const render = () => {
    if (panel.hidden) return;
    if (panel.contains(document.activeElement) && document.activeElement !== filter) return;
    const q = filter.value.trim().toLowerCase();
    const rows: { path: string; scope: Record<string, Value>; key: string; value: Value }[] = [];
    for (const [name, scope] of scopes()) for (const [key, value] of Object.entries(scope)) rows.push({ path: `${name}.${key}`, scope, key, value });
    const shown = rows.filter((r) => q === "" || r.path.toLowerCase().includes(q)).sort((a, b) => Number(pins.has(b.path)) - Number(pins.has(a.path)));
    list.replaceChildren(
      ...shown.map((r) => {
        const row = document.createElement("div");
        row.className = "lm-var-row";
        const pin = document.createElement("button");
        pin.type = "button";
        pin.className = "lm-var-pin";
        pin.textContent = pins.has(r.path) ? "★" : "☆";
        pin.onclick = () => {
          if (pins.has(r.path)) pins.delete(r.path);
          else pins.add(r.path);
          try {
            localStorage.setItem(PIN_KEY, JSON.stringify([...pins]));
          } catch {
            // 覚えられなくても、開いている間は留める
          }
          render();
        };
        const name = document.createElement("span");
        name.className = "lm-var-name";
        name.textContent = r.path;
        const value = document.createElement("input");
        value.className = "lm-var-value";
        value.value = JSON.stringify(r.value);
        value.onchange = () => {
          try {
            r.scope[r.key] = JSON.parse(value.value) as Value;
            value.classList.remove("is-bad");
          } catch {
            value.classList.add("is-bad");
          }
        };
        value.onkeydown = (e) => {
          if (e.key === "Enter") value.blur();
        };
        value.onblur = () => render();
        row.append(pin, name, value);
        return row;
      }),
    );
  };

  filter.addEventListener("input", render);
  window.addEventListener("keydown", (e) => {
    if (e.key !== "F9") return;
    e.preventDefault();
    panel.hidden = !panel.hidden;
    render();
  });
  system.onStatusChange?.(() => render());
  // 命令で値が変わっても、ページを進めなくても追えるように少しずつ見直す
  setInterval(render, 500);
}
