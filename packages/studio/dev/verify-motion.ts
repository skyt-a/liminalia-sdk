/**
 * 制作画面の動き（motion.css と画面の切り替え）が実際に描かれるかを、lim studio の画面で一コマずつ測って確かめる。
 *   npx tsx packages/studio/dev/verify-motion.ts <スクリーンショットの置き場所> [ポート（既定 5314）]
 * ひな形（templates/default）を一時フォルダに写して開く。リポジトリのひな形は書き換えない。
 */
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import { findChromium } from "../../cli/src/chromium.ts";
import { STUDIO_PAGE } from "../src/protocol.ts";

const shots = resolve(process.argv[2] ?? join(tmpdir(), "liminalia-verify-motion"));
mkdirSync(shots, { recursive: true });
const port = Number(process.argv[3] ?? 5314);
const url = `http://localhost:${port}${STUDIO_PAGE}`;

const project = mkdtempSync(join(tmpdir(), "liminalia-verify-motion-"));
cpSync(resolve(import.meta.dirname, "../../../templates/default"), project, { recursive: true });
const server = spawn(process.execPath, [resolve(import.meta.dirname, "../../cli/bin/lim.mjs"), "studio", project, "--port", String(port)], { stdio: "ignore", env: { ...process.env, LIMINALIA_EXIT_WITH_PARENT: "1" } });
for (let i = 0; ; i++) {
  const up = await fetch(url).then((r) => r.ok).catch(() => false);
  if (up) break;
  if (i > 120) throw new Error("lim studio が起動しません");
  await new Promise((r) => setTimeout(r, 500));
}

const browser = await chromium.launch({ executablePath: findChromium(), args: ["--mute-audio"] });
const failures: string[] = [];
const errors: string[] = [];
const expect = (label: string, ok: boolean, detail: unknown = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` ${JSON.stringify(detail)}`}`);
  if (!ok) failures.push(label);
};

async function open(reducedMotion: "reduce" | "no-preference"): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion });
  await context.addInitScript('localStorage.setItem("liminalia.studio.tourDone", "1")');
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForSelector(".tabs-main .tab.on");
  await page.waitForTimeout(1500);
  return page;
}

/** click のあと 300ms、選んでいる地の左端を一コマごとに記録する。 */
function sampleMark(page: Page, container: string, target: string): Promise<{ lefts: number[]; end: number; want: number }> {
  return page.evaluate(
    async ([container, target]) => {
      const box = document.querySelector<HTMLElement>(container!)!;
      const button = box.querySelector<HTMLElement>(target!)!;
      const style = getComputedStyle(box, "::after");
      button.click();
      const lefts: number[] = [];
      const start = performance.now();
      while (performance.now() - start < 300) {
        await new Promise(requestAnimationFrame);
        lefts.push(parseFloat(style.left));
      }
      return { lefts, end: parseFloat(style.left), want: button.getBoundingClientRect().left - box.getBoundingClientRect().left };
    },
    [container, target],
  );
}

const page = await open("no-preference");

// 切り替えの地が滑る
{
  const mark = await sampleMark(page, ".tabs-main", ".tab:nth-child(2)");
  const between = mark.lefts.filter((x) => x > 4 && x < mark.want - 1);
  expect("上の帯の地が途中の位置を通る", between.length >= 3, mark.lefts);
  expect("上の帯の地が選んだタブに着く", Math.abs(mark.end - mark.want) < 1, mark);
  expect("動いたあと地は一つ（タブの地は透明）", (await page.locator(".tabs-main .tab.on").evaluate((el) => getComputedStyle(el).backgroundColor)) === "rgba(0, 0, 0, 0)");
  await page.screenshot({ path: join(shots, "01-map.png") });
  await page.locator(".tabs-main .tab").first().click();
  await page.waitForTimeout(400);
  const seg = await sampleMark(page, ".ed-tools .segmented, .segmented", ".seg:not([aria-pressed='true'])");
  expect("切り替えの部品の地も滑る", new Set(seg.lefts.map((x) => Math.round(x))).size >= 3, seg.lefts);
  await page.waitForTimeout(300);
}

// 別の群のタブへ移ると、もとの群の地は消える（position-visibility は計算値に出ないので、02-cast.png を目で見る）
{
  await page.locator(".tabs-more .tab").first().click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, "02-cast.png") });
}

// 画面の切り替えの動き
{
  const anims = await page.evaluate(async () => {
    const el = document.querySelector<HTMLElement>(".view-surface[data-view='map']")!;
    document.querySelector<HTMLElement>(".tabs-main .tab:nth-child(2)")!.click();
    const during = el.getAnimations().length;
    const visibleAtOnce = !el.hidden;
    await new Promise((r) => setTimeout(r, 300));
    return { during, visibleAtOnce, after: el.getAnimations().length };
  });
  expect("画面の中身は押したその時に替わる", anims.visibleAtOnce, anims);
  expect("画面の中身は薄く重なって出る", anims.during === 1, anims);
  expect("動きが終わると何も残らない", anims.after === 0, anims);
  await page.locator(".tabs-main .tab").first().click();
  await page.waitForTimeout(300);
}

// ⌘K は動かさない
{
  await page.keyboard.press("ControlOrMeta+k");
  await page.waitForSelector(".quick");
  const running = await page.evaluate(() => document.querySelector(".quick")!.closest(".overlay")!.getAnimations({ subtree: true }).length);
  expect("⌘K は動かない", running === 0, running);
  await page.keyboard.press("Escape");
}

// メニューを開いたボタンは押された見た目のまま
{
  await page.locator(".topbar-more").click();
  await page.waitForSelector(".ctx-menu");
  expect("メニューを開いたボタンに印が付く", await page.locator(".topbar-more").evaluate((el) => el.hasAttribute("data-open")));
  await page.screenshot({ path: join(shots, "03-menu.png") });
  await page.keyboard.press("Escape");
  expect("閉じると印が消える", await page.locator(".topbar-more").evaluate((el) => !el.hasAttribute("data-open")));
}

// お知らせは薄れて消える
{
  const notice = await page.evaluate(async () => {
    const el = document.querySelector<HTMLElement>(".notice")!;
    el.textContent = "確かめ";
    el.hidden = false;
    await new Promise((r) => setTimeout(r, 300));
    el.hidden = true;
    const style = getComputedStyle(el);
    const opacities: number[] = [];
    for (let i = 0; i < 6; i++) {
      await new Promise(requestAnimationFrame);
      if (style.display !== "none") opacities.push(Number(style.opacity));
    }
    await new Promise((r) => setTimeout(r, 300));
    return { opacities, end: style.display };
  });
  expect("お知らせは消えるあいだも描かれる", notice.opacities.some((x) => x > 0 && x < 1), notice);
  expect("お知らせは最後に消える", notice.end === "none", notice);
}

// 確かめる画面は動いて出る
{
  await page.locator(".topbar-export").click();
  await page.waitForSelector("dialog.dialog[open]");
  const running = await page.evaluate(() => document.querySelector("dialog.dialog[open]")!.getAnimations().length);
  expect("重ね欄は少し上から出る", running > 0, running);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(shots, "05-dialog.png") });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
}

// 案内の吹き出しは次の場所へ移る
{
  await page.locator(".topbar-more").click();
  await page.locator(".ctx-item").nth(1).click();
  await page.waitForSelector(".tour-bubble");
  await page.waitForTimeout(300);
  const moving = await page.evaluate(async () => {
    const bubble = document.querySelector<HTMLElement>(".tour-bubble")!;
    bubble.querySelector<HTMLElement>("button.primary")!.click();
    let seen = 0;
    for (let i = 0; i < 6; i++) {
      await new Promise(requestAnimationFrame);
      seen = Math.max(seen, bubble.getAnimations().length);
    }
    return seen;
  });
  expect("案内の吹き出しが動く", moving > 0, moving);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
}

// 配色の切り替えが終わると印が残らない（自動 → 明るい → 暗い と巡るので、変わるまで押す）
{
  const theme = await page.evaluate(async () => {
    const root = document.documentElement;
    const was = root.classList.contains("dark-theme");
    let swapping = false;
    for (let i = 0; i < 3 && root.classList.contains("dark-theme") === was; i++) {
      document.querySelector<HTMLElement>(".topbar-theme")!.click();
      swapping = root.classList.contains("theme-swap");
      await new Promise((r) => setTimeout(r, 500));
    }
    return { was, now: root.classList.contains("dark-theme"), swapping, left: root.classList.contains("theme-swap") };
  });
  expect("配色の切り替えが重なって進む", theme.swapping, theme);
  expect("配色が替わる", theme.was !== theme.now, theme);
  expect("切り替えの印が残らない", !theme.left, theme);
  await page.screenshot({ path: join(shots, "04-theme.png") });
}

// 動きを減らす設定では滑らない
{
  const calm = await open("reduce");
  const mark = await sampleMark(calm, ".tabs-main", ".tab:nth-child(2)");
  const running = await calm.evaluate(() => document.querySelector(".view-surface[data-view='map']")!.getAnimations().length);
  expect("動きを減らす設定では地が跳ぶ", mark.lefts.every((x) => Math.abs(x - mark.want) < 1), mark);
  expect("動きを減らす設定では画面も重ねない", running === 0, running);
  await calm.context().close();
}

expect("画面の誤りが無い", errors.length === 0, errors);
await browser.close();
server.kill();
rmSync(project, { recursive: true, force: true });
console.log(failures.length === 0 ? "\nすべて ok" : `\n失敗 ${failures.length} 件: ${failures.join(" / ")}`);
process.exit(failures.length === 0 ? 0 : 1);
