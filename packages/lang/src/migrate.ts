import type { Diagnostic } from "./ast.ts";
import { opensBody } from "./credits.ts";

/**
 * 台本の書式の版と、前の版の書き方を今の書き方に移す（lim migrate と、検査の renamed-command）。
 *
 * SCRIPT_FORMAT は今の .lim の書式の版。作品の liminalia.json の format に、台本を書いた書式の版を書く（lim new と lim migrate が書く）。
 * format を省いた作品は、版を書く前（1）の台本として扱う。format がエンジンの版より新しければ、検査が知らせる（新しいエンジンで書いた台本）。
 *
 * 版の変わりめ:
 * - 1: 版を書く前（2026-11-07 まで）
 * - 2: 前の版の命令の名前（@show・@hide・@hide-all・@sprite-config・@scene）を外した版。今の名前は @chara 一族と @scene-change
 * - 3: プレイを終える命令の ending= を、画面の文言（「BAD END」「通り雨」）からエンディングの種類（bad、other など）にし、名前を title= に分けた版
 *   （endings.ts の migrateEndingSource。2 までの作品の文言の ending= は動き続け、検査が legacy-ending で知らせる）
 * - 4: 動きにかける時間の引数を fade= から time= にした版（@bg・@chara・@mask など。RENAMED_PARAMS）。time= を別の意味で持つ命令
 *   （@effect・@effect-off・@staff-roll・@flash・@chapter-card・@chapter-end）と、fade-in・crossfade・hide-fade などの名前は変えない。
 *   前の fade= も動き続け（args.ts の normalizeBooleanArgs が time に読む）、検査が renamed-param で知らせる
 *
 * 版を上げるときは、ここに変わりめを書き、RENAMED_COMMANDS（か移し方）を足し、SCRIPT_FORMAT を一つ上げる。
 */
export const SCRIPT_FORMAT = 4;

/** 前の版の命令の名前 → 今の名前と、その名前になった版（引数はそのまま使える）。 */
export const RENAMED_COMMANDS: Readonly<Record<string, { to: string; format: number }>> = {
  show: { to: "chara", format: 2 },
  hide: { to: "chara-hide", format: 2 },
  "hide-all": { to: "chara-hide-all", format: 2 },
  "sprite-config": { to: "chara-config", format: 2 },
  scene: { to: "scene-change", format: 2 },
};

/** fade= を time= にした命令（版 4）。 */
const FADE_TO_TIME = [
  "bg", "chara", "plane", "plane-hide", "dof", "tone", "chara-hide", "chara-hide-all", "bgm", "stop-bgm", "se", "stop-se", "mask", "mask-off", "scene-change", "window",
  "bgm-volume", "se-volume", "voice-filter", "stop-voice",
  "image", "free-image", "blend", "blend-off", "filter", "filter-off", "bg-movie", "stop-bg-movie", "blend-movie", "bg-place", "layer-text", "html", "html-hide",
  "particles", "particles-off", "flipbook-off",
] as const;

/** 前の版の引数の名前（命令 → 前の名前 → 今の名前）。組み込みの命令だけ（同じ名前のマクロには当てない）。 */
export const RENAMED_PARAMS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.fromEntries(FADE_TO_TIME.map((name) => [name, { fade: "time" }]));

/**
 * 前の版の引数の名前なら今の名前（無ければ null）。今の仕様が前の名前を持たず今の名前を持つときだけ（マクロやプラグインの同じ名前の命令には当てない）。
 */
export function renamedParam(spec: { name: string; macro?: boolean; params: Readonly<Record<string, unknown>> }, key: string): string | null {
  if (spec.macro) return null;
  const to = RENAMED_PARAMS[spec.name]?.[key];
  return to !== undefined && !(key in spec.params) && to in spec.params ? to : null;
}

/** 移した一か所（1 始まりの行と、前と後の命令の名前）。 */
export interface MigrationChange {
  line: number;
  from: string;
  to: string;
}

/**
 * 台本の前の版の書き方を今の書き方にする。命令の名前（RENAMED_COMMANDS）と引数の名前（RENAMED_PARAMS。`@bg x.jpg fade=1s` → `time=1s`）。
 * 命令の行の頭（`@scene …`）と本文の中の命令（`{@show …}`）を見る。@define の中の行も同じ。
 * @script と @html と @staff-roll の中身、コメントの行は変えない。macros は作品の @define の名前で、同じ名前のマクロがあれば置き換えない
 * （前のひな形の @define scene のように、作品のマクロとして使っているもの）。改行の形（\r\n）はそのまま。
 */
export function migrateSource(source: string, macros: ReadonlySet<string> = new Set()): { text: string; changes: MigrationChange[] } {
  const renames = Object.entries(RENAMED_COMMANDS).filter(([from]) => !macros.has(from));
  const names = renames.map(([from]) => from.replace(/-/g, "\\-")).sort((a, b) => b.length - a.length).join("|");
  const head = renames.length > 0 ? new RegExp(`^(\\s*@)(${names})(?=\\s|$)`) : null;
  const inline = renames.length > 0 ? new RegExp(`(?<!\\\\)\\{@(${names})(?=[\\s}])`, "g") : null;
  const to = (from: string) => RENAMED_COMMANDS[from]!.to;
  const rows = source.split("\n");
  const changes: MigrationChange[] = [];
  /** 引数の名前を今の名前にする（命令の名前は今の名前にしたあとのもの）。 */
  const params = (row: string, line: number): string => {
    let next = row.replace(/^(\s*@)([a-z][a-z0-9-]*)(.*)$/s, (all, at: string, name: string, rest: string) => {
      const renamed = renameArgs(rest, name, macros);
      for (const c of renamed.changes) changes.push({ line, from: `${name} ${c.from}=`, to: `${name} ${c.to}=` });
      return renamed.changes.length > 0 ? `${at}${name}${renamed.text}` : all;
    });
    // 本文の中の {@命令 …}（} は引用と括弧の外のもの）
    const out: string[] = [];
    let at = 0;
    for (const m of next.matchAll(/(?<!\\)\{@([a-z][a-z0-9-]*)/g)) {
      if (m.index! < at) continue;
      const begin = m.index! + m[0].length;
      const close = closingBrace(next, begin);
      if (close < 0) break;
      const renamed = renameArgs(next.slice(begin, close), m[1]!, macros);
      for (const c of renamed.changes) changes.push({ line, from: `${m[1]} ${c.from}=`, to: `${m[1]} ${c.to}=` });
      out.push(next.slice(at, begin), renamed.text);
      at = close;
    }
    if (at > 0) next = out.join("") + next.slice(at);
    return next;
  };
  let raw = false;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const line = row.replace(/\r$/, "").trim();
    if (raw) {
      if (line === "@end") raw = false;
      continue;
    }
    if (line.startsWith("//")) continue;
    const m = /^@([a-z][a-z0-9-]*)(?:\s+(.*))?$/.exec(line);
    if (m && (m[1] === "script" || opensBody(m[1]!, (m[2] ?? "").trim()))) {
      // 中身を持つ命令の行そのもの（@html notice fade=300ms）は引数を移す
      rows[i] = params(row, i + 1);
      raw = true;
      continue;
    }
    let next = head
      ? row.replace(head, (_all, at: string, from: string) => {
          changes.push({ line: i + 1, from, to: to(from) });
          return `${at}${to(from)}`;
        })
      : row;
    if (inline)
      next = next.replace(inline, (_all, from: string) => {
        changes.push({ line: i + 1, from, to: to(from) });
        return `{@${to(from)}`;
      });
    rows[i] = params(next, i + 1);
  }
  return { text: rows.join("\n"), changes };
}

/** 命令の引数の字面（命令の名前のあと）の、前の版の引数の名前を今の名前にする。引用と括弧（式）の中は見ない。 */
function renameArgs(text: string, command: string, macros: ReadonlySet<string>): { text: string; changes: { from: string; to: string }[] } {
  const table = macros.has(command) ? undefined : RENAMED_PARAMS[command];
  if (!table) return { text, changes: [] };
  const changes: { from: string; to: string }[] = [];
  let out = "";
  let quote = false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") {
        out += c + (text[i + 1] ?? "");
        i++;
        continue;
      }
      if (c === '"') quote = false;
      out += c;
      continue;
    }
    if (c === '"') quote = true;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (i === 0 || /\s/.test(text[i - 1]!))) {
      const word = /^([a-z][a-z0-9-]*)=/.exec(text.slice(i));
      const to = word ? table[word[1]!] : undefined;
      if (word && to !== undefined) {
        changes.push({ from: word[1]!, to });
        out += `${to}=`;
        i += word[0].length - 1;
        continue;
      }
    }
    out += c;
  }
  return { text: out, changes };
}

/** 本文の中の {@…} を閉じる } の位置（引用と括弧の中は飛ばす）。無ければ -1。 */
function closingBrace(text: string, from: number): number {
  let quote = false;
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === '"') quote = false;
    } else if (c === '"') quote = true;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === "}" && depth === 0) return i;
  }
  return -1;
}

/**
 * liminalia.json の commandDefaults の前の版の名前を今の名前にする（同じ名前のマクロがあれば変えない）。変えた名前の組を返す。
 * 前の引数の名前（fade）と今の名前（time）を同じ所に書いていれば、前の名前の値は使われていないので外す（dropped。{ from: "chara.fade", kept: "chara.time" }）。
 */
export function migrateCommandDefaults(defaults: Record<string, unknown>, macros: ReadonlySet<string> = new Set()): { defaults: Record<string, unknown>; changes: { from: string; to: string }[]; dropped: { from: string; kept: string }[] } {
  const out: Record<string, unknown> = {};
  const changes: { from: string; to: string }[] = [];
  const dropped: { from: string; kept: string }[] = [];
  for (const [name, value] of Object.entries(defaults)) {
    const renamed = RENAMED_COMMANDS[name];
    if (renamed && !macros.has(name) && !(renamed.to in defaults)) {
      out[renamed.to] = value;
      changes.push({ from: name, to: renamed.to });
    } else out[name] = value;
  }
  // 引数の名前（"bg": { "fade": "1s" } → "time"）。今の名前を同じ所に書いていれば、前の名前は使われていないので外す
  for (const [name, value] of Object.entries(out)) {
    const table = macros.has(name) ? undefined : RENAMED_PARAMS[name];
    if (!table || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const params = value as Record<string, unknown>;
    if (!Object.keys(params).some((k) => table[k] !== undefined)) continue;
    out[name] = Object.fromEntries(
      Object.entries(params).flatMap(([k, v]) => {
        const to = table[k];
        if (to === undefined) return [[k, v]];
        if (to in params) {
          dropped.push({ from: `${name}.${k}`, kept: `${name}.${to}` });
          return [];
        }
        changes.push({ from: `${name}.${k}`, to: `${name}.${to}` });
        return [[to, v]];
      }),
    );
  }
  return { defaults: out, changes, dropped };
}

/** liminalia.json の format（台本の書式の版）を確かめる。エンジンの版より新しければ警告、整数でなければエラー。 */
export function checkFormat(format: unknown): Diagnostic[] {
  if (format === undefined) return [];
  if (typeof format !== "number" || !Number.isInteger(format) || format < 1) {
    // 0.1.17 までの整形の設定（"format": { "indent": 2 }）は、lim migrate が fmt に移して format を数にする
    const hint = format && typeof format === "object" && !Array.isArray(format) ? "整形の設定は fmt に移します（lim migrate）" : `"format": ${SCRIPT_FORMAT}`;
    return [{ severity: "error", code: "bad-config", message: `format は 1 以上の整数で書きます: ${JSON.stringify(format)}`, file: "liminalia.json", line: 1, hint }];
  }
  if (format > SCRIPT_FORMAT) {
    return [{ severity: "warning", code: "newer-format", message: `台本の書式の版（format: ${format}）が、このエンジンの書式の版（${SCRIPT_FORMAT}）より新しくなっています`, file: "liminalia.json", line: 1, hint: "新しい版のエンジン（lim）で検査します" }];
  }
  return [];
}
