import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { endingKinds, endingLabel, endingSitesIn, parse, promisedTargets, type EndingKinds, type EndingRef, type Registry, type Script, type Statement, type TargetHook } from "@liminalia/lang";
import { listScenarioFiles, loadScenarioSource } from "@liminalia/project";
import { coverage, routeCoverage, type CoverageReport } from "@liminalia/runtime";
import { loadContext, runtimeOptionsOf, type Context } from "../context.ts";
import { overlayForPack, overlayOf, overlayPacks, type OverlayPack } from "../pack-overlay.ts";
import { githubAnnotation } from "./check.ts";
import { reachHints, readProjectScripts, type ReachHints } from "./reach.ts";

/** プレイを終える命令の行の、名前とエンディング（ending= と title= が無ければ ref は null）。 */
export interface EndingSiteName {
  /** 出力に出す名前（`bad「沈黙」（ファイル:行）`。ending= も title= も無ければ「@命令（ファイル:行）」）。 */
  name: string;
  ref: EndingRef | null;
}

/**
 * プレイを終える命令（仕様の ends。@title-screen など）の行 → 名前とエンディング。名前は種類と title（`bad「沈黙」`。endingLabel）に行を添えたもの。
 * 種類は台本の原文で読むので、訳した作品でも遊ぶ言語によらず同じ。place は名前に添える位置（パックの台本を重ねたときの位置。省けば台本の名前）。
 */
export function endingSites(scripts: ReadonlyMap<string, { script: Script }>, registry: Registry, kinds?: EndingKinds, place: (file: string) => string = (file) => file): Map<string, EndingSiteName> {
  const out = new Map<string, EndingSiteName>();
  const visit = (file: string, body: Statement[], refs: ReadonlyMap<number, EndingRef>, macros: ReadonlySet<string>) => {
    for (const s of body) {
      if (s.kind === "command" && registry.get(s.name)?.ends && !macros.has(s.name)) {
        const ref = refs.get(s.line) ?? null;
        // 名前の位置は出力の位置（パックの台本は packs/<フォルダ>/scenario/<台本>）。鍵は流す実行器の名前のまま
        out.set(`${file}:${s.line}`, { name: `${ref ? endingLabel(ref) : `@${s.name}`}（${place(file)}:${s.line}）`, ref });
      }
      if (s.kind === "if") for (const b of s.branches) visit(file, b.body, refs, macros);
      // @define のマクロの中に書いた終わる命令も、@with で呼べば実行されるので数える（@liminalia/lang の endingSitesIn と同じ）
      if (s.kind === "define") visit(file, s.body, refs, macros);
    }
  };
  for (const [file, { script }] of scripts) {
    // 下書き（// lim: draft）は全ルートテストの対象外なので、そこの終わる命令も数えない（coverage が流すファイルと同じ）
    if (script.draft) continue;
    // 組み込みと同じ名前のマクロがあれば実行時はそちらが優先（実行側の findDefine と同じ、そのファイルと @use したファイルの @define）ので、
    // その名前の命令は終わる命令ではない
    const macros = new Set<string>();
    const collect = (f: string) => {
      const sc = scripts.get(f);
      if (sc) for (const t of sc.script.body) if (t.kind === "define") macros.add(t.name);
    };
    collect(file);
    for (const s of script.body) if (s.kind === "use") collect(s.file);
    visit(file, script.body, new Map(endingSitesIn(file, script, registry, kinds).map((x) => [x.line, x.ref])), macros);
  }
  return out;
}

/** 種類ごとの、届いたエンディングの数と全部の数（種類の名前の順。ending= の無い終わりは数えない）。 */
export function endingKindCounts(sites: ReadonlyMap<string, EndingSiteName>, reached: ReadonlySet<string>): Record<string, { reached: number; total: number }> {
  const out: Record<string, { reached: number; total: number }> = {};
  for (const { name, ref } of sites.values()) {
    if (!ref) continue;
    const c = (out[ref.kind] ??= { reached: 0, total: 0 });
    c.total++;
    if (reached.has(name)) c.reached++;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * lim coverage [プロジェクト] [--runs 8] [--seeds 1] [--route-runs 8] [--json] [--min-lines 80] [--require-endings] [--github]
 * 全ファイルを画面なしで、選択肢の選び方をまだ試していないものへ広げながら --runs 回まで流し、本文の網羅率と実行時の診断を出す
 * （選び方をすべて試し終えたら、上限より前に止める。試し切れなかったファイルはそう出す）。
 * --seeds N で乱数の種を 1〜N に変えて流す（random の分かれ方を通すため）。
 * （流し方は @liminalia/runtime の coverage。制作画面の全ルートテストも同じものを使う）。
 * 続けて「はじめから」（liminalia.json の entry）ファイルをまたいで最後まで --route-runs 回まで流し（routeCoverage。ほかのファイルで決めた変数を引き継ぐ）、
 * どのエンディング（プレイを終える命令。@title-screen ending= など）に届いたか、届かなかったものはどれかと、選び方をすべて試したか上限で打ち切ったかを出す。
 * --route-runs 0 なら流さない。
 * CI の基準: --min-lines N は到達した本文が N% より低ければ、--require-endings は届かなかったエンディングがあれば失敗にする。
 * --json は結果を JSON で、--github は実行時の診断と基準を満たさないことを GitHub Actions の注釈でも出す。
 * パック（packs/<フォルダ>/scenario）の台本も、本体にすべてのパックを重ねてそのパックを一番後ろにし、ファイルごとに流し（網羅率と --min-lines に数える。位置は packs/<フォルダ>/scenario/<台本>）、
 * 本体にすべてのパックを重ねた「はじめから」（書き出しと同じ）も流して、パックの台本の本文とエンディングに届くかを出す（--require-endings にも数える）。
 */
export interface CoverageCliOptions {
  /** 結果を JSON で出す（文字の出力の代わり）。 */
  json?: boolean;
  /** 到達した本文の割合（%）がこれより低ければ失敗にする。 */
  minLines?: number;
  /** 届かなかったエンディングがあれば失敗にする。 */
  requireEndings?: boolean;
  /** GitHub Actions の注釈（::error 形式）でも出す。 */
  github?: boolean;
}

export async function runCoverage(dir: string, runs: number, seeds = 1, routeRuns = 8, o: CoverageCliOptions = {}): Promise<boolean> {
  const ctx = await loadContext(dir);
  const scenario = ctx.project.paths.scenario;
  const files = listScenarioFiles(scenario).map((f) => f.name);
  // 命令が教えた行き先（画面なしで一度も選択肢に出なかったものを警告にする）
  const scripts = new Map<string, { script: Script; text: string }>();
  // UTF-8 で読めない台本があれば、化けたまま流さずに止める
  for (const f of files) {
    const text = loadScenarioSource(scenario, f);
    scripts.set(f, { script: parse(text, f, { speakers: ctx.cast.speakers }), text });
  }
  const hooks = new Map<string, TargetHook>();
  for (const c of ctx.combined.commands) if (c.targets) hooks.set(c.name, c.targets.bind(c));
  const dataDir = ctx.project.paths.data;
  const data = (name: string): unknown => {
    const path = resolve(dataDir, ...name.split("/"));
    if (!path.startsWith(dataDir + sep) || !existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // 読めないデータは無いものとして流す（データの形の誤りは lim check が知らせる）
      return undefined;
    }
  };
  const seedList = Array.from({ length: Math.max(1, seeds) }, (_, i) => i + 1);
  const main = await coverage({
    files,
    loadSource: async (f) => loadScenarioSource(scenario, f),
    runtime: runtimeOptionsOf(ctx),
    runs,
    seeds: seedList,
    promised: promisedTargets({ scripts, registry: ctx.registry, hooks, data }),
  });
  // パックの台本は、本体にすべてのパックを重ね、そのパックを一番後ろにして、ファイルごとに流す（位置は packs/<フォルダ>/scenario/<台本>）
  const byPack = await packFileCoverage(ctx, files, runs, seedList);
  const packs = byPack.packs;
  // file は出力の位置、name は流す実行器の台本の名前、pack はパックの台本のパック
  const report: { files: (CoverageReport["files"][number] & { pack?: OverlayPack; name: string })[]; diagnostics: CoverageReport["diagnostics"]; endings: Map<string, number> } = {
    files: [...main.files.map((f) => ({ ...f, name: f.file })), ...byPack.files],
    diagnostics: [...main.diagnostics],
    endings: new Map(main.endings),
  };
  mergeDiagnostics(report.diagnostics, byPack.diagnostics);
  for (const [k, v] of byPack.endings) report.endings.set(k, (report.endings.get(k) ?? 0) + v);

  let all = 0;
  let hit = 0;
  const unreached: { file: string; reached: number; total: number }[] = [];
  for (const f of report.files) {
    const t = f.lines.length;
    const h = f.reached.size;
    all += t;
    hit += h;
    if (h < t) unreached.push({ file: f.file, reached: h, total: t });
  }
  const percent = (n: number) => Math.round((n / Math.max(all, 1)) * 1000) / 10;
  const diagnostics = [...report.diagnostics].sort((a, b) => b.count - a.count);

  // ---- はじめから、ファイルをまたいで ----
  const sites = endingSites(scripts, ctx.registry, endingKinds(ctx.project.config.endingKinds));
  const route =
    routeRuns > 0
      ? await routeCoverage({
          entry: ctx.project.config.entry,
          loadSource: async (f) => loadScenarioSource(scenario, f),
          runtime: runtimeOptionsOf(ctx),
          runs: routeRuns,
          seeds: Array.from({ length: Math.max(1, seeds) }, (_, i) => i + 1),
          endings: new Map([...sites].map(([site, x]) => [site, x.name])),
        })
      : null;
  let routeHit = 0;
  if (route) for (const f of report.files) if (!f.pack) routeHit += [...(route.reached.get(f.file) ?? [])].filter((l) => f.lines.includes(l)).length;
  const names = new Set([...sites.values()].map((x) => x.name));
  const reachedEndings = route ? [...route.endings].filter(([name]) => names.has(name)).sort((a, b) => b[1] - a[1]) : [];
  const otherEndings = route ? [...route.endings].filter(([name]) => !names.has(name)).sort((a, b) => b[1] - a[1]) : [];
  const missed = route ? [...names].filter((n) => !route.endings.has(n)) : [];
  // 届かなかったエンディングの手がかり（入る条件と、条件の変数を決める行。道は lim reach で探す）
  const siteOf = new Map([...sites].map(([site, x]) => [x.name, site] as const));
  // 種類ごとの届いた数（ending= を書いた終わりだけ）
  const kinds = route ? endingKindCounts(sites, new Set(route.endings.keys())) : {};
  const project = missed.length > 0 ? readProjectScripts(ctx, scripts) : null;
  const hints = new Map<string, { site: string; hints: ReachHints }>();
  for (const name of missed) {
    const site = siteOf.get(name);
    const m = site ? /^(.+):(\d+)$/.exec(site) : null;
    if (m && project) hints.set(name, { site: site!, hints: reachHints(project, m[1]!, Number(m[2])) });
  }
  const isFresh = (x: { diagnostic: { code: string; file: string; line: number } }) => !report.diagnostics.some((y) => y.diagnostic.code === x.diagnostic.code && y.diagnostic.file === x.diagnostic.file && y.diagnostic.line === x.diagnostic.line);
  const fresh = route ? route.diagnostics.filter(isFresh).sort((a, b) => b.count - a.count) : [];

  // ---- はじめから、すべてのパックを重ねて（書き出しと同じ。パックの台本の本文とエンディング） ----
  const packRoute = routeRuns > 0 && packs.length > 0 ? await packRouteCoverage(ctx, files, packs, report.files, routeRuns, seedList) : null;
  const packFresh = packRoute ? packRoute.diagnostics.filter(isFresh) : [];

  // ---- CI の基準 ----
  const tooFew = o.minLines !== undefined && percent(hit) < o.minLines;
  const missedRequired = o.requireEndings === true && ((route !== null && missed.length > 0) || (packRoute !== null && packRoute.missed.length > 0));
  const ok = report.diagnostics.length === 0 && fresh.length === 0 && packFresh.length === 0 && !tooFew && !missedRequired;

  if (o.json) {
    console.log(
      JSON.stringify(
        {
          ok,
          lines: { reached: hit, total: all, percent: percent(hit) },
          files: report.files.map((f) => ({ file: f.file, reached: f.reached.size, total: f.lines.length, complete: f.complete })),
          endings: Object.fromEntries(report.endings),
          diagnostics: diagnostics.map(({ diagnostic, count }) => ({ ...diagnostic, count })),
          ...(route
            ? {
                route: {
                  entry: ctx.project.config.entry,
                  runs: route.runs.length,
                  complete: route.complete,
                  lines: { reached: routeHit, total: all, percent: percent(routeHit) },
                  endings: Object.fromEntries(reachedEndings),
                  kinds,
                  missedEndings: missed,
                  missedHints: Object.fromEntries([...hints].map(([name, h]) => [name, { reach: `lim reach ${h.site}`, ...h.hints }])),
                  otherEndings: Object.fromEntries(otherEndings),
                  diagnostics: fresh.map(({ diagnostic, count }) => ({ ...diagnostic, count })),
                  ...(packRoute
                    ? {
                        packs: {
                          runs: packRoute.runs,
                          complete: packRoute.complete,
                          lines: { reached: packRoute.reached, total: packRoute.total, percent: Math.round((packRoute.reached / Math.max(packRoute.total, 1)) * 1000) / 10 },
                          endings: Object.fromEntries(packRoute.endings),
                          missedEndings: packRoute.missed,
                          diagnostics: packFresh.map(({ diagnostic, count }) => ({ ...diagnostic, count })),
                        },
                      }
                    : {}),
                },
              }
            : {}),
          ...(o.minLines !== undefined ? { minLines: o.minLines } : {}),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`到達した本文: ${hit}/${all} 行（${percent(hit).toFixed(1)}%）`);
    console.log(`終了の理由: ${[...report.endings].map(([k, v]) => `${k} ${v}`).join(" / ")}`);
    if (unreached.length) console.log(`未到達の行があるファイル:\n${unreached.map((u) => `  ${u.file}: ${u.reached}/${u.total}`).join("\n")}`);
    const cut = report.files.filter((f) => !f.complete).map((f) => f.file);
    if (cut.length > 0) console.log(`選び方を試し切る前に上限（--runs ${runs}）で打ち切ったファイル: ${cut.length} 件（${cut.slice(0, 10).join("、")}${cut.length > 10 ? ` ほか ${cut.length - 10} 件` : ""}）`);
    console.log(`エラーと警告: ${report.diagnostics.length} 種類`);
    for (const { diagnostic: d, count } of diagnostics.slice(0, 40)) console.log(`  ${count}× ${d.code} ${d.file}:${d.line} ${d.message}`);
    if (route) {
      const how = route.complete ? "選び方をすべて試しました" : `上限の ${routeRuns} 回で打ち切り、まだ試していない選び方があります。--route-runs で増やせます`;
      console.log(`\nはじめから（${ctx.project.config.entry}）ファイルをまたいで ${route.runs.length} 回流しました（変数を引き継ぐ。${how}）:`);
      console.log(`  到達した本文: ${routeHit}/${all} 行（${percent(routeHit).toFixed(1)}%）`);
      if (Object.keys(kinds).length > 0) console.log(`  エンディングの種類ごと（届いた数 / 全部）: ${Object.entries(kinds).map(([k, c]) => `${k} ${c.reached}/${c.total}`).join("、")}`);
      if (reachedEndings.length > 0) {
        console.log("  届いたエンディング:");
        for (const [name, n] of reachedEndings) console.log(`    ${name}: ${n} 回`);
      }
      if (missed.length > 0) {
        console.log("  届かなかったエンディング（選び方を増やすなら --route-runs、random の分かれなら --seeds。届く選び方は lim reach で探せます）:");
        for (const name of missed) {
          console.log(`    ${name}`);
          const h = hints.get(name);
          if (!h) continue;
          for (const c of h.hints.conditions) console.log(`      入る条件: ${c.text}（${c.file}.lim:${c.line}）`);
          for (const w of h.hints.setters.slice(0, 5)) console.log(`      条件の変数を決める行: ${w.path ? `${w.path} ` : ""}${w.file}.lim:${w.line}`);
          console.log(`      lim reach ${h.site}`);
        }
      }
      if (otherEndings.length > 0) {
        console.log("  ほかの終わり方:");
        for (const [name, n] of otherEndings) console.log(`    ${name}: ${n} 回`);
      }
      if (names.size === 0) console.log("  プレイを終える命令（@title-screen など）がありません。終わり方はファイルの終わりで数えています");
      if (fresh.length > 0) {
        console.log(`  ファイルをまたいだときだけ出たエラーと警告: ${fresh.length} 種類`);
        for (const { diagnostic: d, count } of fresh.slice(0, 40)) console.log(`    ${count}× ${d.code} ${d.file}:${d.line} ${d.message}`);
      }
    }
    if (packRoute) {
      const how = packRoute.complete ? "選び方をすべて試しました" : `上限の ${routeRuns} 回で打ち切り、まだ試していない選び方があります。--route-runs で増やせます`;
      console.log(`\nすべてのパックを重ねて、はじめから（${ctx.project.config.entry}）ファイルをまたいで ${packRoute.runs} 回流しました（${how}）:`);
      console.log(`  到達したパックの本文: ${packRoute.reached}/${packRoute.total} 行`);
      if (packRoute.endings.size > 0) {
        console.log("  届いたエンディング:");
        for (const [name, n] of packRoute.endings) console.log(`    ${name}: ${n} 回`);
      }
      if (packRoute.missed.length > 0) {
        console.log("  届かなかったパックのエンディング（届く選び方は lim reach で探せます）:");
        for (const name of packRoute.missed) console.log(`    ${name}`);
      }
      if (packFresh.length > 0) {
        console.log(`  パックを重ねたときだけ出たエラーと警告: ${packFresh.length} 種類`);
        for (const { diagnostic: d, count } of packFresh.slice(0, 40)) console.log(`    ${count}× ${d.code} ${d.file}:${d.line} ${d.message}`);
      }
    }
    if (tooFew) console.log(`\n--min-lines ${o.minLines}: 到達した本文が ${percent(hit).toFixed(1)}% で、基準より低いため失敗にします`);
    if (missedRequired) console.log(`\n--require-endings: 届かなかったエンディングが ${missed.length + (packRoute?.missed.length ?? 0)} 件あるため失敗にします`);
  }
  if (o.github) {
    // 実行時の診断と、CI の基準を満たさないことを、GitHub Actions の注釈にする
    const packPlaces = new Set(report.files.filter((f) => f.pack).map((f) => f.file));
    const pathOf = (file: string) => (file === "" ? "" : relative(process.cwd(), packPlaces.has(file) ? join(ctx.project.root, `${file}.lim`) : join(scenario, `${file}.lim`)).split(sep).join("/"));
    for (const { diagnostic: d } of [...diagnostics, ...fresh, ...packFresh]) console.log(githubAnnotation(d, pathOf(d.file)));
    if (tooFew) console.log(`::error title=lim coverage::${`到達した本文が ${percent(hit).toFixed(1)}% で、--min-lines ${o.minLines} より低い`}`);
    for (const name of [...missed, ...(packRoute?.missed ?? [])]) console.log(`::${o.requireEndings ? "error" : "warning"} title=lim coverage::${`届かなかったエンディング: ${name}`.replace(/%/g, "%25")}`);
  }
  return ok;
}

/**
 * パック（packs/<フォルダ>/scenario）の台本を、ファイルごとに流す（lim coverage と MCP の coverage が同じものを使う）。
 * 本体にすべてのパックを重ね、そのパックを一番後ろにして流す（パックのデータも重ねる。pack-overlay.ts）。file は出力の位置（packs/<フォルダ>/scenario/<台本>）、
 * name は流す実行器の台本の名前。診断の file も出力の位置。mainNames は本体の台本の名前。
 */
export async function packFileCoverage(
  ctx: Context,
  mainNames: readonly string[],
  runs: number,
  seeds: readonly number[] = [1],
): Promise<{ packs: OverlayPack[]; files: (CoverageReport["files"][number] & { pack: OverlayPack; name: string })[]; diagnostics: CoverageReport["diagnostics"]; endings: Map<string, number> }> {
  const packs = overlayPacks(ctx);
  const hooks = new Map<string, TargetHook>();
  for (const c of ctx.combined.commands) if (c.targets) hooks.set(c.name, c.targets.bind(c));
  const out = { packs, files: [] as (CoverageReport["files"][number] & { pack: OverlayPack; name: string })[], diagnostics: [] as CoverageReport["diagnostics"], endings: new Map<string, number>() };
  for (const pack of packs) {
    const ov = overlayForPack(ctx, packs, pack);
    const read = ov.read(mainNames);
    const r = await coverage({ files: pack.names, loadSource: ov.loadSource, runtime: ov.runtime, runs, seeds, promised: promisedTargets({ scripts: read, registry: ctx.registry, hooks, data: ov.data }) });
    out.files.push(...r.files.map((f) => ({ ...f, file: ov.place(f.file), name: f.file, pack })));
    mergeDiagnostics(out.diagnostics, r.diagnostics.map((x) => ({ ...x, diagnostic: { ...x.diagnostic, file: x.diagnostic.file === "" ? "" : ov.place(x.diagnostic.file) } })));
    for (const [k, v] of r.endings) out.endings.set(k, (out.endings.get(k) ?? 0) + v);
  }
  return out;
}

/** 実行時の診断を、同じものをまとめて足す（ファイルごとの流しを、本体とパックで合わせる）。 */
function mergeDiagnostics(into: { diagnostic: { code: string; file: string; line: number; message: string }; count: number }[], more: readonly { diagnostic: CoverageReport["diagnostics"][number]["diagnostic"]; count: number }[]): void {
  for (const x of more) {
    const same = into.find((y) => y.diagnostic.code === x.diagnostic.code && y.diagnostic.file === x.diagnostic.file && y.diagnostic.line === x.diagnostic.line && y.diagnostic.message === x.diagnostic.message);
    if (same) same.count += x.count;
    else into.push({ ...x });
  }
}

/**
 * 本体にすべてのパックを重ねて「はじめから」流す（書き出しと同じ組）。パックの台本（重ねて残るもの）の本文に届いた行の数と、パックの台本のエンディングに届いたかを返す。
 * 位置は packs/<フォルダ>/scenario/<台本>。
 */
async function packRouteCoverage(
  ctx: Context,
  mainNames: readonly string[],
  packs: readonly OverlayPack[],
  files: readonly { pack?: OverlayPack; name: string; lines: number[] }[],
  runs: number,
  seeds: readonly number[],
): Promise<{ runs: number; complete: boolean; reached: number; total: number; endings: Map<string, number>; missed: string[]; diagnostics: { diagnostic: CoverageReport["diagnostics"][number]["diagnostic"]; count: number }[] }> {
  const ov = overlayOf(ctx, packs);
  const scripts = ov.read(mainNames);
  const sites = endingSites(scripts, ctx.registry, endingKinds(ctx.project.config.endingKinds), ov.place);
  const route = await routeCoverage({ entry: ctx.project.config.entry, loadSource: ov.loadSource, runtime: ov.runtime, runs, seeds, endings: new Map([...sites].map(([site, x]) => [site, x.name])) });
  // 重ねて残るパックの台本の本文（後ろのパックが同じ名前で差し替えたものは数えない）
  let reached = 0;
  let total = 0;
  for (const f of files) {
    if (!f.pack || ov.owner(f.name) !== f.pack) continue;
    total += f.lines.length;
    reached += [...(route.reached.get(f.name) ?? [])].filter((l) => f.lines.includes(l)).length;
  }
  const own = [...sites].filter(([site]) => ov.owner(site.slice(0, site.lastIndexOf(":"))) !== null).map(([, x]) => x.name);
  const names = new Set([...sites.values()].map((x) => x.name));
  return {
    runs: route.runs.length,
    complete: route.complete,
    reached,
    total,
    endings: new Map([...route.endings].filter(([name]) => names.has(name)).sort((a, b) => b[1] - a[1])),
    missed: own.filter((name) => !route.endings.has(name)),
    diagnostics: route.diagnostics.map((x) => ({ ...x, diagnostic: { ...x.diagnostic, file: x.diagnostic.file === "" ? "" : ov.place(x.diagnostic.file) } })).sort((a, b) => b.count - a.count),
  };
}
