import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/** 行の最後の {noclick}（クリックを待たずに次へ進む）を、実際のブラウザで確かめる。問いかけを出したまま選択肢を出し、ロードでも出し直す。 */

const SCENARIO = `@window show
前のページ。
アカリ「どっちへ行く？」{noclick}
@choice
- 北へ -> #north
- 南へ -> #south
@end
# north
北へ向かった。
@stop
# south
南へ向かった。
@stop
`;

const text = (p: Page) => p.evaluate(`document.querySelector(".message .text").textContent.replace("▼", "")`) as Promise<string>;
const name = (p: Page) => p.evaluate(`document.querySelector(".message .name").textContent`) as Promise<string>;

describe.skipIf(!e2e)("行の最後の {noclick}（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({ scenario: { a: SCENARIO }, config: { entry: "a" } });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("クリックを待たずに、問いかけを出したまま選択肢を出す。選択肢でセーブしてロードしても問いかけが出る", async () => {
    for (const { name: browserName, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await p.waitForTimeout(300);
      // 一度送るだけで、問いかけと選択肢が出る（問いかけの後でクリックを待たない）
      await p.evaluate("window.__liminalia.host.advance()");
      await p.waitForSelector(".choices button");
      await p.waitForTimeout(300);
      expect([await name(p), await text(p)], browserName).toEqual(["アカリ", "「どっちへ行く？」"]);
      expect(await p.evaluate("window.__liminalia.host.waiting"), browserName).toBe(false);
      // 選択肢でセーブして、開き直してロード
      expect(await p.evaluate("window.__liminalia.system.saveTo(1)"), browserName).toBe(true);
      await p.reload();
      await p.waitForFunction(() => !!(window as unknown as { __liminalia?: { system: unknown } }).__liminalia?.system);
      await p.evaluate("window.__liminalia.system.loadFrom(1)");
      await p.waitForSelector(".choices button");
      await p.waitForTimeout(300);
      expect([await name(p), await text(p)], browserName).toEqual(["アカリ", "「どっちへ行く？」"]);
      await p.locator(".choices button").nth(1).click();
      await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("南へ")`);
      expect(await name(p), browserName).toBe("");
      await p.close();
    }
  });
});
