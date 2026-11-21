import type { Diagnostic } from "./ast.ts";
import type { UiConfig } from "./ui.ts";

/**
 * 書体のファイル（.ttf・.otf・.woff・.woff2）が持つ表の名前（"cmap"・"vmtx" など）。中身は読まない。
 * 読めない形（書体の集まり .ttc など）・壊れたものは null。
 */
export function fontTables(data: Uint8Array): Set<string> | null {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tag = (at: number) => String.fromCharCode(data[at]!, data[at + 1]!, data[at + 2]!, data[at + 3]!);
  try {
    const sig = v.getUint32(0);
    if (sig === 0x00010000 || tag(0) === "OTTO" || tag(0) === "true") return sfnt(v, tag, 4, 12, 16);
    if (tag(0) === "wOFF") return sfnt(v, tag, 12, 44, 20);
    if (tag(0) === "wOF2") return woff2(data, v, tag);
  } catch {
    // 途中で切れている
  }
  return null;
}

function sfnt(v: DataView, tag: (at: number) => string, countAt: number, dirAt: number, entry: number): Set<string> {
  const out = new Set<string>();
  const n = v.getUint16(countAt);
  if (dirAt + n * entry > v.byteLength) throw new Error("truncated");
  for (let i = 0; i < n; i++) out.add(tag(dirAt + i * entry));
  return out;
}

/** WOFF2 の表の並び（名前は既知の表なら番号で書かれる）。 */
const WOFF2_KNOWN: Record<number, string> = { 10: "glyf", 11: "loca", 23: "vhea", 24: "vmtx" };

function woff2(data: Uint8Array, v: DataView, tag: (at: number) => string): Set<string> {
  const out = new Set<string>();
  const n = v.getUint16(12);
  let at = 48;
  const base128 = () => {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const b = data[at++]!;
      value = value * 128 + (b & 0x7f);
      if ((b & 0x80) === 0) return value;
    }
    throw new Error("bad UIntBase128");
  };
  for (let i = 0; i < n; i++) {
    const flags = data[at++]!;
    const index = flags & 0x3f;
    let name: string;
    if (index === 63) {
      name = tag(at);
      at += 4;
    } else {
      name = WOFF2_KNOWN[index] ?? `#${index}`;
    }
    base128();
    // 変形の版: glyf・loca は 0 が変形あり、ほかは 0 以外が変形あり（変形したものは長さがもう一つ続く）
    const version = flags >> 6;
    if ((name === "glyf" || name === "loca") === (version === 0)) base128();
    out.add(name);
  }
  if (at > data.length) throw new Error("truncated");
  return out;
}

/**
 * 縦書きで使う本文の書体（ui.text.fontFile）が、縦書きの字送り幅（vmtx）を持たなければ警告する。持たない書体は縦の送りが
 * 書体の上下の高さになり、1em からずれる（一行の字数 ui.text.lineChars・ルビの位置がずれる）。
 * 縦書きを使うのは ui.message.vertical か、台本に @vertical on があるとき。OS の書体（fontFile を書いていない）は、遊ぶ端末で変わるので見ない。
 * read は others の中のファイルの中身（無ければ null）。
 */
export function checkVerticalFont(ui: UiConfig | undefined, sources: Iterable<string>, read: (file: string) => Uint8Array | null): Diagnostic[] {
  const file = ui?.text?.fontFile;
  if (!file) return [];
  let vertical = ui?.message?.vertical === true;
  if (!vertical) {
    for (const source of sources) {
      if (/^[ \t]*@vertical[ \t]+(mode=)?on\b/m.test(source)) {
        vertical = true;
        break;
      }
    }
  }
  if (!vertical) return [];
  const data = read(file);
  const tables = data && fontTables(data);
  if (!tables || tables.has("vmtx")) return [];
  return [
    {
      severity: "warning",
      code: "font-no-vertical-metrics",
      message: `本文のフォント ${file} は縦書きの字送り幅（vmtx）を持たないため、縦書きで一文字の送りが 1em からずれます（ui.text.lineChars の文字数とルビの位置がずれます）`,
      file: "liminalia.json",
      line: 1,
      hint: "縦書きに対応したフォント（Noto Serif CJK、源ノ明朝など）を使います",
    },
  ];
}
