import { assetReferences, CHOICE_OPTION, isVariablePath, parse, parseTargetText, projectMacros, renameInData, renameVariableInLine, resolveTargetText, targetSitesOf, variableUses, type Cast, type CommandSpec, type Script, type TranslationFile, type VoiceLock } from "@liminalia/lang";
import { blockAt, commandSiteAt, namedArgs, optionSite, tokenAt, type Token } from "@liminalia/lang/line-syntax";
import { baselineRenames, jsonIndent, moveReviewThreads, moveVoiceLock, translationMoves, voiceLockMoves, type MovedLine } from "@liminalia/editor/label-follow";
import {
  assetSites,
  castNameProblem,
  castSites,
  macroNameProblem,
  macroSites,
  moveCastImages,
  moveTranslationEntries,
  renameInCast,
  renameStateAssets,
  renameStateCast,
  renameStateFile,
  renameStateVariable,
  renameTranslationFileKeys,
  renameTranslationSpeaker,
  renameVoiceLockFileKeys,
  renameVoiceLockSpeaker,
  rewriteAssetInScript,
  rewriteCastInScript,
  rewriteConfigAssets,
  rewriteConfigCast,
  rewriteConfigFile,
  rewriteConfigMacro,
  rewriteConfigVariable,
  rewriteFileInScript,
  rewriteInlineAssets,
  rewriteMacroInScript,
  rewriteSpeakerInScript,
  rewriteVariableInScript,
  speakerSites,
  variableSites,
  type NameSite,
  type ScriptRewrite,
} from "@liminalia/editor/name-rename";
import { targetVariables } from "@liminalia/editor/label-rename";
import { assetRenameLeft, assetUsePlace, isRenamedCss, renameCssAssets } from "@liminalia/editor/asset-rename";
import type { AssetUse, ReviewThread, StudioState } from "@liminalia/editor/protocol";
import type { AssetTextSource } from "@liminalia/project/asset-uses";
import type { Location, Position, Range, SymbolInformation, TextEdit, WorkspaceEdit } from "vscode-languageserver";
import { labelAt, renameLabelEdit, specOf, type Lang, type RenameFiles, type TextFile } from "./actions.ts";
import { walk, type LimProject } from "./model.ts";

/**
 * 名前の参照の一覧（参照の検索、⇧F12）・名前の変更（F2）・ワークスペースの記号（⌘T）。
 * 名前の種類はシーン（ラベル）、シナリオのファイル、マクロ（@define）、変数、キャラクター、話者、素材。
 * 書き換えは制作画面の名前の変更と同じもの（@liminalia/editor の name-rename.ts と label-rename.ts。lim rename も同じ）。
 */

const range = (line: number, start: number, end: number): Range => ({ start: { line, character: start }, end: { line, character: end } });
const SymbolKind = { File: 1, Function: 12, Key: 20 } as const;

/** カーソルの名前。range は名前の字面の範囲。 */
export type NameAt =
  | { kind: "label"; file: string; name: string; range: Range }
  | { kind: "file"; name: string; range: Range }
  | { kind: "macro"; name: string; range: Range }
  | { kind: "variable"; name: string; range: Range }
  | { kind: "cast"; name: string; range: Range }
  | { kind: "speaker"; name: string; range: Range }
  | { kind: "asset"; folder: string; name: string; range: Range };

const T = {
  nothing: { ja: "ここには名前を変えられるもの（シーン、ファイル、マクロ、変数、キャラクター、話者、素材）がありません", en: "There's nothing here to rename (a scene, file, macro, variable, character, speaker or asset)" },
  badVariable: { ja: (n: string) => `変数名は game.名前、system.名前、temp.名前 のどれかの形で指定します: ${n}`, en: (n: string) => `Give the variable as game.name, system.name or temp.name: ${n}` },
  variableTaken: { ja: (n: string) => `変数 ${n} はすでにあります`, en: (n: string) => `The variable ${n} already exists` },
  badName: { ja: (n: string) => `名前として使えません: ${n}`, en: (n: string) => `Not a usable name: ${n}` },
  castTaken: { ja: (n: string) => `キャラクター ${n} はすでにあります`, en: (n: string) => `The character ${n} already exists` },
  castMissing: { ja: (n: string) => `キャラクター ${n} は cast.json にありません`, en: (n: string) => `The character ${n} isn't in cast.json` },
  speakerTaken: { ja: (n: string) => `話者 ${n} はすでにあります`, en: (n: string) => `The speaker ${n} already exists` },
  macroTaken: { ja: (n: string) => `マクロ @${n} はすでにあります`, en: (n: string) => `The macro @${n} already exists` },
  macroTwice: { ja: (n: string) => `@define ${n} が二つ以上あります。先に一つにしてください`, en: (n: string) => `@define ${n} appears more than once. Keep only one first` },
  badFile: { ja: (n: string) => `シナリオの名前として使えません: ${n}`, en: (n: string) => `Not a usable script name: ${n}` },
  fileTaken: { ja: (n: string) => `${n}.lim はすでにあります`, en: (n: string) => `${n}.lim already exists` },
  badAsset: { ja: (n: string) => `素材の名前として使えません（同じ種類のフォルダの中のパスで、拡張子は変えません）: ${n}`, en: (n: string) => `Not a usable asset name (a path inside the same kind of folder, with the same extension): ${n}` },
  assetTaken: { ja: (n: string) => `${n} はすでにあります`, en: (n: string) => `${n} already exists` },
  assetMissing: { ja: (n: string) => `${n} がありません`, en: (n: string) => `${n} doesn't exist` },
  assetLeft: {
    ja: (n: number, list: string) => `書き換えられなかった参照が ${n} か所あります（式に渡す文字、データ、訳、テンプレート、プラグインの中など）。手で直してください: ${list}`,
    en: (n: number, list: string) => `${n} ${n === 1 ? "reference" : "references"} couldn't be rewritten (text passed to expressions, data, translations, templates, plugins and so on). Fix them by hand: ${list}`,
  },
  more: { ja: (n: number) => `ほか ${n} か所`, en: (n: number) => `and ${n} more` },
};

/** 素材の名前の変更で書き換えられなかった所（手で直す所）の知らせ。場所の書き方は lim rename asset の出力と同じで、limit か所まで並べる。 */
export function assetLeftMessage(left: readonly AssetUse[], lang: Lang, limit = 10): string {
  const places = left.slice(0, limit).map(assetUsePlace);
  if (left.length > limit) places.push(T.more[lang](left.length - limit));
  return T.assetLeft[lang](left.length, places.join(lang === "ja" ? "、" : ", "));
}

/** 名前の変更で、ファイルの名前を変えるのに使うもの（言語サーバーが作る）と、付け替える設定のファイル。 */
export interface NameRenameFiles extends RenameFiles {
  /** cast.json。 */
  cast?: TextFile;
  /** シナリオの名前 → .lim の URI。 */
  scenarioUri?: (name: string) => string;
  /** 素材のフォルダとパス → URI。 */
  assetUri?: (folder: string, path: string) => string;
  /** 素材があるか（素材の名前の変更で、新しい名前が空いているかを見る）。 */
  assetExists?: (folder: string, path: string) => boolean;
  /** 制作画面の変更履歴のフォルダ（.liminalia/history/<シナリオ>）の URI と、あるか。 */
  history?: { uri: (name: string) => string; has: (name: string) => boolean };
  /**
   * 素材の名前を文字として探すファイル（@liminalia/project の assetTextFiles）を読む。素材の名前の変更で、作品の CSS を書き換え、手で直す所を探す。
   * where は手で直す所の場所の名前（作品の外のものは絶対パス）、rel は作品のフォルダからのパス。
   */
  assetTexts?: () => readonly { source: AssetTextSource; where: string; rel: string; file: TextFile }[];
  /** 素材のフォルダ（作品のフォルダからのパス。CSS の url() を書き換える）。 */
  assetsDir?: string;
}

// ---- カーソルの名前 ----

function lookup(project: LimProject, file: string): (name: string) => CommandSpec | undefined {
  return (name) => specOf(project, file, name);
}

/** 作品のどこかの @define も見る仕様の引き方（キャラクターの型の引数を持つマクロも見るため）。 */
function projectSpecs(project: LimProject): (name: string) => CommandSpec | undefined {
  return (name) => project.registry.get(name) ?? project.findDefine(name)?.spec;
}

/** 引数の値の範囲（"…" で囲んでいれば中身）。 */
function valueOf(line: string, token: Token): { start: number; end: number; value: string } {
  const raw = line.slice(token.valueStart, token.end);
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return { start: token.valueStart + 1, end: token.end - 1, value: raw.slice(1, -1) };
  return { start: token.valueStart, end: token.end, value: raw };
}

/** カーソルにある名前（無ければ null）。 */
export function nameAt(project: LimProject, file: string, pos: Position): NameAt | null {
  const lines = project.lines(file);
  const line = lines[pos.line] ?? "";
  const offset = pos.character;
  const within = (start: number, end: number) => offset >= start && offset <= end;

  // シーン（ラベルの行の名前か、ジャンプ先のラベルの部分）
  const label = labelAt(project, file, pos);
  if (label && within(label.range.start.character, label.range.end.character)) return { kind: "label", file: label.file, name: label.label, range: label.range };

  const block = blockAt(lines, pos.line);
  // ジャンプ先のファイルの部分（@jump・@call・選択肢・ジャンプ先の型のパラメータ）
  for (const site of targetSitesOf(lines, pos.line, lookup(project, file))) {
    if (!within(site.start, site.end)) continue;
    const t = parseTargetText(site.text);
    if (!t?.file || !project.input.files.has(t.file)) continue;
    const at = line.indexOf(t.file, site.start);
    if (at >= 0 && within(at, at + t.file.length)) return { kind: "file", name: t.file, range: range(pos.line, at, at + t.file.length) };
  }

  const head = /^([ \t]*)@define[ \t]+([a-z][a-z0-9-]*)\(/.exec(line);
  if (head) {
    const start = line.indexOf(head[2]!, head[1]!.length + 7);
    if (within(start, start + head[2]!.length)) return { kind: "macro", name: head[2]!, range: range(pos.line, start, start + head[2]!.length) };
  }
  const site = commandSiteAt(line, offset, block);
  if (site) {
    if (within(site.nameStart, site.nameEnd)) {
      if (project.findDefine(site.name)) return { kind: "macro", name: site.name, range: range(pos.line, site.nameStart, site.nameEnd) };
    } else if (!site.inline && (site.name === "with" || site.name === "use")) {
      const t = site.args[0];
      if (t && within(t.start, t.end)) {
        if (site.name === "with" && project.findDefine(t.text)) return { kind: "macro", name: t.text, range: range(pos.line, t.start, t.end) };
        if (site.name === "use" && project.input.files.has(t.text)) return { kind: "file", name: t.text, range: range(pos.line, t.start, t.end) };
      }
    }
  }

  // 変数（式の中、@set、{= …}、変数の型のパラメータ）。その行で本当に変数として使っているものだけ
  const pattern = /(?<![\p{ID_Continue}_.])(?:game|system|temp)\.[\p{ID_Start}_][\p{ID_Continue}_]*/gu;
  for (const m of line.matchAll(pattern)) {
    if (!within(m.index!, m.index! + m[0].length)) continue;
    const script = project.script(file);
    if (script && variableUses(script, project.registry).some((u) => u.line === pos.line + 1 && u.path === m[0])) return { kind: "variable", name: m[0], range: range(pos.line, m.index!, m.index! + m[0].length) };
  }

  // キャラクターと素材（パラメータの値）
  const args = site && !within(site.at, site.nameEnd) ? { spec: lookup(project, file)(site.name), tokens: site.args } : block === "choice" ? { spec: CHOICE_OPTION, tokens: optionSite(line)?.args ?? [] } : null;
  const token = args?.spec ? tokenAt(args.tokens, offset) : null;
  if (args?.spec && token) {
    const spec = args.spec;
    const given = namedArgs(args.tokens, spec.positional);
    const param = [...given].find(([, v]) => v.token === token)?.[0];
    const type = param !== undefined ? spec.params[param]?.type : undefined;
    const v = valueOf(line, token);
    if (type?.kind === "cast" && within(v.start, v.end) && v.value in project.input.cast) return { kind: "cast", name: v.value, range: range(pos.line, v.start, v.end) };
    if (type?.kind === "asset" && within(v.start, v.end) && v.value !== "" && !v.value.startsWith("(")) {
      const folder = "folder" in spec.params ? (given.get("folder")?.value ?? type.folder) : type.folder;
      return { kind: "asset", folder, name: v.value, range: range(pos.line, v.start, v.end) };
    }
  }
  // 本文の中の画像 {img …}
  for (const m of line.matchAll(/\{img[ \t]+([^}\s]+)/g)) {
    const start = m.index! + m[0].length - m[1]!.length;
    if (within(start, start + m[1]!.length)) return { kind: "asset", folder: "image", name: m[1]!, range: range(pos.line, start, start + m[1]!.length) };
  }
  // 行の字面からは命令の引数として読めない素材の参照（@with のマクロの引数、@html の中身の <img src>）。参照の集め方は
  // lim rename asset と制作画面と同じ（assetReferences）。桁は引数かパスの頭なので、そこから字面を探す
  const here = project.script(file);
  if (here) {
    for (const r of assetReferences(here, project.registry, projectMacros(project.scripts()))) {
      if (r.line !== pos.line + 1 || (r.form !== "with" && r.form !== "html-image")) continue;
      const at = line.indexOf(r.path, Math.max(0, r.column - 1));
      if (at >= 0 && within(at, at + r.path.length)) return { kind: "asset", folder: r.folder, name: r.path, range: range(pos.line, at, at + r.path.length) };
    }
  }

  // 台詞の話者
  const script = project.script(file);
  let speaker: NameAt | null = null;
  if (script) {
    walk(script.body, (s) => {
      if (speaker || s.kind !== "say" || s.line !== pos.line + 1) return;
      const lead = /^\s*/.exec(line)![0].length;
      if (line.startsWith(s.speaker, lead) && within(lead, lead + s.speaker.length)) speaker = { kind: "speaker", name: s.speaker, range: range(pos.line, lead, lead + s.speaker.length) };
    });
  }
  return speaker;
}

// ---- 参照の一覧 ----

function locations(project: LimProject, file: string, sites: readonly NameSite[]): Location[] {
  const uri = project.input.files.get(file)!.uri;
  return sites.map((s) => ({ uri, range: range(s.line - 1, s.start, s.end) }));
}

/** 名前の参照の一覧（includeDeclaration なら、ラベルの行・@define の行・ファイルの頭も）。 */
export function references(project: LimProject, file: string, pos: Position, includeDeclaration = true): Location[] {
  const at = nameAt(project, file, pos);
  if (!at) return [];
  const out: Location[] = [];
  const files = [...project.input.files.keys()].sort();
  const text = (f: string) => project.input.files.get(f)!.text;
  const targetFiles = { has: (f: string) => project.input.files.has(f), labels: (f: string) => project.labels(f) };
  switch (at.kind) {
    case "label":
    case "file": {
      if (includeDeclaration) {
        if (at.kind === "label") {
          const l = project.labels(at.file).find((x) => x.name === at.name);
          if (l) {
            const t = project.lines(at.file)[l.line - 1] ?? "";
            const c = t.indexOf(at.name, t.indexOf("#"));
            out.push({ uri: project.input.files.get(at.file)!.uri, range: range(l.line - 1, Math.max(0, c), Math.max(0, c) + at.name.length) });
          }
        } else out.push({ uri: project.input.files.get(at.name)!.uri, range: range(0, 0, 0) });
      }
      for (const f of files) {
        const lines = project.lines(f);
        const specs = lookup(project, f);
        lines.forEach((line, i) => {
          if (!line.includes(at.name)) return;
          for (const site of targetSitesOf(lines, i, specs)) {
            const place = resolveTargetText(site.text, f, targetFiles);
            const t = parseTargetText(site.text);
            if (!place || !t) continue;
            if (at.kind === "label" && place.file === at.file && place.label === at.name) {
              const c = line.indexOf(`#${at.name}`, site.start);
              if (c >= 0) out.push({ uri: project.input.files.get(f)!.uri, range: range(i, c + 1, c + 1 + at.name.length) });
            } else if (at.kind === "file" && t.file === at.name) {
              const c = line.indexOf(at.name, site.start);
              if (c >= 0) out.push({ uri: project.input.files.get(f)!.uri, range: range(i, c, c + at.name.length) });
            }
          }
        });
        if (at.kind === "file") {
          const script = project.script(f);
          for (const s of script?.body ?? []) {
            if (s.kind !== "use" || s.file !== at.name) continue;
            const line = lines[s.line - 1] ?? "";
            const c = line.indexOf(at.name, line.indexOf("@use") + 4);
            if (c >= 0) out.push({ uri: project.input.files.get(f)!.uri, range: range(s.line - 1, c, c + at.name.length) });
          }
        }
      }
      return out;
    }
    case "macro":
      for (const f of files) {
        const sites = macroSites(text(f), project.script(f)!, at.name);
        const own = project.defines(f).find((d) => d.name === at.name);
        out.push(...locations(project, f, includeDeclaration || !own ? sites : sites.filter((s) => s.line !== own.line)));
      }
      return out;
    case "variable":
      for (const f of files) out.push(...locations(project, f, variableSites(text(f), project.script(f)!, project.registry, at.name)));
      return out;
    case "cast":
      for (const f of files) out.push(...locations(project, f, castSites(text(f), project.script(f)!, projectSpecs(project), at.name)));
      return out;
    case "speaker":
      for (const f of files) out.push(...locations(project, f, speakerSites(text(f), project.script(f)!, at.name)));
      return out;
    case "asset":
      for (const f of files) out.push(...locations(project, f, assetSites(text(f), project.script(f)!, project.registry, at.folder, at.name)));
      return out;
  }
}

// ---- ワークスペースの記号 ----

/** 作品のすべてのシナリオのシーン（ラベル）と @define（query を名前に含むもの。大文字と小文字は区別しない）。 */
export function workspaceSymbols(project: LimProject, query: string): SymbolInformation[] {
  const q = query.toLowerCase();
  const out: SymbolInformation[] = [];
  for (const f of [...project.input.files.keys()].sort()) {
    const uri = project.input.files.get(f)!.uri;
    const lines = project.lines(f);
    for (const l of project.labels(f)) {
      if (q && !l.name.toLowerCase().includes(q) && !`${f}#${l.name}`.toLowerCase().includes(q)) continue;
      const t = lines[l.line - 1] ?? "";
      const c = Math.max(0, t.indexOf(l.name, t.indexOf("#")));
      out.push({ name: `# ${l.name}`, kind: SymbolKind.Key, location: { uri, range: range(l.line - 1, c, c + l.name.length) }, containerName: f });
    }
    for (const d of project.defines(f)) {
      if (q && !d.name.toLowerCase().includes(q)) continue;
      const t = lines[d.line - 1] ?? "";
      const c = Math.max(0, t.indexOf(d.name));
      out.push({ name: `@${d.name}`, kind: SymbolKind.Function, location: { uri, range: range(d.line - 1, c, c + d.name.length) }, containerName: f });
    }
  }
  return out;
}

// ---- 名前の変更 ----

/** 名前を変える前の準備（名前の範囲と、今の名前）。 */
export function prepareRename(project: LimProject, file: string, pos: Position): { range: Range; placeholder: string } | null {
  const at = nameAt(project, file, pos);
  return at ? { range: at.range, placeholder: at.name } : null;
}

function readJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

const json = (value: unknown, indent: string | number = 2) => `${JSON.stringify(value, null, indent)}\n`;

function whole(text: string, newText: string): TextEdit {
  const lines = text.split("\n");
  return { range: { start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: lines.at(-1)!.length } }, newText };
}

/** 編集を集めるもの。台本は書き換えた行だけを置き換え、設定のファイルは全体を書き直す。 */
class EditBuilder {
  changes: Record<string, TextEdit[]> = {};
  renames: { oldUri: string; newUri: string }[] = [];
  /** 書き換えたファイルの、編集を当てたあとの中身（URI → 中身）。 */
  after = new Map<string, string>();

  script(uri: string, before: string, r: ScriptRewrite): void {
    if (r.changed.length === 0) return;
    const old = before.split("\n");
    const next = r.text.split("\n");
    this.changes[uri] = [...(this.changes[uri] ?? []), ...r.changed.map((n) => ({ range: range(n - 1, 0, (old[n - 1] ?? "").length), newText: next[n - 1] ?? "" }))];
    this.after.set(uri, r.text);
  }

  put(f: TextFile | undefined, next: string | null): void {
    if (f && next !== null && next !== f.text) {
      this.changes[f.uri] = [whole(f.text, next)];
      this.after.set(f.uri, next);
    }
  }

  /** ファイルの、編集を当てたあとの中身（書き換えなければ今の中身）。 */
  textOf(f: TextFile): string {
    return this.after.get(f.uri) ?? f.text;
  }

  /** JSON を読み、mutate が新しい値を返せば書き直す（読めないファイルは書き換えない）。 */
  json<T>(f: TextFile | undefined, mutate: (value: T) => T | null): void {
    if (!f) return;
    const raw = readJson<T>(f.text);
    if (raw === null) return;
    const next = mutate(raw);
    if (next !== null) this.put(f, `${JSON.stringify(next, null, jsonIndent(f.text))}${f.text.endsWith("\n") ? "\n" : ""}`);
  }

  edit(): WorkspaceEdit {
    if (this.renames.length === 0) return { changes: this.changes };
    // ファイルの名前の変更があるときは documentChanges で（古い名前のファイルへの編集を先に、名前の変更を後に）
    return {
      documentChanges: [
        ...Object.entries(this.changes).map(([uri, edits]) => ({ textDocument: { uri, version: null }, edits })),
        ...this.renames.map((r) => ({ kind: "rename" as const, oldUri: r.oldUri, newUri: r.newUri, options: { ignoreIfExists: true } })),
      ],
    };
  }
}

/** 台本を書き換え、本文を書き換えた行の訳の鍵と voice-lock.json の鍵を付け替える（rewrite は訳文の書き換え）。 */
function rewriteScripts(project: LimProject, b: EditBuilder, files: NameRenameFiles, change: (text: string, script: Script, name: string) => ScriptRewrite, rewrite: ((text: string) => string) | null): MovedLine[] {
  const scripts = project.scripts();
  const after = new Map(scripts);
  const moved: MovedLine[] = [];
  for (const [name, script] of scripts) {
    const source = project.input.files.get(name)!;
    const r = change(source.text, script, name);
    if (r.changed.length === 0) continue;
    b.script(source.uri, source.text, r);
    after.set(name, parse(r.text, name, { speakers: project.input.speakers }));
    const old = source.text.split("\n");
    const next = r.text.split("\n");
    moved.push(...r.changed.map((line) => ({ file: name, line, before: old[line - 1] ?? "", after: next[line - 1] ?? "" })));
  }
  if (rewrite) {
    const moves = translationMoves(scripts, after);
    for (const f of files.translations ?? []) b.json<TranslationFile>(f, (t) => moveTranslationEntries(t, moves, rewrite));
    b.json<VoiceLock>(files.voiceLock, (lock) => moveVoiceLock(lock, voiceLockMoves(scripts, after)));
  }
  // 書き換えた行に付いたレビューのスレッド
  const reviews = (files.reviews ?? []).flatMap((f) => {
    const raw = readJson<ReviewThread>(f.text);
    return raw && typeof raw.id === "string" && typeof raw.file === "string" && typeof raw.line === "number" && typeof raw.text === "string" ? [{ f, raw }] : [];
  });
  for (const next of moveReviewThreads(reviews.map((r) => r.raw), moved)) b.put(reviews.find((r) => r.raw.id === next.id)!.f, json(next));
  return moved;
}

/** 作品のデータ（プラグインが形を宣言したもの）の中の名前を替える。 */
function renameData(b: EditBuilder, files: NameRenameFiles, change: Parameters<typeof renameInData>[2]): void {
  for (const { decl, file: f } of files.data ?? []) {
    const raw = readJson<unknown>(f.text);
    if (raw === null) continue;
    const r = renameInData(decl, raw, change);
    if (r.count > 0) b.put(f, `${JSON.stringify(r.value, null, jsonIndent(f.text))}${f.text.endsWith("\n") ? "\n" : ""}`);
  }
}

/**
 * カーソルの名前を to に変える編集（制作画面の名前の変更と、lim rename と同じ書き換え）。シーンは renameLabelEdit。
 * 台本は変えた行だけを置き換え、liminalia.json・cast.json・訳・voice-lock.json・レビュー・制作画面の覚え書き・作品のデータは全体を書き直し、
 * シナリオのファイルと素材はファイルの名前も変える。素材は作品の CSS も書き換え、書き換えられなかった所（手で直す所）を left に返す。
 */
export function renameEdit(project: LimProject, file: string, pos: Position, to: string, lang: Lang, files: NameRenameFiles = {}): { edit: WorkspaceEdit; left?: AssetUse[] } | { error: string } {
  const at = nameAt(project, file, pos);
  if (!at) return { error: T.nothing[lang] };
  if (at.kind === "label") return renameLabelEdit(project, file, pos, to, lang, files);
  const b = new EditBuilder();
  if (to === at.name) return { edit: b.edit() };
  const from = at.name;
  const config = <T extends Record<string, unknown>>(mutate: (raw: T) => boolean) => b.json<T>(files.config, (raw) => (mutate(raw) ? raw : null));
  const studioState = (mutate: (st: StudioState) => StudioState | null) => b.json<StudioState>(files.studioState, mutate);
  switch (at.kind) {
    case "variable": {
      if (!isVariablePath(to)) return { error: T.badVariable[lang](to) };
      const used = new Set([...project.scripts().values()].flatMap((s) => variableUses(s, project.registry).map((u) => u.path)));
      const initial = project.input.config?.variables;
      if (used.has(to) || (initial && typeof initial === "object" && to in initial)) return { error: T.variableTaken[lang](to) };
      rewriteScripts(project, b, files, (text, script) => rewriteVariableInScript(text, script, project.registry, from, to), (t) => renameVariableInLine(t, from, to));
      config((raw) => rewriteConfigVariable(raw, from, to));
      studioState((st) => renameStateVariable(st, from, to));
      renameData(b, files, { kind: "variable", from, to });
      return { edit: b.edit() };
    }
    case "cast": {
      if (castNameProblem(to)) return { error: T.badName[lang](to) };
      if (to in project.input.cast) return { error: T.castTaken[lang](to) };
      if (!(from in project.input.cast)) return { error: T.castMissing[lang](from) };
      rewriteScripts(project, b, files, (text, script) => rewriteCastInScript(text, script, projectSpecs(project), from, to), (t) => t);
      b.json<{ speakers?: string[]; cast?: Cast }>(files.cast, (raw) => {
        const file = { speakers: [...(raw.speakers ?? [])] };
        const cast = structuredClone(raw.cast ?? {});
        renameInCast(cast, file, "cast", from, to);
        return { ...raw, cast };
      });
      studioState((st) => renameStateCast(st, from, to));
      config((raw) => rewriteConfigCast(raw, from, to));
      renameData(b, files, { kind: "cast", from, to });
      return { edit: b.edit() };
    }
    case "speaker": {
      if (castNameProblem(to)) return { error: T.badName[lang](to) };
      if (project.input.speakers.includes(to)) return { error: T.speakerTaken[lang](to) };
      const scripts = project.scripts();
      const after = new Map(scripts);
      rewriteScripts(
        project,
        b,
        files,
        (text, script, name) => {
          const r = rewriteSpeakerInScript(text, script, from, to);
          if (r.changed.length > 0) after.set(name, parse(r.text, name, { speakers: project.input.speakers.map((s) => (s === from ? to : s)) }));
          return r;
        },
        null,
      );
      b.json<{ speakers?: string[]; cast?: Cast }>(files.cast, (raw) => {
        const file = { speakers: [...(raw.speakers ?? [])] };
        const cast = structuredClone(raw.cast ?? {});
        renameInCast(cast, file, "speaker", from, to);
        return { ...raw, speakers: file.speakers, cast };
      });
      for (const f of files.translations ?? []) b.json<TranslationFile>(f, (t) => renameTranslationSpeaker(t, from, to));
      // 台詞の鍵は話者と原文から作るので、voice-lock.json の番号を新しい鍵へ付け替え、話者も書き換える
      b.json<VoiceLock>(files.voiceLock, (lock) => renameVoiceLockSpeaker(moveVoiceLock(lock, voiceLockMoves(scripts, after)) ?? lock, from, to));
      return { edit: b.edit() };
    }
    case "macro": {
      const problem = macroNameProblem(to, project.registry);
      if (problem) return { error: lang === "en" ? englishMacroProblem(to, project.registry) : problem };
      const defines = [...project.input.files.keys()].flatMap((f) => project.defines(f).filter((d) => d.name === from));
      if (defines.length > 1) return { error: T.macroTwice[lang](from) };
      if (project.findDefine(to)) return { error: T.macroTaken[lang](to) };
      const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      rewriteScripts(project, b, files, (text, script) => rewriteMacroInScript(text, script, from, to), (t) => t.replace(new RegExp(`\\{@${esc}(?=[\\s}])`, "g"), `{@${to}`));
      config((raw) => rewriteConfigMacro(raw, from, to));
      return { edit: b.edit() };
    }
    case "file": {
      const name = to.replace(/\\/g, "/").replace(/\.lim$/, "");
      if (name === "" || name.split("/").some((p) => p === "" || p === "." || p === ".." || p.startsWith(".")) || /[\0:*?"<>|]/.test(name)) return { error: T.badFile[lang](to) };
      if (project.input.files.has(name)) return { error: T.fileTaken[lang](name) };
      const specs = projectSpecs(project);
      rewriteScripts(project, b, files, (text, script) => rewriteFileInScript(text, script, specs, from, name), null);
      const variables = targetVariables(project.scripts().values());
      config((raw) => rewriteConfigFile(raw, from, name, variables).length > 0);
      for (const f of files.translations ?? []) b.json<TranslationFile>(f, (t) => renameTranslationFileKeys(t, from, name));
      b.json<VoiceLock>(files.voiceLock, (lock) => renameVoiceLockFileKeys(lock, from, name));
      for (const f of files.reviews ?? []) b.json<ReviewThread>(f, (t) => (t.file === from ? { ...t, file: name } : null));
      studioState((st) => renameStateFile(st, from, name));
      renameData(b, files, { kind: "file", from, to: name });
      if (files.scenarioUri) b.renames.push({ oldUri: files.scenarioUri(from), newUri: files.scenarioUri(name) });
      if (files.history?.has(from) && !files.history.has(name)) b.renames.push({ oldUri: files.history.uri(from), newUri: files.history.uri(name) });
      if (files.baselines) {
        for (const l of project.labels(from)) {
          for (const [a, c] of baselineRenames(files.baselines.names, { file: from, from: l.name, to: l.name, toFile: name })) {
            b.renames.push({ oldUri: `${files.baselines.folder}/${encodeURIComponent(a)}`, newUri: `${files.baselines.folder}/${encodeURIComponent(c)}` });
          }
        }
      }
      return { edit: b.edit() };
    }
    case "asset":
      return renameAssetEdit(project, at.folder, at.name, to, lang, files);
  }
}

/**
 * 素材 folder/from の名前を to（同じ種類のフォルダの中のパス。folder/ を付けてもよい）に変える編集（lim rename asset と制作画面の名前の変更と同じ書き換え）。
 * left は書き換えられなかった参照（手で直す所）。
 */
export function renameAssetEdit(project: LimProject, folder: string, from: string, to: string, lang: Lang, files: NameRenameFiles = {}): { edit: WorkspaceEdit; left: AssetUse[] } | { error: string } {
  const b = new EditBuilder();
  const config = <T extends Record<string, unknown>>(mutate: (raw: T) => boolean) => b.json<T>(files.config, (raw) => (mutate(raw) ? raw : null));
  const studioState = (mutate: (st: StudioState) => StudioState | null) => b.json<StudioState>(files.studioState, mutate);
  const next = to.startsWith(`${folder}/`) ? to.slice(folder.length + 1) : to;
  if (next === from) return { edit: b.edit(), left: [] };
  const ext = (p: string) => /\.[^./]*$/.exec(p)?.[0]?.toLowerCase() ?? "";
  if (next === "" || next.split("/").some((p) => p === "" || p === "." || p === ".." || p.startsWith(".")) || /[\\\0:*?"<>|]/.test(next) || ext(next) !== ext(from)) return { error: T.badAsset[lang](to) };
  if (files.assetExists && !files.assetExists(folder, from)) return { error: T.assetMissing[lang](`${folder}/${from}`) };
  if (files.assetExists?.(folder, next)) return { error: T.assetTaken[lang](`${folder}/${next}`) };
  const moves = new Map([[from, next]]);
  // 台本はマクロ（@define）の素材の型の引数も、訳文は本文の中の命令と {img …} も書き換える（lim rename asset と同じ）
  const macros = projectMacros(project.scripts());
  const scriptLeft: { file: string; line: number }[] = [];
  const scenarios = new Map([...project.scripts()].map(([file, script]) => [file, { file, text: project.input.files.get(file)!.text, script }]));
  rewriteScripts(
    project,
    b,
    files,
    (text, script, name) => {
      const r = rewriteAssetInScript(text, script, project.registry, folder, moves, macros);
      for (const line of r.left) scriptLeft.push({ file: name, line });
      if (r.changed.length > 0) scenarios.set(name, { file: name, text: r.text, script: parse(r.text, name, { speakers: project.input.speakers }) });
      return r;
    },
    (t) => rewriteInlineAssets(t, project.registry, folder, moves, macros) ?? t,
  );
  if (folder === "fgimage") {
    b.json<{ cast?: Cast }>(files.cast, (raw) => {
      const cast = structuredClone(raw.cast ?? {});
      return moveCastImages(cast, moves) ? { ...raw, cast } : null;
    });
    studioState((st) => renameStateAssets(st, moves));
  }
  config((raw) => rewriteConfigAssets(raw, folder, moves).length > 0);
  renameData(b, files, { kind: "asset", folder, from, to: next });
  // 作品の CSS（ui.css とそのフォルダ）の url() と @import
  const kindDir = `${files.assetsDir ?? "assets"}/${folder}`;
  const assetTexts = files.assetTexts?.() ?? [];
  for (const t of assetTexts) if (isRenamedCss(t.source, t.rel)) b.put(t.file, renameCssAssets(t.file.text, t.rel, kindDir, moves));
  // 手で直す所（書き換えたあとの中身で探す）
  const left = assetRenameLeft(
    {
      scenarios: [...scenarios.values()],
      scriptLeft,
      config: (files.config && readJson<Record<string, unknown>>(b.textOf(files.config))) || {},
      texts: assetTexts.map((t) => ({ where: t.where, text: b.textOf(t.file), source: t.source })),
    },
    project.registry,
    folder,
    moves,
  );
  if (files.assetUri) b.renames.push({ oldUri: files.assetUri(folder, from), newUri: files.assetUri(folder, next) });
  return { edit: b.edit(), left };
}

/** マクロの名前に使えない理由の英語。 */
function englishMacroProblem(name: string, commands: { has(name: string): boolean }): string {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return `Macro names can use only lowercase letters, digits and - (starting with a lowercase letter): ${name}`;
  if (commands.has(name)) return `@${name} has the same name as a built-in or plugin command`;
  return `@${name} is a keyword of the script syntax, so it can't be a macro name`;
}
