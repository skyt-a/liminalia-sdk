import { parseExpr, type DataDeclaration, type Expr } from "@liminalia/lang";
import { truthy, type CommandContext, type Value } from "@liminalia/runtime";
import { d, t, type CommandDefinition } from "@liminalia/plugin-host";

/**
 * 図鑑（記録・用語集・持ち物の説明など）。データは data/codex.json。
 * - 項目は条件の式（if）が真になるか、@codex-unlock で開く。持ち物の項目（item）は持っている間開く
 * - 項目の本文は段（sections）に分け、段ごとの条件（if）か @codex-unlock id section=… で少しずつ開く（段階的な開示）
 * - 開いたものはこのプレイの記録（ゲームの変数の、式からは書けない @codex）と、全セーブ共通の記録（system.codex_unlocked）に残す。
 *   おまけから開く図鑑は、全セーブ共通の記録を見せる
 * - 新しく開いた項目と段には、図鑑で読むまで「新」の印を付け、開いたときに知らせる（data の notify を false にすると知らせない）
 * 画面は std の描画（./web の codex.ts）が持つ。メニューとおまけに並び、@codex か @open-screen codex で開く。
 */

export interface CodexSection {
  /** 名前（@codex-unlock id section=名前 で開くとき。無ければ並びの番号）。 */
  id?: string;
  title?: string;
  titleEn?: string;
  text: string;
  textEn?: string;
  /** 開く条件の式。無ければ、locked でない限り項目と一緒に開く。 */
  if?: string;
  /** 条件が無くても、@codex-unlock で開くまで伏せる。 */
  locked?: boolean;
}

/** 相関図の線（項目から to の項目へ）。 */
export interface CodexLink {
  /** 線の先の項目（id）。 */
  to: string;
  label?: string;
  labelEn?: string;
  /** 線の種類（positive 良好・negative 対立・neutral 中立。既定 neutral）。 */
  tone?: "positive" | "negative" | "neutral";
  /** 出す条件の式（無ければ両端の項目が開いていれば出す）。 */
  if?: string;
}

export interface CodexEntry {
  id: string;
  /** categories の id。 */
  category: string;
  title: string;
  titleEn?: string;
  /** 読み（読みの順で並べる区分と、用語の並び）。 */
  reading?: string;
  /** 絵（image フォルダからのパス）。 */
  image?: string;
  /** 一覧に出す短い説明。 */
  summary?: string;
  summaryEn?: string;
  /** 開く条件の式。 */
  if?: string;
  /** 持ち物の名前（liminalia.json の items）。持っている間は開く。 */
  item?: string;
  /** 別名（用語集）。 */
  terms?: string[];
  sections?: CodexSection[];
  /** 関連する項目（id）。 */
  related?: string[];
  /** 年表の日付（並びの見出しに出す文字。「1923年9月」など）。 */
  date?: string;
  dateEn?: string;
  /** 年表の並びの順（小さいほど上。無ければ書いた順）。 */
  order?: number;
  /** 相関図と地図の位置（区分の図の左上からの割合。0〜100）。 */
  x?: number;
  y?: number;
  /** 相関図の線（この項目から出る線）。 */
  links?: CodexLink[];
}

/** 区分の見せ方（list 一覧、timeline 年表、relations 相関図、map 地図）。 */
export const CODEX_TYPES = ["list", "timeline", "relations", "map"] as const;
export type CodexType = (typeof CODEX_TYPES)[number];

export interface CodexCategory {
  id: string;
  label: string;
  labelEn?: string;
  /** order: 書いた順、reading: 読みの順（一覧のときだけ）。 */
  sort?: "order" | "reading";
  /** 見せ方（既定 list）。timeline は項目の date・order で年表に、relations は項目の x・y と links で相関図に、map は地図の絵の上の x・y に並べる。 */
  type?: CodexType;
  /** 地図の絵（type が map のとき。bgimage からのパス。無ければ前の置き場所の image から）。相関図の背景にも使える。 */
  map?: string;
}

export interface CodexData {
  title?: string;
  titleEn?: string;
  /** 開いたときに知らせる（既定 true）。 */
  notify?: boolean;
  categories: CodexCategory[];
  entries: CodexEntry[];
}

export const CODEX_FILE = "codex.json";
/** このプレイの記録（ゲームの変数の、式からは書けない名前）。 */
export const CODEX_KEY = "@codex";
/** 全セーブ共通の記録（システム変数）。 */
export const CODEX_SYSTEM_KEY = "codex_unlocked";

const L = (label: string, labelEn: string, doc?: string, docEn?: string) => ({ label, labelEn, ...(doc ? { doc } : {}), ...(docEn ? { docEn } : {}) });

/** data/codex.json の形の宣言。 */
export const CODEX_DATA: DataDeclaration = {
  file: CODEX_FILE,
  title: "図鑑",
  titleEn: "Codex",
  root: d.record({
    title: d.string(L("画面の見出し", "Screen title"), { translate: true }),
    titleEn: d.string(L("画面の見出し（英語）", "Screen title (English)")),
    notify: d.bool(L("開いたら知らせる", "Notify on unlock")),
    categories: d.list(
      d.record(
        {
          id: d.required(d.string(L("ID", "Id"))),
          label: d.required(d.string(L("見出し", "Label"), { translate: true })),
          labelEn: d.string(L("見出し（英語）", "Label (English)")),
          type: d.enum([...CODEX_TYPES], L("見せ方", "Layout", "list 一覧、timeline 年表、relations 相関図、map 地図", "list, timeline, relations (relationship chart) or map")),
          sort: d.enum(["order", "reading"], L("並べ方", "Sort", "一覧のときだけ", "Only for list")),
          map: d.asset("bgimage", L("地図の絵", "Map image", "地図のときの絵（相関図の背景にもなる）。地図の選択と同じく bgimage から探し、無ければ前の置き場所の image から探す", "The image for a map (also a background for relations). Looked up in bgimage like map choices, then in image, where it used to go"), { also: ["image"] }),
        },
        L("区分", "Category"),
        { title: "label" },
      ),
      L("区分", "Categories"),
      { sortable: true, key: "id" },
    ),
    entries: d.list(
      d.record(
        {
          id: d.required(d.string(L("ID", "Id"))),
          category: d.required(d.ref("/categories", L("区分", "Category"))),
          title: d.required(d.string(L("名前", "Title"), { translate: true })),
          titleEn: d.string(L("名前（英語）", "Title (English)")),
          reading: d.string(L("読み", "Reading")),
          image: d.asset("image", L("絵", "Image")),
          summary: d.text(L("短い説明", "Summary"), { translate: true }),
          summaryEn: d.text(L("短い説明（英語）", "Summary (English)")),
          if: d.expr(L("開く条件", "Unlock if", "真になったら開く。@codex-unlock でも開く", "Opens when true. @codex-unlock also opens it")),
          item: d.string(L("持ち物", "Item", "liminalia.json の items の名前。持っている間は開く", "A name in items of liminalia.json; open while held")),
          terms: d.list(d.string(), L("別名", "Aliases")),
          sections: d.list(
            d.record(
              {
                id: d.string(L("ID", "Id")),
                title: d.string(L("見出し", "Heading"), { translate: true }),
                titleEn: d.string(L("見出し（英語）", "Heading (English)")),
                text: d.required(d.text(L("本文", "Text"), { translate: true })),
                textEn: d.text(L("本文（英語）", "Text (English)")),
                if: d.expr(L("開く条件", "Unlock if")),
                locked: d.bool(L("@codex-unlock で開くまで伏せる", "Hidden until @codex-unlock")),
              },
              L("段", "Section"),
              { title: "title" },
            ),
            L("本文の段", "Sections"),
            { sortable: true },
          ),
          related: d.list(d.ref("/entries", L("項目", "Entry")), L("関連する項目", "Related")),
          date: d.string(L("年表の日付", "Timeline date", "年表のときの見出し（1923年9月 など）", "Shown in a timeline (September 1923 and so on)"), { translate: true }),
          dateEn: d.string(L("年表の日付（英語）", "Timeline date (English)")),
          order: d.number(L("年表の順", "Timeline order", "小さいほど上（無ければ書いた順）", "Smaller comes first (written order if missing)")),
          at: d.point(L("位置", "Position", "相関図と地図の上の位置。押した所に置き、x と y に書く", "Position in a relations chart or map. Click to place it; written to x and y"), { image: "category>map", keys: ["x", "y"] }),
          x: d.number(L("横の位置", "X", "相関図と地図の位置。図の左からの割合（0〜100）", "Position in a relations chart or map, from the left (0 to 100)"), { min: 0, max: 100 }),
          y: d.number(L("縦の位置", "Y", "相関図と地図の位置。図の上からの割合（0〜100）", "Position in a relations chart or map, from the top (0 to 100)"), { min: 0, max: 100 }),
          links: d.list(
            d.record(
              {
                to: d.required(d.ref("/entries", L("線の先", "To"))),
                label: d.string(L("関係", "Relation"), { translate: true }),
                labelEn: d.string(L("関係（英語）", "Relation (English)")),
                tone: d.enum(["positive", "negative", "neutral"], L("線の種類", "Tone", "positive 良好、negative 対立、neutral 中立", "positive, negative or neutral")),
                if: d.expr(L("出す条件", "Show if")),
              },
              L("線", "Link"),
              { title: "label" },
            ),
            L("相関図の線", "Relations"),
            { sortable: true },
          ),
        },
        L("項目", "Entry"),
        { title: "title" },
      ),
      L("項目", "Entries"),
      { sortable: true, key: "id" },
    ),
  }),
};

type Scope = Record<string, Value>;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** データを読む（形の合わないものは null）。 */
export function readCodex(data: unknown): CodexData | null {
  if (!isRecord(data) || !Array.isArray(data.entries)) return null;
  return { ...(data as unknown as CodexData), categories: Array.isArray(data.categories) ? (data.categories as CodexCategory[]) : [] };
}

/** 段の鍵（`項目#名前` か `項目#番号`）。 */
export const sectionKey = (entry: CodexEntry, s: CodexSection, i: number) => `${entry.id}#${s.id ?? i}`;

/** このプレイの記録（unlocked: @codex-unlock で開いたもの、seen: 読んだもの、known: 開いたと知らせたもの）。 */
export function codexRecord(game: Scope): { unlocked: Scope; seen: Scope; known: Scope | null } {
  const r = isRecord(game[CODEX_KEY]) ? (game[CODEX_KEY] as Scope) : (game[CODEX_KEY] = {});
  const part = (k: string) => (isRecord(r[k]) ? (r[k] as Scope) : (r[k] = {}));
  return { unlocked: part("unlocked"), seen: part("seen"), known: isRecord(r.known) ? (r.known as Scope) : null };
}

/** 知らせた記録を作る（はじめて見るときは、そのとき開いているものを知らせずに入れる）。 */
export function codexKnown(game: Scope): Scope {
  const r = isRecord(game[CODEX_KEY]) ? (game[CODEX_KEY] as Scope) : (game[CODEX_KEY] = {});
  return isRecord(r.known) ? (r.known as Scope) : (r.known = {});
}

/** 開いている項目と段と、相関図の線。 */
export interface CodexShown {
  entry: CodexEntry;
  sections: { section: CodexSection; key: string }[];
  /** 出す相関図の線（両端の項目が開いていて、条件が真か、全セーブ共通の記録に残っているもの）。key は `項目>線の先`。 */
  links: { link: CodexLink; key: string }[];
}

/** 線の鍵（`項目>線の先`）。 */
export const linkKey = (entry: CodexEntry, link: CodexLink) => `${entry.id}>${link.to}`;

const exprs = new Map<string, Expr | null>();
/** 式を読む（読めなければ null。検査が知らせる）。 */
export function codexExpr(src: string): Expr | null {
  let e = exprs.get(src);
  if (e === undefined) {
    try {
      e = parseExpr(src);
    } catch {
      e = null;
    }
    exprs.set(src, e);
  }
  return e;
}

/**
 * 今開いているもの。evaluate は条件の式を評価する関数（遊んでいないなら null: unlocked だけで決める）。
 * items は持ち物の数（ゲームの変数の @items）。
 */
export function codexShown(data: CodexData, o: { evaluate: ((e: Expr) => Value) | null; unlocked: Scope; items?: Scope }): CodexShown[] {
  const cond = (src: string | undefined) => {
    if (!src || !o.evaluate) return false;
    const e = codexExpr(src);
    try {
      return e ? truthy(o.evaluate(e)) : false;
    } catch {
      return false;
    }
  };
  const out: CodexShown[] = [];
  for (const entry of data.entries) {
    if (!isRecord(entry) || typeof entry.id !== "string") continue;
    const held = !!entry.item && o.evaluate !== null && typeof o.items?.[entry.item] === "number" && (o.items[entry.item] as number) > 0;
    if (!(o.unlocked[entry.id] === true || cond(entry.if) || held)) continue;
    const sections = (entry.sections ?? []).flatMap((section, i) => {
      const key = sectionKey(entry, section, i);
      // 遊んでいない（おまけ）なら、全セーブ共通の記録に残っている段だけ
      const open = o.unlocked[key] === true || (o.evaluate !== null && (section.if ? cond(section.if) : section.locked !== true));
      return open ? [{ section, key }] : [];
    });
    out.push({ entry, sections, links: [] });
  }
  // 相関図の線（両端が開いているもの）
  const open = new Set(out.map((s) => s.entry.id));
  for (const s of out) {
    for (const link of Array.isArray(s.entry.links) ? s.entry.links : []) {
      if (!isRecord(link) || typeof link.to !== "string" || !open.has(link.to)) continue;
      const key = linkKey(s.entry, link);
      if (o.unlocked[key] === true || (o.evaluate !== null && (link.if ? cond(link.if) : true)) || (o.evaluate === null && !link.if)) s.links.push({ link, key });
    }
  }
  return out;
}

const SCOPES = new Set(["game", "system", "temp"]);
/** ページごとに変わりうる関数（読んだか・言語・場所など）。これを読む条件はページを出すたびに見る。 */
const PAGE_FUNCTIONS = new Set(["read", "lang", "platform", "app", "replaying", "chapter", "year", "month", "day", "hour", "minute", "weekday", "now", "random", "rand"]);

/**
 * 条件の式が読むもの。game.x・system.x・temp.x（頭から二つ。添字が式なら game などの全体）、持ち物は game.@items、
 * visits()・chosen() は visits・chosen、ページごとに変わるもの（read() など）は page、分からないもの（局所変数）は *。
 */
export function exprReads(e: Expr, out = new Set<string>()): Set<string> {
  switch (e.kind) {
    case "literal":
      break;
    case "name":
      out.add(SCOPES.has(e.name) ? e.name : "*");
      break;
    case "member":
    case "index": {
      if (e.kind === "index") exprReads(e.index, out);
      // 変数の頭（game.x）まで下りる
      let o: Expr = e;
      while ((o.kind === "member" || o.kind === "index") && (o.object.kind === "member" || o.object.kind === "index")) {
        if (o.object.kind === "index") exprReads(o.object.index, out);
        o = o.object;
      }
      if ((o.kind === "member" || o.kind === "index") && o.object.kind === "name" && SCOPES.has(o.object.name)) {
        const key = o.kind === "member" ? o.property : o.index.kind === "literal" && (typeof o.index.value === "string" || typeof o.index.value === "number") ? String(o.index.value) : null;
        out.add(key === null ? o.object.name : `${o.object.name}.${key}`);
      } else if (o.kind === "member" || o.kind === "index") exprReads(o.object, out);
      break;
    }
    case "call":
      if (e.callee === "item") out.add("game.@items");
      else if (e.callee === "visits" || e.callee === "chosen") out.add(e.callee);
      else if (PAGE_FUNCTIONS.has(e.callee)) out.add("page");
      for (const a of e.args) exprReads(a, out);
      break;
    case "array":
      for (const x of e.items) exprReads(x, out);
      break;
    case "object":
      for (const x of e.entries) exprReads(x.value, out);
      break;
    case "unary":
      exprReads(e.operand, out);
      break;
    case "binary":
      exprReads(e.left, out);
      exprReads(e.right, out);
      break;
    case "conditional":
      exprReads(e.test, out);
      exprReads(e.then, out);
      exprReads(e.otherwise, out);
      break;
  }
  return out;
}

/** 図鑑の条件（項目と段の if、持ち物の項目）が読むもの（exprReads の形）。読めない式は * にする。 */
export function codexReads(data: CodexData): Set<string> {
  const out = new Set<string>();
  const add = (src: string | undefined) => {
    if (!src) return;
    const e = codexExpr(src);
    if (e) exprReads(e, out);
    else out.add("*");
  };
  for (const entry of data.entries) {
    if (!isRecord(entry)) continue;
    add(entry.if);
    if (entry.item) out.add("game.@items");
    for (const s of entry.sections ?? []) add(s.if);
    for (const l of Array.isArray(entry.links) ? entry.links : []) if (isRecord(l)) add(l.if);
  }
  return out;
}

/** 変わった変数（Runtime.onVariableChange の path）が、読むもの（exprReads の形）に関わるか。 */
export function readsTouched(reads: ReadonlySet<string>, path: string): boolean {
  if (reads.has("*")) return true;
  const [root = "", first] = path.split(".");
  if (!SCOPES.has(root)) return reads.has(path);
  if (reads.has(root)) return true;
  // game そのもの（@clear-vars）が変われば、game.x を読むものはどれも関わる
  if (first === undefined) return [...reads].some((r) => r.startsWith(`${root}.`));
  return reads.has(`${root}.${first}`);
}

/** 開いているものの鍵（項目の id と段の鍵）。 */
export function shownKeys(shown: readonly CodexShown[]): string[] {
  return shown.flatMap((s) => [s.entry.id, ...s.sections.map((x) => x.key), ...(s.links ?? []).map((x) => x.key)]);
}

/** 年表の並び（order、無ければ書いた順）。 */
export function timelineOrder(items: readonly CodexShown[], all: readonly CodexEntry[]): CodexShown[] {
  const index = new Map(all.map((e, i) => [e.id, i]));
  const key = (s: CodexShown) => (typeof s.entry.order === "number" ? s.entry.order : (index.get(s.entry.id) ?? 0));
  return [...items].sort((a, b) => key(a) - key(b) || (index.get(a.entry.id) ?? 0) - (index.get(b.entry.id) ?? 0));
}

/** 全セーブ共通の記録に入れる。 */
export function mirrorToSystem(system: Scope, keys: readonly string[]): void {
  const all = isRecord(system[CODEX_SYSTEM_KEY]) ? (system[CODEX_SYSTEM_KEY] as Scope) : (system[CODEX_SYSTEM_KEY] = {});
  for (const k of keys) all[k] = true;
}

const codexUnlock: CommandDefinition = {
  name: "codex-unlock",
  summary: "図鑑の項目か、その段を開く。条件の式（if）で開く項目なら書かなくてよい",
  positional: ["id"],
  params: {
    id: t.required(t.string("項目の名前（data/codex.json の entries の id）")),
    section: t.string("段の名前（sections の id か番号）。省くと項目だけを開く"),
    notify: t.bool("開いたことを画面の端に知らせる", true),
  },
  example: "@codex-unlock red_eye section=lens",
  category: "system",
  keywords: ["図鑑", "記録", "用語", "解放", "手帳", "codex"],
  async run(args, ctx: CommandContext) {
    const id = String(args.id ?? "");
    const data = readCodex(await ctx.data(CODEX_FILE));
    const entry = data?.entries.find((e) => e.id === id);
    if (!data || !entry) {
      ctx.runtime.report("warning", "unknown-codex-entry", `図鑑の項目 ${id} が data/${CODEX_FILE} にありません`);
      return;
    }
    const record = codexRecord(ctx.state.game);
    const keys = [id];
    if (args.section !== undefined) {
      const i = (entry.sections ?? []).findIndex((s, n) => (s.id ?? String(n)) === String(args.section));
      if (i < 0) {
        ctx.runtime.report("warning", "unknown-codex-entry", `図鑑の項目 ${id} に段 ${String(args.section)} がありません`);
        return;
      }
      keys.push(sectionKey(entry, entry.sections![i]!, i));
    }
    const fresh = keys.filter((k) => record.unlocked[k] !== true);
    for (const k of keys) record.unlocked[k] = true;
    // 知らせたことにする（ページごとの見回りで二度知らせない）。項目と一緒に開いた段と線も（「記録が増えた」と知らせ直さない）
    const known = codexKnown(ctx.state.game);
    const game = ctx.state.game;
    const items = isRecord(game["@items"]) ? (game["@items"] as Scope) : {};
    const now = codexShown(data, { evaluate: (e) => ctx.runtime.eval(e), unlocked: record.unlocked, items }).filter((s) => s.entry.id === id);
    for (const k of [...keys, ...shownKeys(now)]) known[k] = true;
    mirrorToSystem(ctx.runtime.system, keys);
    await ctx.present({ ...args, id, fresh: fresh.length > 0 ? (fresh.includes(id) ? "entry" : "section") : "" }, false);
  },
};

const codexOpen: CommandDefinition = {
  name: "codex",
  summary: "図鑑の画面を開き、閉じるまで待つ。項目の名前を書くと、その項目を開いて出す",
  positional: ["id"],
  params: {
    id: t.string("最初に出す項目の名前（省くと一覧）"),
  },
  example: "@codex red_eye",
  waits: true,
  category: "system",
  keywords: ["図鑑", "記録", "用語集", "手帳", "開く", "codex"],
  async run(args, ctx) {
    ctx.resumeHere();
    await ctx.present(args, true);
  },
  // 自動確認では図鑑を開かずに進む
  autoplay: () => undefined,
};

export const COMMANDS: CommandDefinition[] = [codexUnlock, codexOpen];
