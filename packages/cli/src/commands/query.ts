import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { assetReferences, castAssetReferences, dataReferences, dynamicAssetReferences, extraAssetReferences, itemAssetReferences, jsonLines, parse, parseScenarioTests, projectMacros, resolveTargetText, targetSitesOf, typoDistance, uiAssetReferences, variablePaths, variableUses, type Script } from "@liminalia/lang";
import { assetTextUses, listScenarioFiles, listScenarioTestFiles, projectDataReader, readAssetTextFiles, readScenarioFile } from "@liminalia/project";
import { declaredData } from "@liminalia/plugin-host";
import { loadContext } from "../context.ts";

export type QueryKind = "label" | "var" | "asset";
export interface QuerySite { file: string; line: number; column?: number; role: string; text: string }
export interface QueryItem { name: string; definitions: QuerySite[]; uses: QuerySite[]; dynamic: QuerySite[]; exists?: boolean }
export type QueryResult = { kind: QueryKind; items: { name: string; definitions: number; uses: number }[] } | ({ kind: QueryKind; found: boolean; candidates: string[] } & QueryItem);

export function queryKind(value: string): QueryKind {
  if (value === "label" || value === "labels") return "label";
  if (["var", "variable", "variables"].includes(value)) return "var";
  if (value === "asset" || value === "assets") return "asset";
  throw new Error(`lim query: label | var | asset: ${value}`);
}

export async function queryProject(dir: string, kind: QueryKind, name?: string): Promise<QueryResult> {
  const ctx = await loadContext(dir);
  const { project } = ctx;
  const rel = (file: string) => relative(project.root, file).split(sep).join("/");
  const items = new Map<string, QueryItem>();
  const get = (key: string) => {
    let item = items.get(key);
    if (!item) items.set(key, item = { name: key, definitions: [], uses: [], dynamic: [] });
    return item;
  };
  const texts = new Map<string, string>();
  const scripts = new Map<string, Script>();
  const scriptFiles = new Map<string, string>();
  for (const f of listScenarioFiles(project.paths.scenario)) {
    const { text, encoding } = readScenarioFile(f.path);
    if (encoding) throw new Error(`${rel(f.path)}: ${encoding} (UTF-8 required)`);
    scripts.set(f.name, parse(text, f.name, { speakers: ctx.cast.speakers }));
    texts.set(rel(f.path), text);
    scriptFiles.set(f.name, rel(f.path));
  }
  const ownMacros = new Map([...scripts].map(([file, script]) => [file, projectMacros([[file, script]])]));
  const macrosByFile = new Map([...scripts].map(([file, script]) => {
    const macros = new Map(ownMacros.get(file));
    const imports = new Map<string, NonNullable<ReturnType<typeof ctx.registry.get>>>();
    const visit = (body: Script["body"]) => { for (const s of body) {
      if (s.kind === "use") for (const [name, spec] of ownMacros.get(s.file) ?? []) imports.set(name, spec);
      if (s.kind === "if") for (const b of s.branches) visit(b.body);
      if (s.kind === "define") visit(s.body);
    } };
    visit(script.body);
    return [file, new Map([...imports, ...macros])] as const;
  }));
  const lines = new Map<string, string[]>();
  const json = new Map<string, Map<string, number>>();
  const site = (file: string, line: number, role: string, column?: number): QuerySite => {
    if (!lines.has(file)) lines.set(file, (texts.get(file) ?? "").split(/\r?\n/));
    return { file, line, ...(column === undefined ? {} : { column }), role, text: (lines.get(file)![line - 1] ?? "").trim() };
  };
  const configFile = "liminalia.json";
  texts.set(configFile, readFileSync(join(project.root, configFile), "utf8"));
  texts.set(rel(project.paths.cast), existsSync(project.paths.cast) ? readFileSync(project.paths.cast, "utf8") : "");
  const atJson = (file: string, path: readonly (string | number)[], role: string) => {
    if (!json.has(file)) json.set(file, jsonLines(texts.get(file) ?? ""));
    return site(file, json.get(file)!.get(`/${path.map((p) => String(p).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`) ?? 1, role);
  };
  const data = declaredData(ctx.plugins, projectDataReader(project), (name) => {
    const path = join(project.paths.data, name);
    if (!existsSync(path)) return undefined;
    const text = readFileSync(path, "utf8"); texts.set(rel(path), text); return text;
  }).map((d) => ({ file: rel(join(project.paths.data, d.decl.file)), refs: dataReferences(d.decl, d.value) }));
  if (kind === "var") {
    for (const key of Object.keys(project.config.variables ?? {})) get(key).definitions.push(atJson(configFile, ["variables", key], "def"));
    for (const [file, script] of scripts) for (const u of variableUses(script, new Map([...ctx.registry, ...macrosByFile.get(file)!]))) get(u.path).uses.push(site(scriptFiles.get(file)!, u.line, u.write ? "write" : "read"));
    for (const d of data) for (const [role, refs] of [["write", d.refs.flagsSet], ["read", d.refs.flagsRead]] as const) for (const r of refs) get(r.path).uses.push(atJson(d.file, r.at, role));
    for (const f of listScenarioTestFiles(join(project.root, "tests"))) {
      const file = rel(f); const text = readFileSync(f, "utf8"); texts.set(file, text);
      for (const test of parseScenarioTests(text, file).tests) {
        for (const set of test.sets) { get(set.path).uses.push(site(file, set.line, "write")); for (const path of variablePaths(set.value)) get(path).uses.push(site(file, set.line, "read")); }
        for (const e of test.expects) if (e.kind === "expr") for (const path of variablePaths(e.expr)) get(path).uses.push(site(file, e.line, "read"));
      }
    }
    if (name) name = /^(game|system|temp)\.[^.[]+/u.exec(name)?.[0] ?? name;
  }
  if (kind === "label") {
    const labels = new Map<string, { name: string; line: number }[]>();
    for (const [file, script] of scripts) {
      const found: { name: string; line: number }[] = [];
      const visit = (body: Script["body"]) => { for (const s of body) {
        if (s.kind === "label") { found.push({ name: s.name, line: s.line }); get(`${file}#${s.name}`).definitions.push(site(scriptFiles.get(file)!, s.line, "def")); }
        if ("body" in s && Array.isArray(s.body)) visit(s.body);
        if ("branches" in s) for (const b of s.branches) visit(b.body);
      } };
      visit(script.body);
      labels.set(file, found);
      get(file).definitions.push(site(scriptFiles.get(file)!, 1, "def"));
    }
    const files = { has: (f: string) => scripts.has(f), labels: (f: string) => labels.get(f) ?? [] };
    const target = (value: string, from: string, use: QuerySite) => {
      const p = resolveTargetText(value, from, files);
      if (p) get(p.label === null ? p.file : `${p.file}#${p.label}`).uses.push(use);
    };
    for (const [file, path] of scriptFiles) {
      const macros = macrosByFile.get(file)!;
      const lines = texts.get(path)!.split(/\r?\n/);
      lines.forEach((text, i) => { for (const s of targetSitesOf(lines, i, (n) => macros.get(n) ?? ctx.registry.get(n))) {
        const role = /^\s*@jump\b/.test(text) ? "jump" : /^\s*@call\b/.test(text) ? "call" : text.includes("->") ? "choice" : "target";
        target(s.text, file, site(path, i + 1, role, s.start + 1));
      } });
    }
    const scanConfig = (value: unknown, path: string[] = []) => {
      if (!value || typeof value !== "object") return;
      for (const [key, v] of Object.entries(value)) {
        const p = [...path, key];
        if (typeof v === "string" && (["entry", "afterLoad"].includes(key) || key === "target" || path[0] === "variables" || (path[0] === "check" && path.includes("quiet")) || (path[0] === "chapters" && path.includes("files")))) target(v, "", atJson(configFile, p, "config"));
        if ((path.length === 1 && path[0] === "scenes") || path.join(".") === "extra.flowchart.titles") target(key, "", atJson(configFile, p, "config"));
        scanConfig(v, p);
      }
    };
    scanConfig(project.config);
    for (const d of data) for (const r of d.refs.scenes) target(r.file === null ? r.text : `${r.file}${r.label === null ? "" : `#${r.label}`}`, "", atJson(d.file, r.at, "data"));
    for (const f of listScenarioTestFiles(join(project.root, "tests"))) {
      const path = rel(f); const text = readFileSync(f, "utf8"); texts.set(path, text);
      let from = project.config.entry.split("#")[0]!;
      text.split(/\r?\n/).forEach((line, i) => {
        const m = /^\s*(from|expect (?:not )?reach)\s+(\S+)/.exec(line);
        if (!m) return;
        target(m[2]!, from, site(path, i + 1, "test"));
        if (m[1] === "from") from = m[2]!.split("#")[0] || from;
      });
    }
    if (name && !items.has(name)) {
      const matches = [...items.keys()].filter((key) => key.endsWith(`#${name!.replace(/^[#*]/, "")}`));
      if (matches.length === 1) name = matches[0];
    }
  }
  if (kind === "asset") {
    const walk = (dir: string) => { if (!existsSync(dir)) return; for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const path = join(dir, e.name);
      if (e.isDirectory()) walk(path);
      else { const key = relative(project.paths.assets, path).split(sep).join("/"); get(key).definitions.push({ file: rel(path), line: 1, role: "def", text: key }); }
    } };
    walk(project.paths.assets);
    const dynamic: { folder: string; site: QuerySite }[] = [];
    for (const [file, script] of scripts) {
      const macros = macrosByFile.get(file)!;
      for (const r of assetReferences(script, ctx.registry, macros)) get(`${r.folder}/${r.path}`).uses.push(site(scriptFiles.get(file)!, r.line, "asset", r.column));
      for (const r of dynamicAssetReferences(script, ctx.registry, macros)) dynamic.push({ folder: r.folder, site: site(scriptFiles.get(file)!, r.line, "dynamic", r.column) });
    }
    const matchingJsonSites = (file: string, value: unknown, needle: string, role: string, path: string[] = []): QuerySite[] => {
      if (value === needle) return [atJson(file, path, role)];
      if (!value || typeof value !== "object") return [];
      return Object.entries(value).flatMap(([key, v]) => matchingJsonSites(file, v, needle, role, [...path, key]));
    };
    const configAssetSites = (value: unknown, where: string, path: string[] = [], location = ""): QuerySite[] => {
      if (location === where) return [atJson(configFile, path, "config")];
      if (!value || typeof value !== "object") return [];
      return Object.entries(value).flatMap(([key, v]) => configAssetSites(v, where, [...path, key], Array.isArray(value) ? `${location}[${key}]` : location ? `${location}.${key}` : key));
    };
    for (const r of castAssetReferences(ctx.cast.cast)) get(`${r.folder ?? "fgimage"}/${r.path}`).uses.push(...matchingJsonSites(rel(project.paths.cast), ctx.cast.cast[r.who], r.path, "cast", ["cast", r.who]));
    for (const r of [...extraAssetReferences(project.config.extra), ...itemAssetReferences(project.config.items), ...uiAssetReferences(project.config.ui)]) {
      const section = r.where.split(".")[0]!;
      const uses = section === "extra" ? matchingJsonSites(configFile, project.config.extra, r.path, "config", [section]) : configAssetSites(project.config, r.where);
      get(`${r.folder}/${r.path}`).uses.push(...uses);
    }
    for (const d of data) for (const r of d.refs.assets) get(`${r.folder}/${r.path}`).uses.push(atJson(d.file, r.at, "data"));
    const more = readAssetTextFiles(project);
    for (const t of more) texts.set(t.where, t.text);
    const candidates = [...items.keys()].map((key) => ({ folder: key.split("/")[0]!, path: key.slice(key.indexOf("/") + 1) }));
    for (const [key, uses] of assetTextUses([...texts].map(([where, text]) => ({ where, text })), candidates)) for (const u of uses) {
      const item = get(key);
      if (!item.uses.some((s) => s.file === u.where && s.line === u.line)) item.uses.push(site(u.where, u.line, "guess"));
    }
    for (const item of items.values()) {
      item.exists = existsSync(join(project.paths.assets, item.name));
      item.dynamic = dynamic.filter((r) => r.folder === item.name.split("/")[0]).map((r) => r.site);
    }
  }
  const sorted = [...items.values()].sort((a, b) => a.name.localeCompare(b.name, "en"));
  for (const item of sorted) for (const key of ["definitions", "uses", "dynamic"] as const) item[key] = item[key].filter((s, i, all) => all.findIndex((t) => JSON.stringify(t) === JSON.stringify(s)) === i).sort((a, b) => a.file.localeCompare(b.file, "en") || a.line - b.line || (a.column ?? 0) - (b.column ?? 0));
  if (name === undefined) return { kind, items: sorted.map((s) => ({ name: s.name, definitions: s.definitions.length, uses: s.uses.length })) };
  const item = items.get(name);
  const candidates = item ? [] : sorted.map((s) => ({ name: s.name, distance: typoDistance(name!, s.name) })).filter((s) => s.distance <= Math.max(3, name!.length / 3)).sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name, "en")).slice(0, 3).map((s) => s.name);
  return { kind, found: !!item, candidates, ...(item ?? { name, definitions: [], uses: [], dynamic: [] }) };
}

export async function runQuery(dir: string, kind: QueryKind, name: string | undefined, json: boolean, lang: "ja" | "en"): Promise<boolean> {
  const result = await queryProject(dir, kind, name);
  if (json) console.log(JSON.stringify(result, null, 2));
  else if ("items" in result) {
    for (const item of result.items) console.log(`${item.name}  ${lang === "en" ? "definitions" : "定義"}: ${item.definitions}  ${lang === "en" ? "uses" : "参照"}: ${item.uses}`);
    if (!result.items.length) console.log(lang === "en" ? "No items." : "該当する名前はありません。");
  } else if (!result.found) console.log(`${lang === "en" ? "Not found" : "見つかりません"}: ${result.name}${result.candidates.length ? `\n${lang === "en" ? "Candidates" : "候補"}: ${result.candidates.join(", ")}` : ""}`);
  else {
    if (result.exists !== undefined) console.log(`${result.name}  ${lang === "en" ? (result.exists ? "exists" : "missing") : (result.exists ? "ファイルあり" : "ファイルなし")}`);
    for (const s of [...result.definitions, ...result.uses, ...result.dynamic]) console.log(`${s.file}:${s.line}${s.column ? `:${s.column}` : ""}  ${s.role}  ${s.text}`);
  }
  return !("found" in result) || result.found;
}
