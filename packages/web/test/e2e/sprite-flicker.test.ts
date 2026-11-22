import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 立ち絵のちらつきを減らす仕組みを、実際のブラウザで確かめる。
 * - 話者強調（liminalia.json の ui.chara）: 話していないキャラクターを暗くして下げる。地の文では誰も変えず、@chara-config が優先する
 * - 同じ位置の入れ替え（@chara の swap）: 既定は前の人が消え終わってから出す。swap=cross は前の版のとおり重ねる
 * - 出るのを待つ間（wait=true の @chara）: 前の話者の名前と本文を消しておく。ui.chara.keepText なら残す
 * 見た目は LIMINALIA_SHOT_DIR に撮る（目で確かめるとき）。
 */

const focus = `@bg hill_dusk.webp
@window show
@chara アカリ at=left
@chara ソウ at=right
アカリ「はじめまして」
ソウ「どうも」
二人は並んで立っていた。
@chara-config focus=none
ソウ「強調を止めた」
`;

const swap = `@bg hill_dusk.webp
@window show
@chara アカリ at=center
アカリ「入れ替わる前」
@chara-hide アカリ time=600ms
@chara ソウ at=center time=600ms
入れ替わり。
@chara-hide ソウ time=600ms
@chara アカリ at=center time=600ms swap=cross
重ねる入れ替わり。
`;

/** 立っている人物を、消えていく人物の位置へ動かす（同じ絵のまま、表情を替えながら、滑らせて）。 */
const move = `@bg hill_dusk.webp
@window show
@chara アカリ at=left
@chara ソウ at=right
アカリ「動く前」
@chara-hide ソウ time=600ms
@chara アカリ at=right time=600ms
同じ絵で動いた。
@chara ソウ at=left
ソウ「戻った」
@chara-hide アカリ time=600ms
@chara ソウ smile at=right time=600ms
表情を替えて動いた。
@chara アカリ at=left
アカリ「また戻った」
@chara-hide ソウ time=600ms
@chara アカリ at=right time=600ms slide=true
滑って動いた。
`;

const entrance = `@bg hill_dusk.webp
@window show
@chara アカリ at=left
アカリ「前の台詞」
@chara ソウ at=right time=900ms wait=true
ソウ「次の台詞」
@chara-hide ソウ
ソウは窓の外を見た。
@chara ソウ at=right time=900ms wait=true
ソウ「戻ってきた」
@chara-hide ソウ
ソウ「呼んだ？」
@chara ソウ at=right time=900ms wait=true
アカリ「出てきた」
`;

const shotDir = process.env.LIMINALIA_SHOT_DIR;
const shot = async (p: Page, name: string) => {
  if (shotDir) await p.screenshot({ path: `${shotDir}/${name}.png` });
};

/** 立ち絵の見え方（暗さの filter と、下げた量）。消えていく途中の要素も同じ data-who を持つので、出ているもの（最後のもの）を見る。 */
const look = (p: Page, who: string) =>
  p.evaluate(`(() => {
    const list = document.querySelectorAll('.sprite[data-who="${who}"]');
    const el = list[list.length - 1];
    if (!el) return null;
    const s = getComputedStyle(el);
    return { filter: s.filter, margin: parseFloat(s.marginTop) };
  })()`) as Promise<{ filter: string; margin: number } | null>;

const message = (p: Page) =>
  p.evaluate(`(() => ({ name: document.querySelector(".message .name")?.textContent ?? "", text: document.querySelector(".message .text")?.textContent ?? "" }))()`) as Promise<{ name: string; text: string }>;

const waitText = (p: Page, t: string) => p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes(${JSON.stringify(t)})`, undefined, { timeout: 30_000 });
const next = (p: Page) => p.mouse.click(640, 80);

describe.skipIf(!e2e)("立ち絵のちらつきを減らす（ブラウザ）", { timeout: 240_000 }, () => {
  let project: TestProject;
  let keep: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    // 送ったページの本文を次の命令で消す既定（ui.message.keepText。after-page.test.ts）は止めて、出るのを待つ間の消し方だけを見る
    project = await startProject({ scenario: { focus, swap, move, entrance }, config: { entry: "focus", ui: { chara: { focus: "dim-lower", dim: 0.5, lower: 20 }, message: { keepText: true } } } });
    keep = await startProject({ scenario: { entrance }, config: { entry: "entrance", ui: { chara: { keepText: true }, message: { keepText: true } } } });
  }, 120_000);
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
    await keep?.close();
  });

  it("話者強調: 話していないキャラクターを暗くして下げ、地の文では戻し、@chara-config focus=none で止める", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=focus`);
      await waitText(p, "はじめまして");
      await p.waitForTimeout(500);
      // アカリが話している: ソウが沈む
      expect((await look(p, "アカリ"))!.margin, name).toBe(0);
      expect((await look(p, "アカリ"))!.filter, name).toBe("none");
      expect((await look(p, "ソウ"))!.filter, name).toContain("brightness(0.5)");
      expect((await look(p, "ソウ"))!.margin, name).toBe(20);
      await shot(p, `focus-akari-${name}`);
      // ソウが話す: アカリが沈む
      await next(p);
      await waitText(p, "どうも");
      await p.waitForTimeout(500);
      expect((await look(p, "アカリ"))!.filter, name).toContain("brightness(0.5)");
      expect((await look(p, "アカリ"))!.margin, name).toBe(20);
      expect((await look(p, "ソウ"))!.margin, name).toBe(0);
      await shot(p, `focus-sou-${name}`);
      // 地の文: 誰も沈めない
      await next(p);
      await waitText(p, "並んで立っていた");
      await p.waitForTimeout(500);
      for (const who of ["アカリ", "ソウ"]) {
        expect((await look(p, who))!.filter, `${name} ${who}`).toBe("none");
        expect((await look(p, who))!.margin, `${name} ${who}`).toBe(0);
      }
      // シナリオの @chara-config が作品の設定より優先する
      await next(p);
      await waitText(p, "強調を止めた");
      await p.waitForTimeout(500);
      expect((await look(p, "アカリ"))!.filter, name).toBe("none");
      expect((await look(p, "アカリ"))!.margin, name).toBe(0);
      await p.close();
    }
  });

  it("同じ位置の入れ替え: 既定は前の人が消え終わってから出し、swap=cross は重ねる", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=swap`);
      await waitText(p, "入れ替わる前");
      await p.waitForTimeout(300);
      /** 次へ進めてから 1.6 秒のあいだ、毎フレーム二人の不透明度を記録し、二人とも見えている度合い（小さい方の不透明度）の最大を返す。 */
      const overlap = async (mid: string) => {
        await p.evaluate(`(() => {
          const samples = [];
          window.__samples = samples;
          const read = (who) => { const list = document.querySelectorAll('.sprite[data-who="' + who + '"]'); let v = 0; for (const el of list) v = Math.max(v, Number(getComputedStyle(el).opacity)); return v; };
          const t0 = performance.now();
          const step = () => { samples.push([read("アカリ"), read("ソウ")]); if (performance.now() - t0 < 1600) requestAnimationFrame(step); };
          requestAnimationFrame(step);
        })()`);
        await next(p);
        await p.waitForTimeout(450);
        await shot(p, `${mid}-${name}`);
        await p.waitForTimeout(1300);
        const samples = (await p.evaluate("window.__samples")) as [number, number][];
        expect(samples.length, name).toBeGreaterThan(20);
        return Math.max(...samples.map(([a, b]) => Math.min(a, b)));
      };
      // 既定（after）: 消えかけと出かけが同時に見えない
      expect(await overlap("swap-after"), name).toBeLessThan(0.1);
      expect((await look(p, "ソウ"))!, name).not.toBeNull();
      // swap=cross: 前の版のとおり、二人が半透明で重なる
      expect(await overlap("swap-cross"), name).toBeGreaterThan(0.3);
      await p.close();
    }
  });

  it("同じ位置の入れ替え: 立っている人物を消えていく人物の位置へ動かすときも、消え終わってから現す", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=move`);
      await p.waitForFunction(`window.__liminalia?.host.waiting === true && document.querySelector(".message .text")?.textContent.includes("動く前")`, null, { timeout: 60_000 });
      /**
       * 次へ進め、右半分（行き先）にいる二人の見え方（祖先まで掛けた不透明度）を毎フレーム記録し、次のページを出し終えて二人とも動き終えるまで続ける。
       * 二人とも見えている度合い（小さい方）の最大を返す。
       */
      const overlap = async (leaving: string, mover: string, text: string) => {
        await p.evaluate(`(() => {
          const samples = [];
          window.__samples = samples;
          window.__sampled = false;
          const seen = (el) => { let v = 1; for (let n = el; n && !n.classList.contains("sprites"); n = n.parentElement) v *= Number(getComputedStyle(n).opacity); return v; };
          const right = (who) => {
            let v = 0;
            for (const el of document.querySelectorAll('.sprite[data-who="' + who + '"], .sprite[data-snapshot="' + who + '"]')) {
              const r = el.getBoundingClientRect();
              if (r.left + r.width / 2 > 640) v = Math.max(v, seen(el));
            }
            return v;
          };
          const step = () => {
            const s = [right(${JSON.stringify(leaving)}), right(${JSON.stringify(mover)})];
            samples.push(s);
            const done = window.__liminalia.host.waiting && document.querySelector(".message .text")?.textContent.includes(${JSON.stringify(text)}) && s[0] === 0 && s[1] === 1 && document.querySelector(".layer.sprites").getAnimations({ subtree: true }).length === 0;
            if (done) window.__sampled = true;
            else requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        })()`);
        await p.evaluate("window.__liminalia.host.advance()");
        await p.waitForFunction("window.__sampled === true", null, { timeout: 60_000 });
        const samples = (await p.evaluate("window.__samples")) as [number, number][];
        return Math.max(...samples.map(([a, b]) => Math.min(a, b)));
      };
      const turn = async (text: string) => {
        await p.evaluate("window.__liminalia.host.advance()");
        await p.waitForFunction(`window.__liminalia.host.waiting === true && document.querySelector(".message .text")?.textContent.includes(${JSON.stringify(text)})`, null, { timeout: 60_000 });
      };
      // 同じ絵のまま動く（左で消えて右で現れる）
      expect(await overlap("ソウ", "アカリ", "同じ絵で動いた"), `${name} 同じ絵`).toBeLessThan(0.1);
      await turn("戻った");
      // 表情を替えながら動く（左の絵が消え、右の絵が現れる）
      expect(await overlap("アカリ", "ソウ", "表情を替えて動いた"), `${name} 表情`).toBeLessThan(0.1);
      await turn("また戻った");
      // 滑らせて動く（右に着いたときに、消えていく人物が残っていない）
      expect(await overlap("ソウ", "アカリ", "滑って動いた"), `${name} 滑らせる`).toBeLessThan(0.1);
      await p.close();
    }
  });

  it("出るのを待つ間: 前の話者の名前と本文を消し、地の文と本人の台詞は残す。ui.chara.keepText なら残す", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=entrance`);
      await waitText(p, "前の台詞");
      await p.waitForTimeout(300);
      // アカリの台詞のあと、ソウが出るのを待つ間は名前欄と本文が空
      await next(p);
      await p.waitForTimeout(400);
      expect(await message(p), name).toEqual({ name: "", text: "" });
      await shot(p, `entrance-${name}`);
      await waitText(p, "次の台詞");
      await p.waitForTimeout(400);
      expect((await message(p)).name, name).toBe("ソウ");
      // 地の文のあとは、出るのを待つ間も残す
      await next(p);
      await waitText(p, "窓の外");
      await p.waitForTimeout(300);
      await next(p);
      await p.waitForTimeout(400);
      expect(await message(p), name).toEqual({ name: "", text: "ソウは窓の外を見た。" });
      await waitText(p, "戻ってきた");
      await p.waitForTimeout(400);
      // 出る本人（ソウ）の台詞のあとも残す
      await next(p);
      await waitText(p, "呼んだ");
      await p.waitForTimeout(300);
      await next(p);
      await p.waitForTimeout(400);
      expect(await message(p), name).toEqual({ name: "ソウ", text: "「呼んだ？」" });
      await waitText(p, "出てきた");
      await p.close();

      // keepText: 前の版のとおり、前の話者の名前と本文を残す
      const q = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await q.goto(`${keep.url}?autostart=1&start=entrance`);
      await waitText(q, "前の台詞");
      await q.waitForTimeout(300);
      await next(q);
      await q.waitForTimeout(400);
      expect(await message(q), name).toEqual({ name: "アカリ", text: "「前の台詞」" });
      await shot(q, `entrance-keep-${name}`);
      await q.close();
    }
  });
});
