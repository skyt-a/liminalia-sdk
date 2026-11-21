import { describe, expect, it } from "vitest";
import { englishGaps } from "@liminalia/lang";
import { combinePlugins } from "@liminalia/sdk";
import std from "../src/commands/index.ts";
import { STD_COMMANDS_EN } from "../src/commands/en.ts";

/** 標準のコマンドの英語（en.ts の表）がそろっているか。 */

const { specs } = combinePlugins([std]);

describe("標準のコマンドの英語", () => {
  it("どのコマンドにも英語の要約、パラメータの説明、やりたいことの言葉がある", () => {
    expect(englishGaps(specs)).toEqual([]);
  });

  it("英語の表に、無いコマンドや無いパラメータを書いていない", () => {
    const stale: string[] = [];
    for (const [name, en] of Object.entries(STD_COMMANDS_EN)) {
      const spec = specs.find((c) => c.name === name);
      if (!spec) stale.push(name);
      else for (const p of Object.keys(en.params ?? {})) if (!spec.params[p]) stale.push(`${name}.${p}`);
    }
    expect(stale).toEqual([]);
  });

  it("英語の例（exampleEn）も仕様に入る（例に日本語が残っていないかは englishGaps が見る）", () => {
    expect(specs.find((c) => c.name === "chara-shake")!.exampleEn).toBe("@chara-shake Akari count=1 swing=20");
    expect(specs.find((c) => c.name === "bg-place")!.exampleEn).toBeUndefined();
  });

  it("共通の部品（skip、rule）の英語も仕様に入る", () => {
    const transition = specs.find((c) => c.name === "transition")!;
    expect(transition.params.skip?.docEn).toMatch(/click/);
    expect(transition.params.rule?.docEn).toMatch(/Rule image/);
    // @movie の skip は自分の意味（クリックとスキップで飛ばせる）
    expect(specs.find((c) => c.name === "movie")!.params.skip?.docEn).toMatch(/^Allow skipping with a click .* and with Skip/);
  });
});
