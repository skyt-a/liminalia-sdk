/**
 * 立ち絵の登場順の自動配置（commandDefaults.chara の auto-layout）。並べ方は liminalia.json の autoLayout と、
 * cast.json の人物ごとの side で決める。何も書かなければ前からの並べ方（一人は中央、二人は左右、三人は左中右、四人からは左右の間を等分）。
 *
 * 実行器（@chara）は新しく出した人物を並びに入れるときに assignAutoSlots で枠を決めて状態に残し、描画側と制作画面は
 * autoLayoutSlots で今の枠を読む。どちらも状態と規則だけから決めるので、セーブとロードで同じ並びに戻る。
 *
 * autoLayout の byCount は、位置を名前で明示した立ち絵（at=left など）の読み替え。舞台の立ち絵がちょうどその人数のときだけ、
 * 書いた名前の代わりに別の名前の位置に置く（byCountPosition）。これも状態と規則だけから決まる。
 */
import { AUTO_POSITION, FRAME_POSITIONS, resolveVariant, type Cast } from "./cast.ts";
import type { Diagnostic } from "./ast.ts";

/** 新しく来た人物を並びのどこに入れるか（end は右の端、start は左の端、middle は真ん中）。 */
export type AutoLayoutEnter = "end" | "start" | "middle";
/** 誰かが退場したとき（reflow は残った人物を並べ直す、keep は動かさずに空けておく）。 */
export type AutoLayoutExit = "reflow" | "keep";
/** 人物ごとの定位置（cast.json の side）。left の人物は並びの左に、right の人物は右に寄せる。 */
export type AutoLayoutSide = "left" | "right";

/** liminalia.json の autoLayout（読み解いたもの）。 */
export interface AutoLayoutRules {
  /** 人数ごとの立ち位置（人数 → 左からの位置。立ち絵の枠の立ち位置の名前か、画面の幅に対する割合 "30%"）。 */
  positions?: Readonly<Record<string, readonly string[]>>;
  enter?: AutoLayoutEnter;
  exit?: AutoLayoutExit;
  /**
   * 人数ごとの立ち位置の読み替え（人数 → 書いた立ち位置の名前 → 置く立ち位置の名前）。舞台の立ち絵がちょうどその人数のとき、
   * 位置を名前で明示した立ち絵（自動配置の人物と x= を書いた人物は除く）を読み替え先に置く。
   */
  byCount?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** 並べるときに使うもの（規則と人物ごとの定位置）。省けば前からの並べ方。 */
export interface AutoLayoutContext {
  rules?: AutoLayoutRules | undefined;
  side?: ((who: string) => AutoLayoutSide | undefined) | undefined;
}

/** 自動配置の枠（何人の並びの、左から何番目か。0 から）。 */
export interface AutoSlot {
  index: number;
  count: number;
}

/** 並べるのに使う立ち絵の状態。 */
export interface AutoLayoutSprite {
  at: string;
  autoLayout?: boolean;
  autoSlot?: AutoSlot;
}

/** cast.json の side を読む口。 */
export function castSides(cast: Readonly<Cast> | undefined): (who: string) => AutoLayoutSide | undefined {
  return (who) => {
    const side = cast?.[who]?.side;
    return side === "left" || side === "right" ? side : undefined;
  };
}

/**
 * cast.json の side の誤り（left と right のほかは効かず、黙って登場順に並ぶ）。bad-cast にする（その人物のほかの検査は続ける）。
 */
export function castSideProblems(cast: Readonly<Record<string, unknown>>): { who: string; message: string; hint: string }[] {
  const out: { who: string; message: string; hint: string }[] = [];
  for (const [who, entry] of Object.entries(cast)) {
    if (!entry || typeof entry !== "object" || !("side" in entry)) continue;
    const side = (entry as { side?: unknown }).side;
    if (side === "left" || side === "right") continue;
    out.push({ who, message: `キャラクター ${who} の side は left か right で書きます（${JSON.stringify(side)}）`, hint: "定位置が無ければ side を消します（登場順に並べます）" });
  }
  return out;
}

/** liminalia.json の autoLayout を読み解く（形の違うものは無視する。形の誤りは checkAutoLayout が知らせる）。 */
export function autoLayoutRules(raw: unknown): AutoLayoutRules | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: { positions?: Record<string, string[]>; enter?: AutoLayoutEnter; exit?: AutoLayoutExit; byCount?: Record<string, Record<string, string>> } = {};
  if (r.positions && typeof r.positions === "object" && !Array.isArray(r.positions)) {
    const positions: Record<string, string[]> = {};
    for (const [count, list] of Object.entries(r.positions)) {
      if (!/^[1-9]\d*$/.test(count) || !Array.isArray(list) || list.length !== Number(count) || list.some((p) => typeof p !== "string" || p === "")) continue;
      positions[count] = [...(list as string[])];
    }
    if (Object.keys(positions).length > 0) out.positions = positions;
  }
  if (r.enter === "end" || r.enter === "start" || r.enter === "middle") out.enter = r.enter;
  if (r.exit === "reflow" || r.exit === "keep") out.exit = r.exit;
  if (r.byCount && typeof r.byCount === "object" && !Array.isArray(r.byCount)) {
    const byCount: Record<string, Record<string, string>> = {};
    for (const [count, map] of Object.entries(r.byCount)) {
      if (!/^[1-9]\d*$/.test(count) || !map || typeof map !== "object" || Array.isArray(map)) continue;
      const renames = Object.fromEntries(Object.entries(map).filter(([from, to]) => from !== "" && typeof to === "string" && to !== ""));
      if (Object.keys(renames).length > 0) byCount[count] = renames as Record<string, string>;
    }
    if (Object.keys(byCount).length > 0) out.byCount = byCount;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 立ち位置の値が画面の幅に対する割合（"30%"）なら 0〜1 の数。 */
export function layoutPercent(position: string): number | null {
  const m = /^(\d+(?:\.\d+)?)%$/.exec(position);
  return m ? Number(m[1]) / 100 : null;
}

/**
 * 位置を名前で明示した立ち絵の、人数による読み替え（autoLayout の byCount）。舞台の立ち絵がちょうど count 人で、at に読み替え先があり、
 * その立ち絵の枠にその名前の位置がある（has が true を返す。省けばあるものとする）なら読み替え先、ほかは at のまま。
 * 自動配置の人物・x= を書いた人物・旧 at=auto には使わない（呼ぶ側で除く。byCountTarget が除き方を決める）。
 */
export function byCountPosition(at: string, count: number, rules: AutoLayoutRules | undefined, has?: (name: string) => boolean): string {
  const to = rules?.byCount?.[String(count)]?.[at];
  return to !== undefined && to !== at && (has?.(to) ?? true) ? to : at;
}

/** 人数による読み替え（byCountPosition）の対象の立ち絵か。位置を名前で明示していて、自動配置の人物でも x= を書いた人物でもない。 */
export function byCountTarget(sprite: AutoLayoutSprite & { x?: number | undefined }): boolean {
  return sprite.autoLayout !== true && sprite.at !== AUTO_POSITION && sprite.at !== "" && sprite.x === undefined;
}

/**
 * 表示中の立ち絵それぞれが今いる立ち位置（自動配置の人物は枠の位置、位置を明示した人物は人数による読み替えのあとの名前）。
 * 制作画面のシーンの情報など、立ち位置を名前で出すところが描画と同じ結果になるように使う。has は人物とその名前の位置が枠にあるか（省けばある）。
 */
export function shownPositions<T extends AutoLayoutSprite & { x?: number | undefined }>(items: ReadonlyArray<readonly [string, T]>, ctx?: AutoLayoutContext, has?: (who: string, name: string) => boolean): Map<string, string> {
  const slots = autoLayoutSlots(items, ctx);
  const out = new Map<string, string>();
  for (const [who, sprite] of items) {
    const slot = slots.get(who);
    if (slot) out.set(who, autoLayoutPosition(slot, ctx?.rules));
    else out.set(who, byCountTarget(sprite) ? byCountPosition(sprite.at, items.length, ctx?.rules, has ? (name) => has(who, name) : undefined) : sprite.at);
  }
  return out;
}

/**
 * 表示中の立ち絵それぞれの差分の枠に、その立ち位置の名前があるか（shownPositions の has）。描画（web の layoutSprites）と同じ見方で、
 * cast から差分を引けない立ち絵（描画は出さないが、人数には数える）と枠の無い差分は、どの名前も無いとする。
 * cast を渡さなければ undefined（どの枠にもあるとする。キャストを持たない画面なしの流し）。
 */
export function castPositionCheck(sprites: Readonly<Record<string, { appearance: string; variant: string }>>, cast: Readonly<Cast> | undefined): ((who: string, name: string) => boolean) | undefined {
  if (!cast) return undefined;
  const positions = new Map<string, Record<string, unknown> | undefined>();
  for (const [who, sprite] of Object.entries(sprites)) {
    const entry = cast[who];
    positions.set(who, entry ? resolveVariant(entry, sprite.appearance, sprite.variant).variant?.frame?.positions : undefined);
  }
  return (who, name) => !!positions.get(who)?.[name];
}

/** 規則に書いた立ち位置の名前（割合を除く）。 */
export function autoLayoutPositionNames(rules: AutoLayoutRules | undefined): string[] {
  return [...new Set(Object.values(rules?.positions ?? {}).flat().filter((p) => layoutPercent(p) === null))];
}

/**
 * 枠に置く立ち位置。規則にその人数の位置があればその値（名前か "30%"）、無ければ前からの並べ方
 * （一人は center、二人は left と right、三人は left、center、right。四人からは AUTO_POSITION で、描画側が left と right の間を等分する）。
 */
export function autoLayoutPosition(slot: AutoSlot, rules?: AutoLayoutRules): string {
  const listed = rules?.positions?.[String(slot.count)]?.[slot.index];
  if (listed !== undefined) return listed;
  if (slot.count === 1) return "center";
  if (slot.count === 2) return slot.index === 0 ? "left" : "right";
  if (slot.count === 3) return ["left", "center", "right"][slot.index]!;
  return AUTO_POSITION;
}

/**
 * 枠を立ち位置の名前で呼ぶとき（@chara の replace=left など）の名前。四人からを等分する並べ方では、両端を left と right、
 * ちょうど真ん中を center と呼び、ほかは名前が無い（空）。
 */
export function autoLayoutName(slot: AutoSlot, rules?: AutoLayoutRules): string {
  const position = autoLayoutPosition(slot, rules);
  if (position !== AUTO_POSITION) return position;
  return slot.index === 0 ? "left" : slot.index === slot.count - 1 ? "right" : slot.index === (slot.count - 1) / 2 ? "center" : "";
}

/** 規則で、枠に入れたものの並び（状態に残すか）を使うか。人数ごとの位置だけなら、出した順で決まるので残さない。 */
export function autoLayoutKeepsSlots(ctx: AutoLayoutContext | undefined, cast?: Readonly<Cast>): boolean {
  const rules = ctx?.rules;
  if ((rules?.enter !== undefined && rules.enter !== "end") || rules?.exit === "keep") return true;
  return Object.values(cast ?? {}).some((entry) => entry.side === "left" || entry.side === "right");
}

/** 位置を明示した人物が、count 人の並びで占める枠。 */
function occupiedIndex(at: string, count: number, rules: AutoLayoutRules | undefined): number {
  const listed = rules?.positions?.[String(count)]?.indexOf(at) ?? -1;
  if (listed >= 0) return listed;
  return at === "left" ? 0 : at === "right" ? count - 1 : Math.floor((count - 1) / 2);
}

/** 自動配置に入れる人物の並び（残した枠の順。枠の無いものは出した順のまま後ろ）を、定位置で左と右に寄せる。 */
function orderManaged<T extends AutoLayoutSprite>(managed: ReadonlyArray<readonly [string, T]>, side: AutoLayoutContext["side"]): string[] {
  const order = managed
    .map(([who, sprite], i) => ({ who, key: sprite.autoSlot?.index ?? Number.POSITIVE_INFINITY, i }))
    .sort((a, b) => a.key - b.key || a.i - b.i)
    .map((m) => m.who);
  return bySide(order, side);
}

function bySide(order: readonly string[], side: AutoLayoutContext["side"]): string[] {
  if (!side) return [...order];
  const left = order.filter((who) => side(who) === "left");
  const right = order.filter((who) => side(who) === "right");
  return [...left, ...order.filter((who) => !left.includes(who) && !right.includes(who)), ...right];
}

/** 空いた枠に、並びの順に入れる。 */
function fill(order: readonly string[], count: number, used: ReadonlySet<number>): Map<string, AutoSlot> {
  const free = Array.from({ length: count }, (_, i) => i).filter((i) => !used.has(i));
  return new Map(order.map((who, i) => [who, { index: free[i] ?? Math.min(i, count - 1), count }]));
}

/** 退場しても動かさない（exit: keep）とき、残した枠がそのまま使えるか。使えるならその人数。 */
function keptCount<T extends AutoLayoutSprite>(participants: ReadonlyArray<readonly [string, T]>, rules: AutoLayoutRules | undefined): number | null {
  if (rules?.exit !== "keep") return null;
  const managed = participants.filter(([, s]) => s.autoLayout === true);
  const count = managed[0]?.[1].autoSlot?.count;
  if (count === undefined || participants.length > count) return null;
  const used = new Set<number>();
  for (const [, s] of managed) {
    const slot = s.autoSlot;
    if (!slot || slot.count !== count || slot.index < 0 || slot.index >= count || used.has(slot.index)) return null;
    used.add(slot.index);
  }
  for (const [, s] of participants) {
    if (s.autoLayout) continue;
    const index = occupiedIndex(s.at, count, rules);
    if (used.has(index)) return null;
    used.add(index);
  }
  return count;
}

/**
 * 今の自動配置の枠（自動配置に入った人物ごと）。位置を明示した人物は自分の位置の枠を占め、自動配置の人物は空いた枠に並びの順で入る。
 * 旧 at=auto は別扱い（ここには入らない）。退場しても動かさない規則なら、残した枠をそのまま使う。
 */
export function autoLayoutSlots<T extends AutoLayoutSprite>(items: ReadonlyArray<readonly [string, T]>, ctx?: AutoLayoutContext): Map<string, AutoSlot> {
  const participants = items.filter(([, sprite]) => sprite.at !== AUTO_POSITION || sprite.autoLayout === true);
  const managed = participants.filter(([, sprite]) => sprite.autoLayout === true);
  if (managed.length === 0) return new Map();
  const rules = ctx?.rules;
  const kept = keptCount(participants, rules);
  if (kept !== null) return new Map(managed.map(([who, s]) => [who, { ...s.autoSlot! }]));
  const count = participants.length;
  const used = new Set(participants.filter(([, s]) => !s.autoLayout).map(([, s]) => occupiedIndex(s.at, count, rules)));
  return fill(orderManaged(managed, ctx?.side), count, used);
}

/**
 * 自動配置に新しく入った人物（newcomer。items の中にいて、枠はまだ無い）を並びに入れ、自動配置の人物全員の枠を決める。
 * 退場しても動かさない規則で空いた枠があれば、ほかの人物は動かさずにそこへ入れる（定位置が left なら一番左の、right なら一番右の空き。
 * 無ければ enter の側に近い空き）。空きが無ければ、enter の場所に入れ、定位置で寄せて並べ直す。
 */
export function assignAutoSlots<T extends AutoLayoutSprite>(items: ReadonlyArray<readonly [string, T]>, newcomer: string, ctx?: AutoLayoutContext): Map<string, AutoSlot> {
  const rules = ctx?.rules;
  const participants = items.filter(([, sprite]) => sprite.at !== AUTO_POSITION || sprite.autoLayout === true);
  const others = participants.filter(([who]) => who !== newcomer);
  const kept = keptCount(others, rules);
  if (kept !== null && participants.length <= kept) {
    const used = new Set<number>();
    for (const [, s] of others) used.add(s.autoLayout ? s.autoSlot!.index : occupiedIndex(s.at, kept, rules));
    const free = Array.from({ length: kept }, (_, i) => i).filter((i) => !used.has(i));
    if (free.length > 0) {
      const side = ctx?.side?.(newcomer);
      const enter = rules?.enter ?? "end";
      const pick = side === "left" || (!side && enter === "start")
        ? free[0]!
        : side === "right" || enter === "end"
          ? free[free.length - 1]!
          : free.reduce((best, i) => (Math.abs(i - (kept - 1) / 2) < Math.abs(best - (kept - 1) / 2) ? i : best));
      const out = new Map<string, AutoSlot>(others.filter(([, s]) => s.autoLayout).map(([who, s]) => [who, { ...s.autoSlot! }]));
      out.set(newcomer, { index: pick, count: kept });
      return out;
    }
  }
  const managed = others.filter(([, s]) => s.autoLayout === true);
  const order = orderManaged(managed, undefined);
  const enter = rules?.enter ?? "end";
  if (enter === "start") order.unshift(newcomer);
  else if (enter === "middle") order.splice(Math.ceil(order.length / 2), 0, newcomer);
  else order.push(newcomer);
  const count = participants.length;
  const used = new Set(others.filter(([, s]) => !s.autoLayout).map(([, s]) => occupiedIndex(s.at, count, rules)));
  return fill(bySide(order, ctx?.side), count, used);
}

/**
 * liminalia.json の autoLayout の誤り（bad-auto-layout）。形の誤り（人数と位置の数が合わない、知らない enter・exit、byCount のキーが人数でない・名前が空）と、
 * どの立ち絵の枠にも無い立ち位置の名前（枠の位置が無いと中央に重なる。byCount の書いた側の名前は、at= に書けないので読み替えが効かない）を知らせる。
 */
export function checkAutoLayout(raw: unknown, cast: Readonly<Record<string, unknown>>): Diagnostic[] {
  if (raw === undefined) return [];
  const out: Diagnostic[] = [];
  const error = (message: string, hint?: string) => out.push({ severity: "error", code: "bad-auto-layout", message, file: "liminalia.json", line: 1, ...(hint ? { hint } : {}) });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    error("autoLayout は { positions, enter, exit, byCount } の形で書きます", '"autoLayout": { "positions": { "2": ["left", "right"] }, "enter": "end", "exit": "reflow" }');
    return out;
  }
  const r = raw as Record<string, unknown>;
  const names = framePositionNames(cast);
  checkByCount(r.byCount, names, error);
  if (r.enter !== undefined && !["end", "start", "middle"].includes(r.enter as string)) error(`autoLayout の enter は end、start、middle のどれかで書きます（${JSON.stringify(r.enter)}）`);
  if (r.exit !== undefined && !["reflow", "keep"].includes(r.exit as string)) error(`autoLayout の exit は reflow か keep で書きます（${JSON.stringify(r.exit)}）`);
  if (r.positions === undefined) return out;
  if (!r.positions || typeof r.positions !== "object" || Array.isArray(r.positions)) {
    error("autoLayout の positions は、人数から立ち位置の並びへの辞書で書きます", '"positions": { "2": ["left", "right"] }');
    return out;
  }
  for (const [count, list] of Object.entries(r.positions)) {
    if (!/^[1-9]\d*$/.test(count)) {
      error(`autoLayout の positions のキー ${count} は人数（1 からの整数）で書きます`);
      continue;
    }
    if (!Array.isArray(list) || list.some((p) => typeof p !== "string" || p === "")) {
      error(`autoLayout の positions の ${count} 人は、立ち位置の名前か "30%" の並びで書きます`);
      continue;
    }
    if (list.length !== Number(count)) {
      error(`autoLayout の positions の ${count} 人に、立ち位置が ${list.length} 個あります（人数と同じ数を書きます）`);
      continue;
    }
    for (const p of list as string[]) {
      const percent = layoutPercent(p);
      if (percent !== null ? percent > 1 : !names.has(p)) {
        error(
          percent !== null ? `autoLayout の positions の ${count} 人の ${p} は 0% から 100% で書きます` : `autoLayout の positions の ${count} 人の立ち位置 ${p} は、どの立ち絵の枠の positions にもありません`,
          percent !== null ? undefined : `cast.json の差分の frame.positions に ${p} を足すか、"30%" のように画面の幅の割合で書きます`,
        );
      }
    }
  }
  return out;
}

/** 立ち絵の枠に書いてある立ち位置の名前（left・center・right と、差分の frame.positions の名前）。 */
function framePositionNames(cast: Readonly<Record<string, unknown>>): Set<string> {
  const names = new Set<string>(FRAME_POSITIONS);
  for (const entry of Object.values(cast)) {
    const appearances = (entry as { appearances?: Record<string, { variants?: Record<string, { frame?: { positions?: Record<string, unknown> } }> }> } | null)?.appearances;
    for (const appearance of Object.values(appearances ?? {})) {
      for (const variant of Object.values(appearance?.variants ?? {})) for (const name of Object.keys(variant?.frame?.positions ?? {})) names.add(name);
    }
  }
  return names;
}

/** autoLayout の byCount の誤り（人数でないキー、辞書でない値、空の名前、どの立ち絵の枠にも無い読み替え先）。 */
function checkByCount(raw: unknown, names: ReadonlySet<string>, error: (message: string, hint?: string) => void): void {
  if (raw === undefined) return;
  const example = '"byCount": { "3": { "left": "left-wide", "right": "right-wide" } }';
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    error("autoLayout の byCount は、人数から { 書いた立ち位置: 置く立ち位置 } への辞書で書きます", example);
    return;
  }
  for (const [count, map] of Object.entries(raw)) {
    if (!/^[1-9]\d*$/.test(count)) {
      error(`autoLayout の byCount のキー ${count} は人数（1 からの整数）で書きます`, example);
      continue;
    }
    if (!map || typeof map !== "object" || Array.isArray(map)) {
      error(`autoLayout の byCount の ${count} 人は、{ 書いた立ち位置: 置く立ち位置 } の辞書で書きます`, example);
      continue;
    }
    for (const [from, to] of Object.entries(map)) {
      if (from === "") {
        error(`autoLayout の byCount の ${count} 人に空の名前があります（立ち位置の名前から立ち位置の名前へ書きます）`, example);
        continue;
      }
      if (typeof to !== "string" || to === "") {
        error(`autoLayout の byCount の ${count} 人の ${from} は、立ち位置の名前から立ち位置の名前へ書きます`, example);
        continue;
      }
      // 書いた側は台本の at= に書ける名前（どの枠にも無い名前は at= に書けないので、読み替えは一度も効かない）
      if (!names.has(from)) error(`autoLayout の byCount の ${count} 人の書いた立ち位置 ${from} は、どの立ち絵の枠の positions にもありません（この読み替えは効きません）`, `台本の at= に書く立ち位置の名前（${[...names].join(" / ")}）で書きます`);
      if (!names.has(to)) error(`autoLayout の byCount の ${count} 人の読み替え先 ${to} は、どの立ち絵の枠の positions にもありません`, `cast.json の差分の frame.positions に ${to} を足します`);
    }
  }
}
