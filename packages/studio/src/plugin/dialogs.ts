import { h } from "./dom.ts";
import { closeOnBackIfMobile } from "./mobile-back.ts";
import { PS } from "./strings.ts";

/**
 * 名前を尋ねるダイアログ（ブランチの名前など）。「OK」で入れた文字（前後の空白を除く）、「キャンセル」・Esc で null。
 */
export async function askText(title: string, o: { ok: string; placeholder?: string; value?: string }): Promise<string | null> {
  return (await askTextPick(title, o))?.text ?? null;
}

/** 選ぶ欄（askTextPick の pick）。 */
export interface TextPick {
  label: string;
  options: readonly { value: string; label: string }[];
  value: string;
}

/**
 * 名前を尋ねるダイアログに、選ぶ欄（pick）を一つ添えたもの（同じ名前のマクロが二つあるときの、名前の変更でどちらを変えるか）。
 * 「OK」で入れた文字と選んだ値、「キャンセル」・Esc で null。pick を渡さなければ askText と同じ。
 */
export function askTextPick(title: string, o: { ok: string; placeholder?: string; value?: string; pick?: TextPick }): Promise<{ text: string; pick: string | null } | null> {
  return new Promise<{ text: string; pick: string | null } | null>((resolve) => {
    let answer: { text: string; pick: string | null } | null = null;
    const pick = o.pick ? h("select", { class: "mono ask-text-pick", "aria-label": o.pick.label }, ...o.pick.options.map((x) => h("option", { value: x.value, selected: x.value === o.pick!.value }, x.label))) : null;
    const input = h("input", { type: "text", class: "mono", value: o.value ?? "", placeholder: o.placeholder ?? "", "aria-label": title, spellcheck: false });
    const ok = h("button", { type: "button", class: "primary", disabled: (o.value ?? "").trim() === "", onclick: () => ((answer = { text: input.value.trim(), pick: pick?.value ?? null }), dialog.close()) }, o.ok);
    const cancel = h("button", { type: "button", class: "ghost", onclick: () => dialog.close() }, PS.cancel);
    input.addEventListener("input", () => (ok.disabled = input.value.trim() === ""));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing && input.value.trim() !== "") {
        e.preventDefault();
        ok.click();
      }
    });
    const field = pick ? h("label", { class: "scene-info-field" }, h("span", {}, o.pick!.label), pick) : null;
    const dialog = h("dialog", { class: "dialog confirm-dialog ask-text", "aria-label": title }, h("p", { class: "confirm-dialog-text" }, title), field, input, h("footer", {}, cancel, ok));
    dialog.addEventListener("close", () => {
      release();
      dialog.remove();
      resolve(answer);
    });
    document.body.append(dialog);
    dialog.showModal();
    // スマホ版は戻る操作でキャンセルと同じに閉じる
    const release = closeOnBackIfMobile(() => dialog.close());
    input.focus();
  });
}

/**
 * 確認のダイアログ（ブラウザ標準の confirm() の代わり。制作画面のダイアログと同じ見た目で、画面の言語の「はい」「キャンセル」を出す）。
 * 「はい」で true、「キャンセル」・Esc・外側を押したら false。message の改行はそのまま出す。
 */
export function askConfirm(message: string, o: { ok?: string } = {}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let answer = false;
    const ok = h("button", { type: "button", class: "primary", onclick: () => ((answer = true), dialog.close()) }, o.ok ?? PS.ok);
    const cancel = h("button", { type: "button", class: "ghost", onclick: () => dialog.close() }, PS.cancel);
    const dialog = h("dialog", { class: "dialog confirm-dialog", role: "alertdialog", "aria-describedby": "confirm-dialog-text" }, h("p", { id: "confirm-dialog-text", class: "confirm-dialog-text" }, message), h("footer", {}, cancel, ok));
    dialog.addEventListener("close", () => {
      release();
      dialog.remove();
      resolve(answer);
    });
    // 外側（覆い）を押したらキャンセル
    dialog.addEventListener("mousedown", (e) => {
      const r = dialog.getBoundingClientRect();
      if (e.target === dialog && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) dialog.close();
    });
    document.body.append(dialog);
    dialog.showModal();
    // スマホ版は戻る操作でキャンセルと同じに閉じる
    const release = closeOnBackIfMobile(() => dialog.close());
    ok.focus();
  });
}
