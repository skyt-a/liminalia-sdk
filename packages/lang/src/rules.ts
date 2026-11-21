import { normalizeBooleanArgs, parseLiteral } from "./args.ts";
import type { Argument, Diagnostic, Script, Statement } from "./ast.ts";
import type { Cast } from "./cast.ts";
import { cgMatcher, cgShown } from "./cg.ts";
import type { ExtraConfig } from "./extra.ts";
import type { Registry } from "./registry.ts";

/**
 * 作品の演出の決まり（liminalia.json の check.rules）と、場面ごとの情報（liminalia.json の scenes）の検査。
 * 決まりは宣言で書き、台本を頭から順に読んで立ち絵・暗転の様子を追いながら確かめる（@if の枝はそれぞれ追って合わせる。
 * 飛び込まれるラベルは前の行から落ちてこなければ、様子が分からないものとして空から始める）。
 *
 * scenes は `ファイル` か `ファイル#ラベル` → { pov（視点の人物）, date（作中の日付）, place（場所）, ほか作品の項目 }。
 * ラベルの情報が無ければファイルの情報を使う。
 */

export type RuleSeverity = "error" | "warning" | "info";

export type ProjectRule = { severity?: RuleSeverity; message?: string } & (
  /** CG（extra.cg の画像）を出すときに立ち絵が残っている（§「CG の前に立ち絵を消す」）。 */
  | { rule: "cg-without-sprites" }
  /** ファイルをまたぐ @jump の前に暗転していない。commands は暗転に数える命令（既定 mask・scene-change）。 */
  | { rule: "fade-before-file-jump"; commands?: string[] }
  /** 場面の視点の人物（scenes の pov）の立ち絵を出した。allow は出してよい立ち絵セット（衣装披露など）。 */
  | { rule: "no-pov-sprite"; allow?: string[] }
  /**
   * 時代（scenes の field。既定 era）の立ち絵セットを混ぜた。eras は時代 → 立ち絵セットの名前（* は任意の文字）。
   * 時代のある場面では、その時代の立ち絵セットを持つ人物はそれを使う。時代の無い場面では、一つのラベルの中で時代を混ぜない。
   */
  | { rule: "appearance-era"; field?: string; eras: Record<string, string[]> }
  /** 出している人物の立ち絵セットを、消さずに替えた（衣装替えは出し直す）。 */
  | { rule: "appearance-change-while-shown" }
);

export const PROJECT_RULES = ["cg-without-sprites", "fade-before-file-jump", "no-pov-sprite", "appearance-era", "appearance-change-while-shown"] as const;

/** 場面の情報。 */
export type SceneInfo = { pov?: string; date?: string; place?: string } & Record<string, unknown>;

export interface RulesInput {
  rules: unknown;
  scenes: unknown;
  scripts: ReadonlyMap<string, Script>;
  registry: Registry;
  cast?: Cast;
  extra?: ExtraConfig;
}

const FILE = "liminalia.json";
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);

/** 引数の文字（位置引数は positional の名前で）。 */
function argOf(registry: Registry, name: string, args: readonly Argument[], key: string): string | null {
  const spec = registry.get(name);
  let pos = 0;
  for (const a of spec ? normalizeBooleanArgs(spec, args) : args) {
    const k = a.key ?? spec?.positional[pos++];
    if (k === key) return a.value.kind === "string" ? a.value.value : a.value.kind === "number" || a.value.kind === "bool" ? String(a.value.value) : null;
  }
  return null;
}

/** 立ち絵と暗転の様子（人物 → 立ち絵セット）。 */
interface Stage {
  sprites: Map<string, string>;
  masked: boolean;
  /** 本文から後の命令（暗転の命令があったか）。 */
  fadedSinceText: boolean;
  /** このラベルで使った時代。 */
  eras: Set<string>;
}
const copy = (s: Stage): Stage => ({ sprites: new Map(s.sprites), masked: s.masked, fadedSinceText: s.fadedSinceText, eras: new Set(s.eras) });
const fresh = (): Stage => ({ sprites: new Map(), masked: false, fadedSinceText: false, eras: new Set() });

/** 決まりの形を確かめる（形の誤りは bad-rules）。 */
function readRules(raw: unknown, out: Diagnostic[]): ProjectRule[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    out.push({ severity: "error", code: "bad-rules", message: "check.rules は決まりの並びで書きます", messageEn: "Write check.rules as a list of rules", file: FILE, line: 1 });
    return [];
  }
  const rules: ProjectRule[] = [];
  for (const r of raw) {
    if (!isRecord(r) || !(PROJECT_RULES as readonly string[]).includes(String(r.rule))) {
      out.push({ severity: "error", code: "bad-rules", message: `check.rules の ${JSON.stringify(isRecord(r) ? r.rule : r)} は使える決まりではありません（${PROJECT_RULES.join("・")}）`, messageEn: `${JSON.stringify(isRecord(r) ? r.rule : r)} in check.rules isn't a known rule (${PROJECT_RULES.join(", ")})`, file: FILE, line: 1 });
      continue;
    }
    if (r.rule === "appearance-era" && !isRecord(r.eras)) {
      out.push({ severity: "error", code: "bad-rules", message: "appearance-era には eras（時代 → 立ち絵セットの名前の並び）を書きます", messageEn: "appearance-era needs eras (era → list of appearance names)", file: FILE, line: 1 });
      continue;
    }
    rules.push(r as ProjectRule);
  }
  return rules;
}

/** 場面の情報の形と、指すファイル・ラベルがあるか。 */
function readScenes(raw: unknown, scripts: ReadonlyMap<string, Script>, labels: ReadonlyMap<string, ReadonlySet<string>>, out: Diagnostic[]): Map<string, SceneInfo> {
  const map = new Map<string, SceneInfo>();
  if (raw === undefined) return map;
  if (!isRecord(raw)) {
    out.push({ severity: "error", code: "bad-scenes", message: "scenes は `ファイル` か `ファイル#ラベル` → 場面の情報 で書きます", messageEn: "Write scenes as `file` or `file#label` → scene info", file: FILE, line: 1 });
    return map;
  }
  for (const [key, info] of Object.entries(raw)) {
    const [file = "", label] = key.split("#");
    if (!isRecord(info)) {
      out.push({ severity: "error", code: "bad-scenes", message: `scenes の ${key} は { pov, date, place } のように書きます`, messageEn: `Write ${key} in scenes like { pov, date, place }`, file: FILE, line: 1 });
      continue;
    }
    if (!scripts.has(file) || (label !== undefined && !labels.get(file)?.has(label))) {
      out.push({ severity: "warning", code: "bad-scenes", message: `scenes の ${key} の場面がシナリオにありません`, messageEn: `The scene ${key} in scenes isn't in the scenario`, file: FILE, line: 1 });
      continue;
    }
    map.set(key, info as SceneInfo);
  }
  return map;
}

/** 作品の決まりで台本を確かめる。 */
export function checkProjectRules(input: RulesInput): Diagnostic[] {
  const out: Diagnostic[] = [];
  const rules = readRules(input.rules, out);
  const labels = new Map<string, Set<string>>();
  for (const [file, script] of input.scripts) {
    const names = new Set<string>();
    const visit = (body: readonly Statement[]) => {
      for (const s of body) {
        if (s.kind === "label") names.add(s.name);
        if (s.kind === "if") for (const b of s.branches) visit(b.body);
      }
    };
    visit(script.body);
    labels.set(file, names);
  }
  const scenes = readScenes(input.scenes, input.scripts, labels, out);
  if (rules.length === 0) return out;
  const isCg = cgMatcher(input.extra);
  const cast = input.cast ?? {};
  const registry = input.registry;
  const castName = (who: string) => [who, cast[who]?.speaker].filter((x): x is string => !!x);
  const push = (rule: ProjectRule, code: string, file: string, line: number, message: string, messageEn: string, hint?: string, hintEn?: string) =>
    out.push({ severity: rule.severity ?? "warning", code, message: rule.message ?? message, ...(rule.message ? {} : { messageEn }), file, line, ...(hint ? { hint } : {}), ...(hintEn ? { hintEn } : {}) });
  const eraRule = rules.find((r): r is Extract<ProjectRule, { rule: "appearance-era" }> => r.rule === "appearance-era");
  const eraOf = (appearance: string): string | null => {
    if (!eraRule) return null;
    for (const [era, names] of Object.entries(eraRule.eras)) if (names.some((n) => glob(n).test(appearance))) return era;
    return null;
  };

  for (const [file, script] of input.scripts) {
    let scene: SceneInfo = scenes.get(file) ?? {};
    let sceneName = file;
    const walk = (body: readonly Statement[], st: Stage): Stage => {
      let falls = true;
      for (const s of body) {
        if (s.kind === "label") {
          scene = { ...(scenes.get(file) ?? {}), ...(scenes.get(`${file}#${s.name}`) ?? {}) };
          sceneName = `${file}#${s.name}`;
          // 前の行から落ちてこないラベルは、様子が分からないので空から
          if (!falls) st = fresh();
          st.eras = new Set();
          falls = true;
          continue;
        }
        if (s.kind === "say" || s.kind === "prose") {
          st.fadedSinceText = false;
          falls = true;
          continue;
        }
        if (s.kind === "if") {
          const ends = s.branches.map((b) => walk(b.body, copy(st)));
          if (!s.branches.some((b) => b.condition === null)) ends.push(st);
          const merged = fresh();
          for (const e of ends) {
            for (const [k, v] of e.sprites) merged.sprites.set(k, v);
            merged.masked ||= e.masked;
            merged.fadedSinceText ||= e.fadedSinceText;
            for (const x of e.eras) merged.eras.add(x);
          }
          st = merged;
          continue;
        }
        if (s.kind === "jump") {
          const target = s.target;
          for (const rule of rules) {
            if (rule.rule !== "fade-before-file-jump" || !target.file || target.file === file || target.expr) continue;
            if (!st.masked && !st.fadedSinceText)
              push(rule, "rule-fade-before-jump", file, s.line, `別のファイル（${target.file}）へ飛ぶ前に暗転していません`, `Not faded out before jumping to another file (${target.file})`, `直前に @${(rule.commands ?? ["mask"])[0]} を置きます`, `Put @${(rule.commands ?? ["mask"])[0]} right before it`);
          }
          falls = false;
          continue;
        }
        if (s.kind !== "command") {
          if (s.kind === "choice" || s.kind === "return") falls = false;
          continue;
        }
        falls = !(s.name === "stop" || s.name === "title-screen" || !!registry.get(s.name)?.ends);
        const fadeCommands = (rules.find((r) => r.rule === "fade-before-file-jump") as { commands?: string[] } | undefined)?.commands ?? ["mask", "scene-change"];
        if (fadeCommands.includes(s.name)) st.fadedSinceText = true;
        if (s.name === "mask") st.masked = true;
        if (s.name === "mask-off") st.masked = false;
        // CG を出す（extra.cg の画像）
        const shown = cgShown(registry.get(s.name), s.args).shown.filter((c) => isCg?.(c.folder, c.image));
        if (shown.length > 0 && st.sprites.size > 0) {
          for (const rule of rules)
            if (rule.rule === "cg-without-sprites")
              push(rule, "rule-cg-with-sprites", file, s.line, `CG ${shown[0]!.image} を出すときに立ち絵（${[...st.sprites.keys()].join("、")}）が残っています`, `Sprites (${[...st.sprites.keys()].join(", ")}) are still shown when the CG ${shown[0]!.image} appears`, "CG の前に @chara-hide-all で立ち絵を消します", "Hide the sprites with @chara-hide-all before the CG");
        }
        if (s.name === "chara-hide-all") st.sprites.clear();
        if (s.name === "scene-change" && (argOf(registry, s.name, s.args, "hide-chara") ?? registry.get(s.name)?.params["hide-chara"]?.default) !== "false") {
          const def = registry.get(s.name)?.params["hide-who"]?.default;
          const fallback = def === undefined ? null : parseLiteral(def);
          const who = argOf(registry, s.name, s.args, "hide-who") ?? (!s.args.some((a) => a.key === "hide-who") && fallback?.kind === "string" ? fallback.value : null);
          if (who === null) st.sprites.clear();
          else st.sprites.delete(who);
        }
        if (s.name === "chara-hide") {
          const who = argOf(registry, s.name, s.args, "who");
          if (who === null) st.sprites.clear();
          else st.sprites.delete(who);
        }
        if (s.name !== "chara") continue;
        const who = argOf(registry, s.name, s.args, "who");
        if (who === null) continue;
        const written = argOf(registry, s.name, s.args, "appearance");
        const before = st.sprites.get(who);
        const appearance = written ?? before ?? cast[who]?.defaultAppearance ?? "default";
        for (const rule of rules) {
          if (rule.rule === "appearance-change-while-shown" && before !== undefined && written !== null && written !== before)
            push(rule, "rule-appearance-change", file, s.line, `${who} を出したまま立ち絵セットを ${before} から ${written} に替えています`, `${who}'s appearance changes from ${before} to ${written} while shown`, "衣装替えは @chara-hide で消してから出し直します", "Hide the character with @chara-hide, then show it again");
          if (rule.rule === "no-pov-sprite" && typeof scene.pov === "string" && castName(who).includes(scene.pov) && !(rule.allow ?? []).includes(appearance))
            push(rule, "rule-pov-sprite", file, s.line, `場面 ${sceneName} の視点の人物（${scene.pov}）の立ち絵を出しています`, `The point-of-view character (${scene.pov}) of ${sceneName} is shown as a sprite`, "視点の人物の立ち絵は出しません（出すなら scenes の pov か決まりの allow を見直します）", "Don't show the narrator's sprite (or revise pov in scenes or the rule's allow)");
          if (rule.rule === "appearance-era") {
            const field = rule.field ?? "era";
            const want = typeof scene[field] === "string" ? (scene[field] as string) : null;
            const era = eraOf(appearance);
            const has = (e: string) => Object.keys(cast[who]?.appearances ?? {}).some((a) => eraOf(a) === e);
            if (want !== null && era !== want && has(want))
              push(rule, "rule-appearance-era", file, s.line, `場面 ${sceneName} は ${want} なのに、${who} を ${era ?? "時代の無い"} の立ち絵セット ${appearance} で出しています`, `${sceneName} is ${want}, but ${who} uses ${appearance} (${era ?? "no era"})`, `${who} の ${want} の立ち絵セットにします`, `Use ${who}'s ${want} appearance`);
            if (want === null && era !== null) {
              if (st.eras.size > 0 && !st.eras.has(era))
                push(rule, "rule-appearance-era", file, s.line, `一つの場面に ${[...st.eras].join("・")} と ${era} の立ち絵セットを混ぜています（${who} の ${appearance}）`, `${[...st.eras].join(", ")} and ${era} appearances are mixed in one scene (${who}: ${appearance})`, "場面を分けるか、scenes に時代を書きます", "Split the scene, or set the era in scenes");
              st.eras.add(era);
            }
          }
        }
        if (argOf(registry, s.name, s.args, "solo") === "true") st.sprites.clear();
        st.sprites.set(who, appearance);
      }
      return st;
    };
    walk(script.body, fresh());
  }
  return out;
}
