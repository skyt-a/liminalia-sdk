import type { Locator, Page } from "playwright-core";

/**
 * ゲームの設定の欄のカテゴリ（.game-section）を見出しのボタンで開き、そのカテゴリを返す（開いていれば押さない）。
 * 欄は、選んだカテゴリの分だけ出る（設定の検索が空のとき。game-view.ts の updateSections）。
 * root はゲームの設定の画面（.view-surface[data-view="game"]）か、それを含むページ。
 */
export async function openGameSection(root: Locator | Page, id: string): Promise<Locator> {
  const section = root.locator(`.game-section[data-section="${id}"]`);
  const button = section.locator(":scope > .game-heading > .game-category-button");
  await button.waitFor();
  if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
  await section.locator(":scope > .game-category-body").waitFor();
  return section;
}

/** data-field が path の欄（.game-field）を含むカテゴリを開き、その欄を返す。 */
export async function openGameField(root: Locator | Page, path: string): Promise<Locator> {
  const field = root.locator(`.game-section [data-field="${path}"]`).first();
  await field.waitFor({ state: "attached" });
  const id = await field.evaluate((el) => el.closest<HTMLElement>(".game-section")?.dataset.section ?? "");
  await openGameSection(root, id);
  await field.waitFor();
  return field;
}
