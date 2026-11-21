import type { Inline, Script, Statement } from "./ast.ts";
import { stripBom } from "./encoding.ts";
import { speechLine } from "./speech.ts";
import { autoVoicedLines, packCombinations, voiceAutoSettings, voiceFile, voiceLines, type VoiceLock } from "./voice-lock.ts";

/**
 * 収録用の台本（声を当てる台詞の一覧）。台詞ごとに、鳴らすボイスのファイル・話者・台詞（ルビは「漢字《かんじ》」）・
 * 演技のメモ（台詞のすぐ上の //! の行。ただのコメントの // は入れない）・前の行（掛け合いの相手の台詞や地の文）・場面（直前のラベル）・位置を並べる。
 * ボイスのファイルは、台詞の前の @voice か、番号の固定（voice-lock.json）と @voice-auto の pattern から決める（決まらなければ空）。
 */
export interface VoiceScriptRow {
  /** ボイスのファイル（folder からのパス。決まらなければ空）。 */
  voice: string;
  /** ボイスを読むフォルダ（voice か sound。@voice・@voice-auto の folder=）。 */
  folder: string;
  /** どこで決まったか。voice は台詞の前の @voice、auto は @voice-auto と番号の固定、none は決まっていない。 */
  how: "voice" | "auto" | "none";
  /** 台詞に効く @voice の行（無ければ null。値を式で書いていて voice が空のときも行は指す）。 */
  voiceLine: number | null;
  speaker: string;
  text: string;
  note: string;
  previous: string;
  /** 場面（"ファイル#ラベル"。ラベルより前なら "ファイル"）。 */
  scene: string;
  file: string;
  line: number;
  /**
   * 鳴らない理由（鳴るなら無い）。no-auto: @voice も無く、@voice-auto も効いていない台詞。unlocked: 連番のボイスが効いているのに、
   * 番号の固定（voice-lock.json）にこの台詞の番号が無い（固定があれば、固定に無い台詞は鳴らない）。
   * 固定がまだ無い作品の連番の台詞は、鳴らす順で番号が決まるので鳴る（voice は空）。
   */
  silent?: "no-auto" | "unlocked";
  /** 書き換える前の台詞から番号を引き継いだ（収録したボイスと原文が違う。voice-lock.json の rerecord）。 */
  rerecord?: true;
  /**
   * 同じ台詞で同時に鳴らすボイス（二つ目からの @voice。`who=` でほかの話者か、`channel=` でほかのチャンネル）の行。
   * speaker はそのボイスの話者（`who=`。無ければ台詞の話者）で、台詞の話者は speakerOfLine に入れる。
   */
  also?: true;
  /** also の行の、台詞の話者（speaker と違うときだけ）。 */
  speakerOfLine?: string;
  /** パック（packs/<フォルダ>）の台詞なら、そのフォルダ（file はパックの scenario からの台本の名前）。本体の台詞には無い。 */
  pack?: string;
}

/** 行を見分ける鍵（同じ台詞に同時のボイスがあると、ファイルと行だけでは見分けられない）。 */
export function voiceRowKey(r: Pick<VoiceScriptRow, "file" | "line" | "voiceLine" | "also">): string {
  return r.also ? `${r.file}:${r.line}@${r.voiceLine}` : `${r.file}:${r.line}`;
}

export interface VoiceScriptInput {
  /** ファイル名 → 読んだ台本と本文（メモの // の行を本文から拾う）。並びはファイル名の順。 */
  scripts: ReadonlyMap<string, { script: Script; text: string }>;
  lock: VoiceLock | null;
  /** 話者 → @voice-auto の pattern（番号の固定からファイル名を作る）。 */
  patterns: ReadonlyMap<string, string>;
  /** 話者 → @voice-auto の folder（省くと voice）。 */
  folders?: ReadonlyMap<string, string>;
  /** 台詞の鍵（@liminalia/lang の voiceLines の key）を、ファイルと行から引く。 */
  keyAt(file: string, line: number): string | undefined;
  /** 演技のメモにする行。既定は //! で始まる行だけ、"comments" ならすべての // の行（前の動き。liminalia.json の voiceScript.notes）。 */
  notes?: VoiceNoteStyle | undefined;
  /** 連番のボイスが鳴る台詞（"ファイル:行"。autoVoicedLines）。あれば鳴らない理由（silent）を付ける。 */
  voiced?: ReadonlySet<string> | undefined;
}

/** 演技のメモにする行（marked: //! で始まる行だけ、comments: すべての // の行）。 */
export type VoiceNoteStyle = "marked" | "comments";

/** 台詞の前に書いた @voice（file は値を式で書いていれば null）。 */
interface ExplicitVoice {
  file: string | null;
  line: number;
  folder: string;
  who: string | null;
  channel: number;
}

/** 台詞を収録の台本の行にする。同時に鳴らすボイス（二つ目からの @voice）は、それぞれ行にする（also）。 */
export function voiceScript(input: VoiceScriptInput): VoiceScriptRow[] {
  const rows: VoiceScriptRow[] = [];
  for (const [file, { script, text }] of input.scripts) {
    const lines = text.split("\n");
    let scene = file;
    let previous = "";
    /** 次の台詞で鳴らす @voice（一つ目と、同時に鳴らす二つ目から。実行器の stage.voice.next と also と同じ決まり）。 */
    let explicit: ExplicitVoice[] = [];
    const visit = (body: Statement[]) => {
      for (const s of body) {
        if (s.kind === "label") scene = `${file}#${s.name}`;
        else if (s.kind === "command" && s.name === "voice") {
          const arg = s.args.find((a) => a.key === "file") ?? s.args.find((a) => a.key === null);
          const folder = s.args.find((a) => a.key === "folder");
          const who = s.args.find((a) => a.key === "who");
          const channel = s.args.find((a) => a.key === "channel");
          const cue: ExplicitVoice = {
            file: arg?.value.kind === "string" ? arg.value.value : null,
            line: s.line,
            folder: folder?.value.kind === "string" ? folder.value.value : "voice",
            who: who?.value.kind === "string" && who.value.value !== "" ? who.value.value : null,
            channel: channel?.value.kind === "number" ? channel.value.value : 1,
          };
          const first = explicit[0];
          // ほかのチャンネルか、ほかの話者（who=）なら同時に鳴らす。同じ話者とチャンネルの二つ目は前のものを置き換える
          if (first && (cue.channel !== first.channel || (cue.who !== null && cue.who !== first.who))) explicit = [...explicit.filter((x, i) => i === 0 || x.who !== cue.who || x.channel !== cue.channel), cue];
          else explicit = [cue];
        } else if (s.kind === "say") {
          const key = input.keyAt(file, s.line);
          const locked = key ? input.lock?.lines[key] : undefined;
          const pattern = input.patterns.get(s.speaker);
          const auto = locked && pattern ? voiceFile(pattern, locked.n) : "";
          const line = readable(s.content);
          const skip = new Set(explicit.map((x) => x.line));
          const note = noteAbove(lines, s.line, skip, input.notes ?? "marked");
          const at = { text: line, note, previous, scene, file, line: s.line };
          if (explicit.length === 0) {
            const how = auto ? "auto" : "none";
            // 鳴らない理由（@voice は鳴る。連番は、効いていなければ no-auto、固定があるのに番号が無ければ unlocked）
            const silent = how !== "none" || !input.voiced ? undefined : !input.voiced.has(`${file}:${s.line}`) ? "no-auto" : input.lock ? "unlocked" : undefined;
            rows.push({
              voice: auto,
              folder: input.folders?.get(s.speaker) ?? "voice",
              how,
              voiceLine: null,
              speaker: s.speaker,
              ...at,
              ...(silent ? { silent } : {}),
              ...(how === "auto" && locked?.rerecord ? { rerecord: true as const } : {}),
            });
          } else {
            explicit.forEach((x, i) => {
              const speaker = x.who ?? s.speaker;
              rows.push({
                voice: x.file ?? "",
                folder: x.folder,
                how: "voice",
                voiceLine: x.line,
                speaker,
                ...at,
                ...(i > 0 ? { also: true as const } : {}),
                ...(i > 0 && speaker !== s.speaker ? { speakerOfLine: s.speaker } : {}),
              });
            });
          }
          explicit = [];
          previous = speechLine(s.speaker, line);
        } else if (s.kind === "prose") {
          previous = readable(s.content);
          explicit = [];
        } else if (s.kind === "if") for (const b of s.branches) visit(b.body);
      }
    };
    visit(script.body);
  }
  return rows;
}

/**
 * 読んだシナリオと番号の固定から、収録の台本の行を作る（@voice-auto の pattern と台詞の鍵を揃える）。
 * lim voice-script と制作画面のボイスの画面が同じものを使い、ボイスのファイルの決まりを一つに保つ。
 * packs はパック（dir は packs/<フォルダ>、scripts はパックの台本）。パックの台詞も本体の行のあとに並べ（pack にフォルダ）、pattern は
 * 本体にそのパックを重ねた台本で決める（遊ぶ側と同じ。番号は本体の voice-lock.json）。鳴るかは、そのパックを含むどれかの組み合わせ
 * （@liminalia/lang の packCombinations。番号を振る updateVoiceLock と同じ組）で連番が鳴りうるかで決める。
 */
export function voiceScriptRows(
  scripts: ReadonlyMap<string, { script: Script; text: string }>,
  lock: VoiceLock | null,
  o: { notes?: VoiceNoteStyle | undefined; entry?: string | undefined; packs?: readonly { dir: string; scripts: ReadonlyMap<string, { script: Script; text: string }> }[] } = {},
): VoiceScriptRow[] {
  /** set（一緒に遊ばれる台本）で、rows に並べる台本の行を作る。voiced は連番が鳴りうる台詞（省けば set で決める）。 */
  const rowsOf = (shown: ReadonlyMap<string, { script: Script; text: string }>, set: ReadonlyMap<string, Script>, voiced?: Set<string>): VoiceScriptRow[] => {
    const settings = [...voiceAutoSettings(set)];
    const keys = new Map<string, string>();
    for (const [file, script] of shown) for (const l of voiceLines(script.script)) keys.set(`${file}:${l.line}`, l.key);
    return voiceScript({
      scripts: shown,
      lock,
      patterns: new Map(settings.map(([speaker, list]) => [speaker, list[0]!.pattern])),
      folders: new Map(settings.map(([speaker, list]) => [speaker, list[0]!.folder])),
      keyAt: (file, line) => keys.get(`${file}:${line}`),
      notes: o.notes,
      voiced: voiced ?? autoVoicedLines(set, { entry: o.entry }),
    });
  };
  const plain = new Map([...scripts].map(([name, s]) => [name, s.script]));
  const rows = rowsOf(scripts, plain);
  const packs = (o.packs ?? []).map((p) => new Map([...p.scripts].map(([name, s]) => [name, s.script] as const)));
  const used = packs.filter((p) => p.size > 0);
  const combos = packCombinations(used.length).map((c) => c.map((i) => used[i]!));
  (o.packs ?? []).forEach((pack, i) => {
    const own = packs[i]!;
    const set = new Map([...plain, ...own]);
    // そのパックを含む組み合わせのどれかで、そのパックの台本の台詞に連番が鳴りうるか
    const voiced = new Set<string>();
    for (const chosen of combos) {
      if (!chosen.includes(own)) continue;
      const overlay = new Map([...plain, ...chosen.flatMap((p) => [...p])]);
      for (const at of autoVoicedLines(overlay, { entry: o.entry })) if (overlay.get(at.slice(0, at.lastIndexOf(":"))) === own.get(at.slice(0, at.lastIndexOf(":")))) voiced.add(at);
    }
    rows.push(...rowsOf(pack.scripts, set, voiced).map((r) => ({ ...r, pack: pack.dir })));
  });
  return rows;
}

/** 台詞を読める文字にする（ルビは「漢字《かんじ》」、改行は空白、命令・クリック待ちは外す）。 */
function readable(content: Inline[]): string {
  return content
    .map((n): string => {
      switch (n.kind) {
        case "text":
          return n.text;
        case "ruby":
          return `${n.base}《${n.reading}》`;
        case "br":
          return " ";
        case "value":
        case "click":
        case "noclick":
        case "command":
        case "image":
          return "";
        default:
          return readable(n.children);
      }
    })
    .join("")
    .trim();
}

const NOTE_LINE = /^\s*\/\/\s?(.*)$/;
/** 演技のメモの印（//! 小声で）。 */
const MARKED_NOTE = /^\s*\/\/!\s?(.*)$/;

/**
 * 台詞のすぐ上に続く // の行のうち、演技のメモ（既定は //! の行。style が comments ならすべて）。台詞に効く @voice の行と、
 * ただのコメントの行を挟んでいても読む（メモと @voice はどちらが上でもよい。同時に鳴らす @voice が二つあっても）。@voice は // の行の上に足す（noteStart）。
 */
function noteAbove(lines: readonly string[], line: number, voiceLines: ReadonlySet<number>, style: VoiceNoteStyle): string {
  const notes: string[] = [];
  for (let i = line - 2; i >= 0; i--) {
    if (voiceLines.has(i + 1)) continue;
    const m = NOTE_LINE.exec(lines[i] ?? "");
    if (!m) break;
    if (style === "comments") notes.unshift(m[1]!.trim());
    else {
      const marked = MARKED_NOTE.exec(lines[i] ?? "");
      if (marked) notes.unshift(marked[1]!.trim());
    }
  }
  return notes.join(" ");
}

/** 台詞のすぐ上に続く // の行の、いちばん上の行番号（無ければ台詞の行）。@voice を足すならこの行の前（メモが台詞から離れない）。 */
export function noteStart(lines: readonly string[], line: number): number {
  let at = line;
  while (at > 1 && NOTE_LINE.test(lines[at - 2] ?? "")) at--;
  return at;
}

/** 表を CSV にする（値に , " 改行があれば " で囲む）。Excel で開けるよう、書き出す側が先頭に BOM を付ける。 */
export function toCsv(rows: readonly (readonly (string | number)[])[]): string {
  const cell = (v: string | number) => {
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

/** CSV を読む（" で囲んだ値・その中の "" と改行に対応。先頭の BOM は外す）。 */
export function parseCsv(text: string): string[][] {
  const src = stripBom(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let quoteLine = 1;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\r" || (c === "\n" && src[i - 1] !== "\r")) line++;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') {
      quoted = true;
      quoteLine = line;
    } else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (quoted) throw new Error(`CSV の ${quoteLine} 行目で始まる引用符が閉じられていません`);
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
