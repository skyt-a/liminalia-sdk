import { configDefaults, defineConfig } from "vitest/config";

// 正本（非公開のリポジトリ）の設定から、この写しに要るものだけを残したもの。
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/out/**", "**/dist/**"],
    env: { LIMINALIA_LANG: "ja" },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
