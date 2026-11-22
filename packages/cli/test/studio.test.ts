import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { STUDIO_API, STUDIO_PAGE, type ProjectInfo, type StageReply, type Sweep } from "@liminalia/studio/protocol";
import { findChromium } from "../src/chromium.ts";

/**
 * lim studio の開発サーバーを実際に（別のプロセスで）立て、制作画面の口と、プレイヤーの制作画面用の口（?studio=1 と postMessage）を確かめる。
 * Chrome が要るので、LIMINALIA_E2E_BROWSER=1 のときだけ動かす。
 */

const LIM = resolve(import.meta.dirname, "../bin/lim.mjs");

describe.skipIf(!process.env.LIMINALIA_E2E_BROWSER)("制作画面の開発サーバー", { timeout: 120_000 }, () => {
  let work: string;
  let server: ChildProcess;
  let url: string;
  let browser: Browser;
  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "liminalia-studio-e2e-"));
    const r = spawnSync(process.execPath, [LIM, "new", "game"], { cwd: work, encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    server = spawn(process.execPath, [LIM, "studio", join(work, "game"), "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
    url = await new Promise<string>((resolve, reject) => {
      let out = "";
      server.stdout!.on("data", (c: Buffer) => {
        out += c.toString();
        const m = /プレイヤー: (\S+)/.exec(out);
        if (m) resolve(m[1]!);
      });
      server.on("exit", (code) => reject(new Error(`lim studio が終わりました（${code}）\n${out}`)));
    });
    browser = await chromium.launch({ executablePath: findChromium(), args: ["--mute-audio"] });
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
    server?.kill();
    rmSync(work, { recursive: true, force: true });
  });

  it("別のサイトから使われる口を閉じている（2026-11-20 の S7・S8）", async () => {
    // Vite のエディタを開く口は、どこからでも起こせるので閉じる
    expect((await fetch(new URL("__open-in-editor?file=/etc/hosts", url))).status).toBe(403);
    // 別の番号の localhost のページに、台本と素材を読ませない（CORS の許可の頭を付けない）
    const scenario = await fetch(new URL("project/scenario/start.lim", url), { headers: { Origin: "http://localhost:1" } });
    expect(scenario.status).toBe(200);
    expect(scenario.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("制作画面のページと口が開発サーバーにある", async () => {
    const page = await browser.newPage();
    await page.goto(new URL(STUDIO_PAGE.slice(1), url).href);
    // 書き手の欄（CodeMirror）ができるのを待つ。はじめはブロックの表示で、本文の欄は隠れていることがある
    await page.waitForSelector(".cm-content", { state: "attached" });
    const info = await page.evaluate(async (api) => (await fetch(`${api}/project`)).json(), STUDIO_API);
    expect((info as ProjectInfo).files.map((f) => f.file)).toEqual(["epilogue", "start"]);
    await page.close();
  });

  it("?studio=1 のプレイヤーは、受けたセーブのページを出して返事をする", async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(new URL(STUDIO_PAGE.slice(1), url).href);
    const sweep = (await page.evaluate(async (api) => (await fetch(`${api}/sweep?file=start`)).json(), STUDIO_API)) as Sweep;
    // 制作画面の代わりに、舞台の iframe を置いて受け渡しをする
    const replies = await page.evaluate(
      async ({ save, cast }) => {
        const replies: StageReply[] = [];
        const frame = document.createElement("iframe");
        // 制作画面自身の舞台の返事は数えない
        window.addEventListener("message", (e) => e.source === frame.contentWindow && replies.push(e.data as StageReply));
        frame.id = "e2e-stage";
        frame.src = "/?studio=1";
        frame.style.cssText = "width: 1280px; height: 720px";
        document.body.append(frame);
        const wait = (type: string) =>
          new Promise<void>((resolve) => {
            const timer = setInterval(() => {
              if (replies.some((r) => r.type === type)) {
                clearInterval(timer);
                resolve();
              }
            }, 50);
          });
        await wait("liminalia:stage-ready");
        frame.contentWindow!.postMessage({ type: "liminalia:stage-show", save }, location.origin);
        await wait("liminalia:stage-shown");
        frame.contentWindow!.postMessage({ type: "liminalia:stage-cast", cast }, location.origin);
        return replies;
      },
      // 型を浅くして渡す（SaveData のままだと page.evaluate の型の展開が深くなりすぎる）
      { save: sweep.lines[27]!.save as unknown, cast: {} as unknown },
    );
    // stage-shown にはシステム変数（system）も付く。ここでは返事の順と、出したページの場所を見る
    expect(replies).toMatchObject([{ type: "liminalia:stage-ready" }, { type: "liminalia:stage-shown", at: { file: "start", line: 27 } }]);
    // 制作画面自身の舞台も ?studio=1 なので、置いた iframe を指す
    const frame = (await (await page.$("#e2e-stage"))!.contentFrame())!;
    // クリックで開始・タイトルは出さず、そのページを出している
    await frame.waitForFunction(() => document.querySelector(".text")?.textContent?.includes("着いた"), null, { timeout: 10_000 });
    expect(await frame.evaluate(() => [window.__liminalia!.screen().mode, document.querySelector(".lm-gate"), document.querySelector(".lm-title")])).toEqual(["game", null, null]);
    expect(await frame.evaluate(() => Object.keys(window.__liminalia!.runtime()!.state.stage.sprites))).toEqual(["アカリ"]);

    // 選択肢の行
    await page.evaluate((save) => {
      const frame = document.querySelector<HTMLIFrameElement>("#e2e-stage")!;
      frame.contentWindow!.postMessage({ type: "liminalia:stage-show", save }, location.origin);
    }, sweep.lines[52]!.save as unknown);
    await frame.waitForFunction(() => document.querySelectorAll(".choices button, .choices > *").length === 3, null, { timeout: 10_000 });

    // 命令の行（32 行目 @chara ソウ）の直後: 本文を出さずに、背景と二人の立ち絵の画面だけを組み立て、実行器は進めない
    const still = sweep.stages[sweep.after[32]!.stage]!;
    const stillReply = await page.evaluate(async (stage) => {
      const frame = document.querySelector<HTMLIFrameElement>("#e2e-stage")!;
      // 上で空にしたキャストを戻す（立ち絵を描けるように）
      const { cast } = (await (await fetch("/__liminalia/studio/api/project")).json()) as { cast: unknown };
      frame.contentWindow!.postMessage({ type: "liminalia:stage-cast", cast }, location.origin);
      const got = new Promise<unknown>((resolve) => {
        const on = (e: MessageEvent) => {
          if (e.source === frame.contentWindow && (e.data as StageReply).type === "liminalia:stage-still-shown") {
            window.removeEventListener("message", on);
            resolve(e.data);
          }
        };
        window.addEventListener("message", on);
        setTimeout(() => resolve("timeout"), 10_000);
      });
      frame.contentWindow!.postMessage({ type: "liminalia:stage-still", stage }, location.origin);
      return got;
    }, still as unknown);
    expect(stillReply).toEqual({ type: "liminalia:stage-still-shown" });
    const look = () =>
      frame.evaluate(() => ({
        text: document.querySelector(".text")?.textContent ?? "",
        name: document.querySelector(".name")?.textContent ?? "",
        sprites: document.querySelectorAll(".sprites .sprite").length,
        background: document.querySelector(".background img")?.getAttribute("src") ?? "",
        choices: document.querySelectorAll(".choices > *").length,
      }));
    expect(await look()).toEqual({ text: "", name: "", sprites: 2, background: "assets/bgimage/hill_dusk.webp", choices: 0 });
    // 舞台を押しても先へ進まない
    // （置いた iframe は制作画面の外にあって見えないので、押したことにする）
    await frame.evaluate(() => document.querySelector(".stage")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await frame.waitForTimeout(500);
    expect(await look()).toMatchObject({ text: "", sprites: 2 });
    expect(errors).toEqual([]);
    await page.close();
  });

  it("制作画面でないプレイヤーは、これまでどおり「クリックで開始」を出す", async () => {
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForFunction(() => !!window.__liminalia);
    await page.waitForSelector(".lm-gate");
    await page.close();
  });
});
