import { configDefaults, defineConfig } from "vitest/config";

// 正本（非公開のリポジトリ）の設定から、この写しに要るものだけを残したもの。
export default defineConfig({
  test: {
    // ブラウザのテスト（packages/web/test/e2e）は正本で流す（開発サーバーとブラウザを立てる）
    exclude: [...configDefaults.exclude, "**/out/**", "**/dist/**", "packages/web/test/e2e/**"],
    env: { LIMINALIA_LANG: "ja" },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
