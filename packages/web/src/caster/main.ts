import { appearanceKey, castProblems, FRAME_POSITIONS, positionNames, translateDiagnosticText, type Cast, type CastAppearance, type CastEntry, type CastFrame, type CastVariant } from "@liminalia/lang";
import {
  addAppearance,
  addCharacter,
  addPosition,
  cloneFrame,
  ensureFrame,
  folderOf,
  frameFromNatural,
  HANDLES,
  History,
  imageExtension,
  imageFileName,
  initialFrameAlone,
  initialFrameFromReference,
  normalizeKey,
  opaqueBounds,
  pinchResize,
  positionOf,
  referenceVariantKey,
  removeAppearance,
  resizeBox,
  sanitizeFileBase,
  syncToAllVariants,
  syncToOtherPositions,
  uniqueKey,
  resizeAround,
  wheelResize,
  type Box,
  type FullFrame,
  type Handle,
  type ImageInfo,
  type Size,
} from "./model.ts";
import type { CasterState, SaveResult } from "./server.ts";

/**
 * 立ち絵の位置調整画面（開発サーバーの /__liminalia/cast）。Tyrano Tatie の調整画面と同じ操作で、cast.json の枠を直す。
 * 舞台は作品の画面サイズの領域を縮小して出し、座標は常に作品の座標で扱う。
 * 編集はキャスト全体の写しに対して行い、保存で cast.json に書く（開発サーバーが前の版を残し、取り込み元にも書き戻す）。
 */

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * 画面の言語。制作画面の中では制作画面が ?lang= で渡し、単独では制作画面で選んだ言語（同じオリジンの localStorage）、
 * それも無ければブラウザの言語（日本語なら日本語、ほかは英語）。
 */
const english = ((): boolean => {
  const given = new URLSearchParams(location.search).get("lang");
  if (given === "ja" || given === "en") return given === "en";
  try {
    const v = localStorage.getItem("liminalia.studio.language");
    if (v === "ja" || v === "en") return v === "en";
  } catch {
    // 使えなければブラウザの言語
  }
  return !navigator.language.toLowerCase().startsWith("ja");
})();
/** 今の言語の方の文言。 */
const tr = (ja: string, en: string): string => (english ? en : ja);

/** 開発サーバー（server.ts）が返す日本語の文の英語。表に無いものは構文チェックの英語で訳し、それも無ければそのまま。 */
const SERVER_EN: [RegExp, (...m: string[]) => string][] = [
  [/^別のオリジンからは使えません$/, () => "Requests from another origin aren't allowed"],
  [/^application\/json で送ってください$/, () => "Send it as application/json"],
  [/^cast がありません$/, () => "cast is missing"],
  [/^speakers は話者の名前の配列で送ってください$/, () => "Send speakers as an array of speaker names"],
  [/^キャラクターの設定に誤りがあります$/, () => "The character settings have errors"],
  [/^cast\.json がほかで変更されています$/, () => "cast.json was changed elsewhere"],
  [/^X-Liminalia ヘッダーがありません$/, () => "The X-Liminalia header is missing"],
  [/^画像のパスとして使えません: (.*)$/s, (p) => `Can't be used as an image path: ${p}`],
  [/^(.*) はすでにあります$/s, (p) => `${p} already exists`],
  [/^(.*) はありません$/s, (p) => `${p} doesn't exist`],
  [/^データが大きすぎます$/, () => "The data is too large"],
  [/^インポート元に書き戻す先がありません。次の lim import で cast\.json は上書きされます$/, () => "There's nowhere to write back to in the import source. The next lim import will overwrite cast.json"],
  [/^位置とサイズが未設定の差分は Tyrano Tatie の設定に書き込めないため、書き戻していません: (.*)$/s, (list) => `Variants without a position and size can't be written to the Tyrano Tatie settings, so they weren't written back: ${list.split("、").join(", ")}`],
  [/^インポート元への書き戻しに失敗しました: (.*)$/s, (m) => `Couldn't write back to the import source: ${m}`],
];
function serverText(text: string): string {
  if (!english) return text;
  for (const [re, en] of SERVER_EN) {
    const m = re.exec(text);
    if (m) return en(...m.slice(1));
  }
  return translateDiagnosticText(text) ?? text;
}

/** 書いてある画面の文言（caster.html の data-en、data-en-title、data-en-placeholder）を英語にする。 */
if (english) {
  document.documentElement.lang = "en";
  for (const el of document.querySelectorAll<HTMLElement>("[data-en]")) el.textContent = el.dataset.en!;
  for (const el of document.querySelectorAll<HTMLElement>("[data-en-title]")) el.title = el.dataset.enTitle!;
}
const ui = {
  title: $("title"),
  scale: $("scale"),
  dirty: $("dirty"),
  writeback: $("writeback"),
  undo: $<HTMLButtonElement>("undo"),
  redo: $<HTMLButtonElement>("redo"),
  save: $<HTMLButtonElement>("save"),
  who: $<HTMLSelectElement>("who"),
  appearance: $<HTMLSelectElement>("appearance"),
  variant: $<HTMLSelectElement>("variant"),
  position: $<HTMLSelectElement>("position"),
  frameless: $("frameless"),
  targetOpacity: $<HTMLInputElement>("target-opacity"),
  targetOpacityNumber: $<HTMLInputElement>("target-opacity-number"),
  left: $<HTMLInputElement>("left"),
  top: $<HTMLInputElement>("top"),
  width: $<HTMLInputElement>("width"),
  height: $<HTMLInputElement>("height"),
  keepRatio: $<HTMLInputElement>("keep-ratio"),
  showAll: $<HTMLInputElement>("show-all"),
  syncCenter: $<HTMLInputElement>("sync-center"),
  syncCenterRow: $("sync-center-row"),
  viewport: $("viewport"),
  stageFrame: $("stage-frame"),
  stage: $("stage"),
  bg: $<HTMLImageElement>("bg"),
  ghosts: $("ghosts"),
  positions: $("positions"),
  target: $("target"),
  empty: $("empty"),
  background: $<HTMLSelectElement>("background"),
  showGameUi: $<HTMLInputElement>("show-game-ui"),
  clipGame: $<HTMLInputElement>("clip-game"),
  clipGameRow: $("clip-game-row"),
  gameOverlay: $<HTMLIFrameElement>("game-overlay"),
  cmpWho: $<HTMLSelectElement>("cmp-who"),
  cmpAppearance: $<HTMLSelectElement>("cmp-appearance"),
  cmpPosition: $<HTMLSelectElement>("cmp-position"),
  cmpVariant: $<HTMLSelectElement>("cmp-variant"),
  cmpOpacity: $<HTMLInputElement>("cmp-opacity"),
  cmpOpacityNumber: $<HTMLInputElement>("cmp-opacity-number"),
  cmpFilter: $<HTMLSelectElement>("cmp-filter"),
  status: $("status"),
  dialog: $<HTMLDialogElement>("add-dialog"),
  drop: $("drop"),
  file: $<HTMLInputElement>("file"),
  preview: $<HTMLImageElement>("preview"),
  addFolder: $<HTMLInputElement>("add-folder"),
  addName: $<HTMLInputElement>("add-name"),
  addKey: $<HTMLInputElement>("add-key"),
  addStatus: $("add-status"),
  addOk: $<HTMLButtonElement>("add-ok"),
  addCancel: $<HTMLButtonElement>("add-cancel"),
};
const targetImg = ui.target.querySelector("img")!;
const targetLabel = ui.target.querySelector<HTMLElement>(".label")!;

const FILTERS: Record<string, string> = {
  none: "none",
  red: "sepia(1) saturate(8) hue-rotate(315deg)",
  blue: "sepia(1) saturate(8) hue-rotate(170deg)",
  green: "sepia(1) saturate(8) hue-rotate(65deg)",
  magenta: "sepia(1) saturate(8) hue-rotate(255deg)",
  cyan: "sepia(1) saturate(8) hue-rotate(135deg)",
  yellow: "sepia(1) saturate(8) hue-rotate(25deg)",
  mono: "grayscale(1) contrast(1.25)",
};
const NONE = "__none";
const ALL = "__all";
const SAME_POSITION = "__current";

// ---- 状態 ----

interface Selection {
  who: string;
  appearance: string;
  variant: string;
  position: string;
}

let server: CasterState;
let screen: Size = { width: 1280, height: 720 };
/** 編集中のキャスト。 */
let cast: Cast = {};
/** 開いた時点／最後に保存した時点のキャスト（JSON と、リセット・同期の基準の枠）。 */
let saved = "";
let savedCast: Cast = {};
/** 足した差分の初めの枠（保存するまで、リセット・同期の基準にする）。 */
const addedBase = new Map<string, FullFrame>();
const history = new History<string>(100);
const sel: Selection = { who: "", appearance: "", variant: "", position: "center" };
/** 縦横比を固定したときの比（幅 / 高さ）。 */
let lockedRatio = 1;
let scale = 1;
/** 画像の実寸（URL ごと）。枠のない差分の表示に使う。 */
const naturals = new Map<string, Size>();

const params = new URLSearchParams(location.search);

// 制作画面の「キャラクター」のタブの「位置」に入っているとき（?embed=1）。題と遊ぶ画面への入口は制作画面が持つ
const embedded = params.get("embed") === "1";
document.documentElement.classList.toggle("embedded", embedded);

/** 配色: 制作画面の中ではその配色（html の dark-theme）に、単独では OS の設定に合わせる。 */
function followTheme(): void {
  const root = document.documentElement;
  const apply = (dark: boolean) => {
    root.classList.toggle("dark-theme", dark);
    root.classList.toggle("light-theme", !dark);
  };
  const parentRoot = embedded && window.parent !== window ? window.parent.document.documentElement : null;
  if (parentRoot) {
    const sync = () => apply(parentRoot.classList.contains("dark-theme"));
    sync();
    new MutationObserver(sync).observe(parentRoot, { attributes: true, attributeFilter: ["class"] });
    return;
  }
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  apply(media.matches);
  media.addEventListener("change", () => apply(media.matches));
}
followTheme();

/** 左右の欄の幅を、境目をドラッグして変える（覚えておく）。 */
function splitters(): void {
  const root = document.querySelector<HTMLElement>(".caster")!;
  const sides = [
    { side: "left", min: 220, max: 520 },
    { side: "right", min: 200, max: 480 },
  ] as const;
  for (const { side, min, max } of sides) {
    const key = `liminalia.caster.width.${side}`;
    const set = (px: number) => document.documentElement.style.setProperty(`--${side}`, `${Math.round(Math.min(max, Math.max(min, px)))}px`);
    try {
      const v = Number(localStorage.getItem(key));
      if (v) set(v);
    } catch {
      // 覚えられない環境では既定の幅
    }
    const bar = document.createElement("div");
    bar.className = `splitter ${side}`;
    bar.title = tr("ドラッグで幅を変更（ダブルクリックで元の幅に戻す）", "Drag to resize (double-click to reset)");
    bar.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      bar.setPointerCapture(e.pointerId);
      bar.classList.add("dragging");
      const rect = root.getBoundingClientRect();
      const move = (ev: PointerEvent) => {
        set(side === "left" ? ev.clientX - rect.left : rect.right - ev.clientX);
        fit();
      };
      const up = () => {
        bar.classList.remove("dragging");
        bar.removeEventListener("pointermove", move);
        try {
          localStorage.setItem(key, String(parseFloat(getComputedStyle(document.documentElement).getPropertyValue(`--${side}`))));
        } catch {
          // 覚えられない環境では、この画面の間だけ
        }
      };
      bar.addEventListener("pointermove", move);
      bar.addEventListener("pointerup", up, { once: true });
    });
    bar.addEventListener("dblclick", () => {
      document.documentElement.style.removeProperty(`--${side}`);
      try {
        localStorage.removeItem(key);
      } catch {
        // 覚えられない環境
      }
      fit();
    });
    root.append(bar);
  }
}
const storageKey = (name: string) => `liminalia.caster.${server.project.title}.${name}`;
function remember(name: string, value: string): void {
  try {
    localStorage.setItem(storageKey(name), value);
  } catch {
    // 保存できない環境では覚えない
  }
}
function recall(name: string): string | null {
  try {
    return localStorage.getItem(storageKey(name));
  } catch {
    return null;
  }
}

// ---- キャストを引く ----

const entryOf = (who = sel.who): CastEntry | undefined => cast[who];
const appearanceOf = (who = sel.who, key = sel.appearance): CastAppearance | undefined => cast[who]?.appearances[key];
const variantOf = (who = sel.who, appearance = sel.appearance, key = sel.variant): CastVariant | undefined => cast[who]?.appearances[appearance]?.variants[key];
const idOf = (who: string, appearance: string, variant: string) => JSON.stringify([who, appearance, variant]);

/** 差分の画像の URL（cacheKey 付き）。 */
function imageUrl(variant: CastVariant): string {
  const url = `/assets/fgimage/${variant.image.split("/").map(encodeURIComponent).join("/")}`;
  return variant.cacheKey ? `${url}?cache=${encodeURIComponent(variant.cacheKey)}` : url;
}

/** リセット・同期の基準の枠（開いた時点／最後に保存した時点。足した差分は初めの枠）。 */
function baseFrame(who: string, appearance: string, variant: string): CastFrame | undefined {
  return addedBase.get(idOf(who, appearance, variant)) ?? savedCast[who]?.appearances[appearance]?.variants[variant]?.frame;
}

/** 表示する枠。枠のない差分は画像の実寸で画面下の中央（実寸が分かるまでは null）。 */
function displayFrame(variant: CastVariant): FullFrame | null {
  if (variant.frame) return cloneFrame(variant.frame);
  const natural = naturals.get(imageUrl(variant));
  return natural ? frameFromNatural(natural, screen) : null;
}

/** 今の差分の、書き換えられる枠（枠のない差分には今の見え方の枠を作り、今の位置が無ければ足す）。 */
function editableFrame(): FullFrame | null {
  const variant = variantOf();
  if (!variant) return null;
  if (!variant.frame) {
    const natural = naturals.get(imageUrl(variant));
    if (!natural) return null;
    variant.frame = frameFromNatural(natural, screen);
  }
  const frame = ensureFrame(variant);
  frame.positions[sel.position] ??= { ...positionOf(frame, sel.position) };
  return frame;
}

function currentBox(): Box | null {
  const variant = variantOf();
  const frame = variant && displayFrame(variant);
  if (!frame) return null;
  const at = positionOf(frame, sel.position);
  return { left: at.left, top: at.top, width: frame.width, height: frame.height };
}

/** 枠を box に合わせる（今の位置の left / top と、差分の幅・高さ）。 */
function applyBox(box: Box): void {
  const frame = editableFrame();
  if (!frame) return;
  frame.width = box.width;
  frame.height = box.height;
  frame.positions[sel.position] = { left: box.left, top: box.top };
}

// ---- 変更と履歴 ----

const snapshot = () => JSON.stringify({ cast, sel });

/** 変える前に履歴へ積んで fn を行い、描き直す。group が同じ連続の変更は一手にまとめる。 */
function change(fn: () => void, group: string | null = null): void {
  history.push(snapshot(), group);
  fn();
  render();
}

let sealTimer = 0;
/** 少し間が空いたら、まとめていた変更を区切る（ホイール・矢印キー）。 */
function sealSoon(): void {
  clearTimeout(sealTimer);
  sealTimer = window.setTimeout(() => history.seal(), 600);
}

function restore(state: string | null): void {
  if (state === null) return;
  const s = JSON.parse(state) as { cast: Cast; sel: Selection };
  cast = s.cast;
  Object.assign(sel, s.sel);
  refreshLockedRatio();
  render();
}

function undo(): void {
  restore(history.undo(snapshot()));
}

function redo(): void {
  restore(history.redo(snapshot()));
}

const dirty = () => JSON.stringify(cast) !== saved;

function setStatus(message: string, error = false): void {
  ui.status.textContent = message;
  ui.status.classList.toggle("error", error);
}

function refreshLockedRatio(): void {
  const box = currentBox();
  lockedRatio = box && box.width > 0 && box.height > 0 ? box.width / box.height : 1;
}

// ---- 選ぶ ----

/** 選んでいるものが無くなっていたら、あるものに直す。 */
function normalizeSelection(): void {
  const names = Object.keys(cast);
  if (!cast[sel.who]) sel.who = names[0] ?? "";
  const entry = entryOf();
  if (!entry) {
    sel.appearance = sel.variant = "";
    return;
  }
  if (!entry.appearances[sel.appearance]) sel.appearance = appearanceKey(entry, sel.appearance);
  const variants = appearanceOf()?.variants ?? {};
  if (!variants[sel.variant]) sel.variant = referenceVariantKey(appearanceOf()) ?? "";
  const variant = variantOf();
  if (variant && !positionsOf(variant).includes(sel.position)) sel.position = "center";
}

/** 選べる位置。枠のない差分はどの名前でも同じところに出るので left / center / right。 */
function positionsOf(variant: CastVariant): string[] {
  return variant.frame ? positionNames(variant) : [...FRAME_POSITIONS];
}

function select(next: Partial<Selection>): void {
  Object.assign(sel, next);
  normalizeSelection();
  refreshLockedRatio();
  history.seal();
  render();
  void loadNatural();
}

/** 枠のない差分・比較の差分の画像の実寸を読んでおく（読めたら描き直す）。 */
async function loadNatural(): Promise<void> {
  const wanted = [variantOf(), ...compareVariants().map(([, v]) => v)].filter((v): v is CastVariant => !!v && !v.frame);
  let loaded = false;
  for (const v of wanted) {
    const url = imageUrl(v);
    if (naturals.has(url)) continue;
    const img = await loadImage(url).catch(() => null);
    if (!img) setStatus(tr(`画像を読み込めません: ${v.image}`, `Can't load the image: ${v.image}`), true);
    naturals.set(url, { width: img?.naturalWidth || 1, height: img?.naturalHeight || 1 });
    loaded = true;
  }
  if (loaded) {
    refreshLockedRatio();
    render();
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(tr(`画像を読み込めません: ${url}`, `Can't load the image: ${url}`)));
    img.src = url;
  });
}

/** 画像の大きさと、透明でない部分の外接矩形。 */
async function imageInfo(url: string): Promise<ImageInfo | null> {
  const img = await loadImage(url).catch(() => null);
  if (!img || !img.naturalWidth || !img.naturalHeight) return null;
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(img, 0, 0);
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  return { width: canvas.width, height: canvas.height, bbox: opaqueBounds(data, canvas.width, canvas.height) };
}

// ---- 描く ----

function options(select: HTMLSelectElement, items: [value: string, label: string][], value: string): void {
  select.replaceChildren(
    ...items.map(([v, label]) => {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = label;
      return o;
    }),
  );
  select.value = items.some(([v]) => v === value) ? value : (items[0]?.[0] ?? "");
}

const appearanceLabel = (key: string, a: CastAppearance) => (a.label && a.label !== key ? `${key}  ${a.label}` : key);
const variantLabel = (key: string, v: CastVariant) => `${key}  ${v.image}${v.frame ? "" : tr("（未調整）", " (not adjusted)")}`;

function render(): void {
  normalizeSelection();
  const entry = entryOf();
  const variants = appearanceOf()?.variants ?? {};
  options(ui.who, Object.keys(cast).map((k) => [k, k]), sel.who);
  options(ui.appearance, Object.entries(entry?.appearances ?? {}).map(([k, a]) => [k, appearanceLabel(k, a)]), sel.appearance);
  options(ui.variant, Object.entries(variants).map(([k, v]) => [k, variantLabel(k, v)]), sel.variant);
  const variant = variantOf();
  options(ui.position, (variant ? positionsOf(variant) : [...FRAME_POSITIONS]).map((k) => [k, k]), sel.position);
  ui.appearance.disabled = !entry;
  ui.variant.disabled = !variant;
  ui.position.disabled = !variant;
  for (const b of ["add-appearance", "remove-appearance", "add-variant"]) $<HTMLButtonElement>(b).disabled = !entry;
  $<HTMLButtonElement>("remove-appearance").disabled = !entry || Object.keys(entry.appearances).length <= 1;
  for (const b of ["add-position", "sync-all", "reset"]) $<HTMLButtonElement>(b).disabled = !variant;
  ui.frameless.hidden = !variant || !!variant.frame;
  const isCenter = sel.position === "center";
  ui.syncCenter.disabled = !isCenter;
  ui.syncCenterRow.classList.toggle("disabled", !isCenter);

  renderCompareOptions();
  renderStage();
}

/** 舞台（今の差分・全位置・比較）と数値。ドラッグ中はこれだけを描き直す。 */
function renderStage(): void {
  const variant = variantOf();
  const box = currentBox();
  ui.target.hidden = !variant || !box;
  ui.empty.hidden = !!variant;
  ui.empty.textContent = !sel.who ? tr("キャラクターがいません（＋で追加）", "No characters (add one with +)") : tr("差分がありません（差分の＋で画像を追加）", "No variants (add an image with the variant +)");
  if (variant && box) {
    const url = imageUrl(variant);
    if (targetImg.getAttribute("src") !== url) targetImg.src = url;
    Object.assign(ui.target.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
    ui.target.style.opacity = ui.targetOpacity.value;
    targetLabel.textContent = `${sel.who} / ${sel.appearance} / ${sel.variant} / ${sel.position}  (${box.left}, ${box.top})  ${box.width}×${box.height}`;
  }
  for (const [input, value] of [
    [ui.left, box?.left],
    [ui.top, box?.top],
    [ui.width, box?.width],
    [ui.height, box?.height],
  ] as const) {
    input.disabled = !box;
    if (document.activeElement !== input) input.value = value === undefined ? "" : String(value);
  }
  renderPositions();
  renderGhosts();
  const isDirty = dirty();
  ui.dirty.hidden = !isDirty;
  ui.undo.disabled = !history.canUndo;
  ui.redo.disabled = !history.canRedo;
  document.title = `${isDirty ? "● " : ""}${tr("立ち絵の位置調整", "Sprite positions")} — ${server.project.title}`;
}

/** 全位置を表示: 同じ差分のほかの位置の枠を薄く重ねる。 */
function renderPositions(): void {
  ui.positions.replaceChildren();
  const variant = variantOf();
  const frame = variant && displayFrame(variant);
  if (!ui.showAll.checked || !variant || !frame) return;
  for (const name of positionsOf(variant)) {
    if (name === sel.position) continue;
    const at = positionOf(frame, name);
    ui.positions.append(overlay("position-preview", imageUrl(variant), { left: at.left, top: at.top, width: frame.width, height: frame.height }, name, 0.34));
  }
}

function overlay(cls: string, url: string, box: Box, label: string, opacity: number, filter = "none"): HTMLElement {
  const el = document.createElement("div");
  el.className = cls;
  Object.assign(el.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`, opacity: String(opacity) });
  const img = document.createElement("img");
  img.src = url;
  img.style.filter = filter;
  const tag = document.createElement("span");
  tag.className = "label";
  tag.textContent = label;
  el.append(img, tag);
  return el;
}

// ---- 比較 ----

function renderCompareOptions(): void {
  const who = cast[ui.cmpWho.value] ? ui.cmpWho.value : sel.who;
  options(
    ui.cmpWho,
    Object.keys(cast)
      .filter((k) => Object.values(cast[k]!.appearances).some((a) => Object.keys(a.variants ?? {}).length > 0))
      .map((k) => [k, k]),
    who,
  );
  const entry = cast[ui.cmpWho.value];
  const appearance = entry?.appearances[ui.cmpAppearance.value] ? ui.cmpAppearance.value : entry ? appearanceKey(entry, ui.cmpWho.value === sel.who ? sel.appearance : "") : "";
  options(ui.cmpAppearance, Object.entries(entry?.appearances ?? {}).map(([k, a]) => [k, appearanceLabel(k, a)]), appearance);
  const variants = entry?.appearances[ui.cmpAppearance.value]?.variants ?? {};
  options(ui.cmpVariant, [[NONE, tr("なし", "None")], [ALL, tr("すべての差分", "All variants")], ...Object.entries(variants).map(([k, v]): [string, string] => [k, variantLabel(k, v)])], ui.cmpVariant.value || NONE);
  const names = new Set<string>(FRAME_POSITIONS);
  for (const v of Object.values(variants)) for (const n of v.frame ? positionNames(v) : []) names.add(n);
  options(ui.cmpPosition, [[SAME_POSITION, tr("編集中の立ち位置と同じ", "Same position")], ...[...names].map((n): [string, string] => [n, n])], ui.cmpPosition.value || SAME_POSITION);
}

/** 比較表示中の差分（[名前, 差分]）。 */
function compareVariants(): [string, CastVariant][] {
  const key = ui.cmpVariant.value;
  const variants = cast[ui.cmpWho.value]?.appearances[ui.cmpAppearance.value]?.variants ?? {};
  if (!key || key === NONE) return [];
  if (key === ALL) return Object.entries(variants);
  return variants[key] ? [[key, variants[key]]] : [];
}

/** 比較: 比較対象を半透明で重ねる。 */
function renderGhosts(): void {
  ui.ghosts.replaceChildren();
  const opacity = Number(ui.cmpOpacity.value);
  const filter = FILTERS[ui.cmpFilter.value] ?? "none";
  const position = ui.cmpPosition.value === SAME_POSITION ? sel.position : ui.cmpPosition.value;
  for (const [key, v] of compareVariants()) {
    const frame = displayFrame(v);
    if (!frame) continue;
    const at = positionOf(frame, position);
    ui.ghosts.append(overlay("ghost", imageUrl(v), { left: at.left, top: at.top, width: frame.width, height: frame.height }, `${ui.cmpWho.value} / ${key} / ${position}`, opacity, filter));
  }
}

// ---- 舞台の大きさ ----

function fit(): void {
  const rect = ui.viewport.getBoundingClientRect();
  // 舞台の周りの余白（画面の外の取っ手をつかむため）。指で使う狭い画面では caster.css が小さくする
  const margin = Number.parseFloat(getComputedStyle(ui.viewport).getPropertyValue("--stage-margin")) || 120;
  scale = Math.min(1, (rect.width - margin) / screen.width, (rect.height - margin) / screen.height);
  if (!(scale > 0)) scale = 0.1;
  ui.stage.style.setProperty("--s", String(scale));
  Object.assign(ui.stage.style, { width: `${screen.width}px`, height: `${screen.height}px` });
  Object.assign(ui.stageFrame.style, { width: `${screen.width * scale}px`, height: `${screen.height * scale}px` });
  ui.scale.textContent = tr(`${screen.width}×${screen.height}　縮小率 ${Math.round(scale * 1000) / 10}%`, `${screen.width}×${screen.height}  shown at ${Math.round(scale * 1000) / 10}%`);
}

// ---- 操作: ドラッグ・取っ手・ホイール・矢印キー・数値 ----

for (const handle of HANDLES) {
  const el = document.createElement("span");
  el.className = "handle";
  el.dataset.handle = handle;
  ui.target.append(el);
}

/** 指: 触れている指の位置。 */
const fingers = new Map<number, { x: number; y: number }>();
/** 二本の指で大きさを変えている間の、始めの枠と指の間隔。 */
let pinch: { box: Box; span: number; moved: boolean } | null = null;
/** 今の一本指のドラッグをやめる（二本目の指が触れたとき）。 */
let stopDrag: (() => void) | null = null;

ui.target.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || pinch) return;
  const start = currentBox();
  if (!start) return;
  e.preventDefault();
  ui.target.focus({ preventScroll: true });
  const handle = (e.target as HTMLElement).dataset.handle as Handle | undefined;
  const ratio = ui.keepRatio.checked ? start.width / start.height : null;
  const from = { x: e.clientX, y: e.clientY };
  let moved = false;
  ui.target.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => {
    const dx = (ev.clientX - from.x) / scale;
    const dy = (ev.clientY - from.y) / scale;
    if (!moved) {
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      history.push(snapshot());
      moved = true;
    }
    applyBox(handle ? resizeBox(start, handle, dx, dy, ratio) : { ...start, left: Math.round(start.left + dx), top: Math.round(start.top + dy) });
    renderStage();
  };
  const end = () => {
    stopDrag = null;
    ui.target.removeEventListener("pointermove", move);
    ui.target.removeEventListener("pointerup", end);
    ui.target.removeEventListener("pointercancel", end);
    if (moved) {
      refreshLockedRatio();
      render();
    }
  };
  stopDrag = end;
  ui.target.addEventListener("pointermove", move);
  ui.target.addEventListener("pointerup", end);
  ui.target.addEventListener("pointercancel", end);
});

ui.target.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    // Shift を押すと縦のホイールを横（deltaX）として送るブラウザがある
    const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
    const box = currentBox();
    if (!box || delta === 0) return;
    change(() => applyBox(wheelResize(box, delta, ui.keepRatio.checked, e.shiftKey)), "wheel");
    sealSoon();
  },
  { passive: false },
);

/**
 * 二本の指で広げる・狭めると、中心を保って大きさを変える。指は立ち絵の外に触れていてもよいので、舞台の全体で受ける
 * （立ち絵の上のドラッグより先に受けるよう capture で）。マウスには関係しない。指を一本残しても動かさない。
 */
function fingerSpan(): number {
  const [a, b] = [...fingers.values()];
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
}
function endFinger(e: PointerEvent): void {
  if (!fingers.delete(e.pointerId) || !pinch || fingers.size >= 2) return;
  const { moved } = pinch;
  pinch = null;
  if (moved) {
    refreshLockedRatio();
    render();
  }
}
ui.viewport.addEventListener(
  "pointerdown",
  (e) => {
    if (e.pointerType !== "touch") return;
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (fingers.size !== 2) return;
    stopDrag?.();
    const box = currentBox();
    const span = fingerSpan();
    pinch = box && span > 0 ? { box, span, moved: false } : null;
  },
  true,
);
ui.viewport.addEventListener(
  "pointermove",
  (e) => {
    if (!fingers.has(e.pointerId)) return;
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!pinch) return;
    const factor = fingerSpan() / pinch.span;
    if (!pinch.moved) {
      if (Math.abs(factor - 1) < 0.01) return;
      history.push(snapshot());
      pinch.moved = true;
    }
    applyBox(pinchResize(pinch.box, factor));
    renderStage();
  },
  true,
);
ui.viewport.addEventListener("pointerup", endFinger, true);
ui.viewport.addEventListener("pointercancel", endFinger, true);
// iOS の Safari は touch-action のほかに、画面全体の拡大の合図も止める
ui.viewport.addEventListener("gesturestart", (e) => e.preventDefault());

const editing = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement;

window.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "s") {
    e.preventDefault();
    void save();
    return;
  }
  if (ui.dialog.open || editing(e.target)) return;
  if (mod && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  if (mod && e.key.toLowerCase() === "y") {
    e.preventDefault();
    redo();
    return;
  }
  const step = e.shiftKey ? 10 : 1;
  const d = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, [number, number]>)[e.key];
  const box = currentBox();
  if (!d || !box) return;
  e.preventDefault();
  change(() => applyBox({ ...box, left: box.left + d[0], top: box.top + d[1] }), "nudge");
  sealSoon();
});

for (const field of ["left", "top", "width", "height"] as const) {
  const input = ui[field];
  input.addEventListener("focus", refreshLockedRatio);
  input.addEventListener("input", () => {
    const box = currentBox();
    const n = Number.parseFloat(input.value);
    if (!box || !Number.isFinite(n)) return;
    let next = { ...box, [field]: field === "width" || field === "height" ? Math.max(1, Math.round(n)) : Math.round(n) };
    if (ui.keepRatio.checked && field === "width") next.height = Math.max(1, Math.round(next.width / lockedRatio));
    if (ui.keepRatio.checked && field === "height") next.width = Math.max(1, Math.round(next.height * lockedRatio));
    // 大きさは中心を保って変える（左上を止めたまま広げると、差分ごとに中心がずれる）
    if (field === "width" || field === "height") next = resizeAround(box, next.width, next.height);
    history.push(snapshot(), `input:${field}`);
    applyBox(next);
    renderStage();
    if (field === "width") ui.height.value = String(next.height);
    if (field === "height") ui.width.value = String(next.width);
    if (field === "width" || field === "height") {
      ui.left.value = String(next.left);
      ui.top.value = String(next.top);
    }
  });
  input.addEventListener("change", () => {
    history.seal();
    render();
  });
}

// ---- 選ぶ・表示 ----

ui.who.addEventListener("change", () => select({ who: ui.who.value, appearance: "", variant: "" }));
ui.appearance.addEventListener("change", () => select({ appearance: ui.appearance.value }));
ui.variant.addEventListener("change", () => select({ variant: ui.variant.value }));
ui.position.addEventListener("change", () => select({ position: ui.position.value }));
ui.keepRatio.addEventListener("change", refreshLockedRatio);
ui.showAll.addEventListener("change", renderPositions);

function linkRange(range: HTMLInputElement, number: HTMLInputElement, onChange: () => void): void {
  const set = (v: string) => {
    const n = Math.max(0, Math.min(1, Number.parseFloat(v)));
    if (!Number.isFinite(n)) return;
    range.value = String(n);
    number.value = String(Math.round(n * 100) / 100);
    onChange();
  };
  range.addEventListener("input", () => set(range.value));
  number.addEventListener("input", () => set(number.value));
}
linkRange(ui.targetOpacity, ui.targetOpacityNumber, () => (ui.target.style.opacity = ui.targetOpacity.value));
linkRange(ui.cmpOpacity, ui.cmpOpacityNumber, renderGhosts);
for (const s of [ui.cmpWho, ui.cmpAppearance, ui.cmpVariant, ui.cmpPosition, ui.cmpFilter]) {
  s.addEventListener("change", () => {
    if (s === ui.cmpWho) ui.cmpAppearance.value = "";
    if (s === ui.cmpWho || s === ui.cmpAppearance) ui.cmpVariant.value = NONE;
    renderCompareOptions();
    renderGhosts();
    void loadNatural();
  });
}

ui.background.addEventListener("change", () => {
  showBackground(ui.background.value);
  remember("background", ui.background.value);
});

function showGameUi(on: boolean): void {
  ui.stage.classList.toggle("game-preview", on);
  ui.clipGameRow.hidden = !on;
  ui.stageFrame.classList.toggle("clip-game", on && ui.clipGame.checked);
  ui.gameOverlay.hidden = !on;
  if (on && !ui.gameOverlay.hasAttribute("src")) {
    const query = new URLSearchParams({ "ui-preview": "page", layout: "1", "cast-overlay": "1", "sample-lang": english ? "en" : "ja" });
    ui.gameOverlay.src = `/?${query}`;
  }
}
ui.showGameUi.addEventListener("change", () => {
  showGameUi(ui.showGameUi.checked);
  remember("game-ui", ui.showGameUi.checked ? "1" : "0");
});
ui.clipGame.addEventListener("change", () => {
  ui.stageFrame.classList.toggle("clip-game", ui.showGameUi.checked && ui.clipGame.checked);
  remember("clip-game", ui.clipGame.checked ? "1" : "0");
});

function showBackground(file: string): void {
  ui.bg.hidden = file === "";
  if (file) ui.bg.src = `/assets/bgimage/${file.split("/").map(encodeURIComponent).join("/")}`;
  else ui.bg.removeAttribute("src");
}

// ---- 編集: キャラ・立ち絵セット・位置 ----

function attempt(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    setStatus((e as Error).message, true);
  }
}

$("add-who").addEventListener("click", () => {
  const suggestion = server.file.speakers.find((s) => !cast[s]) ?? "";
  const name = prompt(tr("追加するキャラクターの名前（話者にいなくてもかまいません）", "Name of the character to add (it doesn't need to be a speaker)"), suggestion)?.trim();
  if (!name) return;
  attempt(() => {
    const next = structuredClone(cast);
    addCharacter(next, name);
    change(() => {
      cast = next;
      Object.assign(sel, { who: name, appearance: "", variant: "" });
    });
    setStatus(tr(`キャラクター ${name} を追加しました。差分の＋で画像を追加してください`, `Added the character ${name}. Add an image with the variant +`));
  });
});

$("add-appearance").addEventListener("click", () => {
  const entry = entryOf();
  if (!entry) return;
  const raw = prompt(tr("追加する立ち絵セットの名前（英数字か日本語。服装、時代、状態など）", "Name of the sprite set to add (letters and digits, or Japanese; an outfit, era, state and so on)"), "");
  if (!raw) return;
  const label = prompt(tr("表示名（省略可）", "Display name (optional)"), "") ?? "";
  attempt(() => {
    const next = structuredClone(entry);
    const key = addAppearance(next, raw, label.trim());
    change(() => {
      cast[sel.who] = next;
      Object.assign(sel, { appearance: key, variant: "" });
    });
    setStatus(tr(`立ち絵セット ${key} を追加しました。差分の＋で画像を追加してください`, `Added the sprite set ${key}. Add an image with the variant +`));
  });
});

$("remove-appearance").addEventListener("click", () => {
  const entry = entryOf();
  const appearance = appearanceOf();
  if (!entry || !appearance) return;
  const count = Object.keys(appearance.variants ?? {}).length;
  if (!confirm(tr(`立ち絵セット「${appearanceLabel(sel.appearance, appearance)}」を削除します（差分 ${count} 件。画像ファイルは削除されません）。よろしいですか？`, `Delete the sprite set "${appearanceLabel(sel.appearance, appearance)}"? (${count} ${count === 1 ? "variant" : "variants"}. The image files aren't deleted.)`))) return;
  attempt(() => {
    const next = structuredClone(entry);
    removeAppearance(next, sel.appearance);
    const removed = sel.appearance;
    change(() => {
      cast[sel.who] = next;
      sel.appearance = "";
    });
    setStatus(tr(`立ち絵セット ${removed} を削除しました`, `Deleted the sprite set ${removed}`));
  });
});

$("add-position").addEventListener("click", () => {
  const raw = prompt(tr("追加する立ち位置の名前（center と同じ位置から始まります）", "Name of the position to add (it starts where center is)"), "");
  if (!raw) return;
  attempt(() => {
    const before = snapshot();
    const frame = editableFrame();
    if (!frame) throw new Error(tr("立ち位置を追加できません（画像を読み込めていません）", "Can't add a position (the image isn't loaded)"));
    const name = addPosition(cloneFrame(frame), raw);
    history.push(before);
    frame.positions[name] = { ...positionOf(frame, "center") };
    sel.position = name;
    render();
    setStatus(tr(`立ち位置 ${name} を追加しました`, `Added the position ${name}`));
  });
});

// ---- 同期・リセット ----

$("sync-all").addEventListener("click", () => {
  const appearance = appearanceOf();
  const variant = variantOf();
  if (!appearance || !variant) return;
  if (!editableFrame()) return;
  const exclude = new Set<string>();
  if (ui.cmpWho.value === sel.who && ui.cmpAppearance.value === sel.appearance && ![NONE, ALL].includes(ui.cmpVariant.value)) exclude.add(ui.cmpVariant.value);
  const excluded = [...exclude].filter((k) => k !== sel.variant && appearance.variants[k]);
  const targets = Object.keys(appearance.variants).filter((k) => appearance.variants[k]!.frame && !excluded.includes(k));
  const message = [
    tr("今のサイズの倍率と縦位置を、同じ立ち絵セットのすべての差分に合わせます。", "Match the scale and vertical position of every variant in this sprite set to the current one."),
    tr(`基準: ${sel.appearance} / ${sel.variant} / ${sel.position}`, `Based on: ${sel.appearance} / ${sel.variant} / ${sel.position}`),
    tr(`対象: ${targets.length} 個の差分`, `Applies to: ${targets.length} ${targets.length === 1 ? "variant" : "variants"}`),
    ...(excluded.length ? [tr(`比較表示中の差分は除外: ${excluded.join("、")}`, `Variants shown for comparison are left out: ${excluded.join(", ")}`)] : []),
    tr("横位置は、どの立ち位置も中心を保ちます。合わせますか？", "Every position keeps its horizontal center. Match them?"),
  ].join("\n");
  if (!confirm(message)) return;
  const before = snapshot();
  const result = syncToAllVariants(appearance.variants, { variant: sel.variant, position: sel.position, base: (k) => baseFrame(sel.who, sel.appearance, k), exclude });
  if (!result) {
    setStatus(tr("合わせられる差分がありません", "There are no variants to match"), true);
    return;
  }
  history.push(before);
  render();
  setStatus(
    tr(
      `サイズと縦位置をすべての差分に合わせました（倍率 ${result.scaleX.toFixed(3)} と ${result.scaleY.toFixed(3)}、上 ${result.top}、${result.targets.length} 個${result.excluded.length ? `、比較中の ${result.excluded.length} 個は除く` : ""}）`,
      `Matched the size and vertical position of all variants (scale ${result.scaleX.toFixed(3)} and ${result.scaleY.toFixed(3)}, top ${result.top}, ${result.targets.length} ${result.targets.length === 1 ? "variant" : "variants"}${result.excluded.length ? `, leaving out ${result.excluded.length} shown for comparison` : ""})`,
    ),
  );
});

$("reset").addEventListener("click", () => {
  const variant = variantOf();
  if (!variant) return;
  const id = idOf(sel.who, sel.appearance, sel.variant);
  const known = addedBase.has(id) || !!savedCast[sel.who]?.appearances[sel.appearance]?.variants[sel.variant];
  if (!known) {
    setStatus(tr(`リセットの基準がありません: ${sel.variant}`, `Nothing to reset to: ${sel.variant}`), true);
    return;
  }
  const base = baseFrame(sel.who, sel.appearance, sel.variant);
  change(() => {
    if (base) variant.frame = structuredClone(base);
    else delete variant.frame;
  });
  refreshLockedRatio();
  render();
  setStatus(tr(`今の差分を、開いた時点か最後に保存した時点に戻しました: ${sel.variant}`, `Reset the variant to when it was opened or last saved: ${sel.variant}`));
});

ui.undo.addEventListener("click", undo);
ui.redo.addEventListener("click", redo);

// ---- 差分を足す ----

let pending: File | null = null;
let pendingUrl = "";
let keyTouched = false;

$("add-variant").addEventListener("click", () => {
  if (!entryOf()) return;
  setPending(null);
  const variant = variantOf() ?? Object.values(appearanceOf()?.variants ?? {})[0];
  ui.addFolder.value = variant ? folderOf(variant.image) : normalizeKey(sel.who);
  ui.addStatus.textContent = tr(`${sel.who} / ${sel.appearance} に追加します`, `Adds to ${sel.who} / ${sel.appearance}`);
  ui.dialog.showModal();
});

function setPending(file: File | null): void {
  if (pendingUrl) URL.revokeObjectURL(pendingUrl);
  pending = file;
  pendingUrl = file ? URL.createObjectURL(file) : "";
  ui.preview.hidden = !file;
  if (file) ui.preview.src = pendingUrl;
  else ui.preview.removeAttribute("src");
  ui.addOk.disabled = !file;
  keyTouched = false;
  ui.addName.value = file ? sanitizeFileBase(file.name) : "";
  ui.addKey.value = file ? suggestKey() : "";
}

const suggestKey = () => uniqueKey(appearanceOf()?.variants ?? {}, normalizeKey(ui.addName.value) || "variant");

function takeFile(file: File | undefined): void {
  if (!file) return;
  if (!imageExtension(file.name)) {
    ui.addStatus.textContent = tr("png、jpg、jpeg、gif、webp の画像を選んでください", "Choose a png, jpg, jpeg, gif or webp image");
    return;
  }
  setPending(file);
}

ui.file.addEventListener("change", () => {
  takeFile(ui.file.files?.[0]);
  ui.file.value = "";
});
ui.drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  ui.drop.classList.add("active");
});
ui.drop.addEventListener("dragleave", () => ui.drop.classList.remove("active"));
ui.drop.addEventListener("drop", (e) => {
  e.preventDefault();
  ui.drop.classList.remove("active");
  takeFile(e.dataTransfer?.files[0]);
});
ui.addName.addEventListener("input", () => {
  if (!keyTouched) ui.addKey.value = suggestKey();
});
ui.addKey.addEventListener("input", () => (keyTouched = true));
ui.addCancel.addEventListener("click", () => ui.dialog.close());
ui.dialog.addEventListener("close", () => setPending(null));
ui.addOk.addEventListener("click", () => void addVariant());

async function addVariant(): Promise<void> {
  const file = pending;
  const appearance = appearanceOf();
  if (!file || !appearance) return;
  const key = normalizeKey(ui.addKey.value);
  if (!key) {
    ui.addStatus.textContent = tr("差分名を入力してください", "Enter a variant name");
    return;
  }
  const overwrite = !!appearance.variants[key];
  if (overwrite && !confirm(tr(`差分「${key}」はすでにあります。上書きしますか？`, `The variant "${key}" already exists. Overwrite it?`))) return;
  const folder = ui.addFolder.value.trim().replace(/^\/+|\/+$/g, "");
  const name = imageFileName(ui.addName.value || file.name, file.name);
  const path = folder ? `${folder}/${name}` : name;

  ui.addOk.disabled = true;
  ui.addStatus.textContent = tr(`画像を保存しています: assets/fgimage/${path}`, `Saving the image: assets/fgimage/${path}`);
  try {
    let r = await upload(path, file, false);
    if (r.status === 409) {
      if (!confirm(tr(`「assets/fgimage/${path}」はすでにあります。上書きしますか？`, `assets/fgimage/${path} already exists. Overwrite it?`))) {
        ui.addStatus.textContent = tr("ファイル名を変更してください", "Change the file name");
        return;
      }
      r = await upload(path, file, true);
    }
    if (!r.ok) throw new Error(serverText(((await r.json()) as { error?: string }).error ?? tr(`画像を保存できません（${r.status}）`, `Couldn't save the image (${r.status})`)));

    // 初めの枠: 上書きならその差分、足すなら基準の差分（normal / default / 最初）と、透明でない部分の外接矩形を比べる
    const cacheKey = Date.now().toString(36);
    const added: CastVariant = { image: path, cacheKey };
    const next = await imageInfo(imageUrl(added));
    const referenceKey = overwrite ? key : referenceVariantKey(appearance);
    const reference = referenceKey ? appearance.variants[referenceKey] : undefined;
    let frame: FullFrame;
    if (reference) {
      const info = await imageInfo(imageUrl(reference));
      const referenceFrame = reference.frame ?? (info ? frameFromNatural(info, screen) : undefined);
      frame = referenceFrame ? initialFrameFromReference({ frame: referenceFrame, info }, next) : initialFrameAlone(next ?? screen, screen);
    } else {
      frame = initialFrameAlone(next ?? screen, screen);
    }
    change(() => {
      const variants = appearanceOf()!.variants;
      // 同じ名前の上書きだけ、開いている画面が古い画像を出さないよう鍵を変える（書き出しは中身の鍵を自分で付ける）
      variants[key] = { ...(variants[key] ?? {}), image: path, ...(overwrite ? { cacheKey } : {}), frame };
      addedBase.set(idOf(sel.who, sel.appearance, key), cloneFrame(frame));
      sel.variant = key;
    });
    refreshLockedRatio();
    render();
    ui.dialog.close();
    setStatus(
      tr(
        `${overwrite ? "差分を上書きしました" : "差分を追加しました"}: ${key}（${path}${reference ? `、基準 ${referenceKey}` : ""}）。調整して保存してください`,
        `${overwrite ? "Overwrote the variant" : "Added the variant"}: ${key} (${path}${reference ? `, based on ${referenceKey}` : ""}). Adjust it and save`,
      ),
    );
  } catch (e) {
    ui.addStatus.textContent = (e as Error).message;
  } finally {
    ui.addOk.disabled = !pending;
  }
}

function upload(path: string, file: File, overwrite: boolean): Promise<Response> {
  return fetch(`/__liminalia/api/fgimage?path=${encodeURIComponent(path)}&overwrite=${overwrite ? 1 : 0}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Liminalia": "1" },
    body: file,
  });
}

// ---- 保存 ----

let saving = false;

async function save(force = false): Promise<void> {
  if (saving) return;
  // center の保存: サイズ/Y をほかの位置へ同期（tatie と同じく、今の差分だけ）
  let synced = false;
  if (!force && sel.position === "center" && ui.syncCenter.checked && variantOf()?.frame) {
    const before = snapshot();
    const frame = editableFrame()!;
    const was = JSON.stringify(frame);
    syncToOtherPositions(frame, baseFrame(sel.who, sel.appearance, sel.variant), "center");
    synced = JSON.stringify(frame) !== was;
    if (synced) history.push(before);
    render();
  }
  const problems = castProblems(cast);
  if (problems.length > 0) {
    setStatus(tr(`保存できません: ${problems.map((p) => p.message).join(" / ")}`, `Can't save: ${problems.map((p) => translateDiagnosticText(p.message) ?? p.message).join(" / ")}`), true);
    return;
  }
  saving = true;
  ui.save.disabled = true;
  try {
    const r = await fetch("/__liminalia/api/cast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cast, version: server.version, force }),
    });
    const body = (await r.json()) as SaveResult & { error?: string; conflict?: boolean; problems?: { message: string }[] };
    if (r.status === 409 && body.conflict) {
      saving = false;
      if (confirm(tr("cast.json が、開いた後にほかで変更されています（lim import など）。この画面の内容で上書きしますか？", "cast.json was changed elsewhere after it was opened (by lim import or the like). Overwrite it with what's on this screen?"))) return save(true);
      setStatus(tr("保存をキャンセルしました。画面を開き直すと、現在の cast.json を読み込みます", "Canceled saving. Reopen this screen to load the current cast.json"), true);
      return;
    }
    if (!r.ok) throw new Error([body.error, ...(body.problems ?? []).map((p) => p.message)].filter(Boolean).join(" / "));
    server.version = body.version;
    saved = JSON.stringify(cast);
    savedCast = structuredClone(cast);
    addedBase.clear();
    render();
    const lines = [
      tr(
        `${synced ? "center のサイズと縦位置をほかの立ち位置にも合わせて、" : ""}cast.json に保存しました${body.backup ? `（変更履歴: ${body.backup}）` : ""}`,
        `${synced ? "Matched the other positions to the size and vertical position of center, and saved" : "Saved"} cast.json${body.backup ? ` (history: ${body.backup})` : ""}`,
      ),
      ...body.wroteBack.map((f) => tr(`インポート元に書き戻しました: ${f}`, `Wrote back to the import source: ${f}`)),
      ...body.notes.map(serverText),
    ];
    setStatus(lines.join("\n"), body.notes.some((n) => n.includes("失敗")));
  } catch (e) {
    setStatus(tr(`保存できません: ${(e as Error).message}`, `Can't save: ${serverText((e as Error).message)}`), true);
  } finally {
    saving = false;
    ui.save.disabled = false;
  }
}

ui.save.addEventListener("click", () => void save());
window.addEventListener("beforeunload", (e) => {
  if (!dirty()) return;
  e.preventDefault();
  e.returnValue = "";
});

// ---- 始める ----

async function start(): Promise<void> {
  const r = await fetch("/__liminalia/api/cast");
  if (!r.ok) throw new Error(tr(`キャラクターを読み込めません（${r.status}）`, `Can't load the characters (${r.status})`));
  server = (await r.json()) as CasterState;
  screen = server.project.screen;
  cast = structuredClone(server.file.cast);
  saved = JSON.stringify(cast);
  savedCast = structuredClone(cast);
  ui.title.textContent = server.project.title;

  const wb = server.writeBack;
  ui.writeback.hidden = !wb;
  if (wb) {
    ui.writeback.classList.toggle("warn", wb.kind === "none");
    ui.writeback.textContent =
      wb.kind === "profile"
        ? tr(`インポートで作成された cast.json です。保存すると、インポート元（${wb.target}）にも書き戻します。`, `This cast.json was made by an import. Saving also writes back to the import source (${wb.target}).`)
        : wb.kind === "tatie"
          ? tr(`インポートで作成された cast.json です。保存すると、インポート元の Tyrano Tatie の設定にも書き戻します: ${wb.target}`, `This cast.json was made by an import. Saving also writes back to the Tyrano Tatie settings of the import source: ${wb.target}`)
          : tr(`インポートで作成された cast.json です。書き戻す先がないため、次のインポートで上書きされます。`, `This cast.json was made by an import. There's nowhere to write back to, so the next import will overwrite it.`);
  }

  const background = params.get("bg") ?? recall("background") ?? server.backgrounds[0] ?? "";
  options(ui.background, [["", tr("なし", "None")], ...server.backgrounds.map((f): [string, string] => [f, f])], background);
  showBackground(ui.background.value);
  ui.clipGame.checked = recall("clip-game") === "1";
  ui.showGameUi.checked = recall("game-ui") === "1";
  showGameUi(ui.showGameUi.checked);

  Object.assign(sel, {
    who: params.get("who") ?? "",
    appearance: params.get("appearance") ?? "",
    variant: params.get("variant") ?? "",
    position: params.get("position") ?? "center",
  });
  fit();
  new ResizeObserver(fit).observe(ui.viewport);
  select({});
  setStatus(Object.keys(cast).length ? "" : tr("キャラクターがいません。キャラクターの＋で追加してください", "No characters. Add one with the character +"));
  splitters();
  expose();
}

/**
 * 制作画面が使う口（同じオリジンの iframe から呼ぶ）。dirty は保存していない変更があるか、save は保存（閉じる前・「更新」の前）、
 * select はその立ち絵を選ぶ（台本のカーソルの行の立ち絵）、reload は cast.json を読み直す（保存していない変更が無いときだけ）。
 */
function expose(): void {
  (window as unknown as { __liminaliaCaster: unknown }).__liminaliaCaster = {
    dirty,
    save: async () => {
      if (!dirty()) return;
      await save();
      if (dirty()) throw new Error(tr("立ち絵の変更を保存できませんでした。「キャラクター」タブの「位置」で保存してください", "Couldn't save the sprite changes. Save them in Characters, Position"));
    },
    select: (next: Partial<Selection>) => {
      if (next.who && !cast[next.who]) return;
      select(next);
    },
    reload: () => {
      if (!dirty()) location.reload();
    },
  };
}

start().catch((e: Error) => setStatus(e.message, true));
