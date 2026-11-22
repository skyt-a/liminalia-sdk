/**
 * キーボードだけの操作と読み上げ（aria）を、lim studio の画面で確かめる。
 * - ブロック表示: 一覧は行を選ぶ listbox で、選んでいる行を aria-activedescendant で知らせ、台詞は「話者、本文」、命令の札は名前と要約で読む。
 *   行の「…」は Tab の順に入れず、Shift＋F10 で選んでいる行のメニューを開く。「/」でパーツを選んで足す
 * - パーツの欄: パーツはボタンで、探して Enter で最初のものを足し、↓ でパーツへ移って Enter で足す。⌘K に「パーツを挿入…」
 * - フローチャート: 作業面に入って矢印でカードを移り、Enter でその場面の台本へ移る。Shift＋F10 でカードのメニュー
 * - 綴りの確認: 英語の作品は台詞と地の文の字面だけに spellcheck の印、日本語の作品には付けない
 *   npx tsx packages/studio/dev/verify-a11y.ts <スクリーンショットの置き場所> [ポート（既定 5335。英語の作品は次の番号）]
 * ひな形（templates/default）と、英語の白紙の作品を一時フォルダに作って開く。結果は一行ずつ「OK」か「NG」で出す（NG でも終了コードは 0）。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import { findChromium } from "../../cli/src/chromium.ts";
import { STUDIO_PAGE } from "../src/protocol.ts";

const shots = resolve(process.argv[2] ?? join(tmpdir(), "liminalia-verify-a11y"));
mkdirSync(shots, { recursive: true });
const port = Number(process.argv[3] ?? 5335);
const LIM = resolve(import.meta.dirname, "../../cli/bin/lim.mjs");
const MOD = process.platform === "darwin" ? "Meta" : "Control";

const work = mkdtempSync(join(tmpdir(), "liminalia-verify-a11y-"));
const ja = join(work, "ja");
cpSync(resolve(import.meta.dirname, "../../../templates/default"), ja, { recursive: true });
const en = join(work, "en");
spawnSync(process.execPath, [LIM, "new", en, "--blank", "--lang", "en", "--title", "Spell"], { stdio: "ignore" });
writeFileSync(join(en, "scenario/start.lim"), ["# start", "@bg room.webp", "Akari \"I recieved the leter yesterday.\"", "The rain had stoped by morning.", ""].join("\n"));
writeFileSync(join(en, "cast.json"), `${JSON.stringify({ speakers: ["Akari"], cast: {} }, null, 2)}\n`);
const disk = (file: string) => readFileSync(join(ja, "scenario", `${file}.lim`), "utf8");

const servers: ChildProcess[] = [];
const stop = () => {
  for (const s of servers) s.kill();
  rmSync(work, { recursive: true, force: true });
};
process.on("exit", stop);
async function serve(dir: string, at: number): Promise<string> {
  const url = `http://localhost:${at}${STUDIO_PAGE}`;
  if (await fetch(url).then((r) => r.ok).catch(() => false)) throw new Error(`ポート ${at} はほかで使われています。止めてから流してください`);
  servers.push(spawn(process.execPath, [LIM, "studio", dir, "--port", String(at)], { stdio: "ignore", env: { ...process.env, LIMINALIA_EXIT_WITH_PARENT: "1" } }));
  for (let i = 0; ; i++) {
    if (await fetch(url).then((r) => r.ok).catch(() => false)) return url;
    if (i > 120) throw new Error("lim studio が起動しません");
    await new Promise((r) => setTimeout(r, 500));
  }
}

const results: string[] = [];
const ok = (name: string, cond: boolean, detail: unknown = "") => {
  const line = `${cond ? "OK  " : "NG  "} ${name}${!cond && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`;
  results.push(line);
  console.log(line);
};
const errors: string[] = [];
const browser = await chromium.launch({ executablePath: findChromium(), args: ["--mute-audio"] });

async function open(url: string, blocks: boolean): Promise<Page> {
  const context = await browser.newContext({ locale: "ja-JP", viewport: { width: 1440, height: 900 } });
  // パーツの欄は既定では閉じているので開いておく
  await context.addInitScript(`localStorage.setItem("liminalia.studio.tourDone", "1"); localStorage.setItem("liminalia.studio.blocks", "${blocks ? "1" : "0"}"); localStorage.setItem("liminalia.studio.closedPanels", '["flow"]')`);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/favicon|404|409|autoplay/i.test(m.text()) && errors.push(m.text()));
  await page.goto(url);
  await page.waitForSelector(".cm-content", { state: "attached" });
  await page.waitForTimeout(1500);
  return page;
}
const app = <T>(page: Page, code: string) => page.evaluate(`(() => { const s = window.__liminaliaStudioApp; const ed = s.debug.editor; ${code} })()`) as Promise<T>;
const editorText = (page: Page) => app<string>(page, "return ed.text()");
/** 一覧の読み上げの今の行（aria-activedescendant の指す要素）。 */
const active = (page: Page) =>
  page.evaluate(() => {
    const list = document.querySelector(".blk-list")!;
    const id = list.getAttribute("aria-activedescendant");
    const el = id ? document.getElementById(id) : null;
    return el ? { id, role: el.getAttribute("role"), selected: el.getAttribute("aria-selected"), label: el.getAttribute("aria-label"), from: Number(el.getAttribute("data-from")) } : null;
  });

try {
  const jaUrl = await serve(ja, port);
  const enUrl = await serve(en, port + 1);

  // ---- ブロック表示の読み上げ ----
  const page = await open(jaUrl, true);
  await page.waitForSelector(".blk-list .blk-line-row");
  const list = page.locator(".blk-list");
  const aria = await page.evaluate(() => {
    const list = document.querySelector(".blk-list")!;
    const rows = [...list.querySelectorAll(".blk-line-row")];
    const say = rows.find((r) => r.classList.contains("is-say"));
    const cue = rows.find((r) => r.classList.contains("blk-cue-row"));
    const label = rows.find((r) => r.classList.contains("blk-label"));
    return {
      role: list.getAttribute("role"),
      name: list.getAttribute("aria-label"),
      options: rows.every((r) => r.getAttribute("role") === "option" && r.id !== "" && r.hasAttribute("aria-selected")),
      say: say?.getAttribute("aria-label") ?? null,
      cue: cue?.getAttribute("aria-label") ?? null,
      label: label?.getAttribute("aria-label") ?? null,
      pages: [...list.querySelectorAll(".blk-page")].every((p) => p.getAttribute("role") === "group"),
      cues: [...list.querySelectorAll(".blk-cues")].every((c) => c.getAttribute("role") === "none"),
    };
  });
  ok("ブロック表示: 一覧は名前のある listbox で、行は id と選んでいるかを持つ option、ページは group", aria.role === "listbox" && !!aria.name && aria.options && aria.pages && aria.cues, aria);
  ok("ブロック表示: 台詞は「話者、本文」、命令の札は名前と要約、シーンは「シーン #名前」で読む", aria.say === "アカリ、「着いた……っ。この坂、こんなに長かったっけ」" && !!aria.cue && !aria.cue.startsWith("@") && aria.label === "シーン #start", aria);
  const tabStops = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".blk-list button, .blk-list [tabindex]")].filter((b) => b.tabIndex >= 0).map((b) => b.className));
  ok("ブロック表示: 行の「…」や×は Tab の順に入らない（一覧そのものが一つの入力の場所）", tabStops.length === 0, tabStops.slice(0, 5));

  // キーボードで行を選ぶと、今の行と選んでいる印が動く
  await list.focus();
  await app(page, "ed.gotoLine(23)");
  await page.waitForTimeout(400);
  const before = await active(page);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(300);
  const after = await active(page);
  ok("ブロック表示: ↓ で次の行へ移ると、aria-activedescendant と aria-selected がその行になる", !!before && !!after && after.from > before.from && after.role === "option" && after.selected === "true", { before, after });

  // Shift＋F10: 選んでいる行のメニュー。Esc で一覧へ戻る
  await page.keyboard.press("Shift+F10");
  await page.waitForTimeout(300);
  const menu = await page.evaluate(() => ({ open: !!document.querySelector(".ctx-menu"), focused: document.activeElement?.classList.contains("ctx-item") ?? false }));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  const back = await page.evaluate(() => document.activeElement?.classList.contains("blk-list") ?? false);
  ok("ブロック表示: Shift＋F10 で選んでいる行のメニューを開き、Esc で一覧へ戻る", menu.open && menu.focused && back, { menu, back });

  // 「/」: パーツを選んで、選んでいる行の後ろに足す
  const lines0 = (await editorText(page)).split("\n").length;
  await page.keyboard.press("/");
  await page.waitForSelector(".quick-list li", { timeout: 5000 }).catch(() => undefined);
  const insertList = await page.evaluate(() => ({ open: !(document.querySelector(".overlay") as HTMLElement | null)?.hidden, items: [...document.querySelectorAll(".quick-list li .quick-label")].slice(0, 3).map((e) => e.textContent) }));
  await page.keyboard.type("待つ");
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  const added = (await editorText(page)).split("\n");
  ok("ブロック表示: 「/」でパーツの一覧を開き、探して Enter で選んでいる行の後ろに足す", insertList.open && insertList.items.length > 0 && added.length === lines0 + 1 && added.some((l) => l.startsWith("@wait")), { insertList, lines: [lines0, added.length] });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // パーツの欄: パーツはボタン。探して Enter で最初のものを足す。↓ でパーツへ、Enter で足す
  const parts = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".blk-part")].slice(0, 20).every((p) => p.getAttribute("role") === "button" && p.tabIndex === 0 && !!p.getAttribute("aria-label")));
  await page.locator(".blk-search").focus();
  await page.keyboard.type("効果音");
  await page.waitForTimeout(300);
  const lines1 = (await editorText(page)).split("\n").length;
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  const afterSearch = await editorText(page);
  await page.locator(".blk-search").focus();
  await page.keyboard.press(`${MOD}+A`);
  await page.keyboard.type("背景");
  await page.waitForTimeout(300);
  await page.keyboard.press("ArrowDown");
  const partFocused = await page.evaluate(() => document.activeElement?.classList.contains("blk-part") ?? false);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  const afterPart = await editorText(page);
  await page.keyboard.press("Escape");
  await page.screenshot({ path: join(shots, "a11y-blocks.png") });
  ok("パーツの欄: パーツは名前のあるボタンで、探して Enter で最初のパーツを足す", parts && afterSearch.split("\n").length === lines1 + 1 && afterSearch.includes("@se"), { parts, lines: [lines1, afterSearch.split("\n").length] });
  ok("パーツの欄: ↓ でパーツへ移り、Enter で足す", partFocused && afterPart.split("\n").length === afterSearch.split("\n").length + 1, { partFocused });

  // ⌘K: 「パーツを挿入…」
  await list.focus();
  await page.keyboard.press(`${MOD}+KeyK`);
  await page.waitForTimeout(300);
  await page.keyboard.type("パーツを挿入");
  await page.waitForTimeout(200);
  const quick = await page.locator(".quick-list li.on .quick-label").textContent();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  const reopened = await page.evaluate(() => [...document.querySelectorAll(".quick-list li .quick-kind")].some((e) => e.textContent !== ""));
  await page.keyboard.press("Escape");
  ok("⌘K: 「パーツを挿入…」でパーツの一覧を開く", quick === "パーツを挿入…" && reopened, { quick, reopened });
  // 足した行を保存まで待ってから、ほかの確かめへ
  await page.waitForTimeout(1500);
  ok("足した行は台本に保存する", disk("start").split("\n").length >= lines0 + 3);

  // ---- フローチャート ----
  await page.keyboard.press("Control+2");
  await page.waitForSelector(".map-card");
  await page.waitForTimeout(600);
  const scroll = page.locator(".map-scroll");
  await scroll.focus();
  await page.waitForTimeout(300);
  const first = await page.evaluate(() => document.querySelector(".map-scroll")!.getAttribute("aria-activedescendant"));
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(500);
  const moved = await page.evaluate(() => {
    const scroll = document.querySelector(".map-scroll")!;
    const id = scroll.getAttribute("aria-activedescendant");
    const card = id ? document.getElementById(id) : null;
    return { role: scroll.getAttribute("role"), name: scroll.getAttribute("aria-label"), id, label: card?.getAttribute("aria-label") ?? null, focus: card?.classList.contains("is-focus") ?? false, data: card?.getAttribute("data-id") ?? null };
  });
  await page.screenshot({ path: join(shots, "a11y-map.png") });
  ok("フローチャート: 作業面に入るとカードを選び、↓ で下のカードへ移って読み上げに知らせる", !!first && !!moved.id && moved.id !== first && moved.focus && !!moved.label && moved.role === "group" && !!moved.name, { first, moved });
  await page.keyboard.press("Shift+F10");
  await page.waitForTimeout(300);
  const cardMenu = await page.locator(".ctx-menu .ctx-item").allTextContents();
  await page.keyboard.press("Escape");
  ok("フローチャート: Shift＋F10 でカードのメニューを開く", cardMenu.some((t) => t.includes("シーンを開く") || t.includes("開く")), cardMenu);
  await scroll.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  const opened = await app<{ file: string | null; line: number }>(page, "return { file: s.debug.file, line: ed.cursorLine() }");
  const label = moved.data?.split("#")[1] ?? "";
  const line = (await editorText(page)).split("\n")[opened.line - 1] ?? "";
  ok("フローチャート: Enter で選んでいるカードの場面の台本へ移る", !!label && line.trim() === `# ${label}`, { opened, line, label });
  await page.context().close();

  // ---- 綴りの確認 ----
  const enPage = await open(enUrl, false);
  // 関数を書くと tsx が名前を付ける助けを差し込み、ページで動かないので、式の文字で渡す
  const spell = (await enPage.evaluate(`(() => {
    const lines = [...document.querySelectorAll(".cm-line")];
    const marked = (i) => [...(lines[i]?.querySelectorAll('[spellcheck="true"]') ?? [])].map((e) => e.textContent).join("");
    return { command: marked(1), say: marked(2), prose: marked(3), content: document.querySelector(".cm-content")?.getAttribute("spellcheck") };
  })()`)) as { command: string; say: string; prose: string; content: string | null };
  ok("綴りの確認: 英語の作品は台詞と地の文の字面だけを確かめ、命令の行と話者の名前は確かめない", spell.command === "" && spell.say === '"I recieved the leter yesterday."' && spell.prose === "The rain had stoped by morning." && spell.content === "false", spell);
  await enPage.evaluate(() => (window as unknown as { __liminaliaStudioApp: { debug: { setBlockMode(on: boolean): void } } }).__liminaliaStudioApp.debug.setBlockMode(true));
  await enPage.waitForSelector(".blk-text-row");
  await enPage.locator(".blk-text-row .blk-text").first().click();
  await enPage.waitForTimeout(200);
  await enPage.locator(".blk-text-row .blk-text").first().click();
  await enPage.waitForTimeout(300);
  const blockSpell = await enPage.evaluate(() => ({ editing: document.querySelector(".blk-list")?.getAttribute("contenteditable"), spellcheck: (document.querySelector(".blk-list") as HTMLElement | null)?.spellcheck }));
  await enPage.screenshot({ path: join(shots, "a11y-spell.png") });
  ok("綴りの確認: 英語の作品のブロック表示のその場の編集も確かめる", !!blockSpell.editing && blockSpell.spellcheck === true, blockSpell);
  await enPage.context().close();
  const jaPage = await open(jaUrl, false);
  const jaSpell = await jaPage.evaluate(() => document.querySelectorAll('.cm-content [spellcheck="true"]').length);
  ok("綴りの確認: 日本語の作品には印を付けない", jaSpell === 0, jaSpell);
  await jaPage.context().close();
} finally {
  console.log("");
  for (const e of errors) console.log(`NG   画面のエラー — ${e}`);
  await browser.close();
  stop();
  writeFileSync(join(shots, "results.txt"), `${results.join("\n")}\n`);
}
