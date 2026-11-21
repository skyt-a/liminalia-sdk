import { opensBody, speechOpenAt, splitLineId } from "@liminalia/lang";
/**
 * 行の種類を、構文木を作らずに行ごとに見分ける（打鍵ごとに全行を見直すので、軽いことを優先する）。
 * 見分け方は @liminalia/lang の parse に合わせてある。台本の色分け・札・畳む・持続の帯が使う。
 */

export type LineKind =
  | "blank"
  | "comment"
  | "label"
  /** 演出などの命令（流れの命令を除く）。 */
  | "command"
  /** 流れの命令（@if・@choice・@end・@set・@jump など）。 */
  | "flow"
  /** @choice の中の選択肢の行。 */
  | "option"
  /** @script・@html の中身。 */
  | "script"
  | "say"
  | "prose";

export interface LineInfo {
  kind: LineKind;
  /** 命令名（command・flow）、ラベル名（label）、話者（say）。 */
  name: string | null;
  /** 台詞の行の {name …} の中身（この行だけ名前欄に出す名前。書いたままの字面）。 */
  display?: string;
  /** @define の中の行か。 */
  inDefine: boolean;
  /** @end までの中身をそのまま持つ命令の行か（@html と、file= の無い @staff-roll）。 */
  body?: true;
}

/** 流れを決める命令。札にせず、畳まない。 */
export const FLOW_COMMANDS: ReadonlySet<string> = new Set(["if", "elif", "else", "while", "for", "with", "content", "end", "choice", "define", "function", "script", "set", "let", "jump", "call", "return", "use"]);

/** 命令の種類（色分けの種類）。背景・場面転換、BGM、効果音とボイス、立ち絵、流れ（変数・選択肢・分岐）、そのほか。 */
export type CommandKind = "bg" | "bgm" | "se" | "ch" | "flow" | "sys";

const KIND_OF: Record<string, CommandKind> = Object.fromEntries([
  ...["bg", "scene-change", "bg-place", "transition", "wait-transition", "image", "free-image", "movie", "bg-movie", "stop-bg-movie", "wait-bg-movie", "blend-movie"].map((n) => [n, "bg"]),
  ...["bgm", "stop-bgm", "pause-bgm", "resume-bgm", "bgm-volume", "wait-bgm"].map((n) => [n, "bgm"]),
  ...["se", "stop-se", "pause-se", "resume-se", "se-volume", "wait-se", "voice", "voice-auto", "voice-auto-off", "stop-voice", "wait-voice", "text-sound", "text-sound-off"].map((n) => [n, "se"]),
  ...["chara", "chara-hide", "chara-hide-all", "chara-move", "chara-shake", "chara-config"].map((n) => [n, "ch"]),
]);

/** 命令名の種類（流れの命令は flow、知らない命令・作品の命令は sys）。 */
export function commandKind(name: string): CommandKind {
  return KIND_OF[name] ?? (FLOW_COMMANDS.has(name) ? "flow" : "sys");
}

const NAME_OPEN = "{name ";

/**
 * `話者{name 表示名}「…」`（`Yui{name ???} "…"`）の行なら、話者と {name …} の中身（{name …} のすぐ後が台詞の括弧か引用符のときだけ。
 * 引用符の前には半角の空白を一つ書いてもよい）。speakers は長い名前から。
 */
export function speakerWithName(line: string, speakers: readonly string[]): { speaker: string; inner: string } | null {
  for (const s of speakers) {
    if (!line.startsWith(s) || !line.startsWith(NAME_OPEN, s.length)) continue;
    let depth = 1;
    let i = s.length + NAME_OPEN.length;
    for (; i < line.length && depth > 0; i++) {
      const c = line[i];
      if (c === "\\") i++;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    if (depth !== 0 || speechOpenAt(line, i) < 0) continue;
    return { speaker: s, inner: line.slice(s.length + NAME_OPEN.length, i - 1) };
  }
  return null;
}

/** 行のテキストの並びを見分ける。返す配列の添字は 0 始まり（行番号 − 1）。 */
export function classifyLines(lines: readonly string[], speakers: readonly string[]): LineInfo[] {
  const sorted = [...speakers].sort((a, b) => b.length - a.length);
  const out: LineInfo[] = new Array(lines.length);
  const stack: ("if" | "define" | "choice")[] = [];
  let inScript = false;
  let defineDepth = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.replace(/^[ \t]+/, "").replace(/[ \t\r]+$/, "");
    const inDefine = defineDepth > 0;
    if (inScript) {
      if (line === "@end") {
        inScript = false;
        out[i] = { kind: "flow", name: "end", inDefine };
      } else out[i] = { kind: "script", name: null, inDefine };
      continue;
    }
    if (line === "") {
      out[i] = { kind: "blank", name: null, inDefine };
      continue;
    }
    if (stack.at(-1) === "choice" && line !== "@end") {
      out[i] = { kind: line.startsWith("//") ? "comment" : "option", name: null, inDefine };
      continue;
    }
    if (line.startsWith("//")) {
      out[i] = { kind: "comment", name: null, inDefine };
      continue;
    }
    if (line.startsWith("#")) {
      const m = /^# (.+)$/.exec(line);
      out[i] = { kind: "label", name: m ? m[1]! : null, inDefine };
      continue;
    }
    if (line.startsWith("@")) {
      const m = /^@(\S*)(?:\s+(.*))?$/.exec(line)!;
      const name = m[1]!;
      if (!FLOW_COMMANDS.has(name)) {
        // @html と @staff-roll（file= なし）は @script と同じく @end までの中身をそのまま持つ
        const body = opensBody(name, m[2] ?? "");
        out[i] = { kind: "command", name, inDefine, ...(body ? { body: true as const } : {}) };
        if (body) inScript = true;
        continue;
      }
      out[i] = { kind: "flow", name, inDefine };
      switch (name) {
        case "if":
        case "choice":
          stack.push(name);
          break;
        case "while":
        case "for":
        case "with":
          stack.push("if");
          break;
        case "define":
          stack.push("define");
          defineDepth++;
          break;
        case "script":
          inScript = true;
          break;
        case "end": {
          const top = stack.pop();
          if (top === "define") defineDepth--;
          break;
        }
      }
      continue;
    }
    const speaker = sorted.find((s) => line.startsWith(s) && speechOpenAt(line, s.length) >= 0);
    // 話者{name 表示名}「…」（@liminalia/lang の speakerWithName と同じ見分け方）
    const named = speaker ? null : speakerWithName(line, sorted);
    out[i] = speaker ? { kind: "say", name: speaker, inDefine } : named ? { kind: "say", name: named.speaker, display: named.inner, inDefine } : { kind: "prose", name: null, inDefine };
  }
  return out;
}

/** 本文の行（1 ページになる行）か。 */
export function isText(info: LineInfo | undefined): boolean {
  return info !== undefined && (info.kind === "say" || info.kind === "prose");
}

/** 行の中の命令の部分（`@` の後ろ）。字下げと行末の空白を除く。 */
export function commandSource(line: string): string {
  return line.trim().replace(/^@/, "");
}

/** 話者名と台詞の本文を一行にする（括弧はそのまま続け、引用符の前には半角の空白を挟む。`ユイ「…」`、`Yui "…"`）。 */
export { speechLine } from "@liminalia/lang";

/**
 * 台詞の行の本文（話者名のあと。引用符の前の半角の空白一つは除く）。地の文ならそのまま。どちらも字下げを除いた位置からの桁を返す。
 * 行の終わりの固定の行 ID（` #line:ID`）は本文に入れない（本文を書き換えても、本文の後ろとして残る）。
 */
export function textContent(line: string, info: LineInfo): { text: string; offset: number } {
  const indent = /^[ \t]*/.exec(line)![0].length;
  let skip = info.kind === "say" && info.name ? info.name.length + (info.display !== undefined ? NAME_OPEN.length + info.display.length + 1 : 0) : 0;
  if (info.kind === "say" && info.name) skip = Math.max(skip, speechOpenAt(line, indent + skip) - indent);
  return { text: splitLineId(line.replace(/\r$/, "")).body.slice(indent + skip).replace(/[ \t\r]+$/, ""), offset: indent + skip };
}
