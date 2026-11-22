/**
 * 大きな作品で探す、見るための動きを、lim studio の画面で操作して確かめる（ブロック表示の ⌘F の検索と置換、全体の検索の範囲と話者と欄の幅、
 * ⌘K のシーンの本文と題とタグ、シーンのタグと色と状態、マクロの定義へ移動と使う行と名前の変更、TODO コメント、見出しの文字数、チェックの分類の件数）。
 *   npx tsx packages/studio/dev/verify-find.ts <スクリーンショットの置き場所> [ポート（既定 5319）]
 *   npx tsx packages/studio/dev/verify-find.ts <置き場所> <ポート> --project <作品の写し> --file <大きなファイル> --word <よく出る言葉>
 * はじめの形は、ひな形（templates/default）を一時フォルダに写し、マクロ、TODO、3,000 行のファイルを足して開く（リポジトリのひな形は書き換えない）。
 * --project を渡すと、その作品（写してから渡す。書き換えるのは .liminalia/studio.json のシーンの印だけ）で速さを測る。
 * 結果は一行ずつ「OK」か「NG」で出す（NG でも終了コードは 0）。終わったらサーバーを止める。
 */
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import { findChromium } from "../../cli/src/chromium.ts";
import { STUDIO_PAGE } from "../src/protocol.ts";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1] ?? null;
  args.splice(i, 2);
  return v;
};
const given = opt("--project");
const bigFile = opt("--file") ?? "big";
const word = opt("--word") ?? "ほしぞら";
const shots = resolve(args[0] ?? join(tmpdir(), "liminalia-verify-find"));
mkdirSync(shots, { recursive: true });
const port = Number(args[1] ?? 5319);
const url = `http://localhost:${port}${STUDIO_PAGE}`;

const project = given ? resolve(given) : mkdtempSync(join(tmpdir(), "liminalia-verify-find-"));
if (!given) {
  cpSync(resolve(import.meta.dirname, "../../../templates/default"), project, { recursive: true });
  const scenario = join(project, "scenario");
  writeFileSync(
    join(scenario, "macros.lim"),
    ["// 名前を呼んで手を振る", "@define wave(who: cast, mood: enum(calm|loud) = calm)", "  @chara (who) normal", "@end", "", "# macros_use", "@wave who=アカリ", "アカリ「{@wave who=ソウ}またね」", "// TODO: 背景を差し替える", "  //fixme 音量をそろえる", "@stop"].join("\n"),
  );
  // 3,000 行のファイル（最後の方にだけ「ほしぞら」がある。ブロック表示では、はじめは仮の箱）
  const big: string[] = [];
  for (let s = 0; s < 60; s++) {
    big.push(`# part${s}`);
    for (let i = 0; i < 48; i++) big.push(i % 3 === 0 ? `アカリ「${s}-${i} の台詞です」` : i % 3 === 1 ? `ソウ「${s}-${i} の返事です」` : `　${s}-${i} の地の文です。`);
    if (s >= 57) big.push("アカリ「ほしぞらが見える」", "　ほしぞらの下で。");
    big.push("");
  }
  writeFileSync(join(scenario, "big.lim"), big.join("\n"));
}

if (await fetch(url).then((r) => r.ok).catch(() => false)) throw new Error(`ポート ${port} はほかで使われています。止めてから流してください`);
const server = spawn(process.execPath, [resolve(import.meta.dirname, "../../cli/bin/lim.mjs"), "studio", project, "--port", String(port)], { stdio: "ignore", env: { ...process.env, LIMINALIA_EXIT_WITH_PARENT: "1" } });
const stop = () => {
  server.kill();
  if (!given) rmSync(project, { recursive: true, force: true });
};
process.on("exit", stop);
for (let i = 0; ; i++) {
  if (await fetch(url).then((r) => r.ok).catch(() => false)) break;
  if (i > 240) throw new Error("lim studio が起動しません");
  await new Promise((r) => setTimeout(r, 500));
}

const ok = (name: string, cond: boolean, detail: unknown = "") => console.log(`${cond ? "OK  " : "NG  "} ${name}${!cond && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
const time = (name: string, ms: number) => console.log(`TIME ${name} ${Math.round(ms)}ms`);
const errors: string[] = [];
const browser = await chromium.launch({ executablePath: findChromium(), args: ["--mute-audio"] });
const context = await browser.newContext({ locale: "ja-JP", viewport: { width: 1440, height: 900 } });
await context.addInitScript('localStorage.setItem("liminalia.studio.tourDone", "1"); localStorage.setItem("liminalia.studio.blocks", "1")');
const page: Page = await context.newPage();
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !/favicon|404|409|autoplay/i.test(m.text()) && errors.push(m.text()));
await page.goto(url);
await page.waitForSelector(".cm-content", { state: "attached" });
await page.waitForTimeout(2000);
const app = <T>(code: string) => page.evaluate(`(async () => { const s = window.__liminaliaStudioApp; const ed = s.debug.editor; ${code} })()`) as Promise<T>;
const where = () => app<{ file: string | null; line: number }>("return { file: s.debug.file, line: ed.cursorLine() }");
/** 押してから、条件が満ちるまでの時間。 */
const measure = async (run: () => Promise<unknown>, until: () => Promise<boolean>, limit = 20_000): Promise<number> => {
  const t = Date.now();
  await run();
  while (!(await until())) {
    if (Date.now() - t > limit) return Number.POSITIVE_INFINITY;
    await page.waitForTimeout(20);
  }
  return Date.now() - t;
};

try {
  // ---- ブロック表示の検索と置換（⌘F） ----
  await app(`await s.open(${JSON.stringify(bigFile)}, 1); s.debug.setBlockMode(true)`);
  await page.waitForTimeout(600);
  const pendingBefore = await page.locator(".blk-pending").count();
  await page.locator(".blk-list").click({ position: { x: 5, y: 5 } }).catch(() => undefined);
  await page.keyboard.press("Control+f");
  ok("ブロック表示で ⌘F を押すと、検索の欄が出る", await page.locator(".blk-find:not([hidden])").isVisible());
  const findMs = await measure(
    () => page.locator(".blk-find-input").first().fill(word),
    async () => /\d+ \/ \d+/.test((await page.locator(".blk-find-count").textContent()) ?? ""),
  );
  time(`ブロック表示の検索（${word}）`, findMs);
  const count = (await page.locator(".blk-find-count").textContent()) ?? "";
  ok("まだ描いていない行も数える", /^1 \/ \d+$/.test(count), count);
  await page.waitForTimeout(300);
  const current = page.locator(".blk-line-row.find-current");
  ok("今の当たりの行を描いて、見えるところへ寄せる", (await current.count()) === 1 && (await current.isVisible()), { count: await current.count(), pendingBefore, pendingAfter: await page.locator(".blk-pending").count() });
  ok("当たった行に印を付ける", (await page.locator(".blk-line-row.find-hit").count()) >= 2);
  const before = await where();
  await page.locator(".blk-find-input").first().press("Enter");
  await page.waitForTimeout(200);
  ok("Enter で次の当たりへ（その行を選ぶ）", (await page.locator(".blk-find-count").textContent())?.startsWith("2 /") === true && (await where()).line > before.line, { count: await page.locator(".blk-find-count").textContent(), before, after: await where() });
  await page.screenshot({ path: join(shots, "01-block-find.png") });
  if (!given) {
    await page.locator(".blk-find-toggle").click();
    await page.locator(".blk-find-row:not([hidden]) .blk-find-input").nth(1).fill("ほしの海");
    await page.locator(".blk-find-action", { hasText: "すべて置換" }).click();
    await page.waitForTimeout(400);
    const text = await app<string>("return ed.text()");
    ok("すべて置換で、ファイルの中のすべてを置き換える", !text.includes("ほしぞら") && text.split("ほしの海").length - 1 === 6, text.split("ほしの海").length - 1);
    await page.screenshot({ path: join(shots, "02-block-replace.png") });
    // 「すべて置換」のボタンに入力があるまま ⌘Z
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(300);
    ok("すべて置換は ⌘Z の一回で元に戻る", (await app<string>("return ed.text()")).split("ほしぞら").length - 1 === 6);
  }
  await page.locator(".blk-find-input").first().press("Escape");
  ok("Esc で閉じる", await page.locator(".blk-find").isHidden());

  // ---- コード表示の ⌘F ----
  await app("s.debug.setBlockMode(false)");
  await page.waitForTimeout(300);
  await page.locator(".toc").click({ position: { x: 10, y: 200 } }).catch(() => undefined);
  await page.keyboard.press("Control+f");
  await page.waitForTimeout(200);
  ok("コード表示の ⌘F は、エディタに入力が無くてもエディタの検索を開く", await page.locator(".cm-search").first().isVisible());
  await page.keyboard.press("Escape");

  // ---- 全体の検索（範囲と話者、欄の幅） ----
  const tocWidth = async () => (await page.locator(".toc").boundingBox())?.width ?? 0;
  const narrow = await tocWidth();
  await page.keyboard.press("Control+Shift+f");
  const searchMs = await measure(
    () => page.locator(".toc-search").fill(word),
    async () => (await page.locator(".toc-results .toc-hit").count()) > 0,
  );
  time(`全体の検索（${word}）`, searchMs);
  await page.waitForTimeout(400);
  const wide = await tocWidth();
  ok("検索の結果を出している間は、シーン一覧の欄を広げる", wide > narrow + 40, { narrow, wide });
  const all = await page.locator(".toc-results .toc-hit").count();
  // 二回目（開発サーバーが台本を読み終えたあと。打ってから探し始めるまでの 0.2 秒を含む）
  const firstHit = async () => (await page.locator(".toc-results .toc-hit").first().textContent()) ?? "";
  await page.locator(".toc-search").fill(`${word}x`);
  await page.waitForTimeout(600);
  time(`全体の検索（${word}、二回目）`, await measure(() => page.locator(".toc-search").fill(word), async () => (await firstHit()) !== "" && (await page.locator(".toc-results .toc-hit").count()) === all));
  // 話者の絞り込み（話者はプロジェクトの最初の話者）
  const speaker = await page.locator(".toc-search-speaker option").nth(1).getAttribute("value");
  if (speaker) {
    time(`全体の検索（${word}、話者 ${speaker}）`, await measure(() => page.locator(".toc-search-speaker").selectOption(speaker), async () => (await page.locator(".toc-results .toc-hit").count()) < all));
    await page.locator(".toc-search-speaker").selectOption("");
    await page.waitForTimeout(600);
  }
  await page.locator(".toc-search-scope").selectOption("@open");
  await page.waitForTimeout(800);
  const files = await page.locator(".toc-results .toc-file-name").allTextContents();
  ok("範囲を「開いているファイル」にすると、そのファイルだけ", files.length === 1 && files[0] === `${bigFile}.lim`, files);
  if (!given) {
    await page.locator(".toc-search-speaker").selectOption("アカリ");
    await page.waitForTimeout(800);
    const hits = await page.locator(".toc-results .toc-hit").allTextContents();
    ok("話者を選ぶと、その人の台詞の行だけ", hits.length === 3 && hits.length < all, hits);
    await page.locator(".toc-search-speaker").selectOption("");
  }
  await page.screenshot({ path: join(shots, "03-search-wide.png") });
  await page.locator(".toc-search-scope").selectOption("");
  await page.locator(".toc-search").fill("");
  await page.waitForTimeout(500);
  ok("検索の文字を消すと、欄の幅を戻す", Math.abs((await tocWidth()) - narrow) < 2, { narrow, now: await tocWidth() });

  // ---- シーンのタグ、色、状態 ----
  const scene = given ? null : "part58";
  const target = scene ?? (await app<string>(`const f = s.project.files.find((x) => x.file === ${JSON.stringify(bigFile)}); return f.labels[Math.min(3, f.labels.length - 1)].name`));
  await app(`s.editMarksOf(${JSON.stringify(bigFile)}, ${JSON.stringify(target)}); return null`);
  await page.waitForSelector("dialog.scene-marks");
  await page.locator("dialog.scene-marks .seg", { hasText: "要確認" }).click();
  await page.locator('dialog.scene-marks .scene-swatch[data-value="blue"]').click();
  await page.locator("dialog.scene-marks .scene-mark-tags").fill("伏線、夜");
  await page.screenshot({ path: join(shots, "04-scene-marks.png") });
  await page.locator("dialog.scene-marks button.primary").click();
  await page.waitForTimeout(800);
  const state = JSON.parse(readFileSync(join(project, ".liminalia/shared.json"), "utf8")) as { sceneMarks?: Record<string, unknown> };
  ok("タグと状態を共有するデータ（.liminalia/shared.json）に覚える", JSON.stringify(state.sceneMarks?.[`${bigFile}#${target}`]) === JSON.stringify({ status: "review", color: "blue", tags: ["伏線", "夜"] }), state.sceneMarks);
  ok("シーン一覧の絞り込みが出る", await page.locator(".toc-mark-filter").isVisible());
  const filterMs = await measure(
    () => page.locator(".toc-mark-filter").selectOption("status:review"),
    async () => (await page.locator(".toc-list .scene-row").count()) === 1,
  );
  time("シーン一覧のタグと状態の絞り込み", filterMs);
  ok("状態で絞ると、そのシーンだけを点つきで並べる", (await page.locator(".toc-list .scene-row").count()) === 1 && (await page.locator(".toc-list .scene-row .scene-dot.is-mark-blue").count()) === 1);
  await page.screenshot({ path: join(shots, "05-toc-marks.png") });
  await page.locator(".toc-mark-filter").selectOption("");
  await page.waitForTimeout(300);

  // ---- ⌘K（本文とタグ） ----
  await page.keyboard.press("Control+k");
  const quickMs = await measure(
    () => page.locator(".quick-input").fill("#伏線"),
    async () => ((await page.locator(".quick-list li.on .quick-label").textContent()) ?? "").includes(target),
  );
  time("⌘K（タグ）", quickMs);
  ok("⌘K でタグを打つと、そのシーンが先頭に出る", Number.isFinite(quickMs), await page.locator(".quick-list li.on").textContent());
  const firstText = await app<string>(`const m = await s.api.map(); return (m.nodes.find((n) => n.id === ${JSON.stringify(`${bigFile}#${target}`)})?.text ?? "").replace(/^.*?「/, "").slice(0, 8)`);
  const quickText = await measure(
    () => page.locator(".quick-input").fill(firstText),
    async () => ((await page.locator(".quick-list li .quick-label").allTextContents()).some((t) => t.includes(target))),
  );
  time(`⌘K（最初の本文「${firstText}」）`, quickText);
  ok("⌘K で最初の本文を打つと、そのシーンが出る", Number.isFinite(quickText));
  await page.screenshot({ path: join(shots, "06-quick.png") });
  await page.keyboard.press("Escape");

  // ---- フローチャートのカード ----
  await page.keyboard.press("Control+2");
  await page.waitForSelector(".map-card", { timeout: 20000 });
  await page.waitForTimeout(800);
  await page.locator(".map-filter").nth(2).selectOption("tag:伏線").catch(() => undefined);
  await page.waitForTimeout(800);
  const card = page.locator(`.map-card[data-id="${bigFile}#${target}"]`);
  ok("フローチャートのカードに点と状態とタグを出し、タグで絞り込める", (await card.locator(".scene-dot.is-mark-blue").count()) === 1 && (await card.locator(".map-card-mark").allTextContents()).join(" ") === "要確認 #伏線 #夜" && (await card.getAttribute("class"))?.includes("is-match") === true, await card.locator(".map-card-mark").allTextContents());
  await page.screenshot({ path: join(shots, "07-map-marks.png") });
  await page.keyboard.press("Control+1");
  await page.waitForTimeout(400);

  if (!given) {
    // ---- マクロの定義へ移動と、使う行 ----
    await app('await s.open("macros", 7); s.debug.setBlockMode(false)');
    await page.waitForTimeout(400);
    await app("ed.gotoLine(7)");
    await page.keyboard.press("F12");
    await page.waitForTimeout(400);
    ok("マクロの呼び出しで F12 を押すと @define へ移る", (await where()).line === 2, await where());
    await page.keyboard.press("F12");
    await page.waitForTimeout(800);
    const uses = await page.locator(".ctx-menu .ctx-item").allTextContents();
    ok("@define の行の F12 で、そのマクロを使う行を並べる", uses.some((t) => t.includes("@wave who=アカリ")) && uses.some((t) => t.includes("{@wave who=ソウ}")), uses);
    await page.screenshot({ path: join(shots, "08-macro-uses.png") });
    await page.keyboard.press("Escape");
    // 補完の説明にコメントの要約と enum の候補
    await app("ed.gotoLine(11)");
    await app('ed.view.dispatch({ changes: { from: ed.view.state.doc.line(11).from, insert: "@wave mood=" }, selection: { anchor: ed.view.state.doc.line(11).from + 11 } }); ed.view.focus(); return null');
    await page.keyboard.press("Control+Space");
    await page.waitForTimeout(400);
    const options = await page.locator(".cm-tooltip-autocomplete li").allTextContents();
    ok("マクロの enum のパラメータの値を補完する", options.some((t) => t.includes("calm")) && options.some((t) => t.includes("loud")), options);
    await page.keyboard.press("Escape");
    await app("s.debug.editor.view.dispatch({ changes: { from: ed.view.state.doc.line(11).from, to: ed.view.state.doc.line(11).to, insert: '@stop' } }); return null");
    // マクロの名前の変更（「このマクロを使う行」のメニューから。@define と呼び出し、本文の {@…} を書き換える）
    await app("ed.gotoLine(2)");
    await page.keyboard.press("F12");
    await page.waitForTimeout(800);
    await page.locator(".ctx-menu .ctx-item", { hasText: "マクロの名前を変更" }).click();
    await page.locator("dialog.ask-text input").fill("wave-hand");
    await page.screenshot({ path: join(shots, "08b-macro-rename.png") });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2000);
    const renamedFile = readFileSync(join(project, "scenario", "macros.lim"), "utf8");
    const renamedEditor = await app<string>("return ed.text()");
    ok(
      "マクロの名前を変更すると、@define と呼び出しと本文の {@…} を書き換え、開いているエディタも合わせる",
      [renamedFile, renamedEditor].every((t) => t.includes("@define wave-hand(") && t.includes("@wave-hand who=アカリ") && t.includes("{@wave-hand who=ソウ}")),
      renamedEditor,
    );

    // ---- 見出しの文字数 ----
    await app('await s.open("start", 20)');
    await page.waitForTimeout(600);
    const chars = (await page.locator(".ed-chars").textContent()) ?? "";
    ok("見出しに「このシーン N 字」を出す", /^このシーン [\d,]+ 字$/.test(chars), chars);

    // ---- チェック: TODO コメントと分類の件数 ----
    await page.keyboard.press("Control+3");
    await page.waitForSelector(".todo-card .todo-row", { timeout: 20000 }).catch(() => undefined);
    const todos = await page.locator(".todo-card .todo-row").allTextContents();
    ok("チェックの画面に TODO コメントを並べる", todos.some((t) => t.includes("背景を差し替える")) && todos.some((t) => t.includes("音量をそろえる")), todos);
    await page.locator(".todo-card").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shots, "09-todos.png") });
  }
  ok("画面のエラーが無い", errors.length === 0, errors.slice(0, 5));
} catch (e) {
  ok("途中で止まった", false, e instanceof Error ? e.stack : String(e));
  await page.screenshot({ path: join(shots, "failed.png") }).catch(() => undefined);
} finally {
  await browser.close();
  stop();
  process.exit(0);
}
