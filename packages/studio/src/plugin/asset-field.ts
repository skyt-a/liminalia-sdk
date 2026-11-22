import type { StudioContext } from "../plugin.ts";
import { PS } from "./strings.ts";

/**
 * 素材を選ぶ欄（制作画面のプラグインの画面が使う）。作品の素材の一覧（ctx.project.assets）から候補を出し、
 * 画像の素材なら小さな見本を添える。一覧に無いパスを入れると data-missing を付けて知らせる（入れた値はそのまま残す）。
 * 見た目は制作画面の入力欄と同じで、.plugin-asset-field・.plugin-asset-field-preview で変えられる。
 */
export interface AssetFieldOptions {
  /** 素材のフォルダ（bgimage・fgimage・image・bgm・sound・video・others など）。 */
  kind: string;
  value?: string;
  /** 値を確かめたとき（候補から選んだ・入れ終えた）。 */
  onChange?(value: string): void;
  placeholder?: string;
  /** 空にできるか（既定 true）。 */
  allowEmpty?: boolean;
  /** 見本を出すか（既定は画像のフォルダなら出す）。 */
  preview?: boolean;
  /** 読み上げの名前。 */
  label?: string;
}

export interface AssetField {
  readonly el: HTMLElement;
  readonly value: string;
  set(value: string): void;
  /** 素材の一覧を読み直す（作品が変わったとき。onProjectChanged で自動で呼ぶ）。 */
  refresh(): void;
  dispose(): void;
}

const IMAGE_KINDS = new Set(["bgimage", "fgimage", "image"]);
let serial = 0;

export function assetField(ctx: Pick<StudioContext, "project" | "assetUrl" | "onProjectChanged">, o: AssetFieldOptions): AssetField {
  const id = `plugin-asset-field-${++serial}`;
  const root = document.createElement("span");
  root.className = "plugin-asset-field";
  root.style.cssText = "display:inline-flex;align-items:center;gap:6px";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "mono";
  input.spellcheck = false;
  input.placeholder = o.placeholder ?? (o.allowEmpty === false ? "" : PS.assetNone);
  input.setAttribute("list", id);
  if (o.label) input.setAttribute("aria-label", o.label);
  const list = document.createElement("datalist");
  list.id = id;
  const showPreview = o.preview ?? IMAGE_KINDS.has(o.kind);
  const preview = showPreview ? document.createElement("img") : null;
  if (preview) {
    preview.className = "plugin-asset-field-preview";
    preview.alt = "";
    preview.style.cssText = "width:32px;height:32px;object-fit:contain;border-radius:var(--r-s, 4px);background:var(--el, transparent)";
  }
  root.append(input, list, ...(preview ? [preview] : []));
  let value = o.value ?? "";
  let known = new Set<string>();

  const sync = () => {
    input.value = value;
    const missing = value !== "" && !known.has(value);
    root.toggleAttribute("data-missing", missing);
    input.title = missing ? PS.assetMissing(value) : value;
    if (preview) {
      preview.hidden = value === "" || missing;
      if (!preview.hidden) preview.src = ctx.assetUrl(o.kind, value);
    }
  };
  const refresh = () => {
    const paths = ctx.project.assets[o.kind] ?? [];
    known = new Set(paths);
    list.replaceChildren(...paths.map((p) => Object.assign(document.createElement("option"), { value: p })));
    input.setAttribute("aria-description", PS.assetCount(paths.length));
    sync();
  };
  const commit = () => {
    const next = input.value.trim();
    if (next === "" && o.allowEmpty === false) return sync();
    if (next === value) return sync();
    value = next;
    sync();
    o.onChange?.(value);
  };
  input.addEventListener("change", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) commit();
    if (e.key === "Escape") sync();
  });
  const off = ctx.onProjectChanged(refresh);
  refresh();
  return {
    el: root,
    get value() {
      return value;
    },
    set(next) {
      value = next;
      sync();
    },
    refresh,
    dispose() {
      off();
    },
  };
}
