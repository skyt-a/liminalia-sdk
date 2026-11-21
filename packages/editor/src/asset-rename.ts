import { posix } from "node:path";
import { assetReferences, extraAssetReferences, itemAssetReferences, projectMacros, resolveCssReference, uiAssetReferences, type ExtraConfig, type Registry, type Script, type UiConfig } from "@liminalia/lang";
import { assetTextUses, type AssetTextSource } from "@liminalia/project/asset-uses";
import type { AssetUse } from "./protocol.ts";

/**
 * 素材の名前の変更のうち、ファイルを読み書きせずに決めるもの（作品の CSS の書き換えと、手で直す所）。
 * lim rename asset と制作画面（manage.ts の renameAsset）と、VS Code の F2（packages/vscode の rename.ts）が同じものを使う。
 * 台本は name-rename.ts の rewriteAssetInScript、訳文は rewriteInlineAssets で書き換える（どちらも作品のマクロの仕様 projectMacros を渡す）。
 */

/** 素材の名前の比べ方（濁点などの合成の違いは同じとみなす）。 */
const nfc = (path: string) => path.normalize("NFC");

/** 名前の変更で url() と @import を書き換える作品の CSS か（@liminalia/project の assetTextFiles の css のうち、.css のもの）。 */
export function isRenamedCss(source: AssetTextSource, file: string): boolean {
  return source === "css" && /\.css$/i.test(file);
}

/**
 * CSS の url() と @import "…" のうち、素材のフォルダ kindDir（作品のフォルダからのパス）の中の moves の素材を指すものを、新しい名前にした CSS。
 * CSS のファイル（cssFile。作品のフォルダからのパス）からの相対の URL で書き、引用符はもとの書き方のまま（空白などがあれば " で囲む）。
 */
export function renameCssAssets(text: string, cssFile: string, kindDir: string, moves: ReadonlyMap<string, string>): string {
  const to = new Map([...moves].map(([a, b]) => [nfc(a), b]));
  const swap = (value: string): string | null => {
    const r = resolveCssReference(cssFile, value);
    if (!("path" in r) || !r.path.startsWith(`${kindDir}/`)) return null;
    const next = to.get(nfc(r.path.slice(kindDir.length + 1)));
    if (next === undefined) return null;
    const dir = cssFile.includes("/") ? cssFile.slice(0, cssFile.lastIndexOf("/")) : "";
    return posix.relative(dir, `${kindDir}/${next}`);
  };
  const quoted = (q: string, url: string) => (q === "" && /[\s"'()\\]/.test(url) ? JSON.stringify(url) : `${q}${url}${q}`);
  return text
    .replace(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi, (m, q: string, value: string) => {
      const url = swap(value);
      return url === null ? m : `url(${quoted(q, url)})`;
    })
    .replace(/@import\s+(["'])([^"']*)\1/gi, (m, q: string, value: string) => {
      const url = swap(value);
      return url === null ? m : `@import ${q}${url}${q}`;
    });
}

/** 名前を書き換えたあとの作品（手で直す所を探すもの）。 */
export interface AssetRenameAfter {
  /** 台本（シナリオの名前、中身、構文）。 */
  scenarios: readonly { file: string; text: string; script: Script }[];
  /** 台本の中で書き換えられなかった参照の行（rewriteAssetInScript の left）。 */
  scriptLeft: readonly { file: string; line: number }[];
  /** liminalia.json。 */
  config: { extra?: unknown; items?: unknown; ui?: unknown };
  /** 名前を文字として探すファイル（@liminalia/project の assetTextFiles。where は作品のフォルダからのパスで、作品の外のものは絶対パス）。 */
  texts: readonly { where: string; text: string; source: AssetTextSource }[];
}

const sameUse = (a: AssetUse, b: AssetUse) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 素材の名前の変更で、書き換えられずに手で直す所（書き換えたあとの中身で探す）。台本の書き換えられなかった参照、
 * liminalia.json の ui・extra・items に残った参照、前の名前が文字として出てくる所（式に渡す文字、データ、訳、テンプレート、プラグインなど）の順。
 */
export function assetRenameLeft(after: AssetRenameAfter, commands: Registry, kind: string, moves: ReadonlyMap<string, string>): AssetUse[] {
  const left: AssetUse[] = after.scriptLeft.map((l) => ({ in: "script", file: l.file, line: l.line }));
  const config = [...extraAssetReferences(after.config.extra as ExtraConfig | undefined), ...itemAssetReferences(after.config.items), ...uiAssetReferences(after.config.ui as UiConfig | undefined)];
  for (const r of config) if (r.folder === kind && moves.has(r.path)) left.push({ in: "config", where: r.where });
  for (const use of leftAssetMentions(after, commands, kind, moves)) if (!left.some((l) => sameUse(l, use))) left.push(use);
  return left;
}

/**
 * 名前を替えたあとにも、前の名前が文字として出てくる所（台本は行、ほかは作品のフォルダからのパスと行）。探す所は lim unused と同じ
 * （@liminalia/project の assetTextFiles）。名前が替わったものは前の名前（拡張子つきか拡張子なし）、フォルダだけを替えたものは前のパスで探す。
 */
function leftAssetMentions(after: AssetRenameAfter, commands: Registry, kind: string, moves: ReadonlyMap<string, string>): AssetUse[] {
  const names = new Set(after.scenarios.map((s) => s.file));
  // 台本の、素材を参照する行（このフォルダの参照は書き換え済みか left にある。ほかのフォルダの同じ名前の素材の行は挙げない）
  const macros = projectMacros(after.scenarios.map((s) => [s.file, s.script] as const));
  const refLines = new Map(after.scenarios.map((s) => [s.file, new Set(assetReferences(s.script, commands, macros).map((r) => r.line))]));
  // liminalia.json と cast.json は構文で書き換える（ほかの所に出てくる名前は、ほかのフォルダの同じ名前の素材のことが多いので挙げない）
  const texts = [...after.scenarios.map((s) => ({ where: s.file, text: s.text })), ...after.texts.filter((t) => !["scenario", "theme", "config", "cast"].includes(t.source))];
  const out: AssetUse[] = [];
  const add = (where: string, line: number) => {
    if (refLines.get(where)?.has(line)) return;
    const use: AssetUse = names.has(where) ? { in: "script", file: where, line } : { in: "text", where, line, scenario: false };
    if (!out.some((u) => sameUse(u, use))) out.push(use);
  };
  const renamed = [...moves].filter(([a, b]) => posix.basename(a) !== posix.basename(b)).map(([a]) => ({ folder: kind, path: a }));
  for (const uses of assetTextUses(texts, renamed).values()) for (const u of uses) if (u.how === "name") add(u.where, u.line);
  const moved = [...moves].filter(([a, b]) => posix.basename(a) === posix.basename(b)).map(([a]) => nfc(a));
  if (moved.length > 0) {
    for (const t of texts) {
      const text = nfc(t.text);
      for (const old of moved) for (let i = text.indexOf(old); i >= 0; i = text.indexOf(old, i + 1)) add(t.where, text.slice(0, i).split("\n").length);
    }
  }
  return out;
}

/** 手で直す所の場所の書き方（lim rename asset の出力と、VS Code の知らせ）。 */
export function assetUsePlace(use: AssetUse): string {
  return use.in === "script" ? `${use.file}.lim:${use.line}` : use.in === "cast" ? `cast.json ${use.who}` : use.in === "text" ? `${use.where}:${use.line}` : `liminalia.json ${use.where}`;
}
