import type { Expr } from "@liminalia/lang";
import type { Runtime, Value } from "@liminalia/runtime";
import { dataText, systemText, type CodexScreenApi, type CodexScreenEntry, type DomHost, type RenderContext, type Renderer, type ScreenHandle, type SystemController } from "@liminalia/web";
import { CODEX_FILE, CODEX_SYSTEM_KEY, codexKnown, codexReads, codexRecord, codexShown, mirrorToSystem, readCodex, readsTouched, shownKeys, type CodexData, type CodexShown } from "../commands/codex.ts";
import { srcWithFallback } from "./fallback.ts";
import "./codex.css";

/**
 * 図鑑の画面と、開いたときの知らせ。data/codex.json がある作品だけ、画面 "codex" を登録する（メニューとおまけに並び、
 * @codex・@open-screen codex で開く）。見た目は標準のシステム画面の部品（lm-screen・lm-tab）なので、テーマの色と形が効く。
 * 区分の見せ方（type）は list（一覧）・timeline（年表）・relations（相関図）・map（地図）。作品が WebPlugin の screens.codex を
 * 渡していれば、画面はそちらが作る（中身はここで決めて api に渡す）。
 * 遊んでいる間はこのプレイの記録と条件の式で開いているものを、おまけ（遊んでいない）では全セーブ共通の記録を見せる。
 * 条件の式が読む変数が変わったとき（@set・選んだ選択肢・持ち物・プラグインの setVariable と variablesChanged）に見回し、新しく開いたものをその場で知らせる。
 * ページごとに変わるもの（read() など）か、読むものが分からない条件があれば、ページを出すたびにも見回す。
 */

type Scope = Record<string, Value>;
const english = () => (document.documentElement.lang || "").toLowerCase().startsWith("en");
/** 今の言語の文（英語で英語の欄があればそれ、ほかは data/codex.json の訳。訳が無ければ原文）。 */
const pick = (ja: string | undefined, en: string | undefined) => (english() && en ? en : dataText(CODEX_FILE, ja ?? ""));
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const SVG = "http://www.w3.org/2000/svg";
/** 相関図で行きと帰りの線を弧にずらす量（図の幅と高さの割合。関係の文字は弧のまん中、この半分だけずれた所に置く）。 */
const BOW = 16;
const isRecord = (v: unknown): v is Scope => !!v && typeof v === "object" && !Array.isArray(v);

/** 画面の文言（今の言語のシステム画面の文言。作品の文言の表の codex.* で替えられる）。 */
const T = (k: "title" | "empty" | "fresh" | "related") => systemText().codex[k];

/** 図鑑の今の中身（遊んでいれば条件の式も見る）。 */
export function currentCodex(data: CodexData, runtime: Runtime | null, system: Scope): { shown: CodexShown[]; seen: Scope } {
  if (!runtime) {
    const unlocked = isRecord(system[CODEX_SYSTEM_KEY]) ? (system[CODEX_SYSTEM_KEY] as Scope) : {};
    // おまけでは全部を読んだことにする（新の印は遊んでいる間だけ）
    return { shown: codexShown(data, { evaluate: null, unlocked }), seen: new Proxy({}, { get: () => true }) as Scope };
  }
  const game = runtime.state.game;
  const record = codexRecord(game);
  const items = isRecord(game["@items"]) ? (game["@items"] as Scope) : {};
  return { shown: codexShown(data, { evaluate: (e: Expr) => runtime.eval(e), unlocked: record.unlocked, items }), seen: record.seen };
}

/** 開いているものを、図鑑の画面に渡す形（CodexScreenEntry）にする。 */
export function screenEntries(data: CodexData, shown: readonly CodexShown[], seen: Scope): CodexScreenEntry[] {
  const index = new Map(data.entries.map((e, i) => [e.id, i]));
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  return shown.map((s) => {
    const e = s.entry;
    const sections = s.sections.map(({ section, key }) => ({
      key,
      ...(section.id !== undefined ? { id: section.id } : {}),
      ...(section.title !== undefined ? { title: section.title } : {}),
      ...(section.titleEn !== undefined ? { titleEn: section.titleEn } : {}),
      text: section.text,
      ...(section.textEn !== undefined ? { textEn: section.textEn } : {}),
      fresh: seen[key] !== true,
    }));
    const x = num(e.x);
    const y = num(e.y);
    return {
      id: e.id,
      category: e.category,
      title: e.title,
      ...(e.titleEn !== undefined ? { titleEn: e.titleEn } : {}),
      ...(e.reading !== undefined ? { reading: e.reading } : {}),
      ...(e.image !== undefined ? { image: e.image } : {}),
      ...(e.summary !== undefined ? { summary: e.summary } : {}),
      ...(e.summaryEn !== undefined ? { summaryEn: e.summaryEn } : {}),
      related: (e.related ?? []).filter((r) => shown.some((x) => x.entry.id === r)),
      ...(e.date !== undefined ? { date: e.date } : {}),
      ...(e.dateEn !== undefined ? { dateEn: e.dateEn } : {}),
      order: num(e.order) ?? index.get(e.id) ?? 0,
      ...(x !== undefined ? { x } : {}),
      ...(y !== undefined ? { y } : {}),
      sections,
      links: (s.links ?? []).map(({ link, key }) => ({
        key,
        to: link.to,
        ...(link.label !== undefined ? { label: link.label } : {}),
        ...(link.labelEn !== undefined ? { labelEn: link.labelEn } : {}),
        tone: link.tone === "positive" || link.tone === "negative" ? link.tone : "neutral",
      })),
      fresh: seen[e.id] !== true || sections.some((x) => x.fresh),
    } satisfies CodexScreenEntry;
  });
}

/** 図鑑の画面に渡すもの（作品の screens.codex と、標準の画面の両方が使う）。 */
export function codexApi(
  ctx: Pick<RenderContext, "asset">,
  data: CodexData,
  o: { shown: readonly CodexShown[]; seen: Scope; playing: boolean; entry?: string; close(): void; markSeen(keys: string[]): void; onBack?(handler: () => boolean): void; handle?: ScreenHandle<null> },
): CodexScreenApi {
  const h = o.handle;
  const api: CodexScreenApi = {
    data: {
      ...(data.title !== undefined ? { title: data.title } : {}),
      ...(data.titleEn !== undefined ? { titleEn: data.titleEn } : {}),
      categories: data.categories.map((c) => ({ ...c })),
    },
    entries: screenEntries(data, o.shown, o.seen),
    ...(o.entry ? { entry: o.entry } : {}),
    playing: o.playing,
    markSeen: (keys) => {
      const fresh = keys.filter((k) => o.seen[k] !== true);
      if (fresh.length === 0) return;
      o.markSeen(fresh);
      for (const k of fresh) o.seen[k] = true;
    },
    text: (ja, en) => pick(ja, en),
    asset: (kind, path) => ctx.asset(kind, path),
    close: () => o.close(),
    onBack: (handler) => (h ? h.onBack(handler) : o.onBack?.(handler)),
    onClose: (listener) => (h ? h.onClose(listener) : () => undefined),
  };
  // 閉じる演出は作品が api.leave に入れる。開いた画面の扱いへ渡す
  if (h) {
    Object.defineProperty(api, "leave", {
      get: () => h.leave,
      set: (fn: CodexScreenApi["leave"]) => {
        if (fn) h.leave = fn;
        else delete h.leave;
      },
      enumerable: true,
    });
  }
  return api;
}

/**
 * 図鑑の画面の中身（標準の見た目）。区分の見せ方ごとに左の欄を作る（一覧・年表・相関図・地図）。
 * 項目を決めずに開いたときと区分を替えたときは、その区分の新しい印の付いた項目（無ければ並びの一つ目）を右の欄に出しておく。
 */
export function buildCodex(api: CodexScreenApi): HTMLElement {
  const root = el("div", "lm-screen lm-codex");
  const head = el("div", "lm-screen-header");
  head.append(el("h2", "lm-screen-title", api.text(api.data.title, api.data.titleEn) || T("title")));
  const tabs = el("nav", "lm-tabs");
  head.append(tabs);
  const close = el("button", "lm-button lm-close", systemText().close);
  close.type = "button";
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    api.close();
  });
  head.append(close);
  const body = el("div", "lm-codex-body");
  const list = el("div", "lm-codex-list");
  const detail = el("div", "lm-codex-detail");
  body.append(list, detail);
  root.append(head, body);
  root.addEventListener("click", (e) => e.stopPropagation());
  const entries = api.entries;
  const byId = new Map(entries.map((s) => [s.id, s]));
  const categories = api.data.categories.filter((c) => entries.some((s) => s.category === c.id));
  let category = (api.entry && byId.get(api.entry)?.category) || categories[0]?.id || "";
  let current = api.entry && byId.has(api.entry) ? api.entry : "";
  /** 読んだもの（この表示の間、段の印は残す）。 */
  const read = new Set<string>();
  const isFresh = (s: CodexScreenEntry) => s.fresh && !(read.has(s.id) && s.sections.every((x) => !x.fresh || read.has(x.key)));

  /** 項目のボタン（一覧・年表・相関図・地図で同じ）。 */
  const itemButton = (s: CodexScreenEntry, cls: string, inner: (HTMLElement | string)[]) => {
    const b = el("button", cls);
    b.type = "button";
    b.dataset.entry = s.id;
    b.setAttribute("aria-pressed", String(s.id === current));
    b.setAttribute("aria-label", api.text(s.title, s.titleEn));
    b.append(...inner);
    if (isFresh(s)) b.append(el("span", "lm-codex-fresh", T("fresh")));
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      showEntry(s.id);
    });
    return b;
  };
  const face = (s: CodexScreenEntry) => {
    if (!s.image) return [];
    const img = el("img", "lm-codex-node-image");
    img.alt = "";
    img.src = api.asset("image", s.image);
    return [img];
  };
  /** 相関図と地図の位置（書いていなければ円に並べる）。 */
  const placeOf = (items: readonly CodexScreenEntry[]) => {
    const missing = items.filter((s) => s.x === undefined || s.y === undefined);
    return new Map(
      items.map((s) => {
        if (s.x !== undefined && s.y !== undefined) return [s.id, { x: s.x, y: s.y }];
        const i = missing.indexOf(s);
        const a = (i / Math.max(1, missing.length)) * Math.PI * 2 - Math.PI / 2;
        return [s.id, { x: 50 + Math.cos(a) * 36, y: 50 + Math.sin(a) * 36 }];
      }),
    );
  };

  /** 区分の項目を、左の欄に並べる順に（年表は日付の順、読みで並べる一覧は読みの順、ほかは書いた順）。 */
  const ordered = (categoryId: string): CodexScreenEntry[] => {
    const c = api.data.categories.find((x) => x.id === categoryId);
    const items = entries.filter((s) => s.category === categoryId);
    if (c?.type === "timeline") return items.sort((a, b) => a.order - b.order);
    if ((c?.type ?? "list") === "list" && c?.sort === "reading") return items.sort((a, b) => (a.reading ?? a.title).localeCompare(b.reading ?? b.title, "ja"));
    return items;
  };
  /** 区分を開いたときに出しておく項目（新しい印の付いたもの、無ければ一つ目）。 */
  const firstOf = (categoryId: string): string | null => {
    const items = ordered(categoryId);
    return (items.find(isFresh) ?? items[0])?.id ?? null;
  };

  const showList = () => {
    for (const b of tabs.children) b.setAttribute("aria-pressed", String((b as HTMLElement).dataset.category === category));
    const c = api.data.categories.find((x) => x.id === category);
    const type = c?.type ?? "list";
    body.dataset.type = type;
    const items = ordered(category);
    if (items.length === 0) {
      list.replaceChildren(el("p", "lm-codex-empty", T("empty")));
      return;
    }
    if (type === "timeline") {
      list.replaceChildren(
        ...items.map((s) => {
          const date = api.text(s.date, s.dateEn);
          return itemButton(s, "lm-codex-item lm-codex-event", [el("span", "lm-codex-event-date", date), el("span", "lm-codex-item-title", api.text(s.title, s.titleEn))]);
        }),
      );
      return;
    }
    if (type === "relations" || type === "map") {
      const outer = el("div", "lm-codex-board");
      outer.dataset.type = type;
      // 絵があれば、絵の縦横の比の枠に置く（位置は絵の割合）。無ければ欄いっぱい
      const board = el("div", "lm-codex-board-inner");
      outer.append(board);
      if (c?.map) {
        board.dataset.image = "true";
        const img = el("img", "lm-codex-board-image");
        img.alt = "";
        const fit = () => {
          if (img.naturalWidth > 0 && img.naturalHeight > 0) board.style.setProperty("--lm-codex-ratio", `${img.naturalWidth / img.naturalHeight}`);
        };
        img.addEventListener("load", fit);
        // 地図の選択と同じく bgimage から探し、無ければ前の置き場所の image から
        srcWithFallback(img, [api.asset("bgimage", c.map), api.asset("image", c.map)]);
        if (img.complete) fit();
        board.append(img);
      }
      const at = placeOf(items);
      if (type === "relations") {
        const svg = document.createElementNS(SVG, "svg");
        svg.setAttribute("class", "lm-codex-lines");
        svg.setAttribute("viewBox", "0 0 100 100");
        svg.setAttribute("preserveAspectRatio", "none");
        svg.setAttribute("aria-hidden", "true");
        const labels: HTMLElement[] = [];
        // 行きと帰りの両方がある二人（A から B と B から A）。線を同じ所に重ねず、それぞれ進む向きの左へ弧にずらす
        const pairs = new Set(items.flatMap((s) => s.links.map((l) => `${s.id}>${l.to}`)));
        for (const s of items) {
          for (const l of s.links) {
            const a = at.get(s.id);
            const b = at.get(l.to);
            if (!a || !b) continue;
            const both = pairs.has(`${l.to}>${s.id}`) && l.to !== s.id;
            const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            let line: SVGElement;
            if (both) {
              // 進む向き（a から b）の左の法線へ BOW だけずらした制御点。弧のまん中は、制御点との中ほど
              const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
              const n = { x: (b.y - a.y) / len, y: -(b.x - a.x) / len };
              const c = { x: mid.x + n.x * BOW, y: mid.y + n.y * BOW };
              line = document.createElementNS(SVG, "path");
              line.setAttribute("d", `M ${a.x} ${a.y} Q ${c.x} ${c.y} ${b.x} ${b.y}`);
              line.setAttribute("fill", "none");
              mid.x += (n.x * BOW) / 2;
              mid.y += (n.y * BOW) / 2;
            } else {
              line = document.createElementNS(SVG, "line");
              line.setAttribute("x1", String(a.x));
              line.setAttribute("y1", String(a.y));
              line.setAttribute("x2", String(b.x));
              line.setAttribute("y2", String(b.y));
            }
            line.setAttribute("class", `lm-codex-line lm-codex-line--${l.tone}`);
            line.setAttribute("vector-effect", "non-scaling-stroke");
            line.dataset.link = l.key;
            svg.append(line);
            const text = api.text(l.label, l.labelEn);
            if (text) {
              const tag = el("span", `lm-codex-line-label lm-codex-line-label--${l.tone}`, text);
              tag.style.left = `${mid.x}%`;
              tag.style.top = `${mid.y}%`;
              labels.push(tag);
            }
          }
        }
        board.append(svg, ...labels);
      }
      for (const s of items) {
        const p = at.get(s.id)!;
        const b = itemButton(s, type === "map" ? "lm-codex-node lm-codex-marker" : "lm-codex-node", [...(type === "map" ? [el("span", "lm-codex-marker-dot")] : face(s)), el("span", "lm-codex-node-title", api.text(s.title, s.titleEn))]);
        b.style.left = `${p.x}%`;
        b.style.top = `${p.y}%`;
        board.append(b);
      }
      list.replaceChildren(outer);
      return;
    }
    list.replaceChildren(...items.map((s) => itemButton(s, "lm-codex-item", [el("span", "lm-codex-item-title", api.text(s.title, s.titleEn))])));
  };

  /**
   * 項目を右の欄に出す。picked でなければ、開いたときと区分を替えたときに出しておいただけなので読んだことにしない
   * （遊ぶ人はまだ見ていないかもしれない。「新」の印を残し、記録にも入れない）。
   */
  const showEntry = (id: string, picked = true) => {
    const s = byId.get(id);
    if (!s) return;
    current = id;
    if (s.category !== category) category = s.category;
    const wasFresh = new Set(picked ? [...(s.fresh && !read.has(s.id) ? [s.id] : []), ...s.sections.filter((x) => x.fresh && !read.has(x.key)).map((x) => x.key)] : []);
    const out: HTMLElement[] = [];
    if (s.image) {
      const img = el("img", "lm-codex-image");
      img.alt = "";
      img.src = api.asset("image", s.image);
      out.push(img);
    }
    out.push(el("h3", "lm-codex-title", api.text(s.title, s.titleEn)));
    const date = api.text(s.date, s.dateEn);
    if (date) out.push(el("p", "lm-codex-reading lm-codex-date", date));
    // 読みは日本語で遊んでいるときだけ
    if (s.reading && (document.documentElement.lang || "ja").toLowerCase().startsWith("ja")) out.push(el("p", "lm-codex-reading", s.reading));
    const summary = api.text(s.summary, s.summaryEn);
    if (summary) out.push(el("p", "lm-codex-summary", summary));
    for (const section of s.sections) {
      const part = el("section", "lm-codex-section");
      if (section.fresh && !read.has(section.key)) part.dataset.fresh = "true";
      const heading = api.text(section.title, section.titleEn);
      if (heading) part.append(el("h4", "lm-codex-section-title", heading));
      for (const para of api.text(section.text, section.textEn).split(/\n+/)) part.append(el("p", "lm-codex-text", para));
      out.push(part);
    }
    // 相関図の線（この項目から出るものと、この項目へ来るもの）
    const relations = [...s.links.map((l) => ({ other: l.to, label: api.text(l.label, l.labelEn) })), ...entries.flatMap((x) => x.links.filter((l) => l.to === s.id).map((l) => ({ other: x.id, label: api.text(l.label, l.labelEn) })))];
    const related = [...new Set([...s.related, ...relations.map((r) => r.other)])].filter((r) => byId.has(r) && r !== s.id);
    if (related.length > 0) {
      const nav = el("div", "lm-codex-related");
      nav.append(el("span", "lm-codex-related-label", T("related")));
      for (const r of related) {
        const label = relations.find((x) => x.other === r && x.label)?.label;
        const name = api.text(byId.get(r)!.title, byId.get(r)!.titleEn);
        const b = el("button", "lm-button lm-codex-link", label ? `${name}（${label}）` : name);
        b.type = "button";
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          showEntry(r);
        });
        nav.append(b);
      }
      out.push(nav);
    }
    detail.replaceChildren(...out);
    detail.scrollTop = 0;
    // 読んだ（新の印を外す。段の印はこの表示の間だけ残す）
    api.markSeen([...wasFresh]);
    for (const k of wasFresh) read.add(k);
    showList();
  };

  for (const c of categories) {
    const b = el("button", "lm-tab", api.text(c.label, c.labelEn));
    b.type = "button";
    b.dataset.category = c.id;
    b.dataset.type = c.type ?? "list";
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      category = c.id;
      // 区分の項目を一つ出しておく（新しい印の付いたもの、無ければ一つ目。読んだことにはしない）
      const first = firstOf(c.id);
      if (first) showEntry(first, false);
      else showList();
    });
    tabs.append(b);
  }
  showList();
  // @codex で名前を決めて開いた項目は読んだことにし、決めずに開いたときは区分の項目を一つ出しておく（読んだことにはしない）
  const picked = current !== "";
  current ||= firstOf(category) ?? "";
  if (current) showEntry(current, picked);
  else if (entries.length === 0) detail.append(el("p", "lm-codex-empty", T("empty")));
  return root;
}

/** 読み込んだ図鑑（無い作品では null）。 */
let loaded: Promise<CodexData | null> | null = null;
const loadCodex = (ctx: Pick<RenderContext, "loadData">) => (loaded ??= ctx.loadData(CODEX_FILE).then(readCodex, () => null));

/** 画面の中身を作る（作品の screens.codex があればそれ、無ければ標準の見た目）。 */
function codexContent(system: SystemController, ctx: Pick<RenderContext, "asset">, data: CodexData, h: ScreenHandle<null>, entry?: string): HTMLElement {
  const rt = system.mode === "game" ? system.runtime : null;
  const { shown, seen } = currentCodex(data, rt, system.systemVariables ?? {});
  const api = codexApi(ctx, data, {
    shown,
    seen,
    playing: rt !== null,
    ...(entry ? { entry } : {}),
    close: () => h.close(null),
    markSeen: (keys) => {
      const now = system.mode === "game" ? system.runtime : null;
      if (now) for (const k of keys) codexRecord(now.state.game).seen[k] = true;
    },
    handle: h,
  });
  const custom = system.standardScreens?.codex;
  return custom ? custom(api) : buildCodex(api);
}

/** 図鑑の画面を開く（system.openScreen で。entry は最初に出す項目）。 */
function openCodex(system: SystemController, ctx: Pick<RenderContext, "asset">, data: CodexData, entry?: string): ScreenHandle<null> | null {
  if (!system.openScreen) return null;
  return system.openScreen<null>((h) => codexContent(system, ctx, data, h, entry), { name: "codex", closeOnBack: true, allowMenu: true });
}

/**
 * 新しく開いたものを知らせる（項目が新しければ「加えた」、段だけなら「増えた」）。標準の知らせ（ctx.notify）で出すので、
 * 続けて開けば積み上がり、全画面の演出の間は待ち、スキップ中は短くなる。一度に二つ以上開いたものは数でまとめる。
 */
function announce(ctx: Pick<RenderContext, "notify">, titles: readonly string[], kind: "entry" | "section"): void {
  if (titles.length === 0) return;
  const t = systemText().codex;
  const text = titles.length > 1 ? (kind === "entry" ? t.addedMany(titles.length) : t.updatedMany(titles.length)) : kind === "entry" ? t.added(titles[0]!) : t.updated(titles[0]!);
  ctx.notify(text);
}

/**
 * 図鑑を使えるようにする（WebPlugin の ready から）。data/codex.json が無ければ何もしない。
 * 画面 "codex" を登録し、条件の式で新しく開いたものを、式が読む変数が変わったときに知らせる。
 */
export async function setupCodex(host: DomHost, system: SystemController): Promise<void> {
  const ctx = host.context;
  const data = await loadCodex(ctx);
  if (!data) return;
  system.defineScreen?.("codex", (h: ScreenHandle) => codexContent(system, ctx, data, h as ScreenHandle<null>), {
    // 文字は開くたびに今の言語で引く（作品の文言の表の codex.title で替えられる。data/codex.json の title・titleEn が先）
    label: new Proxy({} as Record<string, string>, { get: (_target, lang) => (lang === "en" && data.titleEn ? data.titleEn : data.title ? dataText(CODEX_FILE, data.title) : "") || systemText().codex.title }),
    menu: true,
    closeOnBack: true,
    // 遊んでいる最中に開いたとき（@open-screen codex）も、上にメニュー・セーブ・履歴・コンフィグを開ける（メニューから開いたときは開かない）
    allowMenu: true,
    extra: () => {
      const all = system.systemVariables?.[CODEX_SYSTEM_KEY];
      return isRecord(all) && Object.keys(all).length > 0;
    },
  });
  // 条件の式が読むもの。変数が変わったときは、そのどれかに関わるときだけ見回す
  const reads = codexReads(data);
  const everyPage = reads.has("page") || reads.has("*");
  /** 見回す（first: このプレイではじめて見回す。そのとき開いていたものは知らせない）。 */
  const scan = (runtime: Runtime, first: boolean, skipping: boolean) => {
    const game = runtime.state.game;
    first ||= codexRecord(game).known === null;
    const known = codexKnown(game);
    const { shown } = currentCodex(data, runtime, system.systemVariables ?? {});
    const keys = shownKeys(shown).filter((k) => known[k] !== true);
    if (keys.length === 0) return;
    for (const k of keys) known[k] = true;
    mirrorToSystem(system.systemVariables ?? {}, keys);
    system.persist?.();
    // はじめて見回すときに開いていたもの（はじめから開いている項目・ロードしたセーブで開いていたもの）は知らせない
    if (first && Object.keys(known).length === keys.length) return;
    if (data.notify === false || skipping) return;
    const added = shown.filter((x) => keys.includes(x.entry.id));
    const updated = shown.filter((x) => !keys.includes(x.entry.id) && x.sections.some((y) => keys.includes(y.key)));
    announce(ctx, added.map((x) => pick(x.entry.title, x.entry.titleEn)), "entry");
    announce(ctx, updated.map((x) => pick(x.entry.title, x.entry.titleEn)), "section");
  };
  let rt: Runtime | null = null;
  let unwatch: (() => void) | null = null;
  let queued = false;
  /** 控えたときのゲームの変数（始め直し・ロード・巻き戻しで替わったら、今開いているものを知らせずに控え直す）。 */
  let base: Scope | null = null;
  const baseline = (runtime: Runtime) => {
    base = runtime.state.game;
    scan(runtime, true, true);
  };
  /** 遊んでいるプレイの実行器が替わったら、変数の知らせを受け直し、今開いているものを知らせずに控える。 */
  const follow = (runtime: Runtime) => {
    unwatch?.();
    rt = runtime;
    baseline(runtime);
    unwatch =
      runtime.onVariableChange?.((path) => {
        if (queued || !readsTouched(reads, path)) return;
        // 同じ命令の中でいくつ変わっても一度だけ見る
        queued = true;
        queueMicrotask(() => {
          queued = false;
          if (system.mode !== "game" || system.runtime !== runtime) return;
          if (runtime.state.game !== base) baseline(runtime);
          else scan(runtime, false, ctx.skipping || system.status?.skip === true);
        });
      }) ?? null;
  };
  system.onStatusChange?.((s) => {
    if (s.mode !== "game" || !system.runtime) return;
    const runtime = system.runtime;
    if (runtime !== rt) follow(runtime);
    else if (runtime.state.game !== base) baseline(runtime);
    else if (everyPage && s.waiting) scan(runtime, false, s.skip);
  });
  // 図鑑を読み終える前に遊び始めていれば、今のプレイから
  if (system.mode === "game" && system.runtime) follow(system.runtime);
}

export const renderers: Record<string, Renderer> = {
  "codex-unlock": async (ctx, args) => {
    if (args.notify === false || ctx.skipping || (args.fresh !== "entry" && args.fresh !== "section")) return;
    const data = await loadCodex(ctx);
    if (!data || data.notify === false) return;
    const entry = data.entries.find((e) => e.id === args.id);
    if (entry) announce(ctx, [pick(entry.title, entry.titleEn)], args.fresh);
  },
  codex: async (ctx, args) => {
    const data = await loadCodex(ctx);
    const system = ctx.system?.controller;
    if (!data || !system) return;
    const handle = openCodex(system, ctx, data, typeof args.id === "string" ? args.id : undefined);
    if (!handle) return;
    // 録画（lim shot --video）は、読む時間だけ見せてから閉じる
    const withdraw = ctx.offer?.({ options: [systemText().close], proceed: 0, choose: () => handle.close() });
    await handle.result.finally(() => withdraw?.());
  },
};
