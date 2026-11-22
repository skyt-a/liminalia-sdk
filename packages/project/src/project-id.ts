/**
 * 作品の ID（liminalia.json の id）を題名かフォルダ名から作る。lim new と制作アプリの新規作成が同じものを使う（ブラウザでも動く。fs を使わない）。
 * ID はセーブデータの置き場所、書き出したフォルダの名前、アプリの識別子に入るので、英数字、_、- で、英数字で始める。
 *
 * - 英数字は半角の小文字にする（全角も）。- と _ はそのまま
 * - ひらがなとカタカナは、ヘボン式のローマ字にする（「ほしのおか」は hoshinooka、「を」は wo、長音の「ー」は書かない）
 * - 漢字など、ローマ字にできない文字と、空白と記号は区切り（_）にする
 *
 * 漢字は読みが分からないのでローマ字にできない。読めた部分が少ない名前（「星の丘」から no）は ID にせず、作り手に入れてもらう
 * （lim new は --id、制作アプリは ID の欄）。
 */

/** ID の長さの上限（制作アプリの ID の欄と同じ）。 */
export const PROJECT_ID_MAX = 40;

/** 作品の ID に使える形（英数字、_、- で、英数字で始める）。 */
export const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * パスの部品として危ない ID か（区切りの / と \、制御文字、. だけと空白だけのもの）。書き出しは <書き出し先>/browser/<ID> を消して置き直すので、
 * loadProject はこれを止める。PROJECT_ID_PATTERN に合わないだけの ID（手で書いた my.game など）は止めず、検査が知らせる。
 */
export function unsafeProjectId(id: string): boolean {
  return /[/\\\p{Cc}]/u.test(id) || /^[.\s]*$/u.test(id);
}

/** ひらがな一文字のローマ字（カタカナはひらがなにしてから引く）。小さい「ゃ」などは前の文字と合わせる。 */
const KANA: Record<string, string> = {
  あ: "a", い: "i", う: "u", え: "e", お: "o",
  か: "ka", き: "ki", く: "ku", け: "ke", こ: "ko",
  が: "ga", ぎ: "gi", ぐ: "gu", げ: "ge", ご: "go",
  さ: "sa", し: "shi", す: "su", せ: "se", そ: "so",
  ざ: "za", じ: "ji", ず: "zu", ぜ: "ze", ぞ: "zo",
  た: "ta", ち: "chi", つ: "tsu", て: "te", と: "to",
  だ: "da", ぢ: "ji", づ: "zu", で: "de", ど: "do",
  な: "na", に: "ni", ぬ: "nu", ね: "ne", の: "no",
  は: "ha", ひ: "hi", ふ: "fu", へ: "he", ほ: "ho",
  ば: "ba", び: "bi", ぶ: "bu", べ: "be", ぼ: "bo",
  ぱ: "pa", ぴ: "pi", ぷ: "pu", ぺ: "pe", ぽ: "po",
  ま: "ma", み: "mi", む: "mu", め: "me", も: "mo",
  や: "ya", ゆ: "yu", よ: "yo",
  ら: "ra", り: "ri", る: "ru", れ: "re", ろ: "ro",
  わ: "wa", ゐ: "i", ゑ: "e", を: "wo", ん: "n", ゔ: "vu",
  ぁ: "a", ぃ: "i", ぅ: "u", ぇ: "e", ぉ: "o", ゃ: "ya", ゅ: "yu", ょ: "yo", ゎ: "wa", ゕ: "ka", ゖ: "ke",
};
/** 前の文字と合わせて読む小さい文字（ゃゅょ と ぁぃぅぇぉ）。 */
const SMALL_Y: Record<string, string> = { ゃ: "a", ゅ: "u", ょ: "o" };
const SMALL_VOWEL: Record<string, string> = { ぁ: "a", ぃ: "i", ぅ: "u", ぇ: "e", ぉ: "o" };

/** 名前から作った ID。complete はローマ字にできない文字（漢字など）が無かったか、usable は ID として使えるか。 */
export interface ProjectIdGuess {
  id: string;
  complete: boolean;
  usable: boolean;
}

/** カタカナをひらがなにする（ヴ も ゔ に）。 */
const hiragana = (ch: string) => {
  const c = ch.codePointAt(0)!;
  return c >= 0x30a1 && c <= 0x30f6 ? String.fromCodePoint(c - 0x60) : ch;
};

/** 名前（題名かフォルダ名）から ID を作る。 */
export function projectIdFromName(name: string): ProjectIdGuess {
  const chars = [...name.normalize("NFKC")].map(hiragana);
  let out = "";
  let kept = 0;
  let lost = 0;
  /** 前の音（小さい文字と合わせるため）。区切りのあとは空。 */
  let last = "";
  let doubled = false;
  const push = (romaji: string) => {
    // 「っ」の次の子音を重ねる（ch は tch）
    if (doubled && /^[bcdfghjkmpqrstvwxyz]/.test(romaji)) out += romaji.startsWith("ch") ? "t" : romaji[0];
    doubled = false;
    out += romaji;
    last = romaji;
  };
  for (const ch of chars) {
    if (/^[A-Za-z0-9]$/.test(ch)) {
      push(ch.toLowerCase());
      kept++;
    } else if (ch === "-" || ch === "_") {
      out += ch;
      last = "";
      doubled = false;
    } else if (ch === "っ") {
      doubled = true;
      kept++;
    } else if (ch === "ー") {
      kept++;
    } else if (ch in SMALL_Y && /i$/.test(last) && last.length > 1) {
      // きゃ kya、しゃ sha、ちゃ cha、じゃ ja
      const head = /^(sh|ch|j)i$/.test(last) ? last.slice(0, -1) : `${last.slice(0, -1)}y`;
      out = out.slice(0, out.length - last.length) + head + SMALL_Y[ch];
      last = head + SMALL_Y[ch];
      kept++;
    } else if (ch in SMALL_VOWEL && last !== "" && /[aiueo]$/.test(last) && last.length > 0) {
      // ファ fa、ティ ti、ウィ wi、シェ she、ツァ tsa
      const head = last === "u" ? "w" : last.replace(/(shi|chi|ji)$/, (m) => m.slice(0, -1)).replace(/(tsu|fu|vu|te|de|to|do)$/, (m) => m.slice(0, -1)).replace(/[aiueo]$/, "");
      out = out.slice(0, out.length - last.length) + head + SMALL_VOWEL[ch];
      last = head + SMALL_VOWEL[ch];
      kept++;
    } else if (ch in KANA) {
      push(KANA[ch]!);
      kept++;
    } else {
      // 漢字など（読めない文字は数え、空白と記号は数えない）
      if (/[\p{L}\p{N}]/u.test(ch)) lost++;
      out += "_";
      last = "";
      doubled = false;
    }
  }
  const trim = (s: string) => s.replace(/_+/g, "_").replace(/^[_-]+|[_-]+$/g, "");
  const id = trim(trim(out).slice(0, PROJECT_ID_MAX));
  const complete = lost === 0;
  // 全部読めたなら 2 字から。一部だけなら、読めた文字が読めない文字より多く、3 字以上のときだけ（「星の丘」の no は使わない）
  const usable = PROJECT_ID_PATTERN.test(id) && (complete ? id.length >= 2 : kept >= lost && id.length >= 3);
  return { id, complete, usable };
}

/**
 * 名前の候補（フォルダ名、題名の順など）から ID を一つ選ぶ。全部をローマ字にできたものを先に、無ければ使える一部のもの。
 * どれも使えなければ null（作り手に入れてもらう）。
 */
export function chooseProjectId(names: readonly (string | undefined)[]): ProjectIdGuess | null {
  const guesses = names.filter((n): n is string => typeof n === "string" && n.trim() !== "").map(projectIdFromName);
  return guesses.find((g) => g.usable && g.complete) ?? guesses.find((g) => g.usable) ?? null;
}
