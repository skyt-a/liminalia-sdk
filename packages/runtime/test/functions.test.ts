import { describe, expect, it } from "vitest";
import { parseExpr } from "@liminalia/lang";
import { evaluate, type Value } from "../src/index.ts";

/** 式の関数。乱数はいつも 0.5 を返すものにして決める。 */
const ev = (src: string, vars: Record<string, Value> = {}) => evaluate(parseExpr(src), { lookup: (n) => vars[n] ?? null, random: () => 0.5 });

describe("式の関数", () => {
  it("乱数（作品の乱数に従う）", () => {
    expect(ev("randint(1, 6)")).toBe(4);
    expect(ev('pick(["a", "b", "c"])')).toBe("b");
    expect(ev("pick([])")).toBeNull();
    expect((ev("shuffle([1, 2, 3, 4])") as number[]).sort()).toEqual([1, 2, 3, 4]);
  });

  it("数", () => {
    expect(ev("round(3.14159, 2)")).toBe(3.14);
    expect(ev("clamp(12, 0, 10)")).toBe(10);
    expect(ev("sum([1, 2, 3])")).toBe(6);
    expect(() => ev('sum([1, "a"])')).toThrow(/数値だけ/);
  });

  it("文字列", () => {
    expect(ev('slice("あいうえお", 1, 3)')).toBe("いう");
    expect(ev('slice("あいうえお", -2)')).toBe("えお");
    expect(ev('replace("a-b-c", "-", "+")')).toBe("a+b+c");
    expect(ev('upper("abc") + lower("DEF") + trim("  x  ")')).toBe("ABCdefx");
    expect(ev('split("a,b", ",")')).toEqual(["a", "b"]);
    expect(ev('join(["a", 1, true], "/")')).toBe("a/1/true");
    expect(ev("pad(7, 3)")).toBe("007");
    expect(ev('str(12) + num("3.5")')).toBe("123.5");
    expect(ev('num("x")')).toBeNull();
    expect(ev('index("abcabc", "c")')).toBe(2);
  });

  it("版の比べ方（version_before。数として比べ、- の付いた版は付かない版より前、空はどの版よりも前）", () => {
    expect(ev('version_before("1.9.0", "1.10.0")')).toBe(true);
    expect(ev('version_before("1.10.0", "1.9.0")')).toBe(false);
    expect(ev('version_before("1.1", "1.1.0")')).toBe(false);
    expect(ev('version_before("1.1.0-beta", "1.1.0")')).toBe(true);
    expect(ev('version_before("1.1.0-beta.2", "1.1.0-beta.10")')).toBe(true);
    expect(ev('version_before("v1.0.0", "1.0.1")')).toBe(true);
    expect(ev('version_before("", "1.0.0")')).toBe(true);
    expect(ev('version_before(v, "1.0.0")', { v: null })).toBe(true);
    expect(ev('version_before("", "")')).toBe(false);
    expect(ev('version_before("1.0.0", "")')).toBe(false);
    expect(() => ev('version_before([1], "1.0.0")')).toThrow(/版の文字列/);
  });

  it("配列とオブジェクト（元は変えない）", () => {
    const items: Value = ["key", "map"];
    expect(ev('push(items, "lamp")', { items })).toEqual(["key", "map", "lamp"]);
    expect(items).toEqual(["key", "map"]);
    expect(ev('remove(items, "key")', { items })).toEqual(["map"]);
    expect(ev("sort([3, 1, 2])")).toEqual([1, 2, 3]);
    expect(ev('sort(["b", "a"])')).toEqual(["a", "b"]);
    expect(ev("reverse([1, 2])")).toEqual([2, 1]);
    expect(ev("unique([1, 1, 2])")).toEqual([1, 2]);
    expect(ev("keys(o)", { o: { a: 1, b: 2 } })).toEqual(["a", "b"]);
    expect(ev('has(o, "a") && !has(o, "toString")', { o: { a: 1 } })).toBe(true);
  });

  it("現実の日時", () => {
    const d = new Date();
    expect(ev("year()")).toBe(d.getFullYear());
    expect(ev("month()")).toBe(d.getMonth() + 1);
    expect(ev("weekday() >= 0 && weekday() <= 6")).toBe(true);
    expect(typeof ev("now()")).toBe("number");
  });
});
