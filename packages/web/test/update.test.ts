import { describe, expect, it } from "vitest";
import { TEXT } from "../src/system/strings.ts";
import { planKey, runUpdate, type DesktopUpdate, type UpdatePlan } from "../src/system/update.ts";

/** デスクトップ版の口の代わり（答えと呼ばれたものを控える）。 */
function fake(plan: UpdatePlan | null, o: { checkOk?: boolean; applyOk?: boolean } = {}) {
  const calls: string[] = [];
  const update: DesktopUpdate = {
    startup: true,
    check: async (fresh) => {
      calls.push(`check:${!!fresh}`);
      return o.checkOk === false ? { ok: false, error: "offline" } : { ok: true, plan };
    },
    apply: async (what) => {
      calls.push(`apply:${what}`);
      return o.applyOk === false ? { ok: false, error: "sha256" } : { ok: true, action: what === "packs" ? "packs" : "installer" };
    },
    relaunch: () => calls.push("relaunch"),
  };
  return { update, calls };
}

function ui(answers: boolean[], declined: string | null = null) {
  const asked: string[] = [];
  const toasts: string[] = [];
  let saved = declined;
  return {
    asked,
    toasts,
    saved: () => saved,
    ui: {
      ask: async (message: string) => {
        asked.push(message);
        return answers.shift() ?? false;
      },
      toast: (message: string) => toasts.push(message),
      language: "ja",
      declined: { get: () => saved, set: (key: string) => void (saved = key) },
    },
  };
}

const packsPlan: UpdatePlan = { app: null, packs: [{ id: "patch1", version: "1.0.1", title: "修正 1", notes: { ja: "誤字を直しました", en: "Typo fixes" }, size: 2 * 1024 * 1024 }] };

describe("アップデートの確認（遊ぶ人に尋ねる）", () => {
  it("パックがあれば説明と大きさを出して尋ね、入れたら再起動を尋ねる", async () => {
    const f = fake(packsPlan);
    const u = ui([true, true]);
    expect(await runUpdate(f.update, u.ui, false)).toBe(true);
    expect(u.asked[0]).toContain("修正 1 1.0.1、2.0 MB");
    expect(u.asked[0]).toContain("誤字を直しました");
    expect(u.asked[1]).toBe(TEXT.update.restart);
    expect(f.calls).toEqual(["check:false", "apply:packs", "relaunch"]);
  });

  it("起動したときに断った更新は二度尋ねない。メニューから確かめたときは尋ねる", async () => {
    const f = fake(packsPlan);
    const u = ui([false]);
    await runUpdate(f.update, u.ui, false);
    expect(u.saved()).toBe(planKey(packsPlan));
    expect(await runUpdate(f.update, u.ui, false)).toBe(false);
    expect(u.asked).toHaveLength(1);
    await runUpdate(f.update, u.ui, true);
    expect(u.asked).toHaveLength(2);
  });

  it("本体の更新を先に尋ね、断ったら今の本体に合うパックを尋ねる", async () => {
    const plan: UpdatePlan = { app: { version: "2.0.0", page: "https://example.com" }, packs: packsPlan.packs };
    const f = fake(plan);
    const u = ui([false, false]);
    await runUpdate(f.update, u.ui, true);
    expect(u.asked[0]).toContain("2.0.0");
    expect(u.asked[1]).toContain("修正 1");
    const g = fake(plan);
    const v = ui([true]);
    await runUpdate(g.update, v.ui, true);
    expect(g.calls).toEqual(["check:true", "apply:app"]);
    expect(v.toasts).toContain(TEXT.update.installer);
  });

  it("メニューから確かめたときは、最新であることと確かめられなかったことを知らせる", async () => {
    const latest = ui([]);
    await runUpdate(fake(null).update, latest.ui, true);
    expect(latest.toasts).toEqual([TEXT.update.latest]);
    const offline = ui([]);
    await runUpdate(fake(null, { checkOk: false }).update, offline.ui, true);
    expect(offline.toasts).toEqual([TEXT.update.checkFailed]);
    // 起動したときは何も出さない
    const quiet = ui([]);
    await runUpdate(fake(null, { checkOk: false }).update, quiet.ui, false);
    expect(quiet.toasts).toEqual([]);
  });

  it("取り寄せに失敗したら理由を知らせ、再起動は尋ねない", async () => {
    const f = fake(packsPlan, { applyOk: false });
    const u = ui([true]);
    expect(await runUpdate(f.update, u.ui, true)).toBe(false);
    expect(u.toasts.at(-1)).toContain("sha256");
    expect(f.calls).not.toContain("relaunch");
  });
});
