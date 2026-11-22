/**
 * 制作画面を lim studio と同じ開発サーバーで開き、Playwright で操作して確かめる（画面の開発用の確かめ）。
 *   npx tsx packages/studio/dev/verify.ts [スクリーンショットの置き場所]
 * ひな形（templates/default）を一時フォルダに写し、8,000 行級のファイル（ひな形の文を複製したもの）を足して開く。
 * 帯がファイル全体に出ること・素材の候補・点検の絞り込み・舞台が入力を奪わないこと・前の版から戻すことも確かめる。
 * 命令の行の舞台（その行を実行した直後の画面）・折り返した行での帯の横位置と幅・帯と札の覗き窓（画像の大きさと置き場所）・
 * 舞台の操作（止める・音を消す・大きく・全画面）と追従（舞台を押して進めると台本のカーソルが動く）、標準のキャラクター・素材のタブ・
 * 作品のプラグインの画面（例のスタンプ帳）・欄の幅も確かめる。
 * リポジトリのひな形は書き換えない。終わったらサーバーを止める。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadProject } from "@liminalia/project";
import { chromium, type Page } from "playwright-core";
import { findChromium } from "../../cli/src/chromium.ts";
import { startPlayerServer } from "../../cli/src/web.ts";
import { STUDIO_PAGE } from "../src/protocol.ts";
import { openGameSection } from "../test/game-section.ts";

const shots = resolve(process.argv[2] ?? join(import.meta.dirname, "../../../../studio-next-shots"));
const project = mkdtempSync(join(tmpdir(), "liminalia-studio-verify-"));
cpSync(resolve(import.meta.dirname, "../../../templates/default"), project, { recursive: true });
const scenario = join(project, "scenario");
// 作品のプラグインの画面（例の「スタンプ帳」）も確かめる
{
  const configPath = join(project, "liminalia.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as { plugins?: string[] };
  config.plugins = [resolve(import.meta.dirname, "../../../examples/stamp-plugin")];
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  mkdirSync(join(project, "assets/image/stamps"), { recursive: true });
  cpSync(join(project, "assets/bgimage/hill_night.webp"), join(project, "assets/image/stamps/star.png"));
}

// 8,000 行級のファイル。ひな形の本文を、ラベルと飛び先に番号を付けて複製する（頭のコメント（最初のラベルの前）は最初の一回だけ）。
{
  const src = readFileSync(join(scenario, "start.lim"), "utf8").split("\n");
  const first = src.findIndex((l) => /^# /.test(l));
  const body = src.slice(first).filter((l) => !l.startsWith("@jump epilogue"));
  const out = src.slice(0, first);
  for (let k = 0; out.length < 8000; k++) {
    for (const l of body) out.push(l.replace(/^# (\S+)/, `# $1_${k}`).replace(/(-> |@jump |@call )#([a-z_]+)/g, (_m, p: string, n: string) => `${p}#${n}_${k}`));
  }
  writeFileSync(join(scenario, "big.lim"), out.join("\n"));
}

// 持続の帯の横位置を確かめるファイル。左の列（BGM・ループの音）の帯が途中で出入りし、右の列（立ち絵）の帯は続き、本文の行は折り返す。
writeFileSync(
  join(scenario, "bands.lim"),
  [
    "# bands",
    "@bg hill_dusk.webp",
    "@bgm quiet_night.wav",
    "@chara アカリ normal at=left",
    "一行目。",
    "@se radio.wav loop=true channel=1",
    `二行目。${"とても長い本文の行が、画面の幅で折り返して二行にわたる。".repeat(4)}`,
    "@stop-se channel=1",
    "三行目。",
    "@stop-bgm",
    `四行目。${"これも長い本文の行で、折り返す。".repeat(6)}`,
    "@bgm quiet_night.wav",
    "五行目。",
    "@chara-hide アカリ",
    "六行目。",
  ].join("\n"),
);

// 英語の台詞（話者名の後ろの " “）。ブロック表示で台詞の札（顔・名前・本文）になるかを確かめる
writeFileSync(
  join(scenario, "english.lim"),
  ["# english", "@bg hill_dusk.webp", "@chara アカリ normal at=left", 'アカリ "Hello. You came."', "ソウ“Wait for me.”", 'アカリ{name ???} "Who are you."', 'Note: "this line is narration."', "アカリ「日本語の台詞」"].join("\n"),
);

const { server, url: playerUrl } = await startPlayerServer(loadProject(project), 0, true);
const base = playerUrl.replace(/\/$/, "");
const url = `${base}${STUDIO_PAGE}`;
const results: string[] = [];
const ok = (name: string, cond: boolean, detail = "") => results.push(`${cond ? "OK  " : "NG  "} ${name}${detail ? ` — ${detail}` : ""}`);

// 舞台の音（AudioContext）が押さなくても動くように
const browser = await chromium.launch({ executablePath: findChromium(), args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required"] });
const errors: string[] = [];
// 確かめはコード表示で行う（はじめの案内も出さない）。ブロック表示の確かめでは切り替える
{
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (options) => {
    const page = await newPage(options);
    await page.addInitScript(() => {
      if (localStorage.getItem("liminalia.studio.blocks") === null) localStorage.setItem("liminalia.studio.blocks", "0");
      localStorage.setItem("liminalia.studio.tourDone", "1");
    });
    return page;
  };
}

/** コード表示を確かめる（はじめはブロック表示で案内も出るので、切り替えて案内を済ませておく）。 */
async function newPage(options: Parameters<typeof browser.newPage>[0]): Promise<Page> {
  const page = await browser.newPage(options);
  await page.addInitScript('if (localStorage.getItem("liminalia.studio.blocks") === null) localStorage.setItem("liminalia.studio.blocks", "0"); localStorage.setItem("liminalia.studio.tourDone", "1")');
  return page;
}

async function open(scheme: "light" | "dark"): Promise<Page> {
  const page = await newPage({ locale: "ja-JP", viewport: { width: 1440, height: 900 }, colorScheme: scheme });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(url);
  await page.waitForSelector(".cm-content");
  await page.waitForTimeout(1500);
  return page;
}
const app = (page: Page, code: string) => page.evaluate(`(() => { const s = window.__liminaliaStudioApp; const ed = s.debug.editor; ${code} })()`);
const goto = async (page: Page, line: number) => {
  await app(page, `ed.gotoLine(${line})`);
  await page.waitForTimeout(600);
};
const lineText = (page: Page, line: number) => app(page, `return ed.state.doc.line(${line}).text`) as Promise<string>;
const disk = (file: string) => readFileSync(join(scenario, `${file}.lim`), "utf8");
const status = (page: Page) => page.locator(".save-status").textContent();
/** 画面に見えている帯（cls の種類）のうち、一番上か一番下のものの上の点（ポインタを乗せる所）。 */
const visibleBand = (page: Page, cls: string, which: "top" | "bottom") =>
  page.evaluate(
    ([cls, which]) => {
      // 台本の見えている部分（上の見出し・下の進み具合の一覧にかからないところ）
      const view = document.querySelector(".cm-scroller")!.getBoundingClientRect();
      const floor = view.bottom;
      const ceil = Math.max(0, view.top);
      const rects = [...document.querySelectorAll(`.lim-band.${cls}`)].map((b) => b.getBoundingClientRect()).filter((r) => r.height > 0 && r.bottom > ceil + 6 && r.top < floor);
      const r = which === "top" ? rects[0] : rects[rects.length - 1];
      return r ? { x: r.left + r.width / 2, y: which === "top" ? Math.max(r.top, ceil) + 6 : Math.min(r.bottom, floor) - 3 } : null;
    },
    [cls, which] as const,
  );
/** 覗き窓の画像の枠の大きさと、窓が画面の内（端から 8px の内）に収まっているか。 */
const peekGeometry = (page: Page) =>
  page.locator(".lim-peek").evaluate((el) => {
    const r = el.getBoundingClientRect();
    const f = el.querySelector(".lim-peek-image")?.getBoundingClientRect();
    const img = el.querySelector("img") as HTMLImageElement | null;
    return {
      frame: f ? [Math.round(f.width), Math.round(f.height)] : null,
      box: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
      inside: r.left >= 7.5 && r.top >= 7.5 && r.right <= innerWidth - 7.5 && r.bottom <= innerHeight - 7.5,
      loaded: (img?.complete && img.naturalWidth > 0) || false,
    };
  });

try {
  // ---- 素材の絞り込み・BGM の波形・ボイス（ほかの節の成否によらず確かめる） ----
  const assetsPage = await open("light");
  await assetsPage.locator(".tab", { hasText: "素材" }).click();
  await assetsPage.waitForSelector(".asset-tile", { timeout: 10000 });
  // 素材の絞り込み: 未使用だけ（断定しない言い方で出す）
  await assetsPage.locator('[data-filter="unused"]').click();
  ok("素材: 未使用だけで絞り、断定しない説明を出す", ((await assetsPage.locator(".assets-filter-note").textContent()) ?? "").includes("どこにも名前が出てきません"));
  await assetsPage.locator('[data-filter="unused"]').click();
  // BGM の波形とループの目印
  await assetsPage.locator(".assets-kind", { hasText: "BGM" }).click();
  await assetsPage.locator('.asset-tile[data-path="quiet_night.wav"]').click();
  await assetsPage.waitForSelector(".bgm-controls:not([hidden])", { timeout: 15000 });
  const painted = await assetsPage.evaluate(() => {
    const c = document.querySelector(".bgm-canvas") as HTMLCanvasElement;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    return d.some((v, i) => i % 4 === 3 && v > 0);
  });
  ok("素材: BGM を選ぶと波形と目印を出す", painted && (await assetsPage.locator(".bgm-mark").count()) === 2);
  await assetsPage.locator(".assets-kind", { hasText: "背景" }).click();
  // ボイス: 「その他の画面」のメニューから開き、台詞を並べる
  await assetsPage.locator(".topbar-screens").click();
  await assetsPage.locator(".ctx-item", { hasText: "ボイス" }).click();
  await assetsPage.waitForSelector(".voice-row", { timeout: 10000 });
  ok("ボイス: メニューから開き、台詞と状態を並べる", (await assetsPage.locator(".voice-status").count()) > 0);
  await assetsPage.screenshot({ path: join(shots, "voices-light.png") });
  await assetsPage.close();
} catch (e) {
  results.push(`NG  例外（素材とボイス）: ${e instanceof Error ? e.stack : String(e)}`);
}

try {
  // ---- 明るい配色: 編集 ----
  const page = await open("light");
  await goto(page, 113);
  await page.screenshot({ path: join(shots, "desk-light.png") });
  const flowLanes = await page.locator(".flow-lane").count();
  ok("演出の流れ（113 行: 本文・カメラ・立ち絵二人）", flowLanes === 4, `${await page.locator(".flow-name").allTextContents()}`);
  ok("事実（変数と決めた行）", (await page.locator(".facts .fact-line").count()) > 0);
  ok("今の舞台の状態（背景・立ち絵と、それを決めた行）", (await page.locator(".facts .fact.is-link").count()) >= 2, `${await page.locator(".facts .fact").allTextContents()}`);
  ok("舞台の下の行の表示", ((await page.locator(".stage-tag").textContent()) ?? "").includes("113 行目"));
  ok("道筋", ((await page.locator(".route").textContent()) ?? "").includes("はじめから"), (await page.locator(".route").textContent()) ?? "");
  ok("持続の帯（背景・BGM・立ち絵）", (await page.locator(".lim-lane-name").count()) >= 4, `${await page.locator(".lim-lane-name").allTextContents()}`);
  const bandTitle = await page.locator(".lim-band.is-start").first().getAttribute("aria-label");
  ok("帯の範囲の表示", /行から/.test(bandTitle ?? ""), bandTitle ?? "");

  // ---- 命令の行の舞台（その行を実行した直後・本文の前） ----
  {
    const stage = page.frameLocator(".stage-frame");
    const look = () =>
      stage.locator("body").evaluate(() => ({
        text: document.querySelector(".text")?.textContent ?? "",
        sprites: [...document.querySelectorAll(".sprites .sprite img")].map((i) => (i.getAttribute("src") ?? "").replace(/^.*\//, "")),
        background: (document.querySelector(".background img")?.getAttribute("src") ?? "").replace(/^.*\//, ""),
      }));
    const tag = async () => (await page.locator(".stage-tag").textContent()) ?? "";
    const settle = async (line: number) => {
      await goto(page, line);
      await page.waitForTimeout(900);
    };
    await settle(23);
    const page23 = await look();
    await settle(26);
    const show26 = await look();
    ok(
      "命令の行（26 行 @chara アカリ）: 立ち絵が出て本文は空",
      show26.sprites.length === 1 && show26.text === "" && (await tag()).includes("26 行目の直後") && (await app(page, "return s.debug.stageStill()")) === true,
      `${await tag()}・${JSON.stringify(show26)}（23 行: ${JSON.stringify(page23)}）`,
    );
    await stage.locator(".stage").click({ position: { x: 10, y: 10 } });
    await page.waitForTimeout(1200);
    const resumed = await look();
    ok("命令の行の画面を押すと、次の台詞から進む", resumed.text.includes("着いた") && resumed.sprites.length === 1, JSON.stringify(resumed));
    await settle(32);
    const show32 = await look();
    ok("命令の行（32 行 @chara ソウ）: 二人", show32.sprites.length === 2 && show32.text === "", JSON.stringify(show32));
    await page.screenshot({ path: join(shots, "stage-still-light.png") });
    await settle(44);
    const scene = await look();
    ok("命令の行（44 行 @scene・部品の呼び出し）: 呼んだ先から戻った時点で背景が替わり立ち絵は下がる", scene.background === "hill_night.webp" && scene.sprites.length === 0 && scene.text === "", JSON.stringify(scene));
    await settle(19);
    const bg19 = await look();
    ok("ファイルの頭の命令の行（19 行 @bg）も、その直後の画面", bg19.background === "hill_dusk.webp" && (await tag()).includes("19 行目の直後"), `${await tag()}・${JSON.stringify(bg19)}`);
    await settle(16);
    ok("変数: はじめはたたんでいる", (await page.locator(".facts-vars-toggle").getAttribute("aria-expanded")) === "false");
    await page.locator(".facts-vars-toggle").click();
    const facts16 = (await page.locator(".facts-vars").textContent()) ?? "";
    await settle(15);
    const facts15 = (await page.locator(".facts-vars").textContent()) ?? "";
    ok("@set の行で事実が変わる（16 行 @set game.looked）", /game\.looked\s*false\s*16/.test(facts16) && !facts15.includes("game.looked"), `${facts16.slice(0, 80)}／${facts15.slice(0, 60)}`);
    await settle(112);
    const flowNow = await page.locator(".flow-now").count();
    const later = await page.locator(".flow-blk.is-later").count();
    ok("命令の行の演出の流れ: 実行し終えた時点の印と、あとの命令・本文を薄く", flowNow === 1 && later >= 1, `印 ${flowNow}・薄い ${later}`);
    await page.screenshot({ path: join(shots, "flow-now-light.png") });
    await settle(27);
    const back = await look();
    ok(
      "本文の行に戻ると今どおり（その行のページ）",
      back.text.includes("着いた") && (await tag()).includes("27 行目") && JSON.stringify(await app(page, "return s.debug.stageShown()")) === JSON.stringify({ file: "start", line: 27 }),
      `${await tag()}・${back.text.slice(0, 20)}`,
    );
  }

  // ---- 英語の台詞: ブロック表示で台詞の札（名前と本文）になり、本文は引用符から ----
  {
    const en = await browser.newPage({ locale: "ja-JP", viewport: { width: 1440, height: 900 }, colorScheme: "light" });
    en.on("pageerror", (e) => errors.push(e.message));
    await en.addInitScript(() => localStorage.setItem("liminalia.studio.blocks", "1"));
    await en.goto(url);
    await en.waitForSelector(".blk-line-row", { timeout: 30000 });
    await en.waitForTimeout(1000);
    await en.keyboard.press("Meta+k");
    await en.keyboard.type("english.lim");
    await en.keyboard.press("Enter");
    await en.waitForTimeout(1500);
    const rows = (await en.evaluate(() =>
      [4, 5, 6, 7, 8].map((l) => {
        const row = document.querySelector(`.blk-line-row[data-from="${l}"]`);
        return [row?.querySelector(".blk-speaker-btn")?.textContent ?? "", row?.querySelector(".blk-text")?.textContent ?? ""];
      }),
    )) as [string, string][];
    const expected = [
      ["アカリ", '"Hello. You came."'],
      ["ソウ", "“Wait for me.”"],
      ["???（アカリ）", '"Who are you."'],
      ["", 'Note: "this line is narration."'],
      ["アカリ", "「日本語の台詞」"],
    ];
    ok("英語の台詞: ブロック表示で台詞の札になり、本文は引用符から（地の文と日本語の台詞はそのまま）", JSON.stringify(rows) === JSON.stringify(expected), JSON.stringify(rows));
    await en.locator('.blk-line-row[data-from="4"]').scrollIntoViewIfNeeded();
    await en.screenshot({ path: join(shots, "english-speech-blocks.png") });
    // その場の直しの途中でパーツをすばやくダブルクリックしても、直しを書き込んでから足す（離れたときの片付けを待たない）
    const lastRow = en.locator('.blk-line-row[data-from="8"]');
    await lastRow.click();
    await en.waitForTimeout(300);
    await lastRow.click();
    await en.waitForTimeout(400);
    await en.keyboard.press("End");
    await en.keyboard.type("追記");
    if (!(await en.locator(".blk-search").isVisible())) await en.locator('.panel-rail[data-panel="parts"]').click();
    await en.waitForTimeout(300);
    await en.locator(".blk-part:visible", { hasText: /^地の文$/ }).first().dblclick();
    await en.waitForTimeout(800);
    const after = [(await lineText(en, 8)) as string, (await lineText(en, 9)) as string, await en.locator(".blk-line-row.is-editing").count()] as const;
    ok("その場の直しの途中でパーツを足す: 直しを残し、足した行の直しが始まる", after[0].startsWith("アカリ「日本語の台詞") && after[0].includes("追記") && after[1] === "　" && after[2] > 0, JSON.stringify(after));
    await en.keyboard.press("Escape");
    await en.close();
  }

  // ---- 持続の帯: 折り返した行でも、同じ列の帯は同じ横位置・同じ幅 ----
  {
    const narrow = await newPage({ locale: "ja-JP", viewport: { width: 1000, height: 900 }, colorScheme: "light" });
    narrow.on("pageerror", (e) => errors.push(e.message));
    await narrow.goto(url);
    await narrow.waitForSelector(".cm-content");
    await narrow.waitForTimeout(1500);
    await narrow.keyboard.press("Meta+k");
    await narrow.keyboard.type("bands.lim");
    await narrow.keyboard.press("Enter");
    await narrow.waitForTimeout(1500);
    await goto(narrow, 5);
    await narrow.waitForTimeout(800);
    const geometry = async () =>
      (await narrow.evaluate(() => {
        const rows = [...document.querySelectorAll<HTMLElement>(".lim-bands-row")].filter((r) => r.parentElement!.offsetHeight > 0);
        const lanes: Record<string, string[]> = {};
        const breaks: string[] = [];
        let wrapped = 0;
        const min = Math.min(...rows.map((r) => r.parentElement!.offsetHeight));
        let prev: Map<string, { bottom: number; from: string; end: boolean }> = new Map();
        for (const row of rows) {
          if (row.parentElement!.offsetHeight > min * 1.6) wrapped++;
          const cur = new Map<string, { bottom: number; from: string; end: boolean }>();
          for (const band of row.querySelectorAll<HTMLElement>(".lim-band")) {
            const r = band.getBoundingClientRect();
            const lane = band.dataset.lane!;
            (lanes[lane] ??= []).push(`${r.left.toFixed(2)}/${r.width.toFixed(2)}`);
            const p = prev.get(lane);
            // 同じ帯の続きの行は、上の行の帯の下端と下の行の帯の上端が接する
            if (p && p.from === band.dataset.from && !p.end && Math.abs(p.bottom - r.top) > 0.5) breaks.push(`列 ${lane}: ${p.bottom.toFixed(1)}→${r.top.toFixed(1)}`);
            cur.set(lane, { bottom: r.bottom, from: band.dataset.from ?? "", end: band.classList.contains("is-end") });
          }
          prev = cur;
        }
        const head = document.querySelector<HTMLElement>(".lim-lane-head");
        const headShown = !!head && head.getBoundingClientRect().height > 0;
        const widths = [...new Set([...document.querySelectorAll<HTMLElement>(".lim-band")].map((e) => e.getBoundingClientRect().width.toFixed(1)))];
        return { rows: rows.length, wrapped, lanes: Object.fromEntries(Object.entries(lanes).map(([k, v]) => [k, [...new Set(v)]])), breaks, headShown, widths };
      })) as { rows: number; wrapped: number; lanes: Record<string, string[]>; breaks: string[]; headShown: boolean; widths: string[] };
    let g = await geometry();
    const same = (x: typeof g) => Object.values(x.lanes).every((v) => v.length === 1);
    ok(
      "帯: 左の列の帯が出入りしても、折り返した行でも、同じ列は同じ left・width",
      g.wrapped > 0 && Object.keys(g.lanes).length === 4 && same(g),
      `${g.rows} 行（折り返し ${g.wrapped}）・${Object.entries(g.lanes).map(([k, v]) => `列${k} ${v.join(",")}`).join("・")}`,
    );
    ok("帯: 同じ帯は行の境目で途切れない", g.breaks.length === 0, g.breaks.slice(0, 5).join("／"));
    ok("帯: 列の見出しは出さず、帯は 3px の縦線", !g.headShown && g.widths.length === 1 && g.widths[0] === "3.0", `見出し ${g.headShown}／幅 ${g.widths.join(",")}`);
    await narrow.screenshot({ path: join(shots, "bands-wrap-light.png") });
    // ひな形の物語（立ち絵が出入りするあたり）を、文字を大きくして折り返させても
    await narrow.keyboard.press("Meta+k");
    await narrow.keyboard.type("start.lim");
    await narrow.keyboard.press("Enter");
    await narrow.waitForTimeout(1500);
    for (let i = 0; i < 4; i++) await narrow.keyboard.press("Meta+=");
    await goto(narrow, 100);
    await narrow.waitForTimeout(800);
    g = await geometry();
    ok("帯: 文字を大きくして折り返させても同じ列は同じ left・width", g.wrapped > 0 && same(g) && g.breaks.length === 0, `${g.rows} 行（折り返し ${g.wrapped}）・${Object.entries(g.lanes).map(([k, v]) => `列${k} ${v.join(",")}`).join("・")}`);
    await narrow.screenshot({ path: join(shots, "bands-wrap-2-light.png") });
    await narrow.keyboard.press("Meta+0");
    await narrow.close();
  }

  // ---- 覗き窓: 帯・縮図・札にポインタを乗せると、背景・立ち絵の画像 ----
  {
    await goto(page, 33);
    await page.waitForTimeout(400);
    const hoverBand = async (cls: string) => {
      // 描かれていても見えていない（台本の上へ流れた）帯があるので、見えている帯に乗せる
      const at = (await visibleBand(page, cls, "top"))!;
      await page.mouse.move(at.x, at.y);
      await page.waitForTimeout(700);
      return page.locator(".lim-peek").evaluate((el) => ({
        visible: !(el as HTMLElement).hidden,
        text: el.textContent ?? "",
        img: (el.querySelector("img")?.getAttribute("src") ?? "").replace(/^.*\/assets\//, ""),
        loaded: (el.querySelector("img") as HTMLImageElement | null)?.naturalWidth ?? 0,
      }));
    };
    const bg = await hoverBand("lim-band-bg");
    ok("覗き窓: 背景の帯は範囲と背景の画像", bg.visible && bg.img.startsWith("bgimage/") && bg.loaded > 0 && bg.text.includes("行から"), JSON.stringify(bg));
    const bgGeo = await peekGeometry(page);
    ok("覗き窓: 背景の画像は 16:9 で幅 480px・画面の内", JSON.stringify(bgGeo.frame) === "[480,270]" && bgGeo.inside, JSON.stringify(bgGeo));
    await page.screenshot({ path: join(shots, "peek-bg-light.png") });
    const ch = await hoverBand("lim-band-ch");
    ok("覗き窓: 立ち絵の帯はその時点の差分の画像", ch.visible && ch.img.startsWith("fgimage/") && ch.loaded > 0, JSON.stringify(ch));
    const chGeo = await peekGeometry(page);
    ok("覗き窓: 立ち絵の画像は高さ 420px・画面の内", chGeo.frame?.[1] === 420 && chGeo.inside, JSON.stringify(chGeo));
    await page.screenshot({ path: join(shots, "peek-ch-light.png") });
    const bgm = await hoverBand("lim-band-bgm");
    ok("覗き窓: BGM は名前と範囲だけ", bgm.visible && bgm.img === "" && bgm.text.includes("BGM"), JSON.stringify(bgm));
    // 縮図
    const map = (await page.locator(".lim-minimap").boundingBox())!;
    await page.mouse.move(map.x + 3, map.y + map.height * 0.3);
    await page.waitForTimeout(700);
    const mapPeek = await page.locator(".lim-peek").evaluate((el) => ({ visible: !(el as HTMLElement).hidden, text: el.textContent ?? "", img: el.querySelector("img")?.getAttribute("src") ?? "" }));
    ok("覗き窓: 縮図の上でも", mapPeek.visible && mapPeek.img.includes("/assets/bgimage/"), JSON.stringify(mapPeek));
    // 縮図は画面の右端。窓はポインタの左へ出て、はみ出さない
    const mapGeo = await peekGeometry(page);
    ok("覗き窓: 右端（縮図）でも画面の内（ポインタの左へ）", mapGeo.inside && mapGeo.box[2]! <= map.x, JSON.stringify(mapGeo));
    // 画面の下の端に近い帯でも、上へ出してはみ出さない
    {
      const low = (await visibleBand(page, "lim-band-bg", "bottom"))!;
      await page.mouse.move(low.x, low.y);
      await page.waitForTimeout(700);
      const lowGeo = await peekGeometry(page);
      ok("覗き窓: 下の端の近くでも画面の内（ポインタの上へ）", lowGeo.inside && lowGeo.box[3]! <= low.y, `ポインタ y=${Math.round(low.y)}・${JSON.stringify(lowGeo)}`);
    }
    // 札（立ち絵）
    await goto(page, 26);
    await page.waitForTimeout(300);
    const chipBox = (await page.locator(".lim-chip-ch").first().boundingBox())!;
    await page.mouse.move(chipBox.x + 5, chipBox.y + 5);
    await page.mouse.move(chipBox.x + 8, chipBox.y + 6);
    await page.waitForTimeout(700);
    const chip = await page.locator(".lim-peek").evaluate((el) => ({ visible: !(el as HTMLElement).hidden, img: el.querySelector("img")?.getAttribute("src") ?? "", loaded: (el.querySelector("img") as HTMLImageElement | null)?.naturalWidth ?? 0 }));
    ok("覗き窓: 立ち絵の札は差分の画像", chip.visible && chip.img.includes("/assets/fgimage/") && chip.loaded > 0, JSON.stringify(chip));
    const chipGeo = await peekGeometry(page);
    ok("覗き窓: 札の立ち絵も高さ 420px・画面の内", chipGeo.frame?.[1] === 420 && chipGeo.inside, JSON.stringify(chipGeo));
    await page.screenshot({ path: join(shots, "peek-chip-light.png") });
    await page.mouse.move(700, 600);
    await page.waitForTimeout(200);
    ok("覗き窓: 離れると畳む", await page.locator(".lim-peek").evaluate((el) => (el as HTMLElement).hidden));

    // 読めるまでの枠: 画像を遅らせても、窓の大きさは読める前と後で同じ（新しいページで、画像の置き場を空にして）
    {
      const slow = await newPage({ locale: "ja-JP", viewport: { width: 1440, height: 900 }, colorScheme: "light" });
      await slow.route("**/assets/bgimage/hill_dusk.webp", async (route) => {
        await new Promise((r) => setTimeout(r, 2000));
        await route.continue().catch(() => {});
      });
      await slow.goto(url);
      await slow.waitForSelector(".cm-content");
      await slow.waitForTimeout(1500);
      await app(slow, "ed.gotoLine(21)");
      await slow.waitForTimeout(800);
      const sb = (await slow.locator(".lim-chip-bg", { hasText: "hill_dusk" }).first().boundingBox())!;
      await slow.mouse.move(sb.x + 5, sb.y + 5);
      await slow.mouse.move(sb.x + 8, sb.y + 6);
      await slow.waitForTimeout(250);
      const before = await peekGeometry(slow);
      await slow.waitForTimeout(2500);
      const after = await peekGeometry(slow);
      ok(
        "覗き窓: 読める前から同じ大きさの枠（窓が跳ねない）",
        !before.loaded && after.loaded && JSON.stringify(before.frame) === "[480,270]" && JSON.stringify(before.box) === JSON.stringify(after.box),
        `前 ${JSON.stringify(before)}・後 ${JSON.stringify(after)}`,
      );
      await slow.close();
    }

    // 小さな画面では、画面に合わせて縮める
    const small = await newPage({ locale: "ja-JP", viewport: { width: 1200, height: 360 }, colorScheme: "light" });
    await small.goto(url);
    await small.waitForSelector(".cm-content");
    await small.waitForTimeout(1500);
    await app(small, "ed.gotoLine(33)");
    await small.waitForTimeout(1200);
    for (const cls of ["lim-band-bg", "lim-band-ch"]) {
      const b = (await visibleBand(small, cls, "top"))!;
      await small.mouse.move(b.x, b.y);
      await small.waitForTimeout(700);
      const g = await peekGeometry(small);
      const [w, hgt] = g.frame ?? [0, 0];
      const ratio = cls === "lim-band-bg" ? 16 / 9 : 315 / 420;
      ok(`覗き窓: 低い画面（1200×360）では縮めて画面の内（${cls === "lim-band-bg" ? "背景" : "立ち絵"}）`, g.inside && hgt! < (cls === "lim-band-bg" ? 270 : 420) && Math.abs(w! / hgt! - ratio) < 0.03, JSON.stringify(g));
      await small.screenshot({ path: join(shots, `peek-small-${cls === "lim-band-bg" ? "bg" : "ch"}-light.png`) });
    }
    await small.close();
  }

  // 帯を押すと始まりの行へ。
  await goto(page, 60);
  await page.locator(".lim-band-bg").first().click();
  await page.waitForTimeout(300);
  ok("帯を押すと始まりの行へ", (await app(page, "return s.debug.editor.cursorLine()")) !== 60, `→ ${await app(page, "return s.debug.editor.cursorLine()")} 行`);

  // ---- 舞台が入力を奪わない・出した位置の返事 ----
  {
    await goto(page, 52);
    await page.waitForTimeout(1200);
    const stage = page.frameLocator(".stage-frame");
    const buttons = await stage.locator(".choices button").count();
    const inEditor = (await page.evaluate("document.activeElement?.closest('.cm-editor') !== null && document.activeElement?.tagName !== 'IFRAME'")) === true;
    const frameActive = await stage.locator("body").evaluate(() => document.activeElement?.tagName ?? "");
    ok("選択肢を出しても舞台に入力が移らない", buttons === 3 && inEditor && frameActive !== "BUTTON", `ボタン ${buttons}・舞台の中の入力 ${frameActive}`);
    await page.keyboard.press("End");
    await page.keyboard.type("あ");
    ok("打った文字は台本に入る", (await lineText(page, 52)) === "@choiceあ", await lineText(page, 52));
    await page.keyboard.press("Backspace");
    ok("舞台が出した位置を返す（選択肢）", JSON.stringify(await app(page, "return s.debug.stageShown()")) === JSON.stringify({ file: "start", line: 52 }), JSON.stringify(await app(page, "return s.debug.stageShown()")));
    await page.screenshot({ path: join(shots, "stage-choice-focus-light.png") });
    await goto(page, 113);
    await page.waitForTimeout(1200);
    ok("舞台が出した位置を返す（ページ）", JSON.stringify(await app(page, "return s.debug.stageShown()")) === JSON.stringify({ file: "start", line: 113 }), JSON.stringify(await app(page, "return s.debug.stageShown()")));
    await page.waitForTimeout(1200);
  }

  // ---- 舞台の操作: 止める・音を消す・大きく・全画面 ----
  {
    const stage = page.frameLocator(".stage-frame");
    const tag = async () => (await page.locator(".stage-tag").textContent()) ?? "";
    const controls = () => app(page, "return s.debug.stageControls()") as Promise<{ paused: boolean; muted: boolean; large: boolean; fullscreen: boolean; player: { paused: boolean; muted: boolean } | null }>;
    /** 舞台の中の様子: 本文・出し終えた文字の数・動いている演出の数・音（AudioContext と、足した <audio>）。 */
    const player = () =>
      stage.locator("body").evaluate(() => {
        const w = window as unknown as { __liminalia: { host: { audio: { context: AudioContext; isMuted: boolean; bgm: unknown } } } };
        const audio = w.__liminalia.host.audio;
        const el = document.querySelector<HTMLAudioElement>("audio.verify-audio");
        const anims = document.getAnimations();
        return {
          text: document.querySelector(".text")?.textContent ?? "",
          shownChars: document.querySelectorAll(".text .ch.shown").length,
          chars: document.querySelectorAll(".text .ch").length,
          running: anims.filter((a) => a.playState === "running").length,
          pausedAnims: anims.filter((a) => a.playState === "paused").length,
          context: audio.context.state,
          bgm: !!audio.bgm,
          muted: audio.isMuted,
          element: el ? { paused: el.paused, muted: el.muted, time: Math.round(el.currentTime * 10) / 10 } : null,
        };
      });
    /** 舞台の中に、鳴り続ける <audio> と、長い Web Animation を足す（動画・プラグインの演出の代わり）。 */
    const addMedia = () =>
      stage.locator("body").evaluate(async () => {
        const a = document.createElement("audio");
        a.className = "verify-audio";
        a.src = "assets/sound/radio.wav";
        a.loop = true;
        document.body.append(a);
        await a.play().catch(() => undefined);
        document.querySelector(".stage")!.animate([{ filter: "brightness(1)" }, { filter: "brightness(0.98)" }], { duration: 60_000 });
      });
    const key = (k: string) => page.keyboard.press(`Meta+Shift+${k}`);

    // 本文の文字送りの途中で止める
    await app(page, "ed.gotoLine(27)");
    for (let i = 0; i < 100; i++) {
      const p = await player();
      if (p.chars > 0 && p.text.includes("着いた")) break;
      await page.waitForTimeout(30);
    }
    await addMedia();
    await page.waitForTimeout(150);
    const running = await player();
    await page.locator(".stage-btn.stage-pause").click();
    await page.waitForTimeout(300);
    const paused = await player();
    const pausedTag = await tag();
    await page.waitForTimeout(1500);
    const later = await player();
    ok(
      "止める: 音のノード（AudioContext）と <audio> が止まる",
      running.context === "running" && running.bgm && paused.context === "suspended" && !!paused.element?.paused,
      `前 ${running.context}・後 ${paused.context}・audio ${JSON.stringify(paused.element)}`,
    );
    ok(
      "止める: 動いている演出（文字送り・Web Animations）が止まり、時間がたっても進まない",
      paused.running === 0 && paused.pausedAnims > 0 && later.shownChars === paused.shownChars && later.running === 0 && paused.shownChars < paused.chars,
      `動いている ${running.running} → ${paused.running}・止めた ${paused.pausedAnims}・出し終えた文字 ${paused.shownChars}/${paused.chars} → ${later.shownChars}`,
    );
    ok("止める: 「止めています」の印とボタン", (await page.locator(".stage-paused").isVisible()) && (await page.locator(".stage-btn.stage-pause").getAttribute("aria-pressed")) === "true" && (await controls()).player?.paused === true);
    await page.screenshot({ path: join(shots, "stage-paused-light.png") });
    // 止めている間にカーソルを動かしても、舞台は作り直さない（命令の行・選択肢の行・別の本文の行）
    for (const line of [26, 52, 113]) await goto(page, line);
    await page.waitForTimeout(800);
    const moved = await player();
    ok(
      "止める: カーソルを動かしても舞台が変わらない",
      moved.text === paused.text && moved.shownChars === paused.shownChars && (await tag()) === pausedTag && JSON.stringify(await app(page, "return s.debug.stageShown()")) === JSON.stringify({ file: "start", line: 27 }),
      `${await tag()}・${moved.text.slice(0, 16)}`,
    );
    ok("止める: 事実・演出の流れはカーソルの行に付いてくる", ((await page.locator(".flow-name").allTextContents()).length > 0), `${await page.locator(".flow-name").allTextContents()}`);
    // 止めている間は、舞台を押しても進まない
    const frameBox = (await page.locator(".stage-frame").boundingBox())!;
    await page.mouse.click(frameBox.x + frameBox.width / 2, frameBox.y + frameBox.height / 2);
    await page.waitForTimeout(400);
    const clicked = await player();
    ok("止める: 舞台を押しても進まない", clicked.text === paused.text && clicked.shownChars === paused.shownChars, `${clicked.shownChars}/${clicked.chars}`);
    // 舞台が入力を持っていても、舞台の操作のキーは効く（⌘⇧P で再開）
    await key("P");
    await page.waitForTimeout(1500);
    const resumed = await player();
    ok(
      "再開（⌘⇧P・舞台が入力を持っていても）: そのときのカーソルの行（113 行）を映し直し、音が戻る",
      (await tag()).includes("113 行目") && JSON.stringify(await app(page, "return s.debug.stageShown()")) === JSON.stringify({ file: "start", line: 113 }) && resumed.context === "running" && !(await page.locator(".stage-paused").isVisible()),
      `${await tag()}・${resumed.context}・${resumed.text.slice(0, 16)}`,
    );
    ok("再開: <audio> と演出も続きから動く", resumed.element?.paused === false && resumed.pausedAnims === 0, `${JSON.stringify(resumed.element)}・止めたまま ${resumed.pausedAnims}`);
    await app(page, "ed.view.focus()");
    await key("P");
    await page.waitForTimeout(300);
    ok("止める（⌘⇧P・台本で打っているとき）", (await controls()).paused && (await player()).context === "suspended");
    await key("P");
    await page.waitForTimeout(800);

    // 音を消す
    await page.locator(".stage-btn.stage-mute").click();
    await page.waitForTimeout(300);
    const muted = await player();
    ok(
      "音を消す: プレイヤーの音量が 0（止めずに）・<audio> も muted",
      muted.muted && muted.context === "running" && muted.element?.muted === true && muted.element.paused === false && (await controls()).player?.muted === true,
      JSON.stringify(muted),
    );
    await goto(page, 26);
    await page.waitForTimeout(900);
    await goto(page, 113);
    await page.waitForTimeout(1200);
    ok("音を消す: 舞台を作り直しても保つ", (await player()).muted, JSON.stringify(await controls()));
    await page.reload();
    await page.waitForSelector(".cm-content");
    await page.waitForTimeout(2500);
    ok(
      "音を消す: 開き直しても保つ（覚えておく）",
      (await player()).muted && (await page.locator(".stage-btn.stage-mute").getAttribute("aria-pressed")) === "true",
      JSON.stringify(await controls()),
    );
    await key("M");
    await page.waitForTimeout(300);
    ok("音を出す（⌘⇧M）", !(await player()).muted && !(await controls()).muted);
    await goto(page, 113);
    await page.waitForTimeout(1200);

    // 大きく（机の中）
    const boxSize = async () => {
      const b = (await page.locator(".stage-box").boundingBox())!;
      return { w: Math.round(b.width), h: Math.round(b.height), ratio: b.width / b.height };
    };
    const normal = await boxSize();
    const scriptNormal = (await page.locator(".script").boundingBox())!.width;
    await key("B");
    await page.waitForTimeout(500);
    const large = await boxSize();
    const scriptLarge = (await page.locator(".script").boundingBox())!.width;
    const flowBelow = (await page.locator(".flow").boundingBox())!.y >= (await page.locator(".stage-box").boundingBox())!.y + large.h - 1;
    ok(
      "大きく: 右の欄が広がり舞台が大きく（16:9）、台本は狭く、演出の流れは舞台の下",
      large.w > normal.w * 1.5 && Math.abs(large.ratio - 16 / 9) < 0.01 && scriptLarge < scriptNormal && flowBelow,
      `舞台 ${normal.w}×${normal.h} → ${large.w}×${large.h}・台本 ${Math.round(scriptNormal)} → ${Math.round(scriptLarge)}`,
    );
    await page.screenshot({ path: join(shots, "stage-large-light.png") });
    await key("B");
    await page.waitForTimeout(400);
    ok("大きく: ⌘⇧B で元の大きさ", (await boxSize()).w === normal.w && !(await controls()).large, JSON.stringify(await boxSize()));

    // 全画面（舞台だけ）
    await page.locator(".stage-btn.stage-fullscreen").click();
    await page.waitForTimeout(800);
    const fs = await page.evaluate(() => {
      const box = document.querySelector(".stage-box")!.getBoundingClientRect();
      return { element: document.fullscreenElement?.className ?? null, w: Math.round(box.width), h: Math.round(box.height), ratio: box.width / box.height, vw: innerWidth, vh: innerHeight, bottom: box.bottom };
    });
    ok(
      "全画面: 舞台（帯ごと）だけが全画面で、16:9 のまま画面に収まる",
      fs.element === "stage" && Math.abs(fs.ratio - 16 / 9) < 0.01 && fs.bottom <= fs.vh + 0.5 && (fs.w >= fs.vw - 1 || fs.h >= fs.vh - 60),
      JSON.stringify(fs),
    );
    await page.screenshot({ path: join(shots, "stage-fullscreen-light.png") });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
    let exited = await page.evaluate(() => document.fullscreenElement === null);
    if (!exited) {
      // 頭なしの Chromium は Esc で全画面を抜けない（ブラウザの画面が受けるキーのため）。⌘⇧Enter で抜ける
      await key("Enter");
      await page.waitForTimeout(600);
      exited = await page.evaluate(() => document.fullscreenElement === null);
      ok("全画面: ⌘⇧Enter で戻る（Esc は頭なしの Chromium では効かないので、デスクトップ版で確かめる）", exited);
    } else ok("全画面: Esc で戻る", exited);
    await key("Enter");
    await page.waitForTimeout(600);
    ok("全画面: ⌘⇧Enter でも入る", (await controls()).fullscreen);
    await key("Enter");
    await page.waitForTimeout(600);
    ok("全画面: ボタンの名前が戻る", (await page.locator(".stage-btn.stage-fullscreen").getAttribute("aria-label")) === "全画面" && !(await controls()).fullscreen);
    await stage.locator("body").evaluate(() => document.querySelector("audio.verify-audio")?.remove());
  }

  // ---- 追従: 舞台を押して進めると、台本のカーソルがその行へ（舞台は作り直さない） ----
  {
    const stage = page.frameLocator(".stage-frame");
    const where = () => app(page, "return { file: s.debug.file, line: ed.cursorLine(), focused: ed.view.hasFocus }") as Promise<{ file: string; line: number; focused: boolean }>;
    const follow = async () => ((await app(page, "return s.debug.stageControls()")) as { follow: boolean }).follow;
    /** 舞台が受けた制作画面からの頼み（stage-show・stage-still）の数。 */
    const requests = () => stage.locator("body").evaluate(() => (window as unknown as { __verifyShows?: number }).__verifyShows ?? 0);
    const waitFor = async (what: string, fn: () => Promise<boolean>) => {
      for (let i = 0; i < 100; i++) {
        if (await fn().catch(() => false)) return true;
        await page.waitForTimeout(100);
      }
      ok(what, false);
      return false;
    };
    /** 舞台が押し待ち（か選択肢）になってから、本文のあたりを押す（文字を出している途中の押しは、残りを出すだけ）。 */
    const press = async () => {
      await waitFor("追従: 舞台が押し待ちになる", () =>
        stage.locator("body").evaluate(() => {
          const h = (window as unknown as { __liminalia: { host: { waiting: boolean; choosing: boolean } } }).__liminalia.host;
          return h.waiting || h.choosing;
        }),
      );
      const box = (await page.locator(".stage-frame").boundingBox())!;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.6);
    };
    const reached = (file: string, line: number) => waitFor(`追従: ${file} の ${line} 行へ動く`, async () => {
      const w = await where();
      return w.file === file && w.line === line;
    });
    if ((await app(page, "return s.debug.stageControls().paused")) === true) await page.locator(".stage-btn.stage-pause").click();
    await goto(page, 113);
    await waitFor("追従: 舞台が 113 行を出す", async () => JSON.stringify(await app(page, "return s.debug.stageShown()")) === JSON.stringify({ file: "start", line: 113 }));
    await stage.locator("body").evaluate(() => {
      const w = window as unknown as { __verifyShows: number };
      w.__verifyShows = 0;
      addEventListener("message", (e) => {
        if (e.data?.type === "liminalia:stage-show" || e.data?.type === "liminalia:stage-still") w.__verifyShows++;
      });
    });
    await page.locator(".stage-btn.stage-follow").click();
    ok("追従: ボタンで入る", (await follow()) && (await page.locator(".stage-btn.stage-follow").getAttribute("aria-pressed")) === "true");
    await press();
    if (await reached("start", 114)) {
      const w = await where();
      ok("追従: 舞台を押すと次のページの行へ・台本に入力を移さない", !w.focused, JSON.stringify(w));
      ok("追従: 帯の表示が追従の行（舞台の状態）", /^114 行目（プレビューの状態）$/.test((await page.locator(".stage-tag").textContent()) ?? ""));
    }
    await page.screenshot({ path: join(shots, "stage-follow-light.png") });
    // 114 行は途中に押し待ち（{click}）がある。押してもまだ同じページ、もう一度で 116 行
    await press();
    await page.waitForTimeout(500);
    ok("追従: ページの途中の押し待ちではカーソルは動かない", (await where()).line === 114);
    await press();
    await reached("start", 116);
    await press();
    if (await reached("start", 117)) ok("追従: 選択肢を出すとその行へ", true);
    await stage.locator(".choices button", { hasText: "黙って" }).click();
    /** 事実の欄の、ある変数の行（値と出どころ）。 */
    const fact = (path: string) =>
      page
        .locator(".fact-var", { has: page.locator(".fact-var-name", { hasText: new RegExp(`^${path.replace(".", "\\.")}$`) }) })
        .evaluate((el) => `${el.textContent} ${el.querySelector(".fact-line")?.getAttribute("title") ?? ""}`);
    if (await reached("start", 135)) {
      ok("追従: 選ぶと選んだ先のページへ", true);
      // 事実の欄・道筋は、道筋どおり（最初の選択肢＝願いごとを言う）でなく、舞台で選んだ側（黙って見ている）で描く
      await waitFor("追従: 事実の欄が舞台で遊んだ状態になる", async () => (await page.locator(".facts.played .facts-played").isVisible()) && /（プレビュー）/.test((await page.locator(".facts-played").textContent()) ?? ""));
      const wished = await fact("game.wished");
      ok("追従: 事実の欄に舞台で選んだ側の変数と、値を入れた行が出る", /false/.test(wished ?? "") && /start 133/.test(wished ?? ""), wished ?? "");
      ok("追従: 帯の表示が舞台で遊んだ状態", /^135 行目（プレビューの状態）$/.test((await page.locator(".stage-tag").textContent()) ?? ""));
      const route = await page.locator(".route").textContent();
      ok("追従: 道筋に舞台で選んだ選択肢が印付きで出る", /ルート（プレビュー）/.test(route ?? "") && (await page.locator(".route .route-played", { hasText: "黙って見ている" }).count()) === 1, route ?? "");
      await page.screenshot({ path: join(shots, "stage-follow-played.png") });
    }
    ok("追従: 舞台を作り直さない", (await requests()) === 0, `頼み ${await requests()} 回`);
    // 台本が入力を持っている間は動かさない（舞台が進んだ知らせをまねる）
    await app(page, "ed.view.focus()");
    await stage.locator("body").evaluate(() => parent.postMessage({ type: "liminalia:stage-progress", at: { file: "start", line: 141 } }, location.origin));
    await page.waitForTimeout(400);
    ok("追従: 台本で打っている間は動かさない", (await where()).line === 135);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    // @jump でほかのファイルへ
    for (const line of [136, 137, 149, 150]) {
      await press();
      await reached("start", line);
    }
    await press();
    if (await reached("epilogue", 10)) {
      ok("追従: ほかのファイルへ進むと、そのファイルを開いてその行へ", (await requests()) === 0, `頼み ${await requests()} 回`);
      await waitFor("追従: ほかのファイルでも事実の欄が舞台で遊んだ状態", async () => /false/.test((await fact("game.wished")) ?? ""));
      ok("追従: ほかのファイルでも舞台で選んだ選択肢が道筋に出る", (await page.locator(".route .route-played", { hasText: "黙って見ている" }).count()) === 1);
    }
    await page.keyboard.press("Meta+Shift+J");
    ok("追従: ⌘⇧J でやめる", !(await follow()));
    await press();
    await page.waitForTimeout(800);
    ok("追従: やめると舞台が進んでもカーソルは動かない", (await where()).line === 10);
    await app(page, "s.open('start', 113)");
    await page.waitForTimeout(800);
    ok("追従: 台本からカーソルを動かすと、事実の欄は現在地の状態（道筋どおり）に戻る", (await page.locator(".facts.played").count()) === 0 && !/ルート（プレビュー）/.test((await page.locator(".route").textContent()) ?? ""));
  }

  // ---- 打鍵と同じ行の中のカーソル移動では、舞台を作り直さない（手が止まって、保存した中身が届いてから映す） ----
  {
    const stage = page.frameLocator(".stage-frame");
    const requests = () => stage.locator("body").evaluate(() => (window as unknown as { __verifyTyped?: number }).__verifyTyped ?? 0);
    await goto(page, 113);
    await page.waitForTimeout(800);
    await stage.locator("body").evaluate(() => {
      const w = window as unknown as { __verifyTyped: number };
      w.__verifyTyped = 0;
      addEventListener("message", (e) => {
        if (e.data?.type === "liminalia:stage-show" || e.data?.type === "liminalia:stage-still") w.__verifyTyped++;
      });
    });
    await app(page, "ed.view.focus(); ed.view.dispatch({ selection: { anchor: ed.state.doc.line(113).to } })");
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("ArrowLeft");
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(600);
    ok("打鍵: 同じ行の中でカーソルを動かしても舞台を作り直さない", (await requests()) === 0, `頼み ${await requests()} 回`);
    await page.keyboard.type("あいうえお", { delay: 150 });
    await page.waitForTimeout(300);
    ok("打鍵: 打っている途中は舞台を作り直さない", (await requests()) === 0, `頼み ${await requests()} 回`);
    // 保存するとプレイヤーが読み直し、最後に頼んだ画面を出し直す
    let shown = "";
    for (let i = 0; i < 50 && !shown.includes("あいうえお"); i++) {
      await page.waitForTimeout(200);
      shown = (await stage.locator("body").textContent().catch(() => "")) ?? "";
    }
    ok("打鍵: 手が止まって保存したら、打った文字が舞台に出る", shown.includes("あいうえお"));
    for (let i = 0; i < 5; i++) await page.keyboard.press("Backspace");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.waitForTimeout(2500);
  }

  // ---- 全ファイルの置換・シーンの名前の変更・ブロック表示の印・プレビューの値を変えて試す ----
  {
    const gaps = join(scenario, "gaps.lim");
    writeFileSync(gaps, ["# gaps_top", "@set game.score = 1", "　一ページ目。ほしぞら。", "　二ページ目。", "@if game.score == 99", "　九十九の道。", "@else", "　ふつうの道。", "@end", "@jump #gaps_end", "# gaps_end", "　おわり。"].join("\n"));
    writeFileSync(join(scenario, "gaps2.lim"), ["# far", "　遠くのほしぞら。", "@jump gaps#gaps_end"].join("\n"));
    await page.waitForTimeout(800);
    await page.keyboard.press("Meta+k");
    await page.keyboard.type("gaps.lim");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1500);
    // 置換
    await page.keyboard.press("Meta+Shift+f");
    await page.locator(".toc-search").first().fill("ほしぞら");
    await page.locator(".toc-replace-toggle").click();
    await page.locator(".toc-replace").fill("流星");
    await page.waitForSelector(".replace-line");
    ok("全ファイルの置換: 当たった行をファイルごとに見本つきで並べる", (await page.locator(".replace-file").count()) === 2 && (await page.locator(".replace-hit ins").first().textContent()) === "流星");
    await page.locator(".replace-run").click();
    await page.waitForFunction(() => document.querySelector(".replace-report")?.textContent?.includes("2 ファイル"));
    ok("全ファイルの置換: ほかのファイルは書き込み口で書く", disk("gaps2").includes("流星"));
    ok("全ファイルの置換: 開いているファイルはエディタの変更", ((await app(page, "return ed.text()")) as string).includes("流星"));
    await page.locator(".toc-replace-toggle").click();
    await page.locator(".toc-search").first().fill("");
    await page.waitForTimeout(400);
    await page.locator('.toc-file[data-file="gaps"] .toc-file-fold').click();
    await page.waitForTimeout(300);
    // シーンの名前
    await page.locator(".scene-row", { hasText: "gaps_end" }).first().click({ button: "right" });
    await page.locator(".ctx-item", { hasText: "シーンの名前を変更" }).click();
    await page.locator(".scene-rename-input").fill("gaps_top");
    await page.keyboard.press("Enter");
    ok("シーンの名前: 同じファイルの重複は断る", await page.locator(".scene-rename-problem").isVisible());
    await page.locator(".scene-rename-input").fill("gaps_last");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".notice")?.textContent?.includes("シーンの名前"));
    ok("シーンの名前: 参照も書き換える", disk("gaps").includes("# gaps_last") && disk("gaps").includes("@jump #gaps_last") && disk("gaps2").includes("@jump gaps#gaps_last"));
    await page.waitForTimeout(800);
    // ブロック表示の印
    await page.keyboard.press("Meta+e");
    await page.waitForSelector(".blk-banner");
    await goto(page, 3);
    await page.locator('.blk-line-row[data-from="4"]').click({ button: "right" });
    await page.locator(".ctx-item", { hasText: "ブレークポイント" }).click();
    ok("ブロック表示: 右クリックでブレークポイント", (await page.locator('.blk-line-row[data-from="4"] .blk-mark-break').count()) === 1);
    await page.locator('.blk-line-row[data-from="3"]').click({ button: "right" });
    await page.locator(".ctx-item", { hasText: "コメントを付ける" }).click();
    await page.locator(".review-new textarea").fill("確かめのコメント");
    await page.keyboard.press("Meta+Enter");
    await page.waitForSelector('.blk-line-row[data-from="3"] .blk-mark-review');
    ok("ブロック表示: コメントの印を押すとスレッドが出る", (await page.locator(".review-pane .review-body").textContent()) === "確かめのコメント");
    await goto(page, 3);
    await page.waitForTimeout(800);
    const stageFrame = page.locator(".stage-frame");
    for (let i = 0; i < 4 && (await page.locator(".blk-line-row.is-stopped").count()) === 0; i++) {
      await stageFrame.click();
      await page.waitForTimeout(500);
    }
    ok("ブロック表示: ブレークポイントで止まった行が分かる", (await page.locator(".blk-line-row.is-stopped").getAttribute("data-from")) === "4");
    // 値を変えて試す（止まっている間に変え、再開するとその値で分岐する）
    if ((await page.locator(".facts-vars-toggle").getAttribute("aria-expanded")) !== "true") await page.locator(".facts-vars-toggle").click();
    const score = page.locator('.fact-var[data-var="game.score"]');
    await score.locator(".fact-var-value").click();
    await page.locator(".fact-var-input").fill("99");
    await page.keyboard.press("Enter");
    await page.waitForSelector('.fact-var[data-var="game.score"] .fact-var-changed');
    await page.keyboard.press("Meta+Shift+p");
    await page.waitForTimeout(400);
    const line = async () => ((await app(page, "return s.debug.stageShown()")) as { line: number } | null)?.line;
    for (let i = 0; i < 6 && (await line()) !== 6 && (await line()) !== 8; i++) {
      await stageFrame.click();
      await page.waitForTimeout(500);
    }
    ok("値を変えて試す: 再開するとその値で分岐が進む", (await line()) === 6, `行 ${await line()}`);
    ok("値を変えて試す: ファイルには書かない", disk("gaps").includes("@set game.score = 1") && !readFileSync(join(project, "liminalia.json"), "utf8").includes("score"));
    await goto(page, 3);
    await page.waitForTimeout(800);
    ok("値を変えて試す: 組み立て直すと現在地の値に戻る", (await score.locator(".fact-var-value").textContent()) === "1" && ((await page.locator(".fact-var-note").textContent()) ?? "").includes("戻りました"));
    await page.locator('.blk-line-row[data-from="4"] .blk-mark-break').click();
    await page.keyboard.press("Meta+e");
    await page.keyboard.press("Meta+k");
    await page.keyboard.type("start.lim");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1200);
  }

  // ---- タブ: 標準のキャラクター（⌘3）〜作品（⌘8）と作品のプラグインの画面（⌘9）、欄の幅 ----
  {
    const tabs = (await page.locator(".topbar .tab").allTextContents()).map((t) => t.replace(/\d+$/, ""));
    ok("タブ: 主な画面（編集・地図・点検）、そのほかの画面（キャラクター・素材・変数・ゲームの設定・ゲームの画面・プラグインの画面）の順", tabs.join(" ") === "シナリオ フローチャート チェック キャラクター 素材 変数 ゲームの設定 ゲームの画面 プラグイン", tabs.join(" "));
    await goto(page, 113);
    await page.keyboard.press("Control+4");
    await page.waitForSelector(".chars-item", { timeout: 10000 });
    await page.waitForTimeout(400);
    ok("キャラクター: ⌘3 で開き、台本のカーソルの行のキャストを選ぶ", ((await page.locator(".chars-item.on .chars-name").textContent()) ?? "") === "ソウ");
    await page.screenshot({ path: join(shots, "chars-light.png") });
    await page.locator(".chars-bar .seg", { hasText: "位置" }).click();
    let caster: import("playwright-core").Frame | null = null;
    for (let i = 0; i < 50 && !caster; i++) {
      const f = page.frames().find((x) => x.url().includes("/__liminalia/cast"));
      if (f && (await f.evaluate(() => "__liminaliaCaster" in window).catch(() => false))) caster = f;
      else await page.waitForTimeout(200);
    }
    await page.waitForTimeout(600);
    ok("キャラクター: 位置で立ち絵の位置調整画面を開き、同じ立ち絵を選ぶ", (await caster?.evaluate(() => (document.getElementById("who") as HTMLSelectElement).value)) === "ソウ");
    await page.screenshot({ path: join(shots, "cast-tab-light.png") });
    await page.locator(".chars-bar .seg", { hasText: "設定" }).click();
    // 素材
    await page.keyboard.press("Control+5");
    await page.waitForSelector(".asset-tile", { timeout: 10000 });
    ok("素材: ⌘4 で開き、背景を並べる", (await page.locator(".asset-tile img").count()) > 0);
    await page.screenshot({ path: join(shots, "assets-light.png") });
    // 地図: 台本のカーソルの場面を照らす
    await page.keyboard.press("Control+2");
    await page.waitForSelector(".map-card", { timeout: 30000 });
    await page.waitForTimeout(1500);
    const mapInfo = await page.evaluate(() => ({
      nodes: document.querySelectorAll(".map-card").length,
      current: document.querySelector(".map-card.is-current")?.getAttribute("data-id") ?? null,
      choices: document.querySelectorAll(".map-choice").length,
      pictures: [...document.querySelectorAll<HTMLElement>(".map-pic")].filter((p) => p.style.backgroundImage !== "").length,
    }));
    ok("地図: ⌘5 で開き、場面のカード（絵つき）と選択肢の札を並べ、カーソルの場面を照らす", mapInfo.nodes > 5 && mapInfo.choices > 0 && mapInfo.current !== null && mapInfo.pictures > 0, JSON.stringify(mapInfo));
    await page.screenshot({ path: join(shots, "map-light.png") });
    await page.keyboard.press("Control+6");
    await page.waitForSelector(".vars-row:not(.vars-head)", { timeout: 10000 });
    ok("変数: ⌘6 で開き、台本の変数を並べる", (await page.locator(".vars-row:not(.vars-head)").count()) > 0);
    await page.keyboard.press("Control+7");
    // 欄は見出しで開いたカテゴリの分だけ出る（99dc20ae）。カテゴリの見出しと見本を確かめ、使うカテゴリは開いてから書く
    await page.waitForSelector(".game-section", { timeout: 10000 });
    ok("ゲームの設定: ⌘7 で開き、項目のカテゴリと見本を出す", (await page.locator(".game-section").count()) > 5 && (await page.locator(".game-frame").count()) === 1);
    // 起動の演出（ui.splash）を、JSON を書かずに項目ごとの欄で書く
    {
      const sec = await openGameSection(page, "splash");
      await sec.scrollIntoViewIfNeeded();
      await sec.locator('[data-field="splash.logos"] .game-list-add').click();
      await sec.locator('[data-field="splash.logos"] .game-list-row select').first().selectOption({ index: 1 });
      await sec.locator('[data-field="splash.notice.title"] input').fill("はじめに");
      await sec.locator('[data-field="splash.notice.blocks"] .game-list-add').click();
      await sec.locator('[data-field="splash.notice.blocks"] .game-list-row textarea').fill("この物語はフィクションです。");
      await sec.locator('[data-field="splash.notice.auto"] input').uncheck();
      await sec.locator('[data-field="splash.fade"] input').fill("900");
      await sec.locator('[data-field="splash.fade"] input').press("Tab");
      await page.waitForTimeout(1200);
      const splash = (JSON.parse(readFileSync(join(project, "liminalia.json"), "utf8")) as { ui?: { splash?: { logos?: { image?: string }[]; notice?: { title?: string; blocks?: { text: string }[]; auto?: boolean }; fade?: number } } }).ui?.splash;
      ok("ゲームの設定: 起動の演出のロゴと注意書きを欄で書く", !!splash?.logos?.[0]?.image && splash.notice?.title === "はじめに" && splash.notice.blocks?.[0]?.text === "この物語はフィクションです。" && splash.notice.auto === false && splash.fade === 900, JSON.stringify(splash));
      await sec.screenshot({ path: join(shots, "game-splash.png") });
    }
    // 立ち絵の見せ方（ui.chara）: 話者強調を選んで強さを書く
    {
      const sec = await openGameSection(page, "chara");
      await sec.scrollIntoViewIfNeeded();
      await sec.locator('[data-field="chara.focus"] select').selectOption("dim-lower");
      await sec.locator('[data-field="chara.lower"] input').fill("10");
      await sec.locator('[data-field="chara.lower"] input').press("Tab");
      await page.waitForTimeout(1200);
      const chara = (JSON.parse(readFileSync(join(project, "liminalia.json"), "utf8")) as { ui?: { chara?: { focus?: string; lower?: number } } }).ui?.chara;
      ok("ゲームの設定: 立ち絵の見せ方で話者強調を選ぶ", chara?.focus === "dim-lower" && chara.lower === 10, JSON.stringify(chara));
      await sec.screenshot({ path: join(shots, "game-chara.png") });
    }
    // 背景ごとの色調（ui.backgroundTones）を、背景の絵と色調の名前の組で書く（確かめたら外す）
    {
      const sec = await openGameSection(page, "tones");
      const field = sec.locator('[data-field="backgroundTones"]');
      await field.scrollIntoViewIfNeeded();
      await field.locator(".game-list-add").click();
      const row = field.locator(".game-list-row").last();
      await row.locator("select").selectOption("hill_night.webp");
      await row.locator('input[type="text"]').fill("night");
      await row.locator('input[type="text"]').press("Tab");
      await page.waitForTimeout(1200);
      const read = () => (JSON.parse(readFileSync(join(project, "liminalia.json"), "utf8")) as { ui?: { backgroundTones?: Record<string, string> } }).ui?.backgroundTones;
      const tones = read();
      ok("ゲームの設定: 背景ごとの色調を欄で書く", tones?.["hill_night.webp"] === "night", JSON.stringify(tones));
      await sec.screenshot({ path: join(shots, "game-background-tones.png") });
      await row.locator(".icon-btn").click();
      await page.waitForTimeout(1200);
      ok("ゲームの設定: 背景ごとの色調の行を消すと項目を外す", read() === undefined, JSON.stringify(read()));
    }
    await page.keyboard.press("Control+9");
    await page.waitForSelector(".proj-section", { timeout: 10000 });
    ok("作品: 開くと基本の設定を出す", (await page.locator(".proj-section").count()) > 0);
    await page.keyboard.press("Control+8");
    await page.waitForTimeout(400);
    await page.locator(".plg-nav", { hasText: "スタンプ帳" }).first().click();
    await page.waitForTimeout(800);
    await page.locator(".plg-nav", { hasText: "スタンプ帳" }).click();
    await page.waitForTimeout(400);
    const book = page.locator('[data-view="stamp-book"]');
    ok("プラグインの画面: ⌘9 で開き、素材の画像を並べる", (await book.isVisible()) && (await book.locator("img").count()) === 1);
    await book.locator('input[type="text"]').fill("夜の星");
    const flushed = await page.evaluate("window.__liminaliaStudio.flush().then(() => 'ok', (e) => String(e))");
    const stamps = existsSync(join(project, "data/stamps.json")) ? (JSON.parse(readFileSync(join(project, "data/stamps.json"), "utf8")) as Record<string, string>) : {};
    ok("プラグインの画面: 作品のデータに書く（flush で保存待ちも）", flushed === "ok" && stamps["stamps/star.png"] === "夜の星", JSON.stringify(stamps));
    await page.keyboard.press("Control+1");
    await page.waitForTimeout(400);
    const tocWidth = () => page.locator(".toc").evaluate((e) => Math.round(e.getBoundingClientRect().width));
    const before = await tocWidth();
    const bar = (await page.locator(".desk > .splitter-left").boundingBox())!;
    await page.mouse.move(bar.x + 4, bar.y + 300);
    await page.mouse.down();
    await page.mouse.move(bar.x + 84, bar.y + 300, { steps: 4 });
    await page.mouse.up();
    ok("欄の幅: 境目をドラッグして目次を広げる", (await tocWidth()) - before > 70, `${before} → ${await tocWidth()}px`);
    await page.locator(".desk > .splitter-left").dblclick();
    ok("欄の幅: ダブルクリックで元の幅", (await tocWidth()) === before);
  }

  // ---- ブロック（1 行ずつ、ページは囲み）: ⌘E で切り替え、つまみで一行を動かし、⌘Z で戻す ----
  {
    await goto(page, 27);
    await page.keyboard.press("Meta+e");
    await page.waitForTimeout(500);
    ok("ブロック: ⌘E で切り替わり、1 行ずつ並んでページは囲みで見える", (await page.locator(".blk").isVisible()) && (await page.locator(".blk-line-row").count()) > 100 && (await page.locator(".blk-page").count()) > 20);
    const lines = async () => ((await app(page, "return ed.state.doc.toString()")) as string).split("\n");
    const before = (await lines()).join("\n");
    const row = (line: number) => page.locator(`.blk-line-row[data-from="${line}"]`);
    await row(24).hover();
    // 暗転の札（18 行）の右半分に落とすと、その札のすぐ後ろに入る
    const mask = (await row(18).boundingBox())!;
    const grip = (await row(24).locator(".blk-grip").boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(mask.x + mask.width - 4, mask.y + mask.height / 2, { steps: 8 });
    // 札は隙間が動くと滑ってよける。滑り終わってから札の右端へ動かし直す（隙間で次の札が折り返しても、ここに落とせる）
    await page.waitForTimeout(250);
    const maskNow = (await row(18).boundingBox())!;
    await page.mouse.move(maskNow.x + maskNow.width - 6, maskNow.y + maskNow.height / 2);
    await page.mouse.move(maskNow.x + maskNow.width - 4, maskNow.y + maskNow.height / 2);
    await page.waitForTimeout(250);
    await page.mouse.up();
    await page.waitForTimeout(400);
    const moved = await lines();
    ok("ブロック: 本文の一行を、命令の行（暗転）の下へ動かす", moved[17] === "@mask" && moved[18]!.startsWith("　丸い屋根"), `${moved[17]} / ${moved[18]}`);
    await page.screenshot({ path: join(shots, "blocks-light.png") });
    await page.locator(".blk-list").focus();
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(300);
    ok("ブロック: ⌘Z で戻す", (await lines()).join("\n") === before);
    // 本文の字の上を引くと、動かさずに通った行まで選ぶ（動かすのはつまみだけ）
    {
      const from = (await row(23).locator(".blk-text").boundingBox())!;
      const to = (await row(25).locator(".blk-text").boundingBox())!;
      await page.mouse.move(from.x + 20, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(to.x + 40, to.y + to.height / 2, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(200);
      const picked = await page.locator(".blk-line-row.in-range").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.from).join(","));
      ok("ブロック: 本文を引くと、動かさずに通った行まで選ぶ", picked === "23,24,25" && (await lines()).join("\n") === before, picked);
    }
    // 札は、重ねると左に出るつまみで動かす（BGM の札を背景の札の前へ）
    {
      await row(20).hover();
      const grip20 = (await row(20).locator(".blk-grip").boundingBox())!;
      const bg = (await row(19).boundingBox())!;
      await page.mouse.move(grip20.x + grip20.width / 2, grip20.y + grip20.height / 2);
      await page.mouse.down();
      await page.mouse.move(bg.x + 6, bg.y + bg.height / 2, { steps: 8 });
      await page.waitForTimeout(250);
      const bgNow = (await row(19).boundingBox())!;
      await page.mouse.move(bgNow.x + 4, bgNow.y + bgNow.height / 2);
      await page.mouse.move(bgNow.x + 6, bgNow.y + bgNow.height / 2);
      await page.waitForTimeout(250);
      await page.mouse.up();
      await page.waitForTimeout(400);
      const swapped = await lines();
      ok("ブロック: 札のつまみで、同じ並びの前の札と入れ替える", swapped[18]!.startsWith("@bgm") && swapped[19]!.startsWith("@bg "), `${swapped[18]} / ${swapped[19]}`);
      await page.locator(".blk-list").focus();
      await page.keyboard.press("Meta+z");
      await page.waitForTimeout(300);
    }
    // 選んでいる札の×で消える（詳細を開く押しに取られない）
    {
      await row(22).locator(".blk-cue").click();
      await page.waitForTimeout(200);
      await row(22).locator(".blk-del").click();
      await page.waitForTimeout(400);
      const removed = await lines();
      ok("ブロック: 選んでいる札の×で消す", removed[21]!.startsWith("　坂を") && removed.length === before.split("\n").length - 1, removed[21]);
      await page.locator(".blk-list").focus();
      await page.keyboard.press("Meta+z");
      await page.waitForTimeout(300);
      ok("ブロック: 札を動かし消したのを ⌘Z で戻す", (await lines()).join("\n") === before);
    }
    // パーツの欄は、はじめは閉じている。端の跡を押して開く
    await page.locator('.panel-rail[data-panel="parts"]').click();
    await page.waitForTimeout(200);
    const sections = await page.locator(".blk-sec-title").allTextContents();
    ok("ブロック: 部品は区切りごとに並ぶ（よく使う・本文・流れ…）", sections[0] === "よく使う" && sections.includes("本文") && sections.includes("流れ") && sections.includes("サウンド"), sections.join(" "));
    await page.locator(".blk-sec-head", { hasText: "サウンド" }).click();
    await page.waitForTimeout(200);
    const soundOpen = await page.locator(".blk-sec-sound .blk-sec-body").isVisible();
    await page.locator(".blk-sec-head", { hasText: "サウンド" }).click();
    ok("ブロック: 区切りの見出しで開閉する", soundOpen && !(await page.locator(".blk-sec-sound .blk-sec-body").isVisible()));
    // ブロックのまま読み直しても立ち上がる（台本を開く前に描こうとしない）
    await page.reload();
    await page.waitForSelector(".blk-line-row", { timeout: 30000 });
    ok("ブロック: ブロックのまま読み直しても開ける", (await page.locator(".pane-toggle").count()) >= 1);
    // 欄の開閉（シーン・右の欄は上の帯の「…」のメニューでも開け閉めできる。パーツの欄は見出しと端の跡で）
    const toggle = async (t: string) => {
      if (t === "パーツの欄の表示を切り替え") {
        const close = page.locator('.panel-head[data-panel="parts"] .panel-close');
        return (await close.isVisible()) ? close.click() : page.locator('.panel-rail[data-panel="parts"]').click();
      }
      await page.locator(".topbar-more").click();
      await page.locator(".ctx-item", { hasText: t }).click();
    };
    for (const t of ["シーン一覧の表示を切り替え", "右の欄の表示を切り替え", "パーツの欄の表示を切り替え"]) await toggle(t);
    await page.waitForTimeout(300);
    ok("欄の開閉: 場面の一覧・右の欄・部品の欄を閉じる", !(await page.locator(".toc").isVisible()) && !(await page.locator(".right").isVisible()) && !(await page.locator(".blk-palette").isVisible()));
    for (const t of ["シーン一覧の表示を切り替え", "右の欄の表示を切り替え", "パーツの欄の表示を切り替え"]) await toggle(t);
    await goto(page, 27);
    await page.waitForTimeout(500);
    // 演出の流れは、はじめはたたんである。見出しの山形で開閉する
    const flowCollapsed = async () => (await page.locator(".flow.collapsed").count()) === 1;
    const flowBefore = await flowCollapsed();
    await page.locator('button[title="タイムラインの表示を切り替え"]').click();
    await page.waitForTimeout(200);
    ok("欄の開閉: 演出の流れを開く・たたむ", flowBefore && !(await flowCollapsed()));
    await page.locator('button[title="タイムラインの表示を切り替え"]').click();
    await page.waitForTimeout(300);
    await page.keyboard.press("Meta+e");
    await page.waitForTimeout(300);
    ok("ブロック: ⌘E でテキストへ戻る", await page.locator(".cm-editor").isVisible());
    await page.waitForTimeout(1500);
  }

  // ---- 畳む・札・フォーム ----
  await page.locator("button.toggle").click();
  await goto(page, 101);
  await page.waitForTimeout(300);
  const hiddenCmd = await page.locator(".cm-line", { hasText: "@chara-hide-all time=500ms" }).count();
  ok("畳むと命令の行が隠れる", hiddenCmd === 0);
  await goto(page, 113);
  await page.screenshot({ path: join(shots, "desk-fold-light.png") });
  const chip = page.locator(".cm-line", { hasText: "流れ星が消えるまでに" }).locator(".lim-chip", { hasText: "ソウ smile 右" });
  ok("札（本文の右に要約）", (await chip.count()) > 0);
  await chip.click();
  await page.waitForTimeout(300);
  ok("札を押すとフォーム", await page.locator(".inspector").isVisible());
  // 差分は顔の一覧から選ぶ（face-picker.ts）
  await page.locator('.inspector .face-choice[data-variant="surprised"]').click();
  await page.waitForTimeout(200);
  ok("フォームで差分を書き換え", (await lineText(page, 112)) === "@chara ソウ surprised at=right time=400ms", await lineText(page, 112));
  // 書式の版 4 で fade= は time= になった
  const time = page.locator(".inspector .field", { has: page.locator(".field-name", { hasText: /^time\b/ }) }).locator("input");
  await time.fill("0");
  await time.dispatchEvent("change");
  await page.waitForTimeout(200);
  ok("既定値と同じ値は書かない", (await lineText(page, 112)) === "@chara ソウ surprised at=right", await lineText(page, 112));
  await page.screenshot({ path: join(shots, "inspector-light.png") });
  await page.waitForTimeout(1600);
  ok("自動保存（フォームの変更）", disk("start").split("\n")[111] === "@chara ソウ surprised at=right", `${await status(page)}`);
  // 本文中の {@…} の印。
  await goto(page, 116);
  const inlineChip = page.locator(".lim-chip-inline").first();
  ok("本文中の {@…} の印", (await inlineChip.count()) > 0, (await inlineChip.textContent()) ?? "");
  // フォームはカーソルの行に付いてくる。札から開いたフォームも、カーソルが本文の行へ動けば閉じる（閉じるボタンは押さない）
  ok("札から開いたフォームは、カーソルが本文の行へ動くと閉じる", !(await page.locator(".inspector").isVisible()));
  await page.locator("button.toggle").click();

  // ---- 編集 → 自動保存 ----
  // End は折り返しの端で止まる。部品欄が開いていると欄が狭くこの行が折り返すので、先に閉じる
  const partsClose = page.locator('.panel-head[data-panel="parts"] .panel-close');
  if (await partsClose.isVisible()) await partsClose.click();
  await goto(page, 27);
  await page.keyboard.press("End");
  await page.keyboard.type("（追記）");
  ok("編集中の表示", ((await status(page)) ?? "") === "未保存", (await status(page)) ?? "");
  await page.waitForTimeout(1600);
  ok("自動保存（約 1 秒）", disk("start").includes("この坂、こんなに長かったっけ」（追記）") && (await status(page)) === "保存済み", (await status(page)) ?? "");
  // 取り消しは文字単位。
  await page.keyboard.press("Meta+z");
  ok("取り消し（CodeMirror の履歴）", (await lineText(page, 27)).endsWith("長かったっけ」"), await lineText(page, 27));
  await page.keyboard.press("Meta+Shift+z");
  ok("やり直し", (await lineText(page, 27)).endsWith("」（追記）"), await lineText(page, 27));

  // ---- 検査の下線 ----
  await goto(page, 29);
  await page.keyboard.press("End");
  await page.keyboard.type(" volum=50");
  await page.waitForTimeout(700);
  ok("打鍵ごとの検査の下線", (await page.locator(".cm-lintRange-error").count()) > 0, `${await page.locator(".ed-problems").textContent()}`);
  // 保存すると保存の検査が届いて検査し直し、開いている吹き出しは閉じる（CodeMirror の lint は診断を出し直すと閉じる）。保存が済んでから乗せる
  await page.waitForFunction(() => document.querySelector(".save-status")?.textContent === "保存済み", undefined, { timeout: 10000 });
  await page.waitForTimeout(500);
  const box = (await page.locator(".cm-lintRange-error", { hasText: "volum" }).first().boundingBox())!;
  await page.mouse.move(box.x - 200, box.y + 200);
  await page.waitForTimeout(100);
  await page.mouse.move(box.x + 6, box.y + 6, { steps: 5 });
  await page.waitForTimeout(150);
  await page.mouse.move(box.x + 9, box.y + 6);
  await page.waitForTimeout(900);
  const tip = (await page.locator(".cm-tooltip").allTextContents()).join(" / ");
  ok("hover で直し方", tip.includes("修正案"), tip || `${JSON.stringify(box)}`);
  await page.screenshot({ path: join(shots, "lint-light.png") });
  for (let i = 0; i < 9; i++) await page.keyboard.press("Backspace");
  await page.waitForTimeout(1500);

  // ---- 補完 ----
  await goto(page, 30);
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("本文{cli");
  await page.waitForSelector('.cm-tooltip-autocomplete li[aria-selected="true"]');
  await page.waitForTimeout(200);
  await page.keyboard.press("Tab");
  const inlineCompleted = await app(page, "return ed.state.doc.lineAt(ed.state.selection.main.head).text");
  ok("補完: Tab で候補を確定し、閉じ括弧を重ねない", inlineCompleted === "本文{click}", String(inlineCompleted));
  await app(page, "const l = ed.state.doc.lineAt(ed.state.selection.main.head); ed.view.dispatch({ changes: { from: l.from - 1, to: l.to } })");
  await goto(page, 30);
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("@cha");
  await page.waitForTimeout(400);
  ok("補完: 命令名", (await page.locator(".cm-tooltip-autocomplete li", { hasText: "chara" }).count()) > 0);
  await page.keyboard.type("ra ア");
  await page.waitForTimeout(400);
  await page.keyboard.press("Enter");
  await page.keyboard.type(" ");
  await page.waitForTimeout(400);
  const variants = await page.locator(".cm-tooltip-autocomplete li").allTextContents();
  ok("補完: キャストと差分", variants.some((v) => v.includes("smile")), variants.join(" / "));
  // どの命令の行にも書ける if=(式)
  ok("補完: 行の if=", variants.some((v) => v.includes("if=")), variants.join(" / "));
  await page.screenshot({ path: join(shots, "completion-light.png") });
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(500);
  ok("補完: 差分の縮小画像", (await page.locator(".cm-completionInfo img.lim-thumb").count()) > 0);
  await page.keyboard.press("Enter");
  await page.keyboard.type(" at=");
  await page.waitForTimeout(400);
  const positions = await page.locator(".cm-tooltip-autocomplete li").allTextContents();
  ok("補完: 立ち位置", positions.some((p) => p.includes("left")), positions.join(" / "));
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Meta+z");
  // 行を足した分を消す。
  await app(page, `const l = ed.state.doc.line(31); if (l.text.startsWith("@chara アカリ")) ed.view.dispatch({ changes: { from: l.from - 1, to: l.to } });`);
  await page.waitForTimeout(1600);

  // ---- 候補のある文字の値（背景の色調） ----
  {
    await goto(page, 30);
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("@bg hill_night.webp tone=");
    await page.waitForTimeout(500);
    const tones = await page.locator(".cm-tooltip-autocomplete li").allTextContents();
    ok("補完: 背景の色調（tone=）の候補", ["night", "evening", "plain", "none"].every((t) => tones.some((i) => i.includes(t))), tones.join(" / "));
    await page.screenshot({ path: join(shots, "completion-tone-light.png") });
    await page.keyboard.press("Escape");
    await app(page, `const l = ed.state.doc.line(31); if (l.text.startsWith("@bg hill_night.webp tone=")) ed.view.dispatch({ changes: { from: l.from - 1, to: l.to } });`);
    await page.waitForTimeout(1600);
  }

  // ---- 素材の候補と、打鍵中の素材の欠け ----
  {
    await goto(page, 30);
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("@bg ");
    await page.waitForTimeout(500);
    const items = await page.locator(".cm-tooltip-autocomplete li").allTextContents();
    ok("補完: 素材のフォルダの候補", ["hill_dusk.webp", "hill_morning.webp", "hill_night.webp"].every((f) => items.some((i) => i.includes(f))), items.join(" / "));
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(500);
    ok("補完: 背景の縮小画像", (await page.locator(".cm-completionInfo img.lim-thumb").count()) > 0);
    await page.screenshot({ path: join(shots, "completion-asset-light.png") });
    await page.keyboard.press("Escape");
    await page.keyboard.type("nothing.png");
    await page.waitForTimeout(600);
    const missing = await page.locator(".cm-lintRange-error", { hasText: "nothing.png" }).count();
    ok("打鍵中の検査: 無い素材", missing > 0 && (await status(page)) === "未保存", `${missing}・${await status(page)}`);
    // 無い画像の札の覗き窓
    const chipBox = (await page.locator(".lim-chip-bg", { hasText: "nothing" }).first().boundingBox())!;
    await page.mouse.move(chipBox.x + 5, chipBox.y + 5);
    await page.mouse.move(chipBox.x + 8, chipBox.y + 6);
    await page.waitForTimeout(900);
    const failed = (await page.locator(".lim-peek").textContent()) ?? "";
    ok("覗き窓: 読めない画像はそう出す", failed.includes("画像を読み込めません"), failed);
    await page.screenshot({ path: join(shots, "peek-missing-light.png") });
    await page.mouse.move(700, 600);
    await app(page, `const l = ed.state.doc.line(31); if (l.text.startsWith("@bg nothing")) ed.view.dispatch({ changes: { from: l.from - 1, to: l.to } });`);
    await page.waitForTimeout(1600);
  }

  // ---- 外の変更の取り込み（編集していないとき） ----
  const before = disk("start");
  writeFileSync(join(scenario, "start.lim"), before.replace("丸い屋根の、", "丸い屋根の、（外で直した）"));
  await page.waitForTimeout(1200);
  ok("外の変更を静かに読み直す", (await app(page, "return ed.text()") as string).includes("（外で直した）") && (await status(page)) === "ほかのアプリでの変更を読み込みました", (await status(page)) ?? "");

  // ---- 更新: 外で足したファイル・書き換えを読み直す。作品の設定が変わったら起動し直すよう知らせる ----
  {
    const update = {
      click: async () => {
        await page.locator(".topbar-more").click();
        await page.locator(".ctx-item", { hasText: "更新" }).click();
      },
    };
    const notice = async () => (await page.locator(".notice").textContent()) ?? "";
    writeFileSync(join(scenario, "extra.lim"), "# extra\n外で足したファイル。\n");
    writeFileSync(join(scenario, "start.lim"), disk("start").replace("（外で直した）", "（更新で読んだ）"));
    await update.click();
    await page.waitForTimeout(2500);
    const read = (await app(page, "return ed.text()")) as string;
    ok(
      "更新: 外で足したファイルが目次に出て、開いているファイルも読み直す",
      (await page.locator(".toc-file", { hasText: "extra" }).count()) > 0 && read.includes("（更新で読んだ）") && (await notice()) === "最新の状態に更新しました",
      await notice(),
    );
    ok("更新: 舞台がつながり直してその行を出す", (await app(page, "return s.debug.stageShown() !== null || s.debug.stageStill()")) === true);
    const configPath = join(project, "liminalia.json");
    const config = readFileSync(configPath, "utf8");
    writeFileSync(configPath, config.replace(/"title":\s*"[^"]*"/, '"title": "更新の確かめ"'));
    await update.click();
    await page.waitForTimeout(1200);
    ok("更新: 作品の設定が変わったら、起動し直すよう知らせる（ブラウザ）", (await notice()).includes("再起動"), await notice());
    writeFileSync(configPath, config);
    unlinkSync(join(scenario, "extra.lim"));
    await page.waitForTimeout(800);
  }

  // ---- 409: 編集中に外で別の行が変わった → 自動で合わせる ----
  await goto(page, 37);
  await page.keyboard.press("End");
  await page.keyboard.type("（ここで）");
  writeFileSync(join(scenario, "start.lim"), disk("start").replace("流れ星を見に来たんだろう。", "流れ星を見に来たんだろう？"));
  await page.keyboard.press("Meta+s");
  await page.waitForTimeout(1800);
  const merged = disk("start");
  ok("重ならない変更は自動で合わせる", merged.includes("（ここで）") && merged.includes("見に来たんだろう？"), (await status(page)) ?? "");

  // ---- 重なった変更 → 画面で選ぶ ----
  await goto(page, 35);
  await page.keyboard.press("End");
  await page.keyboard.type("（こちら）");
  writeFileSync(join(scenario, "start.lim"), disk("start").replace("だれの物でもないから」", "だれの物でもないから」（あちら）"));
  await page.keyboard.press("Meta+s");
  await page.waitForTimeout(800);
  const dialog = page.locator(".dialog.merge");
  ok("重なったら両方を見せて選ばせる", await dialog.isVisible(), (await status(page)) ?? "");
  const flushRejected = await page.evaluate("window.__liminaliaStudio.flush().then(() => 'resolved', (r) => String(r))");
  ok("合わせ直し中の flush は拒否", String(flushRejected).includes("競合"), String(flushRejected));
  await page.screenshot({ path: join(shots, "merge-light.png") });
  await dialog.locator(".merge-side.theirs button").first().click();
  await dialog.locator("footer button.primary").click();
  await page.waitForTimeout(1800);
  ok("選んだ側で合わせて書く", disk("start").includes("（あちら）") && !disk("start").includes("（こちら）"), (await status(page)) ?? "");
  const flushed = await page.evaluate("window.__liminaliaStudio.flush().then(() => 'resolved', (r) => String(r))");
  ok("flush は解決する", flushed === "resolved", String(flushed));

  // ---- ⌘P ----
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("telescope");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  ok("⌘P でラベルへ", (await app(page, "return ed.cursorLine()")) === 58, `${await app(page, "return ed.cursorLine()")}`);
  await page.keyboard.press("Alt+PageDown");
  ok("⌥PageDown で次のラベル", (await app(page, "return ed.cursorLine()")) === 74, `${await app(page, "return ed.cursorLine()")}`);

  // ---- 文字の大きさ（画面側で受ける） ----
  await page.keyboard.press("Meta+=");
  const zoomed = await page.locator(".topbar button", { hasText: "%" }).textContent();
  await page.keyboard.press("Meta+0");
  ok("⌘＋ で文字を大きく、⌘0 で戻す", zoomed === "110%" && (await page.locator(".topbar button", { hasText: "%" }).textContent()) === "100%", zoomed ?? "");

  // ---- 全体の検索 ----
  await page.keyboard.press("Meta+Shift+f");
  await page.keyboard.type("夜明け");
  await page.waitForTimeout(700);
  ok("全体の検索", (await page.locator(".toc-hit").count()) > 0, `${await page.locator(".toc-results p").first().textContent()}`);
  await page.locator(".toc-search").fill("");
  await page.locator(".toc-search").dispatchEvent("input");

  // ---- 点検の分類で絞る ----
  {
    writeFileSync(join(scenario, "broken.lim"), ["@nosuch", "@bg missing.png", "@jump #nowhere", "@se lost.wav", "@chara ダレ normal"].join("\n"));
    await page.waitForTimeout(1000);
    await page.locator(".tab", { hasText: "チェック" }).click();
    await page.locator(".check-rerun, .check-clear-actions button").first().click();
    await page.waitForTimeout(1200);
    const all = await page.locator(".check-surface .diag-list li").count();
    await page.locator('.check-pill[data-category="asset"]').click();
    const shown = await page.locator(".check-surface .diag-list li").allTextContents();
    ok("点検: 分類で絞る", all >= 5 && shown.length === 2 && shown.every((t) => t.includes("素材")), `${all} 件 → ${shown.length} 件 ${shown.join(" / ")}`);
    await page.locator('.check-pill[data-category="target"]').click();
    // 大きなファイル（big.lim）の届かないシーン（情報）も飛び先に入るので、broken.lim の分だけを数える
    // （素材 2 件、無いラベル、@jump の後の届かない行）
    const two = (await page.locator(".check-surface .diag-list li").allTextContents()).filter((t) => t.includes("broken.lim")).length;
    ok("点検: 分類はいくつでも選べる", two === 4, `${two} 件`);
    await page.screenshot({ path: join(shots, "check-filter-light.png") });
    await page.locator(".check-filter button").click();
    ok("点検: すべて表示に戻す", (await page.locator(".check-surface .diag-list li").count()) === all);
    unlinkSync(join(scenario, "broken.lim"));
    await page.waitForTimeout(800);
    await page.locator(".tab", { hasText: "シナリオ" }).click();
  }

  // ---- 点検 ----
  await page.locator(".tab", { hasText: "チェック" }).click();
  await page.locator(".check-actions button.primary, .check-clear-actions button:not(.ghost)").first().click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(shots, "check-light.png") });
  // 未到達のカードの最初の範囲（「start 18–23」）。押すとその範囲の頭の行へ
  const unreached = page.locator(".check-range").first();
  const target = Number(/(\d+)(?:–\d+)?$/.exec((await unreached.textContent()) ?? "")?.[1]);
  await unreached.click();
  await page.waitForTimeout(400);
  ok("点検から机のその行へ", (await app(page, "return ed.cursorLine()")) === target && (await page.locator(".desk").isVisible()), `${target}`);

  // ---- 8,000 行級のファイル ----
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("big.lim");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);
  const lines = await app(page, "return ed.state.doc.lines");
  await goto(page, 4000);
  // 一打鍵の処理（同期の更新: 行の見分け・帯・札・sweep のずらし・描画）を測る。
  const perKey = (await page.evaluate(`(async () => {
    const ed = window.__liminaliaStudioApp.debug.editor;
    const times = [];
    for (let i = 0; i < 60; i++) {
      const pos = ed.state.selection.main.head;
      const t0 = performance.now();
      ed.view.dispatch({ changes: { from: pos, insert: "あ" }, selection: { anchor: pos + 1 }, userEvent: "input.type" });
      ed.view.dom.getBoundingClientRect();
      times.push(performance.now() - t0);
      await new Promise((r) => requestAnimationFrame(() => r()));
    }
    times.sort((a, b) => a - b);
    return { median: times[30], p95: times[57], max: times[59] };
  })()`)) as { median: number; p95: number; max: number };
  // 打鍵ごとの検査（250ms 止まってから走る）の一回分。
  const lintMs = (await page.evaluate(`(async () => {
    const debug = window.__liminaliaStudioApp.debug;
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) debug.lint();
    return (performance.now() - t0) / 5;
  })()`)) as number;
  // 実際のキー入力（Playwright から）での一打鍵。
  const t0 = Date.now();
  await page.keyboard.type("いろはにほへとちりぬるをわかよたれそつねならむ".repeat(2), { delay: 0 });
  const typed = (Date.now() - t0) / 48;
  results.push(
    `PERF 8,000 行級（${lines} 行）: 一打鍵の同期の更新 中央値 ${perKey.median.toFixed(1)}ms / 95% ${perKey.p95.toFixed(1)}ms / 最大 ${perKey.max.toFixed(1)}ms、検査一回 ${lintMs.toFixed(1)}ms、キー入力 1 文字あたり ${typed.toFixed(1)}ms`,
  );
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(shots, "big-file-light.png") });
  ok("大きなファイルも保存", disk("big").includes("いろはにほへと"), (await status(page)) ?? "");
  // 帯はファイル全体（取ってある範囲の外の頭と終わりにも出る）
  {
    await page.waitForTimeout(2500);
    const bands = (await app(page, "return s.debug.bands()")) as { whole: boolean; lanes: { id: string; segments: [number, number, string][] }[] };
    const bg = bands.lanes.find((l) => l.id === "bg");
    const first = Math.min(...(bg?.segments.map((x) => x[0]) ?? [Infinity]));
    const last = Math.max(...(bg?.segments.map((x) => x[1]) ?? [0]));
    const total = Number(await app(page, "return ed.state.doc.lines"));
    ok("帯をファイル全体で描く", bands.whole && first < 100 && last > total - 100, `材料 ${bands.whole ? "全体" : "範囲"}・背景の帯 ${first}〜${last} 行 / ${total} 行・帯 ${bands.lanes.length} 本`);
    const sizes = (await page.evaluate(`(async () => {
      const api = "/__liminalia/studio/api";
      const t0 = performance.now();
      const track = await (await fetch(api + "/sweep/stage?file=big")).text();
      const t1 = performance.now();
      const sweep = await (await fetch(api + "/sweep?file=big")).text();
      return { track: track.length, trackMs: t1 - t0, sweep: sweep.length };
    })()`)) as { track: number; trackMs: number; sweep: number };
    results.push(`PERF 8,000 行級の帯の材料 ${(sizes.track / 1024).toFixed(1)}KB（${sizes.trackMs.toFixed(0)}ms・覚えたあと）、現在地の全体 ${(sizes.sweep / 1024 / 1024).toFixed(2)}MB`);
    await page.screenshot({ path: join(shots, "big-file-bands-light.png") });
  }

  // ---- 札のフォームの素材の候補 ----
  {
    await page.keyboard.press("Meta+k");
    await page.keyboard.type("start.lim");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1500);
    const bgLine = ((await app(page, "return ed.text()")) as string).split("\n").indexOf("@bg hill_dusk.webp") + 1;
    await app(page, `s.openInspector({ line: ${bgLine} })`);
    await page.waitForTimeout(300);
    const input = page.locator(".inspector .field", { hasText: "image" }).locator("input").first();
    await input.focus();
    await page.waitForTimeout(300);
    const options = await page.locator(".inspector .asset-list li[role=option]").count();
    const thumbs = await page.locator(".inspector .asset-list li img").count();
    ok("フォーム: 素材の候補（縮小画像つき）", options === 3 && thumbs === 3 && (await page.locator(".inspector .asset-current img").count()) === 1, `${options} 件・画像 ${thumbs}`);
    await page.screenshot({ path: join(shots, "inspector-asset-light.png") });
    await page.locator(".inspector .asset-list li", { hasText: "hill_night.webp" }).dispatchEvent("mousedown");
    await page.waitForTimeout(300);
    ok("フォーム: 候補を押すとその素材に", (await lineText(page, bgLine)) === "@bg hill_night.webp", await lineText(page, bgLine));
    await page.locator(".inspector button.ghost").first().click();
    await page.waitForTimeout(1600);
    ok("フォームの素材の変更も保存", disk("start").includes("@bg hill_night.webp"), (await status(page)) ?? "");
  }

  // ---- 前の版から戻す ----
  {
    const beforeRestore = disk("start");
    await page.locator(".ed-title").click();
    await page.locator(".ctx-item", { hasText: "変更履歴" }).click();
    await page.waitForTimeout(800);
    const dialog = page.locator(".dialog.history");
    const entries = await dialog.locator(".history-item").count();
    // 素材を替える前の版（一つ前）を選ぶ
    await dialog.locator(".history-item").nth(0).click();
    await page.waitForTimeout(500);
    const removed = await dialog.locator(".diff-row.removed").allTextContents();
    const added = await dialog.locator(".diff-row.added").allTextContents();
    ok("前の版: 一覧と、今の内容との差分", entries >= 3 && removed.some((t) => t.includes("hill_dusk")) && added.some((t) => t.includes("hill_night")), `${entries} 版・消えた行 ${removed.length}・増えた行 ${added.length}`);
    const text = (await dialog.textContent()) ?? "";
    ok("前の版: 仕組みの言葉を出さない", !/git|hash|commit|JSON/i.test(text));
    await page.screenshot({ path: join(shots, "history-light.png") });
    const restoreTo = (await page.evaluate(`(async () => {
      const list = await (await fetch("/__liminalia/studio/api/history?file=start")).json();
      return (await (await fetch("/__liminalia/studio/api/history/item?file=start&id=" + list[0].id)).json()).text;
    })()`)) as string;
    await dialog.locator(".history-foot button.primary").click();
    await page.waitForTimeout(1500);
    ok("前の版: この版に戻す（書き込み口で保存）", disk("start") === restoreTo && disk("start").includes("@bg hill_dusk.webp"), (await status(page)) ?? "");
    const after = await dialog.locator(".history-item").count();
    const top = (await page.evaluate(`(async () => {
      const list = await (await fetch("/__liminalia/studio/api/history?file=start")).json();
      return (await (await fetch("/__liminalia/studio/api/history/item?file=start&id=" + list[0].id)).json()).text;
    })()`)) as string;
    // 同じ分に書いた古い版は間引かれるので、数は一つ増えるか変わらない
    ok("前の版: 戻す前の内容も残る（戻したことも取り消せる）", after >= entries && after <= entries + 1 && top === beforeRestore && (await dialog.locator(".history-notice").isVisible()), `${entries} → ${after} 版`);
    await page.screenshot({ path: join(shots, "history-restored-light.png") });
    await page.keyboard.press("Escape");
    ok("前の版: Esc で閉じる", !(await dialog.isVisible()));
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(1600);
    ok("戻したあとも ⌘Z で取り消せる", disk("start") === beforeRestore, (await status(page)) ?? "");
  }

  // ---- 英語の表示: パーツの欄の札と補完に、コマンドの英語の説明（summaryEn、docEn）を出す ----
  {
    const en = await newPage({ locale: "en-US", viewport: { width: 1440, height: 900 }, colorScheme: "light" });
    en.on("pageerror", (e) => errors.push(e.message));
    await en.goto(`${url}?lang=en`);
    await en.waitForSelector(".cm-content");
    await en.waitForTimeout(1500);
    await goto(en, 27);
    await en.keyboard.press("Meta+e");
    await en.waitForTimeout(600);
    // パーツの欄が閉じていれば、端の跡から開く
    if (!(await en.locator(".blk-search").isVisible())) await en.locator('.panel-rail[data-panel="parts"]').click();
    await en.waitForTimeout(300);
    // 英語の言葉で探せる（"fade to black" は @mask の keywordsEn）
    await en.locator(".blk-search").fill("fade to black");
    await en.waitForTimeout(400);
    const found = await en.locator(".blk-part").allTextContents();
    ok("英語: パーツを英語の言葉で探せる", found.length > 0, found.join(" / "));
    await en.locator(".blk-search").fill("quake");
    await en.waitForTimeout(400);
    await en.locator(".blk-part").first().hover();
    await en.waitForTimeout(800);
    const card = (await en.locator(".part-card").textContent()) ?? "";
    ok("英語: パーツの札の説明が英語", card.includes("Shake the screen") && card.includes("Number of shakes") && !/[ぁ-んァ-ン]/.test(card.replace(/@\S+/g, "")), card.slice(0, 200));
    await en.screenshot({ path: join(shots, "en-part-card.png") });
    await en.locator(".blk-search").fill("");
    await en.keyboard.press("Meta+e");
    await en.waitForTimeout(500);
    // 例に人物の名前が入るコマンドは、札の例も英語の例（exampleEn。人物は英語の ID の Akari）。札の例はコードの表示で出る
    if (!(await en.locator(".blk-search").isVisible())) await en.locator('.panel-rail[data-panel="parts"]').click();
    await en.waitForTimeout(300);
    await en.locator(".blk-search").fill("chara-shake");
    await en.waitForTimeout(400);
    await en.locator(".blk-part").first().hover();
    await en.waitForTimeout(800);
    const example = (await en.locator(".part-card .part-card-example").textContent().catch(() => "")) ?? "";
    ok("英語: パーツの札の例が英語の例", example === "@chara-shake Akari count=1 swing=20", example);
    await en.screenshot({ path: join(shots, "en-part-card-example.png") });
    await en.locator(".blk-search").fill("");
    await en.mouse.move(0, 0);
    // 30 行目の後ろに空の行を足して書く（折り返した行では End が行の途中で止まるため）
    await app(en, "const l = ed.state.doc.line(30); ed.view.dispatch({ changes: { from: l.to, insert: '\\n' }, selection: { anchor: l.to + 1 } }); ed.view.focus()");
    await en.waitForTimeout(300);
    await en.keyboard.type("@quak");
    await en.waitForTimeout(500);
    const item = (await en.locator(".cm-tooltip-autocomplete li", { hasText: "quake" }).first().textContent()) ?? "";
    ok("英語: 補完の命令の説明が英語", item.includes("Shake the screen"), item);
    const info = (await en.locator(".cm-completionInfo").textContent().catch(() => "")) ?? "";
    ok("英語: 補完の詳しい説明も英語", info.includes("Horizontal amplitude"), info.slice(0, 200));
    await en.screenshot({ path: join(shots, "en-completion.png") });
    await en.keyboard.press("Enter");
    await en.keyboard.type(" cou");
    await en.waitForTimeout(500);
    const param = (await en.locator(".cm-completionInfo").textContent().catch(() => "")) ?? "";
    ok("英語: 補完のパラメータの説明が英語", param.includes("Number of shakes"), param);
    await en.screenshot({ path: join(shots, "en-completion-param.png") });
    await en.keyboard.press("Escape");
    // 書きかけの行を消して、保存しないまま閉じる
    await app(en, `const l = ed.state.doc.line(31); if (l.text.startsWith("@quake")) ed.view.dispatch({ changes: { from: l.from - 1, to: l.to } });`);
    await en.close();
  }

  // ---- 暗い配色 ----
  const dark = await open("dark");
  await goto(dark, 108);
  await dark.screenshot({ path: join(shots, "desk-dark.png") });
  await dark.locator("button.toggle").click();
  await goto(dark, 113);
  await dark.locator(".lim-chip").first().click();
  await dark.waitForTimeout(300);
  await dark.screenshot({ path: join(shots, "desk-fold-dark.png") });
  await dark.locator(".tab", { hasText: "チェック" }).click();
  await dark.locator(".check-actions button.primary, .check-clear-actions button:not(.ghost)").first().click();
  await dark.waitForTimeout(1500);
  await dark.screenshot({ path: join(shots, "check-dark.png") });
  // epilogue（道筋つき）
  await dark.locator(".tab", { hasText: "シナリオ" }).click();
  await dark.keyboard.press("Meta+k");
  await dark.keyboard.type("epilogue");
  await dark.keyboard.press("Enter");
  await dark.waitForTimeout(1500);
  await goto(dark, 16);
  ok("別のファイルの道筋", ((await dark.locator(".route").textContent()) ?? "").includes("→"), (await dark.locator(".route").textContent()) ?? "");
  await dark.screenshot({ path: join(shots, "epilogue-dark.png") });
  await dark.keyboard.press("Meta+k");
  await dark.keyboard.type("start.lim");
  await dark.keyboard.press("Enter");
  await dark.waitForTimeout(1000);
  await dark.locator(".ed-title").click();
    await dark.locator(".ctx-item", { hasText: "変更履歴" }).click();
  await dark.waitForTimeout(800);
  await dark.locator(".dialog.history .history-item").nth(1).click();
  await dark.waitForTimeout(500);
  await dark.screenshot({ path: join(shots, "history-dark.png") });
} catch (e) {
  results.push(`NG  例外: ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  await browser.close();
  await server.close();
}
console.log(results.join("\n"));
if (errors.length) console.log(`画面のエラー:\n${errors.join("\n")}`);
console.log(`スクリーンショット: ${shots}`);
process.exit(0);
