import { buildStoryMap, CORE_COMMANDS, createRegistry, endingKinds, endingLabel, endingMatches, type EndingKinds, type EndingRef, type StoryMap, type TargetHook } from "@liminalia/lang";
import { loadCommandPlugins, projectDataReader, projectScripts, type Project } from "@liminalia/project";
import { combinePlugins } from "@liminalia/plugin-host";

/**
 * lim playtest と録画の選択肢の避け方（--avoid-ending）。台本から作る地図（buildStoryMap）で、選んだら避けるエンディングでしか終われない
 * シーンを割り出す。エンディングは、プレイを終えるコマンドの ending= の種類（`@title-screen ending=bad`）で引く
 * （@liminalia/lang の endingMatches。種類でない文字なら、エンディングの名前 title= に含むもの）。台本の原文で引くので、訳した作品でも同じ。
 * 条件分岐の先はどちらも通れるものとして数えるので、避けるのは「どう進んでも避けるエンディングになる」選択肢だけ。
 */

/**
 * --avoid-ending を値なしで書いたときに避けるもの。種類 bad と、名前（title=。前の書き方なら ending= の文言）に DEAD END、GAME OVER を
 * 含むエンディング。DEAD END や GAME OVER は種類の文言ではないので、lim migrate で移すと種類 other とその名前になり、種類 bad だけでは避けない。
 * 作品が足した種類（liminalia.json の endingKinds）は、その文言が DEAD END や GAME OVER なら種類で当たる。
 */
export const DEFAULT_AVOID_ENDINGS: readonly string[] = ["bad", "DEAD END", "GAME OVER", "デッドエンド", "ゲームオーバー"];

/** 知らせに並べるエンディングの数（ほかは数だけ）。 */
const NOTE_LIMIT = 6;

/** エンディングが、避けるもの（種類か、名前に含む文字）のどれかに当たるか。種類の無いエンディングは当たらない。 */
export function endingAvoided(ending: EndingRef | undefined, avoid: readonly string[], kinds?: EndingKinds): boolean {
  if (!ending) return false;
  return avoid.some((q) => endingMatches(ending, q, kinds));
}

/**
 * 避けるエンディングにしか到達しないシーン（ジャンプ先の書き方の "ファイル" か "ファイル#ラベル"）。実行器が選択肢の飛び先として描画側へ渡す
 * 書き方と同じにするため、頭に文の無いファイル（最初のラベルのシーンから始まる）はファイルの名前でも返す。
 * エンディングは、プレイを終えるコマンドで終わるシーン（種類が当たれば避けるもの）と、ファイルの終わりで止まるシーン（避けないもの）。
 * @stop で止まるシーンと、まだ無いファイルやラベルへ飛ぶシーン（書きかけの作品の先）も、避けない終わりとして数える（その先が避けるエンディングとは限らない）。
 */
export function endingTraps(map: StoryMap, avoid: readonly string[], kinds?: EndingKinds): string[] {
  if (avoid.length === 0) return [];
  const into = new Map<string, string[]>();
  for (const e of map.edges) {
    if (e.missing) continue;
    (into.get(e.to) ?? into.set(e.to, []).get(e.to)!).push(e.from);
  }
  /** そこから（矢印を逆にたどって）到達できるシーン。 */
  const back = (starts: string[]): Set<string> => {
    const seen = new Set<string>();
    const queue = [...starts];
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const from of into.get(id) ?? []) if (!seen.has(from)) queue.push(from);
    }
    return seen;
  };
  // @stop で止まるシーン（書きかけの作品の「続きは未定」など）も、避けない終わりとして数える
  const ends = map.nodes.filter((n) => n.ends === "exit" || n.ends === "end" || n.ends === "stop");
  const bad = back(ends.filter((n) => n.ends === "exit" && endingAvoided(n.ending, avoid, kinds)).map((n) => n.id));
  const open = map.edges.filter((e) => e.missing).map((e) => e.from);
  const good = back([...ends.filter((n) => !(n.ends === "exit" && endingAvoided(n.ending, avoid, kinds))).map((n) => n.id), ...open]);
  const traps = new Set([...bad].filter((id) => !good.has(id)));
  // 頭に文の無いファイルは、最初のラベルのシーン（ファイルの名前のジャンプはそこへ行く）
  const firstOf = new Map<string, { id: string; line: number }>();
  for (const n of map.nodes) {
    const first = firstOf.get(n.file);
    if (!first || n.line < first.line) firstOf.set(n.file, { id: n.id, line: n.line });
  }
  const ids = new Set(map.nodes.map((n) => n.id));
  for (const [file, first] of firstOf) if (!ids.has(file) && traps.has(first.id)) traps.add(file);
  return [...traps].sort();
}

/** 地図の、避けるもの（種類か、名前に含む文字）に当たるエンディングと、その場面（ファイル#ラベル）。 */
export function avoidedEndings(map: StoryMap, avoid: readonly string[], kinds?: EndingKinds): { at: string; ending: EndingRef }[] {
  if (avoid.length === 0) return [];
  return map.nodes.filter((n) => n.ends === "exit" && endingAvoided(n.ending, avoid, kinds)).map((n) => ({ at: n.id, ending: n.ending! }));
}

/**
 * 避けるもの（--avoid-ending と playtest.avoidEndings）を書いたときに、録画と lim playtest の始めに出す知らせ。当たるエンディングを並べ、
 * 一つも無ければそう言う（値なしの既定がどれを避けるかを、作者が確かめられるように）。avoid が空なら何も出さない。
 */
export function avoidEndingNotes(map: StoryMap, avoid: readonly string[], kinds?: EndingKinds): string[] {
  const list = avoid.filter((x) => x.trim() !== "");
  if (list.length === 0) return [];
  const hits = avoidedEndings(map, list, kinds);
  if (hits.length === 0) return [`避けるエンディングがありません（${list.join("、")} に当たるエンディングがありません）。種類（ending=）か名前（title=）を --avoid-ending に書きます`];
  const shown = hits
    .slice(0, NOTE_LIMIT)
    .map((h) => `${endingLabel(h.ending)}（${h.at}）`)
    .join("、");
  return [hits.length > NOTE_LIMIT ? `避けるエンディング: ${shown}、ほか ${hits.length - NOTE_LIMIT} か所` : `避けるエンディング: ${shown}`];
}

/** 作品の台本から作る地図（buildStoryMap）。作品のコマンドのプラグインが教えるジャンプ先も使う（lim shot --video の見込みも使う）。 */
export async function projectStoryMap(project: Project): Promise<StoryMap> {
  const plugins = combinePlugins(await loadCommandPlugins(project));
  const hooks = new Map<string, TargetHook>();
  for (const c of plugins.commands) if (c.targets) hooks.set(c.name, c.targets.bind(c));
  return buildStoryMap({
    scripts: projectScripts(project),
    registry: createRegistry(CORE_COMMANDS, plugins.specs),
    entry: project.config.entry,
    hooks,
    data: projectDataReader(project),
    ...(project.config.variables ? { variables: project.config.variables } : {}),
    ...(project.config.endingKinds ? { endingKinds: project.config.endingKinds } : {}),
  });
}

/** 作品の台本から、避けるエンディングにしか到達しないシーン（endingTraps）。作品のコマンドのプラグインが教えるジャンプ先も使う。 */
export async function projectEndingTraps(project: Project, avoid: readonly string[]): Promise<string[]> {
  if (avoid.length === 0) return [];
  return endingTraps(await projectStoryMap(project), avoid, endingKinds(project.config.endingKinds));
}
