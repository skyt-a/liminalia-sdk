import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { JAPANESE, japaneseStrings } from "../../lang/test/source-strings.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { englishServerText, localizedError, rememberLanguage } from "../src/server/errors-en.ts";

const PACKAGES = resolve(import.meta.dirname, "../..");
/** 断りの文を作らないファイル（重さの計測の書き出し、素材の依頼表の CSV と無い画像の札。どれも自分で英語を持つ）。 */
const SKIP_FILES = new Set(["profile.ts", "asset-requests.ts", "missing-placeholder.ts"]);
/** 断りの文ではない日本語（ログ・新しいプラグインのひな形・文の部品の区切り・lim screens の断りを制作画面の言い方に読み替える括弧の中・英語の文を並べて持つ「制作画面が入っていない」のページ）。 */
const NOT_MESSAGES = [/^Studio: /, /^\[プラグイン\]/, /^素材について\.txt$/, /^使っていないテーマ素材を/, /^\s*(\/\*\*|summary:|text: t\.string|example:|p\.textContent)/, /^・$/, /^（(書き直すなら --force|今のファイルに部品を足すなら)/, /^制作画面は入っていません$/, /^この lim には制作画面/];

describe("開発サーバーの断りの文の英語", () => {
  it("開発サーバーの日本語の文が、すべて表で英語になる", () => {
    const files = readdirSync(resolve(PACKAGES, "studio/src/server"))
      .filter((f) => f.endsWith(".ts") && f !== "errors-en.ts" && !SKIP_FILES.has(f))
      .map((f) => `studio/src/server/${f}`)
      // 開発サーバーが使う画面の部品（シーンを移す）
      .concat(["studio/src/model/scene-move.ts"]);
    const missing = japaneseStrings(PACKAGES, files)
      .filter(({ text }) => !NOT_MESSAGES.some((re) => re.test(text)))
      .filter(({ text }) => JAPANESE.test(englishServerText(text.trim())))
      .map(({ where, text }) => `${where} ${text}`);
    expect(missing).toEqual([]);
  });

  it("差し込んだ名前は残し、入れ子の文も訳す", () => {
    expect(englishServerText("シナリオ x がありません（あるのは a・b）")).toBe("The script x doesn't exist (available: a, b)");
    expect(englishServerText("file、line、show（stage-show か stage-still）を送ってください")).toBe("Send file, line, show (stage-show or stage-still)");
    expect(englishServerText("画像の名前として使えません: ../x")).toBe("Not a usable images name: ../x");
    // 表に無い文は原文のまま
    expect(englishServerText("プラグインが投げた文")).toBe("プラグインが投げた文");
  });

  it("要求に x-liminalia-lang: en が付いていれば英語、無ければ日本語のまま返す", () => {
    const en = {} as ServerResponse;
    rememberLanguage({ headers: { "x-liminalia-lang": "en" } } as unknown as IncomingMessage, en);
    expect(localizedError(en, "コメントが空です")).toBe("The comment is empty");
    const ja = {} as ServerResponse;
    rememberLanguage({ headers: {} } as unknown as IncomingMessage, ja);
    expect(localizedError(ja, "コメントが空です")).toBe("コメントが空です");
  });
});
