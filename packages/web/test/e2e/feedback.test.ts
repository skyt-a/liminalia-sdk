import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { loadProject } from "@liminalia/project";
import { browserBuildName, runBuild } from "../../../cli/src/commands/build.ts";
import { importFeedback, readReviews } from "../../../studio/src/server/reviews.ts";
import { browsers, e2e } from "./harness.ts";

/**
 * テスト版の指摘（lim build --feedback）: テスト版にだけ「指摘」の口が入り、製品の書き出しには部品ごと入らないこと。
 * 遊びながら指摘を書くと、送り先（build.feedback.url）へ POST するか、無ければファイルに保存させること。
 * そのファイルを Studio のコメントに取り込むと、行を足したあとでもページの鍵でその行に付くこと。
 */

const TEMPLATE = resolve(import.meta.dirname, "../../../../templates/default");
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".lim": "text/plain; charset=utf-8", ".webp": "image/webp", ".png": "image/png" };
const SCENARIO = "@window show\n@bg hill_dusk.webp\nはじまりの一行。\n二つ目のページ。\n";

/** 書き出したものを配る。POST /feedback は受けた本文を覚える（送り先の代わり）。 */
function serve(dir: string, received: unknown[]): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/feedback") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.writeHead(200).end("{}");
      });
      return;
    }
    const rel = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    const file = join(dir, rel === "/" ? "index.html" : rel);
    if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) return void res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, url: `http://localhost:${(server.address() as { port: number }).port}/` })));
}

/** エンジンの束の中身（指摘の部品が入っているかを見る）。 */
function engineText(build: string): string {
  const dir = join(build, "engine");
  return readdirSync(dir)
    .filter((n) => n.endsWith(".js"))
    .map((n) => readFileSync(join(dir, n), "utf8"))
    .join("\n");
}

describe.skipIf(!e2e)("テスト版の指摘", { timeout: 900_000 }, () => {
  let root: string;
  let list: { name: string; browser: Browser }[];
  const builds: Record<"product" | "post" | "file", string> = { product: "", post: "", file: "" };
  const received: unknown[] = [];
  let receiver: { server: Server; url: string };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "liminalia-feedback-"));
    // 送り先は書き出しに埋めるので、先に立てる（配るのは post の書き出し）
    // テスト版は製品と別の所（<id>-test）に書き出す
    receiver = await serve(join(root, "post", "dist", "browser", browserBuildName("hoshi_wo_matsu_oka", undefined, true)), received);
    for (const kind of ["product", "post", "file"] as const) {
      const dir = join(root, kind);
      cpSync(TEMPLATE, dir, { recursive: true });
      writeFileSync(join(dir, "scenario", "a.lim"), SCENARIO);
      const cfg = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown> & { build?: Record<string, unknown> };
      cfg.entry = "a";
      cfg.build = { ...cfg.build, browser: { offline: false }, ...(kind === "post" ? { feedback: { url: `${receiver.url}feedback` } } : {}) };
      writeFileSync(join(dir, "liminalia.json"), JSON.stringify(cfg));
      const log = console.log;
      console.log = () => undefined;
      try {
        expect(await runBuild(dir, { targets: ["browser"], import: false, verify: false, ...(kind === "product" ? {} : { feedback: true }) })).toBe(true);
      } finally {
        console.log = log;
      }
      builds[kind] = join(dir, "dist", "browser", browserBuildName("hoshi_wo_matsu_oka", undefined, kind !== "product"));
    }
    list = await browsers();
  }, 600_000);

  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    receiver?.server.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("製品の書き出しには指摘の部品が入らず、テスト版には入る", () => {
    expect(engineText(builds.product)).not.toContain("lm-feedback");
    expect(engineText(builds.file)).toContain("lm-feedback");
    expect(JSON.parse(readFileSync(join(builds.file, "project", "build.json"), "utf8")).feedback).toBe(true);
    expect(JSON.parse(readFileSync(join(builds.product, "project", "build.json"), "utf8")).feedback).toBeUndefined();
    // 送り先は CSP で取り寄せを許す
    expect(readFileSync(join(builds.post, "index.html"), "utf8")).toMatch(/connect-src[^;"]*http:\/\/localhost:\d+/);
  });

  const open = async (browser: Browser, url: string): Promise<Page> => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, acceptDownloads: true });
    await page.goto(`${url}?autostart=1&start=a`);
    await page.waitForFunction(() => document.querySelector(".message .text")?.textContent?.includes("はじまり"), null, { timeout: 60_000 });
    return page;
  };

  it("指摘を書くと、送り先へ場面の位置、ページの鍵、スクリーンショットと一緒に送る。書いている間は本文が進まない", async () => {
    // 送り先と同じ所から配る（書き出しに埋めた送り先）
    {
      const url = receiver.url;
      for (const { name, browser } of list) {
        received.length = 0;
        const page = await open(browser, url);
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.locator(".lm-feedback-button").click();
        await page.locator(".lm-feedback textarea").fill("背景が暗すぎる");
        // 書いている途中の Enter と空白で本文を送らない
        await page.locator(".lm-feedback textarea").press("Enter");
        await page.locator(".lm-feedback-name").fill("テスター");
        expect(await page.locator(".lm-feedback-where").textContent(), name).toBe("a の 3 行目");
        await page.locator(".lm-feedback .lm-primary").click();
        await page.locator(".lm-toast").waitFor();
        expect(await page.locator(".message .text").textContent(), name).toContain("はじまり");
        expect(received, name).toHaveLength(1);
        const r = received[0] as { kind: string; project: string; at: { file: string; line: number; key?: string }; body: string; author: string; shot?: string };
        expect(r, name).toMatchObject({ kind: "liminalia-feedback", project: "hoshi_wo_matsu_oka", at: { file: "a", line: 3 }, body: "背景が暗すぎる", author: "テスター" });
        expect(typeof r.at.key, name).toBe("string");
        expect(r.shot?.startsWith("data:image/jpeg;base64,"), name).toBe(true);
        // F8 でも開く
        await page.keyboard.press("F8");
        await page.locator(".lm-feedback").waitFor();
        await page.keyboard.press("Escape");
        await page.locator(".lm-feedback").waitFor({ state: "detached" });
        expect(errors, name).toEqual([]);
        await page.close();
      }
    }
  });

  it("送り先が無ければファイルに保存させ、Studio に取り込むと、行を足したあとでもその行のコメントになる", async () => {
    const { server, url } = await serve(builds.file, []);
    try {
      const { browser } = list[0]!;
      const page = await open(browser, url);
      // 二つ目のページで指摘する（一度目の押しは文字を出し切るだけのことがある）
      for (let i = 0; i < 10 && !((await page.locator(".message .text").textContent()) ?? "").includes("二つ目"); i++) {
        await page.locator(".message").click();
        await page.waitForTimeout(500);
      }
      await page.waitForFunction(() => document.querySelector(".message .text")?.textContent?.includes("二つ目"), null, { timeout: 30_000 });
      await page.locator(".lm-feedback-button").click();
      await page.locator(".lm-feedback textarea").fill("ここの言い回しを直したい");
      const [download] = await Promise.all([page.waitForEvent("download"), page.locator(".lm-feedback .lm-primary").click()]);
      expect(download.suggestedFilename()).toMatch(/^hoshi_wo_matsu_oka-\d{8}-\d{6}\.liminalia-feedback\.json$/);
      const data = JSON.parse(readFileSync((await download.path())!, "utf8")) as unknown;
      await page.close();

      // 指摘のあとで、台本の頭に行を足した
      const dir = join(root, "file");
      writeFileSync(join(dir, "scenario", "a.lim"), `// 足したコメント\n// もう一行\n${SCENARIO}`);
      const project = loadProject(dir);
      const r = importFeedback(project, [{ name: download.suggestedFilename(), data }]);
      expect(r.imported).toBe(1);
      const [thread] = readReviews(project);
      expect(thread).toMatchObject({ file: "a", line: 6, text: "二つ目のページ。", comments: [{ body: "ここの言い回しを直したい", image: expect.stringMatching(/^shots\//) }] });
      expect(existsSync(join(dir, "reviews", thread!.comments[0]!.image!))).toBe(true);
      // 二度目は取り込まない。別のプロジェクトの指摘も取り込まない
      expect(importFeedback(project, [{ name: "again", data }]).skipped).toEqual([{ name: "again", reason: "duplicate" }]);
      expect(importFeedback(project, [{ name: "other", data: { ...(data as object), project: "other", time: new Date().toISOString() } }]).skipped).toEqual([{ name: "other", reason: "project" }]);
    } finally {
      server.close();
    }
  });
});
