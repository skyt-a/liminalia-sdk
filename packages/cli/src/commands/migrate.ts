import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  collectTranslatable,
  CORE_COMMANDS,
  createRegistry,
  ENDING_KIND_LABELS,
  endingKindOfText,
  endingKinds,
  migrateCommandDefaults,
  migrateEndingSource,
  migrateSource,
  OTHER_ENDING,
  parse,
  projectTextKey,
  queryKind,
  SCRIPT_FORMAT,
  translationKey,
  voiceLines,
  type EndingChange,
  type MigrationChange,
  type Registry,
  type TranslationEntry,
  type TranslationFile,
  type Script,
  type VoiceLock,
} from "@liminalia/lang";
import { assertScenariosUtf8, CONFIG_FILE, listScenarioFiles, loadCommandPlugins, loadProject, projectPacks, readCast, readScenarioFile } from "@liminalia/project";
import { combinePlugins } from "@liminalia/plugin-host";
import { BEHAVIOR_CHANGES, behaviorCandidates, setAt, type BehaviorCandidate } from "../behavior-changes.ts";

/** 英語の数と名詞（1 なら単数）。 */
const pl = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`;

/** 移したもの（台本の行と、liminalia.json の項目）。 */
export interface MigrateReport {
  /**
   * 今の書式の版と、作品の liminalia.json の format（省いていれば null。1 以上の整数でなければ null で、書いてあった値を was に）。
   */
  format: { from: number | null; to: number; was?: unknown };
  files: { file: string; changes: MigrationChange[] }[];
  /**
   * プレイを終える命令の ending= を、文言から種類と title= に移したもの（書式の版 3。@liminalia/lang の migrateEndingSource）。
   * whole は文言全体が種類だったもの。そうでなく種類が bad などのものは、文言の頭から種類を読んだもの（title を確かめる）。
   */
  endings: { file: string; changes: EndingChange[] }[];
  /** 画面の文言を前と同じにするため、liminalia.json の endingKinds に書いた文言（前の文言が種類の既定の文言と違ったもの）。 */
  endingKinds: { kind: string; label: string }[];
  /** 種類の表記がそろっていないので、既定の文言のままにした種類と、その表記。 */
  endingSpellings: { kind: string; spellings: string[] }[];
  /** liminalia.json の playtest.avoidEndings の、文言から種類に移したもの。 */
  avoidEndings: { from: string; to: string }[];
  /**
   * 訳のファイル（lang/*.json とパックの packs/<id>/lang/*.json）の鍵を移したもの。to は移した先（title の鍵、作品の設定の文字の鍵、ui の鍵）。null は外したもの。
   * kept は前の鍵も残したもの（本体とパックの同じ名前の台本の、移らなかった側がまだ前の鍵を使う）。
   */
  translations: { file: string; moved: { from: string; to: string | null; kept?: true }[] }[];
  commandDefaults: { from: string; to: string }[];
  /** commandDefaults の前の名前（fade）で、同じ所に今の名前（time）もあるので外したもの（"chara.fade"。値は使われていなかった）。 */
  commandDefaultsDropped: { from: string; kept: string }[];
  /** liminalia.json の import.ink.commands と import.yarn.commands の型の、前の名前の引数を移したもの（"ink.flash" など）。 */
  importCommands: string[];
  /**
   * ボイスの番号の固定（voice-lock.json）の、原文が変わった台詞の鍵と原文を移したもの（番号はそのまま。要再収録の印は付けない）。
   * 読めない voice-lock.json は移さない（lim check が bad-voice-lock で知らせる）。kept は、移らなかった台本がまだ前の鍵を使うので、前の鍵も残した数（moved のうち）。
   */
  voiceLock?: { file: string; moved: number; kept: number };
  /**
   * 0.1.17 までの整形の設定（format の中の indent と expressions）を fmt に移したもの。moved は移した鍵、
   * dropped は fmt に同じ鍵がすでにあったので外した鍵（fmt のほうを使う）。
   */
  fmt?: { moved: string[]; dropped: string[] };
  /** UTF-8 で読めず、移さなかった台本。 */
  skipped: string[];
  /**
   * 作品の書式の版から今までに、既定の見た目や動きが変わったもの（behavior-changes.ts）。setting があれば --keep-behavior で前の動きにする設定を書け、
   * 書いたものは kept。setting の無いものは設定では戻せない（manual の手順）。
   */
  behavior: BehaviorCandidate[];
}

/** 前の動きを残すもの（true はすべて、並びはその id だけ）。 */
export type KeepBehavior = true | readonly string[];

/**
 * 作品を今の書式に移したものを求める（書き換えはしない）。前の版の命令の名前を今の名前にし（@liminalia/lang の RENAMED_COMMANDS。
 * 作品に同じ名前のマクロがあれば変えない）、liminalia.json の commandDefaults の名前も直し、format を今の版にする。
 * format が 0.1.17 までの整形の設定（`"format": { "indent": 2, "expressions": false }`）なら、中身を fmt に移してから数にする
 * （fmt があれば足りない鍵だけ）。format の値が 1 以上の整数でなければ、JSON を書き直して置き換える（字面に format を足すと同じ鍵が二つになる）。
 * プレイを終える命令の ending= の文言は、種類と title= に移す（`ending="BAD END"` → `ending=bad`、`ending="通り雨"` → `ending=other title="通り雨"`）。
 * 前の文言が種類の既定の文言と違えば（Bad End、バッドエンドなど。表記がそろっていれば）、画面の文言を前と同じにするため endingKinds に書く。
 * playtest.avoidEndings の文言も種類にし、訳のファイルの鍵も移す（moveEndingTranslations）。
 * パック（packs/<id>/）の台本も同じに移し、訳（本体の lang とパックの lang）とボイスの番号の固定（本体の voice-lock.json）を移す。
 */
export async function planMigration(dir: string, o: { keepBehavior?: KeepBehavior } = {}): Promise<{ report: MigrateReport; texts: Map<string, string>; config: string | null; langs: Map<string, string> }> {
  const project = loadProject(dir, { skipBrokenPlugins: true });
  // プレイを終える命令（作品のプラグインの命令も）の仕様
  const plugins = combinePlugins(await loadCommandPlugins(project, { skipBroken: true }).catch(() => []));
  const registry: Registry = createRegistry(CORE_COMMANDS, plugins.specs);
  const scenario = project.paths.scenario;
  const files = listScenarioFiles(scenario);
  const sources = new Map<string, { path: string; text: string }>();
  const skipped: string[] = [];
  for (const { name, path } of files) {
    const { text, encoding } = readScenarioFile(path);
    if (encoding) {
      skipped.push(`${name}.lim`);
      continue;
    }
    sources.set(name, { path, text });
  }
  // パック（packs/*/scenario）の台本も移す（報告の名前は作品のフォルダからのパス）
  const packs = projectPacks(project);
  const packSources = new Map<string, { path: string; text: string; name: string; pack: string }>();
  for (const pack of packs) {
    for (const { name, path } of listScenarioFiles(join(pack, "scenario"))) {
      const shown = `${relative(project.root, path).split(sep).join("/")}`;
      const { text, encoding } = readScenarioFile(path);
      if (encoding) skipped.push(shown);
      else packSources.set(shown, { path, text, name, pack });
    }
  }
  // 作品のマクロ（@define）の名前。前の版の名前と同じマクロは、作品のマクロとして使っているので変えない。
  // 台本は、そのファイルと @use したファイルのマクロだけを呼べる（ほかのファイルでは組み込みの命令が動く）ので、ファイルごとに見る
  const parsed = new Map<string, Script>();
  for (const [name, { text }] of sources) parsed.set(name, parse(text, name));
  for (const [shown, { text, name }] of packSources) parsed.set(shown, parse(text, name));
  const definesIn = (script: Script | undefined) => new Set((script?.body ?? []).flatMap((s) => (s.kind === "define" && s.name !== "" ? [s.name] : [])));
  const macros = new Set<string>();
  for (const script of parsed.values()) for (const m of definesIn(script)) macros.add(m);
  /** そのファイル（key は parsed の鍵）で呼べるマクロ（自分と @use したファイル。パックの台本は同じパックの台本を先に探す）。 */
  const macrosFor = (key: string, packDir?: string): Set<string> => {
    const script = parsed.get(key);
    const out = definesIn(script);
    for (const s of script?.body ?? []) {
      if (s.kind !== "use") continue;
      const inPack = packDir !== undefined ? [...packSources].find(([, p]) => p.name === s.file && p.path.startsWith(packDir))?.[0] : undefined;
      for (const m of definesIn(parsed.get(inPack ?? s.file))) out.add(m);
    }
    return out;
  };
  const texts = new Map<string, string>();
  const changed: MigrateReport["files"] = [];
  const configPath = join(project.root, CONFIG_FILE);
  const raw = readFileSync(configPath, "utf8");
  const json = JSON.parse(raw) as Record<string, unknown>;
  const kinds = endingKinds(json.endingKinds);
  const endings: MigrateReport["endings"] = [];
  /** 移したあとの台本（台本の名前 → 中身。パックが同じ名前で本体の台本を差し替えるときは両方。訳の鍵を移すのに使う）。 */
  const after = new Map<string, string[]>();
  const keepAfter = (name: string, text: string) => after.set(name, [...(after.get(name) ?? []), text]);
  /**
   * 訳の鍵を移すもの（どこの台本か → 移した結末の文言と、原文が変わった本文の行と選択肢）。"" は本体、ほかはパックのフォルダ。
   * 結末の file は台本の名前（訳の鍵の名前）にする（報告の endings はパックの台本を作品のフォルダからのパスで出す）。
   */
  const moves = new Map<string, { endings: MigrateReport["endings"]; lines: Map<string, MovedLine> }>();
  const movesOf = (origin: string) => moves.get(origin) ?? moves.set(origin, { endings: [], lines: new Map() }).get(origin)!;
  /** 行の中の命令（{@bg … fade=1s}）を書き換えて原文が変わった本文の行と選択肢の、前の訳の鍵 → 今の鍵と原文。台詞の鍵は話者で変わる */
  let speakers: string[] = [];
  try {
    speakers = readCast(project).speakers;
  } catch {
    // 読めない cast.json は lim check が知らせる。話者なしで読み、台詞の訳は移さない
  }
  /** 原文が変わった台詞（ボイスの番号の固定の鍵と原文を移す）。 */
  const voiceMoves: { from: string; to: string; before: string; source: string }[] = [];
  /**
   * 移したあとの本体とパックの台本が使う、訳の鍵とボイスの番号の固定の鍵（鍵 → 原文）。本体とパックの同じ名前の台本は同じ鍵を作るので、
   * 片方だけが移らない（その台本だけで呼べる、組み込みと同じ名前のマクロがあるなど）とき、移らない側がまだ使う前の鍵は消さずに残す。
   * 訳の鍵は台本ごと（どこの台本か → 台本の名前 → 鍵 → 原文）に持ち、訳のファイルごとに、その訳を使う台本だけで見る（liveLinesFor）
   */
  const add = (map: Map<string, Set<string>>, key: string, source: string) => (map.get(key) ?? map.set(key, new Set()).get(key)!).add(source);
  const liveLines = new Map<string, Map<string, Map<string, Set<string>>>>();
  const liveVoices = new Map<string, Set<string>>();
  const addLive = (origin: string, text: string, name: string, said: readonly string[]) => {
    const script = parse(text, name, { speakers: [...said] });
    const keys = new Map<string, Set<string>>();
    for (const t of collectTranslatable(script, registry)) add(keys, t.key, t.source);
    (liveLines.get(origin) ?? liveLines.set(origin, new Map()).get(origin)!).set(name, keys);
    for (const l of voiceLines(script)) add(liveVoices, l.key, l.source);
  };
  /**
   * その訳のファイル（"" は本体の lang、ほかはそのパックの lang）を使う台本の訳の鍵 → 原文。本体の訳は、本体とすべてのパックの台本
   * （パックに訳が無ければ本体の訳を使う）。パックの訳は、本体にそのパックを重ねた台本（パックを入れると本体の訳と丸ごと入れ替わる。
   * 同じ名前の本体の台本はパックのもので差し替わる）と、ほかのパックの台本（lim check の検査と同じ数え方）。
   */
  const liveLinesFor = (origin: string): Map<string, Set<string>> => {
    const out = new Map<string, Set<string>>();
    const own = liveLines.get(origin);
    for (const [o, scripts] of liveLines) {
      for (const [name, keys] of scripts) {
        if (origin !== "" && o === "" && own?.has(name)) continue;
        for (const [key, set] of keys) for (const source of set) add(out, key, source);
      }
    }
    return out;
  };
  for (const [name, { path, text }] of sources) {
    const own = macrosFor(name);
    const r = migrateSource(text, own);
    const m = movesOf("");
    if (r.changes.length > 0) changed.push({ file: `${name}.lim`, changes: r.changes });
    if (r.changes.length > 0) for (const [from, to] of renamedLineKeys(text, r.text, name, registry, speakers)) m.lines.set(from, { ...to, macros: own });
    // ending= の文言を種類と title= に
    const e = migrateEndingSource(r.text, parse(r.text, name), registry, kinds);
    if (e.changes.length > 0) {
      endings.push({ file: `${name}.lim`, changes: e.changes });
      m.endings.push({ file: `${name}.lim`, changes: e.changes });
    }
    if (r.changes.length > 0 || e.changes.length > 0) texts.set(path, e.text);
    if (r.changes.length > 0) voiceMoves.push(...movedVoiceLines(text, r.text, name, speakers));
    keepAfter(name, e.text);
    addLive("", e.text, name, speakers);
  }
  // パックの台本も、本体の台本と同じに訳とボイスの番号の固定を移す。訳の鍵とボイスの鍵は台本の名前で作る（遊ぶ側と同じ）。
  // パックはボイスの番号の固定を持たず、遊ぶ側はパックの台詞にも本体の voice-lock.json を使う
  for (const [shown, { path, text, name, pack }] of packSources) {
    const own = macrosFor(shown, pack);
    const said = packSpeakers(pack, speakers);
    const r = migrateSource(text, own);
    const m = movesOf(pack);
    if (r.changes.length > 0) changed.push({ file: shown, changes: r.changes });
    if (r.changes.length > 0) for (const [from, to] of renamedLineKeys(text, r.text, name, registry, said)) m.lines.set(from, { ...to, macros: own });
    const e = migrateEndingSource(r.text, parse(r.text, name), registry, kinds);
    if (e.changes.length > 0) {
      endings.push({ file: shown, changes: e.changes });
      m.endings.push({ file: `${name}.lim`, changes: e.changes });
    }
    if (r.changes.length > 0 || e.changes.length > 0) texts.set(path, e.text);
    if (r.changes.length > 0) voiceMoves.push(...movedVoiceLines(text, r.text, name, said));
    keepAfter(name, e.text);
    addLive(pack, e.text, name, said);
  }
  // 画面の文言を前と同じにする: 種類ごとの前の表記が一つにそろっていて、既定の文言と違えば endingKinds に書く
  const spellings = new Map<string, Set<string>>();
  for (const f of endings) for (const c of f.changes) if (c.phrase !== undefined && c.kind !== OTHER_ENDING) (spellings.get(c.kind) ?? spellings.set(c.kind, new Set()).get(c.kind)!).add(c.phrase);
  const labels: MigrateReport["endingKinds"] = [];
  const uneven: MigrateReport["endingSpellings"] = [];
  for (const [kind, set] of spellings) {
    if (kind in kinds.labels) continue;
    const list = [...set];
    if (list.length > 1) uneven.push({ kind, spellings: list });
    else if (list[0] !== ENDING_KIND_LABELS[kind]) labels.push({ kind, label: list[0]! });
  }
  // playtest.avoidEndings の文言を種類に
  const playtest = json.playtest && typeof json.playtest === "object" && !Array.isArray(json.playtest) ? (json.playtest as Record<string, unknown>) : null;
  const avoid = Array.isArray(playtest?.avoidEndings) ? (playtest!.avoidEndings as unknown[]) : null;
  const avoided: MigrateReport["avoidEndings"] = [];
  const nextAvoid = avoid?.map((q) => {
    if (typeof q !== "string") return q;
    const kind = queryKind(q, kinds);
    if (typeof kind !== "string" || kind === q) return q;
    avoided.push({ from: q, to: kind });
    return kind;
  });
  // 訳のファイルの鍵
  const langs = new Map<string, string>();
  const translations: MigrateReport["translations"] = [];
  if ([...moves.values()].some((m) => m.endings.length > 0 || m.lines.size > 0)) {
    // 訳のフォルダのすべての訳のファイル（languages に書く前の訳も）と、パックの訳（packs/<id>/lang/<言語>.json。パックを入れると、その言語の本体の訳と丸ごと入れ替わる）。
    // 本体の訳はパックが訳を持たないときパックの台本にも使われ、パックの訳は本体の台本にも使われるので、どの訳にもすべての台本の移したものを当てる。
    // 同じ鍵の移し先が台本で違うとき（本体とパックの同じ名前の台本が違う形に移ったとき）は、その訳の持ち主（本体かそのパック）の台本の移し方を先にする
    const files = [{ dir: project.paths.lang, origin: "" }, ...packs.map((pack) => ({ dir: join(pack, "lang"), origin: pack }))];
    const labelMap = new Map(labels.map((l) => [l.kind, l.label]));
    for (const { dir, origin } of files) {
      const names = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")).sort() : [];
      const order = [origin, ...[...moves.keys()].filter((o) => o !== origin)].flatMap((o) => moves.get(o) ?? []);
      const lineKeys = new Map<string, MovedLine>();
      for (const m of order) for (const [from, to] of m.lines) if (!lineKeys.has(from)) lineKeys.set(from, to);
      const endingMoves = order.flatMap((m) => m.endings);
      for (const name of names) {
        const path = join(dir, name);
        let file: TranslationFile;
        try {
          file = JSON.parse(readFileSync(path, "utf8")) as TranslationFile;
        } catch {
          // 読めない訳のファイルは移さない（lim check が bad-translation で知らせる）
          continue;
        }
        const moved = [...moveEndingTranslations(file, endingMoves, after, registry, labelMap), ...moveLineTranslations(file, lineKeys, liveLinesFor(origin))];
        if (moved.length === 0) continue;
        langs.set(path, `${JSON.stringify(file, null, 2)}\n`);
        translations.push({ file: relative(project.root, path).split(sep).join("/"), moved });
      }
    }
  }
  const value = json.format;
  const from = typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
  // 書式の版でない format（前の整形の設定、文字、小数など）は、字面を足さずに JSON を書き直して置き換える
  const invalid = value !== undefined && from === null;
  const fmt = invalid ? movedFormatSettings(value, json.fmt) : null;
  const defaults = json.commandDefaults && typeof json.commandDefaults === "object" && !Array.isArray(json.commandDefaults) ? migrateCommandDefaults(json.commandDefaults as Record<string, unknown>, macros) : null;
  const renamed = defaults?.changes ?? [];
  const dropped = defaults?.dropped ?? [];
  // 取り込み（lim import-ink、lim import-yarn）の命令の型の前の名前の引数（"@mask fade={1:s}"）
  const imports = migrateImportCommands(json.import, macros);
  // ボイスの番号の固定の鍵と原文
  let voiceLock: MigrateReport["voiceLock"];
  if (voiceMoves.length > 0 && existsSync(project.paths.voiceLock)) {
    let lock: VoiceLock | null = null;
    try {
      lock = JSON.parse(readFileSync(project.paths.voiceLock, "utf8")) as VoiceLock;
    } catch {
      // 読めない voice-lock.json は移さない（lim check が bad-voice-lock で知らせる）
    }
    const moved = lock?.lines ? moveVoiceLock(lock, voiceMoves, liveVoices) : { moved: 0, kept: 0 };
    if (lock && moved.moved > 0) {
      langs.set(project.paths.voiceLock, `${JSON.stringify(lock, null, 2)}\n`);
      voiceLock = { file: relative(project.root, project.paths.voiceLock).split(sep).join("/"), ...moved };
    }
  }
  // 既定の動きが変わったもの（前の書式の作品だけ）。選んだものは前の動きにする設定を書く
  const behavior = behaviorCandidates(from, { config: json, scripts: new Map([...sources].map(([name, s]) => [name, s.text])) });
  if (o.keepBehavior && o.keepBehavior !== true) {
    const known = new Set(behavior.filter((b) => b.setting).map((b) => b.id));
    const unknown = o.keepBehavior.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      const all = BEHAVIOR_CHANGES.map((b) => b.id);
      throw new Error(`--keep-behavior の ${unknown.join("、")} は、この作品で前の動きに戻せるものではありません（戻せるもの: ${[...known].join("、") || "なし"}。すべての名前: ${all.join("、")}）`);
    }
  }
  const keep = behavior.filter((b) => b.setting && (o.keepBehavior === true || (o.keepBehavior ?? []).includes(b.id)));
  for (const b of keep) b.kept = true;
  let config: string | null = null;
  if (renamed.length > 0 || dropped.length > 0 || imports.changes.length > 0 || invalid || labels.length > 0 || avoided.length > 0 || keep.length > 0) {
    // JSON を書き直す（並びはそのまま。fmt と endingKinds が無かったら build の前に置く）
    const next = Object.fromEntries(
      Object.entries(json).map(([k, v]) => [
        k,
        k === "commandDefaults" && defaults ? defaults.defaults : k === "fmt" && fmt ? fmt.fmt : k === "playtest" && avoided.length > 0 ? { ...playtest, avoidEndings: [...new Set(nextAvoid)] } : k === "import" && imports.changes.length > 0 ? imports.value : v,
      ]),
    );
    if (fmt && !("fmt" in json)) placeBefore(next, "fmt", fmt.fmt, "build");
    if (labels.length > 0) {
      const own = { ...((json.endingKinds as Record<string, string> | undefined) ?? {}), ...Object.fromEntries(labels.map((l) => [l.kind, l.label])) };
      if ("endingKinds" in json) next.endingKinds = own;
      else placeBefore(next, "endingKinds", own, "build");
    }
    for (const b of keep) {
      // 中のオブジェクトは写してから書く（元の json と分ける）
      const top = b.setting!.path[0]!;
      next[top] = structuredClone(next[top] ?? {});
      if (!setAt(next, b.setting!.path, b.setting!.value)) b.kept = false;
    }
    if (from === null || from < SCRIPT_FORMAT) withFormat(next);
    config = `${JSON.stringify(next, null, 2)}\n`;
  } else if (from === null || from < SCRIPT_FORMAT) {
    config = setFormatText(raw, json);
  }
  const report: MigrateReport = {
    format: { from, to: SCRIPT_FORMAT, ...(invalid ? { was: value } : {}) },
    files: changed,
    endings,
    endingKinds: labels,
    endingSpellings: uneven,
    avoidEndings: avoided,
    translations,
    commandDefaults: renamed,
    commandDefaultsDropped: dropped,
    importCommands: imports.changes,
    ...(voiceLock ? { voiceLock } : {}),
    ...(fmt ? { fmt: { moved: fmt.moved, dropped: fmt.dropped } } : {}),
    skipped,
    behavior,
  };
  return { report, texts, config, langs };
}

/** 原文が変わった本文の行と選択肢の、今の鍵と原文（before は前の原文。macros は訳の中の命令を移すときのマクロ）。 */
export interface MovedLine {
  key: string;
  source: string;
  before: string;
  macros?: ReadonlySet<string>;
}

/**
 * 書き換えの前と後の台本の、原文が変わった本文の行と選択肢（行の中の {@chara-hide ユイ fade=1s} を time= にしたものなど）の、
 * 前の訳の鍵 → 今の鍵と原文。行の数は変わらないので、同じ行の同じ種類の項目を順に組にする。
 * 固定の行 ID の行は鍵が変わらないので、前と同じ鍵で今の原文を返す（訳の原文と訳の中の命令を移すため）。
 */
export function renamedLineKeys(before: string, after: string, name: string, registry: Registry, speakers: readonly string[] = []): Map<string, MovedLine> {
  const place = (list: ReturnType<typeof collectTranslatable>) => {
    const out = new Map<string, { key: string; source: string }>();
    const count = new Map<string, number>();
    for (const t of list) {
      if (t.kind !== "line" && t.kind !== "option") continue;
      const at = `${t.line}:${t.kind}`;
      const n = count.get(at) ?? 0;
      count.set(at, n + 1);
      out.set(`${at}:${n}`, { key: t.key, source: t.source });
    }
    return out;
  };
  const was = place(collectTranslatable(parse(before, name, { speakers: [...speakers] }), registry));
  const now = place(collectTranslatable(parse(after, name, { speakers: [...speakers] }), registry));
  const out = new Map<string, MovedLine>();
  for (const [at, old] of was) {
    const next = now.get(at);
    if (next && (next.key !== old.key || next.source !== old.source)) out.set(old.key, { ...next, before: old.source });
  }
  return out;
}

/**
 * パックの台本を読むときの話者。パックが cast.json を持てば、遊ぶ側はそれで本体の cast.json を丸ごと差し替えるので、その話者も足す
 * （読めなければ本体の話者だけ。lim pack も本体の話者で読む）。
 */
function packSpeakers(pack: string, speakers: readonly string[]): string[] {
  const path = join(pack, "cast.json");
  if (!existsSync(path)) return [...speakers];
  try {
    const own = (JSON.parse(readFileSync(path, "utf8")) as { speakers?: unknown }).speakers;
    return [...new Set([...speakers, ...(Array.isArray(own) ? own.filter((s): s is string => typeof s === "string") : [])])];
  } catch {
    // 読めないパックの cast.json は、本体の話者で読む（lim pack もパックの台本を本体の話者で確かめる）
    return [...speakers];
  }
}

/** 書き換えの前と後の台本の、原文が変わった台詞の、ボイスの番号の固定の鍵（前 → 今）と原文。行の数は変わらないので行で組にする。 */
function movedVoiceLines(before: string, after: string, name: string, speakers: readonly string[]): { from: string; to: string; before: string; source: string }[] {
  const was = new Map(voiceLines(parse(before, name, { speakers: [...speakers] })).map((l) => [l.line, l]));
  const out: { from: string; to: string; before: string; source: string }[] = [];
  for (const l of voiceLines(parse(after, name, { speakers: [...speakers] }))) {
    const old = was.get(l.line);
    if (old && old.source !== l.source) out.push({ from: old.key, to: l.key, before: old.source, source: l.source });
  }
  return out;
}

/**
 * ボイスの番号の固定（lock を書き換える）の、原文が変わった台詞の鍵と原文を移す。番号はそのままで、要再収録の印は付けない（話す文は変わっていない）。
 * 固定の原文が移す前の原文と違うもの（固定のあとで書き換えた台詞）と、移す先に固定があるものは移さない。
 * 移したあとの台本（live。鍵 → 原文）がまだ前の鍵と原文を使う（本体とパックの同じ名前の台本の、移らなかった側）なら、前の鍵を残して新しい鍵を足す。
 * 鍵が同じまま原文だけ変わる台詞（固定の行 ID）は、移らなかった側がまだ前の原文を使うなら変えない。移した数と、そのうち前の鍵も残した数を返す。
 */
function moveVoiceLock(lock: VoiceLock, moves: readonly { from: string; to: string; before: string; source: string }[], live: ReadonlyMap<string, ReadonlySet<string>>): { moved: number; kept: number } {
  let moved = 0;
  let kept = 0;
  for (const m of moves) {
    const entry = lock.lines[m.from];
    if (!entry || entry.source !== m.before || (m.to !== m.from && lock.lines[m.to])) continue;
    const used = live.get(m.from)?.has(m.before) === true;
    if (used && m.to === m.from) continue;
    if (used) kept++;
    else delete lock.lines[m.from];
    lock.lines[m.to] = { ...entry, source: m.source };
    moved++;
  }
  return { moved, kept };
}

/**
 * liminalia.json の import.ink.commands と import.yarn.commands（取り込みの命令の型）の、前の名前の引数を今の名前にする（"@mask fade={1:s}" → "time="）。
 * 型の中の {1} などは値の字面として読む。value は書き換えた import。
 */
function migrateImportCommands(raw: unknown, macros: ReadonlySet<string>): { value: unknown; changes: string[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { value: raw, changes: [] };
  const changes: string[] = [];
  const value: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const kind of ["ink", "yarn"]) {
    const section = value[kind];
    if (!section || typeof section !== "object" || Array.isArray(section)) continue;
    const commands = (section as { commands?: unknown }).commands;
    if (!commands || typeof commands !== "object" || Array.isArray(commands)) continue;
    const next: Record<string, unknown> = {};
    for (const [name, template] of Object.entries(commands as Record<string, unknown>)) {
      if (typeof template !== "string") {
        next[name] = template;
        continue;
      }
      const r = migrateSource(template, macros);
      if (r.changes.length > 0) changes.push(`${kind}.${name}`);
      next[name] = r.text;
    }
    value[kind] = { ...(section as Record<string, unknown>), commands: next };
  }
  return { value, changes };
}

/**
 * 訳のファイルの、原文が変わった本文の行と選択肢の訳を今の鍵へ移す（file を書き換え、移した鍵を返す）。訳の中の行の命令も同じに書き換える。
 * 今の鍵に訳があれば、前の訳は外すだけにする。固定の行 ID の行（鍵が同じ）は、訳の原文が移す前の原文と同じときだけ、原文と訳の中の命令を移す
 * （訳のあとで原文を書き換えた項目は、今までどおり原文が変わった訳として残す）。
 * live（移したあとの、この訳を使う台本の鍵 → 原文）がまだ前の鍵と原文を使うなら（本体とパックの同じ名前の台本の、移らなかった側）、前の訳を残して
 * 新しい鍵に写す（kept）。新しい鍵をこの訳を使う台本が使わなければ写さない（パックが差し替える本体の台本だけが移ったときの、パックの訳）。
 * 固定の行 ID の行でまだ前の原文を使う台本があれば、変えない。
 */
export function moveLineTranslations(file: TranslationFile, keys: ReadonlyMap<string, MovedLine>, live?: ReadonlyMap<string, ReadonlySet<string>>): { from: string; to: string | null; kept?: true }[] {
  const lines = file.lines;
  if (!lines || keys.size === 0) return [];
  const moved: { from: string; to: string | null; kept?: true }[] = [];
  for (const [from, to] of keys) {
    const entry = lines[from];
    if (!entry) continue;
    const macros = to.macros ?? new Set<string>();
    const used = live?.get(from)?.has(to.before) === true;
    if (from === to.key) {
      if (entry.source !== to.before || used) continue;
      lines[from] = { ...entry, source: to.source, text: typeof entry.text === "string" ? migrateSource(entry.text, macros).text : entry.text };
      moved.push({ from, to: to.key });
      continue;
    }
    if (used && live && !live.has(to.key)) continue;
    if (!used) delete lines[from];
    if (!lines[to.key] || lines[to.key]!.text === "") {
      lines[to.key] = { ...entry, source: to.source, text: typeof entry.text === "string" ? migrateSource(entry.text, macros).text : entry.text };
    }
    moved.push(used ? { from, to: to.key, kept: true } : { from, to: to.key });
  }
  return moved;
}

/**
 * 訳のファイルの、移した ending= の文言の訳を移す（file を書き換え、移した鍵を返す）。
 * - other とその文言の title=（「通り雨」）: 鍵は同じ（ファイルと原文から作る）なので、そのまま使われる
 * - 文言の頭が種類で、続きを title= にしたもの（「BAD END 2：沈黙」）: 訳の頭の種類も外せれば外して title の鍵へ。外せなければ訳を空にし、前の訳を previous に添える
 * - 文言全体が種類（「BAD END」）: 文言を endingKinds に書いたなら、その訳を作品の設定の文字の鍵へ。既定の文言のままなら、訳が既定の文言と違うときだけ
 *   ui の ending.kinds.<種類> へ（そろっていなければ最初のもの）
 * 移したあとの台本で使わなくなった鍵は外す。
 */
export function moveEndingTranslations(file: TranslationFile, endings: MigrateReport["endings"], after: ReadonlyMap<string, readonly string[]>, registry: Registry, labels: ReadonlyMap<string, string>): { from: string; to: string | null }[] {
  const lines = (file.lines ??= {});
  const moved: { from: string; to: string | null }[] = [];
  const used = new Map<string, Set<string>>();
  const usedIn = (name: string): Set<string> => {
    let set = used.get(name);
    // パックが同じ名前で本体の台本を差し替えるときは、どちらかで使う鍵を残す
    if (!set) used.set(name, (set = new Set((after.get(name) ?? []).flatMap((text) => collectTranslatable(parse(text, name), registry).map((t) => t.key)))));
    return set;
  };
  const put = (key: string, entry: TranslationEntry) => {
    if (!lines[key] || lines[key]!.text === "") lines[key] = entry;
  };
  for (const f of endings) {
    const name = f.file.replace(/\.lim$/, "");
    for (const c of f.changes) {
      const key = translationKey(name, "arg", c.from);
      const entry = lines[key];
      if (!entry) continue;
      const text = typeof entry.text === "string" ? entry.text : "";
      const keep = { ...(entry.note ? { note: entry.note } : {}), ...(entry.contexts ? { contexts: entry.contexts } : {}) };
      let to: string | null = null;
      if (c.title !== undefined && c.title !== c.from) {
        // 頭の種類を外した続きを title にした
        const next = translationKey(name, "arg", c.title);
        const read = text ? endingKindOfText(text) : null;
        put(next, read && read.kind === c.kind && read.title ? { source: c.title, text: read.title, ...keep } : { source: c.title, text: "", ...keep, ...(text ? { previous: { source: c.from, text } } : {}) });
        to = next;
      } else if (c.title === undefined && text !== "") {
        const label = labels.get(c.kind);
        if (label !== undefined) {
          // 画面の文言を endingKinds に書いた: 作品の設定の文字として訳す
          const next = projectTextKey(label);
          put(next, { source: label, text, note: "endingKinds" });
          to = next;
        } else if (text !== ENDING_KIND_LABELS[c.kind]) {
          const ui = (file.ui ??= {});
          const uiKey = `ending.kinds.${c.kind}`;
          if (ui[uiKey] === undefined) ui[uiKey] = text;
          to = `ui:${uiKey}`;
        }
      }
      if (to === key) continue;
      if (!usedIn(name).has(key)) {
        delete lines[key];
        moved.push({ from: key, to });
      } else if (to !== null) moved.push({ from: key, to });
    }
  }
  return moved;
}

/**
 * 0.1.17 までの整形の設定（format の中の indent と expressions）を fmt に移したもの。fmt に同じ鍵があれば fmt のほうを残す。
 * format がオブジェクトでなければ null。
 */
function movedFormatSettings(format: unknown, current: unknown): { fmt: Record<string, unknown>; moved: string[]; dropped: string[] } | null {
  if (!format || typeof format !== "object" || Array.isArray(format)) return null;
  const fmt = current && typeof current === "object" && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {};
  const moved: string[] = [];
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(format as Record<string, unknown>)) {
    if (Object.hasOwn(fmt, k)) dropped.push(k);
    else {
      fmt[k] = v;
      moved.push(k);
    }
  }
  return { fmt, moved, dropped };
}

/** json の鍵 before の前に key を足す（before が無ければ末尾）。 */
function placeBefore(json: Record<string, unknown>, key: string, value: unknown, before: string): void {
  const entries = Object.entries(json).filter(([k]) => k !== key);
  const at = entries.findIndex(([k]) => k === before);
  entries.splice(at < 0 ? entries.length : at, 0, [key, value]);
  for (const k of Object.keys(json)) delete json[k];
  Object.assign(json, Object.fromEntries(entries));
}

/** format を今の版にする（id の次に置く）。 */
function withFormat(json: Record<string, unknown>): void {
  const entries = Object.entries(json).filter(([k]) => k !== "format");
  const at = Math.max(0, entries.findIndex(([k]) => k === "version") + 1 || entries.findIndex(([k]) => k === "title") + 1);
  entries.splice(at, 0, ["format", SCRIPT_FORMAT]);
  for (const k of Object.keys(json)) delete json[k];
  Object.assign(json, Object.fromEntries(entries));
}

/**
 * liminalia.json の字面の format だけを書き換える（無ければ version か title の行の次に足す）。ほかの書き方はそのまま。
 * format が 1 以上の整数か、書いていないときだけ使う（ほかの値は planMigration が JSON を書き直す）。
 */
function setFormatText(raw: string, json: Record<string, unknown>): string {
  if (typeof json.format === "number") {
    const number = /("format"\s*:\s*)-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/;
    if (number.test(raw)) return raw.replace(number, `$1${SCRIPT_FORMAT}`);
  }
  const rows = raw.split("\n");
  const key = "version" in json ? "version" : "title";
  const i = rows.findIndex((r) => new RegExp(`^\\s*"${key}"\\s*:`).test(r));
  if (i >= 0 && /,\s*$/.test(rows[i]!)) {
    const indent = /^\s*/.exec(rows[i]!)![0];
    rows.splice(i + 1, 0, `${indent}"format": ${SCRIPT_FORMAT},`);
    return rows.join("\n");
  }
  const next = { ...json };
  withFormat(next);
  return `${JSON.stringify(next, null, 2)}\n`;
}

/**
 * lim migrate [プロジェクト] [--check] [--json] — 台本を今の書式に移す（前の版の命令の名前を今の名前に、ending= の文言を種類と title= に、
 * liminalia.json の format を今の版に。訳のファイルの鍵も移す）。
 * --check は書き換えずに、移すものがあれば false（CI で前の書き方が残っていないかを見る）。
 */
export async function runMigrate(dir: string, o: { check: boolean; json: boolean; language?: "ja" | "en"; keepBehavior?: KeepBehavior }): Promise<boolean> {
  const en = o.language === "en";
  // UTF-8 で読めない台本があれば、ほかの台本と format も書き換えずに止める（format だけ今の版にすると、その台本の前の書き方が残ったまま通る）
  assertScenariosUtf8(loadProject(dir, { skipBrokenPlugins: true }).paths.scenario, en ? "en" : "ja");
  const { report, texts, config, langs } = await planMigration(dir, o.keepBehavior ? { keepBehavior: o.keepBehavior } : {});
  const pending = report.files.length > 0 || report.endings.length > 0 || report.commandDefaults.length > 0 || report.commandDefaultsDropped.length > 0 || config !== null || langs.size > 0;
  if (!o.check) {
    for (const [path, text] of [...texts, ...langs]) {
      writeFileSync(`${path}.tmp`, text);
      renameSync(`${path}.tmp`, path);
    }
    if (config !== null) {
      const path = join(loadProject(dir, { skipBrokenPlugins: true }).root, CONFIG_FILE);
      writeFileSync(`${path}.tmp`, config);
      renameSync(`${path}.tmp`, path);
    }
  }
  if (o.json) {
    console.log(JSON.stringify({ ok: !o.check || !pending, written: !o.check && pending, ...report }, null, 2));
    return !o.check || !pending;
  }
  const shown = (file: string) => relative(process.cwd(), join(dir, file)).split(sep).join("/") || file;
  for (const f of report.files) for (const c of f.changes) console.log(`${f.file}:${c.line}  @${c.from} → @${c.to}`);
  // ending= の文言を種類と title= に
  for (const f of report.endings)
    for (const c of f.changes) {
      const now = `ending=${c.kind}${c.title !== undefined ? ` title=${JSON.stringify(c.title)}` : ""}`;
      const guessed = !c.whole && c.kind !== OTHER_ENDING;
      console.log(`${f.file}:${c.line}  ending=${JSON.stringify(c.from)} → ${now}${guessed ? (en ? " (kind read from the start of the text; check the title)" : "（種類は文言の頭から読みました。title を確かめます）") : ""}`);
    }
  for (const l of report.endingKinds) console.log(en ? `${CONFIG_FILE}  endingKinds.${l.kind}: ${JSON.stringify(l.label)} (keeps the wording on screen)` : `${CONFIG_FILE}  endingKinds.${l.kind}: ${JSON.stringify(l.label)}（画面の文言を前と同じにします）`);
  for (const u of report.endingSpellings)
    console.log(en ? `${CONFIG_FILE}  ${u.kind}: written as ${u.spellings.join(", ")}; the screen shows the kind's default wording (set it in endingKinds to change it)` : `${CONFIG_FILE}  ${u.kind}: 表記が ${u.spellings.join("、")} とそろっていないため、画面は種類の既定の文言にします（替えるなら endingKinds に書きます）`);
  for (const a of report.avoidEndings) console.log(`${CONFIG_FILE}  playtest.avoidEndings: ${a.from} → ${a.to}`);
  for (const t of report.translations)
    for (const m of t.moved) {
      if (m.to === null) console.log(en ? `${t.file}  ${m.from}: removed (no longer used)` : `${t.file}  ${m.from}: 外します（今の台本で使わない訳）`);
      else if (m.kept) console.log(en ? `${t.file}  ${m.from} → ${m.to} (the old key is kept too; a scenario that wasn't migrated still uses it)` : `${t.file}  ${m.from} → ${m.to}（前の鍵も残します。移らない台本がまだ使います）`);
      else console.log(`${t.file}  ${m.from} → ${m.to}`);
    }
  for (const c of report.commandDefaults) console.log(`${CONFIG_FILE}  commandDefaults.${c.from} → ${c.to}`);
  for (const d of report.commandDefaultsDropped) console.log(en ? `${CONFIG_FILE}  commandDefaults.${d.from}: removed (not used; ${d.kept} is set)` : `${CONFIG_FILE}  commandDefaults.${d.from}: 外します（${d.kept} があり、使われていません）`);
  for (const c of report.importCommands) console.log(en ? `${CONFIG_FILE}  import.${c.replace(".", ".commands.")}: the parameter names were updated` : `${CONFIG_FILE}  import.${c.replace(".", ".commands.")}: 引数の名前を今の名前にしました`);
  if (report.voiceLock)
    console.log(
      en
        ? `${report.voiceLock.file}  moved the keys of ${pl(report.voiceLock.moved, "line")} whose text changed (the numbers stay the same${report.voiceLock.kept > 0 ? `; the old keys of ${report.voiceLock.kept} are kept too, since a scenario that wasn't migrated still uses them` : ""})`
        : `${report.voiceLock.file}  原文が変わった ${report.voiceLock.moved} 行の鍵を移しました（番号はそのまま${report.voiceLock.kept > 0 ? `。うち ${report.voiceLock.kept} 行は、移らない台本がまだ使うので前の鍵も残しました` : ""}）`,
    );
  // 0.1.17 までの整形の設定（format の中）は fmt へ
  for (const k of report.fmt?.moved ?? []) console.log(`${CONFIG_FILE}  format.${k} → fmt.${k}`);
  for (const k of report.fmt?.dropped ?? []) console.log(en ? `${CONFIG_FILE}  format.${k}: removed (fmt.${k} is already set)` : `${CONFIG_FILE}  format.${k}: 外します（fmt.${k} があるため）`);
  const was = "was" in report.format ? JSON.stringify(report.format.was) : (report.format.from ?? (en ? "(none)" : "（なし）"));
  // 書式の版が変わるときだけ出す（ほかの項目だけを書き直すときに format: 4 → 4 と出さない）
  if (config !== null && report.format.from !== report.format.to) console.log(`${CONFIG_FILE}  format: ${was} → ${report.format.to}`);
  for (const f of report.skipped) console.log(en ? `${f}: not UTF-8, skipped` : `${f}: UTF-8 で読めないため移しませんでした`);
  printBehavior(report.behavior, o.check, en);
  const count = report.files.reduce((n, f) => n + f.changes.length, 0) + report.endings.reduce((n, f) => n + f.changes.length, 0);
  const fileCount = new Set([...report.files, ...report.endings].map((f) => f.file)).size;
  if (!pending) console.log(en ? `Already in the current format (format ${SCRIPT_FORMAT})` : `今の書式（format ${SCRIPT_FORMAT}）です。移すものはありません`);
  else if (o.check && count === 0) console.log(en ? `\n${CONFIG_FILE} has settings to migrate. Run lim migrate ${shown(".")} to rewrite it` : `\n${CONFIG_FILE} に移すものがあります。lim migrate ${shown(".")} で書き換えます`);
  else if (o.check) console.log(en ? `\n${pl(count, "line")} to migrate. Run lim migrate ${shown(".")} to rewrite them` : `\n移す行が ${count} 行あります。lim migrate ${shown(".")} で書き換えます`);
  else if (count === 0) console.log(en ? `\nMigrated ${CONFIG_FILE} to format ${SCRIPT_FORMAT}` : `\n${CONFIG_FILE} を、今の書式（format ${SCRIPT_FORMAT}）に移しました`);
  else console.log(en ? `\nMigrated ${pl(count, "line")} in ${pl(fileCount, "file")} to format ${SCRIPT_FORMAT}` : `\n${fileCount} ファイルの ${count} 行を、今の書式（format ${SCRIPT_FORMAT}）に移しました`);
  return !o.check || !pending;
}

/** 既定の動きが変わったものを出す（書いた設定、戻せる候補、設定では戻せないもの）。 */
function printBehavior(behavior: readonly BehaviorCandidate[], check: boolean, en: boolean): void {
  if (behavior.length === 0) return;
  const value = (v: unknown) => JSON.stringify(v);
  const kept = behavior.filter((b) => b.kept);
  const open = behavior.filter((b) => b.setting && !b.kept);
  const manual = behavior.filter((b) => !b.setting);
  for (const b of kept) {
    const path = b.setting!.path.join(".");
    console.log(en ? `${CONFIG_FILE}  ${path}: ${value(b.setting!.value)} (keeps the behavior before ${b.version}: ${b.id})` : `${CONFIG_FILE}  ${path}: ${value(b.setting!.value)}（${b.version} より前の動きを残します: ${b.id}）`);
  }
  if (open.length > 0) {
    console.log(en ? `\nDefaults that changed since this project's format (to keep the old behavior, add --keep-behavior, or --keep-behavior ${open[0]!.id},… for some):` : `\nこの作品の書式から既定が変わったもの（前の動きを残すなら --keep-behavior。一部だけなら --keep-behavior ${open[0]!.id},…）:`);
    for (const b of open) console.log(`  ${b.id} (${b.version}): ${en ? b.text.en : b.text.ja}\n    ${en ? "keep with" : "残す設定"}: ${b.setting!.path.join(".")} = ${value(b.setting!.value)}`);
    if (!check) console.log(en ? "  (after migrating, the project is in the current format, so this list isn't shown again)" : "  （移すと今の書式になるので、この一覧はもう出ません）");
  }
  if (manual.length > 0) {
    console.log(en ? "\nChanges a setting can't undo:" : "\n設定では戻せない変更:");
    for (const b of manual) console.log(`  ${b.id} (${b.version}): ${en ? b.text.en : b.text.ja}${b.manual ? `\n    ${en ? b.manual.en : b.manual.ja}` : ""}`);
  }
}
