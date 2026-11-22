import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Page } from "playwright-core";
import { endingKinds } from "@liminalia/lang";
import type { Project } from "@liminalia/project";
import { resolveShotTarget } from "@liminalia/studio/target";
import { findChromium } from "../chromium.ts";
import { avoidEndingNotes, endingTraps, projectStoryMap } from "../playtest-avoid.ts";
import { startPlayerServer } from "../web.ts";
import { SegmentWriter, type AudioFormat } from "../video-encoder.ts";
import { estimateVideo, formatBytes, formatDuration, freeBytes, PROGRESS_FILE, reachedUntil, readProgress, recordedToEnd, redoSegment, RESUMABLE_STOPS, resumePoint, segmentFileName, segmentKey, untilPoint, writeProgress, type ResumeSnapshot, type SegmentRecord, type VideoProgress, type VideoSplit } from "../video-plan.ts";
import { backupResume } from "../video-backup.ts";
import { AudioAligner, FrameFeeder, VideoChooser, type ChooserState } from "../video-timeline.ts";

export { requireFfmpeg } from "../video-encoder.ts";
export { VIDEO_FPS } from "../video-timeline.ts";

/**
 * lim shot --video: 開始位置から実際の速さで送りながら録画し、mp4 にする。
 * showLine が true なら、画面の左上に実行中のシナリオの行（ファイル:行 と、その行の書き方）を出す（lim shot --line。出すのは録画のページだけ。遊ぶ人の画面には出さない）。
 * - 遊ぶ人の操作を待つ画面（選択肢、@investigate、@map-choice、作品のプラグインの画面）は、画面が知らせた選べるもの
 *   （RenderContext.offer）から、読む時間のあとに選ぶ（選び方は VideoChooser。--choose、--avoid-choice、--avoid-ending）
 * - @movie は飛ばせるものも飛ばさずに最後まで流し（送るのはクリック待ちのときだけなので、動画の送りで終わらせない）、流している間は止まった扱いにしない
 * - 音（BGM、効果音、ボイス、動画の音）は、エンジンの音の出口を AudioWorklet で写し、時刻を合わせて動画に重ねる
 * - コマ（Chromium の画面の流し出し）と音は ffmpeg にそのまま流して書いていく（ffmpeg が要る。無ければ始める前に止める）
 * - --split file|chapter は区切りごとに 出力フォルダ/<番号>_<名前>.mp4 に分け、どこまで録ったかを liminalia-video.json に書く（--resume で続きから。
 *   --redo 番号 でその区切りだけを、その最初のページから録り直す）。
 *   続きは、区切りに入る前の最後の待ちのセーブ（と temp の変数）から録らずに進め、区切りに入ったところから録る（区切りの頭の場面転換も入る）。
 *   --until と --pages で止めたときは、止めた所の次のクリック待ち（か選ぶ画面）のセーブを次の区切りとして書き、--resume でそこから続ける
 */
export interface VideoOptions {
  /** 外部から録画を中止する（録れたところを書き終える）。 */
  cancelled?: () => boolean;
  /** 画面の左上に、実行中のシナリオの行（ファイル:行）を出す（既定は出さない）。 */
  showLine?: boolean;
  endFile?: string;
  /** 指定した終了地点に着かずにゲームが終わったら失敗として知らせる。 */
  requireEnd?: boolean;
  onProgress?: (progress: { pages: number; file: string; line: number; seconds: number }) => void;
  /** 書き出す動画（mp4）。--split なら出力フォルダ。 */
  out: string;
  /** 録るページの数（最初のページを 1 と数える）。Infinity なら終わりまで。 */
  pages: number;
  /** ページを読む時間（ミリ秒。本文を出し終えてから送るまで。選択肢と選ぶ画面を見せてから選ぶまでも同じ）。 */
  readMs: number;
  /**
   * 本文の送りをエンジンのオートに任せる（遊ぶ人がオートにしたときと同じ。文字送りとボイスが終わってから、本文の長さに応じた間を置いて送る）。
   * このときの readMs は、選択肢と選ぶ画面を見せる時間にだけ使う。
   */
  auto: boolean;
  /** 選択肢の選び方（番号か、含む文。順に使い、使い切ったら同じ選択肢に戻るたびに次のもの）。 */
  choose: (number | string)[];
  /** 区切り方（none は一つの mp4）。 */
  split: VideoSplit;
  /** 止める所（ファイル[#ラベル]。そこに着いたら、そこは録らずに止める）。 */
  until?: string;
  /** 出力フォルダの記録から、続きを録る。 */
  resume: boolean;
  /** 出力フォルダの記録から、この番号の区切りだけを録り直す（次の区切りに入ったら止める。ほかの区切りと記録の終わりは変えない）。 */
  redo?: number;
  /** この秒数、ページも位置も進まず、動画もボイスも演出も動いていなければ止まった扱いにする。 */
  stuckSeconds: number;
  /** 音を入れる。 */
  audio: boolean;
  /** 選ばない選択肢の文（liminalia.json の playtest.avoidChoices に足す）。 */
  avoidChoices: string[];
  /** 向かわないエンディングの種類（liminalia.json の playtest.avoidEndings に足す）。 */
  avoidEndings: string[];
}

/** 録画の既定（--pages、--read、--stuck）。--split か --until を付けたときの --pages の既定は終わりまで。 */
export const VIDEO_DEFAULTS = { pages: 20, readMs: 1800, stuckSeconds: 60 } as const;

/** 録画を止めた理由。 */
export type VideoStop = "pages" | "ended" | "until" | "redone" | "stuck" | "looping" | "interrupted" | "disk" | "error";

/** ページが進まないまま選び続けてよい回数（越えたら looping で止める。選ぶたびに画面が変わるので、止まりの秒数には掛からない）。 */
export const MAX_PICKS_WITHOUT_PAGE = 60;

/** 最後まで録れた止まり方（終了の値 0）。 */
const COMPLETE: ReadonlySet<VideoStop> = new Set(["pages", "ended", "until", "redone"]);

/** 隅に出す文（ファイル:行 と、その行の書き方。長ければ切る）。 */
export function lineLabel(file: string, line: number, source: string | undefined): string {
  const code = (source ?? "").trim();
  const cut = code.length > 60 ? `${code.slice(0, 60)}…` : code;
  return cut ? `${file}.lim:${line}\n${cut}` : `${file}.lim:${line}`;
}

/** 止めた理由の文（動画: の行の括弧の中に添える）。英語の出力は lim の文言の表（messages-en.ts）で読み替える。 */
export function stopText(stop: VideoStop, stuckSeconds: number): string {
  return { pages: "", ended: "、プレイが終わりました", until: "、止める所に着きました", redone: "、区切りを録り直しました", stuck: `、${stuckSeconds} 秒進まなかったので止めました`, looping: `、ページが進まないまま ${MAX_PICKS_WITHOUT_PAGE} 回選んだので止めました`, interrupted: "、途中で止めました", disk: "、空きが少なくなったので止めました", error: "、録画の途中でエラーになりました" }[stop];
}

/** 録り終えたときの出力の行（動画、選んだもの、止まった所と続け方）。英語の出力は lim の文言の表で読み替える。 */
export function videoReport(r: VideoResult, o: { split: VideoSplit; out: string; resumed: boolean; redo?: boolean; avoiding: boolean; stuckSeconds: number }): string[] {
  const how = stopText(r.stopped, o.stuckSeconds);
  const lines: string[] = [];
  if (o.split === "none") lines.push(`動画: ${o.out}（${r.pages} ページ、${r.seconds} 秒${how}）`);
  else {
    lines.push(
      o.redo
        ? `動画: ${o.out}（録り直し ${r.files.length} 本、${r.pages} ページ、${r.seconds} 秒${how}）`
        : o.resumed
          ? `動画: ${o.out}（続きから ${r.files.length} 本、${r.pages} ページ、${r.seconds} 秒${how}）`
          : `動画: ${o.out}（${r.files.length} 本、${r.pages} ページ、${r.seconds} 秒${how}）`,
    );
    for (const f of r.files) lines.push(`  ${f}`);
  }
  if (r.choices.length > 12) lines.push(`選んだもの: ${r.choices.slice(0, 12).join(" → ")} ほか ${r.choices.length - 12} 回`);
  else if (r.choices.length > 0) lines.push(`選んだもの: ${r.choices.join(" → ")}`);
  if (o.avoiding) lines.push(`避けた選択肢: ${r.avoided} 回`);
  if (!COMPLETE.has(r.stopped)) {
    if (r.at) lines.push(`止まった所: ${r.at}`);
    // 選べるものを知らせない画面で止まったとき
    if (r.stopped === "stuck") lines.push("遊ぶ人の操作を待つ画面で止まったなら、その画面の描画で選べるものを ctx.offer で知らせると、録画が進められます（docs/plugins.md の「録画での進め方」）");
    if (o.split !== "none") lines.push(`録れた所までは残してあります。続きは --resume を付けて録ります（${PROGRESS_FILE}）`);
  } else if (r.continues) {
    lines.push(r.stopped === "until" ? `続きは --resume を付けて録ります（--until は先の所にするか外します。${PROGRESS_FILE}）` : `続きは --resume を付けて録ります（--pages は増やすか外します。${PROGRESS_FILE}）`);
  }
  return lines;
}

/** 画面のコマがページから届いてから、動画に書くまでの遅れ（ミリ秒。遅れて届いたコマも時刻どおりに並べる）。 */
const VIDEO_LAG = 250;
/** 音がページから届いてから書くまでの遅れ（ミリ秒。ページが忙しくて遅れた音も時刻どおりに並べる）。 */
const AUDIO_LAG = 1200;
/** ボイスが鳴り終えてから送るまでの間（ミリ秒）。 */
const VOICE_GAP = 400;
/** この空きを切ったら止める（バイト）。 */
const DISK_FLOOR = 512 * 1024 * 1024;
/** ffmpeg が追いつかず、書き込みを待つものがこれを超えたら止める（バイト）。 */
const BACKLOG_LIMIT = 512 * 1024 * 1024;

interface PlayerState {
  waiting: boolean;
  pages: number;
  at: [string, number] | null;
  /** 呼び出しとマクロの深さ（0 ならファイルの本体）。 */
  depth: number;
  ended: boolean;
  mode: string;
  /** 画面が知らせた選べるもの（選択肢も）。 */
  offer: { id: number; options: (string | null)[]; targets: (string | null)[] | null; proceed: number | null } | null;
  /** @movie を出している（飛ばせるものも）か、繰り返さない動画が流れている。 */
  playing: boolean;
  /** 終わりのある演出が動いている。 */
  animating: boolean;
  /** 鳴っているボイスの残り（ミリ秒）。 */
  voice: number;
  /** システムのオートが入っているか（標準のシステム画面の様子。持たないシステム画面なら null）。 */
  auto: boolean | null;
}

/** プレイヤーの今の様子（ページで評価する）。 */
const STATE_SOURCE = `(() => {
  const l = window.__liminalia;
  const h = l.host;
  const rt = l.runtime();
  let animating = false;
  try {
    animating = document.getAnimations().some((a) => {
      const t = a.effect && a.effect.getComputedTiming();
      return a.playState === "running" && t && Number.isFinite(t.endTime);
    });
  } catch {}
  return {
    waiting: !!h.waiting,
    pages: l.pages(),
    at: rt && rt.at ? [rt.at.file, rt.at.line] : null,
    depth: rt ? rt.state.callStack.length : 0,
    ended: !!l.ended,
    mode: l.screen().mode || "",
    offer: typeof h.offered === "function" ? h.offered() : null,
    // @movie は、飛ばせるものも、流し始める前（読み込み中）から終わるまで。ほかの動画は流れている間（繰り返すものは数えない）
    playing: [...document.querySelectorAll("video")].some((v) => !v.ended && !v.loop && (!v.paused || v.classList.contains("lim-movie"))),
    animating,
    voice: h.audio && typeof h.audio.voiceRemaining === "function" ? h.audio.voiceRemaining() : 0,
    auto: l.system.status && typeof l.system.request === "function" ? !!l.system.status.auto : null,
  };
})()`;

/**
 * 続きから録るためのセーブと、セーブに入らない temp の変数（ページで評価する。セーブを取れなければ null）。
 * temp は記録（liminalia-video.json）に書くので、JSON にできる値だけを写す。
 */
const SNAPSHOT_SOURCE = `(() => {
  const rt = window.__liminalia.runtime();
  const save = rt ? rt.save() : null;
  if (!save) return null;
  let temp = null;
  try {
    temp = JSON.parse(JSON.stringify(rt.state.temp || {}));
  } catch {
    // JSON にできない temp は戻さない（セーブだけで続ける）
    temp = null;
  }
  return { save, temp };
})()`;

/** セーブを読み、temp の変数を戻す（ページで評価する。読んだページを出し始めてから戻すので、そのあとの文から効く）。 */
const LOAD_SOURCE = `async ({ save, temp }) => {
  const l = window.__liminalia;
  l.host.automated = false;
  await l.system.loadSave(save);
  const rt = l.runtime();
  if (rt && temp) {
    rt.state.temp = temp;
    rt.variablesChanged("temp");
  }
}`;

/** セーブと temp（SNAPSHOT_SOURCE の結果）を、記録に書く形にする（空の temp は書かない）。 */
function snapshotOf(snap: { save: unknown; temp: Record<string, unknown> | null }, chooser: VideoChooser): ResumeSnapshot {
  return { save: snap.save, ...(snap.temp && Object.keys(snap.temp).length > 0 ? { temp: snap.temp } : {}), chooser: chooser.snapshot() as ChooserState };
}

/**
 * 区切りに入る前の最後の待ち（ResumePoint.lead）を読んだ所から、録らずに送って（選ぶ画面は選び方どおりに選んで）区切り（key）に入るまで進める。
 * 区切りの頭の場面転換などを、続けて録ったときと同じに録るため。入れたら true、プレイが終わったか stuckMs のあいだ進まなければ false。
 */
async function enterSegment(page: Page, o: { key: string; split: VideoSplit; chapters: Project["config"]["chapters"]; chooser: VideoChooser; stuckMs: number }): Promise<boolean> {
  // 前に送ったクリック待ちを抜けてから次を送る（同じクリック待ちで二度送らない）
  let left = true;
  let lastSent = "";
  /** 選んだ知らせの番号と時刻。 */
  let pickedId = -1;
  let pickedAt = 0;
  let signature = "";
  let movedAt = Date.now();
  for (;;) {
    // 様子を読めなければ（ページが閉じた）、進められなかったことにする
    const s = (await page.evaluate(STATE_SOURCE).catch(() => null)) as PlayerState | null;
    if (!s || s.ended || s.mode === "title") return false;
    if (s.at && s.depth === 0 && segmentKey(o.split, s.at[0], o.chapters).key === o.key) return true;
    const now = Date.now();
    const sig = JSON.stringify([s.pages, s.at, s.waiting, s.offer?.id ?? null, s.mode, s.depth]);
    if (sig !== signature || s.playing || s.voice > 0 || s.animating) {
      signature = sig;
      movedAt = now;
    }
    if (now - movedAt > o.stuckMs) return false;
    const offer = s.offer;
    if (offer) {
      // 選ぶものは一度だけ選び、進めるだけのもの（閉じる、OK）は閉じなければ押し直す
      if (pickedId !== offer.id || (offer.proceed !== null && now - pickedAt > 1000)) {
        const index = offer.proceed ?? o.chooser.pick(offer.options, offer.targets).index;
        pickedId = offer.id;
        pickedAt = now;
        // 選べなかったら、次の回でまた様子を見る
        await page.evaluate(([id, i]) => window.__liminalia!.host.chooseOffered(id, i), [offer.id, index] as const).catch(() => false);
      }
    } else if (!s.waiting) left = true;
    else if (left || JSON.stringify([s.pages, s.at]) !== lastSent) {
      left = false;
      lastSent = JSON.stringify([s.pages, s.at]);
      // 送れなくても、止まった扱いになるまで様子を見る
      await page.evaluate(() => window.__liminalia!.host.advance()).catch(() => undefined);
    }
    await page.waitForTimeout(30);
  }
}

/** システムのオートを入れる・切る（ページで評価する。@auto start・stop と同じ）。 */
const AUTO_SOURCE = `(on) => window.__liminalia.system.request({ name: "auto", args: { mode: on ? "start" : "stop" } })`;

/** 開発時の右上の位置の表示を隠す（ページで評価する。録画には常に入れる）。 */
const HIDE_STATUS_SOURCE = `(() => {
  const style = document.createElement("style");
  style.textContent = ".status { display: none !important; }";
  document.head.append(style);
})()`;

/** 隅の文を置く・書き換える（ページで評価する。showLine が true の録画だけ）。 */
const LABEL_SOURCE = `(text) => {
  let el = document.getElementById("lim-video-line");
  if (!el) {
    el = document.createElement("div");
    el.id = "lim-video-line";
    Object.assign(el.style, { position: "fixed", left: "12px", top: "10px", zIndex: "2147483647", background: "rgba(0, 0, 0, 0.72)", color: "#ffd84a", font: "14px/1.5 ui-monospace, Menlo, 'Hiragino Sans', monospace", padding: "6px 10px", maxWidth: "70vw", whiteSpace: "pre", overflow: "hidden", pointerEvents: "none" });
    document.body.append(el);
  }
  el.textContent = text;
}`;

/** 音を写す AudioWorklet（16 ビットにして、約 0.1 秒ごとに、その最後の標本の音の時刻と一緒に送る）。 */
const WORKLET_SOURCE = `class LiminaliaVideoTap extends AudioWorkletProcessor {
  constructor() { super(); this.parts = []; this.frames = 0; this.limit = Math.round(sampleRate / 10); }
  process(inputs) {
    const input = inputs[0];
    const n = input && input.length > 0 ? input[0].length : 128;
    const left = input && input[0];
    const right = input && (input[1] || input[0]);
    const out = new Int16Array(n * 2);
    if (left) {
      for (let i = 0; i < n; i++) {
        out[i * 2] = Math.max(-32768, Math.min(32767, Math.round(left[i] * 32767)));
        out[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(right[i] * 32767)));
      }
    }
    this.parts.push(out);
    this.frames += n;
    if (this.frames >= this.limit) {
      const all = new Int16Array(this.frames * 2);
      let at = 0;
      for (const p of this.parts) { all.set(p, at); at += p.length; }
      this.port.postMessage({ data: all.buffer, end: currentTime + n / sampleRate }, [all.buffer]);
      this.parts = [];
      this.frames = 0;
    }
    return true;
  }
}
registerProcessor("liminalia-video-tap", LiminaliaVideoTap);`;

/**
 * エンジンの音の出口（AudioPlayer.capture）を AudioWorklet で写し、window.__liminaliaVideoAudio(base64, 時刻) へ送る（ページで評価する）。
 * 時刻は、その音が鳴る時刻（Date.now と同じ時計のミリ秒。AudioContext の getOutputTimestamp で合わせる）。返すのは標本の速さ。
 */
const AUDIO_SOURCE = `async (code) => {
  const audio = window.__liminalia.host.audio;
  const ctx = audio.context;
  if (ctx.state !== "running") await ctx.resume().catch(() => undefined);
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
  const node = new AudioWorkletNode(ctx, "liminalia-video-tap", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: "explicit", channelInterpretation: "speakers" });
  const sink = ctx.createGain();
  sink.gain.value = 0;
  node.connect(sink).connect(ctx.destination);
  node.port.onmessage = (e) => {
    const ts = ctx.getOutputTimestamp();
    const perf = performance.now();
    const end = ts && ts.performanceTime > 0 ? Date.now() + (ts.performanceTime - perf) + (e.data.end - ts.contextTime) * 1000 : Date.now() - (ctx.currentTime - e.data.end) * 1000;
    const bytes = new Uint8Array(e.data.data);
    let s = "";
    for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    window.__liminaliaVideoAudio(btoa(s), end);
  };
  audio.capture(node);
  return { rate: ctx.sampleRate, state: ctx.state };
}`;

/** 録画の結果。 */
export interface VideoResult {
  pages: number;
  seconds: number;
  stopped: VideoStop;
  /** 書いた mp4（区切りの順）。 */
  files: string[];
  choices: string[];
  avoided: number;
  /** 止まった所（ファイル:行）。 */
  at: string | null;
  /** --until か --pages で止め、続きから録る所のセーブを記録に書いた（--resume で続けられる）。 */
  continues: boolean;
}

/** 録っている区切り。 */
interface Segment {
  record: SegmentRecord | null;
  key: string;
  writer: SegmentWriter;
  start: number;
  audio: AudioAligner | null;
  /** 区切りの終わりの時刻（閉じ始めたら入る）。 */
  end: number | null;
  /** 始めたときのページの数。 */
  pagesAtStart: number;
  /** 区切りに入る前の最後の待ち（続きから録るときに、ここから録らずに進めて区切りの頭から録る）。 */
  lead?: ResumeSnapshot;
}

/** lim shot --video の中身（lim shot が開始位置を確かめ、ffmpeg があることを確かめてから呼ぶ）。最後まで録れたら true。 */
export async function runShotVideo(project: Project, o: { target: string; skip: number; language?: string; video: VideoOptions }): Promise<boolean> {
  const v = o.video;
  const split = v.split;
  const outPath = resolve(v.out);
  const folder = split === "none" ? dirname(outPath) : outPath;
  if (split === "chapter" && !project.config.chapters?.length) throw new Error("--split chapter には liminalia.json の chapters が要ります（章を書くか、--split file で分けます）");
  if (v.resume && split === "none") throw new Error("--resume は --split と一緒に使います（どこまで録ったかを出力フォルダに書くため）");
  if (v.redo !== undefined && split === "none") throw new Error("--redo は --split と一緒に使います（区切りの番号は出力フォルダの記録にあります）");
  if (v.redo !== undefined && v.resume) throw new Error("--redo と --resume は一緒に使いません（--redo は一つの区切りだけ、--resume は続きを録ります）");
  if (split === "none" && existsSync(outPath) && statSync(outPath).isDirectory()) throw new Error(`${outPath} はフォルダです（--split を付けると、フォルダに区切りごとの mp4 を書きます）`);
  mkdirSync(folder, { recursive: true });
  const until = v.until ? untilPoint(project, resolveShotTarget(project, v.until)) : null;
  const avoidChoices = [...(project.config.playtest?.avoidChoices ?? []), ...v.avoidChoices].filter((x) => x !== "");
  const avoidEndings = [...(project.config.playtest?.avoidEndings ?? []), ...v.avoidEndings].filter((x) => x !== "");
  const map = await projectStoryMap(project);
  const kinds = endingKinds(project.config.endingKinds);
  const traps = new Set(endingTraps(map, avoidEndings, kinds));
  for (const line of avoidEndingNotes(map, avoidEndings, kinds)) console.log(line);

  // どこまで録ったか（--split のとき）
  let progress: VideoProgress | null = null;
  let resumeFrom: SegmentRecord | null = null;
  /** 続きから録るときに上書きする区切り（録り始める直前に控えてから消す）。 */
  let overwritten: SegmentRecord[] = [];
  if (split !== "none") {
    const old = readProgress(folder);
    if (v.redo !== undefined) {
      // 一つの区切りだけを録り直す（ほかの区切りの mp4 と記録、録り終えたかはそのまま）
      if (!old) throw new Error(`${folder} に録った記録（${PROGRESS_FILE}）がありません（--redo は録った区切りを録り直します）`);
      if (old.split !== split) throw new Error(`前の録画は --split ${old.split} で分けています（同じ分け方で録り直します）`);
      resumeFrom = redoSegment(old, v.redo);
      rmSync(join(folder, resumeFrom.file), { force: true });
      progress = old;
    } else if (v.resume) {
      if (!old) throw new Error(`${folder} に録った記録（${PROGRESS_FILE}）がありません（--resume を外すと、はじめから録ります）`);
      if (old.split !== split) throw new Error(`前の録画は --split ${old.split} で分けています（同じ分け方で続けます）`);
      if (recordedToEnd(old)) {
        console.log(`動画: ${folder}（もう最後まで録ってあります。録り直すなら、フォルダを消すか別のフォルダに書きます）`);
        return true;
      }
      resumeFrom = resumePoint(old);
      if (!resumeFrom) throw new Error("続きから録れる所がありません（最初のページを録る前に止まりました）。--resume を外して録り直します（フォルダの中身を消してから）");
      // --pages で止めた所から続けるときは、--pages を増やすか外す（同じ数のままでは録るページが無い）
      const from = resumeFrom.resume?.pages ?? 1;
      if (from > v.pages) throw new Error(`${from - 1} ページ目まではもう録ってあります。続けるなら --pages を ${from} 以上にするか外します`);
      // 続きから録る区切りと、その後に書きかけたものは録り直す（録り始める直前に、前の動画と記録を控えてから消す）
      overwritten = old.segments.filter((s) => s.n >= resumeFrom!.n);
      old.segments = old.segments.filter((s) => s.n < resumeFrom!.n);
      delete old.stopped;
      progress = old;
    } else {
      if (old) throw new Error(`${folder} には録った記録（${PROGRESS_FILE}）があります。続きから録るなら --resume を付け、録り直すならフォルダを消すか別のフォルダに書きます`);
      progress = { version: 1, project: project.config.id, split, start: o.target, segments: [], finished: false, updated: "" };
    }
  }

  // 見込みの大きさと空き
  const startAt = resumeFrom ? resumeTarget(resumeFrom) : o.target;
  const pagesLeft = v.pages - (resumeFrom?.resume?.pages ?? 1) + 1;
  const estimate = estimateVideo(project, map, { start: startAt, until, pages: pagesLeft, readMs: v.readMs, audio: v.audio });
  const free = freeBytes(folder);
  console.log(`見込み: 約 ${formatDuration(estimate.seconds)}、${formatBytes(estimate.bytes)}（${estimate.pages} ページ。分かれ道はどれも通るものとして数えます）。空き: ${formatBytes(free)}`);
  if (free < estimate.bytes + DISK_FLOOR) {
    throw new Error(`空きが足りません（見込み ${formatBytes(estimate.bytes)} と残しておく ${formatBytes(DISK_FLOOR)} に対して、空き ${formatBytes(free)}）。--pages か --until で短くするか、空きを作ってから録ります`);
  }

  const lang = o.language !== undefined ? `lang=${encodeURIComponent(o.language)}` : "";
  // 録画の出力（mp4 や liminalia-video.json）を作品の中に書いても読み直さないよう、ファイルの見張りを切る
  const { server, url } = await startPlayerServer(project, 0, true, { server: { watch: null } });
  const { chromium } = await import("playwright-core");
  // 音: 押す操作なしで鳴らし、音の時計を実際の時間で進める（音の出口を持たない仮の出口。手元のスピーカーからは鳴らない）
  // Ctrl+C はこちらで受けて、録れた所まで書き終えてから止める（Playwright にブラウザを閉じさせない）
  const browser = await chromium.launch({ executablePath: findChromium(), args: v.audio ? ["--autoplay-policy=no-user-gesture-required", "--disable-audio-output"] : ["--mute-audio"], handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
  const errors: string[] = [];
  let interrupted = false;
  const onSignal = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.log("止めています（ここまでの動画を書き終えます。もう一度押すとすぐ止めます）");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const page = await browser.newPage({ viewport: { width: project.screen.width, height: project.screen.height }, bypassCSP: true });
    // 長い録画でも溜めすぎない（同じものは一つ、200 件まで）
    const note = (line: string) => {
      if (errors.length < 200 && !errors.includes(line)) errors.push(line);
    };
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") note(`${m.type()}: ${m.text()}`);
    });
    page.on("pageerror", (e) => note(`pageerror: ${e.message}`));
    // 音の受け口（録っている区切りと、閉じかけの区切りへ）
    const open: Segment[] = [];
    await page.exposeFunction("__liminaliaVideoAudio", (b64: string, end: number) => {
      const pcm = Buffer.from(b64, "base64");
      for (const s of open) if (s.audio) for (const b of s.audio.chunk(end, pcm)) s.writer.writeAudio(b);
    });
    let chooser = new VideoChooser(v.choose, { choices: avoidChoices, traps }, resumeFrom?.resume?.chooser);
    /** 続きから: タイトルを開いてから、セーブを読み、セーブに入らない temp の変数を戻す（遊ぶ人の操作を待つ画面も動画も、そこからは映す）。 */
    const loadAt = async (at: ResumeSnapshot) => {
      await page.goto(`${url}?autostart=1&autoplay=1${lang ? `&${lang}` : ""}`);
      await page.waitForFunction(() => window.__liminalia?.screen().mode === "title", null, { timeout: 90_000 });
      await page.evaluate(`(${LOAD_SOURCE})(${JSON.stringify({ save: at.save, temp: at.temp ?? null })})`);
    };
    let entered = false;
    if (resumeFrom?.resume?.lead) {
      // 区切りに入る前の最後の待ちから、録らずに区切りに入るまで進める（区切りの頭の場面転換なども、続けて録ったときと同じに録る）
      await loadAt(resumeFrom.resume.lead);
      chooser = new VideoChooser(v.choose, { choices: avoidChoices, traps }, resumeFrom.resume.lead.chooser);
      entered = await enterSegment(page, { key: resumeFrom.key, split, chapters: project.config.chapters, chooser, stuckMs: v.stuckSeconds * 1000 });
      if (!entered) {
        console.log("区切りの前の所から区切りまで進められなかったので、区切りの最初のページから録ります（区切りの頭の演出は入りません）");
        chooser = new VideoChooser(v.choose, { choices: avoidChoices, traps }, resumeFrom.resume.chooser);
      }
    }
    if (resumeFrom && !entered) await loadAt(resumeFrom.resume!);
    else if (!resumeFrom) {
      // 自動確認（?autoplay=1）: 開始位置までの、遊ぶ人の操作を待つ画面と動画は、命令の autoplay で進める
      await page.goto(`${url}?start=${encodeURIComponent(o.target)}&skip=${o.skip}&autostart=1&autoplay=1${lang ? `&${lang}` : ""}`);
    }
    // 区切りに入ったところから録るときは、もう動いている（待たずにすぐ録り始める）
    if (!entered) {
      await page.waitForFunction(
        (target) => {
          const l = window.__liminalia;
          return !!l && (l.ended || (l.pages() >= target && (l.host.waiting || !!l.host.offered?.())));
        },
        resumeFrom ? 0 : o.skip,
        { timeout: 90_000 },
      );
    }
    // 作品が撮影を止めていれば（host.holdShot）離すまで待つ
    await page.waitForFunction(() => window.__liminalia?.shotReady?.() !== false, null, { timeout: 60_000 }).catch(() => undefined);
    // --until で止めた所から続けるときは、--until を先の所にするか外す（同じ所のままでは、録り始めてすぐ止まる）
    if (resumeFrom && until) {
      const s = (await page.evaluate(STATE_SOURCE)) as PlayerState;
      if (reachedUntil(until, s.at ? { file: s.at[0], line: s.at[1] } : null, s.depth)) throw new Error(`止める所（--until ${until.target}）にはもう着いています。続けるなら --until を先の所にするか外します`);
    }
    // ここからは遊ぶ人の画面のまま（画面を出し、動画を流す）
    await page.evaluate(() => void (window.__liminalia!.host.automated = false));
    const audioFormat: AudioFormat | null = v.audio ? { rate: ((await page.evaluate(`(${AUDIO_SOURCE})(${JSON.stringify(WORKLET_SOURCE)})`)) as { rate: number }).rate, channels: 2 } : null;
    // 再開は区切りを上書きする。以前の動画と記録を安全に控えてから元を消す（録り始める前に止まったときは、何も消さない）
    let backup: string | null = null;
    if (overwritten.length > 0) {
      backup = backupResume(folder, overwritten);
      console.log(`録り直す前の動画と記録: ${backup}`);
      for (const s of overwritten) rmSync(join(folder, s.file), { force: true });
    }
    const r = await record(page, project, {
      v,
      folder,
      outPath,
      progress,
      resumeFrom,
      until,
      chooser,
      audio: audioFormat,
      open,
      interrupted: () => interrupted || v.cancelled?.() === true,
    });
    for (const line of videoReport(r, { split, out: split === "none" ? outPath : folder, resumed: resumeFrom !== null, redo: v.redo !== undefined, avoiding: avoidChoices.length > 0 || avoidEndings.length > 0, stuckSeconds: v.stuckSeconds })) console.log(line);
    // 続きを録り終えたら控えは要らない。録り終えなければ残して場所を出す
    if (backup && COMPLETE.has(r.stopped)) rmSync(backup, { recursive: true, force: true });
    else if (backup) console.log(`録り直す前の動画と記録は ${backup} に残しています`);
    for (const e of errors) console.log(e);
    return COMPLETE.has(r.stopped);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    // ブラウザがもう閉じていれば何もしない
    await browser.close().catch(() => undefined);
    await server.close();
  }
}

/** 続きから録る区切りの、見込みを数える開始位置（セーブの位置のファイル）。 */
function resumeTarget(s: SegmentRecord): string {
  const unit = (s.resume?.save as { position?: { unit?: unknown } } | undefined)?.position?.unit;
  return typeof unit === "string" ? unit.split("::")[0]! : s.name;
}

interface RecordContext {
  v: VideoOptions;
  folder: string;
  outPath: string;
  progress: VideoProgress | null;
  resumeFrom: SegmentRecord | null;
  until: ReturnType<typeof untilPoint> | null;
  chooser: VideoChooser;
  audio: AudioFormat | null;
  /** 音を受ける区切り（runShotVideo と分け合う）。 */
  open: Segment[];
  interrupted(): boolean;
}

/** 録る（開始位置のクリック待ちまで進めたページで）。 */
async function record(page: Page, project: Project, c: RecordContext): Promise<VideoResult> {
  const { v, progress } = c;
  const split = v.split;
  const sources = new Map<string, string[]>();
  const sourceLine = (file: string, line: number): string | undefined => {
    if (!sources.has(file)) {
      const path = join(project.paths.scenario, `${file}.lim`);
      sources.set(file, existsSync(path) ? readFileSync(path, "utf8").split("\n") : []);
    }
    return sources.get(file)![line - 1];
  };
  const files: string[] = [];
  const choices: string[] = [];
  const feeder = new FrameFeeder();
  const cdp = await page.context().newCDPSession(page);
  const setLabel = (text: string) => page.evaluate(`(${LABEL_SOURCE})(${JSON.stringify(text)})`);
  let state = (await page.evaluate(STATE_SOURCE)) as PlayerState;
  let label = state.at ? lineLabel(state.at[0], state.at[1], sourceLine(state.at[0], state.at[1])) : "";
  // 開発時の表示を隠せなくても録画は続ける
  await page.evaluate(HIDE_STATUS_SOURCE).catch(() => undefined);
  if (v.showLine === true) await setLabel(label);
  /** 録った長さ（ミリ秒。区切りの長さの和）。 */
  let recorded = 0;
  let failure: string | null = null;
  let seg: Segment | null = null;
  const closing: Promise<void>[] = [];
  // 最初のページ（開始位置）を 1 と数える。続きからなら、その区切りの最初のページまでの数から
  let shown = c.resumeFrom?.resume?.pages ?? 1;
  let nextNumber = c.resumeFrom?.n ?? 1;
  /** いちばん新しい待ち（クリック待ちか選ぶ画面）のセーブと、そのときの区切り。次の区切りの lead になる。 */
  let lastWait: (ResumeSnapshot & { key: string }) | null = null;
  /** lastWait を取った待ち（同じ待ちで取り直さない）。 */
  let lastWaitAt = "";

  /** 区切りを始める。 */
  const openSegment = async (key: string, name: string): Promise<Segment> => {
    const n = nextNumber++;
    const file = split === "none" ? c.outPath : join(c.folder, segmentFileName(n, name));
    const writer = await SegmentWriter.open(file, c.audio);
    const start = Date.now();
    const record: SegmentRecord | null = progress ? { n, name, key, file: segmentFileName(n, name), status: "recording" } : null;
    if (progress && record) {
      // 録り直す区切り（--redo）は、記録の同じ番号の所を置き換える
      const at = progress.segments.findIndex((x) => x.n === n);
      if (at >= 0) progress.segments[at] = record;
      else progress.segments.push(record);
      writeProgress(c.folder, progress);
    }
    const s: Segment = { record, key, writer, start, audio: c.audio ? new AudioAligner(c.audio.rate, c.audio.channels, start) : null, end: null, pagesAtStart: shown };
    c.open.push(s);
    files.push(file);
    return s;
  };

  /** 区切りを閉じる（音が届き終えるのを待ってから）。done は最後まで録れた区切りか。 */
  const closeSegment = (s: Segment, done: boolean): Promise<void> => {
    const end = Date.now();
    s.end = end;
    recorded += end - s.start;
    s.audio?.limit(end);
    for (const f of feeder.take(s.start, s.writer.frames, end)) s.writer.writeFrame(f);
    const job = (async () => {
      // 遅れて届く音を待つ（止めたときは待たずに、届いていない所を無音にする）
      if (s.audio) await new Promise((r) => setTimeout(r, done ? AUDIO_LAG : 200));
      const silence = s.audio?.fill(end);
      if (silence) s.writer.writeAudio(silence);
      c.open.splice(c.open.indexOf(s), 1);
      await s.writer.close(done, () => freeBytes(c.folder));
      if (s.record && progress) {
        s.record.status = done ? "done" : "recording";
        s.record.seconds = Math.round((end - s.start) / 100) / 10;
        s.record.pages = Math.max(0, shown - s.pagesAtStart + 1);
        writeProgress(c.folder, progress);
      }
    })();
    // 区切りを替えるときは待たずに次を録る（失敗は最後にまとめて知らせる）
    job.catch(() => undefined);
    closing.push(job);
    return job;
  };

  // 最初の区切りは開始位置のファイル（続きからなら、録り直す区切り）
  const firstKey = split === "none" || !progress ? { key: "", name: "" } : c.resumeFrom ? { key: c.resumeFrom.key, name: c.resumeFrom.name } : segmentKey(split, progress.start.split("#")[0]!, project.config.chapters);
  seg = await openSegment(firstKey.key, firstKey.name);

  // 画面のコマ（変わったときだけ届く）
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    feeder.push(metadata.timestamp ? metadata.timestamp * 1000 : Date.now(), Buffer.from(data, "base64"));
    // 受けたことを返せなくても、録るのは続ける（途中で閉じたときなど）
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
  });
  const size = page.viewportSize() ?? { width: 1280, height: 720 };
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: size.width, maxHeight: size.height, everyNthFrame: 1 });
  // 動画のコマと無音を、時刻どおりに書き続ける。空きと ffmpeg の様子も見る
  let lastDiskCheck = Date.now();
  let lowDisk = false;
  const pump = setInterval(() => {
    const now = Date.now();
    const s = seg;
    if (!s || s.end !== null) return;
    if (feeder.ready) for (const f of feeder.take(s.start, s.writer.frames, now - VIDEO_LAG)) s.writer.writeFrame(f);
    const silence = s.audio?.fill(now - AUDIO_LAG);
    if (silence) s.writer.writeAudio(silence);
    if (s.writer.error) failure ??= s.writer.error;
    else if (s.writer.backlog > BACKLOG_LIMIT) failure ??= "ffmpeg が録る速さに追いつきません（ほかの重い処理を止めるか、--no-audio で音を外します）";
    if (now - lastDiskCheck > 20_000) {
      lastDiskCheck = now;
      if (freeBytes(c.folder) < DISK_FLOOR) lowDisk = true;
    }
  }, 100);

  const read = v.readMs;
  // オートで送るのは、システムがオートを持つとき（作品が差し替えたシステム画面が持たなければ、--read で送る）
  const autoMode = v.auto && state.auto !== null;
  if (v.auto && !autoMode) console.log("このシステム画面はオートを受け付けないので、--read の時間で送ります");
  const stuckMs = v.stuckSeconds * 1000;
  let lastPages = state.pages;
  let readSince: number | null = state.waiting ? Date.now() : null;
  let wasWaiting = state.waiting;
  let quietSince: number | null = null;
  let offerSince = null as { id: number; at: number } | null;
  const tried = new Map<number, number>();
  let signature = "";
  let movedAt = Date.now();
  let picks = { pages: state.pages, count: 0 };
  let endedAt: number | null = null;
  let stopped: VideoStop = "pages";
  const startedAt = Date.now();
  let progressAt = 0;
  let enteredFile = false;
  try {
    for (;;) {
      if (c.interrupted()) {
        stopped = "interrupted";
        break;
      }
      if (failure) {
        stopped = "error";
        break;
      }
      if (lowDisk) {
        stopped = "disk";
        break;
      }
      await page.waitForTimeout(50);
      try {
        state = (await page.evaluate(STATE_SOURCE)) as PlayerState;
      } catch (e) {
        failure = e instanceof Error ? e.message.split("\n")[0]! : String(e);
        stopped = "error";
        break;
      }
      const now = Date.now();
      if (state.at) {
        const next = lineLabel(state.at[0], state.at[1], sourceLine(state.at[0], state.at[1]));
        if (next !== label) {
          label = next;
          // 行の札を出せなくても録画は続ける
          if (v.showLine === true) await setLabel(label).catch(() => undefined);
        }
      }
      const at = state.at ? { file: state.at[0], line: state.at[1] } : null;
      if (v.onProgress && now - progressAt >= 1000) {
        progressAt = now;
        v.onProgress({ pages: shown, file: at?.file ?? "", line: at?.line ?? 0, seconds: Math.floor((now - startedAt) / 1000) });
      }
      if (v.endFile && at && state.depth === 0) {
        if (at.file === v.endFile) enteredFile = true;
        else if (enteredFile) { stopped = "until"; break; }
      }
      if (reachedUntil(c.until, at, state.depth)) {
        stopped = "until";
        break;
      }
      // 区切り（ファイルの本体の位置で見る。呼び出しとマクロの中では替えない）
      if (split !== "none" && at && state.depth === 0) {
        const k = segmentKey(split, at.file, project.config.chapters);
        // 一つの区切りだけを録り直すときは、次の区切りに入ったら止める
        if (k.key !== seg.key && v.redo !== undefined) {
          stopped = "redone";
          break;
        }
        if (k.key !== seg.key) {
          void closeSegment(seg, true);
          // 前の区切りの最後の待ちを、新しい区切りの lead にする（続きから録るときに、そこから区切りの頭まで録らずに進める）
          const lead = lastWait && lastWait.key === seg.key ? lastWait : null;
          seg = await openSegment(k.key, k.name);
          if (lead) seg.lead = { save: lead.save, ...(lead.temp ? { temp: lead.temp } : {}), chooser: lead.chooser };
        }
      }
      // 待ち（クリック待ちか選ぶ画面）ごとに、セーブと temp の変数を取っておく。区切りの最初の待ちのものは、続きから録るための印にし、
      // いちばん新しいものは次の区切りの lead にする（選ぶ前に取るので、選び方も選ぶ前のもの）
      const waitAt = state.offer ? `offer:${state.offer.id}` : state.waiting ? `page:${state.pages}` : "";
      if (progress && waitAt !== "" && waitAt !== lastWaitAt) {
        // セーブを取れなければ、続きからの録り直しの印を残さない（前の印のまま。次の回に取り直す）
        const snap = (await page.evaluate(SNAPSHOT_SOURCE).catch(() => null)) as { save: unknown; temp: Record<string, unknown> | null } | null;
        if (snap) {
          lastWaitAt = waitAt;
          const here = snapshotOf(snap, c.chooser);
          lastWait = { ...here, key: seg.key };
          if (seg.record && !seg.record.resume) {
            seg.record.resume = { ...here, pages: shown, ...(seg.lead ? { lead: seg.lead } : {}) };
            writeProgress(c.folder, progress);
          }
        }
      }
      const sig = JSON.stringify([state.pages, state.at, state.waiting, state.offer?.id ?? null, state.mode, state.depth]);
      // @movie を出している間（飛ばせるものも）、ボイスと終わりのある演出が動いている間は、止まった扱いにしない
      if (sig !== signature || state.playing || state.voice > 0 || state.animating) {
        signature = sig;
        movedAt = now;
      }
      if (state.ended || state.mode === "title") {
        // 終わったら、終わりの画面を少し見せて止める
        endedAt ??= now;
        if (now - endedAt > 1500) {
          stopped = "ended";
          break;
        }
        continue;
      }
      if (now - movedAt > stuckMs) {
        stopped = "stuck";
        break;
      }
      const offer = state.offer;
      if (offer) {
        // 選択肢と、画面が知らせた選べるもの（読む時間だけ見せてから選ぶ）
        if (offerSince?.id !== offer.id) {
          offerSince = { id: offer.id, at: now };
          // 番号は増える一方で、前の知らせには戻らない
          for (const id of tried.keys()) if (id !== offer.id) tried.delete(id);
        }
        const last = tried.get(offer.id);
        const proceed = offer.proceed;
        // 進めるだけのもの（閉じる、OK）は、閉じなければ読む時間ごとに押し直す。選ぶものは一度だけ選ぶ
        if (now - offerSince.at >= read && (last === undefined || (proceed !== null && now - last >= read + 1000))) {
          // オート中のクリックはオートを切るだけになるので、選ぶ前に切る（次のクリック待ちで入れ直す）
          if (state.auto === true) await page.evaluate(`(${AUTO_SOURCE})(false)`).catch(() => undefined);
          const index = proceed ?? c.chooser.pick(offer.options, offer.targets).index;
          if (proceed === null) {
            // ページが進まないまま選び続けていたら止める（行き先の無いものだけを選び続ける、など）
            if (state.pages !== picks.pages) picks = { pages: state.pages, count: 0 };
            if (++picks.count > MAX_PICKS_WITHOUT_PAGE) {
              stopped = "looping";
              break;
            }
          }
          // ページが替わって選べなかったら、次の回で選び直す
          const ok = (await page.evaluate(([id, i]) => window.__liminalia!.host.chooseOffered(id, i), [offer.id, index] as const).catch(() => false)) as boolean;
          tried.set(offer.id, now);
          if (ok && proceed === null) choices.push(offer.options[index] ?? String(index));
        }
        continue;
      }
      offerSince = null;
      if (autoMode) {
        // エンジンのオートで送る: クリック待ちでオートが切れていれば入れる。--pages のページを読み終えたら、オートが送ったところで止める
        if (!state.waiting) {
          if (wasWaiting && shown >= v.pages) {
            stopped = "pages";
            break;
          }
          wasWaiting = false;
          continue;
        }
        if (!wasWaiting || state.pages !== lastPages) {
          // 非待機の瞬間が短く、次の待機までに観測できない場合もある。
          if (state.pages !== lastPages && shown >= v.pages) {
            stopped = "pages";
            break;
          }
          wasWaiting = true;
          if (state.pages !== lastPages) {
            lastPages = state.pages;
            shown++;
          }
        }
        // オートに戻せなくても、--read の送りで進む
        if (state.auto === false) await page.evaluate(`(${AUTO_SOURCE})(true)`).catch(() => undefined);
        continue;
      }
      if (!state.waiting) {
        wasWaiting = false;
        continue;
      }
      if (!wasWaiting || state.pages !== lastPages || readSince === null) {
        // 短い本文は非待機を観測する前に次の待機になる。ページの変化と送り直後も拾う。
        // クリック待ちになった（新しいページか、ページの途中のクリック待ち）
        wasWaiting = true;
        readSince = now;
        if (state.pages !== lastPages) {
          lastPages = state.pages;
          shown++;
        }
      }
      // ボイスは鳴り終えるまで待ってから送る
      if (state.voice > 0) quietSince = null;
      else quietSince ??= now;
      if (readSince !== null && now - readSince >= read && quietSince !== null && now - quietSince >= VOICE_GAP) {
        if (shown >= v.pages) {
          stopped = "pages";
          break;
        }
        await page.evaluate(() => window.__liminalia!.host.advance());
        readSince = null;
      }
    }
    // 続きから録るなら、止めた所より先へオートで送らない（続きは止めた所の次のクリック待ちから）
    if (progress && RESUMABLE_STOPS.has(stopped) && state.auto === true) await page.evaluate(`(${AUTO_SOURCE})(false)`).catch(() => undefined);
    await page.waitForTimeout(300);
  } finally {
    clearInterval(pump);
    // 止められなくても、届いた分の画面で動画を作る
    await cdp.send("Page.stopScreencast").catch(() => undefined);
    // 録画の接続がもう切れていれば何もしない
    await cdp.detach().catch(() => undefined);
  }
  if (v.requireEnd && stopped === "ended" && ((v.endFile && !enteredFile) || c.until)) {
    failure = `指定した終了地点（${v.endFile ?? c.until?.target}）に到達する前にゲームが終わりました`;
    stopped = "error";
  }
  const complete = COMPLETE.has(stopped);
  if (seg) {
    try {
      await closeSegment(seg, complete);
    } catch (e) {
      failure ??= e instanceof Error ? e.message : String(e);
    }
  }
  const results = await Promise.allSettled(closing);
  for (const r of results) if (r.status === "rejected") failure ??= r.reason instanceof Error ? r.reason.message : String(r.reason);
  let continues = false;
  // 一つの区切りだけを録り直したときは、録り終えたかと続きの記録を変えない（区切りの記録は closeSegment が書いた）
  if (progress && v.redo !== undefined) writeProgress(c.folder, progress);
  else if (progress) {
    // 録り終えたのはプレイが終わったときだけ。--until と --pages で止めたら、続きから録る所のセーブを次の区切りとして書く
    let ended = stopped === "ended";
    if (RESUMABLE_STOPS.has(stopped) && !failure) {
      const next = await nextResume(page, { advance: stopped === "pages" && !autoMode, lastPages, shown, chooser: c.chooser, stuckMs });
      if (next === "ended") ended = true;
      else if (next) {
        const unit = (next.save as { position?: { unit?: unknown } }).position?.unit;
        const file = typeof unit === "string" ? unit.split("::")[0]! : (state.at?.[0] ?? "");
        const k = segmentKey(split, file, project.config.chapters);
        const n = nextNumber++;
        progress.segments.push({ n, name: k.name, key: k.key, file: segmentFileName(n, k.name), status: "recording", resume: next });
        continues = true;
      } else console.log("続きから録る所のセーブを取れませんでした（--resume では、最後の区切りを頭から録り直します）");
    }
    progress.finished = ended;
    // 止めた所のすぐ後でプレイが終わっていれば、続きは無い
    progress.stopped = ended ? "ended" : stopped;
    writeProgress(c.folder, progress);
  }
  if (failure && stopped !== "error") stopped = "error";
  if (failure) console.error(`録画のエラー: ${failure}`);
  return {
    pages: shown,
    seconds: Math.round(recorded / 100) / 10,
    stopped,
    files: split === "none" ? files : files.map((f) => f.slice(c.folder.length + 1)),
    choices,
    avoided: c.chooser.avoided,
    at: state.at ? `${state.at[0]}:${state.at[1]}` : null,
    continues,
  };
}

/**
 * --until か --pages で止めた所から、録らずに次のクリック待ち（か選ぶ画面）まで進め、そこのセーブを取る（--resume で、そこから録る）。
 * advance なら先に一度送る（--pages で止めたページは読み終えている）。pages はそのページの番号（新しいページなら shown の次）。
 * プレイが終わったら "ended"、stuckMs のあいだ何も進まなければ null。
 */
async function nextResume(page: Page, o: { advance: boolean; lastPages: number; shown: number; chooser: VideoChooser; stuckMs: number }): Promise<NonNullable<SegmentRecord["resume"]> | "ended" | null> {
  // 送ったあとは、一度クリック待ちを抜けるのを待つ（送る前のクリック待ちでセーブを取らない）
  let left = !o.advance;
  // 送れなくても（ページが閉じかけているなど）、下でクリック待ちが変わらなければ止まった扱いになる
  if (o.advance) await page.evaluate(() => window.__liminalia!.host.advance()).catch(() => undefined);
  let signature = "";
  let movedAt = Date.now();
  for (;;) {
    await page.waitForTimeout(50);
    // 様子を読めなければ（ページが閉じた）、続きのセーブは取らない（呼ぶ側が知らせる）
    const s = (await page.evaluate(STATE_SOURCE).catch(() => null)) as PlayerState | null;
    if (!s) return null;
    if (s.ended || s.mode === "title") return "ended";
    const now = Date.now();
    const sig = JSON.stringify([s.pages, s.at, s.waiting, s.offer?.id ?? null, s.mode, s.depth]);
    if (sig !== signature || s.playing || s.voice > 0 || s.animating) {
      signature = sig;
      movedAt = now;
    }
    if (now - movedAt > o.stuckMs) return null;
    if (!left) {
      left = !s.waiting || s.pages !== o.lastPages || !!s.offer;
      if (!left) continue;
    }
    if (!s.waiting && !s.offer) continue;
    // セーブを取れなければ、続きのセーブは取らない（呼ぶ側が知らせる）
    const snap = (await page.evaluate(SNAPSHOT_SOURCE).catch(() => null)) as { save: unknown; temp: Record<string, unknown> | null } | null;
    if (!snap) return null;
    return { ...snapshotOf(snap, o.chooser), pages: s.pages !== o.lastPages ? o.shown + 1 : o.shown };
  }
}
