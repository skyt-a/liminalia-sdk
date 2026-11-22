import { truthy, type Args, type CommandContext, type PickOutcome, type Value } from "@liminalia/runtime";
import { t, type CommandDefinition } from "@liminalia/plugin-host";
import { exprEvaluator, INVESTIGATION_FILE, sceneTarget, type InvestigationRect } from "./investigate.ts";

/**
 * 地図で行き先を選ぶ（@map-choice）。地図（背景）の上の地点を押すと説明の欄に名前、絵、説明を出し、「ここに決める」で選ぶ
 * （confirm を切ると押した地点にすぐ決める）。選んだ地点の id を result の変数に入れ、地点の飛び先へ飛ぶ（無ければ次の行へ）。
 * データは data/investigation.json の maps（@investigate と同じファイル。地点の矩形は制作画面で地図の上に引ける）。
 */

export interface MapSpot {
  id: string;
  label: string;
  labelEn?: string;
  /** 舞台の px の矩形（押せる範囲）。 */
  rect: InvestigationRect;
  /** 選んだら飛ぶ場面（`#ラベル` は地図の file のラベル）。省くと @map-choice の次の行へ。 */
  target?: string;
  desc?: string;
  descEn?: string;
  /** 説明の欄に出す絵（image からのパス）。 */
  image?: string;
  /** 出す条件の式。 */
  if?: string;
  /** 押せない条件の式（真なら出すが選べない）。 */
  locked?: string;
  /** 押せないときに説明の欄に出す理由（「鍵が要る」など）。 */
  lockedDesc?: string;
  lockedDescEn?: string;
}

export interface ChoiceMap {
  title?: string;
  titleEn?: string;
  prompt?: string;
  promptEn?: string;
  /** 地点の `#ラベル` のファイル。 */
  file?: string;
  /** 地図（bgimage からのパス。無ければ image から。図鑑の地図と同じ）。 */
  background: string;
  /** 決める前に確かめる（既定 true）。 */
  confirm?: boolean;
  /** 説明の欄の位置（既定 right）。 */
  panel?: "right" | "left" | "bottom";
  /** 出している間も常駐の文字（@hud-text）を見せる（常駐のボタンは出さない）。 */
  hud?: boolean;
  spots: MapSpot[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** データから地図を読む（形の合わないものは null）。 */
export function readMap(data: unknown, id: string): ChoiceMap | null {
  const map = isRecord(data) && isRecord(data.maps) ? data.maps[id] : undefined;
  if (!isRecord(map) || typeof map.background !== "string" || !Array.isArray(map.spots)) return null;
  return map as unknown as ChoiceMap;
}

/** 今出す地点と、押せない地点。 */
export function mapState(map: ChoiceMap, evaluate: ((src: string) => Value) | null): { visible: MapSpot[]; locked: string[] } {
  const cond = (src: string | undefined, fallback: boolean) => (!src || !evaluate ? fallback : truthy(evaluate(src)));
  const visible = map.spots.filter((s) => isRecord(s) && typeof s.id === "string" && cond(s.if, true));
  return { visible, locked: visible.filter((s) => cond(s.locked, false)).map((s) => s.id) };
}

/** 地点の飛び先（無ければ null）。 */
export const mapTarget = (map: ChoiceMap, spot: MapSpot): string | null => (spot.target ? sceneTarget(map, spot.target) : null);

/** 起こりうる結果の一覧（ctx.pick と地図の矢印）。先頭は画面なしの既定の選び方（押せる地点の最初）。 */
export function mapOutcomes(map: ChoiceMap, visible: readonly MapSpot[], locked: readonly string[]): PickOutcome<string>[] {
  return visible.filter((s) => !locked.includes(s.id)).map((s) => ({ label: s.label, target: mapTarget(map, s), value: s.id }));
}

async function runMapChoice(args: Args, ctx: CommandContext): Promise<void> {
  const id = String(args.id ?? "");
  const map = readMap(await ctx.data(INVESTIGATION_FILE), id);
  if (!map) {
    ctx.runtime.report("error", "unknown-map", `地図 ${id} が data/${INVESTIGATION_FILE} の maps にありません`);
    return;
  }
  const { visible, locked } = mapState(map, exprEvaluator(ctx));
  const outcomes = mapOutcomes(map, visible, locked);
  if (outcomes.length === 0) {
    ctx.runtime.report("warning", "empty-map", `地図 ${id} に選べる地点がありません（次の行へ進みます）`);
    return;
  }
  ctx.resumeHere();
  const returned = await ctx.present({ ...args, id, visible: visible.map((s) => s.id), locked }, true);
  if (ctx.signal.aborted) return;
  const answer = typeof returned === "string" && outcomes.some((o) => o.value === returned) ? returned : null;
  const chosen = await ctx.pick(outcomes, answer);
  if (chosen === null || chosen === undefined) return;
  const spot = visible.find((s) => s.id === chosen)!;
  if (typeof args.result === "string" && args.result !== "") ctx.runtime.setVariable(args.result, spot.id);
  const target = mapTarget(map, spot);
  if (target) await ctx.runtime.jump(target);
}

const mapChoice: CommandDefinition = {
  name: "map-choice",
  summary:
    "地図で行き先を選ばせる。地点を押すと説明の欄に名前、絵、説明を出し、「ここに決める」で選ぶ。選んだ地点の id を result の変数に入れ、地点の飛び先へ飛ぶ（無ければ次の行へ）。地図は data/investigation.json の maps",
  positional: ["id"],
  params: {
    id: t.required(t.dataKey(INVESTIGATION_FILE, "maps", "地図の名前（data/investigation.json の maps の名前）")),
    result: t.variable("選んだ地点の id を入れる変数（temp.where など）"),
  },
  example: "@map-choice town result=temp.where",
  waits: true,
  category: "flow",
  keywords: ["地図", "行き先", "移動", "選ぶ", "マップ", "map"],
  run: runMapChoice,
  targets: (args, data) => {
    const map = readMap(data(INVESTIGATION_FILE), args.id ?? "");
    if (!map) return { targets: [] };
    const targets = map.spots.flatMap((s) => (isRecord(s) && typeof s.target === "string" ? [sceneTarget(map, s.target)] : []));
    // どの地点にも飛び先があれば、かならずどこかへ飛ぶ
    return { targets: [...new Set(targets)], leaves: map.spots.length > 0 && map.spots.every((s) => isRecord(s) && !!s.target) };
  },
};

export const COMMANDS: CommandDefinition[] = [mapChoice];
