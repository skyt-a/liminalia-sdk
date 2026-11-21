import type { Inline, Script, Statement } from "./ast.ts";
import { plainText } from "./inline.ts";
import { SPEECH_CLOSE } from "./speech.ts";
import { voiceLines, type VoiceLock } from "./voice-lock.ts";

/**
 * シナリオの文字数の集計（lim stats と Studio のチェックの画面）。
 *
 * - 台詞（say）と地の文（prose）を分けて、行の数と文字数を数える。選択肢の文は別に数える
 * - 文字は表示される文字だけ: ルビは親文字だけ、コマンド（本文中の {@…}）・値の埋め込み・改行・空白（全角の空白を含む）は数えない。
 *   台詞は外側の括弧（「」『』（）()）を数えない
 * - ボイスの付いた台詞: 前の行の @voice、本文の中の {@voice …}、@voice-auto で自動にしている話者の台詞
 *   （番号の固定 voice-lock.json があれば、固定に無い台詞は鳴らないので数えない）
 * - 集計の単位は、ファイル、シーン（ラベルから次のラベルまで。最初のラベルより前はファイルの名前）、話者
 * - マクロ（@define）の中の行は、書いてあるシーンで数える
 */
export interface TextCount {
  lines: number;
  chars: number;
}

export interface StatsRow {
  say: TextCount;
  prose: TextCount;
  choice: TextCount;
  /** ボイスの付いた台詞の数。 */
  voiced: number;
}

export interface FileStats extends StatsRow {
  file: string;
}

export interface SceneStats extends StatsRow {
  file: string;
  /** ラベル（最初のラベルより前は null）。 */
  label: string | null;
  /** ラベルの行（最初のラベルより前は 1）。 */
  line: number;
}

export interface SpeakerStats {
  speaker: string;
  say: TextCount;
  voiced: number;
}

export interface TextStats {
  total: StatsRow;
  files: FileStats[];
  scenes: SceneStats[];
  speakers: SpeakerStats[];
}

/** 本文の一行（集計と表記ゆれの検出に使う）。 */
export interface TextUnit {
  file: string;
  line: number;
  kind: "say" | "prose" | "choice";
  speaker: string | null;
  /** 表示される文字（ルビは親文字、改行は \n）。 */
  text: string;
}


/** 数える文字の数（空白と改行を除いたコードポイントの数）。 */
export function countChars(text: string): number {
  let n = 0;
  for (const c of text) if (!/\s/u.test(c)) n++;
  return n;
}

/** 台詞の外側の括弧と引用符を外す（文字数に数えない）。 */
function unquote(text: string): string {
  const close = SPEECH_CLOSE[text[0] ?? ""];
  return close && text.length >= 2 && text.endsWith(close) ? text.slice(1, -1) : text;
}

const empty = (): StatsRow => ({ say: { lines: 0, chars: 0 }, prose: { lines: 0, chars: 0 }, choice: { lines: 0, chars: 0 }, voiced: 0 });

function hasVoiceCommand(content: Inline[]): boolean {
  return content.some((n) => (n.kind === "command" && n.name === "voice") || ("children" in n && hasVoiceCommand(n.children)));
}

/** 本文の行を、ボイスの有無と一緒に取り出す（ファイルの名前の順）。 */
export function textUnits(scripts: ReadonlyMap<string, Script>, lock: VoiceLock | null = null): (TextUnit & { voiced: boolean; scene: string | null; sceneLine: number })[] {
  const out: (TextUnit & { voiced: boolean; scene: string | null; sceneLine: number })[] = [];
  for (const [file, script] of scripts) {
    const keys = lock ? new Map(voiceLines(script).map((v) => [v.line, v.key])) : null;
    /** @voice-auto で自動にしている話者（"" はすべて）。 */
    const auto = new Map<string, boolean>();
    const configured = new Set<string>();
    let pending = false;
    let scene: string | null = null;
    let sceneLine = 1;
    const autoOn = (speaker: string) => configured.has(speaker) && (auto.get(speaker) ?? false);
    const visit = (body: readonly Statement[]) => {
      for (const s of body) {
        switch (s.kind) {
          case "label":
            scene = s.name;
            sceneLine = s.line;
            break;
          case "command": {
            const who = (s.args.find((a) => a.key === "who") ?? s.args.find((a) => a.key === null))?.value;
            const name = who?.kind === "string" ? who.value : null;
            if (s.name === "voice") pending = true;
            else if (s.name === "voice-auto") {
              const pattern = s.args.find((a) => a.key === "pattern");
              const start = s.args.find((a) => a.key === "start")?.value;
              const on = !(start?.kind === "bool" && !start.value);
              if (name !== null) {
                if (pattern) configured.add(name);
                auto.set(name, pattern ? on : true);
              } else for (const k of configured) auto.set(k, true);
            } else if (s.name === "voice-auto-off") {
              if (name !== null) auto.set(name, false);
              else for (const k of configured) auto.set(k, false);
            }
            break;
          }
          case "say": {
            const inline = hasVoiceCommand(s.content);
            let voiced = pending || inline;
            if (!voiced && autoOn(s.speaker)) {
              const key = keys?.get(s.line);
              voiced = !lock || (key !== undefined && key in lock.lines);
            }
            pending = false;
            out.push({ file, line: s.line, kind: "say", speaker: s.speaker, text: unquote(plainText(s.content)), voiced, scene, sceneLine });
            break;
          }
          case "prose":
            pending = false;
            out.push({ file, line: s.line, kind: "prose", speaker: null, text: plainText(s.content), voiced: false, scene, sceneLine });
            break;
          case "choice":
            for (const o of s.options) {
              const text = plainText(o.content);
              if (text.trim() !== "") out.push({ file, line: o.line, kind: "choice", speaker: null, text, voiced: false, scene, sceneLine });
            }
            break;
          case "if":
            for (const b of s.branches) visit(b.body);
            break;
          case "define":
            visit(s.body);
            break;
          default:
            break;
        }
      }
    };
    visit(script.body);
  }
  return out;
}

/** 文字数を集計する。 */
export function textStats(scripts: ReadonlyMap<string, Script>, lock: VoiceLock | null = null): TextStats {
  const total = empty();
  const files = new Map<string, FileStats>();
  const scenes = new Map<string, SceneStats>();
  const speakers = new Map<string, SpeakerStats>();
  for (const file of scripts.keys()) files.set(file, { file, ...empty() });
  const add = (row: StatsRow, u: TextUnit & { voiced: boolean }, chars: number) => {
    row[u.kind].lines++;
    row[u.kind].chars += chars;
    if (u.voiced) row.voiced++;
  };
  for (const u of textUnits(scripts, lock)) {
    const chars = countChars(u.text);
    add(total, u, chars);
    add(files.get(u.file)!, u, chars);
    const key = `${u.file}#${u.scene ?? ""}`;
    let sc = scenes.get(key);
    if (!sc) scenes.set(key, (sc = { file: u.file, label: u.scene, line: u.sceneLine, ...empty() }));
    add(sc, u, chars);
    if (u.kind === "say" && u.speaker !== null) {
      let sp = speakers.get(u.speaker);
      if (!sp) speakers.set(u.speaker, (sp = { speaker: u.speaker, say: { lines: 0, chars: 0 }, voiced: 0 }));
      sp.say.lines++;
      sp.say.chars += chars;
      if (u.voiced) sp.voiced++;
    }
  }
  return {
    total,
    files: [...files.values()],
    scenes: [...scenes.values()],
    speakers: [...speakers.values()].sort((a, b) => b.say.chars - a.say.chars),
  };
}
