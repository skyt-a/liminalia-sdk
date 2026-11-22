import { chapterHeading, type Cast, type ChapterInfo, type ExtraAchievement, type ExtraCg, type ExtraChapter, type ExtraCharacter, type ExtraConfig, type ExtraGlossary, type ExtraMovie, type ExtraMusic, type ExtraReplay } from "@liminalia/lang";
import type { Value } from "@liminalia/runtime";
import type { AudioPlayer } from "../audio.ts";
import { lazyThumb, THUMB_SIZE } from "./thumbs.ts";
import type { AssetKind } from "../dom-host.ts";
import { formatDate, TEXT } from "./strings.ts";
import { button, el, header, swallow } from "./ui.ts";
import { playSound } from "../ui-parts.ts";

export type ExtraTab = "cg" | "replay" | "music" | "movies" | "characters" | "chapters" | "glossary" | "achievements" | "endings";

export const EXTRA_TABS: readonly ExtraTab[] = ["cg", "replay", "music", "movies", "characters", "chapters", "glossary", "achievements", "endings"];

/** おまけのエンディングの一覧の一つ（シナリオから作ったフローチャートのエンディング）。 */
export interface ExtraEnding {
  /** 一覧に出す名前（エンディングの種類の文言と title= の名前。訳したもの）。 */
  name: string;
  /** エンディングの種類（ending= の bad など。無ければ ""）。 */
  kind: string;
  /** 場面の題（その場面の最初の本文など）。 */
  title: string;
  reached: boolean;
  /** その場面から読み直す（着いたときの控えがあるときだけ。確かめるのは呼んだ側）。 */
  jump?(): void;
}

/** 解放したものを記録しているシステム変数（全セーブ共通）。 */
const unlockedSet = (system: Record<string, Value>, key: string): Record<string, Value> => {
  const v = system[key];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Value>) : {};
};

/** 一覧の解放の具合を、システム変数から読む。 */
export function extraState(_extra: ExtraConfig, system: Record<string, Value>) {
  const cg = unlockedSet(system, "cg_unlocked");
  const replay = unlockedSet(system, "replay_unlocked");
  const music = unlockedSet(system, "bgm_heard");
  const achievements = unlockedSet(system, "achievements");
  const glossary = unlockedSet(system, "glossary_unlocked");
  const chapters = unlockedSet(system, "chapters_unlocked");
  const movies = unlockedSet(system, "movies_seen");
  const sprites = unlockedSet(system, "sprites_seen");
  const progress = unlockedSet(system, "achievement_progress");
  return {
    /** 数を数える実績の今の数（数えていなければ 0。解放していれば goal 以上として扱う）。 */
    achievementProgress: (a: ExtraAchievement): number => {
      const v = progress[a.id];
      const n = typeof v === "number" ? v : 0;
      return achievements[a.id] && typeof a.goal === "number" ? Math.max(n, a.goal) : n;
    },
    movie: (m: ExtraMovie) => !!movies[m.file],
    /** 見た差分（立ち絵セット → 差分の名前）。一つも見ていなければ null。 */
    character: (c: ExtraCharacter): Record<string, Record<string, Value>> | null => {
      const seen = sprites[c.who];
      return seen && typeof seen === "object" && !Array.isArray(seen) && Object.keys(seen).length > 0 ? (seen as Record<string, Record<string, Value>>) : null;
    },
    glossary: (g: ExtraGlossary) => !!glossary[g.id],
    chapter: (c: ExtraChapter) => !!chapters[c.id],
    cgImages: (c: ExtraCg) => (c.images ?? []).filter((i) => !!cg[i]),
    replay: (r: ExtraReplay) => !!replay[r.id],
    music: (m: ExtraMusic) => !!music[m.file],
    achievement: (a: ExtraAchievement): string | null => {
      const v = achievements[a.id];
      return v ? (typeof v === "string" ? v : "") : null;
    },
  };
}

/** 項目ごとの数（解放したもの / 全体）。 */
export interface CompletionCount {
  done: number;
  total: number;
}

/**
 * コンプリート率。read は既読（本文のページ）、endings はエンディング（どちらも台本から作ったフローチャートが読めなければ null）、
 * cg は CG の画像、replay は回想、music は音楽、movies はムービー、achievements は実績。
 * rate は全体の割合（全体の数が 0 の項目を除いた、項目ごとの割合の平均。0〜1）。
 */
export interface Completion {
  read: CompletionCount | null;
  endings: CompletionCount | null;
  cg: CompletionCount;
  replay: CompletionCount;
  music: CompletionCount;
  movies: CompletionCount;
  achievements: CompletionCount;
  rate: number;
}

/** おまけの一覧の解放の具合と、既読とエンディングの数から、コンプリート率を作る。 */
export function extraCompletion(extra: ExtraConfig | undefined, system: Record<string, Value>, flow: { read: CompletionCount; endings: CompletionCount } | null = null): Completion {
  const s = extraState(extra ?? {}, system);
  const count = <T>(list: readonly T[] | undefined, done: (x: T) => number, size: (x: T) => number = () => 1): CompletionCount => ({
    done: (list ?? []).reduce((n, x) => n + done(x), 0),
    total: (list ?? []).reduce((n, x) => n + size(x), 0),
  });
  const out: Omit<Completion, "rate"> = {
    read: flow?.read ?? null,
    endings: flow?.endings ?? null,
    cg: count(extra?.cg, (c) => s.cgImages(c).length, (c) => (c.images ?? []).length),
    replay: count(extra?.replay, (r) => Number(s.replay(r))),
    music: count(extra?.music, (m) => Number(s.music(m))),
    movies: count(extra?.movies, (m) => Number(s.movie(m))),
    achievements: count(extra?.achievements, (a) => Number(s.achievement(a) !== null)),
  };
  const parts = Object.values(out).filter((c): c is CompletionCount => c !== null && c.total > 0);
  return { ...out, rate: parts.length > 0 ? parts.reduce((n, c) => n + Math.min(1, c.done / c.total), 0) / parts.length : 0 };
}

/** 一覧にあるタブ（中身のあるものだけ）。 */
export function extraTabs(extra: ExtraConfig | undefined): ExtraTab[] {
  return EXTRA_TABS.filter((t) => (t === "endings" ? extra?.endings === true : (extra?.[t]?.length ?? 0) > 0));
}

/** 何か一つでも解放しているか（タイトルの「おまけ」を出すか）。 */
export function anyExtraUnlocked(extra: ExtraConfig | undefined, system: Record<string, Value>): boolean {
  if (!extra) return false;
  const s = extraState(extra, system);
  return (
    (extra.cg ?? []).some((c) => s.cgImages(c).length > 0) ||
    (extra.replay ?? []).some(s.replay) ||
    (extra.music ?? []).some(s.music) ||
    (extra.glossary ?? []).some(s.glossary) ||
    (extra.chapters ?? []).some(s.chapter) ||
    (extra.movies ?? []).some(s.movie) ||
    (extra.characters ?? []).some((c) => s.character(c) !== null) ||
    (extra.achievements ?? []).some((a) => s.achievement(a) !== null)
  );
}

export interface ExtraScreenOptions {
  extra: ExtraConfig;
  system: Record<string, Value>;
  asset(kind: AssetKind, path: string): string;
  audio: AudioPlayer;
  /** 回想を再生する（画面は呼んだ側が閉じる）。 */
  replay(entry: ExtraReplay): void;
  /** 章から読み直す（確かめるのも画面を閉じるのも呼んだ側）。 */
  startChapter(chapter: ExtraChapter): void;
  /** 立ち絵の鑑賞: キャスト（立ち絵セットと差分の並び）と、差分の絵の URL（パーツ合成なら重ねたもの）。 */
  cast?: Cast;
  sprite?(who: string, appearance: string, variant: string): Promise<string>;
  close(): void;
  tab?: ExtraTab;
  /** タブの並びの後ろに置く、作品の画面を開くボタン（defineScreen の extra）。 */
  screens?: readonly { label: string; open(): void }[];
  /** コンプリート率（既読とエンディングはフローチャートを読んでから。済んだら見出しの下に出す）。 */
  completion?: Promise<Completion>;
  /** 章の情報（liminalia.json の chapters。CG の chapter を見出しにする）。 */
  chapters?: readonly ChapterInfo[];
  /** エンディングの一覧（extra.endings。フローチャートを読んでから）。 */
  endings?: Promise<readonly ExtraEnding[]>;
}

export interface ExtraScreen {
  el: HTMLElement;
  /** Esc・右クリック。CG を大きく見ているならそれを閉じて true、そうでなければ false（画面を閉じる）。 */
  back(): boolean;
  /** 画面を閉じるときの片付け（音楽の再生を止める）。 */
  dispose(): void;
}

/** 最後に開いていたタブ。 */
let lastTab: ExtraTab | null = null;
/** CG のタブで最後に開いていたまとまり（group か章の見出し）。 */
let lastGroup: string | null = null;

/** CG の鑑賞で拡大できる倍率の上限。 */
const CG_ZOOM_MAX = 4;

/**
 * おまけの画面。CG・回想・音楽・実績のうち、一覧（liminalia.json の extra）にあるものをタブで切り替える。
 * まだ解放していないものは中身を見せない（画像も名前も伏せる。実績は hidden でなければ名前と説明だけ見せる）。
 */
export function createExtra(o: ExtraScreenOptions): ExtraScreen {
  const s = extraState(o.extra, o.system);
  const tabs = extraTabs(o.extra);
  const root = el("div", "lm-screen lm-extra");
  swallow(root);
  const body = el("div", "lm-extra-body");
  const nav = el("nav", "lm-tabs");
  const tabButtons = new Map<ExtraTab, HTMLButtonElement>();
  /** 音楽のタブで鳴らしている曲。 */
  let playing: { file: string; row: HTMLButtonElement } | null = null;
  /** 音楽室の再生の様子（タブを切り替えても保つ）。 */
  const music: { index: number | null; paused: boolean; repeat: "all" | "one" | "none"; shuffle: boolean; seeking: boolean } = { index: null, paused: false, repeat: "all", shuffle: false, seeking: false };
  let viewer: HTMLElement | null = null;

  for (const t of tabs) {
    const b = button("lm-tab", TEXT.extra.tabs[t], () => show(t));
    tabButtons.set(t, b);
    nav.append(b);
  }
  for (const s of o.screens ?? []) nav.append(button("lm-tab", s.label, () => s.open()));
  const summary = el("div", "lm-extra-summary");
  root.append(header(TEXT.extra.heading, o.close, nav), summary, body);
  // コンプリート率（全体と、数のある項目ごと）
  void o.completion?.then((c) => {
    const pct = (n: number) => Math.floor(n * 100);
    const item = (label: string, x: CompletionCount | null, percent = false) => (x && x.total > 0 ? [el("span", "lm-extra-summary-item", percent ? TEXT.extra.completionPercent(label, pct(x.done / x.total)) : TEXT.extra.completionCount(label, x.done, x.total))] : []);
    summary.replaceChildren(
      el("span", "lm-extra-summary-item is-total", TEXT.extra.completionPercent(TEXT.extra.completion, pct(c.rate))),
      ...item(TEXT.extra.completionRead, c.read, true),
      ...item(TEXT.extra.tabs.cg, c.cg),
      ...item(TEXT.extra.tabs.replay, c.replay),
      ...item(TEXT.extra.completionEndings, c.endings),
      ...item(TEXT.extra.tabs.achievements, c.achievements),
    );
  });

  function show(tab: ExtraTab): void {
    lastTab = tab;
    for (const [t, b] of tabButtons) b.setAttribute("aria-pressed", String(t === tab));
    body.replaceChildren(
      tab === "cg"
        ? cgGrid()
        : tab === "replay"
          ? replayGrid()
          : tab === "music"
            ? musicList()
            : tab === "movies"
              ? movieGrid()
              : tab === "characters"
                ? characterView()
                : tab === "chapters"
                  ? chapterList()
                  : tab === "glossary"
                    ? glossaryList()
                    : tab === "endings"
                      ? endingList()
                      : achievementList(),
    );
  }

  /** 縮小画像の一枚。locked なら画像も名前も伏せる。 */
  function tile(image: string | null, title: string, locked: boolean, onOpen: () => void, folder: "bgimage" | "fgimage" = "bgimage", shrink = false): HTMLElement {
    const frame = el("span", "lm-extra-thumb");
    if (!locked && image) {
      const img = el("img");
      img.alt = "";
      img.draggable = false;
      // 縮小画像を書いていない CG は、その場で縮めたものを出す（元の CG を一覧に並べて持ち続けない）
      if (shrink) lazyThumb(img, o.asset(folder, image), THUMB_SIZE);
      else {
        img.src = o.asset(folder, image);
        img.loading = "lazy";
      }
      frame.append(img);
    } else {
      frame.append(el("span", "lm-extra-locked", TEXT.extra.locked));
    }
    const b = button("lm-extra-tile", "", onOpen);
    b.append(frame, el("span", "lm-extra-title", locked ? TEXT.extra.unknown : title));
    b.disabled = locked;
    return b;
  }

  /** CG のまとまり（group、無ければ chapter の章の見出し。どちらも無ければ null）。 */
  const groupOf = (c: ExtraCg): string | null => {
    if (typeof c.group === "string" && c.group !== "") return c.group;
    const chapter = c.chapter ? o.chapters?.find((x) => x.id === c.chapter) : undefined;
    return chapter ? chapterHeading(chapter) : null;
  };

  /**
   * CG の一覧。まとまり（group か章）が二つ以上あればタブで分け、まとまりの解放の数と割合を出す。
   * 押すとそのまとまりの解放した CG を順に見られる（openViewer）。
   */
  function cgGrid(): HTMLElement {
    const all = o.extra.cg ?? [];
    const groups = [...new Set(all.map(groupOf))];
    const wrap = el("div", "lm-extra-cg");
    const grid = el("div", "lm-extra-grid");
    const progress = el("p", "lm-extra-progress");
    const groupTabs = el("div", "lm-tabs lm-extra-groups");
    const showGroup = (group: string | null) => {
      lastGroup = group;
      for (const b of groupTabs.querySelectorAll<HTMLButtonElement>("button")) b.setAttribute("aria-pressed", String(b.dataset.group === (group ?? "")));
      const entries = groups.length > 1 ? all.filter((c) => groupOf(c) === group) : all;
      const done = entries.reduce((n, c) => n + s.cgImages(c).length, 0);
      const total = entries.reduce((n, c) => n + (c.images ?? []).length, 0);
      progress.textContent = TEXT.extra.rate(done, total);
      // 見られるもの（解放した画像のある CG）を順に送れる
      const open = entries.filter((c) => s.cgImages(c).length > 0);
      grid.replaceChildren(
        ...entries.map((c) => {
          const images = s.cgImages(c);
          const thumb = c.thumb ?? images[0] ?? null;
          const t: HTMLElement = tile(thumb, c.title ?? "", images.length === 0, () => openViewer(open, open.indexOf(c), t), c.folder, !c.thumb);
          if (images.length > 0 && c.description) t.title = c.description;
          return t;
        }),
      );
    };
    if (groups.length > 1) {
      for (const g of groups) {
        const b = button("lm-tab", g ?? TEXT.extra.ungrouped, () => showGroup(g));
        b.dataset.group = g ?? "";
        groupTabs.append(b);
      }
      wrap.append(groupTabs);
    }
    wrap.append(progress, grid);
    showGroup(groups.length > 1 && lastGroup !== null && groups.includes(lastGroup) ? lastGroup : (groups[0] ?? null));
    return wrap;
  }

  /**
   * CG を画面いっぱいに一つの画面として出す（裏の一覧とタブは inert にして、フォーカスを閉じ込める）。
   * - クリック、Enter、Space、パッドの A: 次の差分。最後の差分のあとは閉じる
   * - ←→、パッドの十字キーの左右: 前後の CG。↑↓、十字キーの上下: 前後の差分。ホイール: 前後（差分、続けて次の CG）
   * - 拡大: Ctrl を押しながらホイール（トラックパッドのピンチ）、指のピンチ、+ と -、パッドの RT と LT（0 とパッドの X で元に戻す）。
   *   拡大している間はドラッグ、ホイール、右スティックで動かす
   * - Esc、右クリック、パッドの B: 閉じる（システムが back を呼ぶ）
   */
  function openViewer(list: readonly ExtraCg[], start: number, opener: HTMLElement | null): void {
    if (start < 0 || !list[start]) return;
    let at = start;
    let i = 0;
    let scale = 1;
    let x = 0;
    let y = 0;
    const images = () => s.cgImages(list[at]!);
    const img = el("img");
    img.alt = "";
    img.draggable = false;
    const title = el("span", "lm-extra-caption-title");
    const description = el("span", "lm-extra-caption-text");
    const page = el("span", "lm-extra-page");
    const caption = el("div", "lm-extra-caption", title, description);
    const view = el("div", "lm-extra-viewer", img, caption, page);
    view.setAttribute("role", "dialog");
    view.setAttribute("aria-modal", "true");
    view.tabIndex = -1;
    viewer = view;

    /** 舞台の拡大・縮小（画面の px → 舞台の px）。 */
    const stageScale = () => view.getBoundingClientRect().width / (view.offsetWidth || 1) || 1;
    const clampPan = () => {
      const mx = ((scale - 1) * img.offsetWidth) / 2;
      const my = ((scale - 1) * img.offsetHeight) / 2;
      x = Math.min(mx, Math.max(-mx, x));
      y = Math.min(my, Math.max(-my, y));
    };
    const place = () => {
      clampPan();
      img.style.transform = scale === 1 ? "" : `translate(${x}px, ${y}px) scale(${scale})`;
      view.classList.toggle("is-zoomed", scale > 1);
    };
    /** 拡大する（cx・cy は動かさずにおく点。画面の座標。省けば真ん中）。 */
    const zoom = (next: number, cx?: number, cy?: number) => {
      const to = Math.min(CG_ZOOM_MAX, Math.max(1, next));
      if (to === scale) return;
      const r = view.getBoundingClientRect();
      const k = stageScale();
      // 押さえた点が同じところに残るように動かす（舞台の px で、真ん中からの位置）
      const px = cx === undefined ? 0 : (cx - (r.left + r.width / 2)) / k;
      const py = cy === undefined ? 0 : (cy - (r.top + r.height / 2)) / k;
      x = px - ((px - x) * to) / scale;
      y = py - ((py - y) * to) / scale;
      scale = to;
      if (scale === 1) x = y = 0;
      place();
    };
    const pan = (dx: number, dy: number) => {
      if (scale === 1) return;
      x += dx;
      y += dy;
      place();
    };
    const show = () => {
      const c = list[at]!;
      const files = images();
      i = Math.max(0, Math.min(i, files.length - 1));
      img.src = o.asset(c.folder ?? "bgimage", files[i]!);
      scale = 1;
      x = y = 0;
      place();
      title.textContent = c.title ?? "";
      description.textContent = c.description ?? "";
      caption.hidden = !c.title && !c.description;
      page.textContent = files.length > 1 ? `${i + 1} / ${files.length}` : "";
      view.setAttribute("aria-label", c.title || TEXT.extra.tabs.cg);
    };
    /** 次の差分。最後の差分なら、close のときは閉じ、そうでなければ次の CG へ。 */
    const next = (close: boolean) => {
      if (i + 1 < images().length) i++;
      else if (close) return closeViewer();
      else if (at + 1 < list.length) {
        at++;
        i = 0;
      } else return;
      playSound("page");
      show();
    };
    const prev = () => {
      if (i > 0) i--;
      else if (at > 0) {
        at--;
        i = images().length - 1;
      } else return;
      playSound("page");
      show();
    };
    const entry = (d: number) => {
      const to = at + d;
      if (to < 0 || to >= list.length) return;
      at = to;
      i = 0;
      playSound("page");
      show();
    };
    const variant = (d: number) => {
      const to = i + d;
      if (to < 0 || to >= images().length) return;
      i = to;
      playSound("page");
      show();
    };

    // 指とマウス: 拡大している間はドラッグで動かす（動かしたあとのクリックは送りにしない）。二本の指で拡大、横のスワイプで前後の CG
    const pointers = new Map<number, { x: number; y: number }>();
    let moved = false;
    let pinch: { distance: number; scale: number } | null = null;
    let from: { x: number; y: number } | null = null;
    const two = () => [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
    view.addEventListener("pointerdown", (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        moved = false;
        from = { x: e.clientX, y: e.clientY };
      } else if (pointers.size === 2) {
        const [a, b] = two();
        pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), scale };
        from = null;
        moved = true;
      }
    });
    view.addEventListener("pointermove", (e) => {
      const last = pointers.get(e.pointerId);
      if (!last) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size === 2) {
        const [a, b] = two();
        zoom((pinch.scale * Math.hypot(a.x - b.x, a.y - b.y)) / (pinch.distance || 1), (a.x + b.x) / 2, (a.y + b.y) / 2);
        return;
      }
      if (!moved && from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > 6) moved = true;
      if (moved && scale > 1) pan((e.clientX - last.x) / stageScale(), (e.clientY - last.y) / stageScale());
    });
    const release = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      // 拡大していないときの横のスワイプ（指）は前後の CG
      if (from && e.pointerType === "touch" && scale === 1 && pointers.size === 0) {
        const dx = e.clientX - from.x;
        const dy = e.clientY - from.y;
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) entry(dx < 0 ? 1 : -1);
      }
      if (pointers.size === 0) from = null;
    };
    view.addEventListener("pointerup", release);
    view.addEventListener("pointercancel", release);
    view.addEventListener("click", (e) => {
      e.stopPropagation();
      if (moved || scale > 1) {
        moved = false;
        return;
      }
      next(true);
    });
    // ホイール: Ctrl（トラックパッドのピンチ）で拡大、拡大している間は動かし、そうでなければ前後
    let wheelAt = 0;
    view.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.ctrlKey || e.metaKey) return zoom(scale * Math.exp(-e.deltaY / 300), e.clientX, e.clientY);
        if (scale > 1) return pan(-e.deltaX / stageScale(), -e.deltaY / stageScale());
        const now = performance.now();
        if (now - wheelAt < 150 || e.deltaY === 0) return;
        wheelAt = now;
        if (e.deltaY > 0) next(false);
        else prev();
      },
      { passive: false },
    );
    view.addEventListener("keydown", (e) => {
      const keys: Record<string, () => void> = {
        ArrowLeft: () => entry(-1),
        ArrowRight: () => entry(1),
        ArrowUp: () => variant(-1),
        ArrowDown: () => variant(1),
        Enter: () => next(true),
        " ": () => next(true),
        "+": () => zoom(scale * 1.25),
        "=": () => zoom(scale * 1.25),
        "-": () => zoom(scale / 1.25),
        "0": () => zoom(1),
      };
      const run = keys[e.key];
      if (!run || e.altKey || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      run();
    });
    // ゲームパッド（bindPlayerInput が lm-pad と lm-stick で知らせる）
    view.addEventListener("lm-pad", (e) => {
      const pads: Record<string, () => void> = {
        a: () => next(true),
        left: () => entry(-1),
        right: () => entry(1),
        up: () => variant(-1),
        down: () => variant(1),
        rt: () => zoom(scale * 1.25),
        lt: () => zoom(scale / 1.25),
        x: () => zoom(1),
      };
      const run = pads[(e as CustomEvent<{ button: string }>).detail.button];
      if (!run) return;
      e.preventDefault();
      run();
    });
    view.addEventListener("lm-stick", (e) => {
      const d = (e as CustomEvent<{ x: number; y: number; dt: number }>).detail;
      if (scale === 1) return;
      e.preventDefault();
      pan((-d.x * d.dt * 0.9) / stageScale(), (-d.y * d.dt * 0.9) / stageScale());
    });

    // 裏の一覧とタブは操作できないようにして、閉じたら開いたタイルへ戻る
    const behind = [...root.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c !== view);
    for (const b of behind) b.inert = true;
    restoreFocus = () => {
      for (const b of behind) b.inert = false;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
    show();
    root.append(view);
    view.focus({ preventScroll: true });
    playSound("open");
  }

  /** 閉じたときに裏を戻し、開いたものへフォーカスを戻す。 */
  let restoreFocus: (() => void) | null = null;

  function closeViewer(): void {
    viewer?.querySelector("video")?.pause();
    const had = viewer !== null;
    viewer?.remove();
    viewer = null;
    restoreFocus?.();
    restoreFocus = null;
    if (had) playSound("close");
  }

  /** ムービーの鑑賞: 再生したものだけ選べる。押すと画面いっぱいに流し（操作の帯つき）、終わるか Esc・右クリックで閉じる。 */
  function movieGrid(): HTMLElement {
    const grid = el("div", "lm-extra-grid");
    for (const m of o.extra.movies ?? []) {
      const seen = s.movie(m);
      const frame = el("span", "lm-extra-thumb");
      if (seen && m.thumb) {
        const img = el("img");
        img.src = o.asset("image", m.thumb);
        img.alt = "";
        img.draggable = false;
        frame.append(img);
      } else frame.append(el("span", "lm-extra-locked", seen ? "▶" : TEXT.extra.locked));
      const b = button("lm-extra-tile", "", () => openMovie(m));
      b.append(frame, el("span", "lm-extra-title", seen ? (m.title ?? m.file.replace(/^.*\//, "").replace(/\.[^.]+$/, "")) : TEXT.extra.unknown));
      b.disabled = !seen;
      grid.append(b);
    }
    return grid;
  }

  function openMovie(m: ExtraMovie): void {
    stopMusic();
    const video = el("video");
    video.src = o.asset("video", m.file);
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    // ゲームの中の @movie と同じ音量（コンフィグの BGM の音量 × 全体の音量。ミュートも効く）
    o.audio.bindMedia(video, 100);
    if (m.subtitles) {
      const track = el("track");
      track.kind = "subtitles";
      track.default = true;
      track.src = o.asset("video", m.subtitles);
      video.append(track);
    }
    video.addEventListener("ended", closeViewer);
    viewer = el("div", "lm-extra-viewer lm-extra-movie", video);
    // 動画の外を押したら閉じる（動画の上は再生の操作）
    viewer.addEventListener("click", (e) => {
      e.stopPropagation();
      if (e.target === viewer) closeViewer();
    });
    root.append(viewer);
    // 文書に入ってから showing にする。disabled のままだと WebKit は字幕を読まない（load も来ない）。
    const track = video.querySelector("track");
    if (track) track.track.mode = "showing";
  }

  /**
   * 立ち絵の鑑賞: 左にキャラクター（一つでも差分を見た人だけ）、右に立ち絵セットのタブと差分の並び（見た差分だけ選べる）と大きな立ち絵。
   */
  function characterView(): HTMLElement {
    const wrap = el("div", "lm-chars");
    const list = el("div", "lm-chars-list");
    const main = el("div", "lm-chars-main");
    const people = (o.extra.characters ?? []).map((c) => ({ c, seen: s.character(c) }));
    const showPerson = (c: ExtraCharacter, seen: Record<string, Record<string, Value>>) => {
      for (const b of list.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.who === c.who));
      const entry = o.cast?.[c.who];
      const appearances = Object.keys(entry?.appearances ?? {}).filter((a) => seen[a]);
      const tabs = el("div", "lm-tabs lm-chars-sets");
      const variants = el("div", "lm-chars-variants");
      const picture = el("div", "lm-chars-picture");
      const showSet = (a: string) => {
        for (const b of tabs.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.set === a));
        const set = entry?.appearances[a];
        const names = Object.keys(set?.variants ?? {});
        variants.replaceChildren(
          ...names.map((v) => {
            const open = !!seen[a]?.[v];
            const b = button("lm-toggle lm-chars-variant", open ? v : TEXT.extra.locked, () => void showVariant(a, v, b));
            b.disabled = !open;
            return b;
          }),
        );
        const first = names.find((v) => seen[a]?.[v]);
        if (first) void showVariant(a, first, variants.querySelector<HTMLButtonElement>(".lm-chars-variant:not(:disabled)"));
      };
      const showVariant = async (a: string, v: string, b: HTMLButtonElement | null) => {
        for (const x of variants.querySelectorAll("button")) x.setAttribute("aria-pressed", String(x === b));
        const url = await o.sprite?.(c.who, a, v);
        if (!url) return;
        const img = el("img");
        img.src = url;
        img.alt = "";
        img.draggable = false;
        picture.replaceChildren(img);
      };
      for (const a of appearances) {
        const b = button("lm-tab", entry?.appearances[a]?.label ?? a, () => showSet(a));
        b.dataset.set = a;
        tabs.append(b);
      }
      main.replaceChildren(el("div", "lm-chars-side", el("h3", "lm-chars-name", c.name ?? c.who), ...(appearances.length > 1 ? [tabs] : []), variants), picture);
      if (appearances[0]) showSet(appearances[0]);
    };
    for (const { c, seen } of people) {
      const b = button("lm-extra-row lm-chars-person", seen ? (c.name ?? c.who) : TEXT.extra.unknown, () => seen && showPerson(c, seen));
      b.dataset.who = c.who;
      b.disabled = !seen;
      list.append(b);
    }
    wrap.append(list, main);
    const first = people.find((p) => p.seen);
    if (first) showPerson(first.c, first.seen!);
    return wrap;
  }

  function replayGrid(): HTMLElement {
    const grid = el("div", "lm-extra-grid");
    for (const r of o.extra.replay ?? []) {
      const open = s.replay(r);
      grid.append(tile(r.thumb ?? null, r.title ?? r.id, !open, () => o.replay(r)));
    }
    return grid;
  }

  /**
   * 音楽室: 曲の一覧（聞いたことのある曲だけ選べる）と、下の再生の欄（今の曲、アーティスト、説明、シークバー、再生と一時停止、
   * 前後の曲、リピート（全曲、一曲、なし）、シャッフル）。全曲とリピートなしは曲を繰り返さずに鳴らし、終わったら次の曲へ進む。
   */
  function musicList(): HTMLElement {
    const tracks = o.extra.music ?? [];
    const wrap = el("div", "lm-music");
    const list = el("div", "lm-extra-list");
    const rows: HTMLButtonElement[] = [];
    const nameOf = (m: ExtraMusic) => m.title ?? m.file.replace(/^.*\//, "").replace(/\.[^.]+$/, "");
    tracks.forEach((m, i) => {
      const heard = s.music(m);
      const row = button("lm-extra-row lm-extra-track", "", () => (music.index === i ? toggle() : play(i)));
      row.append(
        el("span", "lm-extra-no", String(i + 1).padStart(2, "0")),
        el("span", "lm-extra-name", heard ? nameOf(m) : TEXT.extra.unknown),
        el("span", "lm-extra-artist", heard ? (m.artist ?? "") : ""),
      );
      row.disabled = !heard;
      rows.push(row);
      list.append(row);
    });
    // 再生の欄
    const title = el("span", "lm-music-title");
    const artist = el("span", "lm-music-artist");
    const description = el("p", "lm-music-description");
    const seek = el("input", "lm-music-seek") as HTMLInputElement;
    seek.type = "range";
    seek.min = "0";
    seek.step = "0.1";
    seek.setAttribute("aria-label", TEXT.extra.musicSeek);
    const time = el("span", "lm-music-time");
    const prev = button("lm-button lm-music-prev", "⏮", () => step(-1));
    const playButton = button("lm-button lm-music-play", "▶", () => toggle());
    const next = button("lm-button lm-music-next", "⏭", () => step(1));
    const repeat = button("lm-button lm-music-repeat", "", () => {
      music.repeat = music.repeat === "all" ? "one" : music.repeat === "one" ? "none" : "all";
      // 一曲リピートは曲を繰り返して鳴らす（埋め込みのループの位置も使う）。ほかは繰り返さない
      if (music.index !== null) play(music.index, true);
      sync();
    });
    const shuffle = button("lm-button lm-music-shuffle", TEXT.extra.musicShuffle, () => {
      music.shuffle = !music.shuffle;
      sync();
    });
    prev.setAttribute("aria-label", TEXT.extra.musicPrev);
    next.setAttribute("aria-label", TEXT.extra.musicNext);
    seek.addEventListener("input", () => {
      music.seeking = true;
      time.textContent = clock(Number(seek.value), Number(seek.max));
    });
    seek.addEventListener("change", () => {
      music.seeking = false;
      o.audio.seekBgm(Number(seek.value));
    });
    const player = el(
      "div",
      "lm-music-player",
      el("div", "lm-music-now", title, artist),
      description,
      el("div", "lm-music-bar", seek, time),
      el("div", "lm-music-buttons", prev, playButton, next, repeat, shuffle),
    );
    wrap.append(list, player);

    const heardIndexes = () => tracks.flatMap((m, i) => (s.music(m) ? [i] : []));
    function play(i: number, keepPosition = false): void {
      const m = tracks[i];
      if (!m || !s.music(m)) return;
      const at = keepPosition && music.index === i ? (o.audio.bgmProgress()?.position ?? 0) : 0;
      if (music.index !== null) o.audio.stopBgm(keepPosition ? 0 : 300);
      music.index = i;
      music.paused = false;
      void o.audio.playBgm(m.file, 100, music.repeat === "one", keepPosition ? 0 : 300).then(() => {
        if (at > 0 && music.index === i) o.audio.seekBgm(at);
      });
      playing = { file: m.file, row: rows[i]! };
      sync();
    }
    function toggle(): void {
      if (music.index === null) return play(heardIndexes()[0] ?? -1);
      if (music.paused) {
        if (!o.audio.resumeBgm()) play(music.index);
        music.paused = false;
      } else {
        o.audio.pauseBgm();
        music.paused = true;
      }
      sync();
    }
    function step(d: number): void {
      const heard = heardIndexes();
      if (heard.length === 0) return;
      if (music.shuffle && heard.length > 1) {
        const others = heard.filter((i) => i !== music.index);
        return play(others[Math.floor(Math.random() * others.length)]!);
      }
      const at = music.index === null ? -1 : heard.indexOf(music.index);
      play(heard[(at + d + heard.length) % heard.length]!);
    }
    function sync(): void {
      const m = music.index === null ? null : tracks[music.index]!;
      rows.forEach((r, i) => r.setAttribute("aria-pressed", String(i === music.index)));
      title.textContent = m ? nameOf(m) : TEXT.extra.musicNone;
      artist.textContent = m?.artist ?? "";
      description.textContent = m?.description ?? "";
      description.hidden = !m?.description;
      playButton.textContent = music.index !== null && !music.paused ? "⏸" : "▶";
      playButton.setAttribute("aria-label", music.index !== null && !music.paused ? TEXT.extra.musicPause : TEXT.extra.musicPlay);
      repeat.textContent = TEXT.extra.musicRepeat[music.repeat];
      shuffle.setAttribute("aria-pressed", String(music.shuffle));
      for (const b of [prev, next, playButton, seek]) b.disabled = heardIndexes().length === 0;
    }
    // シークバーと、曲の終わり（繰り返さないときは次の曲へ）を見る
    const timer = window.setInterval(() => {
      if (!wrap.isConnected) return window.clearInterval(timer);
      const p = o.audio.bgmProgress();
      if (!p || music.index === null) return;
      if (!music.seeking) {
        seek.max = String(p.duration);
        seek.value = String(p.position);
        time.textContent = clock(p.position, p.duration);
      }
      if (music.repeat !== "one" && !music.paused && p.position >= p.duration - 0.05) {
        const heard = heardIndexes();
        const last = heard.indexOf(music.index) === heard.length - 1;
        if (music.repeat === "none" && last && !music.shuffle) {
          stopMusic();
          sync();
        } else step(1);
      }
    }, 250);
    sync();
    return wrap;
  }

  function stopMusic(): void {
    if (!playing && music.index === null) return;
    playing?.row.setAttribute("aria-pressed", "false");
    playing = null;
    music.index = null;
    music.paused = false;
    o.audio.stopBgm(300);
  }

  function chapterList(): HTMLElement {
    const list = el("div", "lm-extra-list");
    (o.extra.chapters ?? []).forEach((c, i) => {
      const open = s.chapter(c);
      const row = button(`lm-extra-row lm-extra-chapter${open ? "" : " is-locked"}`, "", () => open && o.startChapter(c));
      row.disabled = !open;
      const thumb = el("span", "lm-extra-chapter-thumb");
      if (open && c.thumb) {
        const img = el("img");
        img.src = o.asset("bgimage", c.thumb);
        img.alt = "";
        thumb.append(img);
      }
      row.append(el("span", "lm-extra-no", String(i + 1).padStart(2, "0")), thumb, el("span", "lm-extra-text", el("span", "lm-extra-name", open ? c.title : TEXT.extra.unknown), el("span", "lm-extra-desc", open ? (c.synopsis ?? "") : "")));
      list.append(row);
    });
    return list;
  }

  function glossaryList(): HTMLElement {
    const list = el("div", "lm-extra-list lm-extra-glossary");
    const items = o.extra.glossary ?? [];
    list.append(el("p", "lm-extra-progress", TEXT.extra.progress(items.filter(s.glossary).length, items.length)));
    let group: string | undefined;
    // 読みの順（読みが無ければ語）で、まとまりごとに
    const sorted = [...items].sort((a, b) => (a.group ?? "").localeCompare(b.group ?? "", "ja") || (a.reading ?? a.term).localeCompare(b.reading ?? b.term, "ja"));
    for (const g of sorted) {
      if (g.group !== undefined && g.group !== group) list.append(el("h3", "lm-extra-group", g.group));
      group = g.group;
      const open = s.glossary(g);
      list.append(el("div", `lm-extra-row lm-extra-term${open ? "" : " is-locked"}`, el("span", "lm-extra-text", el("span", "lm-extra-name", open ? g.term : TEXT.extra.unknown), el("span", "lm-extra-desc", open ? g.description : ""))));
    }
    return list;
  }

  /** エンディングの一覧（フローチャートのエンディングのタブと同じ。着いたものは名前と場面の題、控えがあれば押すとそこから読み直す）。 */
  function endingList(): HTMLElement {
    const list = el("div", "lm-extra-list lm-flow-endings");
    void o.endings?.then((endings) => {
      const reached = endings.filter((e) => e.reached).length;
      list.replaceChildren(endings.length === 0 ? el("p", "lm-log-empty", TEXT.flowchart.noEndings) : el("p", "lm-extra-progress", TEXT.extra.progress(reached, endings.length)));
      endings.forEach((e, i) => {
        const row = button(`lm-extra-row lm-flow-ending${e.reached ? "" : " is-locked"}`, "", () => e.reached && e.jump?.());
        row.disabled = !e.reached || !e.jump;
        if (e.kind) row.dataset.kind = e.kind;
        row.append(el("span", "lm-extra-no", String(i + 1).padStart(2, "0")), el("span", "lm-extra-text", el("span", "lm-extra-name", e.reached ? e.name : TEXT.flowchart.locked), el("span", "lm-extra-desc", e.reached ? e.title : "")));
        list.append(row);
      });
    });
    return list;
  }

  function achievementList(): HTMLElement {
    const list = el("div", "lm-extra-list");
    const items = o.extra.achievements ?? [];
    const done = items.filter((a) => s.achievement(a) !== null).length;
    list.append(el("p", "lm-extra-progress", TEXT.extra.progress(done, items.length)));
    for (const a of items) {
      const at = s.achievement(a);
      const hidden = at === null && a.hidden === true;
      const icon = el("span", "lm-extra-icon");
      if (at !== null && a.icon) {
        const img = el("img");
        img.src = o.asset("image", a.icon);
        img.alt = "";
        icon.append(img);
      } else {
        icon.textContent = at !== null ? "★" : "☆";
      }
      const text = el("span", "lm-extra-text", el("span", "lm-extra-name", hidden ? TEXT.extra.unknown : a.title), el("span", "lm-extra-desc", hidden ? TEXT.extra.hiddenDescription : (a.description ?? "")));
      // 数を数える実績は、解放するまで「今の数 / 目標」
      const counted = at === null && typeof a.goal === "number" && !hidden ? TEXT.extra.progress(Math.min(s.achievementProgress(a), a.goal), a.goal) : "";
      const row = el("div", `lm-extra-row lm-extra-achievement${at === null ? " is-locked" : ""}`, icon, text, el("span", "lm-extra-date", at ? formatDate(at) : counted));
      list.append(row);
    }
    return list;
  }

  const first = o.tab && tabs.includes(o.tab) ? o.tab : lastTab && tabs.includes(lastTab) ? lastTab : tabs[0];
  if (first) show(first);
  else body.append(el("p", "lm-log-empty", TEXT.extra.empty));

  return {
    el: root,
    back: () => {
      if (!viewer) return false;
      closeViewer();
      return true;
    },
    dispose: stopMusic,
  };
}

/** 秒を「分:秒 / 分:秒」に。 */
function clock(at: number, total: number): string {
  const f = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  return `${f(at)} / ${f(total)}`;
}
