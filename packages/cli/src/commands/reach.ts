import { buildStoryMap, endingKinds, endingLabel, endingMatches, endingSitesIn, parse, parseExpr, parseTargetText, variablePaths, type EndingSite, type Script, type Statement, type StoryMap, type TargetHook } from "@liminalia/lang";
import { listScenarioFiles, loadScenarioSource, projectDataReader, readScenarioFile } from "@liminalia/project";
import { capture, display, walk, type ChoiceMade, type Reached, type Value } from "@liminalia/runtime";
import { routeGuide, Sweeper } from "@liminalia/studio/sweep";
import { loadContext, runtimeOptionsOf, type Context } from "../context.ts";
import { overlayForPack, overlayPacks, type Overlay, type OverlayPack } from "../pack-overlay.ts";

/** 届く道の手がかり: その行に入る条件と、条件の変数を決める行。 */
export interface ReachHints {
  /** その行を囲む @if・@elif の条件と、その場面へ移る矢印の条件（file・line は条件を書いた行）。 */
  conditions: { text: string; file: string; line: number }[];
  /** 条件の変数（game.・system.）を、条件に合いそうな値に決める行。 */
  setters: { path: string; file: string; line: number }[];
}

/** lim reach の結果。 */
export interface ReachResult {
  /** 探した場所（コメントか空行を渡したときは、代わりに探した次の文の行）。 */
  target: string;
  /** 渡した場所（コメントか空行で、target と違うときだけ）。 */
  requested?: string;
  file: string;
  line: number;
  found: boolean;
  /** 見つからなかったわけ（unreachable: 探し尽くしても届かない、timeout: 時間内に見つからない）。 */
  reason?: "unreachable" | "timeout" | "cancelled";
  /** 届くまでに選んだ選択肢（picked は 0 始まり）。 */
  choices: { file: string; line: number; picked: number; count: number; text: string }[];
  /** 届いた時点の、条件に出てくる変数の値と、その値を決めた行。 */
  variables: { path: string; value: Value; file?: string; line?: number }[];
  hints: ReachHints;
  /** エンディングで探したとき（--ending と --endings）。query は書いたもの、kind と title は届いた（届かなければ最初に当たった）結末。 */
  ending?: { query: string; kind: string; title?: string };
  /** パックの台本の場所を探したとき、そのパック（packs/<フォルダ>）。ファイルの位置は packs/<フォルダ>/scenario/<台本> で、lim test はパックを流さないのでテストの書き方は出さない。 */
  pack?: string;
}

/** 作品の台本（読めたもの）と分岐の地図。overlay があれば、本体にパックを重ねた台本（流すときもパックの台本を読む）。 */
export interface ProjectScripts {
  scripts: Map<string, Script>;
  texts: Map<string, string>;
  map: StoryMap;
  overlay?: Overlay;
}

/**
 * パックの台本の場所を探すときの台本と地図。本体にすべてのパックを重ね、そのパックを一番後ろにする（そのパックの台本が勝つ。
 * パックの台本はほかのパックの台本へ飛ぶこともあり、書き出しはパックをすべて入れる）。
 */
export function packProjectScripts(ctx: Context, pack: OverlayPack): ProjectScripts {
  const overlay = overlayForPack(ctx, overlayPacks(ctx), pack);
  return { ...readProjectScripts(ctx, overlay.read(listScenarioFiles(ctx.project.paths.scenario).map((f) => f.name)), overlay.data), overlay };
}

/** 流した結果の台本の名前を、出力の位置（パックの台本は packs/<フォルダ>/scenario/<台本>）に直す。 */
function placed(r: ReachResult, overlay: Overlay, pack: OverlayPack): ReachResult {
  const at = <T extends { file: string }>(x: T): T => ({ ...x, file: overlay.place(x.file) });
  return {
    ...r,
    file: overlay.place(r.file),
    choices: r.choices.map(at),
    variables: r.variables.map((v) => (v.file ? { ...v, file: overlay.place(v.file) } : v)),
    hints: { conditions: r.hints.conditions.map(at), setters: r.hints.setters.map(at) },
    pack: pack.dir,
  };
}

/** パックの台本の位置（packs/<フォルダ>/scenario/…）なら、そのパックと、パックの scenario からの書き方。 */
function packPlace(packs: readonly OverlayPack[], place: string): { pack: OverlayPack; rest: string } | null {
  for (const pack of packs) if (place.startsWith(`${pack.dir}/scenario/`)) return { pack, rest: place.slice(`${pack.dir}/scenario/`.length) };
  return null;
}

/** 作品の台本を読んで地図を作る。read があればそれを使う（lim coverage が読んだもの）。data は作品のデータ（省けば本体のデータ。パックを重ねるときはパックのデータも重ねたもの）。 */
export function readProjectScripts(ctx: Context, read?: ReadonlyMap<string, { script: Script; text: string }>, data: (name: string) => unknown = projectDataReader(ctx.project)): ProjectScripts {
  const scripts = new Map<string, Script>();
  const texts = new Map<string, string>();
  if (read) {
    for (const [name, { script, text }] of read) {
      scripts.set(name, script);
      texts.set(name, text);
    }
  } else {
    for (const { name, path } of listScenarioFiles(ctx.project.paths.scenario)) {
      const { text, encoding } = readScenarioFile(path);
      if (encoding) continue;
      texts.set(name, text);
      scripts.set(name, parse(text, name, { speakers: ctx.cast.speakers }));
    }
  }
  const hooks = new Map<string, TargetHook>();
  for (const c of ctx.combined.commands) if (c.targets) hooks.set(c.name, c.targets.bind(c));
  const map = buildStoryMap({
    scripts: new Map([...scripts].map(([f, s]) => [f, { script: s, text: texts.get(f)! }])),
    registry: ctx.registry,
    entry: ctx.project.config.entry,
    hooks,
    data,
    ...(ctx.project.config.variables ? { variables: ctx.project.config.variables } : {}),
    ...(ctx.project.config.endingKinds ? { endingKinds: ctx.project.config.endingKinds } : {}),
  });
  return { scripts, texts, map };
}

/**
 * lim reach の場所。ファイルと行（コメントか空行を渡したら、次の文の行にして from に元の行）か、探さずに止めるわけ
 * （missing: ファイルかラベルが無い、outside: 行の範囲の外、after-last: その行より後に文が無い）。
 */
export type ReachPlace =
  | { file: string; line: number; from?: number }
  | { problem: "missing" }
  | { problem: "outside"; file: string; lines: number }
  | { problem: "after-last"; file: string; line: number };

/** 文の行（実行するときに通る行。@if の中と @define の中も。選択肢の行、@elif、@else、@end は入れない）。 */
function statementLines(body: readonly Statement[], out = new Set<number>()): Set<number> {
  for (const s of body) {
    if (s.kind === "use" || s.kind === "function") continue;
    if (s.kind === "define") {
      statementLines(s.body, out);
      continue;
    }
    out.add(s.line);
    if (s.kind === "if") for (const b of s.branches) statementLines(b.body, out);
  }
  return out;
}

/**
 * 場所を確かめる（探す前に。無い行やコメントの行で、探す時間の上限まで待たないように）。`ファイル:行` は、範囲の外なら outside、
 * コメントか空行なら次の文の行（無ければ after-last）。`ファイル#ラベル` と `ファイル` は resolvePlace と同じ。
 */
export function reachPlace(place: string, p: Pick<ProjectScripts, "scripts" | "texts">): ReachPlace {
  const at = /^(.+):(-?\d+)$/.exec(place);
  if (!at) return resolvePlace(place, p.scripts) ?? { problem: "missing" };
  const file = at[1]!;
  const line = Number(at[2]);
  const script = p.scripts.get(file);
  const text = p.texts.get(file);
  if (!script || text === undefined) return { problem: "missing" };
  const rows = text.split("\n");
  const lines = text.endsWith("\n") ? rows.length - 1 : rows.length;
  if (line < 1 || line > lines) return { problem: "outside", file, lines };
  const row = rows[line - 1]!.trim();
  if (row !== "" && !row.startsWith("//")) return { file, line };
  const next = [...statementLines(script.body)].filter((l) => l > line).sort((a, b) => a - b)[0];
  return next === undefined ? { problem: "after-last", file, line } : { file, line: next, from: line };
}

/** `ファイル#ラベル`・`ファイル:行`・`ファイル` を、ファイルと行にする（ファイルだけなら最初の文の行）。無ければ null。 */
export function resolvePlace(place: string, scripts: ReadonlyMap<string, Script>): { file: string; line: number } | null {
  const at = /^(.+):(\d+)$/.exec(place);
  if (at) return scripts.has(at[1]!) ? { file: at[1]!, line: Number(at[2]) } : null;
  const t = parseTargetText(place.trim());
  if (!t?.file || !scripts.has(t.file)) return null;
  const body = scripts.get(t.file)!.body;
  if (t.label === null) {
    const first = body.find((s) => s.kind !== "use" && s.kind !== "define" && s.kind !== "function");
    return { file: t.file, line: first?.line ?? 1 };
  }
  const label = body.find((s) => s.kind === "label" && s.name === t.label);
  return label ? { file: t.file, line: label.line } : null;
}

/** その行に入る条件と、条件の変数を決める行（静的に。条件は書いたままの字面）。 */
export function reachHints(p: ProjectScripts, file: string, line: number): ReachHints {
  const conditions: ReachHints["conditions"] = [];
  const rows = p.texts.get(file)?.split("\n") ?? [];
  const textAt = (l: number) => (rows[l - 1] ?? "").trim();
  // その行を囲む @if・@elif（@else は前の条件がすべて偽のとき。行の if=(式) はその行の条件）
  const enclosing = (body: readonly Statement[]) => {
    for (const st of body) {
      if (st.kind !== "if" || st.with) continue;
      for (const b of st.branches) {
        const lines = b.body.flatMap(lineSpan);
        if (lines.length === 0 || line < Math.min(...lines) || line > Math.max(...lines)) continue;
        if (st.guard !== undefined) conditions.push({ text: st.guard, file, line: b.line });
        else if (st.each) conditions.push({ text: textAt(b.line).replace(/^@for\s+/, "@for "), file, line: b.line });
        else if (b.condition) conditions.push({ text: textAt(b.line).replace(/^@(if|elif|while)\s+/, ""), file, line: b.line });
        else conditions.push({ text: "@else", file, line: b.line });
        enclosing(b.body);
        return;
      }
    }
  };
  enclosing(p.scripts.get(file)?.body ?? []);
  // その場面へ移る矢印の条件
  const node = [...p.map.nodes].filter((n) => n.file === file && n.line <= line).sort((a, b) => b.line - a.line)[0];
  for (const e of p.map.edges) {
    if (e.to !== node?.id || !e.cond || e.cond === "else") continue;
    const from = p.map.nodes.find((n) => n.id === e.from);
    conditions.push({ text: e.cond, file: from?.file ?? file, line: e.line });
  }
  // 条件の変数を決める行。道筋の探索の中継点（条件に合う値を入れる行）を先に、ほかの @set を後に
  const wanted = new Set<string>();
  for (const c of conditions) {
    try {
      for (const v of variablePaths(parseExpr(c.text))) if (v.startsWith("game.") || v.startsWith("system.")) wanted.add(v);
    } catch {
      // 読めない条件（@else、@for の行）は見ない
    }
  }
  const guide = routeGuide(p.map, p.scripts, file, line);
  const first = new Set(guide.waypoints.map((w) => `${w.file}:${w.line}`));
  const setters: ReachHints["setters"] = [];
  const visit = (f: string, body: readonly Statement[]) => {
    for (const st of body) {
      if (st.kind === "set") {
        const path = variablePaths(st.target)[0];
        if (path && wanted.has(path)) setters.push({ path, file: f, line: st.line });
      } else if (st.kind === "if") for (const b of st.branches) visit(f, b.body);
      else if (st.kind === "define") visit(f, st.body);
    }
  };
  for (const [f, script] of p.scripts) visit(f, script.body);
  setters.sort((a, b) => Number(!first.has(`${a.file}:${a.line}`)) - Number(!first.has(`${b.file}:${b.line}`)));
  return { conditions, setters };
}

/** 文とその中の行。 */
function lineSpan(s: Statement): number[] {
  if (s.kind === "if") return [s.line, ...s.branches.flatMap((b) => [b.line, ...b.body.flatMap(lineSpan)])];
  if (s.kind === "choice") return [s.line, ...s.options.map((o) => o.line)];
  return [s.line];
}

/** 着いた時点の、条件に出てくる変数の値と、それを決めた行。 */
function variablesAt(at: Reached, hints: ReachHints): ReachResult["variables"] {
  const paths = new Set<string>();
  for (const c of hints.conditions) {
    try {
      for (const p of variablePaths(parseExpr(c.text))) if (p.startsWith("game.") || p.startsWith("system.") || p.startsWith("temp.")) paths.add(p);
    } catch {
      // 読めない条件（@else など）は変数を見ない
    }
  }
  for (const s of hints.setters) if (s.path) paths.add(s.path);
  return [...paths].sort().map((path) => {
    const [scope, name] = path.split(".") as [string, string];
    const root = scope === "game" ? at.save.game : scope === "system" ? at.system : at.temp;
    const origin = at.assigned[path];
    return { path, value: (root as Record<string, Value>)[name] ?? null, ...(origin ? { file: origin.file, line: origin.line } : {}) };
  });
}

/** 一回の流しの命令数の上限（制作画面の届かない行の探索と同じ）。 */
const MAX_STEPS = 500_000;
/** 見つけた選び方を縮める時間の上限（ミリ秒）。 */
const SHRINK_BUDGET_MS = 10_000;

/** テストの choose と同じ選び方（文で選ぶ。文の無い画像のボタンは番号）。 */
const pickOf = (c: Pick<ChoiceMade, "text" | "picked">): string | number => (c.text === "" ? c.picked : c.text);

/**
 * 「はじめから」、picks を順に選んで流し（lim test の choose と同じく、同じ文か、その文を含む選択肢）、その行に着いた時点を返す。
 * 選ぶものが無くなるか、選ぶ文の選択肢が無ければそこで止める（着かなければ null）。
 */
async function replay(ctx: Context, p: Pick<ProjectScripts, "overlay">, place: { file: string; line: number }, picks: readonly (string | number)[]): Promise<Reached | null> {
  const scenario = ctx.project.paths.scenario;
  let hit: Reached | null = null;
  let next = 0;
  let index = 0;
  await walk({
    loadSource: p.overlay?.loadSource ?? (async (file) => loadScenarioSource(scenario, file)),
    runtime: { ...(p.overlay?.runtime ?? runtimeOptionsOf(ctx)), onError: "continue", maxSteps: MAX_STEPS },
    start: ctx.project.config.entry,
    choice: (_at, options) => {
      const want = picks[next++];
      if (want === undefined) return true;
      index = typeof want === "number" ? want : options.indexOf(want) >= 0 ? options.indexOf(want) : options.findIndex((o) => o.includes(want));
      return index < 0 || index >= options.length;
    },
    pick: () => index,
    step: (at, w) => {
      // @define の中は除く（制作画面の届かない行の探索と同じ）
      if (hit || at.file !== place.file || at.line !== place.line || w.runtime.state.position.unit.includes("::")) return;
      hit = capture(w, at);
      w.runtime.stop();
    },
  });
  return hit;
}

/**
 * 見つけた選び方を縮める（探索は戻ってくる選択肢で回り道を選ぶことがあるので、一つずつ抜いて、まだ着くなら抜いたままにする。
 * 抜けるものが無くなるまで）。流し直して着かなければ（乱数で決まる分岐など）null で、見つけたものを使う。
 */
async function shorterRoute(ctx: Context, p: Pick<ProjectScripts, "overlay">, place: { file: string; line: number }, found: readonly ChoiceMade[], budgetMs: number): Promise<Reached | null> {
  const deadline = Date.now() + Math.min(budgetMs, SHRINK_BUDGET_MS);
  let best = await replay(ctx, p, place, found.map(pickOf));
  if (!best) return null;
  let picks = best.choices.map(pickOf);
  for (let changed = true; changed && Date.now() < deadline; ) {
    changed = false;
    for (let i = 0; i < picks.length && Date.now() < deadline; ) {
      const r = await replay(ctx, p, place, [...picks.slice(0, i), ...picks.slice(i + 1)]);
      if (r) {
        best = r;
        picks = r.choices.map(pickOf);
        changed = true;
      } else i++;
    }
  }
  return best;
}

/** その場所へ届く道を探す（lim reach と lim coverage の手がかり）。budgetMs は探す時間の上限。場所が無いか、行の範囲の外なら null。 */
export async function findReach(ctx: Context, p: ProjectScripts, target: string, budgetMs: number): Promise<ReachResult | null> {
  const where = reachPlace(target, p);
  if ("problem" in where) return null;
  // コメントか空行を渡したら、次の文の行を探す（テストの書き方もその行で書く）
  const place = { file: where.file, line: where.line };
  const name = where.from !== undefined ? `${place.file}:${place.line}` : target;
  const sweeper = new Sweeper({
    loadSource: p.overlay?.loadSource ?? (async (file) => loadScenarioSource(ctx.project.paths.scenario, file)),
    runtime: p.overlay?.runtime ?? runtimeOptionsOf(ctx),
    entry: ctx.project.config.entry,
  });
  const hints = reachHints(p, place.file, place.line);
  const requested = where.from !== undefined ? { requested: target } : {};
  const r = await sweeper.entryReaching(place.file, place.line, routeGuide(p.map, p.scripts, place.file, place.line), undefined, budgetMs);
  if (!r.entry) return { target: name, ...requested, ...place, found: false, reason: r.reason, choices: [], variables: [], hints };
  const found = r.at ?? r.entry;
  const at = (await shorterRoute(ctx, p, place, found.choices, budgetMs)) ?? found;
  return {
    target: name,
    ...requested,
    ...place,
    found: true,
    choices: at.choices.map((c) => ({ file: c.file, line: c.line, picked: c.picked, count: c.count, text: c.text })),
    variables: variablesAt(at, hints),
    hints,
  };
}

/** 作品のエンディング（プレイを終える命令の ending= と title= を書いた行。ファイルの順、行の順）。 */
export function endingSites(ctx: Context, p: Pick<ProjectScripts, "scripts">): EndingSite[] {
  const kinds = endingKinds(ctx.project.config.endingKinds);
  return [...p.scripts].flatMap(([file, script]) => endingSitesIn(file, script, ctx.registry, kinds));
}

/**
 * 作品のエンディングと、それを探す台本（本体のエンディングは本体の台本、パックの台本のエンディングは本体にすべてのパックを重ね、そのパックを一番後ろにした台本。
 * パックは遊ぶ側の並び）。lim reach --ending と --endings が使う。
 */
function allEndingSites(ctx: Context, p: ProjectScripts): { site: EndingSite; p: ProjectScripts; pack?: OverlayPack }[] {
  const out: { site: EndingSite; p: ProjectScripts; pack?: OverlayPack }[] = endingSites(ctx, p).map((site) => ({ site, p }));
  for (const pack of overlayPacks(ctx)) {
    const q = packProjectScripts(ctx, pack);
    for (const site of endingSites(ctx, q)) if (q.overlay!.owner(site.file) === pack) out.push({ site, p: q, pack });
  }
  return out;
}

/** 探した結果（パックの台本なら出力の位置に直す）。 */
async function reachAt(ctx: Context, x: { site: EndingSite; p: ProjectScripts; pack?: OverlayPack }, budgetMs: number): Promise<ReachResult | null> {
  const r = await findReach(ctx, x.p, `${x.site.file}:${x.site.line}`, budgetMs);
  return r && x.pack ? placed(r, x.p.overlay!, x.pack) : r;
}

/**
 * エンディングの種類か名前（query。lim test の expect ending と同じ引き方）に当たる結末へ届く道を探す。当たる行を順に探し、
 * 最初に届いたものを返す（どれにも届かなければ最初の行の結果）。当たるエンディングが無ければ null。パックの台本の結末も探す。
 */
export async function findEndingReach(ctx: Context, p: ProjectScripts, query: string, budgetMs: number): Promise<ReachResult | null> {
  const kinds = endingKinds(ctx.project.config.endingKinds);
  const sites = allEndingSites(ctx, p).filter((x) => endingMatches(x.site.ref, query, kinds));
  if (sites.length === 0) return null;
  const deadline = Date.now() + budgetMs;
  let first: ReachResult | null = null;
  for (const x of sites) {
    const s = x.site;
    const left = Math.max(1000, deadline - Date.now());
    const r = await reachAt(ctx, x, left);
    if (!r) continue;
    const named = { ...r, ending: { query, kind: s.ref.kind, ...(s.ref.title ? { title: s.ref.title } : {}) } };
    if (r.found) return named;
    first ??= named;
    if (Date.now() >= deadline) break;
  }
  return first;
}

/** 届く選び方を、そのまま tests/*.limtest に書ける形にする（見出しの言語は language）。エンディングで探したものは expect ending で書く。 */
export function reachTestText(r: ReachResult, language: "ja" | "en" = "ja"): string {
  // 文で選ぶ（数だけの文は "…" で囲む。文の無い画像のボタンは上からの番号）
  const pick = (c: ReachResult["choices"][number]) => (c.text === "" ? String(c.picked + 1) : /^\d+$/.test(c.text) ? JSON.stringify(c.text) : c.text);
  const name = r.ending ? endingLabel(r.ending) : r.target;
  const head = language === "en" ? `# Reaches ${r.ending ? `the ending ${name}` : name}` : `# ${r.ending ? `エンディング ${name}` : name} へ届く`;
  const expect = r.ending ? `expect ending ${r.ending.query}` : `expect reach ${r.target}`;
  return [head, ...r.choices.map((c) => `choose ${pick(c)}`), expect].join("\n");
}

/**
 * lim reach [プロジェクト] <ファイル#ラベル|ファイル:行|ファイル|--ending 種類か名前|--endings> [--timeout 秒] [--json] [--lang en]
 * --ending は、エンディングの種類（bad など）か名前（title= の一部。lim test の expect ending と同じ引き方）で探し、テストの書き方は expect ending で書く。
 * --endings は、すべてのエンディングについて届くかを並べる（すべて届けば 0）。
 * はじめから（liminalia.json の entry）その場所へ届く選び方を探し（制作画面の届かない行の探索と同じ、@liminalia/studio の Sweeper と routeGuide）、
 * 選ぶ選択肢、届いた時点の条件の変数、テストの書き方を出す。届かなければ、入る条件と条件の変数を決める行を手がかりに出す。
 * 見つけた選び方は、到達に要らない選択を除いてから出す。行の範囲の外と、後ろに文の無い行は探さずに止め（終了の値 2）、
 * コメントと空行は次の文の行で探す。終了の値（0: 届く、1: 見つからない、2: 場所の書き方の誤り）を返す。
 * パックの台本の場所（packs/<フォルダ>/scenario/<台本>:<行> など）は、本体にすべてのパックを重ね、そのパックを一番後ろにした「はじめから」から探す（lim test はパックを流さないので、
 * テストの書き方は出さない）。--ending と --endings は、パックの台本の結末も探す。
 */
export async function runReach(
  dir: string,
  target: string,
  o: { timeoutSeconds?: number; json?: boolean; language?: "ja" | "en"; ending?: string; endings?: boolean } = {},
): Promise<0 | 1 | 2> {
  const ctx = await loadContext(dir);
  const p = readProjectScripts(ctx);
  const en = o.language === "en";
  const fail = (message: string, code: 1 | 2) => {
    if (o.json) console.log(JSON.stringify({ ok: false, target: o.ending ?? target, error: message }, null, 2));
    else console.error(`lim reach: ${message}`);
    return code;
  };
  const budgetMs = Math.max(1, o.timeoutSeconds ?? 30) * 1000;
  if (o.endings) return await reachEndings(ctx, p, budgetMs, o);
  if (o.ending !== undefined) {
    const r = await findEndingReach(ctx, p, o.ending, budgetMs);
    if (!r) return fail(en ? `No ending matches ${o.ending} (write a kind such as bad, or part of a title=)` : `${o.ending} に当たるエンディングがありません（bad などの種類か、title= の名前の一部を書きます）`, 2);
    return printReach(r, o);
  }
  // パックの台本の場所（packs/<フォルダ>/scenario/…）は、本体にすべてのパックを重ね、そのパックを一番後ろにした台本で探す
  const inPack = packPlace(overlayPacks(ctx), target);
  const q = inPack ? packProjectScripts(ctx, inPack.pack) : p;
  const sought = inPack ? inPack.rest : target;
  const placeOf = (file: string) => q.overlay?.place(file) ?? file;
  // 探す前に場所を確かめる（無い行やコメントの行で、探す時間の上限まで待たない）
  const where = reachPlace(sought, q);
  const missing = () => fail(en ? `${target} doesn't exist (write file#label, file:line or file)` : `${target} がありません（ファイル#ラベル、ファイル:行、ファイルのどれかで書きます）`, 1);
  // パックの位置で、そのパックに無い台本（本体の台本）を書いたもの
  if (inPack && !("problem" in where && where.problem === "missing") && q.overlay!.owner((where as { file: string }).file) !== inPack.pack) return missing();
  if ("problem" in where && where.problem === "outside") {
    return fail(en ? `${target} is outside the lines of ${placeOf(where.file)}.lim (1 to ${where.lines})` : `${target} は ${placeOf(where.file)}.lim の行の範囲（1〜${where.lines} 行）の外です`, 2);
  }
  if ("problem" in where && where.problem === "after-last") {
    return fail(en ? `${target} is a comment or blank line with no statement after it in ${placeOf(where.file)}.lim` : `${target} はコメントか空行で、${placeOf(where.file)}.lim のその行より後に文がありません`, 2);
  }
  if (!("problem" in where) && where.from !== undefined && !o.json) {
    const next = `${placeOf(where.file)}:${where.line}`;
    console.log(en ? `${target} is a comment or blank line, so searching from the next statement line, ${next}` : `${target} はコメントか空行なので、次の文の行 ${next} で探します`);
  }
  const found = await findReach(ctx, q, sought, budgetMs);
  if (!found) return missing();
  // パックの台本の結果は、書いた場所（と次の文の行）も出力の位置で
  const r = inPack ? placed({ ...found, target: found.target === sought ? target : `${placeOf(found.file)}:${found.line}`, ...(found.requested !== undefined ? { requested: target } : {}) }, q.overlay!, inPack.pack) : found;
  return printReach(r, o);
}

/** lim reach の一つの結果を出す（終了の値 0: 届く、1: 見つからない）。 */
function printReach(r: ReachResult, o: { timeoutSeconds?: number; json?: boolean; language?: "ja" | "en" }): 0 | 1 {
  const en = o.language === "en";
  // lim test はパックを流さないので、パックの台本の結果にはテストの書き方を出さない
  const test = r.found && !r.pack;
  if (o.json) {
    console.log(JSON.stringify({ ok: r.found, ...r, ...(test ? { test: reachTestText(r, en ? "en" : "ja") } : {}) }, null, 2));
    return r.found ? 0 : 1;
  }
  const at = `${r.file}.lim:${r.line}`;
  const name = r.ending ? (en ? `the ending ${endingLabel(r.ending)}` : `エンディング ${endingLabel(r.ending)}`) : r.target;
  if (r.found) {
    console.log(en ? `Choices that reach ${name} (${at}) from the start:` : `はじめから ${name}（${at}）へ届く選び方:`);
    if (r.choices.length === 0) console.log(en ? "  (no choices; it's reached by going straight)" : "  （選択肢なし。そのまま進めば届きます）");
    r.choices.forEach((c, i) => console.log(`  ${i + 1}. ${c.file}.lim:${c.line}  ${c.text !== "" ? (en ? `"${c.text}"` : `「${c.text}」`) : ""}${en ? ` (option ${c.picked + 1} of ${c.count})` : `（${c.count} 個のうち ${c.picked + 1} 番目）`}`));
    if (r.variables.length > 0) {
      console.log(en ? "\nVariables when it gets there:" : "\n届いた時点の変数:");
      for (const v of r.variables) console.log(`  ${v.path} = ${typeof v.value === "string" ? JSON.stringify(v.value) : display(v.value) || "null"}${v.file ? (en ? ` (set at ${v.file}.lim:${v.line})` : `（${v.file}.lim:${v.line} で決めた）`) : ""}`);
    }
  } else {
    console.log(en ? `No way to reach ${name} (${at}) was found${r.reason === "timeout" ? ` within ${o.timeoutSeconds ?? 30} seconds (raise --timeout)` : " (no choice reaches it)"}` : `${name}（${at}）へ届く選び方は見つかりませんでした${r.reason === "timeout" ? `（${o.timeoutSeconds ?? 30} 秒で探し終わりませんでした。--timeout で延ばせます）` : "（どの選び方でも届きません）"}`);
  }
  if (r.hints.conditions.length > 0) {
    console.log(en ? "\nConditions to get in:" : "\n入る条件:");
    for (const c of r.hints.conditions) console.log(`  ${c.text}  (${c.file}.lim:${c.line})`);
  }
  if (!r.found && r.hints.setters.length > 0) {
    console.log(en ? "\nLines that set the variables in the conditions:" : "\n条件の変数を決める行:");
    for (const s of r.hints.setters) console.log(`  ${s.path ? `${s.path}  ` : ""}${s.file}.lim:${s.line}`);
  }
  if (test) console.log(`\n${en ? "As a test (tests/*.limtest):" : "テストにするなら（tests/*.limtest）:"}\n${reachTestText(r, en ? "en" : "ja").split("\n").map((l) => `  ${l}`).join("\n")}`);
  return r.found ? 0 : 1;
}

/**
 * lim reach --endings: 作品のすべてのエンディング（ending= と title= を書いた行）について、はじめから届くかを探して並べる。
 * 届くものはテストの書き方（expect ending。名前があれば名前で引く）、届かないものはわけと入る条件を出す。すべて届けば 0、一つでも届かなければ 1。
 */
async function reachEndings(ctx: Context, p: ProjectScripts, budgetMs: number, o: { timeoutSeconds?: number; json?: boolean; language?: "ja" | "en" }): Promise<0 | 1> {
  const en = o.language === "en";
  const results: ReachResult[] = [];
  for (const x of allEndingSites(ctx, p)) {
    const s = x.site;
    const r = await reachAt(ctx, x, budgetMs);
    if (r) results.push({ ...r, ending: { query: s.ref.title ?? s.ref.kind, kind: s.ref.kind, ...(s.ref.title ? { title: s.ref.title } : {}) } });
  }
  const ok = results.every((r) => r.found);
  if (o.json) {
    const endings = results.map((r) => ({
      kind: r.ending!.kind,
      ...(r.ending!.title ? { title: r.ending!.title } : {}),
      file: r.file,
      line: r.line,
      found: r.found,
      ...(r.reason ? { reason: r.reason } : {}),
      choices: r.choices,
      ...(r.pack ? { pack: r.pack } : {}),
      ...(r.found ? (r.pack ? {} : { test: reachTestText(r, en ? "en" : "ja") }) : { conditions: r.hints.conditions }),
    }));
    console.log(JSON.stringify({ ok, endings }, null, 2));
    return ok ? 0 : 1;
  }
  if (results.length === 0) {
    console.log(en ? "This project has no endings (an ending is a command that ends play, written with ending= or title=)" : "エンディングがありません（プレイを終える命令に ending= か title= を書いたものがエンディングです）");
    return 0;
  }
  for (const r of results) {
    const label = endingLabel(r.ending!);
    const at = `${r.file}.lim:${r.line}`;
    if (r.found) {
      const picks = r.choices.length === 0 ? (en ? "no choices" : "選択肢なし") : en ? `${r.choices.length} choice(s)` : `選択 ${r.choices.length} 回`;
      console.log(en ? `Reached: ${label} (${at}, ${picks})` : `届く: ${label}（${at}、${picks}）`);
    } else {
      const why = r.reason === "timeout" ? (en ? `not found within ${o.timeoutSeconds ?? 30} seconds` : `${o.timeoutSeconds ?? 30} 秒で見つからない`) : en ? "no choice reaches it" : "どの選び方でも届かない";
      console.log(en ? `Not reached: ${label} (${at}, ${why})` : `届かない: ${label}（${at}、${why}）`);
      for (const c of r.hints.conditions) console.log(`  ${c.text}  (${c.file}.lim:${c.line})`);
    }
  }
  const tests = results.filter((r) => r.found && !r.pack).map((r) => reachTestText(r, en ? "en" : "ja"));
  if (tests.length > 0) console.log(`\n${en ? "As tests (tests/*.limtest):" : "テストにするなら（tests/*.limtest）:"}\n${tests.join("\n\n").split("\n").map((l) => (l === "" ? "" : `  ${l}`)).join("\n")}`);
  return ok ? 0 : 1;
}
