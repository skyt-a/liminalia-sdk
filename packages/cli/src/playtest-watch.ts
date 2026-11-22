import { closeSync, mkdirSync, openSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { cgMatcher, endingKinds, type CgMatcher } from "@liminalia/lang";
import type { Project } from "@liminalia/project";
import { avoidEndingNotes, DEFAULT_AVOID_ENDINGS, endingTraps, projectStoryMap } from "./playtest-avoid.ts";
import { str, type Flags } from "./context.ts";

/**
 * lim playtest の付け足し（送りの手順 playtest-drive.ts の外に置く）。
 * - --fast: 待ち時間（setTimeout）と、回数の決まったアニメーションを詰める。繰り返し続けるアニメーションはそのまま。
 * - --log: ページごとの位置、話者、本文、ボイスと、舞台の状態（背景、CG、立ち絵、画像、BGM、ループの効果音）を <out>/playtest/run-N.jsonl に残す。
 * - --shots: 背景、立ち絵、画像（CG を含む）が変わったページと選択肢で、スクリーンショットを <out>/playtest/run-N/ に撮る（--log も付ける）。
 * - --avoid-choice・--avoid-ending（liminalia.json の playtest.avoidChoices・avoidEndings）: 文を含む選択肢と、
 *   避けるエンディングにしか到達しない選択肢を、ほかに選べるものがあれば選ばない（--choose で決めた選択は変えない）。
 * 送りの手順は、ページで window.__liminaliaPlaytest があれば step・pick・choice を呼ぶ（WATCH_SOURCE が置く）。
 */

/** lim playtest のコマンドラインの付け足し。 */
export interface PlaytestWatchOptions {
  fast?: boolean;
  log?: boolean;
  shots?: boolean;
  /** 選ばない選択肢の文（含んでいれば）。 */
  avoidChoices?: string[];
  /** 向かわないエンディングの種類（ending= の bad など。種類でない文字なら、名前の title= に含むもの）。 */
  avoidEndings?: string[];
}

/** 詰める倍率（待ち時間は 1/20、アニメーションは 20 倍の速さ）。 */
export const FAST_RATE = 20;

/**
 * --fast でページを開く前に差し込む手順（page.addInitScript）。setTimeout の待ちを 1/FAST_RATE にし、
 * 動き始めたアニメーション（CSS のものも）のうち終わりのあるものを FAST_RATE 倍の速さにする。
 * DOM の作りに頼らない（XML の文書や head の無い文書でも動く）。
 */
export const FAST_SOURCE = `(() => {
  const RATE = ${FAST_RATE};
  const timeout = window.setTimeout.bind(window);
  window.setTimeout = function (fn, ms, ...rest) {
    const n = Number(ms) || 0;
    return timeout(fn, n > 0 ? n / RATE : n, ...rest);
  };
  const seen = new WeakSet();
  const sweep = () => {
    try {
      if (typeof document.getAnimations === "function") {
        for (const a of document.getAnimations()) {
          if (seen.has(a)) continue;
          seen.add(a);
          const timing = a.effect && a.effect.getComputedTiming();
          if (timing && Number.isFinite(timing.endTime)) a.updatePlaybackRate(a.playbackRate * RATE);
        }
      }
    } catch {
      // 終わったアニメーションや、文書が替わる途中
    }
    timeout(sweep, 30);
  };
  timeout(sweep, 30);
})()`;

/**
 * 送りの手順の口（window.__liminaliaPlaytest）を置く（page.evaluate に文字のまま渡す。引数は { log, avoidChoices, traps }）。
 * - step(): クリック待ちの新しいページなら、位置、話者、本文、ボイス、舞台の状態を window.__liminaliaPlaytestReport へ渡す（log のとき）
 * - pick(buttons, i): i 番目が避ける選択肢なら、そこから順に避けないものを探して番号を返す（無ければ i のまま）
 * - choice(buttons, i): 選ぶ選択肢を知らせる（log のとき）
 * 選択肢のジャンプ先は、描画側の host.choose に実行器が渡すもの（ファイルかファイル#ラベル）を控えて使う。
 */
export const WATCH_SOURCE = `(o) => {
  const l = window.__liminalia;
  const host = l.host;
  const report = o.log ? window.__liminaliaPlaytestReport : null;
  const traps = new Set(o.traps);
  let offered = [];
  const choose = host.choose;
  host.choose = function (options, signal, looks, targets, ...rest) {
    offered = targets || [];
    return choose.call(this, options, signal, looks, targets, ...rest);
  };
  const where = () => {
    const rt = l.runtime();
    return rt && rt.at ? rt.at.file + ":" + rt.at.line : null;
  };
  const textOf = (b) => ((b.textContent || "").trim() || b.getAttribute("aria-label") || (b.querySelector("img") && b.querySelector("img").alt) || "").trim();
  const stage = () => {
    const rt = l.runtime();
    if (!rt) return null;
    const s = rt.state.stage;
    const out = {};
    const bg = typeof s.background === "string" ? s.background : s.background && s.background.image;
    if (bg) out.bg = bg;
    const planes = Object.entries(s.planes || {});
    if (planes.length > 0) out.planes = Object.fromEntries(planes.map(([name, p]) => [name, p.image]));
    const images = [];
    for (const [layer, items] of Object.entries((s.extra && s.extra["image.layers"]) || {})) for (const item of items || []) images.push(layer + ":" + (item.file || item.kind));
    if (images.length > 0) out.images = images;
    const sprites = Object.entries(s.sprites || {});
    if (sprites.length > 0) out.sprites = Object.fromEntries(sprites.map(([who, p]) => [who, (p.appearance ? p.appearance + "/" : "") + p.variant + "@" + p.at]));
    if (s.bgm) {
      out.bgm = s.bgm.file;
      if (s.bgm.paused) out.bgmPaused = true;
    }
    const se = Object.entries(s.loopingSe || {}).filter(([, x]) => !x.paused);
    if (se.length > 0) out.se = Object.fromEntries(se.map(([ch, x]) => [ch, x.file]));
    if (s.mask) out.mask = s.mask;
    return out;
  };
  const look = (s) => JSON.stringify(s ? [s.bg, s.planes, s.images, s.sprites] : null);
  const page = (at) => {
    const log = l.system.backlog;
    const last = log && log.length > 0 ? log[log.length - 1] : null;
    if (last && !last.choice && last.at && last.at.file + ":" + last.at.line === at) {
      const text = last.parts.map((p) => ("br" in p ? "\\n" : p.text || "")).join("");
      return { name: last.label || last.speaker || "", text, voice: last.voice ? last.voice.file : "" };
    }
    const msg = document.querySelector(".message");
    const plain = (el) => {
      if (!el) return "";
      const copy = el.cloneNode(true);
      for (const x of copy.querySelectorAll("rt, .glyph")) x.remove();
      return (copy.textContent || "").trim();
    };
    return { name: plain(msg && msg.querySelector(".name")), text: plain(msg && msg.querySelector(".text")), voice: "" };
  };
  let lastPages = -1;
  let lastLook = "";
  const avoided = (buttons) => {
    const all = [...document.querySelectorAll(".layer.choices button")];
    const targets = buttons.map((b) => offered[all.indexOf(b)]);
    // 飛び先の分かるものがどれも避けるシーンなら、この選択肢では避けない（飛び先の分からないものだけを選び続けないように）
    const known = targets.filter((t) => typeof t === "string");
    const allTrapped = known.length > 0 && known.every((t) => traps.has(t));
    return buttons.map((b, i) => {
      const text = textOf(b);
      const target = targets[i];
      return o.avoidChoices.some((a) => text.includes(a)) || (!allTrapped && typeof target === "string" && traps.has(target));
    });
  };
  const state = (window.__liminaliaPlaytest = {
    avoided: 0,
    async step() {
      if (!report || !host.waiting) return;
      const pages = l.pages();
      if (pages === lastPages) return;
      lastPages = pages;
      const at = where();
      const s = stage();
      const key = look(s);
      const changed = key !== lastLook;
      lastLook = key;
      const p = page(at);
      await report({ kind: "page", n: pages, at, name: p.name, text: p.text, voice: p.voice, stage: s, changed });
    },
    pick(buttons, i) {
      const bad = avoided(buttons);
      if (!bad[i]) return i;
      for (let k = 1; k < buttons.length; k++) {
        const j = (i + k) % buttons.length;
        if (!bad[j]) {
          state.avoided++;
          return j;
        }
      }
      return i;
    },
    async choice(buttons, i) {
      if (!report) return;
      const s = stage();
      lastLook = look(s);
      const bad = avoided(buttons);
      await report({ kind: "choice", n: l.pages(), at: where(), options: buttons.map(textOf), pick: i, avoided: buttons.map(textOf).filter((_, k) => bad[k]), stage: s, changed: true });
    },
  });
}`;

/** 撮る前に、終わりのあるアニメーションを終わりの姿にし、画像の読み込みを待つ（ページで評価する式）。 */
const SETTLE_SOURCE = `(async () => {
  for (const a of document.getAnimations()) {
    try {
      const timing = a.effect && a.effect.getComputedTiming();
      if (timing && Number.isFinite(timing.endTime) && a.playState === "running") a.finish();
    } catch {
      // 終われないもの
    }
  }
  const images = [...document.querySelectorAll("img")].filter((i) => !i.complete);
  await Promise.race([Promise.all(images.map((i) => i.decode().catch(() => undefined))), new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50)))]);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
})()`;

/** 舞台の状態（WATCH_SOURCE の stage）。 */
export interface StageSummary {
  bg?: string;
  /** 背景が CG（liminalia.json の extra.cg と extra.cgAuto）。 */
  cg?: true;
  planes?: Record<string, string>;
  /** 画像の層に置いたもの（"層:ファイル"）。 */
  images?: string[];
  /** 立ち絵（キャラクター ID → "立ち絵セット/差分@立ち位置"）。 */
  sprites?: Record<string, string>;
  bgm?: string;
  bgmPaused?: true;
  /** 鳴り続けている効果音（チャンネル → ファイル）。 */
  se?: Record<string, string>;
  mask?: string;
}

/** ページから届く知らせ。 */
interface Report {
  kind: "page" | "choice";
  n: number;
  at: string | null;
  name?: string;
  text?: string;
  voice?: string;
  options?: string[];
  pick?: number;
  avoided?: string[];
  stage: StageSummary | null;
  changed: boolean;
}

/** 背景が CG なら cg を付ける。 */
export function withCg(stage: StageSummary | null, isCg: CgMatcher | null): StageSummary | null {
  if (!stage || !isCg || !stage.bg || !isCg("bgimage", stage.bg)) return stage;
  const { bg, ...rest } = stage;
  return { bg, cg: true, ...rest };
}

/** スクリーンショットのファイルの名前（通し番号と位置）。 */
export function shotName(seq: number, at: string | null, kind: "page" | "choice"): string {
  return `${String(seq).padStart(4, "0")}_${(at ?? "x").replace(/[:/\\]/g, "_")}${kind === "choice" ? "_choice" : ""}.jpg`;
}

/** 一通りの付け足しの結果（PlaytestRun に足す）。 */
export interface WatchResult {
  /** ページのログ（--log・--shots）。 */
  log?: string;
  /** 撮ったスクリーンショットの数と場所（--shots）。 */
  shots?: { count: number; dir: string };
  /** 避けた選択肢の数（--avoid-choice・--avoid-ending）。 */
  avoided?: number;
}

/** 実行ごとの準備（ページを開く前に attach、ゲームが始まったら install、終わったら finish）。 */
export interface RunWatch {
  install(): Promise<void>;
  finish(end: { outcome: string; pages: number; at: string | null; seconds: number }): Promise<WatchResult>;
}

/** 作品の設定（liminalia.json の playtest）とコマンドラインを合わせた付け足し。何もしないなら null。 */
export interface PlaytestWatch {
  attach(page: Page, run: number): Promise<RunWatch>;
  /** 始めに出す知らせ（避けるエンディングの一覧。playtest-avoid.ts の avoidEndingNotes）。 */
  notes: string[];
}

export async function playtestWatch(project: Project, o: PlaytestWatchOptions = {}): Promise<PlaytestWatch | null> {
  const avoidChoices = [...(project.config.playtest?.avoidChoices ?? []), ...(o.avoidChoices ?? [])].filter((x) => x !== "");
  const avoidEndings = [...(project.config.playtest?.avoidEndings ?? []), ...(o.avoidEndings ?? [])].filter((x) => x !== "");
  const log = !!(o.log || o.shots);
  if (!o.fast && !log && avoidChoices.length === 0 && avoidEndings.length === 0) return null;
  const map = avoidEndings.length > 0 ? await projectStoryMap(project) : null;
  const kinds = endingKinds(project.config.endingKinds);
  const traps = map ? endingTraps(map, avoidEndings, kinds) : [];
  const notes = map ? avoidEndingNotes(map, avoidEndings, kinds) : [];
  const isCg = cgMatcher(project.config.extra);
  const folder = join(project.paths.out, "playtest");
  return {
    notes,
    async attach(page, run) {
      if (o.fast) await page.addInitScript(FAST_SOURCE);
      const logFile = join(folder, `run-${run + 1}.jsonl`);
      const shotDir = join(folder, `run-${run + 1}`);
      let fd: number | null = null;
      let seq = 0;
      let taken = 0;
      const started = Date.now();
      const write = (line: unknown) => {
        if (fd !== null) writeSync(fd, `${JSON.stringify(line)}\n`);
      };
      if (log) {
        mkdirSync(folder, { recursive: true });
        fd = openSync(logFile, "w");
        rmSync(shotDir, { recursive: true, force: true });
        if (o.shots) mkdirSync(shotDir, { recursive: true });
        await page.exposeFunction("__liminaliaPlaytestReport", async (r: Report) => {
          let shot: string | undefined;
          if (o.shots && r.changed) {
            shot = shotName(++seq, r.at, r.kind);
            // 止められなくてもそのまま撮る
            await page.evaluate(SETTLE_SOURCE).catch(() => undefined);
            await page.screenshot({ path: join(shotDir, shot), type: "jpeg", quality: 80 }).then(
              () => taken++,
              () => (shot = undefined),
            );
          }
          const { changed: _, stage, ...rest } = r;
          write({ ...rest, t: Date.now() - started, stage: withCg(stage, isCg), ...(shot ? { shot } : {}) });
        });
      }
      return {
        install: async () => {
          await page.evaluate(`(${WATCH_SOURCE})(${JSON.stringify({ log, avoidChoices, traps })})`);
        },
        finish: async (end) => {
          const result: WatchResult = {};
          // ページが閉じていれば避けた数は 0 とする
          const avoided = (await page.evaluate(() => (window as unknown as { __liminaliaPlaytest?: { avoided: number } }).__liminaliaPlaytest?.avoided ?? 0).catch(() => 0)) as number;
          if (avoidChoices.length > 0 || avoidEndings.length > 0) result.avoided = avoided;
          if (fd !== null) {
            write({ kind: "end", ...end, t: Date.now() - started });
            closeSync(fd);
            fd = null;
            result.log = logFile;
          }
          if (o.shots) result.shots = { count: taken, dir: shotDir };
          return result;
        },
      };
    },
  };
}

/** lim playtest の付け足しの旗（--fast、--log、--shots、--avoid-choice 文,…、--avoid-ending [種類,…]）。 */
export function playtestWatchFlags(f: Flags): PlaytestWatchOptions {
  const list = (name: string) =>
    str(f, name)
      ?.split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  const choices = list("avoid-choice");
  // 値なしの --avoid-ending は既定（種類 bad と、名前が DEAD END や GAME OVER のもの。playtest-avoid.ts）
  const endings = f.flags.get("avoid-ending") === true ? [...DEFAULT_AVOID_ENDINGS] : list("avoid-ending");
  return {
    ...(f.flags.has("fast") ? { fast: true } : {}),
    ...(f.flags.has("log") ? { log: true } : {}),
    ...(f.flags.has("shots") ? { shots: true } : {}),
    ...(choices?.length ? { avoidChoices: choices } : {}),
    ...(endings?.length ? { avoidEndings: endings } : {}),
  };
}
