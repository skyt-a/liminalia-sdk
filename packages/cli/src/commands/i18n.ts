import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { schemaUrl } from "../schema-url.ts";
import { join, relative } from "node:path";
import {
  applyTranslationTable,
  exchangeContext,
  lineIdsOf,
  moveTranslationKeys,
  moveVoiceLockKeys,
  parse,
  stampLineIds,
  translateDiagnosticText,
  translationCount,
  translationKeyMoves,
  translationToCsv,
  translationToXliff,
  updateTranslation,
  voiceKeyMoves,
  type ExchangeRejected,
  type KeyMove,
  type Script,
  type TranslationFile,
} from "@liminalia/lang";
import { assertScenariosUtf8, listPackSources, listScenarioFiles, projectDataReader, readScenarioFile, readVoiceLock } from "@liminalia/project";
import { packTranslationScope, parsePacks, projectDataTexts } from "@liminalia/plugin-host";
import { uiStringTable } from "@liminalia/web/ui-strings";
import { loadContext } from "../context.ts";
import { countEn } from "../english.ts";

/**
 * lim i18n [プロジェクト] <言語> — その言語の訳のファイル（paths.lang の <言語>.json）を今のシナリオに合わせる。
 * 今ある訳は残し、新しい本文の行・選択肢・話者名・コマンドの文字（@layer-text の文字など）・作品の設定の文字（章の題、おまけの題など）を訳を空で足す。使われなくなった訳は捨てずに、
 * 原文が同じ行へ引き継ぐか、近い原文の行の previous に添えるか、stale に取っておく（@liminalia/lang の updateTranslation）。
 * 日本語と英語以外の言語には、システム画面の文言（ui）も英語の原文を添えて並べる。
 * liminalia.json の languages に無い言語なら、足すように知らせる（書き換えはしない）。
 *
 * lim i18n [プロジェクト] --stamp-ids [<言語>] — 台詞、地の文、選択肢の行のうち固定の行 ID の無いものに ` #line:ID` を振り、
 * 訳のファイル（すべての言語）とボイスの番号の固定（voice-lock.json）の鍵を ID の鍵に付け替える（原文を書き換えても訳と番号が外れなくなる）。
 */
/** 訳のやり取り（lim i18n の --export・--import・--count ほか）。 */
export interface I18nExchange {
  /** 表（csv）か XLIFF（xliff）に書き出す先。 */
  export?: { format: "csv" | "xliff"; out: string };
  /** 訳を書き込んだ表か XLIFF を読み戻す。 */
  import?: string;
  /** 文字数（見積もり用）を出す。 */
  count?: boolean;
  /** 書き出すのを訳の無い項目だけにする。 */
  untranslated?: boolean;
  /** 書き出すのを訳のあとで原文が変わった項目だけにする（untranslated と両方なら、どちらかに当たるもの）。 */
  changed?: boolean;
  /** 行 ID の無い行に振る。 */
  stampIds?: boolean;
  /** 出力と、書き出す表と XLIFF の文脈の言葉。 */
  lang?: "ja" | "en";
}

export async function runI18n(dir: string, language: string | null, exchange: I18nExchange = {}): Promise<boolean> {
  const en = exchange.lang === "en";
  const ctx = await loadContext(dir);
  const { project } = ctx;
  const languages = project.config.languages ?? [];
  // 化けた本文を訳の原文や書き出す表に入れず、行 ID を振った台本も書き戻さない
  assertScenariosUtf8(project.paths.scenario, en ? "en" : "ja");
  if (exchange.stampIds) stampIds(ctx, en);
  if (language === null) {
    if (exchange.stampIds) return true;
    console.error(en ? "Specify a language (lim i18n en)" : "言語を指定してください（lim i18n en）");
    return false;
  }
  if (languages[0] === language) {
    console.error(en ? `${language} is the source language (the first of languages). Specify a language to translate into` : `${language} は原文の言語です（languages の先頭）。翻訳する言語を指定してください`);
    return false;
  }
  const scripts = readScripts(ctx);
  const path = join(project.paths.lang, `${language}.json`);
  const existing = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as TranslationFile) : null;
  // パックに訳が無ければ、遊ぶ側は本体の訳をパックの台本にも使う（その行も並べる）。訳を持つパックの台本だけが使う訳も消さずに残す
  const sources = { registry: ctx.registry, project: project.config, ui: uiStringTable(), data: projectDataTexts(ctx.plugins, projectDataReader(project)), ...packTranslationScope(parsePacks(listPackSources(project.root), ctx.cast.speakers), language) };
  const r = updateTranslation(existing, language, scripts, ctx.cast.speakers, sources);
  const back = exchange.import ? applyTranslationTable(r.file, readFileSync(exchange.import, "utf8")) : null;
  mkdirSync(project.paths.lang, { recursive: true });
  // 先頭の $schema は残す（新しいファイルにはサイトの JSON Schema を書く）
  const schema = { $schema: existing ? (existing as { $schema?: unknown }).$schema : schemaUrl("lang") };
  const withSchemaKey = (f: TranslationFile) => (schema.$schema === undefined ? f : { ...schema, ...f });
  writeFileSync(path, `${JSON.stringify(withSchemaKey(r.file), null, 2)}\n`);
  const rel = relative(project.root, path);
  console.log(en ? `${rel}: ${r.translated} of ${countEn(r.total, "item")} translated, ${r.added} added` : `${rel}: ${r.total} 行のうち翻訳済み ${r.translated}、新しく追加 ${r.added}`);
  if (r.carried || r.suggested || r.kept) {
    console.log(
      en
        ? `  Translations no longer used: ${r.carried} carried over to lines with the same source, ${r.suggested} added as suggestions to similar lines (previous), ${r.kept} kept (stale)`
        : `  使われなくなった翻訳: 同じ原文の行へ引き継ぎ ${r.carried}、近い原文の行に候補として追加 ${r.suggested}（previous）、保持 ${r.kept}（stale）`,
    );
  }
  if (r.outdated) console.log(en ? `  The source changed after translation: ${countEn(r.outdated, "item")} (the translation is still shown; export them with --changed)` : `  訳のあとで原文が変わった項目: ${r.outdated}（訳は使われ続けます。--changed で書き出せます）`);
  if (r.ui) {
    console.log(
      en
        ? `  System screen text: ${r.ui.translated} of ${countEn(r.ui.total, "item")} translated, ${r.ui.added} added${r.ui.outdated ? `, the English changed for ${r.ui.outdated}` : ""} (untranslated ones show the English)`
        : `  システム画面の文言: ${r.ui.total} 件のうち翻訳済み ${r.ui.translated}、新しく追加 ${r.ui.added}${r.ui.outdated ? `、英語が変わった ${r.ui.outdated}` : ""}（訳の無いものは英語を出します）`,
    );
  }
  if (!languages.includes(language)) console.log(en ? `Add "${language}" to languages in liminalia.json to make it selectable in the game settings (the first one is the source language)` : `liminalia.json の languages に "${language}" を追加すると、ゲームのコンフィグで選べるようになります（先頭は原文の言語）`);
  let file = r.file;
  if (back) {
    file = back.file;
    writeFileSync(path, `${JSON.stringify(withSchemaKey(file), null, 2)}\n`);
    console.log(en ? `Import: applied ${countEn(back.applied, "translation")}` : `インポート: ${back.applied} 行の翻訳を反映しました`);
    if (back.rejected.length) {
      console.log(en ? `  Not applied because the translation is malformed: ${back.rejected.length}` : `  訳の書き方が正しくないため反映しなかった行: ${back.rejected.length}`);
      for (const x of back.rejected) console.log(`    ${where(x, en)} ${x.key}: ${message(x.message, en)}`);
    }
    if (back.warnings.length) {
      console.log(en ? `  Applied, but check: ${back.warnings.length}` : `  反映したが確かめてほしい行: ${back.warnings.length}`);
      for (const x of back.warnings) console.log(`    ${where(x, en)} ${x.key}: ${message(x.message, en)}`);
    }
    if (back.changedSource) {
      console.log(
        en
          ? `  Not applied because the source differs from the current scenario: ${back.changedSource} (the file was exported before the scenario changed; export again and move the translations over)`
          : `  原文が現在のシナリオと異なるため反映しなかった行: ${back.changedSource}（シナリオの変更前にエクスポートしたファイルです。エクスポートし直して翻訳を移してください）`,
      );
      for (const key of back.changedKeys) console.log(`    ${key}`);
    }
    if (back.unknown) console.log(en ? `  Keys not in the current translation file: ${back.unknown}` : `  現在の翻訳ファイルにないキー: ${back.unknown}`);
    // 上の数はインポートする前のものなので、インポートした訳で数え直す（数え方は上と同じ updateTranslation）
    const now = updateTranslation(file, language, scripts, ctx.cast.speakers, sources);
    console.log(en ? `  After the import: ${now.translated} of ${countEn(now.total, "item")} translated, ${now.total - now.translated} left` : `  インポートのあと: ${now.total} 行のうち翻訳済み ${now.translated}、残り ${now.total - now.translated}`);
    if (now.ui) {
      console.log(
        en
          ? `  System screen text after the import: ${now.ui.translated} of ${countEn(now.ui.total, "item")} translated, ${now.ui.total - now.ui.translated} left`
          : `  インポートのあとのシステム画面の文言: ${now.ui.total} 件のうち翻訳済み ${now.ui.translated}、残り ${now.ui.total - now.ui.translated}`,
      );
    }
  }
  if (exchange.export) {
    const options = { context: exchangeContext(scripts, ctx.registry), ...(exchange.untranslated ? { untranslated: true } : {}), ...(exchange.changed ? { changed: true } : {}), noteLanguage: en ? ("en" as const) : ("ja" as const) };
    const out = exchange.export.format === "xliff" ? translationToXliff(file, languages[0] ?? "ja", options) : `﻿${translationToCsv(file, options)}`;
    writeFileSync(exchange.export.out, out);
    const only = exchange.untranslated && exchange.changed ? (en ? ", untranslated and changed only" : "、訳の無いものと原文が変わったものだけ") : exchange.untranslated ? (en ? ", untranslated only" : "、訳の無いものだけ") : exchange.changed ? (en ? ", changed only" : "、原文が変わったものだけ") : "";
    console.log(en ? `Export: ${exchange.export.out} (${exchange.export.format === "xliff" ? "XLIFF 1.2" : "CSV"}${only})` : `エクスポート: ${exchange.export.out}（${exchange.export.format === "xliff" ? "XLIFF 1.2" : "CSV"}${only}）`);
  }
  if (exchange.count) {
    const c = translationCount(file);
    console.log(en ? `Characters (source): ${c.chars} in all (${countEn(c.lines, "item")}), ${c.untranslatedChars} untranslated (${countEn(c.untranslatedLines, "item")})` : `文字数（原文）: 全体 ${c.chars} 字（${c.lines} 項目）、未翻訳 ${c.untranslatedChars} 字（${c.untranslatedLines} 項目）`);
  }
  return true;
}

type Context = Awaited<ReturnType<typeof loadContext>>;

function readScripts(ctx: Context): Map<string, Script> {
  const scripts = new Map<string, Script>();
  for (const { name, path: file } of listScenarioFiles(ctx.project.paths.scenario)) scripts.set(name, parse(readScenarioFile(file).text, name, { speakers: ctx.cast.speakers }));
  return scripts;
}

/** 取り込まなかった訳の位置（表の行か、XLIFF の行と、訳の中の何文字目か）。 */
function where(x: ExchangeRejected, en: boolean): string {
  const at = "row" in x.at ? (en ? `row ${x.at.row}` : `表の ${x.at.row} 行目`) : "line" in x.at ? (en ? `line ${x.at.line}` : `${x.at.line} 行目`) : en ? `item ${x.at.index + 1}` : `${x.at.index + 1} 番目`;
  return x.column !== undefined ? (en ? `${at} (character ${x.column} of the translation)` : `${at}（訳の ${x.column} 文字目）`) : at;
}

const message = (text: string, en: boolean) => (en ? (translateDiagnosticText(text) ?? text) : text);

/**
 * 行 ID の無い台詞、地の文、選択肢に ` #line:ID` を振り、訳のファイルとボイスの番号の固定の鍵を付け替える。
 * ID は作品の中で重ならないようにする。読めない行（構文の誤り）には振らない。
 */
function stampIds(ctx: Context, en: boolean): void {
  const { project } = ctx;
  // 付け替える訳とボイスの番号の固定は、台本を書き換える前に読む。読めないものがあれば何も書かずに止める
  // （飛ばして続けると、そのファイルだけ古い鍵のまま残り、訳やボイスが黙って使われなくなる）
  const langFiles = existsSync(project.paths.lang)
    ? readdirSync(project.paths.lang)
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
          const path = join(project.paths.lang, f);
          try {
            return { path, file: JSON.parse(readFileSync(path, "utf8")) as TranslationFile };
          } catch (e) {
            const why = e instanceof Error ? e.message : String(e);
            throw new Error(en ? `Can't read ${relative(project.root, path)}, so no line IDs were stamped. Fix it and try again (${why})` : `${relative(project.root, path)} を読めないので、行 ID を振りませんでした。直してから、もう一度振ってください（${why}）`);
          }
        })
    : [];
  const lock = readVoiceLock(project);
  const files = listScenarioFiles(project.paths.scenario);
  const taken = new Set<string>();
  const before = new Map<string, { path: string; text: string; script: Script }>();
  for (const { name, path } of files) {
    const text = readScenarioFile(path).text;
    const script = parse(text, name, { speakers: ctx.cast.speakers });
    for (const { id } of lineIdsOf(script)) taken.add(id);
    before.set(name, { path, text, script });
  }
  const translationMoves: KeyMove[] = [];
  const voiceMoves: KeyMove[] = [];
  let lines = 0;
  let changedFiles = 0;
  for (const [name, b] of before) {
    const r = stampLineIds(b.text, b.script, taken);
    if (r.stamped === 0) continue;
    writeFileSync(b.path, r.text);
    const after = parse(r.text, name, { speakers: ctx.cast.speakers });
    translationMoves.push(...translationKeyMoves(b.script, after, ctx.registry));
    voiceMoves.push(...voiceKeyMoves(b.script, after));
    lines += r.stamped;
    changedFiles++;
  }
  console.log(en ? `Stamped line IDs on ${countEn(lines, "line")} in ${countEn(changedFiles, "file")}` : `行 ID を ${changedFiles} ファイルの ${lines} 行に振りました`);
  // 訳のファイル（すべての言語）の鍵を、行 ID の鍵に付け替える
  for (const { path, file } of langFiles) {
    const next = moveTranslationKeys(file, translationMoves);
    if (next !== file && JSON.stringify(next) !== JSON.stringify(file)) {
      writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
      console.log(en ? `  Moved the translation keys of ${relative(project.root, path)} to the line IDs` : `  ${relative(project.root, path)} の翻訳キーを行 ID に更新しました`);
    }
  }
  if (lock) {
    const next = moveVoiceLockKeys(lock, voiceMoves);
    if (JSON.stringify(next) !== JSON.stringify(lock)) {
      writeFileSync(project.paths.voiceLock, `${JSON.stringify(next, null, 2)}\n`);
      console.log(en ? `  Moved the keys of ${relative(project.root, project.paths.voiceLock)} to the line IDs (the numbers stay the same)` : `  ${relative(project.root, project.paths.voiceLock)} のキーを行 ID に更新しました（番号はそのまま）`);
    }
  }
}
