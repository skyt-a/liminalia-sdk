import type { Value } from "@liminalia/runtime";
import { dataText, systemText, type RenderContext, type Renderer, type ScreenHandle } from "@liminalia/web";
import { INVESTIGATION_FILE } from "../commands/investigate.ts";
import { mapTarget, readMap, type ChoiceMap } from "../commands/map-choice.ts";
import { srcWithFallback } from "./fallback.ts";
import "./map-choice.css";

/**
 * @map-choice の描画。地図の上に地点のボタンを置き、選んだ地点の名前・絵・説明を説明の欄に出して、「ここに決める」で返す。
 * 見た目は標準のシステム画面の部品（lm-screen-title・lm-button）と同じ class と色の変数なので、テーマの色と形が効く。
 * 矢印キー・十字キーで地点を巡り（選んだ地点の説明を出す）、Enter・A で決める。
 */

const english = () => (document.documentElement.lang || "").toLowerCase().startsWith("en");
/** 今の言語の文（英語で英語の欄があればそれ、ほかは data/investigation.json の訳。訳が無ければ原文）。 */
const pick = (ja: string | undefined, en: string | undefined) => (english() && en ? en : dataText(INVESTIGATION_FILE, ja ?? ""));
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** 画面の文言（今の言語のシステム画面の文言。作品の文言の表の mapChoice.* で替えられる）。 */
const tx = (k: "go" | "hint") => systemText().mapChoice[k];

/** 画面の中身を作る（描画とテストで使う）。 */
export function buildMapChoice(ctx: Pick<RenderContext, "asset" | "screen">, map: ChoiceMap, o: { visible: readonly string[]; locked: readonly string[]; answer(id: string): void }): HTMLElement {
  const root = el("div", "lm-map-choice");
  root.dataset.panel = map.panel ?? "right";
  const stage = el("div", "lm-map-choice-stage");
  const bg = el("img", "lm-map-choice-bg");
  bg.alt = "";
  // bgimage から探し、無ければ image から（図鑑の地図と同じ）
  srcWithFallback(bg, [ctx.asset("bgimage", map.background), ctx.asset("image", map.background)]);
  stage.append(bg);
  const confirm = map.confirm !== false;
  const panel = el("aside", "lm-map-choice-panel");
  const title = pick(map.title, map.titleEn);
  if (title) panel.append(el("h2", "lm-screen-title lm-map-choice-title", title));
  const prompt = pick(map.prompt, map.promptEn);
  if (prompt) panel.append(el("p", "lm-map-choice-prompt", prompt));
  const detail = el("div", "lm-map-choice-detail");
  detail.setAttribute("aria-live", "polite");
  const go = el("button", "lm-button lm-map-choice-go", tx("go"));
  go.type = "button";
  panel.append(detail, ...(confirm ? [go] : []));
  root.append(stage, panel);
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  const spots = map.spots.filter((s) => o.visible.includes(s.id));
  let selected: string | null = null;
  const buttons = spots.map((s) => {
    const b = el("button", "lm-map-choice-spot");
    b.type = "button";
    b.dataset.spot = s.id;
    const label = pick(s.label, s.labelEn);
    b.append(el("span", "lm-map-choice-mark"), el("span", "lm-map-choice-label", label));
    b.setAttribute("aria-label", label);
    if (o.locked.includes(s.id)) {
      b.dataset.locked = "true";
      b.setAttribute("aria-disabled", "true");
    }
    b.style.left = pct(s.rect.x, ctx.screen.width);
    b.style.top = pct(s.rect.y, ctx.screen.height);
    b.style.width = pct(s.rect.width, ctx.screen.width);
    b.style.height = pct(s.rect.height, ctx.screen.height);
    b.addEventListener("focus", () => select(s.id));
    b.addEventListener("pointerenter", () => select(s.id));
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      select(s.id);
      if (!confirm) choose();
    });
    stage.append(b);
    return b;
  });
  const select = (id: string) => {
    const s = spots.find((x) => x.id === id);
    if (!s) return;
    selected = id;
    for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset.spot === id));
    const out: HTMLElement[] = [el("h3", "lm-map-choice-name", pick(s.label, s.labelEn))];
    if (s.image) {
      const img = el("img", "lm-map-choice-image");
      img.alt = "";
      img.src = ctx.asset("image", s.image);
      out.push(img);
    }
    for (const para of pick(s.desc, s.descEn).split(/\n+/).filter((x) => x !== "")) out.push(el("p", "lm-map-choice-desc", para));
    // 押せない理由
    if (o.locked.includes(id)) for (const para of pick(s.lockedDesc, s.lockedDescEn).split(/\n+/).filter((x) => x !== "")) out.push(el("p", "lm-map-choice-locked", para));
    detail.replaceChildren(...out);
    go.disabled = o.locked.includes(id);
  };
  const choose = () => {
    if (selected === null || o.locked.includes(selected)) return;
    o.answer(selected);
  };
  go.addEventListener("click", (e) => {
    e.stopPropagation();
    choose();
  });
  root.addEventListener("click", (e) => e.stopPropagation());
  if (spots.length > 0) select(spots.find((s) => !o.locked.includes(s.id))?.id ?? spots[0]!.id);
  else {
    detail.append(el("p", "lm-map-choice-desc", tx("hint")));
    go.disabled = true;
  }
  return root;
}

/** 録画（lim shot --video）で一つ選ぶまでに、選んだ地点の説明を見せる時間（ミリ秒）。 */
const POINT_MS = 900;

/**
 * 録画で選べるもの（出している地点の並び。押せない地点は null）。選んだ地点を押して説明の欄に出し、しばらく見せてから「ここに決める」を押す。
 */
export function mapChoiceOffer(ctx: Pick<RenderContext, "delay">, map: ChoiceMap, o: { visible: readonly string[]; locked: readonly string[] }, root: () => HTMLElement | null): { options: (string | null)[]; targets: (string | null)[]; choose(i: number): Promise<void> } {
  const spots = map.spots.filter((s) => o.visible.includes(s.id));
  return {
    options: spots.map((s) => (o.locked.includes(s.id) ? null : s.label)),
    targets: spots.map((s) => mapTarget(map, s)),
    async choose(i) {
      const spot = spots[i];
      const el = root();
      const button = spot && el?.querySelector<HTMLButtonElement>(`.lm-map-choice-spot[data-spot="${CSS.escape(spot.id)}"]`);
      if (!button) return;
      if (map.confirm === false) {
        button.click();
        return;
      }
      // 地点を選んで説明を出し、見せてから決める
      button.focus({ preventScroll: true });
      await ctx.delay(POINT_MS);
      el?.querySelector<HTMLButtonElement>(".lm-map-choice-go")?.click();
    },
  };
}

export const renderers: Record<string, Renderer> = {
  "map-choice": async (ctx: RenderContext, args: Record<string, Value>) => {
    const map = readMap(await ctx.loadData(INVESTIGATION_FILE).catch(() => undefined), String(args.id ?? ""));
    // 画面を開けない（作品の画面を持たないシステム画面）なら、画面なしと同じく命令に選ばせる
    if (!map || !ctx.system) return null;
    const shown = {
      visible: Array.isArray(args.visible) ? (args.visible as string[]) : map.spots.map((s) => s.id),
      locked: Array.isArray(args.locked) ? (args.locked as string[]) : [],
    };
    // 出している間も、メニュー・セーブ・履歴・コンフィグを開ける（セーブはこの命令の所に残り、ロードすると地図に戻る）
    const handle: ScreenHandle<string> = ctx.system.openScreen<string>((h) => buildMapChoice(ctx, map, { ...shown, answer: (id) => h.close(id) }), { name: "map-choice", allowMenu: true });
    // 出している間も常駐の文字を見せる（web の style.css の data-lm-hud）
    if (map.hud) handle.el.dataset.lmHud = "true";
    // 録画（lim shot --video）は、画面を出したまま、ふつうの選択肢と同じ選び方で選ぶ
    const withdraw = ctx.offer?.(mapChoiceOffer(ctx, map, shown, () => handle.el));
    return (await handle.result.finally(() => withdraw?.())) ?? null;
  },
};
