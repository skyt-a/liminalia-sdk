import type { Value } from "@liminalia/runtime";
import { t, type CommandDefinition, type PluginCheckProject, type PluginDiagnostic } from "@liminalia/sdk";
import type { Statement } from "@liminalia/lang";

/**
 * 一回きりの演出。どれも状態（セーブ）に残さず、描画側が出して片付ける（RenderContext.scope）。
 * クリックの早送りで終わりの姿へ飛び、スキップ中は出さず、遊ぶ人が「光の点滅」を「控えめ」にしていれば @flash を点滅させない。
 * - @flipbook: 連番の画像のコマ送り（コマごとの時間を durations か data/ の JSON で書ける）。loop=0 は @flipbook-off で止めるまで繰り返し、
 *   これだけは状態（stage.extra の "std.flipbooks"）に残してロードで流し直す（待たない。スキップ中も止めない）
 * - @flipbook-off: 繰り返しているコマ送りを止める（名前を省くとすべて）
 * - @flash: 反転のコマ（白・黒・色・画面の色の反転）
 * - @blink: 瞼の瞬き（上下から閉じて開く）
 * - @cutin: 枠付きの差し込み画像（差し込んで、しばらく置いて、引く）。stay=true なら @cutin-hide まで残し、状態（stage.extra の "std.cutins"）に
 *   残してロードで出し直す
 * - @cutin-hide: 残したカットインを引く（名前を省くとすべて）
 */

const DEPTH_LAYERS = ["images", "fx", "overlay"] as const;
const FRONT_LAYERS = ["fx", "overlay"] as const;
const DEPTH_DOC = "置く層（images はカメラの内側の前景、fx は画面効果の層でメッセージ枠の下、overlay はメッセージ枠の上）";
/** カットインの層（hud はメッセージ枠の上で暗転の下。常駐の表示と同じ層）。 */
const CUTIN_LAYERS = ["images", "fx", "hud", "overlay"] as const;
const CUTIN_LAYER_DOC =
  "置く層（images はカメラの内側の前景、fx は画面効果の層でメッセージ枠の下、hud はメッセージ枠の上で暗転の下、overlay はメッセージ枠と暗転の上）。省くと、stay=true は hud（暗転しきっている間と章の扉の間は隠れる）、そうでなければ overlay";
const FRONT_DOC = "置く層（fx はメッセージ枠の下、overlay はメッセージ枠も覆う）";

const flipbookCommand: CommandDefinition = {
  name: "flipbook",
  summary: "連番の画像をコマ送りで流す（斬撃・爆発・光の筋など）。コマごとの時間は time か durations、data で書ける。流し終えたら消える",
  positional: ["image"],
  params: {
    image: t.string("連番の画像のパス（folder の中。{n} がコマの番号、{nn} は 2 桁、{nnn} は 3 桁で、1 から数える）。data を書けば省ける"),
    folder: t.enum(["image", "fgimage", "bgimage"], "画像のフォルダ", "image"),
    frames: t.int("コマの数（image に {n} があるとき）"),
    time: t.duration("一コマの時間（durations が無いとき）", "80ms"),
    durations: t.string("コマごとの時間（ミリ秒をカンマで並べる。「32,28,28,32」。足りないコマは最後の値）"),
    data: t.string("コマの並びを書いたデータ（data フォルダの JSON の名前と鍵。「flipbooks#slash」。中身は { image, frames, durations, folder }）"),
    loop: t.int("流す回数（0 なら @flipbook-off で止めるまで繰り返す。そのときは待たない）", "1"),
    name: t.string("名前（loop=0 のとき、@flipbook-off で止めるのに使う。同じ名前で流し直すと前のものを止める）"),
    speed: t.number("速さの倍率", "1"),
    layer: t.enum([...DEPTH_LAYERS], DEPTH_DOC, "fx"),
    x: t.number("左端（px）", "0"),
    y: t.number("上端（px）", "0"),
    width: t.number("幅（px。省くと画面の幅）"),
    height: t.number("高さ（px。省くと画面の高さ）"),
    opacity: t.number("不透明度（0〜1）", "1"),
    blend: t.string("重ね方（CSS の mix-blend-mode）", "normal", ["normal", "screen", "lighten", "multiply", "overlay", "plus-lighter"]),
    reflect: t.bool("左右に反転する", false),
    wait: t.bool("流し終えるまで次に進まない（loop=0 では待たない）", true),
    skip: t.skip(),
  },
  example: "@flipbook effects/slash/slash_{nn}.png frames=8 durations=32,28,28,32,42,52,66,90 blend=screen",
  waits: true,
  // 止めるまで繰り返すもの（loop=0）だけ、ロードで流し直すために残す
  apply(args, extra) {
    if (!flipbookLoops(args)) return;
    const name = typeof args.name === "string" ? args.name : "";
    const kept = readFlipbookLoops(extra).filter((l) => name === "" || l.name !== name);
    writeFlipbookLoops(extra, [...kept, { name, args: loopArgs(args) }]);
  },
};

const flipbookOffCommand: CommandDefinition = {
  name: "flipbook-off",
  summary: "@flipbook loop=0 で繰り返しているコマ送りを止める（名前を省くとすべて）",
  positional: ["name"],
  params: {
    name: t.string("止める名前（@flipbook の name。省略するとすべて）"),
    time: t.duration("消えるまでの時間", "0ms"),
  },
  example: "@flipbook-off rain time=300ms",
  apply(args, extra) {
    const name = typeof args.name === "string" ? args.name : null;
    writeFlipbookLoops(extra, name === null ? [] : readFlipbookLoops(extra).filter((l) => l.name !== name));
  },
};

const flashCommand: CommandDefinition = {
  name: "flash",
  summary: "反転のコマ（白・黒・色の一瞬のコマか、画面の色の反転）を挟む。「光の点滅」を「控えめ」にしていれば、点滅させずに薄い幕を一度かける",
  positional: ["type"],
  params: {
    type: t.enum(["white", "black", "color", "invert"], "コマの種類（white 白・black 黒・color は color の色・invert は画面の色を反転）", "white"),
    color: t.color("色（type=color のとき）", "#ffffff"),
    count: t.int("回数", "1"),
    time: t.duration("一コマを出しておく時間", "60ms"),
    gap: t.duration("コマとコマのあいだ", "60ms"),
    fade: t.duration("最後のコマが消えるまでの時間", "120ms"),
    hitstop: t.duration("ヒットストップ（コマを出したところで画面の動きを止めておく時間。止めるのは立ち絵の揺れ、アニメーション、画面効果）", "0ms"),
    zoom: t.number("ヒットストップのあいだ画面を寄せる倍率（1 で寄せない。1.03 くらいが目安）", "1"),
    layer: t.enum([...FRONT_LAYERS], FRONT_DOC, "overlay"),
    wait: t.bool("終わるまで次に進まない", true),
    skip: t.skip(),
  },
  example: "@flash invert count=2 time=50ms hitstop=120ms zoom=1.03",
  waits: true,
};

const blinkCommand: CommandDefinition = {
  name: "blink",
  summary: "瞼の瞬き（上下から閉じ、少しのあいだ閉じたままにしてから開く）。目を覚ます・気を失うなどの見た目の演出",
  params: {
    count: t.int("回数", "1"),
    close: t.duration("閉じる時間", "140ms"),
    hold: t.duration("閉じている時間", "160ms"),
    open: t.duration("開く時間", "300ms"),
    gap: t.duration("次の瞬きまでのあいだ", "260ms"),
    soft: t.int("瞼の縁のぼかし（px）", "0"),
    color: t.color("瞼の色", "#000000"),
    layer: t.enum([...FRONT_LAYERS], FRONT_DOC, "overlay"),
    wait: t.bool("開き終わるまで次に進まない", true),
    skip: t.skip(),
  },
  example: "@blink count=2 close=90ms hold=80ms open=220ms",
  waits: true,
};

const cutinCommand: CommandDefinition = {
  name: "cutin",
  summary: "枠付きの画像を差し込み、しばらく置いて引く（手がかり・持ち物・顔のアップなど）。stay=true なら @cutin-hide まで残し、セーブにも残る",
  positional: ["image"],
  params: {
    image: t.required(t.asset("image", "差し込む画像")),
    x: t.number("中心の横の位置（px。省くと画面の中央）"),
    y: t.number("中心の縦の位置（px。省くと画面の中央）"),
    width: t.number("画像の幅（px。省くと画像の大きさ。height だけなら縦横比から）"),
    height: t.number("画像の高さ（px）"),
    "max-width": t.number("大きさの上限の幅（px。枠と余白を含む。width と height を省いたとき、画像を縦横比のまま縮めて収める）"),
    "max-height": t.number("大きさの上限の高さ（px。枠と余白を含む）"),
    padding: t.int("画像と枠のあいだの余白（px。枠の色で埋まる）", "0"),
    frame: t.color("枠の色", "#ffffff"),
    border: t.int("枠の太さ（px。0 で枠なし）", "8"),
    from: t.enum(["right", "left", "top", "bottom", "none"], "差し込む向き（none はその場で浮かび上がる）", "right"),
    rotate: t.number("傾き（度）", "0"),
    in: t.duration("差し込む時間", "250ms"),
    time: t.duration("置いておく時間（stay=true では使わない）", "1.2s"),
    out: t.duration("引く時間（stay=true では @cutin-hide の既定）", "250ms"),
    stay: t.bool("差し込んだまま残す（@cutin-hide で引く。セーブに残り、ロードで出し直す）", false),
    name: t.string("名前（stay=true のとき、@cutin-hide で引くのに使う。同じ名前で出し直すと前のものと入れ替わる）"),
    layer: t.enum([...CUTIN_LAYERS], CUTIN_LAYER_DOC),
    "hide-window": t.bool("出しているあいだメッセージ枠を隠す（stay=true では差し込むあいだだけ）", false),
    wait: t.bool("引き終わるまで次に進まない（stay=true では差し込み終わるまで）", true),
    skip: t.skip(),
  },
  example: "@cutin props/key.png from=left time=1.5s rotate=-3",
  waits: true,
  // 残すもの（stay=true）だけ、ロードで出し直すために残す
  apply(args, extra) {
    if (args.stay !== true) return;
    const name = typeof args.name === "string" ? args.name : "";
    writeCutins(extra, [...readCutins(extra).filter((c) => c.name !== name), { name, args: cutinArgs(args) }]);
  },
};

const cutinHideCommand: CommandDefinition = {
  name: "cutin-hide",
  summary: "@cutin stay=true で残したカットインを引く（名前を省くとすべて）",
  positional: ["name"],
  params: {
    name: t.string("引く名前（@cutin の name。省くとすべて）"),
    time: t.duration("引く時間。省くと出したときの out"),
    "hide-window": t.bool("引くあいだメッセージ枠を隠す", false),
    wait: t.bool("引き終わるまで次に進まない", true),
    skip: t.skip(),
  },
  example: "@cutin-hide key time=300ms",
  waits: true,
  apply(args, extra) {
    const name = typeof args.name === "string" ? args.name : null;
    writeCutins(extra, name === null ? [] : readCutins(extra).filter((c) => c.name !== name));
  },
};

export const COMMANDS: CommandDefinition[] = [flipbookCommand, flipbookOffCommand, flashCommand, blinkCommand, cutinCommand, cutinHideCommand];

// ---- 残すカットイン（状態に残す） ----

/** 状態の鍵（stage.extra）。出した順に並べる。 */
export const CUTINS_KEY = "std.cutins";

/** 残しているカットイン（name は空でもよい。args は出し直すのに要る引数だけ）。 */
export interface StayCutin {
  name: string;
  args: Record<string, Value>;
}

const CUTIN_ARGS = ["image", "x", "y", "width", "height", "max-width", "max-height", "padding", "frame", "border", "from", "rotate", "out", "layer", "name"];
function cutinArgs(args: Record<string, Value>): Record<string, Value> {
  const out: Record<string, Value> = { stay: true };
  for (const k of CUTIN_ARGS) if (args[k] !== undefined) out[k] = args[k]!;
  return out;
}

export function readCutins(extra: Record<string, Value>): StayCutin[] {
  const v = extra[CUTINS_KEY];
  return Array.isArray(v) ? (v as unknown as StayCutin[]).filter((c) => c && typeof c === "object" && c.args && typeof c.args === "object") : [];
}

function writeCutins(extra: Record<string, Value>, cutins: StayCutin[]): void {
  if (cutins.length === 0) delete extra[CUTINS_KEY];
  else extra[CUTINS_KEY] = cutins as unknown as Value;
}

// ---- 止めるまで繰り返すコマ送り（状態に残す） ----

/** 状態の鍵（stage.extra）。 */
export const FLIPBOOK_LOOPS_KEY = "std.flipbooks";

/** 繰り返しているコマ送り（name は空でもよい。args は流し直すのに要る引数だけ）。 */
export interface FlipbookLoop {
  name: string;
  args: Record<string, Value>;
}

/** 止めるまで繰り返すか（loop=0）。 */
export const flipbookLoops = (args: Record<string, Value>): boolean => args.loop === 0;

/** 流し直すのに要る引数。 */
const LOOP_ARGS = ["image", "folder", "frames", "time", "durations", "data", "speed", "layer", "x", "y", "width", "height", "opacity", "blend", "reflect", "name"];
function loopArgs(args: Record<string, Value>): Record<string, Value> {
  const out: Record<string, Value> = { loop: 0 };
  for (const k of LOOP_ARGS) if (args[k] !== undefined) out[k] = args[k]!;
  return out;
}

export function readFlipbookLoops(extra: Record<string, Value>): FlipbookLoop[] {
  const v = extra[FLIPBOOK_LOOPS_KEY];
  return Array.isArray(v) ? (v as unknown as FlipbookLoop[]).filter((l) => l && typeof l === "object" && l.args && typeof l.args === "object") : [];
}

function writeFlipbookLoops(extra: Record<string, Value>, loops: FlipbookLoop[]): void {
  if (loops.length === 0) delete extra[FLIPBOOK_LOOPS_KEY];
  else extra[FLIPBOOK_LOOPS_KEY] = loops as unknown as Value;
}

// ---- コマ送りの並び（描画側と検査が使う） ----

/** コマ送りの並びを書いたデータの一つ（data/<名前>.json の鍵の値）。 */
export interface FlipbookData {
  image: string;
  frames?: number;
  durations?: number[];
  folder?: string;
}

/** コマ送りの並び（一コマずつのパスと時間）。 */
export interface FlipbookFrames {
  folder: string;
  frames: { path: string; ms: number }[];
}

const PLACEHOLDER = /\{(n+)\}/;

/** "32,28 ,28" を数の並びにする（読めない値は飛ばす）。 */
export function parseDurations(v: Value | undefined): number[] {
  if (typeof v === "number") return [v];
  if (Array.isArray(v)) return v.filter((x): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0);
  if (typeof v !== "string") return [];
  return v
    .split(/[\s,、]+/)
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0);
}

/** data= の「名前#鍵」を分ける。 */
export function splitDataRef(ref: string): { name: string; key: string | null } {
  const i = ref.indexOf("#");
  return i < 0 ? { name: ref, key: null } : { name: ref.slice(0, i), key: ref.slice(i + 1) || null };
}

/** 引数と（あれば）データから、コマの並びを決める。足りなければ理由を返す。 */
export function flipbookFrames(args: Record<string, Value>, data: FlipbookData | null): FlipbookFrames | { error: string; errorEn: string } {
  const image = typeof args.image === "string" && args.image !== "" ? args.image : (data?.image ?? "");
  if (!image) return { error: "@flipbook には image か data を書きます", errorEn: "@flipbook needs image or data" };
  const folder = typeof args.folder === "string" && args.data === undefined ? args.folder : (data?.folder ?? (typeof args.folder === "string" ? args.folder : "image"));
  const listed = parseDurations(args.durations);
  const fromData = data?.durations?.filter((n) => typeof n === "number" && Number.isFinite(n) && n >= 0) ?? [];
  const durations = listed.length > 0 ? listed : fromData;
  const m = PLACEHOLDER.exec(image);
  let count = typeof args.frames === "number" ? args.frames : (data?.frames ?? (m ? durations.length : 1));
  if (m && count <= 0) return { error: "@flipbook の image に {n} があるときは frames（コマの数）を書きます", errorEn: "@flipbook needs frames (the number of frames) when image has {n}" };
  if (!m) count = 1;
  const each = typeof args.time === "number" ? args.time : 80;
  const frames = Array.from({ length: Math.min(count, 500) }, (_, i) => ({
    path: m ? image.replace(PLACEHOLDER, String(i + 1).padStart(m[1]!.length, "0")) : image,
    ms: durations.length > 0 ? (durations[i] ?? durations.at(-1)!) : each,
  }));
  return { folder, frames };
}

// ---- 検査（lim check の「プラグイン」） ----

type CommandStatement = Extract<Statement, { kind: "command" }>;

/** 台本の中の命令の行（@if・@while・@with・@define の中も）。 */
function* commandsIn(statements: readonly Statement[]): Generator<CommandStatement> {
  for (const s of statements) {
    if (s.kind === "command") yield s;
    else if (s.kind === "if") for (const b of s.branches) yield* commandsIn(b.body);
    else if (s.kind === "define") yield* commandsIn(s.body);
  }
}

/** 書いた値（式は読まない）。位置引数は positional の名前で引ける。 */
function argValues(c: CommandStatement, positional: readonly string[]): Record<string, Value> {
  const out: Record<string, Value> = {};
  let i = 0;
  for (const a of c.args) {
    const name = a.key ?? positional[i++];
    if (!name) continue;
    const v = a.value;
    if (v.kind === "duration") out[name] = v.ms;
    else if (v.kind !== "expr") out[name] = v.value;
  }
  return out;
}

/**
 * @flipbook の並び（image と data・frames・素材）を作品全体で確かめる。止めるまで繰り返すもの（loop=0）に wait=true を書いたもの（待たない）と、
 * @flipbook-off の名前が、どの @flipbook loop=0 の name にも無いものも知らせる。
 */
export function checkOneShots(project: PluginCheckProject): PluginDiagnostic[] {
  const out: PluginDiagnostic[] = [];
  // 繰り返すコマ送りの名前（式で書いたものがあれば、名前は確かめない）
  const loopNames = new Set<string>();
  let dynamicNames = false;
  const offs: { file: string; line: number; name: string }[] = [];
  for (const [file, script] of project.scripts) {
    for (const c of commandsIn(script.body)) {
      if (c.name === "flipbook-off") {
        const v = argValues(c, ["name"]);
        if (c.args.some((a) => a.value.kind === "expr")) dynamicNames = true;
        else if (typeof v.name === "string" && v.name !== "") offs.push({ file, line: c.line, name: v.name });
        continue;
      }
      if (c.name !== "flipbook") continue;
      const args = argValues(c, ["image"]);
      if (c.args.some((a) => (a.key === "name" || a.key === "loop") && a.value.kind === "expr")) dynamicNames = true;
      else if (args.loop === 0 && typeof args.name === "string") loopNames.add(args.name);
      if (args.loop === 0 && args.wait === true)
        out.push({
          severity: "warning",
          code: "flipbook-loop-wait",
          message: "@flipbook loop=0 は止めるまで繰り返すので、wait=true でも待たずに次へ進みます（止めるのは @flipbook-off）",
          messageEn: "@flipbook loop=0 repeats until stopped, so it doesn't wait even with wait=true (stop it with @flipbook-off)",
          file,
          line: c.line,
        });
      // 式で書いた値は実行するまで分からないので確かめない
      if (c.args.some((a) => a.value.kind === "expr")) continue;
      let data: FlipbookData | null = null;
      if (typeof args.data === "string" && args.data !== "") {
        const { name, key } = splitDataRef(args.data);
        const all = project.data(name.endsWith(".json") ? name : `${name}.json`) as Record<string, unknown> | undefined;
        const picked = all === undefined ? undefined : key === null ? all : all[key];
        if (!picked || typeof picked !== "object" || typeof (picked as FlipbookData).image !== "string") {
          out.push({
            severity: "error",
            code: "flipbook-data",
            message: `@flipbook の data ${args.data} がありません（data フォルダの JSON に { image, frames, durations } を書きます）`,
            messageEn: `@flipbook data ${args.data} doesn't exist (write { image, frames, durations } in a JSON file in the data folder)`,
            file,
            line: c.line,
          });
          continue;
        }
        data = picked as FlipbookData;
      }
      const r = flipbookFrames(args, data);
      if ("error" in r) {
        out.push({ severity: "error", code: "flipbook-frames", message: r.error, messageEn: r.errorEn, file, line: c.line });
        continue;
      }
      const missing = r.frames.map((f) => f.path).filter((p) => !project.assetExists(r.folder, p));
      if (missing.length > 0)
        out.push({
          severity: "warning",
          code: "flipbook-missing",
          message: `@flipbook のコマ ${missing.slice(0, 3).join("、")}${missing.length > 3 ? ` ほか ${missing.length - 3} 枚` : ""} が ${r.folder} にありません`,
          messageEn: `@flipbook frames ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ` and ${missing.length - 3} more` : ""} aren't in ${r.folder}`,
          file,
          line: c.line,
        });
    }
  }
  if (!dynamicNames)
    for (const o of offs)
      if (!loopNames.has(o.name))
        out.push({
          severity: "warning",
          code: "flipbook-off-unknown",
          message: `@flipbook-off の ${o.name} を、どの @flipbook loop=0 も name に書いていません`,
          messageEn: `No @flipbook loop=0 has name ${o.name} for @flipbook-off`,
          file: o.file,
          line: o.line,
        });
  return out;
}
