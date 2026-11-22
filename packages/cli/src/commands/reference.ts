import { writeFileSync } from "node:fs";
import { STD_IMPORT, tagsByCommand, type TyranoImportProfile } from "@liminalia/ks-import";
import { applyCommandDefaults, CHOICE_BLOCK, CHOICE_OPTION, commandExample, commandSummary, CORE_COMMANDS, FUNCTION_ARITY, FUNCTION_DOCS, FUNCTION_DOCS_EN, FUNCTION_USAGE, FUNCTION_USAGE_EN, paramDoc, type CommandSpec, type ParamType } from "@liminalia/lang";
import { loadProject, pluginEntry, STD_PLUGIN } from "@liminalia/project";
import { toSpec, type CommandPlugin } from "@liminalia/plugin-host";
import { pathToFileURL } from "node:url";
import { loadPluginImports } from "../context.ts";

/**
 * lim reference [プロジェクト] [--json] [--lang en] [--out ファイル] — 命令のリファレンスを出す。
 * 仕様の正本（組み込みのレジストリとプラグインの命令の表）から作るので、実装と食い違わない。
 * 取り込み元の .ks のタグと取り込まないタグは、取り込みの変換表（組み込みの標準の変換表とプラグインの "./import"）から載せる。
 * プロジェクトを省くと、組み込みと標準の命令だけを出す。
 * --json はコマンドの仕様をそのまま出す（英語の summaryEn、docEn、keywordsEn、exampleEn と、群の titleEn も入る）。
 * --lang en は文字の出力を英語にする（例は exampleEn。英語の無い説明と例は日本語のまま。docs/commands.md は日本語で作る）。
 */

export type ReferenceLang = "ja" | "en";

export interface ReferenceGroup {
  /** "core"（組み込み）またはプラグインの名前。 */
  source: string;
  title: string;
  titleEn: string;
  commands: (CommandSpec & { ks: string[] })[];
  /** 取り込まない .ks のタグ（タグ名 → 理由）。 */
  unsupportedTags?: Record<string, string>;
  /** @choice の選択肢の行に書ける引数（組み込みだけが持つ）。ks は選択肢の行になる .ks のタグ。 */
  choiceOption?: CommandSpec & { ks: string[] };
  /** プラグインが足す式の関数（CommandPlugin.functions）。 */
  functions?: { name: string; usage: string[]; doc: string; docEn?: string }[];
}

/** 選択肢の行になる .ks のタグ（取り込みの組み込みの変換。cond= は if= になる）。 */
const CHOICE_OPTION_TAGS = ["glink", "link", "button", "clickable"];

export async function collectReference(dir: string | null): Promise<ReferenceGroup[]> {
  /** 命令のプラグインと、同じパッケージの取り込み設定（標準の命令は組み込みの STD_IMPORT）。 */
  const plugins: { plugin: CommandPlugin; imports: TyranoImportProfile[] }[] = [];
  const loadCommands = async (pluginDir: string) => {
    const entry = pluginEntry(pluginDir, "commands");
    return entry ? ((await import(pathToFileURL(entry).href)) as { default: CommandPlugin }).default : null;
  };
  if (dir === null) {
    plugins.push({ plugin: (await loadCommands(STD_PLUGIN))!, imports: [STD_IMPORT] });
  } else {
    const project = loadProject(dir);
    const imports = await loadPluginImports(project);
    for (const pluginDir of project.plugins) {
      const plugin = await loadCommands(pluginDir);
      if (!plugin) continue;
      const own = imports.filter((p) => p.dir === pluginDir).map((p) => p.profile);
      plugins.push({ plugin, imports: pluginDir === STD_PLUGIN ? [STD_IMPORT, ...own] : own });
    }
  }
  const ks = tagsByCommand(plugins.flatMap((p) => p.imports.flatMap((i) => i.mappings ?? [])));
  const tagsOf = (name: string) => ks.get(name) ?? [];
  // プロジェクトのコマンドの既定値（liminalia.json の commandDefaults）を重ねて出す
  const defaults = dir === null ? undefined : loadProject(dir).config.commandDefaults;
  const own = (c: CommandSpec) => applyCommandDefaults(c, defaults);
  const groups: ReferenceGroup[] = [
    { source: "core", title: "組み込みのコマンド", titleEn: "Built-in commands", commands: CORE_COMMANDS.map((c) => ({ ...own(c), ks: tagsOf(c.name) })), choiceOption: { ...CHOICE_OPTION, ks: CHOICE_OPTION_TAGS } },
  ];
  for (const { plugin: p, imports } of plugins) {
    const unsupported = Object.assign({}, ...imports.map((i) => i.unsupportedTags ?? {})) as Record<string, string>;
    groups.push({
      source: p.name,
      title: p.name === "std" ? "標準のコマンド（@liminalia/std）" : `プラグイン ${p.name} のコマンド`,
      titleEn: p.name === "std" ? "Standard commands (@liminalia/std)" : `Commands of the ${p.name} plugin`,
      commands: p.commands.map((c) => ({ ...own(toSpec(c)), ks: tagsOf(c.name) })),
      ...(Object.keys(unsupported).length > 0 ? { unsupportedTags: unsupported } : {}),
      ...(p.functions && Object.keys(p.functions).length > 0
        ? { functions: Object.entries(p.functions).map(([name, f]) => ({ name, usage: [...(f.usage ?? [`${name}()`])], doc: f.doc, ...(f.docEn ? { docEn: f.docEn } : {}) })) }
        : {}),
    });
  }
  return groups;
}

/** 文字の出力の言葉（日本語と英語）。 */
const WORDS = {
  ja: {
    asset: (folder: string, cg: boolean) => (cg ? `素材（${folder}。おまけの CG の画像なら解放する）` : `素材（${folder}）`),
    cast: "キャラクター ID",
    appearance: "立ち絵セット名",
    variant: "差分名",
    position: "立ち位置名 / `auto`",
    text: "文字列（訳す）",
    name: "文字列（名前。訳す）",
    int: "整数",
    number: "数値",
    range: (min: number | undefined, max: number | undefined) => `（${min ?? ""}〜${max ?? ""}）`,
    kinds: { string: "文字列", bool: "真偽値", duration: "時間", color: "色", target: "ジャンプ先", variable: "変数", condition: "条件（式）" } as Record<string, string>,
    waitsBoth: "終わるまで次に進まない（`wait=false` で待たずに進む）。",
    waits: "終わるまで次に進まない。",
    noWait: "終わるのを待たずに次に進む（`wait=true` で終わるまで待つ）。",
    tableHead: "| パラメータ | 型 | 既定値 | 説明 |",
    positional: (name: string, n: number) => `${name}（名前なし、${n} 番目）`,
    projectDefault: (standard: string | undefined) => (standard !== undefined ? `（プロジェクトの設定。標準は \`${standard}\`）` : "（プロジェクトの設定）"),
    required: "必須",
    requiredUnless: (others: readonly string[]) => `${others.join("、")} が無ければ必須`,
    heading: "# コマンドリファレンス",
    intro: [
      "`lim reference` がコマンドの仕様（組み込みのレジストリとプラグインのコマンドの表）とインポートの変換表から生成したもの。手で編集しない。",
      "構文は [format.md](design/format.md)。名前なしのパラメータは名前付きでは書けず、既定値と同じ値は書かない。",
      '台詞の行は、話者名のすぐ後に「 『 （ ( のどれか（`ユイ「おはよう」`）か、話者名の後ろに " か “（半角の空白を一つ挟んでもよい。`Yui "Good morning."`）で始まる。括弧と引用符は本文の一部で、ゲームには書いたまま出す。',
      "「終わるまで次に進まない」コマンドは、演出（や画面、入力）が終わるまでシナリオが止まる（仕様の waits。Studio のタイムラインもこれで描く）。",
      "どのコマンドの行にも、`@jump` `@call` `@set` `@let` `@return` にも `if=(式)` を書ける。偽ならその行を飛ばす（TyranoScript の `cond=`。`@bg room.jpg if=(game.night)`）。下の表には載せない。",
    ],
    ks: (tags: string) => `インポート元の .ks のタグ: ${tags}`,
    choiceOption: "### @choice の選択肢の行",
    choiceOptionLead: (summary: string) => `${summary}。\`- 文 -> ジャンプ先\` のあとに書く。`,
    choiceOptionKs: (tags: string) => `インポート元の .ks のタグ: ${tags}（\`cond=\` は \`if=\`）`,
    choiceBlock: "### @choice の行",
    sentence: (s: string) => `${s}。`,
    unsupported: "### インポートしない .ks のタグ",
    unsupportedHead: "| タグ | 理由 |",
    functions: "## 式の関数",
    functionsLead: "このほかに、作品の `@function 名前(引数, …) = 式` で作った関数を呼べる（[format.md](design/format.md) の「式の関数（`@function`）」）。",
    functionsHead: "| 書き方 | 説明 |",
    pluginFunction: (plugin: string) => `（プラグイン ${plugin}）`,
    dataKey: (file: string, path: string) => `${file} の ${path} の名前`,
  },
  en: {
    asset: (folder: string, cg: boolean) => (cg ? `Asset (${folder}; unlocks the image if it's a CG in Extras)` : `Asset (${folder})`),
    cast: "Character ID",
    appearance: "Sprite set name",
    variant: "Variant name",
    position: "Position name / `auto`",
    text: "String (translated)",
    name: "String (a name; translated)",
    int: "Integer",
    number: "Number",
    range: (min: number | undefined, max: number | undefined) => (min !== undefined && max !== undefined ? ` (${min} to ${max})` : min !== undefined ? ` (${min} or more)` : ` (up to ${max})`),
    kinds: { string: "String", bool: "Boolean", duration: "Duration", color: "Color", target: "Jump target", variable: "Variable", condition: "Condition (expression)" } as Record<string, string>,
    waitsBoth: "Waits until it finishes before continuing (`wait=false` continues without waiting).",
    waits: "Waits until it finishes before continuing.",
    noWait: "Continues without waiting for it to finish (`wait=true` waits until it finishes).",
    tableHead: "| Parameter | Type | Default | Description |",
    positional: (name: string, n: number) => `${name} (unnamed, position ${n})`,
    projectDefault: (standard: string | undefined) => (standard !== undefined ? ` (project setting; the standard default is \`${standard}\`)` : " (project setting)"),
    required: "Required",
    requiredUnless: (others: readonly string[]) => `Required unless ${others.join(" or ")}`,
    heading: "# Command reference",
    intro: [
      "Generated by `lim reference` from the command specs (the built-in registry and the plugins' command tables) and the import mappings. Don't edit it by hand.",
      "See [format.md](design/format.md) for the syntax. Unnamed parameters can't be written by name, and values equal to the default are left out.",
      'A dialogue line starts with a speaker name followed right away by one of 「 『 （ ( (`Yui「Good morning.」`), or followed by " or “ with at most one half-width space between (`Yui "Good morning."`). The brackets and quotation marks are part of the text and are shown as written.',
      "Commands that wait until they finish stop the scenario until the effect (or screen, or input) ends (waits in the spec; the Studio timeline is drawn from it too).",
      "Any command line, and `@jump` `@call` `@set` `@let` `@return` too, can take `if=(expression)`. If it's false, the line is skipped (TyranoScript's `cond=`; `@bg room.jpg if=(game.night)`). It isn't listed in the tables below.",
    ],
    ks: (tags: string) => `Imported from these .ks tags: ${tags}`,
    choiceOption: "### @choice option lines",
    choiceOptionLead: (summary: string) => `${summary}. Write these after \`- text -> target\`.`,
    choiceOptionKs: (tags: string) => `Imported from these .ks tags: ${tags} (\`cond=\` becomes \`if=\`)`,
    choiceBlock: "### @choice line",
    sentence: (s: string) => `${s}.`,
    unsupported: "### .ks tags that aren't imported",
    unsupportedHead: "| Tag | Reason |",
    functions: "## Expression functions",
    functionsLead: "Functions the project makes with `@function name(argument, …) = expression` can be called too (see [format.md](design/format.md)).",
    functionsHead: "| Usage | Description |",
    pluginFunction: (plugin: string) => ` (plugin ${plugin})`,
    dataKey: (file: string, path: string) => `A name in ${path} of ${file}`,
  },
};

function typeName(t: ParamType, lang: ReferenceLang): string {
  const w = WORDS[lang];
  switch (t.kind) {
    case "enum":
      return t.values.map((v) => `\`${v}\``).join(" / ");
    case "asset":
      return w.asset(t.folder, t.cg === true);
    case "cast":
      return w.cast;
    case "appearance":
      return w.appearance;
    case "variant":
      return w.variant;
    case "position":
      return w.position;
    case "string":
      // 多言語の作品で訳す文字（訳のファイルのコマンドの文字・話者名）
      if (t.data) return w.dataKey(t.data.file, t.data.path);
      return t.translate === "text" ? w.text : t.translate === "name" ? w.name : w.kinds.string!;
    case "number":
    case "int": {
      const range = t.min !== undefined || t.max !== undefined ? w.range(t.min, t.max) : "";
      return `${t.kind === "int" ? w.int : w.number}${range}`;
    }
    default:
      return w.kinds[t.kind]!;
  }
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** 演出・画面・入力の終わりを待つか（CommandSpec.waits）。待たず、wait も持たない命令は書かない。 */
function waitsLine(c: CommandSpec, lang: ReferenceLang): string | null {
  const w = WORDS[lang];
  const hasWait = c.params.wait?.type.kind === "bool";
  if (c.waits) return hasWait ? w.waitsBoth : w.waits;
  return hasWait ? w.noWait : null;
}

/** 引数の表（引数が無ければ空）。 */
function paramsTable(c: CommandSpec, lang: ReferenceLang): string[] {
  const w = WORDS[lang];
  const params = Object.entries(c.params);
  if (params.length === 0) return [];
  const out = [w.tableHead, "|---|---|---|---|"];
  for (const [name, p] of params) {
    const pos = c.positional.indexOf(name);
    const label = pos >= 0 ? w.positional(name, pos + 1) : name;
    // プロジェクトの既定値なら、標準の既定値も添える
    const standard = p.projectDefault ? w.projectDefault(p.standardDefault) : "";
    const def = p.required ? w.required : p.requiredUnless ? w.requiredUnless(p.requiredUnless) : p.default !== undefined ? `\`${p.default}\`${standard}` : "";
    out.push(`| ${cell(label)} | ${cell(typeName(p.type, lang))} | ${cell(def)} | ${cell(paramDoc(p, lang === "en"))} |`);
  }
  out.push("");
  return out;
}

export function referenceMarkdown(groups: ReferenceGroup[], lang: ReferenceLang = "ja"): string {
  const w = WORDS[lang];
  const en = lang === "en";
  const out: string[] = [w.heading, "", ...w.intro];
  for (const g of groups) {
    out.push("", `## ${en ? g.titleEn : g.title}`, "");
    for (const c of [...g.commands].sort((a, b) => a.name.localeCompare(b.name))) {
      out.push(`### @${c.name}`, "", commandSummary(c, en), "");
      const waits = waitsLine(c, lang);
      if (waits) out.push(waits, "");
      out.push("```", commandExample(c, en), "```", "");
      out.push(...paramsTable(c, lang));
      if (c.ks.length > 0) out.push(w.ks(c.ks.map((t) => `\`[${t}]\``).join(" ")), "");
    }
    if (g.choiceOption) {
      const o = g.choiceOption;
      out.push(w.choiceOption, "", w.choiceOptionLead(commandSummary(o, en)), "");
      out.push("```", commandExample(o, en), "```", "");
      out.push(...paramsTable(o, lang));
      out.push(w.choiceOptionKs(o.ks.map((t) => `\`[${t}]\``).join(" ")), "");
      out.push(w.choiceBlock, "", w.sentence(commandSummary(CHOICE_BLOCK, en)), "");
      out.push("```", commandExample(CHOICE_BLOCK, en), "```", "");
      out.push(...paramsTable(CHOICE_BLOCK, lang));
    }
    const unsupported = Object.entries(g.unsupportedTags ?? {});
    if (unsupported.length > 0) {
      out.push(w.unsupported, "", w.unsupportedHead, "|---|---|");
      for (const [tag, reason] of unsupported) out.push(`| \`[${tag}]\` | ${cell(reason)} |`);
      out.push("");
    }
  }
  out.push("", w.functions, "", w.functionsLead, "", w.functionsHead, "|---|---|");
  const usage = en ? FUNCTION_USAGE_EN : FUNCTION_USAGE;
  const docs = en ? FUNCTION_DOCS_EN : FUNCTION_DOCS;
  for (const name of Object.keys(FUNCTION_ARITY)) out.push(`| ${(usage[name] ?? FUNCTION_USAGE[name] ?? [`${name}()`]).map((u) => `\`${u}\``).join("<br>")} | ${cell(docs[name] ?? FUNCTION_DOCS[name] ?? "")} |`);
  // プラグインが足した関数（どのプラグインのものかを添える）
  for (const g of groups) for (const f of g.functions ?? []) out.push(`| ${f.usage.map((u) => `\`${u}\``).join("<br>")} | ${cell(`${en ? (f.docEn ?? f.doc) : f.doc}${w.pluginFunction(g.source)}`)} |`);
  return `${out.join("\n").trimEnd()}\n`;
}

export async function runReference(dir: string | null, o: { json: boolean; lang?: ReferenceLang; out?: string }): Promise<void> {
  const groups = await collectReference(dir);
  const text = o.json ? `${JSON.stringify(groups, null, 2)}\n` : referenceMarkdown(groups, o.lang ?? "ja");
  if (o.out) {
    writeFileSync(o.out, text);
    console.log(o.lang === "en" ? `Wrote ${o.out}` : `出力: ${o.out}`);
  } else {
    process.stdout.write(text);
  }
}
