import { argOrigin, type TextOrigin, type Value } from "@liminalia/runtime";
import { t, type CommandDefinition } from "@liminalia/sdk";

/**
 * 常駐の表示（HUD）。遊んでいるあいだ出したままにするボタンと文字（TyranoScript の [button fix=true] と、日付や場所、好感度の表示）。
 * - @hud-button: 押すと場面を呼ぶボタン（call=）。show-if=(式) が偽のあいだは出さない（変数が変わるたびに見直す）。
 *   行の if=(式)（その行を実行するかどうか。lang の takeGuard）とは別の名前にしてある。key= のキーでも押せ、矢印キーと十字キーでも選べる
 * - @hud-text: 変数を埋めた文字（"{= game.day} 日目"）。変数が変わるたびに描き直す
 * - @hud-button-off、@hud-text-off: 名前で外す（省くとすべて）
 * 出しているものは stage.extra の "std.hud" に持ち、セーブとロード、巻き戻し、スキップで同じに出し直す。
 * 字面で書いた文字（@hud-text の text、@hud-button の label）は訳の元（i18n）を持ち、言語を替えたときと別の言語でロードしたときに
 * 今の言語で出し直す（@liminalia/runtime の retranslate.ts）。
 */

/** 状態の鍵（stage.extra）。 */
export const HUD_KEY = "std.hud";

/** 押すと場面を呼ぶボタン。if は出す条件の式（式の元の文字。無ければいつも出す）。 */
export interface HudButton {
  kind: "button";
  name: string;
  call: string;
  x: number;
  y: number;
  image?: string;
  hover?: string;
  label?: string;
  width?: number;
  height?: number;
  /** 押すキー（KeyboardEvent.key の名前。英字は大文字と小文字を同じに扱う）。 */
  key?: string;
  if?: string;
  /** 言語を替えたときに出し直す元（label）。 */
  i18n?: { label: TextOrigin };
}

/** 変数を埋めた文字。text の {= 式} を出すときに評価する。 */
export interface HudText {
  kind: "text";
  name: string;
  text: string;
  x: number;
  y: number;
  width?: number;
  size?: number;
  color?: string;
  align?: string;
  if?: string;
  /** 言語を替えたときに出し直す元（text）。 */
  i18n?: { text: TextOrigin };
}

export type HudItem = HudButton | HudText;

export function readHud(extra: Record<string, Value>): HudItem[] {
  const v = extra[HUD_KEY];
  return Array.isArray(v) ? (v as unknown as HudItem[]).filter((i) => i && typeof i === "object" && (i.kind === "button" || i.kind === "text") && typeof i.name === "string") : [];
}

function writeHud(extra: Record<string, Value>, items: HudItem[]): void {
  if (items.length === 0) delete extra[HUD_KEY];
  else extra[HUD_KEY] = items as unknown as Value;
}

/** 同じ種類と名前のものは置き換える（並びの位置は保つ）。 */
function put(extra: Record<string, Value>, item: HudItem): void {
  const items = readHud(extra);
  const i = items.findIndex((x) => x.kind === item.kind && x.name === item.name);
  if (i >= 0) items[i] = item;
  else items.push(item);
  writeHud(extra, items);
}

function remove(extra: Record<string, Value>, kind: HudItem["kind"], name: Value | undefined): void {
  writeHud(
    extra,
    readHud(extra).filter((x) => x.kind !== kind || (typeof name === "string" && x.name !== name)),
  );
}

const num = (v: Value | undefined): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: Value | undefined): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** 書いたものだけ入れる（セーブを小さく保つ）。 */
type Loose<T> = { [K in keyof T]: T[K] | undefined };
function defined<T extends object>(o: Loose<T>): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

const NAME_DOC = "名前（@hud-button-off、@hud-text-off で外すのに使う。同じ名前で書き直すと置き換える）";
const IF_DOC = "出す条件（式）。偽のあいだは出さない。変数が変わるたびに見直す";

const hudButtonCommand: CommandDefinition = {
  name: "hud-button",
  summary: "遊んでいるあいだ出したままにするボタンを置く。押すと call= の場面を呼び、戻ったら読んでいたページ（選択肢を出していれば選択肢）を出し直す。@hud-button-off で外すまで残り、セーブにも残る",
  positional: ["name"],
  params: {
    name: t.required(t.string(NAME_DOC)),
    call: { type: { kind: "target" }, required: true, doc: "押したときに呼ぶ場面（#ラベル、ファイル#ラベル）。@return か次のラベルで戻る" },
    image: t.asset("image", "ボタンの画像（省くと label の文字のボタン）"),
    hover: t.asset("image", "マウスを載せたときの画像"),
    label: t.text("ボタンの文字（image を省いたとき。読み上げにも使う）"),
    x: t.number("左端（px）", "0"),
    y: t.number("上端（px）", "0"),
    width: t.number("幅（px。省くと画像か文字の大きさ）"),
    height: t.number("高さ（px）"),
    key: t.string("押すキー（m、F1 など。英字の大文字と小文字は同じ）。遊んでいる最中と選択肢を出している間に効き、ほかの操作の既定のキーより先に効く"),
    "show-if": { type: { kind: "condition" }, doc: IF_DOC },
  },
  example: "@hud-button notebook image=ui/notebook.png x=1180 y=20 call=#open_notebook key=n show-if=(game.has_notebook)",
  waits: false,
  async run(args, ctx) {
    const item = defined<HudButton>({
      kind: "button" as const,
      name: String(args.name ?? ""),
      call: String(args.call ?? ""),
      x: num(args.x) ?? 0,
      y: num(args.y) ?? 0,
      image: str(args.image),
      hover: str(args.hover),
      label: str(args.label),
      width: num(args.width),
      height: num(args.height),
      key: str(args.key),
      // 条件は式の元の文字で残し、出すときと変数が変わったときに評価する
      if: ctx.sources?.["show-if"],
    });
    const label = argOrigin(args, "label");
    if (label && item.label !== undefined) item.i18n = { label };
    put(ctx.state.stage.extra, item);
    await ctx.present(args, false);
  },
};

const hudButtonOffCommand: CommandDefinition = {
  name: "hud-button-off",
  summary: "@hud-button で置いたボタンを外す（名前を省くとすべて）",
  positional: ["name"],
  params: { name: t.string("外す名前（省くとすべて）") },
  example: "@hud-button-off notebook",
  apply: (args, extra) => remove(extra, "button", args.name),
};

const hudTextCommand: CommandDefinition = {
  name: "hud-text",
  summary: "遊んでいるあいだ出したままにする文字を置く。{= 式} で変数の値を埋め、変数が変わるたびに描き直す（日付、場所、好感度など）。@hud-text-off で外すまで残り、セーブにも残る",
  positional: ["name"],
  params: {
    name: t.required(t.string(NAME_DOC)),
    text: t.required(t.text("出す文字（{= 式} で変数の値を埋める。\"{= game.day} 日目\" など）")),
    x: t.number("左端（px）", "0"),
    y: t.number("上端（px）", "0"),
    width: t.number("幅（px。align で揃える幅。省くと文字の幅）"),
    size: t.number("文字の大きさ（px。省くとメッセージ枠の文字と同じ）"),
    color: t.color("文字の色（省くとメッセージ枠の文字と同じ）"),
    align: t.enum(["left", "center", "right"], "揃え（width を書いたとき）", "left"),
    "show-if": { type: { kind: "condition" }, doc: IF_DOC },
  },
  example: '@hud-text day text="{= game.day} 日目" x=40 y=24 size=28',
  waits: false,
  async run(args, ctx) {
    const item = defined<HudText>({
      kind: "text" as const,
      name: String(args.name ?? ""),
      // 遊んでいる言語の文を残す（訳す前の元は i18n に持ち、言語を替えたら書き換える）。{= 式} は出すときに評価する
      text: String(args.text ?? ""),
      x: num(args.x) ?? 0,
      y: num(args.y) ?? 0,
      width: num(args.width),
      size: num(args.size),
      color: str(args.color),
      align: args.align === "left" ? undefined : str(args.align),
      if: ctx.sources?.["show-if"],
    });
    const text = argOrigin(args, "text");
    if (text) item.i18n = { text };
    put(ctx.state.stage.extra, item);
    await ctx.present(args, false);
  },
};

const hudTextOffCommand: CommandDefinition = {
  name: "hud-text-off",
  summary: "@hud-text で置いた文字を外す（名前を省くとすべて）",
  positional: ["name"],
  params: { name: t.string("外す名前（省くとすべて）") },
  example: "@hud-text-off day",
  apply: (args, extra) => remove(extra, "text", args.name),
};

export const COMMANDS: CommandDefinition[] = [hudButtonCommand, hudButtonOffCommand, hudTextCommand, hudTextOffCommand];

/** text の {= 式} の並び（start〜end は `{` から `}` の後ろまで、source は式の元の文字）。 */
export interface HudSegment {
  start: number;
  end: number;
  source: string;
}

/** 文字の中の {= 式} を探す（"…" の中の } は数えない）。閉じていないものは文字のまま。 */
export function hudSegments(text: string): HudSegment[] {
  const out: HudSegment[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "{" && text[i + 1] === "=") {
      let j = i + 2;
      let quoted = false;
      while (j < text.length && (quoted || text[j] !== "}")) {
        if (text[j] === "\\" && quoted) j++;
        else if (text[j] === '"') quoted = !quoted;
        j++;
      }
      if (j >= text.length) break;
      out.push({ start: i, end: j + 1, source: text.slice(i + 2, j).trim() });
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}
