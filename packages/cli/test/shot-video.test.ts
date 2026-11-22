import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { stopText, videoReport, type VideoResult } from "../src/commands/shot-video.ts";
import { englishText } from "../src/english-output.ts";
import { ffmpegArgs } from "../src/video-encoder.ts";
import { bytesPerSecond, formatBytes, formatDuration, PROGRESS_FILE, reachedUntil, readProgress, recordedToEnd, redoSegment, resumePoint, segmentFileName, segmentKey, writeProgress, type VideoProgress } from "../src/video-plan.ts";
import { AudioAligner, VideoChooser } from "../src/video-timeline.ts";

/** lim shot --video の、ページもブラウザも使わない部分（音の並べ方、選び方、区切り、記録）。 */

const work = mkdtempSync(join(tmpdir(), "liminalia-shot-video-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** 標本の数（2 チャンネル、16 ビット）の音。値は v。 */
const pcm = (frames: number, v = 1000) => {
  const b = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames * 2; i++) b.writeInt16LE(v, i * 2);
  return b;
};
const frames = (bs: Buffer[]) => bs.reduce((n, b) => n + b.length / 4, 0);

describe("音の並べ方（AudioAligner）", () => {
  it("届いた音は、区切りの始まりからの時刻の位置に置く（間は無音で埋め、重なりは捨てる）", () => {
    // 1000 標本/秒、始まりは 10 秒。誤差は 50 標本まで見逃す
    const a = new AudioAligner(1000, 2, 10_000, 50);
    // 10.1 秒に終わる 100 標本（ちょうど始まりから）
    expect(frames(a.chunk(10_100, pcm(100)))).toBe(100);
    // 0.02 秒の揺れは、そのまま続ける
    expect(frames(a.chunk(10_220, pcm(100)))).toBe(100);
    expect(a.written).toBe(200);
    // 0.3 秒あいて届いた（その間は鳴っていなかった）: 間を無音で埋める
    const later = a.chunk(10_600, pcm(100));
    expect(later.map((b) => b.length / 4)).toEqual([300, 100]);
    expect(later[0]!.every((x) => x === 0)).toBe(true);
    // 重なって届いた（音の時計が速い）: 重なった所を捨てる
    expect(frames(a.chunk(10_620, pcm(100)))).toBe(20);
    expect(a.written).toBe(620);
  });

  it("始まりより前と、区切りの終わりより後の音は書かない。届かない間は無音で埋める", () => {
    const a = new AudioAligner(1000, 2, 10_000, 50);
    expect(a.chunk(9_950, pcm(100))).toEqual([]);
    expect(frames(a.chunk(10_050, pcm(100)))).toBe(50);
    expect(frames([a.fill(10_500)!])).toBe(450);
    expect(a.fill(10_400)).toBeNull();
    a.limit(10_600);
    expect(frames(a.chunk(10_700, pcm(200)))).toBe(100);
    expect(a.fill(11_000)).toBeNull();
    expect(a.written).toBe(600);
  });
});

describe("選び方（VideoChooser）", () => {
  it("避ける文と、避けるエンディングにしか行かない飛び先を、ほかに選べるものがあれば選ばない（--choose で決めたものは変えない）", () => {
    const traps = new Set(["start#sleep"]);
    const c = new VideoChooser([], { choices: ["逃げる"], traps });
    expect(c.pick(["眠ってしまう", "願う"], ["start#sleep", "start#wish"])).toEqual({ index: 1, avoided: true });
    expect(c.pick(["逃げる", "戦う"]).index).toBe(1);
    // どれも避けるものなら、そのまま
    expect(c.pick(["逃げる"]).index).toBe(0);
    expect(c.avoided).toBe(2);
    // 飛び先の分かるものがどれも避けるシーンなら避けない（飛び先の分からない「視点を替える」だけを選び続けないように）
    const all = new VideoChooser([], { choices: [], traps: new Set(["a#spot", "a#done"]) });
    expect(all.pick(["視点を替える", "机", "調べ終える"], [null, "a#spot", "a#done"])).toEqual({ index: 0, avoided: false });
    expect(all.pick(["視点を替える", "机", "調べ終える"], [null, "a#spot", "a#done"])).toEqual({ index: 1, avoided: false });
    const explicit = new VideoChooser([0], { choices: [], traps });
    expect(explicit.pick(["眠ってしまう", "願う"], ["start#sleep", "start#wish"])).toEqual({ index: 0, avoided: false });
  });

  it("続きから録るときは、選び方の進み具合を引き継ぐ", () => {
    const c = new VideoChooser([1]);
    c.pick(["A", "B"]);
    c.pick(["X", "Y", "Z"]);
    const again = new VideoChooser([1], undefined, c.snapshot());
    // --choose は使い終えていて、同じ選択肢は二度目
    expect(again.pick(["X", "Y", "Z"]).index).toBe(1);
  });
});

describe("区切りと記録", () => {
  it("区切りの名前は 3 桁の番号と、ファイルか章の名前（使えない文字は _）", () => {
    expect(segmentFileName(1, "start")).toBe("001_start.mp4");
    expect(segmentFileName(12, "chapter/one:two")).toBe("012_chapter_one_two.mp4");
    expect(segmentFileName(3, "")).toBe("003_part.mp4");
    const chapters = [{ id: "ch1", title: "一", files: ["chapter1_*"] }];
    expect(segmentKey("file", "chapter1_a", chapters)).toEqual({ key: "file:chapter1_a", name: "chapter1_a" });
    expect(segmentKey("chapter", "chapter1_a", chapters)).toEqual({ key: "chapter:ch1", name: "ch1" });
    // 章に入らないファイルは、ファイルで分ける
    expect(segmentKey("chapter", "prologue", chapters)).toEqual({ key: "file:prologue", name: "prologue" });
  });

  it("止める所には、ファイルの本体の位置で着く（呼び出しとマクロの中では止めない）", () => {
    const file = { file: "epilogue", line: null, target: "epilogue" };
    expect(reachedUntil(file, { file: "epilogue", line: 3 }, 0)).toBe(true);
    expect(reachedUntil(file, { file: "epilogue", line: 3 }, 1)).toBe(false);
    expect(reachedUntil(file, { file: "start", line: 3 }, 0)).toBe(false);
    const label = { file: "start", line: 40, target: "start#night" };
    expect(reachedUntil(label, { file: "start", line: 39 }, 0)).toBe(false);
    expect(reachedUntil(label, { file: "start", line: 41 }, 0)).toBe(true);
    expect(reachedUntil(null, { file: "start", line: 41 }, 0)).toBe(false);
  });

  it("どこまで録ったかを書き、続きはセーブを持つ最後の区切りから", () => {
    const dir = join(work, "progress");
    const progress: VideoProgress = {
      version: 1,
      project: "p",
      split: "file",
      start: "start",
      finished: false,
      updated: "",
      segments: [
        { n: 1, name: "start", key: "file:start", file: "001_start.mp4", status: "done", resume: { save: { a: 1 }, chooser: { used: 0, seen: {}, avoided: 0 }, pages: 1 } },
        { n: 2, name: "epilogue", key: "file:epilogue", file: "002_epilogue.mp4", status: "recording", resume: { save: { a: 2 }, chooser: { used: 0, seen: {}, avoided: 0 }, pages: 30 } },
        { n: 3, name: "after", key: "file:after", file: "003_after.mp4", status: "recording" },
      ],
    };
    rmSync(dir, { recursive: true, force: true });
    expect(readProgress(dir)).toBeNull();
    mkdirSync(dir, { recursive: true });
    writeProgress(dir, progress);
    const back = readProgress(dir)!;
    expect(back.segments).toHaveLength(3);
    expect(back.updated).not.toBe("");
    expect(resumePoint(back)?.n).toBe(2);
    writeFileSync(join(dir, PROGRESS_FILE), "{}");
    expect(() => readProgress(dir)).toThrow(/形が読めません/);
  });

  it("--redo は番号の区切りを、その区切りの最初のページの記録から録り直す（記録の無い区切りと無い番号は断る）", () => {
    const resume = { save: { a: 1 }, chooser: { used: 0, seen: {}, avoided: 0 }, pages: 1 };
    const progress: VideoProgress = {
      version: 1,
      project: "p",
      split: "file",
      start: "start",
      finished: true,
      stopped: "ended",
      updated: "",
      segments: [
        { n: 1, name: "start", key: "file:start", file: "001_start.mp4", status: "done", resume },
        { n: 2, name: "middle", key: "file:middle", file: "002_middle.mp4", status: "done", resume: { ...resume, pages: 20 } },
        { n: 3, name: "end", key: "file:end", file: "003_end.mp4", status: "done" },
      ],
    };
    expect(redoSegment(progress, 2).name).toBe("middle");
    expect(() => redoSegment(progress, 3)).toThrow(/録り直す所の記録がありません/);
    expect(() => redoSegment(progress, 9)).toThrow(/9 番の区切りはありません（あるもの: 001、002、003）/);
    expect(stopText("redone", 60)).toBe("、区切りを録り直しました");
    expect(englishText(`動画: video（録り直し 1 本、20 ページ、30 秒${stopText("redone", 60)}）`)).toBe("Video: video (re-recorded 1 part, 20 pages, 30 s, part re-recorded)");
    expect(videoReport({ pages: 20, seconds: 30, stopped: "redone", files: ["002_middle.mp4"], choices: [], avoided: 0, at: null, continues: false }, { split: "file", out: "video", resumed: true, redo: true, avoiding: false, stuckSeconds: 60 })[0]).toBe(
      "動画: video（録り直し 1 本、20 ページ、30 秒、区切りを録り直しました）",
    );
  });

  it("最後まで録ってあるのはプレイが終わったときだけ（--until と --pages で止めた記録は、前の版で finished にしたものも続きを録る）", () => {
    const base: Omit<VideoProgress, "finished"> = { version: 1, project: "p", split: "file", start: "a", segments: [], updated: "" };
    expect(recordedToEnd({ ...base, finished: true, stopped: "ended" })).toBe(true);
    expect(recordedToEnd({ ...base, finished: true })).toBe(true);
    expect(recordedToEnd({ ...base, finished: true, stopped: "until" })).toBe(false);
    expect(recordedToEnd({ ...base, finished: true, stopped: "pages" })).toBe(false);
    expect(recordedToEnd({ ...base, finished: false, stopped: "interrupted" })).toBe(false);
  });

  it("見込みと止まり方の文", () => {
    expect(bytesPerSecond({ width: 1280, height: 720 }, true)).toBe(220_000);
    expect(bytesPerSecond({ width: 1280, height: 720 }, false)).toBe(200_000);
    expect(formatBytes(3.5 * 1024 ** 3)).toBe("3.5 GB");
    expect(formatBytes(20 * 1024 ** 2)).toBe("20 MB");
    expect(formatDuration(3 * 3600 + 125)).toBe("3 時間 2 分");
    expect(formatDuration(75)).toBe("1 分 15 秒");
    expect(stopText("stuck", 60)).toBe("、60 秒進まなかったので止めました");
    expect(stopText("pages", 60)).toBe("");
  });

  it("出力の言語が英語なら、見込みと終わりの出力も英語にする（lim の文言の表で読み替える）", () => {
    const en = (lines: string[]) => lines.map(englishText);
    expect(englishText(formatDuration(3 * 3600 + 125))).toBe("3 h 2 min");
    expect(englishText(formatDuration(75))).toBe("1 min 15 s");
    expect(englishText(`見込み: 約 ${formatDuration(75)}、${formatBytes(20 * 1024 ** 2)}（3 ページ。分かれ道はどれも通るものとして数えます）。空き: ${formatBytes(Number.NaN)}`)).toBe(
      "Estimate: about 1 min 15 s, 20 MB (3 pages, counting every branch as played). Free space: unknown",
    );
    const stuck: VideoResult = { pages: 12, seconds: 30.5, stopped: "stuck", files: ["001_start.mp4"], choices: ["北の道", "眠る"], avoided: 1, at: "start:40", continues: false };
    const lines = en(videoReport(stuck, { split: "file", out: "video", resumed: false, avoiding: true, stuckSeconds: 60 }));
    expect(lines).toEqual([
      "Video: video (1 file, 12 pages, 30.5 seconds; stopped after 60 seconds without moving on)",
      "  001_start.mp4",
      "Chosen: 北の道 → 眠る",
      "Choices avoided: 1",
      "Stopped at: start:40",
      "If it stopped on a screen that waits for the player, have that screen's renderer tell what can be chosen with ctx.offer so the recording can go on (\"How recordings go on\" in docs/plugins.md)",
      "What was recorded is kept. Add --resume to record the rest (liminalia-video.json)",
    ]);
    // 日本語は前と同じ
    expect(videoReport({ ...stuck, stopped: "until", continues: true, choices: [] }, { split: "file", out: "video", resumed: true, avoiding: false, stuckSeconds: 60 })).toEqual([
      "動画: video（続きから 1 本、12 ページ、30.5 秒、止める所に着きました）",
      "  001_start.mp4",
      "続きは --resume を付けて録ります（--until は先の所にするか外します。liminalia-video.json）",
    ]);
    expect(en(videoReport({ ...stuck, stopped: "pages", files: ["/tmp/v.mp4"], choices: Array.from({ length: 14 }, (_, i) => `c${i}`) }, { split: "none", out: "/tmp/v.mp4", resumed: false, avoiding: false, stuckSeconds: 60 }))).toEqual([
      "Video: /tmp/v.mp4 (12 pages, 30.5 seconds)",
      "Chosen: c0 → c1 → c2 → c3 → c4 → c5 → c6 → c7 → c8 → c9 → c10 → c11 and 2 more",
    ]);
  });
});

describe("ffmpeg に渡すもの", () => {
  it("コマは標準入力、音は手元の TCP。書いている間は断片の mp4（途中で止まってもそこまで見られる）", () => {
    const args = ffmpegArgs("/x/out.mp4", { rate: 48_000, channels: 2, port: 5555 }, 30, ["-c:v", "libx264"]);
    expect(args.join(" ")).toContain("-f image2pipe -framerate 30 -c:v mjpeg -i -");
    expect(args.join(" ")).toContain("-f s16le -ar 48000 -ac 2 -i tcp://127.0.0.1:5555");
    expect(args.join(" ")).toContain("-map 0:v:0 -map 1:a:0 -c:a aac");
    expect(args.join(" ")).toContain("+frag_keyframe+empty_moov");
    expect(args.at(-1)).toBe("/x/out.mp4");
    // 音なし
    expect(ffmpegArgs("/x/out.mp4", null, 30, ["-c:v", "mpeg4"]).join(" ")).not.toContain("tcp://");
  });
});

const ROOT = resolve(import.meta.dirname, "../../..");
const LIM = join(ROOT, "packages/cli/bin/lim.mjs");
const e2e = !!process.env.LIMINALIA_E2E_BROWSER;
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

/** 作品: 声のある台詞、飛ばせない動画（音つき 6 秒）、文字の入力、確かめの枠、調べる画面、地図、プラグインの画面（スタンプ）、BAD END の分かれ道、二つ目のファイルに飛ばせる動画。 */
function makeProject(dir: string): void {
  cpSync(join(ROOT, "templates/default"), dir, { recursive: true });
  for (const part of ["package.json", "src"]) cpSync(join(ROOT, "examples/stamp-plugin", part), join(dir, "plugins/stamp", part), { recursive: true });
  for (const sub of ["assets/video", "assets/voice", "assets/image/stamps", "data"]) mkdirSync(join(dir, sub), { recursive: true });
  const ff = (...args: string[]) => execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-y", ...args]);
  ff("-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=6", "-f", "lavfi", "-i", "sine=frequency=660:duration=6", "-c:v", "libvpx", "-b:v", "300k", "-c:a", "libopus", "-shortest", join(dir, "assets/video/m.webm"));
  ff("-f", "lavfi", "-i", "sine=frequency=440:duration=1.5", "-ac", "1", join(dir, "assets/voice/v1.wav"));
  for (const name of ["ok", "ng"]) cpSync(join(ROOT, "packages/web/test/e2e/fixtures/stripes.png"), join(dir, `assets/image/stamps/${name}.png`));
  writeFileSync(
    join(dir, "scenario/a.lim"),
    "# a\n@bg hill_dusk.webp\n@bgm quiet_night.wav volume=60\nはじまり。\n@voice v1.wav\nアカリ「声のある台詞。」\n@movie m.webm\n動画のあと。\n" +
      '@text-input game.name initial="ユイ"\n@dialog "確かめます"\n@investigate room\n調べ終えた。\n@map-choice town result=temp.where\n' +
      "@stamp-pick images=stamps/ok.png,stamps/ng.png\n選んだのは{= game.stamp}。\n@choice\n- 眠ってしまう -> #sleep\n- 先へ進む -> b\n@end\n# desk\n机を調べた。\n" +
      '# sleep\n気がつくと朝だった。\n@title-screen ending="BAD END"\n',
  );
  writeFileSync(join(dir, "scenario/b.lim"), "# b\n@bg hill_night.webp\n二つ目のファイル。\n@movie m.webm skip=true\nおわり。\n");
  writeFileSync(
    join(dir, "data/investigation.json"),
    JSON.stringify({
      places: { room: { file: "a", views: [{ id: "v", label: "部屋", background: "hill_night.webp", spots: [{ id: "desk", label: "机", rect: { x: 500, y: 300, width: 200, height: 160 }, target: "#desk" }] }] } },
      maps: { town: { background: "hill_dusk.webp", spots: [{ id: "north", label: "北の丘", rect: { x: 300, y: 200, width: 140, height: 60 } }, { id: "south", label: "南の町", rect: { x: 700, y: 400, width: 140, height: 60 } }] } },
    }),
  );
  const cfg = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ ...cfg, entry: "a", plugins: ["./plugins/stamp"] }));
}

/** mp4 の流れ（種類の並び）と長さと、音の平均の大きさ（dB）。 */
function probe(file: string): { streams: string[]; duration: number; mean: number } {
  const p = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", file], { encoding: "utf8" });
  const j = JSON.parse(p.stdout) as { streams: { codec_type: string }[]; format: { duration: string } };
  const v = spawnSync("ffmpeg", ["-nostdin", "-i", file, "-vn", "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  return { streams: j.streams.map((s) => s.codec_type), duration: Number(j.format.duration), mean: Number(/mean_volume: (-?[\d.]+) dB/.exec(v)?.[1] ?? "-Infinity") };
}

describe.skipIf(!e2e || !hasFfmpeg)("録画（lim shot --video、ブラウザと ffmpeg）", { timeout: 600_000 }, () => {
  const dir = join(work, "game");
  const out = join(work, "rec");
  const lim = (args: string[]) => {
    const r = spawnSync(process.execPath, [LIM, ...args], { encoding: "utf8", timeout: 400_000 });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it("プラグインの画面を映したまま選び、動画で止まらず、BAD END を避けて、ファイルごとの音つきの mp4 に分ける", () => {
    makeProject(dir);
    // 止まりの判定（4 秒）より長い 6 秒の動画が二つある（二つ目は飛ばせる動画）
    const r = lim(["shot", dir, "a", "--video", out, "--split", "file", "--read", "300", "--stuck", "4", "--avoid-ending"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("プレイが終わりました");
    expect(r.out).toContain("選んだもの: 机 → 北の丘 → stamps/ok.png → 先へ進む");
    expect(r.out).toContain("避けた選択肢: 1 回");
    expect(readdirSync(out).sort()).toEqual(["001_a.mp4", "002_b.mp4", "liminalia-video.json"]);
    const a = probe(join(out, "001_a.mp4"));
    const b = probe(join(out, "002_b.mp4"));
    expect(a.streams).toEqual(["video", "audio"]);
    expect(b.streams).toEqual(["video", "audio"]);
    // 音が入っている（無音は -91 dB）。二つ目は飛ばせる動画を最後まで流した（6 秒より長い）
    expect(a.mean).toBeGreaterThan(-50);
    expect(b.mean).toBeGreaterThan(-50);
    expect(b.duration).toBeGreaterThan(6);
    const progress = JSON.parse(readFileSync(join(out, "liminalia-video.json"), "utf8")) as { finished: boolean; segments: { status: string }[] };
    expect(progress.finished).toBe(true);
    expect(progress.segments.map((s) => s.status)).toEqual(["done", "done"]);
    // 記録のあるフォルダには、--resume なしでは録らない
    expect(lim(["shot", dir, "a", "--video", out, "--split", "file"]).out).toContain("--resume");
    expect(lim(["shot", dir, "a", "--video", out, "--split", "file", "--resume"]).out).toContain("もう最後まで録ってあります");
  });

  it("途中で止まった区切りは、--resume でその最初のページから録り直し、録り終えた区切りは残す", () => {
    // 二つ目の区切りを録っている途中で止まったことにする
    const path = join(out, "liminalia-video.json");
    const progress = JSON.parse(readFileSync(path, "utf8")) as { finished: boolean; stopped?: string; segments: { status: string }[] };
    progress.finished = false;
    progress.stopped = "interrupted";
    progress.segments[1]!.status = "recording";
    writeFileSync(path, JSON.stringify(progress));
    rmSync(join(out, "002_b.mp4"));
    const first = statSync(join(out, "001_a.mp4")).mtimeMs;
    const r = lim(["shot", dir, "a", "--video", out, "--split", "file", "--read", "300", "--resume"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("続きから 1 本");
    expect(existsSync(join(out, "002_b.mp4"))).toBe(true);
    expect(statSync(join(out, "001_a.mp4")).mtimeMs).toBe(first);
    expect(probe(join(out, "002_b.mp4")).streams).toEqual(["video", "audio"]);
  });

  it("--redo で区切りを一つだけ録り直し、ほかの区切りと記録の終わりはそのまま", () => {
    const second = statSync(join(out, "002_b.mp4")).mtimeMs;
    const first = statSync(join(out, "001_a.mp4")).mtimeMs;
    const r = lim(["shot", dir, "a", "--video", out, "--split", "file", "--read", "300", "--stuck", "4", "--avoid-ending", "--redo", "1"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("録り直し 1 本");
    expect(statSync(join(out, "001_a.mp4")).mtimeMs).toBeGreaterThan(first);
    expect(statSync(join(out, "002_b.mp4")).mtimeMs).toBe(second);
    expect(probe(join(out, "001_a.mp4")).streams).toEqual(["video", "audio"]);
    const progress = JSON.parse(readFileSync(join(out, "liminalia-video.json"), "utf8")) as { finished: boolean; segments: { n: number; status: string }[] };
    expect(progress.segments.map((s) => [s.n, s.status])).toEqual([
      [1, "done"],
      [2, "done"],
    ]);
    expect(progress.finished).toBe(true);
  });

  it("--until で止めた録画は、--resume で次の区切りから続ける（録り終えた区切りは録り直さない）", () => {
    const rec = join(work, "rec-until");
    const r = lim(["shot", dir, "a", "--video", rec, "--split", "file", "--until", "b", "--read", "300", "--stuck", "4", "--avoid-ending"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("止める所に着きました");
    expect(r.out).toContain("続きは --resume を付けて録ります");
    const path = join(rec, "liminalia-video.json");
    const progress = JSON.parse(readFileSync(path, "utf8")) as { finished: boolean; stopped: string; segments: { name: string; status: string; resume?: { pages: number } }[] };
    expect(progress).toMatchObject({ finished: false, stopped: "until" });
    // 続きは、止めた所（b）の最初のクリック待ちから
    expect(progress.segments.map((s) => [s.name, s.status, !!s.resume])).toEqual([
      ["a", "done", true],
      ["b", "recording", true],
    ]);
    expect(readdirSync(rec).sort()).toEqual(["001_a.mp4", "liminalia-video.json"]);
    // 同じ --until のままでは、録るものが無い
    expect(lim(["shot", dir, "a", "--video", rec, "--split", "file", "--until", "b", "--resume"]).out).toContain("もう着いています");
    const first = statSync(join(rec, "001_a.mp4")).mtimeMs;
    const again = lim(["shot", dir, "a", "--video", rec, "--split", "file", "--read", "300", "--stuck", "4", "--resume"]);
    expect(again.code, again.out).toBe(0);
    expect(again.out).toContain("続きから 1 本");
    expect(again.out).toContain("プレイが終わりました");
    expect(readdirSync(rec).sort()).toEqual(["001_a.mp4", "002_b.mp4", "liminalia-video.json"]);
    expect(statSync(join(rec, "001_a.mp4")).mtimeMs).toBe(first);
    expect(probe(join(rec, "002_b.mp4")).streams).toEqual(["video", "audio"]);
    expect((JSON.parse(readFileSync(path, "utf8")) as { finished: boolean }).finished).toBe(true);
  });

  it("--resume は区切りの前の待ちから録らずに進め、区切りの頭の場面転換を録り、temp の変数も戻す", () => {
    const game = join(work, "resume-game");
    const rec = join(work, "rec-resume");
    cpSync(join(ROOT, "templates/default"), game, { recursive: true });
    // temp で出し分ける選択肢と、区切り（ファイル b）の頭の長い場面転換
    writeFileSync(join(game, "scenario/a.lim"), '# a\n@bg hill_dusk.webp\n@set temp.mark = "T"\nはじまり。\n@jump b\n');
    writeFileSync(
      join(game, "scenario/b.lim"),
      '# b\n@scene-change hill_night.webp time=3000ms\n二つ目のファイル。\n@choice\n- 印の道 -> #m if=(temp.mark == "T")\n- 別の道 -> #n\n@end\n# n\n別の道を選んだ。\n@title-screen\n# m\n印の道を選んだ。\n@title-screen\n',
    );
    const cfg = JSON.parse(readFileSync(join(game, "liminalia.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(game, "liminalia.json"), JSON.stringify({ ...cfg, entry: "a" }));
    const full = lim(["shot", game, "a", "--video", rec, "--split", "file", "--read", "300", "--stuck", "8", "--no-audio"]);
    expect(full.code, full.out).toBe(0);
    expect(full.out).toContain("選んだもの: 印の道");
    const whole = probe(join(rec, "002_b.mp4")).duration;
    // 二つ目の区切りを録っている途中で止まったことにする
    const path = join(rec, "liminalia-video.json");
    const progress = JSON.parse(readFileSync(path, "utf8")) as { finished: boolean; stopped?: string; segments: { status: string; resume?: { temp?: Record<string, unknown>; lead?: { temp?: Record<string, unknown> } } }[] };
    expect(progress.segments[1]!.resume?.temp).toEqual({ mark: "T" });
    expect(progress.segments[1]!.resume?.lead?.temp).toEqual({ mark: "T" });
    progress.finished = false;
    progress.stopped = "interrupted";
    progress.segments[1]!.status = "recording";
    writeFileSync(path, JSON.stringify(progress));
    rmSync(join(rec, "002_b.mp4"));
    const again = lim(["shot", game, "a", "--video", rec, "--split", "file", "--read", "300", "--stuck", "8", "--no-audio", "--resume"]);
    expect(again.code, again.out).toBe(0);
    expect(again.out).toContain("続きから 1 本");
    // temp.mark が戻っているので、印の道が出て選べる
    expect(again.out).toContain("選んだもの: 印の道");
    // 区切りの頭の場面転換（3 秒）も録る（続けて録ったものとほぼ同じ長さ）
    expect(probe(join(rec, "002_b.mp4")).duration).toBeGreaterThan(whole - 1.5);
  });

  it("短い本文が連続しても次のクリック待ちを見逃さずに送る", () => {
    const game = join(work, "short-lines");
    cpSync(join(ROOT, "templates/default"), game, { recursive: true });
    writeFileSync(join(game, "scenario/start.lim"), `# start\n${"景\n".repeat(10)}@stop\n`);
    const result = lim(["shot", game, "start", "--video", join(work, "short-lines.mp4"), "--pages", "5", "--read", "100", "--stuck", "3", "--no-audio"]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("5 ページ");
    const auto = lim(["shot", game, "start", "--video", join(work, "short-lines-auto.mp4"), "--pages", "3", "--auto", "--stuck", "8", "--no-audio"]);
    expect(auto.code, auto.out).toBe(0);
    expect(auto.out).toContain("3 ページ");
  });

  it("--auto はエンジンのオートで送る（声のある台詞と動画を越えて、決めたページで止まる）", () => {
    const clip = join(work, "auto.mp4");
    const r = lim(["shot", dir, "a", "--video", clip, "--auto", "--pages", "3", "--stuck", "4"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("（3 ページ");
    expect(probe(clip).streams).toEqual(["video", "audio"]);
  });
});
