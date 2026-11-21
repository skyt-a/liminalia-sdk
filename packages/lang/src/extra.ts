import type { Argument, Diagnostic, Inline, Script, Statement } from "./ast.ts";
import { cgShown, redundantCgUnlocks, unlockOf, unshownCg } from "./cg.ts";
import type { ChapterInfo } from "./chapters.ts";
import { CORE_COMMANDS, createRegistry, type Registry } from "./registry.ts";

/**
 * おまけ（鑑賞）の一覧。liminalia.json の extra に書く。タイトルの「おまけ」と @open-screen extra で開く画面が並べる。
 *
 * - cg: CG。images のどれかを @cg-unlock したか、@bg（など CG として解放する印のあるパラメータ）で出したら見られる。見られるのは解放した画像だけ（差分を順に送る）
 * - cgAuto: CG の自動の登録。シナリオが出す、決めたフォルダの画像のうち cg に無いものを、一枚ずつ CG として並べる（expandExtra）
 * - replay: 回想。@replay-unlock id で見られるようにし、target から再生して @replay-end か終わりで戻る
 * - music: 音楽。@bgm で一度鳴らしたら聞ける
 * - achievements: 実績。@achieve id で解放する。hidden は解放するまで名前も説明も伏せる。goal を書くと数を数える実績になり、@achieve-progress で数を進め、goal に届いたら解放する。
 *   endings（エンディングの種類）を書くと、その種類のエンディングを見た数で進める
 * - flowchart: フローチャート・エンディングの一覧・既読率を見せる（台本から作る。true か { titles }）
 * - glossary: 用語集（TIPS）。本文に term・aliases が出たら解放し、本文の中でその語に印を付けて押すと説明を出す。@glossary-unlock id でも解放する
 * - chapters: 章選択。target の最初のページにはじめて着いたら、その時点を控えて解放し、そこから読み直せる（synopsis はあらすじ）
 */
export interface ExtraConfig {
  cg?: ExtraCg[];
  cgAuto?: ExtraCgAuto;
  replay?: ExtraReplay[];
  music?: ExtraMusic[];
  achievements?: ExtraAchievement[];
  flowchart?: boolean | ExtraFlowchart;
  glossary?: ExtraGlossary[];
  chapters?: ExtraChapter[];
  /** 立ち絵の鑑賞（キャラクターの並び）。見た差分だけを見せる。 */
  characters?: ExtraCharacter[];
  /** ムービーの鑑賞（@movie で再生したものを解放する）。 */
  movies?: ExtraMovie[];
  /** エンディングの一覧をおまけのタブに出す（シナリオから作ったフローチャートのエンディング。着いたものだけ名前を出す）。 */
  endings?: boolean;
}

export interface ExtraCharacter {
  /** キャスト名（cast.json の cast）。 */
  who: string;
  /** 一覧に出す名前（省くとキャスト名）。 */
  name?: string;
}

export interface ExtraMovie {
  /** 動画（video からのパス。@movie のファイル）。 */
  file: string;
  title?: string;
  /** 一覧の絵（image からのパス）。 */
  thumb?: string;
  /** 字幕（video からのパス。WebVTT）。 */
  subtitles?: string;
}

export interface ExtraGlossary {
  id: string;
  /** 語（本文に出たら解放し、印を付ける）。 */
  term: string;
  /** 読み（一覧の並びと見出しのルビ）。 */
  reading?: string;
  /** 同じものを指す別の書き方（これが本文に出ても解放し、印を付ける）。 */
  aliases?: string[];
  description: string;
  /** 一覧で見出しにするまとまり。 */
  group?: string;
  /** 本文の中で印を付けるか（既定 true。false なら解放だけ）。 */
  link?: boolean;
}

export interface ExtraChapter {
  /** 章選択の名前。liminalia.json の chapters に同じ id があれば、title を省くとその題になる。 */
  id: string;
  title: string;
  /** 章の始まり（`ファイル` か `ファイル#ラベル`）。 */
  target: string;
  /** あらすじ。 */
  synopsis?: string;
  /** 一覧に出す画像（bgimage からのパス）。 */
  thumb?: string;
}

export interface ExtraFlowchart {
  /** 場面の id（"ファイル#ラベル"）→ フローチャートに出す題（書かなければ場面の最初の本文）。 */
  titles?: Record<string, string>;
}

export interface ExtraCg {
  id: string;
  title?: string;
  /** 一覧で見出しにするまとまり（章など）。同じ group のものを続けて並べる。 */
  group?: string;
  /** 章（liminalia.json の chapters の id）。group を書かなければ、その章の見出し（番号か題）を group にする。 */
  chapter?: string;
  /** 説明（場面の一言など）。 */
  description?: string;
  /** images を探すフォルダ（既定 bgimage）。 */
  folder?: "bgimage" | "fgimage";
  /** 画像（folder からのパス）。一枚目を一覧の縮小画像にする（thumb があればそれ）。 */
  images: string[];
  /** 一覧に出す画像（bgimage からのパス）。 */
  thumb?: string;
  /** cgAuto で足したもの（expandExtra が付ける。liminalia.json には書かない）。 */
  auto?: boolean;
}

export interface ExtraCgAuto {
  /** bgimage の中のフォルダ。シナリオが @bg（など CG として解放する印のあるパラメータ）・@cg-unlock で出したこのフォルダの画像を CG にする。 */
  folder: string;
  /** folder の直下のフォルダの名前 → 一覧の見出し（group）。書いていなければフォルダの名前のまま。 */
  groups?: Record<string, string>;
}

export interface ExtraReplay {
  /** @replay-unlock の名前。 */
  id: string;
  title?: string;
  /** 再生を始める位置（`ファイル`・`ファイル#ラベル`）。 */
  target: string;
  /** 一覧に出す画像（bgimage からのパス）。 */
  thumb?: string;
  /**
   * 再生を始める前に入れる変数（"game.x"・"temp.x" → 値）。本編で決まる値（選んだルート、主人公の名前など）を回想に渡す。
   * 回想の中かどうかは式の replaying() で分かる。
   */
  variables?: Record<string, unknown>;
}

export interface ExtraMusic {
  /** BGM のファイル（bgm からのパス）。 */
  file: string;
  title?: string;
  /** アーティスト（作曲者、歌手など）。 */
  artist?: string;
  /** 曲の説明（音楽室で選んだ曲の下に出す）。 */
  description?: string;
}

export interface ExtraAchievement {
  /** @achieve の名前。 */
  id: string;
  title: string;
  description?: string;
  /** 解放するまで名前と説明を伏せる。 */
  hidden?: boolean;
  /** 一覧に出す画像（image からのパス）。 */
  icon?: string;
  /** 数を数える実績の目標（1 以上の整数）。@achieve-progress で数を進め、この数に届いたら解放する。おまけの一覧に「今の数 / goal」を出す。 */
  goal?: number;
  /**
   * 見たエンディングの数で進める実績（エンディングの種類。"*" はどの種類も）。プレイを終える命令（@title-screen ending=）を動かすたびに、
   * その種類のエンディングを見た数（式の endings() と同じ数え方）を今の数にし、goal に届いたら解放する（@achieve-progress を書かなくてよい）。
   */
  endings?: string;
}

/** 数を数える実績の目標（id → goal）。実行器の achievementGoals に渡す。 */
export function achievementGoals(extra: ExtraConfig | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of Array.isArray(extra?.achievements) ? extra.achievements : []) if (typeof a?.id === "string" && typeof a.goal === "number" && a.goal > 0) out[a.id] = a.goal;
  return out;
}

/** おまけの一覧が参照する素材。 */
export function extraAssetReferences(extra: ExtraConfig | undefined): { folder: string; path: string; where: string }[] {
  const out: { folder: string; path: string; where: string }[] = [];
  for (const c of extra?.cg ?? []) {
    for (const image of c.images ?? []) out.push({ folder: c.folder ?? "bgimage", path: image, where: `extra.cg ${c.id}` });
    if (c.thumb) out.push({ folder: "bgimage", path: c.thumb, where: `extra.cg ${c.id}` });
  }
  for (const r of extra?.replay ?? []) if (r.thumb) out.push({ folder: "bgimage", path: r.thumb, where: `extra.replay ${r.id}` });
  for (const c of extra?.chapters ?? []) if (c.thumb) out.push({ folder: "bgimage", path: c.thumb, where: `extra.chapters ${c.id}` });
  for (const m of extra?.music ?? []) out.push({ folder: "bgm", path: m.file, where: "extra.music" });
  for (const a of extra?.achievements ?? []) if (a.icon) out.push({ folder: "image", path: a.icon, where: `extra.achievements ${a.id}` });
  for (const m of extra?.movies ?? []) {
    out.push({ folder: "video", path: m.file, where: "extra.movies" });
    if (m.thumb) out.push({ folder: "image", path: m.thumb, where: "extra.movies" });
    if (m.subtitles) out.push({ folder: "video", path: m.subtitles, where: "extra.movies" });
  }
  return out;
}

const FILE = "liminalia.json";

/**
 * おまけの一覧の検査。形の崩れ・名前の重なり・回想の始まりの位置が無い、をエラーにする。
 * シナリオの @cg-unlock・@replay-unlock・@achieve が一覧に無い名前を指していたら警告にする（一覧に出ないため）。
 * CG は、どのシナリオも出さず解放もしない画像を警告に、表示したときに解放されるので要らない @cg-unlock を情報にする（cg.ts）。
 * registry は CG として解放する印のあるパラメータを探すコマンドの仕様（省くと組み込みのコマンドだけ）。
 */
/**
 * dataCg は、プラグインが作品のデータから CG として解放する画像（`フォルダ/パス`。@liminalia/lang の dataCgImages）。
 * どこからも出ない CG の検査（unshown-cg）が、これを出しているものとして数える。
 */
export function checkExtra(extra: unknown, scripts: ReadonlyMap<string, Script>, registry: Registry = createRegistry(CORE_COMMANDS), chapters?: readonly ChapterInfo[], dataCg?: ReadonlySet<string>): Diagnostic[] {
  if (extra === undefined) return [];
  const out: Diagnostic[] = [];
  const error = (message: string, hint?: string) => out.push({ severity: "error", code: "bad-extra", message, file: FILE, line: 1, ...(hint ? { hint } : {}) });
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) {
    error("extra はオブジェクトで書きます");
    return out;
  }
  const e = extra as Record<string, unknown>;
  const list = <T>(key: string): T[] => {
    const v = e[key];
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      error(`extra.${key} は配列で書きます`);
      return [];
    }
    return v as T[];
  };
  const ids = (key: string, items: { id?: unknown }[]) => {
    const seen = new Set<string>();
    for (const item of items) {
      if (typeof item?.id !== "string" || item.id === "") error(`extra.${key} に id のないものがあります`);
      else if (seen.has(item.id)) error(`extra.${key} の id ${item.id} が重複しています`);
      else seen.add(item.id);
    }
    return seen;
  };
  // 章の情報（liminalia.json の chapters）の id
  const chapterIds = new Set(Array.isArray(chapters) ? chapters.flatMap((c) => (typeof c?.id === "string" ? [c.id] : [])) : []);
  const cg = list<ExtraCg>("cg");
  ids("cg", cg);
  const auto = e.cgAuto as Partial<ExtraCgAuto> | undefined;
  if (auto !== undefined) {
    if (!auto || typeof auto !== "object" || Array.isArray(auto) || typeof auto.folder !== "string" || auto.folder === "") error("extra.cgAuto は { \"folder\": \"bgimage の中のフォルダ\" } の形で書きます", '"cgAuto": { "folder": "stills" }');
    else if (auto.groups !== undefined && (!auto.groups || typeof auto.groups !== "object" || Array.isArray(auto.groups) || Object.values(auto.groups).some((v) => typeof v !== "string"))) error("extra.cgAuto.groups はフォルダの名前 → 見出しの文字列で書きます");
  }
  const autoPrefix = auto && typeof auto.folder === "string" && auto.folder !== "" ? `${auto.folder.replace(/\/+$/, "")}/` : null;
  for (const c of cg) if (!Array.isArray(c?.images) || c.images.length === 0 || c.images.some((i) => typeof i !== "string")) error(`extra.cg ${c?.id ?? ""} に images（画像のパスの配列）がありません`);
  for (const c of cg) if (c?.chapter !== undefined && !chapterIds.has(c.chapter)) error(`extra.cg ${c?.id ?? ""} の chapter ${String(c.chapter)} が liminalia.json の chapters にありません`);
  const replay = list<ExtraReplay>("replay");
  const replayIds = ids("replay", replay);
  for (const r of replay) {
    if (typeof r?.target !== "string" || r.target === "") {
      error(`extra.replay ${r?.id ?? ""} に target（再生を始める位置）がありません`);
      continue;
    }
    const [file = "", label] = r.target.split("#");
    const script = scripts.get(file);
    if (!script) error(`extra.replay ${r.id} の target のファイル ${file} がありません`);
    else if (label !== undefined && !labelsOf(script.body).has(label)) error(`extra.replay ${r.id} の target のラベル #${label} が ${file} にありません`);
    const vars = r.variables;
    if (vars !== undefined) {
      if (!vars || typeof vars !== "object" || Array.isArray(vars)) error(`extra.replay ${r.id} の variables は "game.x" → 値 の形で書きます`, '"variables": { "game.route": "a" }');
      else for (const key of Object.keys(vars)) if (!/^(game|temp)\.[\p{ID_Start}_][\p{ID_Continue}_]*$/u.test(key)) error(`extra.replay ${r.id} の variables の ${key} は game.x か temp.x の形で書きます`);
    }
  }
  if (e.endings !== undefined && typeof e.endings !== "boolean") error("extra.endings は true か false で書きます");
  const flowchart = e.flowchart;
  if (flowchart !== undefined && typeof flowchart !== "boolean") {
    const titles = (flowchart as ExtraFlowchart | null)?.titles;
    if (!flowchart || typeof flowchart !== "object" || Array.isArray(flowchart) || (titles !== undefined && (!titles || typeof titles !== "object" || Object.values(titles).some((v) => typeof v !== "string")))) {
      error('extra.flowchart は true か { "titles": { "ファイル#ラベル": "タイトル" } } で書きます');
    }
  }
  const glossary = list<ExtraGlossary>("glossary");
  const glossaryIds = ids("glossary", glossary);
  for (const g of glossary) {
    if (typeof g?.term !== "string" || g.term === "") error(`extra.glossary ${g?.id ?? ""} に term（用語）がありません`);
    if (typeof g?.description !== "string") error(`extra.glossary ${g?.id ?? ""} に description（説明）がありません`);
    if (g?.aliases !== undefined && (!Array.isArray(g.aliases) || g.aliases.some((a) => typeof a !== "string" || a === ""))) error(`extra.glossary ${g?.id ?? ""} の aliases は文字列の配列で書きます`);
  }
  const extraChapters = list<ExtraChapter>("chapters");
  ids("chapters", extraChapters);
  for (const c of extraChapters) {
    if ((typeof c?.title !== "string" || c.title === "") && !chapterIds.has(c?.id)) error(`extra.chapters ${c?.id ?? ""} に title がありません`);
    if (typeof c?.target !== "string" || c.target === "") {
      error(`extra.chapters ${c?.id ?? ""} に target（章の始まりの位置）がありません`);
      continue;
    }
    const [file = "", label] = c.target.split("#");
    const script = scripts.get(file);
    if (!script) error(`extra.chapters ${c.id} の target のファイル ${file} がありません`);
    else if (label !== undefined && !labelsOf(script.body).has(label)) error(`extra.chapters ${c.id} の target のラベル #${label} が ${file} にありません`);
  }
  const music = list<ExtraMusic>("music");
  for (const m of music) if (typeof m?.file !== "string" || m.file === "") error("extra.music に file のないものがあります");
  const characters = list<ExtraCharacter>("characters");
  for (const c of characters) if (typeof c?.who !== "string" || c.who === "") error("extra.characters に who（キャスト名）のないものがあります");
  const movies = list<ExtraMovie>("movies");
  for (const m of movies) if (typeof m?.file !== "string" || m.file === "") error("extra.movies に file のないものがあります");
  const achievements = list<ExtraAchievement>("achievements");
  const achievementIds = ids("achievements", achievements);
  for (const a of achievements) if (typeof a?.title !== "string" || a.title === "") error(`extra.achievements ${a?.id ?? ""} に title がありません`);
  for (const a of achievements) if (a?.goal !== undefined && (typeof a.goal !== "number" || !Number.isInteger(a.goal) || a.goal < 1)) error(`extra.achievements ${a?.id ?? ""} の goal は 1 以上の整数で書きます`);
  const goalIds = new Set(achievements.flatMap((a) => (typeof a?.id === "string" && typeof a.goal === "number" ? [a.id] : [])));

  // シナリオの解放の命令が、一覧に無い名前を指していないか
  const cgImages = new Set(cg.flatMap((c) => (Array.isArray(c?.images) ? c.images : [])));
  for (const [name, script] of scripts) {
    for (const s of commands(script.body)) {
      const first = s.args[0];
      const value = first && first.key === null && first.value.kind === "string" ? first.value.value : null;
      if (value === null) continue;
      const warn = (message: string) => out.push({ severity: "warning", code: "not-in-extra", message, file: name, line: s.line });
      if (s.name === "glossary-unlock" && e.glossary !== undefined && !glossaryIds.has(value)) warn(`用語 ${value} が liminalia.json の extra.glossary にありません（おまけに表示されません）`);
      if (s.name === "achieve" && !achievementIds.has(value)) warn(`実績 ${value} が liminalia.json の extra.achievements にありません（おまけに表示されません）`);
      if (s.name === "achieve-progress" && !achievementIds.has(value)) warn(`実績 ${value} が liminalia.json の extra.achievements にありません（おまけに表示されません）`);
      else if (s.name === "achieve-progress" && !goalIds.has(value)) warn(`実績 ${value} に goal（数える目標）がありません（数を進めても解除されません）`);
      if (s.name === "replay-unlock" && e.replay !== undefined && !replayIds.has(value)) warn(`回想 ${value} が liminalia.json の extra.replay にありません（おまけに表示されません）`);
      if (s.name === "cg-unlock" && e.cg !== undefined && !cgImages.has(value) && !(autoPrefix && value.startsWith(autoPrefix))) warn(`CG ${value} が liminalia.json の extra.cg の images にありません（おまけに表示されません）`);
    }
  }
  // 形の崩れた一覧では CG の出どころを見ない（上のエラーを先に直す）
  if (out.some((d) => d.severity === "error")) return out;
  const config = e as ExtraConfig;
  out.push(...unshownCg(config, scripts, registry, dataCg), ...redundantCgUnlocks(scripts, config, registry));
  return out;
}

/** ロードの直後に呼び出す位置（liminalia.json の afterLoad）が、あるファイル・ラベルを指しているか。 */
export function checkAfterLoad(target: unknown, scripts: ReadonlyMap<string, Script>): Diagnostic[] {
  if (target === undefined) return [];
  const error = (message: string) => [{ severity: "error" as const, code: "bad-after-load", message, file: FILE, line: 1, hint: "\"afterLoad\": \"common#after_load\"" }];
  if (typeof target !== "string" || target === "") return error("afterLoad は `ファイル#ラベル` の文字列で書きます");
  const [file = "", label] = target.split("#");
  const script = scripts.get(file);
  if (!script) return error(`afterLoad のファイル ${file} がありません`);
  if (label !== undefined && !labelsOf(script.body).has(label)) return error(`afterLoad のラベル #${label} が ${file} にありません`);
  return [];
}

function labelsOf(body: Statement[], out = new Set<string>()): Set<string> {
  for (const s of body) {
    if (s.kind === "label") out.add(s.name);
    if (s.kind === "if") for (const b of s.branches) labelsOf(b.body, out);
  }
  return out;
}

/** 行のコマンドと、本文・選択肢の中のコマンド（{@…}）。@if・@define の中も。 */
function* commands(body: Statement[]): Generator<{ name: string; args: Argument[]; line: number }> {
  for (const s of body) {
    if (s.kind === "command") yield s;
    if (s.kind === "say" || s.kind === "prose") yield* inlineCommands(s.content, s.line);
    if (s.kind === "choice") for (const o of s.options) yield* inlineCommands(o.content, o.line);
    if (s.kind === "if") for (const b of s.branches) yield* commands(b.body);
    if (s.kind === "define") yield* commands(s.body);
  }
}

function* inlineCommands(nodes: readonly Inline[], line: number): Generator<{ name: string; args: Argument[]; line: number }> {
  for (const n of nodes) {
    if (n.kind === "command") yield { name: n.name, args: n.args, line };
    else if ("children" in n) yield* inlineCommands(n.children, line);
  }
}

/**
 * シナリオが出す背景の画像（@bg など CG として解放する印のあるパラメータと @cg-unlock に、文字列で書いたもの。@if・@define の中も）を、
 * 物語の順に重なりなく並べる。順はファイルの名前の順（数字は数として比べる。chapter4_10 は chapter4_9 の後）、ファイルの中は書いた順。
 * registry は印のあるパラメータを探すコマンドの仕様（省くと組み込みのコマンドだけ）。
 */
export function shownImages(scripts: Iterable<readonly [string, Script]>, registry: Registry = createRegistry(CORE_COMMANDS)): string[] {
  const seen = new Set<string>();
  const sorted = [...scripts].sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }));
  for (const [, script] of sorted) {
    for (const s of commands(script.body)) {
      if (s.name === "cg-unlock") {
        const u = unlockOf(s.args);
        if (u && u !== "dynamic" && u.folder === "bgimage") seen.add(u.image);
        continue;
      }
      for (const shown of cgShown(registry.get(s.name), s.args).shown) if (shown.folder === "bgimage") seen.add(shown.image);
    }
  }
  return [...seen];
}

/**
 * cgAuto を一覧に広げる。shown（shownImages）のうち cgAuto.folder の下にあって cg のどれにも無い画像を、一枚ずつの CG（auto: true）として足す。
 * 足す場所は、物語でその画像の前に出した CG の後ろ（見出しが違えば、同じ見出しの並びの中の近いところ）。cg に書いたものの順は変えない。
 * cgAuto が無ければ extra をそのまま返す。
 */
export function expandExtra(extra: ExtraConfig | undefined, shown: readonly string[]): ExtraConfig | undefined {
  const auto = extra?.cgAuto;
  if (!extra || !auto || typeof auto.folder !== "string" || auto.folder === "") return extra;
  const prefix = `${auto.folder.replace(/\/+$/, "")}/`;
  const list: ExtraCg[] = [...(Array.isArray(extra.cg) ? extra.cg : [])];
  const entryOf = new Map<string, ExtraCg>();
  for (const c of list) for (const image of Array.isArray(c?.images) ? c.images : []) if (!entryOf.has(image)) entryOf.set(image, c);
  // 物語でこの画像の前に出した CG（全体と、見出しごと）
  let anchor: ExtraCg | null = null;
  const anchorOf = new Map<string | undefined, ExtraCg>();
  for (const image of shown) {
    const known = entryOf.get(image);
    if (known) {
      anchor = known;
      anchorOf.set(known.group, known);
      continue;
    }
    if (!image.startsWith(prefix)) continue;
    const rest = image.slice(prefix.length);
    const sub = rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : null;
    const group = sub === null ? undefined : (auto.groups?.[sub] ?? sub);
    const entry: ExtraCg = { id: `auto:${image}`, ...(group !== undefined ? { group } : {}), images: [image], auto: true };
    list.splice(insertAt(list, anchor, anchorOf.get(group), group), 0, entry);
    entryOf.set(image, entry);
    anchor = entry;
    anchorOf.set(group, entry);
  }
  return { ...extra, cg: list };
}

/**
 * 足す CG の置き場所。前に出した CG の後ろ。それと見出しが違う（回想で前の章の CG を出した後など）ときは、
 * 同じ見出しで前に出した CG の後ろ、それも無ければ同じ見出しの最初の前、同じ見出しが無ければ前に出した CG の後ろ。
 */
function insertAt(list: readonly ExtraCg[], anchor: ExtraCg | null, sameGroup: ExtraCg | undefined, group: string | undefined): number {
  if (anchor && anchor.group === group) return list.indexOf(anchor) + 1;
  if (sameGroup) return list.indexOf(sameGroup) + 1;
  const first = list.findIndex((c) => c.group === group);
  if (first >= 0) return first;
  return anchor ? list.indexOf(anchor) + 1 : 0;
}
