import type { Diagnostic, DiagnosticFix } from "./ast.ts";
import { typoDistance } from "./check.ts";
import { jsonLines } from "./data-schema.ts";
import { stripBom } from "./encoding.ts";

/**
 * 設定の JSON（liminalia.json・cast.json・lang/<言語>.json）の検査。読めない所の行と桁を分かる文で出し、
 * JSON Schema（packages/project/schemas。ProjectConfig などの型から作る）に無い項目を、近い名前の案つきで警告する。
 */

/** 検査に使う JSON Schema の形（使うものだけ）。 */
export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  enum?: unknown[];
  required?: string[];
  $schema?: string;
}

/** JSON として読めない所（offset は文字の位置）と、その理由。読めれば null。 */
export function jsonSyntaxError(text: string): { offset: number; reason: string } | null {
  let i = 0;
  class Stop {
    constructor(
      readonly offset: number,
      readonly reason: string,
    ) {}
  }
  const fail = (reason: string, at = i): never => {
    throw new Stop(at, reason);
  };
  const ws = () => {
    for (;;) {
      while (i < text.length && /[ \t\r\n﻿]/.test(text[i]!)) i++;
      if (text.startsWith("//", i) || text.startsWith("/*", i)) fail("JSON にはコメントを書けません");
      return;
    }
  };
  const end = () => (i >= text.length ? fail("途中で終わっています（閉じ括弧か値が足りません）") : undefined);
  const string = () => {
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\n" || text[i] === "\r") fail("文字列の中で改行できません（改行は \\n と書きます）");
      if (text[i] === "\\") i++;
      i++;
    }
    if (i >= text.length) fail("文字列が閉じていません");
    i++;
  };
  const value = (): void => {
    ws();
    end();
    const c = text[i]!;
    if (c === "{") return object();
    if (c === "[") return array();
    if (c === '"') return string();
    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
    if (!literal) fail(c === "'" ? "文字列は \"…\" で囲みます（' は使えません）" : "値として読めません（文字列は \"…\" で囲みます）");
    i += literal![0].length;
  };
  const object = () => {
    i++;
    ws();
    end();
    if (text[i] === "}") {
      i++;
      return;
    }
    for (;;) {
      ws();
      end();
      if (text[i] === "}") fail("最後の項目のあとの , は書けません");
      if (text[i] !== '"') fail("項目の名前は \"…\" で囲みます");
      string();
      ws();
      end();
      if (text[i] !== ":") fail("項目の名前のあとに : が必要です");
      i++;
      value();
      ws();
      end();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "}") {
        i++;
        return;
      }
      fail("値のあとに , か } が必要です（前の行の終わりの , を忘れていませんか）");
    }
  };
  const array = () => {
    i++;
    ws();
    end();
    if (text[i] === "]") {
      i++;
      return;
    }
    for (;;) {
      ws();
      end();
      if (text[i] === "]") fail("最後の値のあとの , は書けません");
      value();
      ws();
      end();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "]") {
        i++;
        return;
      }
      fail("値のあとに , か ] が必要です");
    }
  };
  try {
    value();
    ws();
    if (i < text.length) fail("値のあとに余分なものがあります");
    return null;
  } catch (e) {
    if (e instanceof Stop) return { offset: e.offset, reason: e.reason };
    throw e;
  }
}

/** 文字の位置を行と桁（どちらも 1 から）にする。 */
export function lineColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  return { line, column: offset - (before.lastIndexOf("\n") + 1) + 1 };
}

/**
 * 設定の JSON の文字を読む。読めなければ、その位置（行と桁）の誤り（code）を返す。読めれば値と、Schema に無い項目の警告（unknown-config-key）。
 */
export function readConfigJson(text: string, file: string, schema: JsonSchema | null, code = "bad-config", skip: readonly string[] = []): { value: unknown; diagnostics: Diagnostic[] } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    const at = jsonSyntaxError(text) ?? { offset: 0, reason: "JSON として読めません" };
    const { line, column } = lineColumn(text, at.offset);
    return { value: undefined, diagnostics: [{ severity: "error", code, message: `JSON として読めません: ${at.reason}`, file, line, column }] };
  }
  return { value, diagnostics: schema ? unknownConfigKeys(value, schema, file, text, skip) : [] };
}

/**
 * Schema に無い項目（additionalProperties が false の所）。書いても使われないので警告し、綴りの近い項目があれば案と置き換える直し方を付ける。
 * 一番外の $schema（エディタが Schema を読むための項目）は認める。skip は中を見ない項目（"ui" など。ほかの検査が知らない項目を知らせるもの）。
 */
export function unknownConfigKeys(value: unknown, schema: JsonSchema, file: string, text?: string, skip: readonly string[] = []): Diagnostic[] {
  const out: Diagnostic[] = [];
  const lines = text ? jsonLines(text) : new Map<string, number>();
  const pointer = (path: readonly string[]) => path.map((p) => `/${p.replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
  const walk = (v: unknown, s: JsonSchema | undefined, path: string[]) => {
    if (!s || v === null || typeof v !== "object" || skip.includes(path.join("."))) return;
    if (Array.isArray(v)) {
      if (s.items) v.forEach((x, i) => walk(x, s.items, [...path, String(i)]));
      return;
    }
    // どの形にも当てはまる記録（anyOf）は、記録の形が一つだけのときに見る
    const objects = (s.anyOf ?? [s]).filter((x) => x.properties || x.additionalProperties !== undefined);
    if (objects.length !== 1) return;
    const shape = objects[0]!;
    for (const [key, child] of Object.entries(v as Record<string, unknown>)) {
      const known = shape.properties?.[key];
      if (known) {
        walk(child, known, [...path, key]);
        continue;
      }
      if (typeof shape.additionalProperties === "object") {
        walk(child, shape.additionalProperties, [...path, key]);
        continue;
      }
      if (shape.additionalProperties !== false || (path.length === 0 && key === "$schema")) continue;
      const names = Object.keys(shape.properties ?? {});
      let near: string | null = null;
      let best = Infinity;
      for (const n of names) {
        const d = typoDistance(key.toLowerCase(), n.toLowerCase());
        if (d < best) [near, best] = [n, d];
      }
      if (near === null || best > Math.max(1, Math.floor(key.length / 3))) near = null;
      const where = [...path, key].join(".");
      const fix: DiagnosticFix | undefined = near ? { kind: "replace", find: JSON.stringify(key), with: JSON.stringify(near) } : undefined;
      out.push({
        severity: "warning",
        code: "unknown-config-key",
        message: `${file} の ${where} は知らない項目のため、使われません`,
        file,
        line: lines.get(pointer([...path, key])) ?? 1,
        ...(near ? { hint: `${near} のことですか？` } : { hint: `書ける項目: ${names.join("、")}` }),
        ...(fix ? { fix, fixes: [fix] } : {}),
      });
    }
  };
  walk(value, schema, []);
  return out;
}

/** liminalia.json の variables に書ける変数の名前（game. か system. の後ろに名前）。 */
export const VARIABLE_KEY = /^(game|system)\.[\p{ID_Start}_][\p{ID_Continue}_]*$/u;

/**
 * liminalia.json の項目の値の誤り（その項目を使わずに続けるもの。variables の形と名前、saves.location）。
 * config は読み解いた liminalia.json、text はその字面（項目の行を求める）。loadProject はここで知らせた項目を使わない。
 */
export function configValueProblems(config: unknown, text: string, file = "liminalia.json"): Diagnostic[] {
  if (!config || typeof config !== "object" || Array.isArray(config)) return [];
  const c = config as { variables?: unknown; saves?: { location?: unknown } | null };
  let lines: Map<string, number> | null = null;
  const out: Diagnostic[] = [];
  const problem = (pointer: string, message: string) => {
    lines ??= jsonLines(text);
    out.push({ severity: "error", code: "bad-config", message, file, line: lines.get(pointer) ?? 1 });
  };
  if (c.variables !== undefined) {
    if (typeof c.variables !== "object" || c.variables === null || Array.isArray(c.variables)) problem("/variables", `${file} の variables は "game.名前" → 値 の形で書きます`);
    else {
      for (const key of Object.keys(c.variables)) {
        if (!VARIABLE_KEY.test(key)) problem(`/variables/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`, `${file} の variables の ${key} は "game.名前" か "system.名前" で書きます`);
      }
    }
  }
  const location = c.saves && typeof c.saves === "object" ? c.saves.location : undefined;
  if (location !== undefined && location !== "user" && location !== "portable") problem("/saves/location", `${file} の saves.location は "user" か "portable" です`);
  return out;
}

/** 設定の形の誤りの code → その誤りのある項目（JSON Pointer）。値の形を見る検査は場所を持たないので、少なくともこの項目の行に出す。 */
const CONFIG_SECTIONS: Readonly<Record<string, string>> = {
  "bad-ui": "/ui",
  "bad-chapters": "/chapters",
  "bad-auto-layout": "/autoLayout",
  "bad-extra": "/extra",
  "bad-after-load": "/afterLoad",
  "bad-command-defaults": "/commandDefaults",
  "bad-items": "/items",
  "bad-rules": "/check/rules",
  "bad-scenes": "/scenes",
  "unknown-tone": "/ui/backgroundTones",
};

/** 使われない話者の文（flow-check.ts の unused-speaker）の話者の名前。 */
const UNUSED_SPEAKER = /^話者 (.+) はどの台詞にも使われていません$/;

/** 文の中の設定の道（`ui.window.padding`、`check.sound.off`、`chapters[2].target`）。 */
const CONFIG_PATH = /(?:^|[^\w.])((?:ui|extra|chapters|items|check|scenes|commandDefaults|entry|format|afterLoad|variables|saves|paths|build|languages|plugins)(?:\.[\w-]+|\[\d+\])*)/;

/**
 * 設定のファイル（liminalia.json、cast.json）の 1 行目に出した診断を、誤りのある項目の行へ移す（text はそのファイルの中身）。
 * 文の中の設定の道（`ui.window.padding`）、`@命令 の パラメータ`（commandDefaults）、使われない話者（cast.json の speakers の行）、
 * キャストの名前（cast.json）で探し、見つからなければ code の項目（CONFIG_SECTIONS）の行。どれも無ければそのまま。読めない JSON ならそのまま。
 */
export function placeConfigLines(diagnostics: readonly Diagnostic[], text: string, file: string): Diagnostic[] {
  let lines: Map<string, number> | null = null;
  const lineOf = (pointers: readonly string[]): number | undefined => {
    lines ??= jsonLines(text);
    for (const p of pointers) {
      const at = lines.get(p);
      if (at !== undefined) return at;
    }
    return undefined;
  };
  /** 道とその親（深いものから）。 */
  const prefixes = (pointer: string): string[] => {
    const parts = pointer.split("/").slice(1);
    return parts.map((_, i) => `/${parts.slice(0, parts.length - i).join("/")}`);
  };
  /** cast.json の speakers（使われない話者をその行へ移す。読めなければ空）。 */
  let speakers: readonly unknown[] | null = null;
  const speakerIndex = (name: string): number => {
    if (speakers === null) {
      const value: unknown = jsonSyntaxError(text) === null ? JSON.parse(stripBom(text)) : null;
      const list = value && typeof value === "object" ? (value as { speakers?: unknown }).speakers : undefined;
      speakers = Array.isArray(list) ? list : [];
    }
    return speakers.indexOf(name);
  };
  return diagnostics.map((d) => {
    if (d.file !== file || d.line !== 1) return d;
    const tries: string[] = [];
    // 使われない話者（flow-check.ts の unused-speaker）は speakers のその話者の行
    const speaker = d.code === "unused-speaker" ? UNUSED_SPEAKER.exec(d.message)?.[1] : undefined;
    if (speaker !== undefined && speakerIndex(speaker) >= 0) tries.push(`/speakers/${speakerIndex(speaker)}`);
    const path = CONFIG_PATH.exec(d.message)?.[1];
    if (path) tries.push(...prefixes(`/${path.replace(/\[(\d+)\]/g, ".$1").split(".").join("/")}`));
    const command = d.code === "bad-command-defaults" ? /@([a-z][a-z0-9-]*) の ([a-z][a-z0-9-]*)/.exec(d.message) : null;
    if (command) tries.push(`/commandDefaults/${command[1]}/${command[2]}`, `/commandDefaults/${command[1]}`);
    const who = d.cast?.who;
    if (who !== undefined) tries.push(`/cast/${who.replace(/~/g, "~0").replace(/\//g, "~1")}`);
    const section = CONFIG_SECTIONS[d.code];
    if (section) tries.push(...prefixes(section));
    const line = tries.length > 0 ? lineOf(tries) : undefined;
    return line !== undefined && line !== 1 ? { ...d, line } : d;
  });
}
