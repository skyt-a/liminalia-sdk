/**
 * 長い一覧を見える所まで作ること（シーン一覧・変数・チェックの結果・素材）と、ブロック表示が変わったまとまりだけ作り直すことを、
 * lim studio の画面で操作して確かめる。
 *   npx tsx packages/studio/dev/verify-heavy.ts <スクリーンショットの置き場所> [ポート（既定 5318）]
 * dev/shapes.ts の many（ファイル 300・変数 3,000・警告 1,500・背景 2,000）を一時フォルダに作って開く。
 * 続けて long（8,000 行のファイル）をポート＋1 で開き、ブロック表示が見せる所から作って残りをあとから作ることを確かめる。
 * 結果は一行ずつ「ok」か「FAIL」で出す。終わったらサーバーを止める。
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { findChromium } from "../../cli/src/chromium.ts";
import { STUDIO_PAGE } from "../src/protocol.ts";
import { makeShape } from "./shapes.ts";

const shots = resolve(process.argv[2] ?? join(tmpdir(), "liminalia-verify-heavy"));
mkdirSync(shots, { recursive: true });
const port = Number(process.argv[3] ?? 5318);
const url = `http://localhost:${port}${STUDIO_PAGE}`;
const project = mkdtempSync(join(tmpdir(), "liminalia-verify-heavy-"));
const info = makeShape("many", project);

const server = spawn(process.execPath, [resolve(import.meta.dirname, "../../cli/bin/lim.mjs"), "studio", project, "--port", String(port)], { stdio: "ignore", env: { ...process.env, LIMINALIA_EXIT_WITH_PARENT: "1" } });
const failures: string[] = [];
const errors: string[] = [];
const expect = (label: string, ok: boolean, detail: unknown = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` ${JSON.stringify(detail)}`}`);
  if (!ok) failures.push(label);
};
try {
  for (let i = 0; ; i++) {
    if (await fetch(url).then((r) => r.ok).catch(() => false)) break;
    if (i > 120) throw new Error("lim studio が起動しません");
    await new Promise((r) => setTimeout(r, 500));
  }
  const browser = await chromium.launch({ executablePath: findChromium(), args: ["--mute-audio"] });
  const page = await browser.newPage({ locale: "ja-JP", viewport: { width: 1440, height: 900 } });
  const files = ((await (await fetch(`${url}/api/project`)).json()) as { files: { file: string }[] }).files.map((f) => f.file);
  await page.addInitScript((open: string) => {
    localStorage.setItem("liminalia.studio.tourDone", "1");
    localStorage.setItem("liminalia.studio.blocks", "0");
    localStorage.setItem("liminalia.studio.tocOpen", open);
  }, JSON.stringify(files));
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/favicon|404|409|autoplay/i.test(m.text()) && errors.push(m.text()));
  await page.goto(url);
  await page.waitForSelector(".cm-content");
  const app = <T>(code: string) => page.evaluate(`(async () => { const s = window.__liminaliaStudioApp; const ed = s.debug.editor; ${code} })()`) as Promise<T>;
  await app(`await s.open(${JSON.stringify(info.file)}, 1)`);
  await page.waitForTimeout(2000);

  /** その一覧をいちばん下までスクロールし続け、行の数が増えなくなるまで待つ。 */
  const scrollAll = async (scroller: string, rows: string) => {
    let last = -1;
    for (let i = 0; i < 80; i++) {
      const n = await page.locator(rows).count();
      if (n === last) break;
      last = n;
      await page.locator(scroller).first().evaluate((el) => el.scrollTo(0, el.scrollHeight));
      await page.waitForTimeout(150);
    }
    return page.locator(rows).count();
  };

  // 1. シーン一覧（300 ファイルを開いた状態）
  const tocFirst = await page.locator(".toc-group").count();
  expect("シーン一覧は、はじめは一部だけ作る", tocFirst > 0 && tocFirst < files.length, tocFirst);
  expect("今のファイルのシーンは作ってある", (await page.locator(".scene-row.on").count()) === 1);
  const tocAll = await scrollAll(await scrollContainer(page, ".toc-group"), ".toc-group");
  expect("スクロールすると全部のファイルが出る", tocAll === files.length, { tocAll, files: files.length });
  await page.screenshot({ path: join(shots, "01-toc.png") });

  // 2. ブロック表示: 一行を書き換えても、ほかのまとまりは作り直さない
  await app(`s.debug.setBlockMode(true)`);
  await page.waitForTimeout(800);
  await page.evaluate(`(() => { for (const el of document.querySelector(".blk-list").children) el.__kept = true; })()`);
  await app(`const line = ed.view.state.doc.line(${info.editLine}); ed.view.dispatch({ changes: { from: line.to, insert: "（足した）" } });`);
  await page.waitForTimeout(300);
  const kept = (await page.evaluate(`(() => { const all = [...document.querySelector(".blk-list").children]; return { all: all.length, kept: all.filter((el) => el.__kept).length }; })()`)) as { all: number; kept: number };
  expect("書き換えたまとまりのほかは、前の要素をそのまま使う", kept.kept === kept.all - 1, kept);
  expect("書き換えた行は新しい中身で出る", ((await page.locator(".blk-list").textContent()) ?? "").includes("（足した）"));
  await app(`ed.view.dispatch({ changes: { from: 0, insert: "// 頭に足した行\\n" } });`);
  await page.waitForTimeout(300);
  const rowLine = (await page.locator(".blk-text-row").first().getAttribute("data-from")) ?? "";
  await page.locator(".blk-text-row").first().click();
  await page.waitForTimeout(200);
  expect("行が下へずれたら、押したときの行もずれる", (await app<number>(`return ed.cursorLine()`)) === Number(rowLine), { rowLine });
  await app(`s.debug.setBlockMode(false)`);
  await page.waitForTimeout(500);

  // 3. 変数・チェック・素材
  for (const [id, , rows, total] of [
    ["variables", ".vars-body, .vars-table", ".vars-row:not(.vars-head)", 3003],
    ["check", ".check-problems", ".check-problems > li:not(.lazy-more)", 1500],
    ["assets", ".assets-grid", ".asset-tile", 2003],
  ] as const) {
    await app(`s.setSurface(${JSON.stringify(id)})`);
    await page.waitForSelector(rows, { timeout: 20000 });
    await page.waitForTimeout(500);
    const first = await page.locator(rows).count();
    expect(`${id}: はじめは一部だけ作る`, first > 0 && first < total, first);
    const scrollerOf = await scrollContainer(page, rows);
    const all = await scrollAll(scrollerOf, rows);
    expect(`${id}: スクロールすると全部出る`, all >= total, { all, total });
    await page.screenshot({ path: join(shots, `02-${id}.png`) });
  }
  // 4. フローチャート（ファイル 300 を積むと縦に長すぎるので、列に折り返す）
  await app(`s.setSurface("map")`);
  await page.waitForSelector(".map-card", { timeout: 60000 });
  await page.waitForTimeout(800);
  const zoomOf = async () => Number(((await page.locator(".map-zoom-value").textContent()) ?? "").replace("%", ""));
  const wrapBtn = page.locator(".map-wrap");
  expect("フローチャート: 折り返しのボタンが出て、折り返している", (await wrapBtn.isVisible()) && (await wrapBtn.getAttribute("aria-pressed")) === "true");
  await page.locator(".map-fit").click();
  await page.waitForTimeout(800);
  const fitZoom = await zoomOf();
  const nameSize = await page.evaluate(() => {
    const t = document.querySelector<HTMLElement>(".map-file-name");
    return t ? t.getBoundingClientRect().height : 0;
  });
  expect(`フローチャート: 全体を表示しても 10% より小さくしない（${fitZoom}%）`, fitZoom >= 10, fitZoom);
  expect(`フローチャート: 遠くから見てもファイルの名前は読める大きさ（${Math.round(nameSize)}px）`, nameSize >= 12, nameSize);
  expect("フローチャート: 収まらないときは全体図で場所を示す", await page.locator(".map-mini").isVisible());
  await page.screenshot({ path: join(shots, "04-map-wrapped.png") });
  // 折り返した並べ方でカードを動かすと、縦一列の座標で覚え、縦一列に戻すとその位置に出る
  for (let i = 0; i < 20 && (await zoomOf()) < 100; i++) {
    await page.locator(".map-zoom button").last().click();
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(500);
  // 欄の中に見えているカードを一枚選ぶ
  const id = await page.evaluate(() => {
    const r = document.querySelector(".map-scroll")!.getBoundingClientRect();
    const inside = [...document.querySelectorAll<HTMLElement>(".map-card")].find((c) => {
      const b = c.getBoundingClientRect();
      return b.left > r.left + 20 && b.top > r.top + 20 && b.right < r.right - 200 && b.bottom < r.bottom - 120;
    });
    return inside?.dataset.id ?? "";
  });
  const card = page.locator(`.map-card[data-id="${id}"]`);
  const box = (await card.boundingBox())!;
  const before = await card.evaluate((el) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) }));
  await page.mouse.move(box.x + 60, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 140, box.y + 100, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  const shown = await card.evaluate((el) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) }));
  const saved = ((await (await fetch(`${url}/api/studio-state`)).json()) as { mapPositions?: Record<string, { x: number; y: number }> }).mapPositions?.[id];
  expect("フローチャート: 動かしたカードは動かした所に出る", Math.abs(shown.x - before.x - 80) <= 2 && Math.abs(shown.y - before.y - 40) <= 2, { before, shown });
  await wrapBtn.click();
  await page.waitForTimeout(800);
  // 覚えた位置のあたりを出して、そのカードの位置を見る
  const stacked = await page.evaluate(
    async ([id, at]) => {
      const scroll = document.querySelector<HTMLElement>(".map-scroll")!;
      const z = Number(document.querySelector(".map-zoom-value")!.textContent!.replace("%", "")) / 100;
      scroll.scrollLeft = at.x * z - scroll.clientWidth / 2;
      scroll.scrollTop = at.y * z - scroll.clientHeight / 2;
      await new Promise((r) => setTimeout(r, 300));
      const el = document.querySelector<HTMLElement>(`.map-card[data-id="${CSS.escape(id)}"]`);
      return el ? { x: parseFloat(el.style.left), y: parseFloat(el.style.top) } : null;
    },
    [id, saved ?? { x: 0, y: 0 }] as const,
  );
  expect("フローチャート: 覚えた位置は縦一列の座標で、縦一列に戻すとそこに出る", !!saved && !!stacked && stacked.x === saved.x && stacked.y === saved.y, { saved, stacked, shown });
  expect("フローチャート: 縦一列に戻すと、ボタンは押していない形", (await wrapBtn.getAttribute("aria-pressed")) === "false");
  await wrapBtn.click();
  await page.waitForTimeout(500);
  expect("画面の誤りが無い", errors.length === 0, errors);
  await verifyLong(browser, port + 1);
  expect("長いファイルでも画面の誤りが無い", errors.length === 0, errors);
  await browser.close();
} finally {
  server.kill();
  rmSync(project, { recursive: true, force: true });
}
console.log(failures.length === 0 ? "\nすべて ok" : `\n失敗 ${failures.length} 件: ${failures.join(" / ")}`);
process.exit(failures.length === 0 ? 0 : 1);

/** その行を含むスクロールの欄に、目印の属性を付けて、その選び方を返す。 */
async function scrollContainer(page: Page, rows: string): Promise<string> {
  await page.locator(rows).first().evaluate((el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const o = getComputedStyle(p).overflowY;
      if (o === "auto" || o === "scroll") {
        document.querySelectorAll("[data-heavy-scroller]").forEach((x) => x.removeAttribute("data-heavy-scroller"));
        p.setAttribute("data-heavy-scroller", "");
        return;
      }
    }
  });
  return "[data-heavy-scroller]";
}

/**
 * 8,000 行のファイル（dev/shapes.ts の long）で、ブロック表示が見せる所から作り、残りをあとから作ることを確かめる。
 * 切り替える前に見ていた行が同じ所に出て、残りを作っている間も動かないこと・遠くの行へ移れること・全部を選ぶと後から作った行も選ばれること。
 */
async function verifyLong(browser: Browser, port: number): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "liminalia-verify-heavy-long-"));
  const info = makeShape("long", dir);
  const server = spawn(process.execPath, [resolve(import.meta.dirname, "../../cli/bin/lim.mjs"), "studio", dir, "--port", String(port)], { stdio: "ignore", env: { ...process.env, LIMINALIA_EXIT_WITH_PARENT: "1" } });
  const url = `http://localhost:${port}${STUDIO_PAGE}`;
  try {
    for (let i = 0; ; i++) {
      if (await fetch(url).then((r) => r.ok).catch(() => false)) break;
      if (i > 120) throw new Error("lim studio が起動しません");
      await new Promise((r) => setTimeout(r, 500));
    }
    const page = await browser.newPage({ locale: "ja-JP", viewport: { width: 1440, height: 900 } });
    await page.addInitScript(() => {
      localStorage.setItem("liminalia.studio.tourDone", "1");
      localStorage.setItem("liminalia.studio.blocks", "0");
    });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(url);
    await page.waitForSelector(".cm-content");
    const app = <T>(code: string) => page.evaluate(`(async () => { const s = window.__liminaliaStudioApp; const ed = s.debug.editor; ${code} })()`) as Promise<T>;
    await app(`await s.open(${JSON.stringify(info.file)}, 1)`);
    await page.waitForTimeout(2500);
    const pending = () => page.locator(".blk-pending").count();
    const waitFilled = async () => {
      for (let i = 0; i < 100 && (await pending()) > 0; i++) await page.waitForTimeout(100);
      return pending();
    };
    /** 一覧の上の端から、その行（無ければ後ろのいちばん近い行）までの距離。 */
    const offsetOf = (line: number) =>
      page.evaluate((line) => {
        const top = document.querySelector(".blk-scroll")!.getBoundingClientRect().top;
        const rows = [...document.querySelectorAll<HTMLElement>(".blk-list .blk-line-row")].filter((r) => Number(r.dataset.from) >= line);
        const row = rows.sort((a, b) => Number(a.dataset.from) - Number(b.dataset.from))[0];
        return row ? { line: Number(row.dataset.from), y: Math.round(row.getBoundingClientRect().top - top) } : null;
      }, line);

    // 1. コード表示で 4,000 行目あたりを見たまま、カーソルは 1 行目のまま切り替える
    const anchor = await app<{ line: number; offset: number }>(
      `const v = ed.view; v.scrollDOM.scrollTop = v.lineBlockAt(v.state.doc.line(4000).from).top; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return ed.scrollAnchor()`,
    );
    const ms = await app<number>(`const t = performance.now(); s.debug.setBlockMode(true); return Math.round(performance.now() - t)`);
    const first = await pending();
    const shown = await offsetOf(anchor.line);
    expect(`長いファイル: 切り替えは見せる所だけ作る（${ms}ms、仮の箱 ${first}）`, first > 0 && ms < 400, { ms, first });
    expect("長いファイル: 切り替える前に見ていた行が同じ所に出る", !!shown && shown.line - anchor.line < 5 && Math.abs(shown.y - anchor.offset) < 40, { anchor, shown });
    const left = await waitFilled();
    const after = await offsetOf(anchor.line);
    expect("長いファイル: 残りはあとから全部作る", left === 0, left);
    expect("長いファイル: 残りを作っている間も見ている所は動かない", !!after && !!shown && after.line === shown.line && Math.abs(after.y - shown.y) <= 2, { shown, after });
    await page.screenshot({ path: join(shots, "03-long-blocks.png") });

    // 2. 一行目から切り替えてすぐ、遠くの行へ移る（まだ作っていない所でも、その行が選ばれて見えている）
    // （一度作ったまとまりは使い回すので、開き直してから）
    await page.reload();
    await page.waitForSelector(".cm-content");
    await app(`await s.open(${JSON.stringify(info.file)}, 1)`);
    await page.waitForTimeout(2000);
    await app(`s.debug.setBlockMode(true)`);
    await page.waitForTimeout(50);
    const notYet = await page.locator(".blk-line-row[data-from='7896']").count();
    await app(`const v = ed.view; v.dispatch({ selection: { anchor: v.state.doc.line(7900).from } })`);
    await page.waitForTimeout(300);
    expect("長いファイル: 移る前は、遠くの行はまだ作っていない", notYet === 0, notYet);
    const on = await page.evaluate(() => {
      const row = document.querySelector<HTMLElement>(".blk-line-row.on");
      const box = document.querySelector(".blk-scroll")!.getBoundingClientRect();
      const r = row?.getBoundingClientRect();
      return row ? { from: Number(row.dataset.from), to: Number(row.dataset.to), visible: !!r && r.bottom > box.top && r.top < box.bottom } : null;
    });
    expect("長いファイル: 遠くの行も選ばれて見えている", !!on && on.from <= 7900 && on.to >= 7900 && on.visible, on);

    // 3. 一行目から切り替えてすぐ全部を選び、作っている途中に一字足す
    await app(`s.debug.setBlockMode(false)`);
    await app(`const v = ed.view; v.dispatch({ selection: { anchor: 0 }, scrollIntoView: true })`);
    await page.waitForTimeout(500);
    await app(`s.debug.setBlockMode(true)`);
    await page.locator(".blk-list").focus();
    await page.keyboard.press("ControlOrMeta+a");
    // 足すのは最初の本文の行（頭の続いたコメントの行は一つにまとめて畳み、二行目からは出さない。50473e5f）
    await app(`const n = ed.view.state.doc.toString().split("\\n").findIndex((l) => l.startsWith("　")) + 1; const line = ed.view.state.doc.line(n); ed.view.dispatch({ changes: { from: line.to, insert: "（途中で足した）" } })`);
    const left2 = await waitFilled();
    const sel = await page.evaluate(() => ({ rows: document.querySelectorAll(".blk-list .blk-line-row").length, inRange: document.querySelectorAll(".blk-list .blk-line-row.in-range").length }));
    expect("長いファイル: 作っている途中に直しても、残りを全部作る", left2 === 0, left2);
    expect("長いファイル: 途中で足した字が出る", ((await page.locator(".blk-list").textContent()) ?? "").includes("（途中で足した）"));
    expect("長いファイル: 全部を選ぶと、あとから作った行も選ばれる", sel.rows > 3000 && sel.inRange === sel.rows, sel);
    await page.close();
  } finally {
    server.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}
