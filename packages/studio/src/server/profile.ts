import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { ProfileEvent, ProfileReport, ProfileSample } from "../protocol.ts";
import type { BrowserPage, BrowserProvider } from "./browser.ts";

/**
 * 重さの計測（lim profile と制作画面のチェックの「重さを計る」が使う。数値はゲームの画面の F10 と同じ、@liminalia/web の perf-watch.ts）。
 * 開いたプレイヤー（?start=…&autostart=1）を決めたページ数だけ進めながら、ページごとにフレームレートなどを取る。
 */

/** 開発サーバーのプレイヤーが window.__liminaliaPerf に置く計測の数値。 */
type PerfSnapshot = ReturnType<NonNullable<Window["__liminaliaPerf"]>["snapshot"]>;

export interface MeasureOptions {
  /** 進めるページの数。 */
  pages: number;
  /** ページを出し切ってから次へ進めるまで待つミリ秒（その間のフレームレートを計る）。 */
  wait: number;
  /** 選択肢で選ぶ番号（0 始まり）を順に。使い切ったら最初の選択肢。 */
  choose: number[];
  /** ページを取るたびに呼ぶ（page は 1 から、pages を超えない）。 */
  progress?: (page: number, pages: number, at: string) => void;
  /** 止めたら、次のページを取る前に投げる（ProfileCancelled）。 */
  signal?: AbortSignal;
}

/** 計測を途中で止めた。 */
export class ProfileCancelled extends Error {
  constructor() {
    super("計測を止めました");
  }
}

/** プレイヤーを開く URL（開発サーバーの base から）。 */
export function profileUrl(base: string, target: string): string {
  return `${base.replace(/\/$/, "")}/?start=${encodeURIComponent(target)}&autostart=1`;
}

/**
 * 開いたプレイヤーを進めながら計る。送るたびに、ページを出し切って待つ（行の途中の {click} も一回と数える）か、選択肢か、終わりになるまで待つ。
 * ページの数が pages に達するか、送った回数が pages の 4 倍を超えたら止める。
 */
export async function measureProfile(page: BrowserPage, target: string, o: MeasureOptions): Promise<ProfileReport> {
  const stopIfAsked = () => {
    if (o.signal?.aborted) throw new ProfileCancelled();
  };
  await page.waitFor(() => !!window.__liminalia?.system && !!window.__liminaliaPerf, null, 60_000);
  await page.evaluate(() => {
    window.__liminaliaPerf!.reset();
    window.__liminaliaPerf!.start("profile");
  }, null);
  const samples: ProfileSample[] = [];
  let first: PerfSnapshot | null = null;
  let last: PerfSnapshot | null = null;
  const choices = [...o.choose];
  for (let step = 0; step < o.pages * 4; step++) {
    stopIfAsked();
    await page.waitFor(
      () => {
        const l = window.__liminalia;
        return !!l && (l.ended || l.host.waiting || l.system.status?.choosing === true);
      },
      null,
      60_000,
    );
    await new Promise((r) => setTimeout(r, o.wait));
    stopIfAsked();
    const s = await sample(page);
    first ??= s.snap;
    last = s.snap;
    const total = Object.values(s.snap.resources).reduce((a, r) => a + r.count, 0);
    const prev = samples.at(-1);
    const row: ProfileSample = { page: s.pages, at: s.at, fps: s.snap.fps, memory: s.snap.memory?.used ?? null, dom: s.snap.dom, resources: total, longFrames: s.snap.frames.long };
    // 同じページの途中のクリック待ちは、一つの行にまとめる（後の値で上書き）
    if (prev && prev.page === row.page) samples[samples.length - 1] = row;
    else samples.push(row);
    o.progress?.(Math.min(s.pages, o.pages), o.pages, s.at);
    if (s.ended || (s.pages >= o.pages && !s.choosing)) break;
    if (s.choosing) {
      const pick = choices.shift() ?? 0;
      await page.evaluate((i) => {
        const buttons = document.querySelectorAll<HTMLButtonElement>(".layer.choices button");
        (buttons[i] ?? buttons[0])?.click();
      }, pick);
    } else await page.evaluate(() => window.__liminalia!.host.advance(), null);
    // 送ったことが効く（待ちが解ける）まで少し待つ
    await page
      .waitFor(
        () => {
          const l = window.__liminalia!;
          return l.ended || !l.host.waiting;
        },
        null,
        3000,
      )
      .catch(() => undefined);
  }
  last = (await sample(page)).snap;
  return summarize(target, samples, first, last);
}

async function sample(page: BrowserPage): Promise<{ snap: PerfSnapshot; at: string; pages: number; ended: boolean; choosing: boolean }> {
  return page.evaluate(() => {
    const l = window.__liminalia!;
    const at = l.runtime()?.at ?? null;
    return { snap: window.__liminaliaPerf!.snapshot(), at: at ? `${at.file}:${at.line}` : "", pages: l.pages(), ended: l.ended, choosing: l.system.status?.choosing === true };
  }, null);
}

/** ページごとの計測と、始めと終わりの数値から、結果をまとめる。 */
export function summarize(target: string, samples: ProfileSample[], first: PerfSnapshot | null, last: PerfSnapshot | null): ProfileReport {
  const fpsList = samples.map((s) => s.fps).filter((f): f is number => f !== null);
  const memList = samples.map((s) => s.memory).filter((m): m is number => m !== null);
  return {
    target,
    pages: samples.length,
    samples,
    summary: {
      fps: { average: fpsList.length ? Math.round(fpsList.reduce((a, b) => a + b, 0) / fpsList.length) : null, min: fpsList.length ? Math.min(...fpsList) : null },
      frames: last?.frames ?? { count: 0, long: 0, longest: 0 },
      longTasks: last?.longTasks ?? null,
      memory: { start: first?.memory?.used ?? null, end: last?.memory?.used ?? null, max: memList.length ? Math.max(...memList) : null, limit: last?.memory?.limit ?? null },
      dom: { max: Math.max(0, ...samples.map((s) => s.dom)) },
      resources: last?.resources ?? { image: { count: 0, bytes: 0 }, audio: { count: 0, bytes: 0 }, video: { count: 0, bytes: 0 }, font: { count: 0, bytes: 0 }, other: { count: 0, bytes: 0 } },
      slowest: last?.slowest ?? [],
    },
  };
}

/**
 * 制作画面の「重さを計る」（POST /profile）: base の開発サーバーのプレイヤーを開いて計り、進み具合と結果を順に出す。
 * 終わったら 計測.md・計測.json を exports/profile に書く（language が en なら profile.md・profile.json）。signal で止めたら、ブラウザを閉じて何も書かずに終わる。
 */
export async function* profileEvents(o: { provider: BrowserProvider; base: string; root: string; size: { width: number; height: number }; target: string; pages: number; signal: AbortSignal; language?: ProfileLanguage }): AsyncGenerator<ProfileEvent> {
  const queue: ProfileEvent[] = [];
  let wake: (() => void) | null = null;
  const push = (e: ProfileEvent) => {
    queue.push(e);
    wake?.();
  };
  let finished = false;
  let failure: unknown = null;
  const job = (async () => {
    const page = await o.provider.open(profileUrl(o.base, o.target), o.size);
    // 止めたら、待っているところでもすぐ閉じる（待ちは閉じたことで失敗して終わる）
    const stop = () => void page.close().catch(() => undefined);
    o.signal.addEventListener("abort", stop);
    try {
      const report = await measureProfile(page, o.target, { pages: o.pages, wait: 500, choose: [], signal: o.signal, progress: (page, pages, at) => push({ type: "progress", page, pages, at }) });
      if (o.signal.aborted) return;
      const lang = o.language ?? "ja";
      const dir = writeProfileReport(o.root, report, undefined, lang);
      const folder = relative(o.root, dir).split(sep).join("/");
      push({ type: "done", report, folder, file: `${folder}/${PROFILE_FILES[lang].markdown}` });
    } finally {
      o.signal.removeEventListener("abort", stop);
      await page.close().catch(() => undefined);
    }
  })()
    .catch((e: unknown) => {
      if (!o.signal.aborted && !(e instanceof ProfileCancelled)) failure = e;
    })
    .finally(() => {
      finished = true;
      wake?.();
    });
  try {
    for (;;) {
      const next = queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (finished) break;
      await new Promise<void>((r) => (wake = r));
      wake = null;
    }
    if (failure) throw failure;
  } finally {
    // 画面が切ったら（signal）計測も止まる。止まり終えるまで待ってから戻る（次の計測とブラウザが重ならないように）
    await job;
  }
}

export type ProfileLanguage = "ja" | "en";

/**
 * 書き出すファイルの名前。日本語は前からの名前のまま（既に使っている人の手順や読み込みを壊さない）、英語（lim profile --lang en、
 * Studio の英語の表示）は英語の名前にする。
 */
export const PROFILE_FILES: Record<ProfileLanguage, { markdown: string; json: string }> = {
  ja: { markdown: "計測.md", json: "計測.json" },
  en: { markdown: "profile.md", json: "profile.json" },
};

/** 計測.md と 計測.json（en なら profile.md と profile.json）を書く（folder は作品のフォルダからのパス。既定 exports/profile）。書いたフォルダの絶対パスを返す。 */
export function writeProfileReport(root: string, report: ProfileReport, folder = "exports/profile", language: ProfileLanguage = "ja"): string {
  const dir = resolve(root, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, PROFILE_FILES[language].markdown), profileMarkdown(report, language));
  writeFileSync(join(dir, PROFILE_FILES[language].json), `${JSON.stringify(report, null, 2)}\n`);
  return dir;
}

export const mb = (n: number | null) => (n === null ? "—" : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** 計測.md（en なら profile.md）の中身。 */
export function profileMarkdown(r: ProfileReport, language: ProfileLanguage = "ja"): string {
  if (language === "en") return profileMarkdownEn(r);
  const s = r.summary;
  const out = [`# パフォーマンス計測（${r.target} から ${r.pages} ページ）`, ""];
  out.push("| 項目 | 値 |", "|---|---|");
  out.push(`| フレームレート（平均、最低） | ${s.fps.average ?? "—"} fps、${s.fps.min ?? "—"} fps |`);
  out.push(`| 長いフレーム（50ms 超） | ${s.frames.long} / ${s.frames.count}（一番長いもの ${s.frames.longest} ms） |`);
  if (s.longTasks) out.push(`| 長いタスク | ${s.longTasks.count}（合計 ${s.longTasks.total} ms） |`);
  out.push(`| JS のメモリ（始め、終わり、最大） | ${mb(s.memory.start)}、${mb(s.memory.end)}、${mb(s.memory.max)} |`);
  out.push(`| DOM の要素（最大） | ${s.dom.max} |`);
  const names: Record<string, string> = { image: "画像", audio: "音声", video: "動画", font: "フォント", other: "そのほか" };
  for (const [k, v] of Object.entries(s.resources)) if (v.count > 0 || k === "image" || k === "audio") out.push(`| 読み込んだ${names[k]} | ${v.count} 個、${mb(v.bytes)} |`);
  out.push("", "## 読み込みに時間のかかった素材", "", "| 素材 | 時間 | 大きさ |", "|---|---:|---:|");
  for (const x of s.slowest) out.push(`| ${x.name} | ${x.ms} ms | ${(x.bytes / 1024).toFixed(1)} KB |`);
  out.push("", "## ページごと", "", "| ページ | 位置 | fps | JS のメモリ | DOM の要素 | 素材の数 | 長いフレーム |", "|---:|---|---:|---:|---:|---:|---:|");
  for (const x of r.samples) out.push(`| ${x.page} | ${x.at} | ${x.fps ?? "—"} | ${mb(x.memory)} | ${x.dom} | ${x.resources} | ${x.longFrames} |`);
  return `${out.join("\n")}\n`;
}

const countEn = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function profileMarkdownEn(r: ProfileReport): string {
  const s = r.summary;
  const out = [`# Performance profile (${countEn(r.pages, "page")} from ${r.target})`, ""];
  out.push("| Item | Value |", "|---|---|");
  out.push(`| Frame rate (average, lowest) | ${s.fps.average ?? "—"} fps, ${s.fps.min ?? "—"} fps |`);
  out.push(`| Long frames (over 50 ms) | ${s.frames.long} / ${s.frames.count} (longest ${s.frames.longest} ms) |`);
  if (s.longTasks) out.push(`| Long tasks | ${s.longTasks.count} (${s.longTasks.total} ms in total) |`);
  out.push(`| JS memory (start, end, highest) | ${mb(s.memory.start)}, ${mb(s.memory.end)}, ${mb(s.memory.max)} |`);
  out.push(`| DOM elements (highest) | ${s.dom.max} |`);
  const names: Record<string, [string, string]> = { image: ["image", "Images"], audio: ["audio file", "Audio"], video: ["video", "Videos"], font: ["font", "Fonts"], other: ["file", "Other files"] };
  for (const [k, v] of Object.entries(s.resources)) if (v.count > 0 || k === "image" || k === "audio") out.push(`| ${names[k]![1]} loaded | ${countEn(v.count, names[k]![0])}, ${mb(v.bytes)} |`);
  out.push("", "## Slowest assets to load", "", "| Asset | Time | Size |", "|---|---:|---:|");
  for (const x of s.slowest) out.push(`| ${x.name} | ${x.ms} ms | ${(x.bytes / 1024).toFixed(1)} KB |`);
  out.push("", "## By page", "", "| Page | Position | fps | JS memory | DOM elements | Assets | Long frames |", "|---:|---|---:|---:|---:|---:|---:|");
  for (const x of r.samples) out.push(`| ${x.page} | ${x.at} | ${x.fps ?? "—"} | ${mb(x.memory)} | ${x.dom} | ${x.resources} | ${x.longFrames} |`);
  return `${out.join("\n")}\n`;
}
