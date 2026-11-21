import { defineCommandPlugin, withEnglish } from "@liminalia/sdk";
import { COMMANDS as anim } from "./anim.ts";
import { COMMANDS as chapter } from "./chapter.ts";
import { COMMANDS as chat } from "./chat.ts";
import { CODEX_DATA, COMMANDS as codex } from "./codex.ts";
import { checkStdData } from "./data-check.ts";
import { COMMANDS as effect } from "./effect.ts";
import { COMMANDS as emote } from "./emote.ts";
import { STD_COMMANDS_EN } from "./en.ts";
import { COMMANDS as html } from "./html.ts";
import { COMMANDS as hud } from "./hud.ts";
import { COMMANDS as image } from "./image.ts";
import { COMMANDS as investigate, INVESTIGATION_DATA } from "./investigate.ts";
import { COMMANDS as mapChoice } from "./map-choice.ts";
import { COMMANDS as manga } from "./manga.ts";
import { COMMANDS as movie } from "./movie.ts";
import { COMMANDS as notify } from "./notify.ts";
import { COMMANDS as oneshot, checkOneShots } from "./oneshot.ts";
import { COMMANDS as particles } from "./particles.ts";
import { COMMANDS as screen } from "./screen.ts";
import { COMMANDS as staffRoll } from "./staff-roll.ts";
import { COMMANDS as text } from "./text.ts";

/**
 * 標準の命令（TyranoScript・TyranoBuilder に標準である画像・レイヤー・合成・フィルタ・立ち絵の移動・動画・
 * 要素の動き・画面の切り替えと揺れ・レイヤーの文字・JS なしの HTML・パーティクル）。
 * どのプロジェクトにも組み込みで入る（liminalia.json の plugins に書かなくてよい）。
 * TyranoScript の .ks のタグからの変換表は取り込みの側（@liminalia/ks-import の STD_MAPPINGS）が持つ。
 */
export default defineCommandPlugin({
  name: "std",
  // 英語（summaryEn、docEn、keywordsEn、exampleEn）は en.ts の表から重ねる
  commands: withEnglish([...image, ...movie, ...anim, ...screen, ...text, ...html, ...particles, ...effect, ...chat, ...staffRoll, ...notify, ...oneshot, ...investigate, ...mapChoice, ...codex, ...hud, ...chapter, ...emote, ...manga], STD_COMMANDS_EN),
  // 標準の命令が読む作品のデータの形（検査・制作画面のフォーム・名前を変えたときの書き換え）
  data: [INVESTIGATION_DATA, CODEX_DATA],
  // 一回きりの演出（@flipbook のコマの並び）と、台本の @investigate・@codex-unlock などが指す名前を、作品全体で確かめる
  check: (project) => [...checkOneShots(project), ...checkStdData(project)],
});

export * as imageState from "./image.ts";
export * as animState from "./anim.ts";
export * as screenState from "./screen.ts";
export * as textState from "./text.ts";
export * as movieState from "./movie.ts";
export * as particlesState from "./particles.ts";
export * as effectState from "./effect.ts";
export * as chatState from "./chat.ts";
export * as htmlState from "./html.ts";
export * as oneshotState from "./oneshot.ts";
export * as investigation from "./investigate.ts";
export * as mapChoice from "./map-choice.ts";
export * as codex from "./codex.ts";
export * as hudState from "./hud.ts";
export * as emoteState from "./emote.ts";
export { leaveParam, presentLeaving } from "./chapter.ts";
