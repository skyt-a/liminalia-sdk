import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toCsv, type TranslationFile } from "@liminalia/lang";

/** ひな形の作品で、lim i18n の書き出しと取り込み、行 ID の振り付け、原文を直したあとの差分の書き出しを通して確かめる。 */

const LIM = resolve(import.meta.dirname, "../bin/lim.mjs");
const lim = (args: string[], cwd?: string) => {
  const r = spawnSync(process.execPath, [LIM, ...args], { cwd, encoding: "utf8", timeout: 120_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

let root = "";
let dir = "";
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "liminalia-i18n-"));
  dir = join(root, "game");
  expect(lim(["new", dir, "--title", "訳の見本"]).code).toBe(0);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const fr = () => JSON.parse(readFileSync(join(dir, "lang", "fr.json"), "utf8")) as TranslationFile;

describe("lim i18n（ひな形の作品で通して）", { timeout: 300_000 }, () => {
  it("CSV の引用符が閉じていなければ訳のファイルを更新せず、改行と引用符のある訳は取り込む", () => {
    expect(lim(["i18n", dir, "de"]).code).toBe(0);
    const path = join(dir, "lang", "de.json");
    const file = JSON.parse(readFileSync(path, "utf8")) as TranslationFile;
    const [key, entry] = Object.entries(file.lines!)[0]!;
    const out = join(root, "de.csv");
    const before = `${JSON.stringify(file)}\n`;
    writeFileSync(path, before);
    writeFileSync(out, `${toCsv([["key", "source", "translation"], [key, entry.source, ""]]).trimEnd()}\"unfinished\nrest`);
    const broken = lim(["i18n", dir, "de", "--import", out]);
    expect(broken.code).not.toBe(0);
    expect(broken.out).toContain("CSV の 2 行目で始まる引用符が閉じられていません");
    expect(readFileSync(path, "utf8")).toBe(before);
    const text = 'Guten Tag\nEr sagt "Hallo".';
    writeFileSync(out, toCsv([["key", "source", "translation"], [key, entry.source, text]]));
    const valid = lim(["i18n", dir, "de", "--import", out]);
    expect(valid.code).toBe(0);
    expect(valid.out).toContain("インポート: 1 行の翻訳を反映しました");
    expect((JSON.parse(readFileSync(path, "utf8")) as TranslationFile).lines![key]!.text).toBe(text);
  });

  it("日本語と英語以外の言語は、システム画面の文言も英語の原文を添えて並べ、XLIFF の書き方を要素にして書き出す", () => {
    const r = lim(["i18n", dir, "fr"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("システム画面の文言");
    expect(fr().ui?.["title.start"]).toEqual({ source: "New Game", text: "" });
    expect(lim(["i18n", dir, "en"]).code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "lang", "en.json"), "utf8")).ui).toBeUndefined();
    const out = join(root, "fr.xlf");
    expect(lim(["i18n", dir, "fr", "--export", "xliff", "--out", out]).code).toBe(0);
    const xliff = readFileSync(out, "utf8");
    expect(xliff).toMatch(/<ph id="1" ctype="x-ruby">\{r [^<]+\}<\/ph>/);
    expect(xliff).toMatch(/<note>[^<]*位置: start\.lim \d+ 行目/);
    expect(xliff).toContain('<trans-unit id="ui:title.start" xml:space="preserve">');
  });

  it("作品のデータ（図鑑、調べる場所）の訳す文も並べ、英語は英語の欄のあるものを除く", () => {
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "data", "codex.json"), JSON.stringify({ categories: [{ id: "people", label: "人物" }], entries: [{ id: "a", category: "people", title: "アカリ", titleEn: "Akari", summary: "丘の上に住む。" }] }));
    expect(lim(["i18n", dir, "ko"]).code).toBe(0);
    const ko = JSON.parse(readFileSync(join(dir, "lang", "ko.json"), "utf8")) as TranslationFile;
    const data = Object.entries(ko.lines ?? {}).filter(([k]) => k.startsWith("data/codex.json:"));
    expect(data.map(([, e]) => e.source).sort()).toEqual(["アカリ", "丘の上に住む。", "人物"].sort());
    expect(data.find(([, e]) => e.source === "アカリ")![1].note).toBe("data/codex.json /entries/0/title");
    expect(lim(["i18n", dir, "en"]).code).toBe(0);
    const en = JSON.parse(readFileSync(join(dir, "lang", "en.json"), "utf8")) as TranslationFile;
    expect(Object.values(en.lines ?? {}).filter((e) => e.note?.startsWith("data/")).map((e) => e.source).sort()).toEqual(["丘の上に住む。", "人物"].sort());
    rmSync(join(dir, "data", "codex.json"));
    rmSync(join(dir, "lang", "ko.json"));
  });

  it("訳を書き込んで取り込む。書き方の読めない訳は位置を出して書かない", () => {
    const out = join(root, "fr.xlf");
    const xliff = readFileSync(out, "utf8");
    const units = [...xliff.matchAll(/<trans-unit id="(start:l[^"]+)"[^>]*>\n\s*<source>([^<]*)<\/source>\n\s*<target state="needs-translation"><\/target>/g)];
    const [good, bad] = [units[0]!, units[1]!];
    const edited = xliff
      .replace(`${good[2]}</source>\n        <target state="needs-translation"></target>`, `${good[2]}</source>\n        <target>Au sommet de la pente.</target>`)
      .replace(`${bad[2]}</source>\n        <target state="needs-translation"></target>`, `${bad[2]}</source>\n        <target>Un {b toit rond</target>`)
      .replace('<source>New Game</source>\n        <target state="needs-translation"></target>', "<source>New Game</source>\n        <target>Nouvelle partie</target>");
    writeFileSync(out, edited);
    const r = lim(["i18n", dir, "fr", "--import", out]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("インポート: 2 行の翻訳を反映しました");
    expect(r.out).toMatch(new RegExp(`\\d+ 行目（訳の 4 文字目） ${bad[1]}`));
    // インポートする前の数（翻訳済み 0）だけでなく、インポートしたあとの数と残りを出す
    const total = Object.keys(fr().lines!).length;
    const ui = Object.keys(fr().ui!).length;
    expect(r.out).toContain(`インポートのあと: ${total} 行のうち翻訳済み 1、残り ${total - 1}`);
    expect(r.out).toContain(`インポートのあとのシステム画面の文言: ${ui} 件のうち翻訳済み 1、残り ${ui - 1}`);
    const again = lim(["i18n", dir, "fr", "--import", out, "--lang", "en"]);
    expect(again.out).toContain(`After the import: 1 of ${total} items translated, ${total - 1} left`);
    expect(again.out).toContain(`System screen text after the import: 1 of ${ui} items translated, ${ui - 1} left`);
    expect(fr().lines![good[1]!]!.text).toBe("Au sommet de la pente.");
    expect(fr().lines![bad[1]!]!.text).toBe("");
    expect((fr().ui!["title.start"] as { text: string }).text).toBe("Nouvelle partie");
    // 訳の無いものだけを表に書き出す（英語の出力）
    const csv = join(root, "fr.csv");
    const e = lim(["i18n", dir, "fr", "--export", "csv", "--out", csv, "--untranslated", "--lang", "en"]);
    expect(e.out).toContain("CSV, untranslated only");
    expect(readFileSync(csv, "utf8")).not.toContain(good[1]!);
  });

  it("--stamp-ids は、読めない訳があれば台本に何も書かずに止める（その訳だけ古い鍵のまま残さない）", () => {
    const broken = join(dir, "lang", "xx.json");
    const start = readFileSync(join(dir, "scenario", "start.lim"), "utf8");
    writeFileSync(broken, "{ 壊れた");
    try {
      const r = lim(["i18n", dir, "--stamp-ids"]);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("lang/xx.json を読めないので、行 ID を振りませんでした");
      expect(readFileSync(join(dir, "scenario", "start.lim"), "utf8")).toBe(start);
    } finally {
      rmSync(broken, { force: true });
    }
  });

  it("--stamp-ids で行 ID を振ると訳の鍵が付け替わり、原文を直しても訳は使われ続け、--changed で書き出せる", () => {
    const before = fr();
    const translated = Object.entries(before.lines!).find(([, e]) => e.text !== "")!;
    const r = lim(["i18n", dir, "--stamp-ids"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/行 ID を \d+ ファイルの \d+ 行に振りました/);
    const start = readFileSync(join(dir, "scenario", "start.lim"), "utf8");
    expect(start).toMatch(/ #line:[0-9a-f]{8}\n/);
    const moved = Object.entries(fr().lines!).find(([, e]) => e.text === translated[1].text)!;
    expect(moved[0]).toMatch(/^start:l@[0-9a-f]{8}$/);
    expect(lim(["check", dir]).code).toBe(0);
    // 原文を少し直す
    const id = moved[0].slice("start:l@".length);
    writeFileSync(join(dir, "scenario", "start.lim"), start.replace(` #line:${id}`, `……。 #line:${id}`));
    const changed = join(root, "changed.xlf");
    const s = lim(["i18n", dir, "fr", "--export", "xliff", "--out", changed, "--changed"]);
    expect(s.out).toContain("訳のあとで原文が変わった項目: 1");
    expect(fr().lines![moved[0]]).toMatchObject({ text: "Au sommet de la pente.", translatedFrom: translated[1].source });
    const x = readFileSync(changed, "utf8");
    expect([...x.matchAll(/<trans-unit /g)]).toHaveLength(1);
    expect(x).toContain('<target state="needs-review-translation">Au sommet de la pente.</target>');
    expect(lim(["check", dir]).code).toBe(0);
  });
});
