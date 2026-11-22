import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { renameSync, rmSync, statSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { VIDEO_FPS } from "./video-timeline.ts";

/**
 * lim shot --video の、一つの区切り（一つの mp4）を書く ffmpeg。コマ（JPEG）は標準入力へ、音（16 ビット、チャンネルを交互）は
 * 手元の TCP（127.0.0.1）で流し、録りながら書いていく（コマを一時フォルダに溜めない）。
 * 書いている間は断片にした mp4（途中で止まっても、そこまでは見られる）にし、閉じたら、空きがあれば一つにまとめた mp4 に書き直す。
 */

/** ffmpeg のコマンド（テストで差し替える）。 */
export const FFMPEG = "ffmpeg";

/** ffmpeg が無ければ、入れ方を添えて止める（録画を始める前に呼ぶ）。 */
export function requireFfmpeg(cmd = FFMPEG): void {
  const r = spawnSync(cmd, ["-version"], { encoding: "utf8", timeout: 15_000 });
  if (r.error || r.status !== 0) {
    throw new Error(`録画には ffmpeg が要りますが、見つかりません。入れてからもう一度実行してください（Mac は brew install ffmpeg、Linux は apt install ffmpeg、Windows は winget install ffmpeg）`);
  }
}

/** 使う動画の符号器（H.264。その符号器の無い ffmpeg なら MPEG-4）。 */
let codecArgs: string[] | null = null;
function videoCodec(): string[] {
  if (codecArgs) return codecArgs;
  const encoders = spawnSync(FFMPEG, ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout ?? "";
  // 録りながら書くので速い設定にする（静かな場面が多いので、大きさはそれほど増えない）
  codecArgs = /\blibx264\b/.test(encoders) ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21"] : ["-c:v", "mpeg4", "-q:v", "4"];
  return codecArgs;
}

/** 音の形（16 ビットの符号つき、チャンネルを交互に並べたもの）。 */
export interface AudioFormat {
  rate: number;
  channels: number;
}

/** ffmpeg に渡す引数（テストで確かめる）。audio が null なら音なし。port は音を流す TCP の口。 */
export function ffmpegArgs(out: string, audio: (AudioFormat & { port: number }) | null, fps = VIDEO_FPS, codec = videoCodec()): string[] {
  const video = ["-thread_queue_size", "1024", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-"];
  const sound = audio ? ["-thread_queue_size", "1024", "-f", "s16le", "-ar", String(audio.rate), "-ac", String(audio.channels), "-i", `tcp://127.0.0.1:${audio.port}`] : [];
  const maps = audio ? ["-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "160k"] : ["-map", "0:v:0"];
  // 縦と横を偶数に（H.264 の yuv420p の決まり）。キーフレームは 10 秒ごと（断片の区切り）
  return ["-v", "error", "-y", ...video, ...sound, ...maps, "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-pix_fmt", "yuv420p", ...codec, "-g", String(fps * 10), "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", out];
}

/** 一つの区切りの書き手。 */
export class SegmentWriter {
  /** 書いた動画のコマの数。 */
  frames = 0;
  private readonly child: ChildProcess;
  private stderr = "";
  private readonly exited: Promise<number | null>;
  private socket: Socket | null = null;
  /** ffmpeg が音の口につないだら解決する。 */
  private readonly connected: Promise<void>;
  private readonly pending: Buffer[] = [];
  private failed: string | null = null;

  private constructor(
    readonly out: string,
    private readonly server: Server | null,
    port: number,
    audio: AudioFormat | null,
  ) {
    // 端末の Ctrl+C が ffmpeg に届かないように、別の組で立てる（止めるときは入力を閉じて書き終えさせる。Windows は別の窓が開くので分けない）
    this.child = spawn(FFMPEG, ffmpegArgs(out, audio ? { ...audio, port } : null), { stdio: ["pipe", "ignore", "pipe"], detached: process.platform !== "win32" });
    this.child.stderr!.on("data", (d: Buffer) => {
      this.stderr = (this.stderr + d.toString()).slice(-4000);
    });
    // 書いている途中で ffmpeg が止まっても、書き込みの失敗では落とさず、終了の値で知らせる
    this.child.stdin!.on("error", () => undefined);
    this.exited = new Promise((resolve) => {
      this.child.once("close", (code) => resolve(code));
      this.child.once("error", (e) => {
        this.failed = e.message;
        resolve(-1);
      });
    });
    this.connected = new Promise((resolve) => {
      if (!server) return resolve();
      server.once("connection", (socket) => {
        socket.on("error", () => undefined);
        this.socket = socket;
        for (const b of this.pending.splice(0)) socket.write(b);
        resolve();
      });
    });
  }

  /** ffmpeg を立てる（音があれば、音を受ける口を先に開く）。 */
  static async open(out: string, audio: AudioFormat | null): Promise<SegmentWriter> {
    let server: Server | null = null;
    let port = 0;
    if (audio) {
      server = createServer();
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      port = (server.address() as { port: number }).port;
    }
    return new SegmentWriter(out, server, port, audio);
  }

  /** ffmpeg が止まっていれば、その理由。 */
  get error(): string | null {
    if (this.failed) return this.failed;
    if (this.child.exitCode !== null && this.child.exitCode !== 0) return this.reason();
    return null;
  }

  /** 書き込みを待っているバイト数（ffmpeg が追いつかないと増える）。 */
  get backlog(): number {
    return (this.child.stdin?.writableLength ?? 0) + (this.socket?.writableLength ?? this.pending.reduce((n, b) => n + b.length, 0));
  }

  /** 動画のコマ（JPEG）を一枚書く。 */
  writeFrame(jpeg: Buffer): void {
    if (this.child.exitCode !== null) return;
    this.child.stdin!.write(jpeg);
    this.frames++;
  }

  /** 音を書く。 */
  writeAudio(pcm: Buffer): void {
    if (pcm.length === 0) return;
    if (this.socket) this.socket.write(pcm);
    else this.pending.push(pcm);
  }

  private reason(): string {
    return this.stderr.trim().split("\n").slice(-3).join(" ");
  }

  /**
   * 書き終える（入力を閉じて ffmpeg が書き終えるのを待つ）。tidy なら、空きがあれば一つにまとめた mp4 に書き直す
   * （書き直せなければ、断片にした mp4 のまま残す）。
   */
  async close(tidy: boolean, freeBytes: () => number): Promise<void> {
    this.child.stdin!.end();
    // 短い区切りでは、ffmpeg が音の口につなぐ前のことがある（つなぐのを待ってから閉じる。ffmpeg が先に止まれば待たない）
    await Promise.race([this.connected, this.exited]);
    this.socket?.end();
    const code = await this.exited;
    this.server?.close();
    if (code !== 0) throw new Error(`ffmpeg で動画にできませんでした: ${this.failed ?? this.reason()}`);
    if (!tidy) return;
    let size = 0;
    try {
      size = statSync(this.out).size;
    } catch {
      // 書いたファイルが無ければ、書き直さない
      return;
    }
    if (freeBytes() < size * 1.1 + 64 * 1024 * 1024) return;
    const tmp = `${this.out}.tidy.mp4`;
    const r = spawnSync(FFMPEG, ["-v", "error", "-y", "-i", this.out, "-map", "0", "-c", "copy", "-movflags", "+faststart", tmp], { encoding: "utf8" });
    if (r.status === 0) renameSync(tmp, this.out);
    else rmSync(tmp, { force: true });
  }

  /** 止める（書いた所までは断片の mp4 として残る）。 */
  kill(): void {
    this.child.stdin?.end();
    this.socket?.destroy();
    this.server?.close();
  }
}
