/**
 * はじめての人がつまずく所の直し（ブロック表示の問題の印と「修正」、シーン一覧とタブの問題の数、同じ作品を二つの画面で開いたときの保存、
 * 保存できないときの帯とバックアップ、読み込めないプラグインの帯と診断、サイトへのリンク、白紙の作品の素材、無い素材の札と依頼表）を、
 * lim studio の画面で操作して確かめる。
 *   npx tsx packages/studio/dev/verify-onboarding.ts <スクリーンショットの置き場所> [ポート（既定 5361。プラグインの確かめに次の番号も使う）]
 * ひな形（templates/default）を一時フォルダに写して書き換えて開く。リポジトリのひな形は書き換えない。
 * 結果は一行ずつ「OK」か「NG」で出す（NG でも終了コードは 0）。終わったらサーバーを止める。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { findChromium } from "../../cli/src/chromium.ts";
import { STUDIO_PAGE } from "../src/protocol.ts";
import { autoConfirm } from "./confirm-auto.ts";

const shots = resolve(process.argv[2] ?? join(tmpdir(), "liminalia-verify-onboarding"));
mkdirSync(shots, { recursive: true });
const port = Number(process.argv[3] ?? 5361);
const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
const LIM = resolve(import.meta.dirname, "../../cli/bin/lim.mjs");

const results: string[] = [];
const ok = (name: string, cond: boolean, detail: unknown = "") => {
  const line = `${cond ? "OK  " : "NG  "} ${name}${!cond && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`;
  results.push(line);
  console.log(line);
};
const errors: string[] = [];
const servers: { child: ChildProcess; dir: string }[] = [];
process.on("exit", () => {
  for (const s of servers) {
    s.child.kill();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

/** ひな形を写して change で書き換え、lim studio で開く。 */
async function serve(name: string, at: number, change: (dir: string) => void): Promise<{ dir: string; url: string }> {
  const dir = mkdtempSync(join(tmpdir(), `liminalia-verify-onboarding-${name}-`));
  cpSync(TEMPLATE, dir, { recursive: true });
  change(dir);
  const url = `http://localhost:${at}${STUDIO_PAGE}`;
  if (await fetch(url).then((r) => r.ok).catch(() => false)) throw new Error(`ポート ${at} はほかで使われています。止めてから流してください`);
  const child = spawn(process.execPath, [LIM, "studio", dir, "--port", String(at)], { stdio: "ignore", env: { ...process.env, LIMINALIA_EXIT_WITH_PARENT: "1" } });
  servers.push({ child, dir });
  for (let i = 0; ; i++) {
    if (await fetch(url).then((r) => r.ok).catch(() => false)) break;
    if (i > 120) throw new Error("lim studio が起動しません");
    await new Promise((r) => setTimeout(r, 500));
  }
  return { dir, url };
}

const browser = await chromium.launch({ executablePath: findChromium(), args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required"] });

async function open(url: string, o: { blocks: boolean; language?: "ja" | "en"; init?: string }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ locale: o.language === "en" ? "en-US" : "ja-JP", viewport: { width: 1440, height: 900 } });
  await context.addInitScript(`localStorage.setItem("liminalia.studio.tourDone", "1"); localStorage.setItem("liminalia.studio.blocks", "${o.blocks ? "1" : "0"}"); ${o.init ?? ""}`);
  await autoConfirm(context, () => true);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/favicon|404|409|500|autoplay|ERR_FAILED|ERR_CONNECTION_REFUSED|Failed to fetch|わざと|ディスクがいっぱい/i.test(m.text()) && errors.push(m.text()));
  await page.goto(url);
  await page.waitForSelector(".cm-content", { state: "attached" });
  await page.waitForTimeout(1500);
  return { context, page };
}
const app = <T>(page: Page, code: string) => page.evaluate(`(async () => { const s = window.__liminaliaStudioApp; const ed = s.debug.editor; ${code} })()`) as Promise<T>;
const text = (page: Page) => app<string>(page, "return ed.text()");

try {
  // ---- ブロック表示の問題の印と「修正」、シーン一覧とタブの問題の数（25、26） ----
  const main = await serve("main", port, (dir) => {
    const path = join(dir, "scenario/start.lim");
    const lines = readFileSync(path, "utf8").split("\n");
    lines[39] = "@chara ソウ simle at=right";
    lines[53] = "- ラジオをつける -> #radoi_on";
    lines.splice(33, 0, "ナゾ「だれかいるの？」");
    writeFileSync(path, lines.join("\n"));
  });
  const disk = (file: string) => readFileSync(join(main.dir, "scenario", `${file}.lim`), "utf8");
  {
    const { context, page } = await open(main.url, { blocks: true });
    await app(page, "ed.gotoLine(38); s.blocks.centerCursor()");
    await page.waitForSelector(".blk-mark-problem", { timeout: 10000 }).catch(() => undefined);
    const marks = await page.locator(".blk-mark-problem").count();
    ok("ブロック表示: エラーと警告の行に印を置く", marks >= 2, marks);
    ok("ブロック表示: 誤りの行の中身に波線（has-error）", (await page.locator(".blk-list .has-error").count()) >= 1);
    ok("ブロック表示: 警告の行の中身に波線（has-warning）", (await page.locator(".blk-list .has-warning").count()) >= 1);
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shots, "blocks-problems.png") });
    // 立ち絵の差分の綴り違いの印を押すと、文とヒントと「修正」
    const row = page.locator(".blk-line-row", { has: page.locator(".has-error") }).filter({ hasText: "ソウ" }).first();
    await row.scrollIntoViewIfNeeded();
    await row.locator(".blk-mark-problem").first().click();
    const card = page.locator(".blk-problem-card");
    await card.waitFor({ timeout: 5000 }).catch(() => undefined);
    const cardText = (await card.textContent().catch(() => "")) ?? "";
    ok("問題の印を押すと、文と修正案を出す", cardText.includes("simle") && cardText.includes("修正案: smile"), cardText);
    ok("問題の印を押すと「修正」を出す", (await card.locator(".blk-problem-fix").count()) === 1);
    await page.screenshot({ path: join(shots, "blocks-problem-card.png") });
    await card.locator(".blk-problem-fix").click();
    await page.waitForTimeout(2500);
    ok("「修正」で行を直して保存する", disk("start").includes("@chara ソウ smile at=right") && !disk("start").includes("simle"));
    ok("「修正」のあと札を閉じる", (await page.locator(".blk-problem-card").count()) === 0);
    // シーン一覧のファイルの問題の数
    const dot = page.locator('.toc-file[data-file="start"] .problem-dot');
    ok("シーン一覧のファイルに問題の数の点", (await dot.count()) === 1 && /^\d+$/.test((await dot.textContent()) ?? ""), await dot.textContent().catch(() => null));
    ok("問題の数の点はエラーがあれば赤", ((await dot.getAttribute("class")) ?? "").includes("is-error"));
    // シーンの行には、そのシーンの範囲の数（ファイルの数を超えない）。ファイルのシーンを開いて見る
    if ((await page.locator('.toc-file[data-file="start"] .toc-file-fold[aria-expanded="false"]').count()) > 0) await page.locator('.toc-file[data-file="start"] .toc-file-fold').click();
    await page.waitForTimeout(500);
    const sceneDots = await page.locator('.scene-row[data-file="start"] .problem-dot').allTextContents();
    ok(
      "シーン一覧のシーンの行に、そのシーンの問題の数の点",
      sceneDots.length >= 1 && sceneDots.reduce((n, t) => n + Number(t), 0) <= Number((await dot.textContent()) ?? "0"),
      sceneDots,
    );
    await page.locator(".toc").screenshot({ path: join(shots, "toc-problem-dot.png") }).catch(() => undefined);
    // タブ（二つ開くと出る）
    await app(page, 'await s.open("epilogue"); await s.open("start");');
    await page.waitForTimeout(800);
    const tabDot = page.locator('.file-tab[data-file="start"] .problem-dot');
    ok("ファイルのタブに問題の数の点", (await tabDot.count()) === 1);
    await page.locator(".file-tabs").screenshot({ path: join(shots, "tab-problem-dot.png") }).catch(() => undefined);

    // 制作画面が実行する直し方（26）: 診断にキャラクターに追加、シーンを追加の fix があれば、印の札からボタンで実行する
    const nazo = (await text(page)).split("\n").findIndex((l) => l.startsWith("ナゾ「")) + 1;
    await app(page, `s.diagnosticsChanged(2, [
      { severity: "warning", code: "unknown-speaker", message: "ナゾ は話者に登録されていないため、この行は台詞ではなく地の文になります", file: "start", line: ${nazo}, fixes: [{ kind: "add-speaker", name: "ナゾ" }] },
      { severity: "error", code: "unknown-label", message: "ラベル #radoi_on がこのファイルにありません", file: "start", line: 55, fixes: [{ kind: "add-label", file: "start", label: "radoi_on" }] },
    ])`);
    await page.waitForTimeout(300);
    const nazoRow = page.locator(".blk-line-row", { hasText: "だれかいるの" }).first();
    await nazoRow.scrollIntoViewIfNeeded();
    await nazoRow.locator(".blk-mark-problem").click();
    const addSpeaker = page.locator(".blk-problem-card .blk-problem-fix");
    ok("キャラクターに追加の直し方は、何をするかをボタンに出す", ((await addSpeaker.textContent()) ?? "") === "ナゾ をキャラクターに追加", await addSpeaker.textContent());
    await page.screenshot({ path: join(shots, "blocks-add-speaker.png") });
    await addSpeaker.click();
    await page.waitForTimeout(1500);
    const cast = JSON.parse(readFileSync(join(main.dir, "cast.json"), "utf8")) as { speakers: string[]; cast: Record<string, unknown> };
    ok("キャラクターに追加: cast.json の speakers と cast に足す", cast.speakers.includes("ナゾ") && "ナゾ" in cast.cast);
    await app(page, `s.diagnosticsChanged(1, [{ severity: "error", code: "unknown-label", message: "ラベル #radoi_on がこのファイルにありません", file: "start", line: 55, fixes: [{ kind: "add-label", file: "start", label: "radoi_on" }] }])`);
    await page.waitForTimeout(300);
    await app(page, "ed.gotoLine(55); s.blocks.centerCursor()");
    await page.waitForTimeout(300);
    await page.locator(".blk-line-row .blk-mark-problem").first().click();
    await page.locator(".blk-problem-card .blk-problem-fix").click();
    await page.waitForTimeout(2500);
    ok("シーンを追加: ファイルの末尾に # radoi_on を足して保存する", /\n# radoi_on\n/.test(disk("start")));
    await context.close();
  }

  // ---- 同じ作品を二つの画面で開いたとき（A19） ----
  {
    const a = await open(main.url, { blocks: false });
    const b = await open(main.url, { blocks: false });
    await app(a.page, 'ed.gotoLine(16); ed.replaceInLine(16, 0, 0, "// 二つ目の画面へ\\n")');
    await a.page.waitForFunction(() => document.querySelector(".save-status")?.textContent === "保存済み", null, { timeout: 20000 }).catch(() => undefined);
    await b.page.waitForFunction(() => (window as unknown as { __liminaliaStudioApp: { debug: { editor: { text(): string } } } }).__liminaliaStudioApp.debug.editor.text().includes("二つ目の画面へ"), null, { timeout: 10000 }).catch(() => undefined);
    ok("片方の画面で保存した変更が、もう片方の画面に届く", (await text(b.page)).includes("// 二つ目の画面へ"), (await text(b.page)).slice(0, 200));
    await a.page.waitForTimeout(1000);
    ok("書いた画面は自分の知らせで読み直さない（保存済みのまま）", ((await a.page.locator(".save-status").textContent()) ?? "") === "保存済み", await a.page.locator(".save-status").textContent());
    await b.page.screenshot({ path: join(shots, "two-windows-b.png") });
    await a.context.close();
    await b.context.close();
  }

  // ---- 保存できないとき（38） ----
  {
    const { context, page } = await open(main.url, { blocks: false });
    const id = JSON.parse(readFileSync(join(main.dir, "liminalia.json"), "utf8")).id as string;
    let mode: "down" | "refuse" | "up" = "down";
    await page.route("**/__liminalia/studio/api/file*", (route) => {
      if (route.request().method() !== "PUT" || mode === "up") return route.continue();
      if (mode === "down") return route.abort("connectionrefused");
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "ディスクがいっぱいです" }) });
    });
    await app(page, 'ed.replaceInLine(16, 0, 0, "// 保存できない間に書いた\\n")');
    await page.waitForTimeout(2000);
    const banner = page.locator(".app-banner.is-error");
    ok("サーバーにつながらないと上に帯を出す", await banner.isVisible(), await banner.textContent());
    ok("帯に直し方（lim studio を起動し直す）を添える", ((await banner.textContent()) ?? "").includes("lim studio を起動し直す"));
    ok("保存待ちの内容を localStorage にバックアップする", await page.evaluate((key) => (localStorage.getItem(key) ?? "").includes("保存できない間に書いた"), `liminalia.studio.unsaved:${id}:start`));
    await page.screenshot({ path: join(shots, "save-offline.png") });
    mode = "refuse";
    await page.locator(".app-banner.is-error button").click();
    await page.waitForTimeout(800);
    const notice = (await page.locator(".notice").textContent().catch(() => "")) ?? "";
    ok("断られたら理由をお知らせに出し、帯を消す", notice.includes("保存できません") && !(await banner.isVisible()), notice);
    await page.screenshot({ path: join(shots, "save-refused.png") });
    // 開き直すとバックアップから戻す（そのあいだに保存できるようになった）
    mode = "up";
    await page.unrouteAll();
    await page.evaluate(() => window.removeEventListener("beforeunload", () => undefined));
    await page.reload({ waitUntil: "load" }).catch(() => undefined);
    await page.waitForSelector(".cm-content", { state: "attached" });
    await page.waitForTimeout(3000);
    ok("開き直すとバックアップから戻して保存する", (await text(page)).includes("保存できない間に書いた") && disk("start").includes("保存できない間に書いた"));
    ok("保存できたらバックアップを消す", await page.evaluate((key) => localStorage.getItem(key) === null, `liminalia.studio.unsaved:${id}:start`));
    await page.screenshot({ path: join(shots, "save-restored.png") });
    await context.close();
  }

  // ---- サイトへのリンク（29） ----
  {
    const { context, page } = await open(main.url, { blocks: true });
    await page.locator(".topbar-more").click();
    const item = page.locator(".ctx-menu .ctx-item", { hasText: "使い方（サイト）" });
    ok("「…」のメニューに「使い方（サイト）」", (await item.count()) === 1);
    const popup = context.waitForEvent("page", { timeout: 5000 }).catch(() => null);
    await item.click();
    const opened = await popup;
    ok("「使い方（サイト）」はサイトの使い方を開く", opened?.url().startsWith("https://liminalia.skyta.dev/guide/") === true, opened?.url());
    await opened?.close();
    if (!(await page.locator(".blk-search").isVisible())) await page.locator('.panel-rail[data-panel="parts"]').click();
    await page.locator(".blk-search").fill("@bg");
    await page.waitForTimeout(400);
    await page.locator(".blk-part").first().hover();
    const more = page.locator(".part-card:not([hidden]) .part-card-more");
    await more.waitFor({ timeout: 5000 }).catch(() => undefined);
    const cardName = ((await page.locator(".part-card-head code").textContent().catch(() => "")) ?? "").replace(/^@/, "");
    ok("パーツの説明のカードに「詳しく」（そのコマンドのリファレンス）", (await more.getAttribute("href").catch(() => null)) === `https://liminalia.skyta.dev/reference/${cardName}/`, [cardName, await more.getAttribute("href").catch(() => null)]);
    const box = await page.locator(".part-card").boundingBox();
    if (box) await page.mouse.move(box.x + 20, box.y + 20, { steps: 4 });
    await page.waitForTimeout(400);
    ok("カードの上に移っても消えない（「詳しく」を押せる）", await page.locator(".part-card").isVisible());
    await page.screenshot({ path: join(shots, "part-card-more.png") });
    // コマンドの編集の欄
    await page.locator(".blk-search").fill("");
    await page.mouse.move(700, 400);
    const bgmLine = (await text(page)).split("\n").findIndex((l) => l.startsWith("@bgm ")) + 1;
    await app(page, `ed.gotoLine(${bgmLine}); s.openInspector({ line: ${bgmLine}, inline: null })`);
    const inspectorMore = page.locator(".inspector:not([hidden]) .inspector-more");
    await inspectorMore.waitFor({ timeout: 5000 }).catch(() => undefined);
    ok("コマンドの編集の欄に「詳しく」", ((await inspectorMore.getAttribute("href").catch(() => null)) ?? "").startsWith("https://liminalia.skyta.dev/reference/"), await inspectorMore.getAttribute("href").catch(() => null));
    await page.locator(".inspector").screenshot({ path: join(shots, "inspector-more.png") }).catch(() => undefined);
    await context.close();
    const en = await open(main.url, { blocks: true, init: 'localStorage.setItem("liminalia.studio.language", "en");' });
    if (!(await en.page.locator(".blk-search").isVisible())) await en.page.locator('.panel-rail[data-panel="parts"]').click();
    await en.page.locator(".blk-search").fill("quake");
    await en.page.waitForTimeout(400);
    await en.page.locator(".blk-part").first().hover();
    const enMore = en.page.locator(".part-card:not([hidden]) .part-card-more");
    await enMore.waitFor({ timeout: 5000 }).catch(() => undefined);
    ok("英語の表示では /en/reference/ を指す", ((await enMore.getAttribute("href").catch(() => null)) ?? "").startsWith("https://liminalia.skyta.dev/en/reference/"), await enMore.getAttribute("href").catch(() => null));
    await en.context.close();
  }

  // ---- 白紙の作品の素材（31）と、無い素材の札と依頼表（32） ----
  {
    const blank = await serve("blank", port + 2, (dir) => {
      rmSync(join(dir, "assets"), { recursive: true, force: true });
      rmSync(join(dir, "素材について.txt"), { force: true });
      mkdirSync(join(dir, "assets"), { recursive: true });
      writeFileSync(join(dir, "cast.json"), JSON.stringify({ speakers: [], cast: {} }));
      rmSync(join(dir, "scenario"), { recursive: true, force: true });
      mkdirSync(join(dir, "scenario"));
      writeFileSync(join(dir, "scenario/start.lim"), "# start\n@bg school_gate.webp\n　校門の前で、わたしは立ち止まった。\n　まだ誰も来ていない。\n");
    });
    const { context, page } = await open(blank.url, { blocks: true });
    // 無い背景は、プレビューでは名前の札（書き出しは止める）
    const placard = await fetch(`http://localhost:${port + 2}/assets/bgimage/school_gate.webp`, { headers: { referer: `http://localhost:${port + 2}/?studio=1` } });
    ok("無い背景はプレイヤーに名前の札を返す", placard.status === 200 && (placard.headers.get("content-type") ?? "").startsWith("image/svg+xml") && (await placard.text()).includes("school_gate.webp"));
    // 制作画面のページから頼むと（ブラウザが Referer を付ける）、無いことをそのまま返す
    // （開発サーバーは無いファイルに HTML を返すことがあるので、札の印が無いことで見る）
    const studioAsk = await page.evaluate(() => fetch("/assets/bgimage/school_gate.webp").then((r) => r.headers.get("x-liminalia-placeholder")));
    ok("制作画面そのものには札を返さない（無いことを見せる）", studioAsk === null, studioAsk);
    await app(page, "ed.gotoLine(3)");
    await page.waitForTimeout(2500);
    await page.locator(".stage-frame").screenshot({ path: join(shots, "missing-placard-preview.png") }).catch(() => undefined);
    // 依頼表
    await app(page, 's.setSurface("assets")');
    await page.waitForSelector(".assets-view", { timeout: 10000 });
    await page.waitForTimeout(800);
    ok("素材の空の状態に、次にすること（サンプル素材、仮の素材）のボタン", (await page.locator(".assets-empty-actions button").count()) === 2);
    await page.screenshot({ path: join(shots, "assets-empty.png") });
    await page.locator(".assets-more").click();
    await page.locator(".ctx-menu .ctx-item", { hasText: "素材の依頼表を書き出す" }).click();
    await page.waitForTimeout(1500);
    const csvPath = join(blank.dir, "exports/asset-requests.csv");
    const csv = existsSync(csvPath) ? readFileSync(csvPath, "utf8") : "";
    ok("素材の依頼表を exports/asset-requests.csv に書き出す", csv.includes("素材,bgimage,school_gate.webp,,start.lim,2,@bg school_gate.webp,1"), csv.slice(0, 200));
    ok("書き出したらお知らせ（ダウンロードを添える）", ((await page.locator(".notice").textContent()) ?? "").includes("exports/asset-requests.csv"), await page.locator(".notice").textContent());
    // サンプル素材と仮の素材
    await page.locator(".assets-empty-actions button", { hasText: "サンプル素材から追加" }).click();
    await page.waitForTimeout(1500);
    ok("サンプル素材から追加: ひな形の CC0 の素材を写す", existsSync(join(blank.dir, "assets/bgimage/hill_dusk.webp")) && existsSync(join(blank.dir, "assets/fgimage/akari/normal.webp")) && existsSync(join(blank.dir, "素材について.txt")));
    ok("サンプル素材が一覧に出る", (await page.locator(".asset-tile").count()) > 0);
    await page.screenshot({ path: join(shots, "assets-samples.png") });
    await page.locator(".assets-more").click();
    await page.locator(".ctx-menu .ctx-item", { hasText: "仮の素材を作る" }).click();
    await page.waitForTimeout(1500);
    ok("仮の素材を作る: 単色の背景と人の形の立ち絵を PNG で足す", existsSync(join(blank.dir, "assets/bgimage/placeholder-bg.png")) && existsSync(join(blank.dir, "assets/fgimage/placeholder-person.png")));
    const png = existsSync(join(blank.dir, "assets/bgimage/placeholder-bg.png")) ? readFileSync(join(blank.dir, "assets/bgimage/placeholder-bg.png")) : Buffer.alloc(0);
    ok("仮の背景は画面の大きさ", png.length > 24 && png.readUInt32BE(16) === 1280 && png.readUInt32BE(20) === 720, png.length > 24 ? [png.readUInt32BE(16), png.readUInt32BE(20)] : png.length);
    await page.locator('.assets-kinds button, .assets-kinds a', { hasText: "立ち絵" }).first().click().catch(() => undefined);
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(shots, "assets-placeholder-person.png") });
    // キャラクターの空の状態
    await app(page, 's.setSurface("cast")');
    await page.waitForTimeout(800);
    ok("キャラクターの空の状態に次にすること", ((await page.locator(".chars-empty").first().textContent()) ?? "").includes("キャラクターを追加"), await page.locator(".chars-empty").first().textContent().catch(() => null));
    await page.screenshot({ path: join(shots, "cast-empty.png") });
    await context.close();
  }

  // ---- 読み込めないプラグイン（34） ----
  {
    const plugins = await serve("plugins", port + 1, (dir) => {
      mkdirSync(join(dir, "plugins/broken"), { recursive: true });
      writeFileSync(join(dir, "plugins/broken/package.json"), JSON.stringify({ name: "broken", type: "module", exports: { "./commands": "./commands.ts" } }));
      writeFileSync(join(dir, "plugins/broken/commands.ts"), 'throw new Error("わざと止める");\nexport default { name: "broken", commands: [] };\n');
      const config = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown>;
      config.plugins = ["./plugins/broken", "no-such-package-xyz"];
      writeFileSync(join(dir, "liminalia.json"), JSON.stringify(config, null, 2));
      writeFileSync(join(dir, "scenario/stamp.lim"), "# stamp\n@stamp a\n@stamp b\n");
    });
    const { context, page } = await open(plugins.url, { blocks: true });
    const banner = page.locator(".app-banner", { hasText: "読み込めないプラグイン" });
    ok("lim studio は読み込めないプラグインを外して開き、上に帯を出す", await banner.isVisible(), await banner.textContent().catch(() => null));
    ok("帯に理由を出す", ((await banner.textContent()) ?? "").includes("no-such-package-xyz（パッケージが見つかりません）"), await banner.textContent());
    await page.screenshot({ path: join(shots, "plugin-banner.png") });
    await banner.locator("button").click();
    await page.waitForSelector(".check-surface:not([hidden])", { timeout: 10000 });
    await page.waitForTimeout(1500);
    const pill = page.locator('.check-pill[data-category="plugin"]');
    ok("チェックの「プラグイン」の分類に診断を出す", Number(await pill.getAttribute("data-count")) === 2, await pill.getAttribute("data-count"));
    const rows = await page.locator(".check-problems li").allTextContents();
    ok("診断は「プラグイン X を読み込めません（理由）」", rows.some((r) => r.includes("プラグイン ./plugins/broken を読み込めません（わざと止める）")), rows.slice(0, 4));
    ok("未定義のコマンドの指摘はまとめる", !rows.some((r) => r.includes("コマンド @stamp はありません")) && rows.some((r) => r.includes("未定義のコマンド @stamp")), rows.slice(0, 4));
    await page.screenshot({ path: join(shots, "plugin-check.png") });
    await context.close();
  }
} finally {
  await browser.close();
}
ok("画面のエラーが無い", errors.length === 0, errors.slice(0, 5));
console.log(`\n${results.filter((r) => r.startsWith("NG")).length} 件の NG`);
for (const f of readdirSync(shots)) if (!existsSync(join(shots, f))) console.log(f);
process.exit(0);
