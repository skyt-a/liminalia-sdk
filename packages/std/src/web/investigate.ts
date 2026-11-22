import type { StageState, Value } from "@liminalia/runtime";
import { dataText, systemText, type RenderContext, type Renderer, type ScreenHandle } from "@liminalia/web";
import { hitRect, INVESTIGATION_FILE, investigationOutcomes, readInvestigation, type Investigation, type InvestigationAnswer, type InvestigationSpot } from "../commands/investigate.ts";
import "./investigate.css";

/**
 * @investigate の描画。背景の上に場所のボタンを置いた作品の画面を開き、押した場所（か「調べ終える」、初めて入る視点）を返す。
 * 見た目は標準のシステム画面の部品（lm-tab・lm-button）と同じ class なので、テーマの色と形がそのまま効く。
 * 場所の矩形は舞台の px で、画面の大きさに対する割合で置く（縦長の作品でも、拡大・縮小でもずれない）。当たり判定は hitScale で縮める。
 * 視点の札には顔（face）を出す。初めて入ったときは扉の題（opening）を大きく出してから消す（押すとすぐ消える）。
 * 場所の名前（tip か label）は、マウスを載せたときとキーで選んだときに出す。指では一度目に押すと名前と枠を出し（data-armed）、
 * 同じ場所をもう一度押すか名前を押すと調べる（マウスとキーは一度で調べる）。制作画面のプレビューがスマホの見え方を真似ているときも指と同じ。
 * 「場所を示す」（lm-investigate-reveal）を押すと、調べられる場所をすべて光らせる（もう一度押すと戻す）。
 * progress なら、見出しの横に調べた必須の場所の数（lm-investigate-progress）を出す。
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

/** 画面の文言（今の言語のシステム画面の文言。作品の文言の表の investigate.* で替えられる）。 */
const t = (k: "finish" | "done" | "unfinished" | "reveal") => systemText().investigate[k];

/** 扉の題を出しておく長さ（ミリ秒。出し入れの時間を除く）。 */
const OPENING_HOLD = 1200;
const OPENING_FADE = 400;

/** 画面の中身を作る（描画とテストで使う）。 */
export function buildInvestigation(
  ctx: Pick<RenderContext, "asset" | "screen"> & Partial<Pick<RenderContext, "skipping">>,
  place: Investigation,
  o: {
    view: string;
    complete: boolean;
    examined: readonly string[];
    visible: Readonly<Record<string, readonly string[]>>;
    /** 入ったことのある視点（初めて入るときの場面を持つ視点だけが気にする）。 */
    entered?: readonly string[];
    /** 扉の題（初めて入ったときだけ。無ければ出さない）。 */
    opening?: string;
    onView(view: string): void;
    answer(a: InvestigationAnswer): void;
    /** 調べていない場所が残ったまま「調べ終える」を押したときに尋ねる（はいなら true。無ければ尋ねない）。 */
    confirmFinish?(): Promise<boolean>;
  },
): HTMLElement {
  const root = el("div", "lm-investigate");
  const picture = el("div", "lm-investigate-stage");
  const bg = el("img", "lm-investigate-bg");
  bg.alt = "";
  picture.append(bg);
  const spots = el("div", "lm-investigate-spots");
  picture.append(spots);
  const head = el("div", "lm-investigate-head");
  const title = pick(place.title, place.titleEn);
  if (title) head.append(el("h2", "lm-investigate-title", title));
  // 調べた必須の場所の数（出している場所と、調べて隠れた場所。必須でないものは数えない）
  if (place.progress) {
    const required = place.views.flatMap((v) => (v.spots ?? []).filter((s) => s.required !== false && ((o.visible[v.id] ?? []).includes(s.id) || o.examined.includes(s.id))));
    const done = required.filter((s) => o.examined.includes(s.id)).length;
    head.append(el("span", "lm-investigate-progress", `${done} / ${required.length}`));
  }
  const tabs = el("nav", "lm-tabs lm-investigate-views");
  if (place.views.length > 1) head.append(tabs);
  const entered = new Set(o.entered ?? []);
  const unfinishedEnd = (viewId: string) => !!(place.views.find((v) => v.id === viewId)?.end || place.incomplete);
  const finish = el("button", "lm-button lm-investigate-finish", t("finish"));
  finish.type = "button";
  let asking = false;
  finish.addEventListener("click", (e) => {
    e.stopPropagation();
    if (o.complete) return o.answer({ action: "finish", view: current });
    if (!unfinishedEnd(current) || asking) return;
    // 調べていない場所が残っている（調べ足りないまま終える道）。確かめてから終える
    const view = current;
    if (!o.confirmFinish) return o.answer({ action: "finish", view });
    asking = true;
    void o.confirmFinish().then((yes) => {
      asking = false;
      if (yes && finish.isConnected) o.answer({ action: "finish", view });
    });
  });
  // 調べられる場所をすべて光らせる（押すたびに切り替える）
  const reveal = el("button", "lm-button lm-investigate-reveal", t("reveal"));
  reveal.type = "button";
  reveal.setAttribute("aria-pressed", "false");
  reveal.addEventListener("click", (e) => {
    e.stopPropagation();
    const on = root.dataset.reveal !== "true";
    if (on) root.dataset.reveal = "true";
    else delete root.dataset.reveal;
    reveal.setAttribute("aria-pressed", String(on));
  });
  head.append(reveal);
  // 「調べ終える」は、終わり方が button のときと、調べ足りないまま終える道があるときに出す
  if (place.finish === "button" || place.incomplete || place.views.some((v) => v.end)) head.append(finish);
  root.append(picture, head);
  const tip = el("div", "lm-investigate-tip");
  tip.hidden = true;
  root.append(tip);
  let current = o.view;
  /** 直前の押しが指か（pointerdown の種類。制作画面のプレビューがスマホの見え方を真似ているときも指とみなす）。 */
  let touch = false;
  root.addEventListener(
    "pointerdown",
    (e) => {
      touch = e.pointerType === "touch" || e.pointerType === "pen" || document.documentElement.classList.contains("lm-emulate-touch");
    },
    true,
  );
  /** 指で一度押して名前を出している場所（もう一度押すと調べる）。 */
  let armed: { id: string; examine: () => void } | null = null;
  const disarm = () => {
    armed = null;
    for (const b of spots.children) delete (b as HTMLElement).dataset.armed;
    tip.classList.remove("is-armed");
  };
  // 名前を押しても調べる（指で名前を出しているとき）
  tip.addEventListener("click", (e) => {
    e.stopPropagation();
    armed?.examine();
  });
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  const show = (viewId: string) => {
    current = viewId;
    disarm();
    tip.hidden = true;
    const view = place.views.find((v) => v.id === viewId) ?? place.views[0]!;
    bg.src = ctx.asset("bgimage", view.background);
    finish.disabled = !(o.complete || unfinishedEnd(view.id));
    finish.dataset.complete = String(o.complete);
    for (const b of tabs.children) b.setAttribute("aria-pressed", String((b as HTMLElement).dataset.view === view.id));
    const ids = new Set(o.visible[view.id] ?? []);
    spots.replaceChildren(
      ...view.spots
        .filter((s) => ids.has(s.id))
        .map((s) => {
          const b = el("button", "lm-investigate-spot");
          b.type = "button";
          b.dataset.spot = s.id;
          const label = pick(s.label, s.labelEn);
          b.setAttribute("aria-label", label);
          if (o.examined.includes(s.id)) b.dataset.done = "true";
          const r = hitRect(s.rect, place.hitScale);
          b.style.left = pct(r.x, ctx.screen.width);
          b.style.top = pct(r.y, ctx.screen.height);
          b.style.width = pct(r.width, ctx.screen.width);
          b.style.height = pct(r.height, ctx.screen.height);
          const text = (s.tip ? dataText(INVESTIGATION_FILE, s.tip) : "") || label;
          const showTip = () => {
            tip.textContent = o.examined.includes(s.id) ? `${text}（${t("done")}）` : text;
            tip.hidden = false;
          };
          /** 名前を隠す（指で名前を出している場所なら残す）。 */
          const hideTip = () => {
            if (armed) return;
            tip.hidden = true;
          };
          const examine = () => o.answer({ action: "spot", view: view.id, spot: s.id });
          b.addEventListener("pointerenter", (e) => {
            if (e.pointerType === "mouse") showTip();
          });
          b.addEventListener("focus", () => {
            if (!armed) showTip();
          });
          b.addEventListener("pointerleave", (e) => {
            if (e.pointerType === "mouse") hideTip();
          });
          b.addEventListener("blur", hideTip);
          b.addEventListener("click", (e) => {
            e.stopPropagation();
            // 指では、一度目は名前と枠を出すだけ（何を調べるかを確かめてから押せるように）。キーで押したもの（detail が 0）は一度で調べる
            if (touch && e.detail > 0 && armed?.id !== s.id) {
              disarm();
              armed = { id: s.id, examine };
              b.dataset.armed = "true";
              tip.classList.add("is-armed");
              showTip();
              return;
            }
            examine();
          });
          return b;
        }),
    );
  };
  for (const v of place.views) {
    const b = el("button", "lm-tab lm-investigate-view");
    b.type = "button";
    b.dataset.view = v.id;
    // 視点の顔の札
    if (v.face) {
      const face = el("img", "lm-investigate-face");
      face.alt = "";
      face.src = ctx.asset("image", v.face);
      b.append(face);
      b.dataset.face = "true";
    }
    b.append(el("span", "lm-investigate-view-label", pick(v.label, v.labelEn)));
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (v.id === current) return;
      // 初めて入る視点の場面（命令が呼び、戻るとこの視点）
      if (v.enter && !entered.has(v.id)) {
        o.answer({ action: "enter", view: v.id });
        return;
      }
      show(v.id);
      o.onView(v.id);
    });
    tabs.append(b);
  }
  show(o.view);
  // 扉の題（初めて入ったときだけ。押すとすぐ消える。早送り中は出さない）
  if (o.opening && !ctx.skipping) {
    const card = el("div", "lm-investigate-opening");
    card.append(el("p", "lm-investigate-opening-title", o.opening));
    card.setAttribute("role", "status");
    root.append(card);
    const gone = () => card.remove();
    card.addEventListener("click", (e) => {
      e.stopPropagation();
      gone();
    });
    const anim = card.animate([{ opacity: 0 }, { opacity: 1, offset: OPENING_FADE / (OPENING_FADE * 2 + OPENING_HOLD) }, { opacity: 1, offset: (OPENING_FADE + OPENING_HOLD) / (OPENING_FADE * 2 + OPENING_HOLD) }, { opacity: 0 }], { duration: OPENING_FADE * 2 + OPENING_HOLD, fill: "forwards" });
    void anim.finished.then(gone, gone);
  }
  return root;
}

/** 録画（lim shot --video）で一つ選ぶまでに、選んだ場所を指して見せる時間（ミリ秒）。 */
const POINT_MS = 700;

/**
 * 録画で選べるもの（命令が画面なしで選ぶときと同じ一覧と並び。調べていない必須の場所が先）。
 * 今の視点の場所を選んだら、その場所の説明を出してから押す。ほかは答えをそのまま返す。
 */
export function investigationOffer(ctx: Pick<RenderContext, "delay">, place: Investigation, args: Record<string, Value>, root: () => HTMLElement | null, answer: (a: InvestigationAnswer) => void): { options: string[]; targets: (string | null)[]; choose(i: number): Promise<void> } {
  const ids = (v: Value | undefined) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const scope = (list: string[]) => Object.fromEntries(list.map((k) => [k, true as Value]));
  const shown = (args.visible ?? {}) as Record<string, Value>;
  const visible = new Map<string, InvestigationSpot[]>(place.views.map((v) => [v.id, (v.spots ?? []).filter((s) => ids(shown[v.id]).includes(s.id))]));
  const view = place.views.some((v) => v.id === args.view) ? String(args.view) : place.views[0]!.id;
  const outcomes = investigationOutcomes(place, view, visible, scope(ids(args.examined)), args.complete === true, scope(ids(args.entered)));
  return {
    options: outcomes.map((o) => o.label),
    targets: outcomes.map((o) => o.target),
    async choose(i) {
      const a = outcomes[i]?.value;
      if (!a) return;
      const spot = a.action === "spot" ? root()?.querySelector<HTMLButtonElement>(`.lm-investigate-spot[data-spot="${CSS.escape(a.spot)}"]`) : null;
      if (spot) {
        // 押す前に、その場所の説明を出して見せる
        spot.focus({ preventScroll: true });
        await ctx.delay(POINT_MS);
        if (spot.isConnected) spot.click();
        return;
      }
      answer(a);
    },
  };
}

export const renderers: Record<string, Renderer> = {
  investigate: async (ctx: RenderContext, args: Record<string, Value>, _wait: boolean, stage: StageState) => {
    const place = readInvestigation(await ctx.loadData(INVESTIGATION_FILE).catch(() => undefined), String(args.id ?? ""));
    // 画面を開けない（作品の画面を持たないシステム画面）なら、画面なしと同じく命令に選ばせる
    if (!place || !ctx.system) return null;
    const saved = stage.extra["std.investigation"];
    const handle: ScreenHandle<InvestigationAnswer> = ctx.system.openScreen<InvestigationAnswer>(
      (h) =>
        buildInvestigation(ctx, place, {
          view: String(args.view ?? ""),
          complete: args.complete === true,
          examined: Array.isArray(args.examined) ? (args.examined as string[]) : [],
          visible: (args.visible ?? {}) as Record<string, string[]>,
          entered: Array.isArray(args.entered) ? (args.entered as string[]) : [],
          ...(typeof args.openingTitle === "string" && args.openingTitle !== "" ? { opening: pick(args.openingTitle, place.openingEn) } : {}),
          onView: (view) => {
            // セーブに残す視点（命令がロードで読む）
            if (saved && typeof saved === "object" && !Array.isArray(saved)) (saved as Record<string, Value>).view = view;
          },
          answer: (a) => h.close(a),
          // 調べていない場所が残ったまま終えるときは確かめる（コンフィグで確認を省いていれば尋ねない）
          confirmFinish: () => ctx.system?.ask(t("unfinished"), "investigate-finish") ?? Promise.resolve(true),
        }),
      // 出している間も、メニュー・セーブ・履歴・コンフィグを開ける（セーブはこの命令の所に残り、ロードすると同じ視点で戻る）
      { name: "investigate", allowMenu: true },
    );
    // 出している間も常駐の文字を見せる（web の style.css の data-lm-hud）
    if (place.hud) handle.el.dataset.lmHud = "true";
    // 録画（lim shot --video）は、画面を出したまま、ふつうの選択肢と同じ選び方で選ぶ
    const withdraw = ctx.offer?.(investigationOffer(ctx, place, args, () => handle.el, (a) => handle.close(a)));
    const answer = await handle.result.finally(() => withdraw?.());
    return answer ? (answer as unknown as Value) : null;
  },
};
