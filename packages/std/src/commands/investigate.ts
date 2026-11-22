import { parseExpr, type DataDeclaration } from "@liminalia/lang";
import { EvalError, truthy, type Args, type CommandContext, type PickOutcome, type Value } from "@liminalia/runtime";
import { d, t, type CommandDefinition } from "@liminalia/sdk";

/**
 * 調べる場所（@investigate）。背景の上に矩形の場所を置いて選ばせ、選んだ場所の場面を呼び出す。
 * 場面は次のラベルかファイルの終わりで（@return を書かなくても）調べる画面へ戻り、調べた印と完了のフラグは命令が立てる。
 * 必須の場所をすべて調べたら、完了の飛び先（done）へ進む（無ければ @investigate の次の行へ）。
 * - 視点ごとに顔の札（face）を出し、初めてその視点へ切り替えたときの場面（enter。呼んで戻る）を挟める
 * - 場所を二度目に調べたときは again の場面（無ければ target）。場面の中では temp.first_visit が初めてなら true
 * - 調べ足りないまま「調べ終える」を押したときの飛び先（視点ごとの end、無ければ場所の incomplete）を書くと、終える前でも押せる
 * - 初めて入ったときに、扉の題（opening）を大きく出す
 * データは data/investigation.json（形は下の INVESTIGATION_DATA。制作画面が背景の上で矩形を引いて直せる）。
 */

export interface InvestigationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InvestigationSpot {
  id: string;
  label: string;
  labelEn?: string;
  /** 舞台の px の矩形。 */
  rect: InvestigationRect;
  /** 調べたときに呼ぶ場面（`#ラベル` は調べる場所の file のラベル）。 */
  target: string;
  /** 二度目からに呼ぶ場面（無ければ target。場面の中の temp.first_visit でも分けられる）。 */
  again?: string;
  /** 終わりの条件に入るか（既定 true）。 */
  required?: boolean;
  /** 調べたら true にするフラグ（`game.x` か `x`）。省いても調べた印は命令が覚える。 */
  flag?: string;
  /** 出す条件の式（偽なら出さない）。 */
  if?: string;
  /** マウスを重ねたときに出す短い説明。 */
  tip?: string;
  /** 調べたあとは出さない。 */
  once?: boolean;
}

export interface InvestigationView {
  id: string;
  label: string;
  labelEn?: string;
  /** 背景（bgimage からのパス）。extra.cg の画像なら、出したときに CG として解放する。 */
  background: string;
  /** 視点を切り替える札の顔（image からのパス）。 */
  face?: string;
  /** 札でこの視点へ初めて切り替えたときに呼ぶ場面（次のラベルで調べる画面へ戻る。戻るとこの視点）。 */
  enter?: string;
  /** この視点へ入ったら true にするフラグ（`game.x` か `x`）。省いても入った印は命令が覚える。 */
  enterFlag?: string;
  /** 調べ足りないまま、この視点で「調べ終える」を押したときの飛び先（場所の incomplete より先に使う）。 */
  end?: string;
  spots: InvestigationSpot[];
}

export interface Investigation {
  title?: string;
  titleEn?: string;
  /** 初めて入ったときに大きく出す扉の題（無ければ出さない）。 */
  opening?: string;
  openingEn?: string;
  /** 場面のファイル（spots の `#ラベル` のファイル）。 */
  file: string;
  views: InvestigationView[];
  /** 必須の場所を調べ終えたら飛ぶ場面。省くと @investigate の次の行へ進む。 */
  done?: string;
  /** 調べ足りないまま「調べ終える」を押したときの飛び先（視点の end が無いとき）。書くと、終える前でも押せる。 */
  incomplete?: string;
  /** auto: 調べ終えたらすぐ done へ。button: 「調べ終える」を押したら（調べ終えるまで押せない。incomplete・end があれば押せる）。 */
  finish?: "auto" | "button";
  /** 場所の当たり判定を、矩形の中心を保ったまま縮める率（0.1〜1。既定 1）。絵の縁で押せてしまうのを防ぐ。 */
  hitScale?: number;
  /** 見出しの横に、調べた必須の場所の数（「1 / 3」）を出す。 */
  progress?: boolean;
  /** 出している間も常駐の文字（@hud-text）を見せる（常駐のボタンは出さない）。 */
  hud?: boolean;
}

export interface InvestigationData {
  places: Record<string, Investigation>;
  /** 地図で行き先を選ぶ画面（@map-choice。map-choice.ts）。 */
  maps?: Record<string, unknown>;
}

export const INVESTIGATION_FILE = "investigation.json";

const L = (label: string, labelEn: string, doc?: string, docEn?: string) => ({ label, labelEn, ...(doc ? { doc } : {}), ...(docEn ? { docEn } : {}) });

/** 地図で行き先を選ぶ画面の形（@map-choice。data/investigation.json の maps）。 */
const MAPS_DATA = d.map(
  d.record(
    {
      title: d.string(L("見出し", "Title"), { translate: true }),
      titleEn: d.string(L("見出し（英語）", "Title (English)")),
      prompt: d.text(L("案内", "Prompt", "見出しの下に出す短い文", "A short line under the title"), { translate: true }),
      promptEn: d.text(L("案内（英語）", "Prompt (English)")),
      file: d.file(L("場面のファイル", "Scene file", "地点の飛び先に書いた #ラベル は、このファイルのラベルを指す", "#label targets are labels in this file")),
      background: d.required(d.asset("bgimage", L("地図", "Map", "bgimage から探し、無ければ image から探す（図鑑の地図と同じ）", "Looked up in bgimage, then in image (the same as the codex map)"), { also: ["image"] })),
      confirm: d.bool(L("決める前に確かめる", "Confirm", "地点を押すと説明を出し、決めるボタンで選ぶ（既定）。切ると押した地点にすぐ決める", "Pressing a spot shows its details and the Go button picks it (default). Off picks the spot at once")),
      panel: d.enum(["right", "left", "bottom"], L("説明の欄の位置", "Panel position")),
      hud: d.bool(L("常駐の文字を見せる", "Show HUD text", "出している間も @hud-text の文字を上に見せる（常駐のボタンは出さない）", "Keeps @hud-text visible on top while the map is shown (HUD buttons stay hidden)")),
      spots: d.list(
        d.record(
          {
            id: d.required(d.string(L("ID", "Id"))),
            label: d.required(d.string(L("名前", "Name"), { translate: true })),
            labelEn: d.string(L("名前（英語）", "Name (English)")),
            rect: d.required(d.rect(L("場所", "Area"), { image: "background" })),
            target: d.scene(L("飛び先", "Target", "省くと @map-choice の次の行へ進む（選んだ地点は result の変数で分ける）", "Without it, play goes on after @map-choice (branch on the result variable)"), { base: "file" }),
            desc: d.text(L("説明", "Description"), { translate: true }),
            descEn: d.text(L("説明（英語）", "Description (English)")),
            image: d.asset("image", L("説明の絵", "Picture")),
            if: d.expr(L("出す条件", "Show if")),
            locked: d.expr(L("押せない条件", "Locked if", "真なら出すが選べない", "Shown but can't be picked while true")),
            lockedDesc: d.text(L("押せない理由", "Locked reason", "押せないときに説明の欄に出す", "Shown in the panel while the spot is locked"), { translate: true }),
            lockedDescEn: d.text(L("押せない理由（英語）", "Locked reason (English)")),
          },
          L("地点", "Spot"),
          { title: "label" },
        ),
        L("地点", "Spots"),
        { sortable: true, key: "id" },
      ),
    },
    L("地図", "Map"),
    { title: "title" },
  ),
  L("地図で選ぶ", "Map choices"),
);

/** data/investigation.json の形の宣言（検査・制作画面のフォーム・名前を変えたときの書き換え）。 */
export const INVESTIGATION_DATA: DataDeclaration = {
  file: INVESTIGATION_FILE,
  title: "調べる場所",
  titleEn: "Investigation",
  root: d.record({
    places: d.map(
      d.record(
        {
          title: d.string(L("見出し", "Title"), { translate: true }),
          titleEn: d.string(L("見出し（英語）", "Title (English)")),
          opening: d.string(L("扉の題", "Opening title", "初めて入ったときに大きく出す", "Shown large the first time the place opens"), { translate: true }),
          openingEn: d.string(L("扉の題（英語）", "Opening title (English)")),
          file: d.required(d.file(L("場面のファイル", "Scene file", "場所の飛び先に書いた #ラベル は、このファイルのラベルを指す", "#label targets are labels in this file"))),
          finish: d.enum(["auto", "button"], L("終わり方", "Finish", "auto は調べ終えたらすぐ終わり、button は「調べ終える」を押したら終わる", "auto finishes at once, button waits for the finish button")),
          done: d.scene(L("完了の飛び先", "Done target", "省くと @investigate の次の行へ進む", "Without it, play goes on after @investigate"), { base: "file" }),
          incomplete: d.scene(L("調べ足りないまま終える飛び先", "Unfinished target", "書くと、調べ終える前でも「調べ終える」を押せる（視点の終わりの飛び先のほうを優先する）", "With it, the finish button works before everything is examined (a view's end target comes first)"), { base: "file" }),
          hitScale: d.number(L("当たり判定の大きさ", "Hit area scale", "場所の矩形を、中心を変えずに縮める率（0.1〜1）", "Shrinks spot areas around their centers (0.1 to 1)"), { min: 0.1, max: 1 }),
          progress: d.bool(L("調べた数を出す", "Show progress", "見出しの横に、調べた必須の場所の数を出す（1 / 3）", "Shows how many required spots are examined next to the title (1 / 3)")),
          hud: d.bool(L("常駐の文字を見せる", "Show HUD text", "出している間も @hud-text の文字を上に見せる（常駐のボタンは出さない）", "Keeps @hud-text visible on top while the place is shown (HUD buttons stay hidden)")),
          views: d.list(
            d.record(
              {
                id: d.required(d.string(L("ID", "Id"))),
                label: d.required(d.string(L("見出し", "Label"), { translate: true })),
                labelEn: d.string(L("見出し（英語）", "Label (English)")),
                background: d.required(d.asset("bgimage", L("背景", "Background"), { cg: true })),
                face: d.asset("image", L("札の顔", "Face", "視点を切り替える札に出す顔", "The face on the view's tab")),
                enter: d.scene(L("初めて入るときの場面", "First entry scene", "札で初めて切り替えたときに呼び、次のラベルで戻る", "Called the first time the tab is used; returns at the next label"), { base: "file" }),
                enterFlag: d.flag("set", L("入ったフラグ", "Entered flag")),
                end: d.scene(L("終わりの飛び先", "End target", "調べ足りないまま、この視点で終えたとき", "When finishing in this view before everything is examined"), { base: "file" }),
                spots: d.list(
                  d.record(
                    {
                      id: d.required(d.string(L("ID", "Id"))),
                      label: d.required(d.string(L("見出し", "Label"), { translate: true })),
                      labelEn: d.string(L("見出し（英語）", "Label (English)")),
                      rect: d.required(d.rect(L("場所", "Area"), { image: "background" })),
                      target: d.required(d.scene(L("調べたときの場面", "Scene"), { base: "file" })),
                      again: d.scene(L("二度目からの場面", "Revisit scene", "省くと同じ場面（temp.first_visit で分けられる）", "Without it, the same scene (branch on temp.first_visit)"), { base: "file" }),
                      required: d.bool(L("必須", "Required")),
                      flag: d.flag("set", L("完了のフラグ", "Done flag")),
                      if: d.expr(L("出す条件", "Show if")),
                      tip: d.string(L("説明", "Tip"), { translate: true }),
                      once: d.bool(L("調べたら隠す", "Hide when done")),
                    },
                    L("場所", "Spot"),
                    { title: "label" },
                  ),
                  L("調べる場所", "Spots"),
                  { sortable: true, key: "id" },
                ),
              },
              L("視点", "View"),
              { title: "label" },
            ),
            L("視点", "Views"),
            { sortable: true, key: "id" },
          ),
        },
        L("調べる場所", "Place"),
        { title: "title" },
      ),
      L("調べる場所", "Places"),
    ),
    maps: MAPS_DATA,
  }),
};

/** 調べた印（ゲームの変数の、式からは書けない名前のところ）。場所の名前 → 場所の id → true。 */
export const INVESTIGATION_KEY = "@investigation";
/** 調べる場所ごとの今の様子（場所の名前 → { view: 最後に見ていた視点, entered: 入った視点 → true, opened: 扉の題を出した }）。 */
export const INVESTIGATION_STATE_KEY = "@investigation-state";
/** 調べる場面の中で、その場所を初めて調べたか（場面を呼ぶ前に入れる）。 */
export const FIRST_VISIT = "temp.first_visit";

type Scope = Record<string, Value>;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** データから調べる場所を読む（形の合わないものは null）。 */
export function readInvestigation(data: unknown, id: string): Investigation | null {
  const place = isRecord(data) && isRecord(data.places) ? data.places[id] : undefined;
  if (!isRecord(place) || typeof place.file !== "string" || !Array.isArray(place.views)) return null;
  return place as unknown as Investigation;
}

/** 調べた印（場所の id → true）。 */
export function examinedOf(game: Scope, id: string): Scope {
  const all = isRecord(game[INVESTIGATION_KEY]) ? (game[INVESTIGATION_KEY] as Scope) : (game[INVESTIGATION_KEY] = {});
  return isRecord(all[id]) ? (all[id] as Scope) : (all[id] = {});
}

/** 調べる場所の今の様子（最後の視点・入った視点・扉の題を出したか）。 */
export function placeStateOf(game: Scope, id: string): { view?: string; opened?: boolean; entered: Scope } {
  const all = isRecord(game[INVESTIGATION_STATE_KEY]) ? (game[INVESTIGATION_STATE_KEY] as Scope) : (game[INVESTIGATION_STATE_KEY] = {});
  const s = isRecord(all[id]) ? (all[id] as Scope) : (all[id] = {});
  if (!isRecord(s.entered)) s.entered = {};
  return s as unknown as { view?: string; opened?: boolean; entered: Scope };
}

/** 飛び先を `ファイル#ラベル` にする（`#ラベル` は file のラベル）。 */
export function sceneTarget(place: { file?: string }, target: string): string {
  return target.startsWith("#") && place.file ? `${place.file}${target}` : target;
}

/** 当たり判定の矩形（hitScale で中心を保ったまま縮めたもの）。 */
export function hitRect(rect: InvestigationRect, scale: number | undefined): InvestigationRect {
  const s = typeof scale === "number" && scale > 0 && scale < 1 ? Math.max(0.1, scale) : 1;
  if (s === 1) return rect;
  const width = rect.width * s;
  const height = rect.height * s;
  return { x: rect.x + (rect.width - width) / 2, y: rect.y + (rect.height - height) / 2, width, height };
}

const exprCache = new Map<string, ReturnType<typeof parseExpr> | null>();
/**
 * 条件の式を評価する関数（読めない式は真。構文チェックが知らせる）。計算できない式（初期値の無い変数を数と比べたなど）は、
 * 実行時のエラーを知らせて偽にする（実行器の @if や選択肢の if= と同じく、真の側へ黙って進まない）。
 */
export function exprEvaluator(ctx: CommandContext): (src: string) => Value {
  return (src) => {
    let e = exprCache.get(src);
    if (e === undefined) {
      try {
        e = parseExpr(src);
      } catch {
        e = null;
      }
      exprCache.set(src, e);
    }
    if (!e) return true;
    try {
      return ctx.runtime.eval(e);
    } catch (err) {
      if (!(err instanceof EvalError)) throw err;
      ctx.runtime.report("error", "runtime", `条件の式を計算できないため、偽として扱いました（${err.message}）`);
      return false;
    }
  };
}

/** 出す条件（式が読めなければ出す）。 */
function shown(spot: InvestigationSpot, evaluate: ((src: string) => Value) | null): boolean {
  if (!spot.if || !evaluate) return true;
  return truthy(evaluate(spot.if));
}

/** 今出す場所（視点ごと）と、調べ終えたか。 */
export function investigationState(place: Investigation, examined: Scope, evaluate: ((src: string) => Value) | null): { visible: Map<string, InvestigationSpot[]>; complete: boolean } {
  const visible = new Map<string, InvestigationSpot[]>();
  let complete = true;
  for (const v of place.views) {
    const list = (v.spots ?? []).filter((s) => shown(s, evaluate));
    for (const s of list) if (s.required !== false && examined[s.id] !== true) complete = false;
    visible.set(
      v.id,
      list.filter((s) => !(s.once && examined[s.id] === true)),
    );
  }
  return { visible, complete };
}

/** 調べ足りないまま終えたときの飛び先（その視点の end、無ければ場所の incomplete。どちらも無ければ null）。 */
export function incompleteTarget(place: Investigation, view: string): string | null {
  const end = place.views.find((v) => v.id === view)?.end || place.incomplete;
  return end ? sceneTarget(place, end) : null;
}

/** 描画側が返す答え。enter は札で初めてその視点へ切り替えた。 */
export type InvestigationAnswer = { action: "spot"; view: string; spot: string } | { action: "finish"; view: string } | { action: "enter"; view: string };

function parseAnswer(v: Value | void, place: Investigation, visible: Map<string, InvestigationSpot[]>, complete: boolean, entered: Scope): InvestigationAnswer | null {
  if (!isRecord(v) || typeof v.view !== "string" || !visible.has(v.view)) return null;
  if (v.action === "finish") return complete || incompleteTarget(place, v.view) !== null ? { action: "finish", view: v.view } : null;
  if (v.action === "enter") return place.views.find((x) => x.id === v.view)?.enter && entered[v.view] !== true ? { action: "enter", view: v.view } : null;
  if (v.action === "spot" && typeof v.spot === "string" && visible.get(v.view)!.some((s) => s.id === v.spot)) return { action: "spot", view: v.view, spot: v.spot };
  return null;
}

/** 場所を調べたときに呼ぶ場面（二度目からは again があればそれ）。 */
export function spotTarget(place: Investigation, spot: InvestigationSpot, examined: boolean): string {
  return sceneTarget(place, examined && spot.again ? spot.again : spot.target);
}

/**
 * 起こりうる結果の一覧（ctx.pick と地図の矢印）。先頭は画面なしの既定の選び方: 今の視点から順に、まだ調べていない必須の場所。
 * 調べ終えていれば「調べ終える」が先頭。まだ入っていない視点の初めての場面、調べ足りないまま終える道は、後ろに並べる。
 */
export function investigationOutcomes(place: Investigation, view: string, visible: Map<string, InvestigationSpot[]>, examined: Scope, complete: boolean, entered: Scope = {}): PickOutcome<InvestigationAnswer>[] {
  const order = [view, ...place.views.map((v) => v.id).filter((v) => v !== view)];
  const all: { o: PickOutcome<InvestigationAnswer>; first: boolean }[] = [];
  for (const v of order) {
    for (const s of visible.get(v) ?? []) {
      all.push({ o: { label: s.label, target: spotTarget(place, s, examined[s.id] === true), value: { action: "spot", view: v, spot: s.id } }, first: s.required !== false && examined[s.id] !== true });
    }
  }
  const out = [...all.filter((x) => x.first), ...all.filter((x) => !x.first)].map((x) => x.o);
  if (complete) out.unshift({ label: "調べ終える", target: place.done ? sceneTarget(place, place.done) : null, value: { action: "finish", view } });
  for (const v of place.views) {
    if (v.id !== view && v.enter && entered[v.id] !== true) out.push({ label: `${v.label}（初めて入る）`, target: sceneTarget(place, v.enter), value: { action: "enter", view: v.id } });
  }
  if (!complete) {
    const end = incompleteTarget(place, view);
    if (end) out.push({ label: "調べ足りないまま終える", target: end, value: { action: "finish", view } });
  }
  return out;
}

/** 調べる場所を終える（今の様子を消す）。 */
function closePlace(game: Scope, id: string): void {
  const all = game[INVESTIGATION_STATE_KEY];
  if (isRecord(all) && isRecord(all[id])) {
    const s = all[id] as Scope;
    delete s.view;
    delete s.opened;
  }
}

/** 完了の飛び先へ（無ければ次の行へ）。 */
async function finish(place: Investigation, id: string, ctx: CommandContext): Promise<void> {
  closePlace(ctx.state.game, id);
  if (place.done) await ctx.runtime.jump(sceneTarget(place, place.done));
}

async function runInvestigate(args: Args, ctx: CommandContext): Promise<void> {
  const id = String(args.id ?? "");
  const place = readInvestigation(await ctx.data(INVESTIGATION_FILE), id);
  if (!place || place.views.length === 0) {
    ctx.runtime.report("error", "unknown-investigation", `調べる場所 ${id} が data/${INVESTIGATION_FILE} にありません`);
    return;
  }
  const evaluate = exprEvaluator(ctx);
  const game = ctx.state.game;
  const examined = examinedOf(game, id);
  const state = placeStateOf(game, id);
  const { visible, complete } = investigationState(place, examined, evaluate);
  if (complete && place.finish !== "button") return finish(place, id, ctx);
  // 途中のセーブから戻ったら、そのときの視点から。場面から戻ったら、最後に見ていた視点から
  const extra = ctx.state.stage.extra;
  const saved = isRecord(extra["std.investigation"]) && extra["std.investigation"].id === id ? (extra["std.investigation"] as Scope) : null;
  const requested = typeof saved?.view === "string" ? saved.view : typeof state.view === "string" ? state.view : typeof args.view === "string" ? args.view : "";
  const view = place.views.some((v) => v.id === requested) ? requested : place.views[0]!.id;
  // 扉の題は、初めて入ったときだけ（途中のセーブから戻ったとき・場面から戻ったときは出さない）
  const opening = !state.opened && !saved && args.opening !== false ? (place.opening ?? "") : "";
  state.opened = true;
  state.view = view;
  ctx.resumeHere();
  extra["std.investigation"] = { id, view };
  const entered = state.entered;
  const returned = await ctx.present(
    {
      ...args,
      id,
      view,
      complete,
      examined: Object.keys(examined).filter((k) => examined[k] === true),
      visible: Object.fromEntries([...visible].map(([k, v]) => [k, v.map((s) => s.id)])),
      entered: Object.keys(entered).filter((k) => entered[k] === true),
      ...(opening ? { openingTitle: opening } : {}),
    },
    true,
  );
  delete extra["std.investigation"];
  if (ctx.signal.aborted) return;
  const answer = await ctx.pick(investigationOutcomes(place, view, visible, examined, complete, entered), parseAnswer(returned, place, visible, complete, entered));
  if (!answer) return;
  const shownView = place.views.find((v) => v.id === answer.view)!;
  // 画面を閉じたあとも、その視点の背景を見せておく（場面の本文はこの背景の上で読む）
  ctx.state.stage.background = shownView.background;
  delete ctx.state.stage.backgroundColor;
  ctx.runtime.unlockCgImage("bgimage", shownView.background);
  state.view = shownView.id;
  if (answer.action === "finish") {
    if (complete) return finish(place, id, ctx);
    const end = incompleteTarget(place, answer.view);
    closePlace(game, id);
    if (end) await ctx.runtime.jump(end);
    return;
  }
  if (answer.action === "enter") {
    entered[shownView.id] = true;
    if (shownView.enterFlag) ctx.runtime.setVariable(shownView.enterFlag.includes(".") ? shownView.enterFlag : `game.${shownView.enterFlag}`, true);
    await ctx.runtime.callScene(sceneTarget(place, shownView.enter!), true);
    return;
  }
  const spot = shownView.spots.find((s) => s.id === answer.spot)!;
  const before = examined[spot.id] === true;
  examined[spot.id] = true;
  if (spot.flag) ctx.runtime.setVariable(spot.flag.includes(".") ? spot.flag : `game.${spot.flag}`, true);
  // 呼ぶ場面の中で、初めて調べたかを分けられる
  ctx.runtime.setVariable(FIRST_VISIT, !before);
  await ctx.runtime.callScene(spotTarget(place, spot, before), true);
}

const investigate: CommandDefinition = {
  name: "investigate",
  summary:
    "調べる場所。背景の上の場所を選ばせ、その場面を呼ぶ（場面は次のラベルで @return なしに戻る）。必須の場所を調べ終えたら done へ進む。視点の顔の札、初めて入る視点の場面、二度目からの場面（temp.first_visit）、調べ足りないまま終える飛び先も書ける。場所は data/investigation.json",
  positional: ["id"],
  params: {
    id: t.required(t.dataKey(INVESTIGATION_FILE, "places", "調べる場所の名前（data/investigation.json の places の名前）")),
    view: t.string("最初の視点（views の id）。省くと views の最初の視点。場面から戻ったときは、最後に見ていた視点"),
    opening: t.bool("初めて入ったときに扉の題（opening）を出す", true),
  },
  example: "@investigate room",
  waits: true,
  category: "flow",
  keywords: ["調べる", "探索", "クリック", "ポイント", "現場", "investigate"],
  run: runInvestigate,
  // 自動確認では画面を出さず、場所の一覧を選択肢にして選ぶ（ctx.pick。調べていない必須の場所が先）
  autoplay: () => undefined,
  targets: (args, data) => {
    const place = readInvestigation(data(INVESTIGATION_FILE), args.id ?? "");
    if (!place) return { targets: [] };
    const targets = new Set<string>();
    for (const v of place.views) {
      for (const s of v.spots ?? []) {
        targets.add(sceneTarget(place, s.target));
        if (s.again) targets.add(sceneTarget(place, s.again));
      }
      if (v.enter) targets.add(sceneTarget(place, v.enter));
      if (v.end) targets.add(sceneTarget(place, v.end));
    }
    if (place.done) targets.add(sceneTarget(place, place.done));
    if (place.incomplete) targets.add(sceneTarget(place, place.incomplete));
    // 完了の飛び先があれば、調べ終えても調べ足りないまま終えても必ずどこかへ飛ぶ（incomplete・視点の end だけでは、調べ終えたあと次の行へ進みうる）
    return { targets: [...targets], leaves: !!place.done };
  },
};

const investigateReset: CommandDefinition = {
  name: "investigate-reset",
  summary: "調べる場所の調べた印と、入った視点の印を消す（もう一度はじめから調べさせる）。完了のフラグは消さない",
  positional: ["id"],
  params: {
    id: t.required(t.dataKey(INVESTIGATION_FILE, "places", "調べる場所の名前")),
  },
  example: "@investigate-reset room",
  category: "flow",
  keywords: ["調べる", "やり直す"],
  async run(args, ctx) {
    const id = String(args.id ?? "");
    for (const key of [INVESTIGATION_KEY, INVESTIGATION_STATE_KEY]) {
      const all = ctx.state.game[key];
      if (isRecord(all)) delete (all as Scope)[id];
    }
  },
};

export const COMMANDS: CommandDefinition[] = [investigate, investigateReset];
