import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { findChromium } from "../../cli/src/chromium.ts";
import { CONFIRM_TEMPLATE } from "@liminalia/screens/confirm";

/**
 * 制作画面の「ゲームの画面」のテンプレートの欄（client/screen-template.ts）を、lim studio を立てて Chromium で確かめる。
 * - 「この画面を自分で作る」で標準のテンプレートを写して登録し、プレビューはそのテンプレートで開く
 * - テンプレートの欄で書くと、保存する前にプレビューが変わる。属性の値を補完し、テンプレートの検査の誤りに波線を出す
 * - 画面の JS の雛形を置いて欄で開く。標準が変わった部品を一行で知らせ、押すと標準との違いを出す
 * - 標準に戻すと登録を外し、ファイルは名前を変えて残す。⌘Z で戻る
 * Chrome が要るので、LIMINALIA_E2E_BROWSER=1 のときだけ動かす。
 */

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
const LIM = resolve(import.meta.dirname, "../../cli/bin/lim.mjs");

describe.skipIf(!process.env.LIMINALIA_E2E_BROWSER)("ゲームの画面のテンプレートの欄（lim studio）", { timeout: 600_000 }, () => {
  let dir: string;
  let server: ChildProcess;
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];
  const view = (): Locator => page.locator('.view-surface[data-view="screens"]');
  const frame = () => view().locator(".screens-frame");
  const inner = () => frame().contentFrame();
  const panel = () => view().locator(".screens-panel");
  const pane = () => panel().locator(".screens-template");
  const editor = () => pane().locator(".screens-template-editor .cm-content");
  const undoKey = process.platform === "darwin" ? "Meta+z" : "Control+z";
  const selectAll = process.platform === "darwin" ? "Meta+a" : "Control+a";
  const config = () => JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as { ui?: { templates?: Record<string, string> } };
  const htmlPath = () => join(dir, "ui/screens/confirm/confirm.html");
  const jsPath = () => join(dir, "ui/screens/confirm/confirm.js");
  const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null);
  const doc = () => editor().evaluate((e) => [...e.querySelectorAll(".cm-line")].map((l) => l.textContent).join("\n"));
  /** 欄の中身を置き換える（打った文字として。補いは働かない）。 */
  const replace = async (text: string) => {
    await editor().click();
    await page.keyboard.press(selectAll);
    await page.keyboard.press("Backspace");
    if (text) await page.keyboard.insertText(text);
  };
  const settled = async (act: () => Promise<unknown>) => {
    await view().evaluate((e) => delete (e as HTMLElement).dataset.preview);
    await act();
    await expect.poll(() => view().getAttribute("data-preview"), { timeout: 30_000 }).toBe("ready");
  };
  const blur = () => page.locator("body").evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "liminalia-screen-template-"));
    cpSync(TEMPLATE, dir, { recursive: true });
    server = spawn(process.execPath, [LIM, "studio", dir, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LIMINALIA_EXIT_WITH_PARENT: "1" } });
    const url = await new Promise<string>((ok, ng) => {
      let out = "";
      server.stdout!.on("data", (c: Buffer) => {
        out += c.toString();
        const m = /Studio: (\S+)/.exec(out);
        if (m) ok(m[1]!);
      });
      server.on("exit", (code) => ng(new Error(`lim studio が終わりました（${code}）\n${out}`)));
    });
    browser = await chromium.launch({ executablePath: findChromium(), args: ["--mute-audio"] });
    const context = await browser.newContext({ locale: "ja-JP", viewport: { width: 1440, height: 900 } });
    await context.addInitScript('localStorage.setItem("liminalia.studio.tourDone", "1")');
    page = await context.newPage();
    page.on("pageerror", (e) => errors.push(`${page.url()} ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.goto(url);
    await page.waitForSelector(".cm-content", { state: "attached" });
    await page.evaluate(() => (window as unknown as { __liminaliaStudio: { showView(id: string): void } }).__liminaliaStudio.showView("screens"));
    await view().locator('.screens-frame').waitFor({ state: "attached" }).catch((e: unknown) => {
      throw new Error(`${String(e)}\n${errors.join("\n")}`);
    });
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.view-surface[data-view="screens"]')?.dataset.preview === "ready", null, { timeout: 30_000 });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    server?.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("テンプレートで作れない画面ではテンプレートの欄を出さない", async () => {
    await settled(() => view().locator('.screens-item[data-screen="confirm"]').click());
    await settled(() => view().locator('.screens-item[data-screen="extra"]').click());
    expect(await panel().locator('.screens-modes .seg[data-mode="template"]').isVisible()).toBe(false);
    await settled(() => view().locator('.screens-item[data-screen="confirm"]').click());
    expect(await panel().locator('.screens-modes .seg[data-mode="template"]').isVisible()).toBe(true);
  });

  it("この画面を自分で作ると、ui/screens/ にテンプレートを写して登録し、欄で開き、プレビューはそのテンプレートで開く", async () => {
    await panel().locator('.screens-modes .seg[data-mode="template"]').click();
    // 部品だけを写す選択（画面の全体か、部品の一つ）
    const parts = await pane().locator(".screens-template-part option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    expect(parts).toEqual(["", "screen"]);
    expect(read(htmlPath())).toBeNull();
    await settled(() => pane().locator(".screens-template-own").click());
    await expect.poll(() => read(htmlPath()), { timeout: 10_000 }).toContain('data-part="screen"');
    expect(config().ui?.templates).toEqual({ confirm: "ui/screens/confirm/confirm.html" });
    expect(existsSync(join(dir, ".liminalia/screens/confirm/screen.2.html"))).toBe(true);
    await expect.poll(doc, { timeout: 10_000 }).toBe(read(htmlPath()));
    expect(await pane().locator(".screens-template-head").textContent()).toContain("ui/screens/confirm/confirm.html");
    expect(await inner().locator(".lm-dialog").count()).toBe(1);
  });

  it("テンプレートの欄で書くと、保存する前にプレビューが変わり、少し待って保存する", async () => {
    await page.evaluate(() => {
      const w = window as unknown as { __release?: () => void; __fetch?: typeof fetch };
      const gate = new Promise<void>((r) => (w.__release = r));
      w.__fetch = window.fetch;
      window.fetch = async (input, init) => {
        if (init?.method === "PUT" && String(input).endsWith("/screens/file")) await gate;
        return w.__fetch!(input, init);
      };
    });
    const saved = read(htmlPath())!;
    const next = saved.replace('<p class="lm-dialog-message" data-field="message"></p>', '<p class="lm-dialog-message" data-field="message"></p>\n    <p class="mine-note">MINE</p>');
    expect(next).not.toBe(saved);
    await replace(next);
    await expect.poll(() => inner().locator(".lm-dialog .mine-note").count(), { timeout: 15_000 }).toBe(1);
    expect(read(htmlPath())).toBe(saved);
    await page.evaluate(() => {
      const w = window as unknown as { __release?: () => void; __fetch?: typeof fetch };
      w.__release!();
      window.fetch = w.__fetch!;
    });
    await expect.poll(() => read(htmlPath()), { timeout: 10_000 }).toBe(next);
    await expect.poll(() => inner().locator(".lm-dialog .mine-note").count(), { timeout: 15_000 }).toBe(1);
  });

  it("属性の値を、その画面の決まりから補完する", async () => {
    const labels = () => page.locator(".cm-tooltip-autocomplete li .cm-completionLabel").allTextContents();
    const saved = read(htmlPath())!;
    const at = saved.indexOf("</template>");
    const head = saved.slice(0, at);
    const tail = saved.slice(at);
    const tryAttr = async (typed: string, want: string[]) => {
      await replace(`${head}<span ${typed}`);
      await page.keyboard.insertText(tail);
      for (let i = 0; i < tail.length; i++) await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("Control+Space");
      await expect.poll(labels, { timeout: 10_000 }).toEqual(expect.arrayContaining(want));
      await page.keyboard.press("Escape");
    };
    await tryAttr('data-role="', ["ok", "cancel", "close"]);
    await tryAttr('data-field="', ["message", "yes", "no", "kind"]);
    await tryAttr('data-text="confirm.', ["confirm.yes", "confirm.no"]);
    // 打っている間にも出す
    await replace(`${head}<span data-role="`);
    await page.keyboard.type("ca");
    await expect.poll(labels, { timeout: 10_000 }).toContain("cancel");
    await page.keyboard.press("Escape");
    // 部品の名前（一番外の <template data-part>）
    await replace('<template data-part="');
    await page.keyboard.type("s");
    await expect.poll(labels, { timeout: 10_000 }).toContain("screen");
    await page.keyboard.press("Escape");
    await replace(saved);
    await expect.poll(() => read(htmlPath()), { timeout: 10_000 }).toBe(saved);
  });

  it("テンプレートの検査（template-*）の誤りに波線を出し、直すと消える", async () => {
    const saved = read(htmlPath())!;
    await replace(saved.replace('data-role="cancel"', 'data-role="cancle"'));
    await expect.poll(() => pane().locator(".cm-lintRange-warning").count(), { timeout: 10_000 }).toBe(1);
    expect(await pane().locator(".cm-lintRange-warning").first().textContent()).toContain("cancle");
    // はいを押せる要素が無い（エラー）
    await replace(saved.replace('data-role="ok"', ""));
    await expect.poll(() => pane().locator(".cm-lintRange-error").count(), { timeout: 10_000 }).toBeGreaterThan(0);
    await replace(saved);
    await expect.poll(() => pane().locator(".cm-lintRange-error, .cm-lintRange-warning").count(), { timeout: 10_000 }).toBe(0);
    await expect.poll(() => read(htmlPath()), { timeout: 10_000 }).toBe(saved);
  });

  it("この画面に JS を足すと、雛形を置いて欄で開く", async () => {
    expect(read(jsPath())).toBeNull();
    await pane().locator(".screens-template-js").click();
    await expect.poll(() => read(jsPath()), { timeout: 10_000 }).toContain("export default function");
    await expect.poll(doc, { timeout: 10_000 }).toContain("export default function");
    expect(await pane().locator(".screens-template-head").textContent()).toContain("ui/screens/confirm/confirm.js");
    // テンプレートと JS を切り替えられる
    await pane().locator('.screens-template-files .seg[data-file="template"]').click();
    await expect.poll(doc, { timeout: 10_000 }).toContain('data-part="screen"');
  });

  it("標準が変わった部品を一行で知らせ、押すと標準との違いを出す", async () => {
    // 写した元が古い版だったことにする（版 0 の元の文字を置き、部品の版を 0 にする）
    const old = CONFIRM_TEMPLATE.replace('data-version="2"', 'data-version="0"').replace(' data-autofocus', "");
    mkdirSync(join(dir, ".liminalia/screens/confirm"), { recursive: true });
    writeFileSync(join(dir, ".liminalia/screens/confirm/screen.0.html"), old.slice(0, old.indexOf("</template>") + "</template>".length));
    expect(await pane().locator(".screens-template-outdated").count()).toBe(0);
    const saved = read(htmlPath())!;
    await replace(saved.replace('data-version="2"', 'data-version="0"'));
    await expect.poll(() => pane().locator(".screens-template-outdated").count(), { timeout: 10_000 }).toBe(1);
    await expect.poll(() => read(htmlPath()), { timeout: 10_000 }).toContain('data-version="0"');
    await pane().locator(".screens-template-outdated").click();
    const diff = pane().locator(".screens-template-diff");
    await expect.poll(() => diff.textContent(), { timeout: 10_000 }).toContain("data-autofocus");
    expect(await diff.textContent()).toContain("@@");
    await replace(saved);
    await expect.poll(() => pane().locator(".screens-template-outdated").count(), { timeout: 10_000 }).toBe(0);
    await expect.poll(() => read(htmlPath()), { timeout: 10_000 }).toBe(saved);
  });

  it("標準に戻すと登録を外し、ファイルは名前を変えて残し、⌘Z で戻る", async () => {
    // 外で画面の JS を書いたあとでも同じ（開発サーバーが見張りに足したファイルを、戻したときに足し直して見本が崩れていた）
    writeFileSync(jsPath(), `${read(jsPath())!}// 外で書いた\n`);
    await page.waitForTimeout(4000);
    const saved = read(htmlPath())!;
    await settled(() => pane().locator(".screens-template-reset").click());
    await expect.poll(() => config().ui?.templates, { timeout: 10_000 }).toBeUndefined();
    const kept = readdirSync(join(dir, "ui/screens/confirm")).sort();
    expect(kept.filter((f) => /^confirm\.reset-\d{8}-\d{6}\.(html|js)$/.test(f))).toHaveLength(2);
    expect(read(htmlPath())).toBeNull();
    await expect.poll(() => pane().locator(".screens-template-own").count(), { timeout: 10_000 }).toBe(1);
    await expect.poll(() => inner().locator(".lm-dialog .mine-note").count(), { timeout: 30_000 }).toBe(0);
    await expect.poll(() => inner().locator(".lm-dialog").count(), { timeout: 30_000 }).toBe(1);
    // このタブの ⌘Z で、標準に戻す前へ
    await blur();
    await page.keyboard.press(undoKey);
    await expect.poll(() => config().ui?.templates, { timeout: 10_000 }).toEqual({ confirm: "ui/screens/confirm/confirm.html" });
    expect(read(htmlPath())).toBe(saved);
    expect(read(jsPath())).toContain("export default function");
    await expect.poll(() => pane().locator(".screens-template-editor").count(), { timeout: 10_000 }).toBe(1);
    await expect.poll(() => inner().locator(".lm-dialog .mine-note").count(), { timeout: 30_000 }).toBe(1);
  });

  it("外で CRLF に書き換えたテンプレートと JS を欄が読み直し、JS を見ただけなら書かず、テンプレートは CRLF のまま書く", async () => {
    await blur();
    const crlf = (t: string) => t.replace(/\r?\n/g, "\r\n");
    const before = { html: read(htmlPath())!, js: read(jsPath())! };
    const html = crlf(`<!-- crlf -->\n${before.html}`);
    const js = crlf(before.js);
    writeFileSync(htmlPath(), html);
    writeFileSync(jsPath(), js);
    // 外の変更（開発サーバーの screens-changed）で欄が読み直す
    await expect.poll(doc, { timeout: 15_000 }).toContain("<!-- crlf -->");
    expect(await doc()).toBe(html.replace(/\r\n/g, "\n"));
    // JS を見てからテンプレートに戻り、テンプレートの頭に一行足す
    await pane().locator('.screens-template-files .seg[data-file="script"]').click();
    await expect.poll(doc, { timeout: 10_000 }).toContain("export default function");
    await pane().locator('.screens-template-files .seg[data-file="template"]').click();
    await expect.poll(doc, { timeout: 10_000 }).toContain("<!-- crlf -->");
    await editor().locator(".cm-line").first().click();
    await page.keyboard.press("Home");
    await page.keyboard.insertText("<!-- typed -->");
    await expect.poll(() => read(htmlPath()), { timeout: 10_000 }).toContain("<!-- typed -->");
    const written = read(htmlPath())!;
    expect(written).toBe(html.replace("<!-- crlf -->", "<!-- typed --><!-- crlf -->"));
    expect(/(^|[^\r])\n/.test(written)).toBe(false);
    expect(read(jsPath())).toBe(js);
    await blur();
    await expect.poll(() => inner().locator(".lm-dialog .mine-note").count(), { timeout: 30_000 }).toBe(1);
    // 次のテストのために、前の中身に戻す（欄も読み直す）
    writeFileSync(htmlPath(), before.html);
    writeFileSync(jsPath(), before.js);
    await expect.poll(doc, { timeout: 15_000 }).toBe(before.html);
  });

  it("ページの例外とエラーが出ていない", () => {
    expect(errors).toEqual([]);
  });
});
