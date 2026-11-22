/**
 * 2026-11 の点検の直し（表記ゆれ・約物の検査と修正・文字数の表・コメントの範囲・ショートカットの一覧・ゲームの設定の入れ子の欄・
 * 確認のダイアログ・英語の断りの文・見た目の確かめ・押した状態の ghost ボタン・文字の大きさ）を、lim studio と同じ開発サーバーで開いて確かめる。
 *   npx tsx packages/studio/dev/verify-quality.ts [スクリーンショットの置き場所]
 * ひな形を一時フォルダに写し、表記ゆれと約物の誤りのある行を足して開く。リポジトリのひな形は書き換えない。
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadProject } from "@liminalia/project";
import { chromium, type Page } from "playwright-core";
import { findChromium } from "../../cli/src/chromium.ts";
import { startPlayerServer } from "../../cli/src/web.ts";
import { STUDIO_API, STUDIO_PAGE } from "../src/protocol.ts";
import { openGameField } from "../test/game-section.ts";
import { autoConfirm } from "./confirm-auto.ts";

const shots = resolve(process.argv[2] ?? join(tmpdir(), "verify-quality-shots"));
mkdirSync(shots, { recursive: true });
const project = mkdtempSync(join(tmpdir(), "liminalia-studio-quality-"));
cpSync(resolve(import.meta.dirname, "../../../templates/default"), project, { recursive: true });
const extra = ["# quality", "アカリ「それなら出来る」", "ソウ「できるさ」", "アカリ「できないことはない」", "　本当？うそみたい。。", "ソウ「（小声で」", ""].join("\n");
writeFileSync(join(project, "scenario", "quality.lim"), extra);

const results: string[] = [];
const ok = (name: string, cond: boolean, detail = "") => results.push(`${cond ? "OK  " : "NG  "} ${name}${detail ? ` — ${detail}` : ""}`);
const { server, url: playerUrl } = await startPlayerServer(loadProject(project), 0, true);
const base = playerUrl.replace(/\/$/, "");
const browser = await chromium.launch({ executablePath: findChromium(), args: ["--mute-audio"] });

/** 見えている文字の大きさ（px）の一覧。 */
const fontSizes = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    const out = new Set<number>();
    for (const root of document.querySelectorAll(sel)) {
      for (const n of [root, ...root.querySelectorAll("*")]) {
        const el = n as HTMLElement;
        if (el.offsetParent === null || el.closest(".game-theme-swatch, .cm-editor")) continue;
        if (![...el.childNodes].some((c) => c.nodeType === 3 && c.textContent!.trim() !== "")) continue;
        out.add(Math.round(parseFloat(getComputedStyle(el).fontSize) * 10) / 10);
      }
    }
    return [...out].sort((a, b) => a - b);
  }, selector);

try {
  for (const [language, scheme] of [["ja", "light"], ["en", "dark"]] as const) {
    const page = await browser.newPage({ locale: language === "ja" ? "ja-JP" : "en-US", viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    await page.addInitScript(`localStorage.setItem("liminalia.studio.blocks", "0"); localStorage.setItem("liminalia.studio.tourDone", "1"); localStorage.setItem("liminalia.studio.language", "${language}")`);
    const asked: string[] = [];
    page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
    await autoConfirm(page, (m) => (asked.push(m), true));
    await page.goto(`${base}${STUDIO_PAGE}`);
    await page.waitForSelector(".cm-content", { timeout: 30000 });
    await page.waitForTimeout(1500);
    const tag = `${language}-${scheme}`;

    // ---- チェック ----
    await page.keyboard.press("Control+3");
    await page.waitForSelector(".check-surface:not([hidden])", { timeout: 10000 });
    await page.locator(".check-rerun, .check-clear-actions button").first().click();
    await page.waitForSelector(".variant-list", { timeout: 20000 });
    await page.waitForTimeout(500);
    const syntaxPill = page.locator('.check-pill[data-category="syntax"]');
    // 二回目（英語）は一回目で直したあとなので、括弧の閉じ忘れだけが残る
    const first = language === "ja";
    ok(`チェック（${tag}）: 約物の問題が構文の分類に入る`, Number(await syntaxPill.getAttribute("data-count")) >= (first ? 3 : 1), (await syntaxPill.getAttribute("data-count")) ?? "");
    const fixes = await page.locator(".diag-fix").count();
    if (first) ok(`チェック（${tag}）: 修正案を当てられる行に「修正」が付く`, fixes >= 2, String(fixes));
    if (first) ok(`チェック（${tag}）: 約物の「まとめて修正」`, (await page.locator(".check-fix").count()) >= 1, (await page.locator(".check-fix").allTextContents()).join(" / "));
    await page.screenshot({ path: join(shots, `check-${tag}.png`), fullPage: false });
    // 文字数の表: 見出しで並べ替え
    const table = page.locator(".stats-table");
    await table.scrollIntoViewIfNeeded();
    const firstBefore = await table.locator("tbody tr th").first().textContent();
    await table.locator("thead .stats-sort").nth(2).click();
    const sorted = await table.locator("tbody tr td:nth-child(3)").allTextContents();
    const nums = sorted.map((t) => Number(t.replace(/,/g, "")));
    ok(`文字数の表（${tag}）: 見出しで大きい順に並べ替える`, nums.every((n, i) => i === 0 || nums[i - 1]! >= n) && (await table.locator('thead th[aria-sort="descending"]').count()) === 1, `${firstBefore} → ${nums.join(",")}`);
    ok(`文字数の表（${tag}）: CSV を書き出すボタン`, (await page.locator(".stats-csv").count()) === 1);
    // 表記ゆれ: 除外と元に戻す
    const variant = page.locator(".variant", { hasText: "出来" });
    ok(`表記ゆれ（${tag}）: そろえるボタン`, (await variant.locator(".variant-unify").count()) === 1);
    await variant.screenshot({ path: join(shots, `variant-${tag}.png`) });
    await variant.locator(".variant-ignore").click();
    await page.waitForSelector(".stats-ignored", { timeout: 10000 });
    ok(`表記ゆれ（${tag}）: 除外した組の一覧`, ((await page.locator(".stats-ignored").textContent()) ?? "").includes("できる"));
    await page.locator(".stats-ignored").screenshot({ path: join(shots, `ignored-${tag}.png`) });
    await page.locator(".stats-ignored-item button").first().click();
    await page.waitForFunction(() => !document.querySelector(".stats-ignored"), null, { timeout: 10000 });
    ok(`表記ゆれ（${tag}）: 元に戻すと一覧から消え、liminalia.json の ignore も外す`, !(JSON.parse(readFileSync(join(project, "liminalia.json"), "utf8")) as { stats?: unknown }).stats);
    // 見た目の確かめのカード
    ok(`見た目の確かめ（${tag}）: カードがある`, (await page.locator(".check-card.regress").count()) === 1);
    // 文字の大きさ（チェックの画面）
    const checkSizes = await fontSizes(page, ".check-surface");
    ok(`チェック（${tag}）: 文字は 12px 以上で 4 種類以内`, Math.min(...checkSizes) >= 12 && checkSizes.length <= 4, JSON.stringify(checkSizes));

    if (language === "ja") {
      // 「そろえる」で全ファイルの置換を開く
      await page.locator(".variant", { hasText: "出来" }).locator(".variant-unify").click();
      await page.waitForSelector(".toc-replace-row:not([hidden])", { timeout: 10000 });
      const q = await page.locator(".toc-search").inputValue();
      const r = await page.locator(".toc-replace").inputValue();
      ok("そろえる: 全ファイルの置換に探す文字と置き換える文字を入れて開く", q.startsWith("出来(?=") && r === "でき", `${q} → ${r}`);
      await page.waitForTimeout(1200);
      await page.screenshot({ path: join(shots, "unify-replace.png") });
      // 押した状態の置換のボタンは、マウスを重ねても押した色
      const toggle = page.locator(".toc-replace-toggle");
      const pressedBg = await toggle.evaluate((b) => getComputedStyle(b).backgroundColor);
      await toggle.hover();
      await page.waitForTimeout(300);
      const hoverBg = await toggle.evaluate((b) => getComputedStyle(b).backgroundColor);
      ok("押した ghost ボタン: マウスを重ねても押した状態の色", pressedBg === hoverBg && (await toggle.getAttribute("aria-pressed")) === "true", `${pressedBg} / ${hoverBg}`);
      await page.keyboard.press("Escape");

      // 見た目の確かめ: 一回目は基準を作り、二回目は比べて変わらない
      await page.keyboard.press("Control+3");
      const regress = page.locator(".check-card.regress");
      await regress.scrollIntoViewIfNeeded();
      for (const round of [1, 2]) {
        await regress.locator("button.primary, .check-actions button:not(.ghost)").first().click();
        await page.waitForFunction(() => /シーン/.test(document.querySelector(".check-card.regress .check-note")?.textContent ?? "") && !document.querySelector(".check-card.regress .check-bar"), null, { timeout: 180_000 });
        const note = (await regress.locator(".check-note").first().textContent()) ?? "";
        ok(`見た目の確かめ（${round} 回目）: 撮影して比べる`, round === 1 ? /基準に追加/.test(note) : /変わったシーンはありません/.test(note), note);
      }
      await regress.screenshot({ path: join(shots, "regress.png") });

      // チェックの「修正」: 句読点の重なりを直す
      await page.keyboard.press("Control+3");
      await page.waitForTimeout(500);
      const doubled = page.locator(".check-problems li.has-fix", { hasText: "。。" }).first();
      await doubled.locator(".diag-fix").click();
      await page.waitForFunction(() => document.querySelector(".notice")?.textContent?.includes("修正しました"), null, { timeout: 10000 }).catch(() => undefined);
      await page.waitForTimeout(1500);
      const after = readFileSync(join(project, "scenario", "quality.lim"), "utf8");
      ok("修正: 句読点の重なりを一つにして保存する", after.includes("うそみたい。\n") && !after.includes("。。"), JSON.stringify(after.split("\n")[4]));

      // 確認のダイアログ（チェックの「まとめて修正」）
      await page.locator(".check-rerun").click();
      await page.waitForTimeout(1500);
      const before = asked.length;
      const fixRow = page.locator(".check-fix", { hasText: "！？" });
      if ((await fixRow.count()) > 0) {
        await fixRow.locator(".check-fix-run").click();
        await page.waitForTimeout(1500);
        ok("まとめて修正: 制作画面の確認のダイアログで尋ねてから当てる", asked.length === before + 1 && readFileSync(join(project, "scenario", "quality.lim"), "utf8").includes("本当？　うそ"), asked.at(-1) ?? "");
      } else ok("まとめて修正: ！？の後の空白の行がある", false);

      // コメントを範囲に付ける（start.lim を開き直す）
      await page.goto(`${base}${STUDIO_PAGE}?file=start&line=23`);
      await page.waitForSelector(".cm-content", { timeout: 30000 });
      await page.waitForTimeout(1500);
      await page.evaluate(() => {
        const app = (window as unknown as { __liminaliaStudioApp: { debug: { editor: { gotoLine(n: number): void; view: { dispatch(t: unknown): void; state: { doc: { line(n: number): { from: number; to: number } } } } } } } }).__liminaliaStudioApp;
        const ed = app.debug.editor;
        ed.gotoLine(23);
        ed.view.dispatch({ selection: { anchor: ed.view.state.doc.line(23).from, head: ed.view.state.doc.line(25).to } });
      });
      await page.locator(".review-open").click();
      await page.waitForSelector(".review-new", { timeout: 5000 }).catch(async (e: unknown) => {
        await page.screenshot({ path: join(shots, "review-failed.png") });
        const info = await page.evaluate(() => ({ btn: !!document.querySelector(".review-open"), visible: (document.querySelector(".review-open") as HTMLElement | null)?.offsetParent !== null, pane: document.querySelector(".review-pane")?.outerHTML.slice(0, 200), file: (window as unknown as { __liminaliaStudioApp: { debug: { file: string } } }).__liminaliaStudioApp.debug.file }));
        throw new Error(`${String(e)} ${JSON.stringify(info)}`);
      });
      ok("コメント: 選んだ範囲に付ける欄", ((await page.locator(".review-new-at").textContent()) ?? "").includes("23〜25"), (await page.locator(".review-new-at").textContent()) ?? "");
      await page.locator(".review-new textarea").fill("ここの三行をまとめたい");
      await page.keyboard.press("Control+Enter");
      await page.waitForTimeout(1200);
      const reviewFiles = (await page.evaluate(async (api) => (await (await fetch(`${api}/reviews`)).json()) as { threads: { end?: { line: number } }[] }, STUDIO_API)).threads;
      ok("コメント: 範囲の最後の行を持つ", reviewFiles.some((t) => t.end?.line === 25), JSON.stringify(reviewFiles.map((t) => t.end)));
      ok("コメント: 続きの行に印", (await page.locator(".cm-review.is-range").count()) === 2);
      await page.locator(".review-edit").first().click();
      await page.locator(".review-thread textarea").first().fill("書き直した");
      await page.keyboard.press("Control+Enter");
      await page.waitForTimeout(1000);
      ok("コメント: 書き直すと（編集済み）", ((await page.locator(".review-pane").textContent()) ?? "").includes("編集済み"));
      await page.screenshot({ path: join(shots, "review-range.png") });
    }

    // ショートカットの一覧（? で開く）
    await page.locator(".topbar").click({ position: { x: 700, y: 10 } }).catch(() => undefined);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Shift+Slash");
    await page.waitForSelector("dialog.shortcuts", { timeout: 5000 }).catch(() => undefined);
    ok(`ショートカットの一覧（${tag}）: ? で開く`, (await page.locator("dialog.shortcuts").count()) === 1);
    if ((await page.locator("dialog.shortcuts").count()) === 1) {
      await page.locator("dialog.shortcuts").screenshot({ path: join(shots, `shortcuts-${tag}.png`) });
      const sizes = await fontSizes(page, "dialog.shortcuts");
      ok(`ショートカットの一覧（${tag}）: 文字は 12px 以上`, Math.min(...sizes) >= 12, JSON.stringify(sizes));
      await page.keyboard.press("Escape");
    }

    // ゲームの設定の入れ子の欄
    // 欄は見出しで開いたカテゴリの分だけ出る（一度に開くのは一つ）。触る欄のカテゴリを、触る前に開く
    await page.keyboard.press("Control+7");
    const variants = await openGameField(page, "title.variants");
    // 開いた直後の読み込み（見本の知らせ・素材の一覧）が落ち着くまで待つ
    await page.waitForTimeout(1500);
    await variants.scrollIntoViewIfNeeded();
    // 「名前 -> 文字」の行で書く欄（type: map）は JSON ではないので数えない
    const jsonFields = await page.evaluate(() => [...document.querySelectorAll('.game-form textarea.mono:not([data-kind="map"])')].map((t) => t.closest("[data-field]")?.getAttribute("data-field") ?? ""));
    ok(`ゲームの設定（${tag}）: JSON の欄が無い`, jsonFields.length === 0, JSON.stringify(jsonFields));
    ok(`ゲームの設定（${tag}）: 画像の切り分けは四つの数`, (await page.locator('[data-field="message.imageSlice"] input[type="number"]').count()) === 4);
    if (language === "ja") {
      await variants.locator(".game-list-add").click();
      await page.waitForTimeout(300);
      await variants.screenshot({ path: join(shots, "game-variants-added.png") });
      await variants.locator('input[aria-label="条件"]').fill("(system.cleared)");
      await variants.locator('input[aria-label="条件"]').press("Tab");
      await variants.locator("select").first().selectOption("hill_night.webp");
      await page.waitForTimeout(1000);
      const ui = (JSON.parse(readFileSync(join(project, "liminalia.json"), "utf8")) as { ui?: { title?: { variants?: unknown } } }).ui;
      ok("ゲームの設定: 替えるタイトルを行で足すと liminalia.json に書く", JSON.stringify(ui?.title?.variants) === JSON.stringify([{ if: "(system.cleared)", background: "hill_night.webp" }]), `${JSON.stringify(ui?.title)} ${(await page.locator(".notice").textContent()) ?? ""}`);
      const slice = (await openGameField(page, "message.imageSlice")).locator("input");
      await slice.first().fill("24");
      await slice.first().press("Tab");
      await page.waitForTimeout(800);
      const ui2 = (JSON.parse(readFileSync(join(project, "liminalia.json"), "utf8")) as { ui?: { message?: { imageSlice?: unknown } } }).ui;
      ok("ゲームの設定: 切り分けの上だけなら一つの数で書く", ui2?.message?.imageSlice === 24, JSON.stringify(ui2?.message?.imageSlice));
    }
    await openGameField(page, "title.variants");
    await variants.screenshot({ path: join(shots, `game-variants-${tag}.png`) });
    await openGameField(page, "systemVoice");
    await page.locator('[data-field="systemVoice"]').scrollIntoViewIfNeeded();
    await page.locator('[data-section="systemVoice"]').screenshot({ path: join(shots, `game-voice-${tag}.png`) });
    const gameSizes = await fontSizes(page, ".game-form");
    ok(`ゲームの設定（${tag}）: 文字は 12px 以上`, Math.min(...gameSizes) >= 12, JSON.stringify(gameSizes));

    // 英語の断りの文
    const message = await page.evaluate(async ([api, lang]) => {
      const r = await fetch(`${api}/file?file=../nothing`, { headers: lang === "en" ? { "x-liminalia-lang": "en" } : {} });
      return ((await r.json()) as { error: string }).error;
    }, [STUDIO_API, language] as const);
    ok(`断りの文（${tag}）: 画面の言語で返す`, language === "en" ? /^[\x20-\x7e]+$/.test(message) : /[ぁ-ん]/.test(message), message);

    // ⌘− で縮めても 12px を下回らない
    await page.keyboard.press("Control+1");
    await page.keyboard.press("Control+Minus");
    await page.keyboard.press("Control+Minus");
    await page.waitForTimeout(500);
    const small = await fontSizes(page, ".topbar, .toc, .right");
    ok(`縮小（${tag}）: ⌘− でも 12px 以上`, Math.min(...small) >= 12, JSON.stringify(small));
    await page.screenshot({ path: join(shots, `zoom-out-${tag}.png`) });
    await page.keyboard.press("Control+0");
    await page.close();
  }
} catch (e) {
  results.push(`NG  例外: ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  await browser.close();
  await server.close();
}
console.log(results.join("\n"));
console.log(`スクリーンショット: ${shots}`);
process.exit(results.some((r) => r.startsWith("NG")) ? 1 : 0);
