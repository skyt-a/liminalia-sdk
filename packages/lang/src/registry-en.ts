import { RULE_PARAMS, SKIP_PARAM } from "@liminalia/sdk";
import { COMMAND_META } from "./command-meta.ts";
import type { CommandSpec, ParamSpec } from "./registry.ts";

/**
 * 組み込みのコマンドと式の関数の英語（リファレンス、lim reference --lang en、Studio と VS Code の英語表示が読む）。
 * コマンドの仕様（registry.ts と registry-play.ts）はここを withEnglish で重ねて summaryEn、docEn、keywordsEn、exampleEn を持つ。
 * 日本語の定義の近くに書かず一か所にまとめるのは、共通の部品（duration、flag など）の形を変えずに済み、訳をまとめて見直せるため。
 * 全部のコマンドとパラメータに英語があるかは lang/test/registry-en.test.ts が確かめる。
 * 用語は Studio の英語表示（studio/src/client/strings-en.ts）にそろえる（sprite、sprite set、variant、message window など）。
 */

// コマンドの定義に英語を重ねる関数の正本は @liminalia/sdk（プラグインも使う約束）
export { withCommandEnglish, withEnglish, type CommandEnglish } from "@liminalia/sdk";
import type { CommandEnglish } from "@liminalia/sdk";

/** 英語で読むときの要約（英語が無ければ日本語）。 */
export function commandSummary(spec: Pick<CommandSpec, "summary" | "summaryEn">, en: boolean): string {
  return en ? (spec.summaryEn ?? spec.summary) : spec.summary;
}

/** 英語で読むときの例（英語の例が無ければ example）。 */
export function commandExample(spec: Pick<CommandSpec, "example" | "exampleEn">, en: boolean): string {
  return en ? (spec.exampleEn ?? spec.example) : spec.example;
}

/** 英語で読むときのパラメータの説明（英語が無ければ日本語）。 */
export function paramDoc(p: Pick<ParamSpec, "doc" | "docEn">, en: boolean): string {
  return en ? (p.docEn ?? p.doc) : p.doc;
}

/** 英語の文に混ざってはいけない文字（かな、漢字、全角の記号）。 */
const JAPANESE = /[\u3000-\u30ff\u3400-\u9fff\uff00-\uffef]/;

/**
 * 英語がそろっていない所（要約、パラメータの説明、やりたいことの言葉。英語に日本語が混ざったものも）。テストが使う。
 * keywordsEn は、日本語の keywords（定義か組み込みの COMMAND_META）があるコマンドにだけ求める。
 * 例は、英語で読むときの例（exampleEn、無ければ example）に日本語が残っていないかを見る。
 */
export function englishGaps(specs: readonly CommandSpec[]): string[] {
  const out: string[] = [];
  const check = (where: string, text: string | undefined) => {
    if (!text) out.push(`${where}: 英語が無い`);
    else if (JAPANESE.test(text)) out.push(`${where}: 英語に日本語が混ざる（${text}）`);
  };
  for (const c of specs) {
    check(`${c.name} summaryEn`, c.summaryEn);
    for (const [name, p] of Object.entries(c.params)) check(`${c.name}.${name} docEn`, p.docEn);
    const keywords = c.keywords ?? COMMAND_META[c.name]?.keywords;
    if (keywords?.length && !c.keywordsEn?.length) out.push(`${c.name} keywordsEn: 英語が無い`);
    for (const k of c.keywordsEn ?? []) check(`${c.name} keywordsEn`, k);
    const example = commandExample(c, true);
    if (JAPANESE.test(example)) out.push(`${c.name} exampleEn: ${c.exampleEn ? "英語の例に日本語が混ざる" : "例に日本語があるのに英語の例が無い"}（${example.split("\n")[0]}）`);
  }
  return out;
}

// ---- よく出る説明 ----
const FADE_IN = "Fade-in time";
const FADE_OUT = "Fade-out time";
const VOLUME = "Volume (0 to 100)";
const PAN = "Stereo position (-100 is left, 100 is right)";
const RATE = "Playback speed (1 is normal; the pitch changes too)";
const SPEAKER = "Speaker name (written as on dialogue lines)";
const FILTER = "Sound filter (muffled, phone for over the phone, radio, hall for hall reverb; none for no filter)";
const FILTER_STRENGTH = "Filter strength (0 to 100; mixed with the original sound)";

/** 組み込みのコマンド（CORE_COMMANDS。PLAY_COMMANDS を含む）。@choice の行と選択肢の行は CHOICE_EN。 */
export const CORE_COMMANDS_EN: Readonly<Record<string, CommandEnglish>> = {
  bg: {
    summary: "Change the background",
    params: {
      image: "Background image (write color instead for a solid color)",
      color: "Solid background color (written instead of image; no picture is needed, and saves keep it as a color)",
      time: "Transition time",
      method: "Transition style",
      cross: "Cross-fade the old and new backgrounds",
      wait: "Wait until the transition finishes before continuing",
      "hide-window": "true hides the message window during the transition (while fading) and shows it again with the next text. If omitted, the window stays shown (also when swapping variants of a CG)",
      "keep-text": "true keeps the previous page's name and text until the next text when this line comes right after a page is advanced with a click (so the line stays visible while a CG variant changes). Text already cleared by an earlier line doesn't come back. ui.message.keepText in liminalia.json brings back the old behavior for the whole game",
      alt: "Description of the picture (not shown on screen; passed to screen readers and text-to-speech with the next text)",
      tone: "Tone applied to sprites while this background is shown (the same names as @tone; none applies no tone). If omitted, the tone from ui.backgroundTones in liminalia.json. Sprites given a tone with @tone keep that one",
    },
    keywords: ["background", "location", "scene change", "transition", "wipe"],
  },
  chara: {
    summary: "Show a sprite or change it. A character already on screen keeps its current variant, sprite set, position and flip for anything you leave out (a hidden character uses the defaults)",
    example: "@chara Akari smile at=left time=300ms",
    params: {
      who: "Character ID",
      variant: "Variant (expression or pose). If omitted, a character on screen keeps its current variant and a hidden one uses the base variant (normal, then default, then the first one)",
      appearance: "Sprite set (outfit, era, condition and so on). If omitted, a character on screen keeps its current set and a hidden one uses the default sprite set (defaultAppearance, then default, then the first one)",
      at: "Position: a name from the variant's frame positions (unknown names fall back to center) or auto (auto sprites line up evenly side by side). If at, x and y are all omitted, a character on screen stays where it is and a hidden one appears at center",
      x: "Left edge (px). Overrides at",
      y: "Top edge (px). Overrides at",
      width: "Width (px). If omitted, a character on screen keeps its current size and a hidden one uses the variant's size",
      height: "Height (px). If omitted, a character on screen keeps its current size and a hidden one uses the variant's size",
      flip: "Flip horizontally. If omitted, a character on screen keeps its current flip and a hidden one isn't flipped",
      cross: "When the image changes, cross-fade the old and new images (false shows the new image fully before removing the old one)",
      time: "Time to show or change the sprite",
      wait: "Wait until the sprite is shown or changed before continuing",
      "if-hidden": "Show the sprite only if it's hidden (does nothing when it's already on screen)",
      enter: "How a hidden character appears, over the time: fade appears in place, left, right, top and bottom slide in from that side (by distance), and zoom grows from a small size",
      slide: "When a character on screen changes position, slide it to the new position over the time instead of hiding and showing it again",
      z: "Stacking order. Higher values are in front (with equal values, the later sprite is in front). If omitted, a character on screen keeps its order and a hidden one uses 0",
      solo: "Hide the other characters' sprites first (swapping over the time). For projects that show one character at a time, set it in commandDefaults for chara",
      replace: "The character to replace: the name of a character on screen, or the name of their position. Position names are left, center, right, a name in the sprite frame's positions, a name written in autoLayout's positions, or the name after autoLayout's byCount remaps it (choose a character placed with x or y by name). left, center, right and the names in autoLayout's positions are read as positions even when a character has the same name. The new character inherits that position and order of appearance, and the other sprites remain in place",
      "auto-layout": "Automatically place newly shown characters without explicit positions from left to right in entrance order. When the cast changes, fade the sprites out and show them again in their new positions. Set it in commandDefaults for the whole project. Change the layout with autoLayout in liminalia.json and side in cast.json",
      "auto-fade": "Time to fade existing sprites out before automatically rearranging them. time controls the new entrance",
      clear: "Hide all sprites, including this character, over this duration before showing them. Equivalent to @chara-hide-all time=… followed by @chara; time controls the entrance duration",
      swap: "How to show the sprite while another character's sprite is still disappearing at the destination position: after waits until it has gone (the two don't overlap; a character already on screen that moves there also appears there only once it has gone), cross overlaps them (the previous behavior). To change it for the whole project, set it in commandDefaults for chara",
      alt: "Description of the picture (not shown on screen; passed to screen readers and text-to-speech with the next text)",
    },
    keywords: ["sprite", "character", "enter", "appear", "expression", "change expression", "variant", "show", "slide in", "zoom", "stacking order", "front", "one at a time", "swap"],
  },
  plane: {
    summary: "Layer a background image with depth (distant sky, mountains, grass in front and so on). When @camera moves, farther planes move less. The same name replaces the old plane, and @bg removes them",
    params: {
      name: "Name (used by @plane-hide)",
      image: "Image (bgimage; transparent areas show what's behind)",
      depth: "Depth (0 moves with the sprites and values near 1 barely move; negative values are in front and move more). Farther planes are drawn behind",
      front: "Place it in front of the sprites",
      time: "Time to appear",
      wait: "Wait until it has appeared before continuing",
    },
    keywords: ["depth", "parallax", "multi-layer scrolling", "distant view"],
  },
  "plane-hide": {
    summary: "Remove a plane layered with @plane",
    params: {
      name: "Name to remove (all if omitted)",
      time: "Time to disappear",
      wait: "Wait until it has disappeared before continuing",
    },
    keywords: ["remove depth", "remove parallax"],
  },
  dof: {
    summary: "Depth of field. Choose what is in focus and blur the rest (focusing on the background blurs the sprites and foreground images; focusing on the sprites blurs the background and foreground images). none turns it off",
    params: {
      on: "What to focus on (background, sprites, or none for no blur). Can be omitted when who is given",
      who: "Character to focus on (blurs the background and the other sprites; other sprites get half the strength)",
      blur: "Blur strength (px)",
      time: "Time to change",
      wait: "Wait until the change finishes before continuing",
    },
    keywords: ["depth of field", "blur", "focus"],
  },
  tone: {
    summary: "Change the color tone of sprites (to match the time of day or a flashback). Without a character it applies to all sprites, including ones shown later. It wins over the background's tone (tone= of @bg). none resets it (back to the background's tone, if it has one)",
    params: {
      tone: "Tone: sepia, mono (black and white), night, evening, dark, plain (no change, not even the background's tone), none (reset), or a tone defined in ui.tones of liminalia.json",
      who: "Character ID (all sprites if omitted; this also clears tones set per character)",
      time: "Time to change",
      wait: "Wait until the change finishes before continuing",
    },
    keywords: ["tone", "night", "evening", "sepia", "flashback", "monochrome", "change color"],
  },
  "chara-config": {
    summary: "Configure how sprites behave (highlighting the character who is speaking and how fast auto positions rearrange). Changes only what you write",
    params: {
      focus: "How characters who aren't speaking look: dim darkens them, lower moves them down a little, dim-lower does both, blur blurs them, dim-blur darkens and blurs them, none leaves them as is (nobody changes during narration). Until you write it, the project setting applies (ui.chara in liminalia.json)",
      dim: "Brightness when dimmed (0 to 1; default 0.6)",
      lower: "How far to move them down (px; default 12)",
      jump: "Make a character give a small hop when they start speaking",
      "move-time": "Time auto positions take to rearrange (if omitted, the same as the time to show or hide)",
      easing: "Easing when rearranging (default ease)",
    },
    keywords: ["sprite settings", "highlight speaker", "dim", "move down"],
  },
  "chara-hide": {
    summary: "Hide a sprite",
    example: "@chara-hide Akari time=300ms",
    params: {
      who: "Character ID",
      time: "Time to disappear",
      exit: "How the sprite leaves, over the time: fade disappears in place, left, right, top and bottom slide out to that side (by distance), and zoom shrinks away",
      wait: "Wait until it has disappeared before continuing",
    },
    keywords: ["hide sprite", "exit", "leave", "slide out"],
  },
  "chara-hide-all": {
    summary: "Hide all sprites",
    params: {
      time: "Time to disappear. Can also be written without a name (@chara-hide-all 300ms)",
      exit: "How the sprites leave (same as exit of @chara-hide)",
      wait: "Wait until they have disappeared before continuing",
    },
    keywords: ["hide all sprites", "everyone exits"],
  },
  face: {
    summary: "Set the expression in the face window (for a character whose sprite isn't shown; while the sprite is shown, its variant is used). When the sprite is hidden, the face window keeps the variant it had",
    example: "@face Akari smile",
    params: {
      who: "Character ID",
      variant: "Variant (expression). The base variant if omitted",
      appearance: "Sprite set. The default sprite set if omitted",
    },
    keywords: ["face window", "face", "expression"],
  },
  "face-off": {
    summary: "Hide the face window (when show of ui.face is explicit; it stays hidden until @face shows it)",
    keywords: ["face window", "face", "hide"],
  },
  bgm: {
    summary: "Play BGM",
    params: {
      file: "Audio file",
      volume: VOLUME,
      time: FADE_IN,
      loop: "Loop",
      crossfade: "Time to cross-fade from the current BGM (loads the new track first, then fades the current one out while fading the new one in)",
      "loop-start": "Where the loop starts (after the intro). If omitted, the LOOPSTART tag embedded in the track, or the beginning",
      "loop-end": "Where the loop ends. If omitted, computed from the embedded LOOPLENGTH tag, or the end",
      pan: PAN,
      rate: RATE,
      filter: `${FILTER} for the BGM`,
      "filter-strength": FILTER_STRENGTH,
      "filter-fade": "Time to apply or remove the filter (when applying it again to the same track that's playing)",
    },
    keywords: ["BGM", "music", "track", "play", "muffled", "filter"],
  },
  "stop-bgm": {
    summary: "Stop the BGM",
    params: { time: `${FADE_OUT}. Can also be written without a name (@stop-bgm 600ms)` },
    keywords: ["stop BGM", "stop music", "fade out"],
  },
  se: {
    summary: "Play a sound effect",
    params: {
      file: "Audio file",
      channel: "Playback channel. A sound on the same channel replaces the previous one",
      volume: VOLUME,
      time: FADE_IN,
      loop: "Loop",
      pan: PAN,
      rate: RATE,
      caption: "Caption (shown to players who turn on sound captions in Settings). If omitted, the caption from ui.captions.sounds in liminalia.json",
      filter: `${FILTER} for the sound effect`,
      "filter-strength": FILTER_STRENGTH,
      "filter-fade": "Time to apply or remove the filter",
    },
    keywords: ["sound effect", "SE", "sound", "play", "footsteps", "door", "ambience"],
  },
  "stop-se": {
    summary: "Stop sound effects",
    params: { channel: "Channel to stop", time: `${FADE_OUT}. Can also be written without a name (@stop-se 1s)` },
    keywords: ["stop sound effect"],
  },
  wait: {
    summary: "Wait for the given time",
    params: { time: "Time to wait" },
    keywords: ["wait", "pause", "delay"],
  },
  mask: {
    summary: "Cover the screen with a solid color (fade out)",
    params: {
      color: "Color to cover with",
      time: "Time to finish covering. Can also be written without a name (@mask 600ms)",
      method: "Motion when covering (same as method of @bg)",
      "hide-window": "Hide the message window once the screen is covered and show it again with the next text (so the previous text isn't seen during the fade in). false keeps it shown",
    },
    keywords: ["fade out", "fade to black", "black", "white", "cover the screen", "scene change"],
  },
  "mask-off": {
    summary: "Remove the screen cover (fade in)",
    params: {
      time: "Time to finish uncovering. Can also be written without a name (@mask-off 600ms)",
      method: "How the cover is removed (the outgoing motions of method of @bg)",
    },
    keywords: ["fade in", "undo fade out"],
  },
  "scene-change": {
    summary: "Change scenes: fade out, hide all sprites, change the background, then fade back in (@mask, @chara-hide-all, @bg and @mask-off in one command). It can also stop or change the BGM while the screen is covered",
    params: {
      image: "Background image. If omitted, the background stays (only the sprites are hidden)",
      "bg-color": "Make the background a solid color (written instead of image; same as @bg color=)",
      time: "Time for the fade out and for the fade in",
      "fade-out": "Time to fade out (cover the screen). time if omitted",
      "fade-in": "Time to fade in (uncover the screen). time if omitted",
      hold: "Time to stay covered (from changing the background until the fade in starts)",
      "hide-chara": "Hide sprites. false keeps everyone on screen and ignores hide-who, hide-chara-at and hide-fade",
      "hide-who": "Character to hide. If omitted, hide all sprites; if specified, keep the other sprites",
      "hide-chara-at": "When to start hiding sprites: covered after fading out, or start at the same time as fading out",
      "hide-at": "Previous name for hide-chara-at; do not specify both",
      "hide-fade": "Time for sprites to fade out, separate from the screen transition",
      color: "Fade color",
      "stop-bgm": "Stop the BGM while the screen is covered",
      bgm: "BGM to play while the screen is covered (replaces the current BGM and loops. Write a separate @bgm for finer control)",
      "bgm-volume": "Volume of the BGM to play (0–100, when bgm is given)",
      "bgm-fade": "Time to fade out the stopped BGM and fade in the new BGM (from the moment the screen is covered)",
      "hide-window": "Hide the message window and show it again with the next text. false keeps it shown",
      "hide-window-at": "When to hide the message window and its controls: start at the same time as fading out, or covered after fading out. Ignored when hide-window=false",
      tone: "Tone applied to sprites while the new background is shown (the same as tone= of @bg). If omitted, the tone from ui.backgroundTones in liminalia.json",
    },
    keywords: ["scene change", "fade out", "fade in", "switch scenes", "background", "hide all sprites", "fade", "stop BGM", "change track"],
  },
  quake: {
    summary: "Shake the screen",
    params: {
      time: "Length of the shake",
      count: "Number of shakes",
      horizontal: "Horizontal amplitude (px)",
      vertical: "Vertical amplitude (px)",
      target: "What to shake (screen shakes the background, sprites and foreground; background shakes only the background)",
      wait: "Wait until the shaking stops before continuing",
    },
    keywords: ["shake", "quake", "vibration", "earthquake", "impact"],
  },
  camera: {
    summary: "Zoom, move or rotate the whole screen",
    params: {
      zoom: "Zoom factor (1 is actual size)",
      x: "Camera's horizontal position (game screen px). Positive values move the camera right, so the view scrolls left. The closer the zoom, the farther it scrolls on screen",
      y: "Camera's vertical position (game screen px). Positive values move the camera down, so the view scrolls up. The closer the zoom, the farther it scrolls on screen",
      rotate: "Rotation angle (degrees)",
      "from-zoom": "Starting zoom factor. The current value if omitted",
      "from-x": "Starting horizontal position",
      "from-y": "Starting vertical position",
      "from-rotate": "Starting rotation angle",
      time: "Duration of the motion",
      ease: "Easing (ease, easeOutSine and so on)",
      yoyo: "Go and come back (move to the given view in half of time, then back to the previous view in the other half. The camera's state doesn't change)",
      wait: "Wait until the motion finishes before continuing",
    },
    keywords: ["camera", "close-up", "zoom", "zoom in", "zoom out", "pan", "yoyo", "bounce"],
  },
  "reset-camera": {
    summary: "Reset the camera",
    params: {
      time: "Time to reset",
      ease: "Easing",
      wait: "Wait until the camera is reset before continuing",
    },
    keywords: ["reset camera", "reset zoom"],
  },
  window: {
    summary: "Show or hide the message window",
    params: { mode: "show / hide", time: "Time to show or hide" },
    keywords: ["message window", "text box", "hide", "show"],
  },
  "window-image": {
    summary: "Change the message window's background image (omit the image to go back to ui.message.image)",
    params: { image: "Background image" },
    keywords: ["message window", "frame", "background", "image"],
  },
  nvl: {
    summary: "Switch to NVL mode, which shows text over the whole screen, or back to the message window (switching clears the text). style= uses a look from ui.nvlStyles in liminalia.json",
    params: { mode: "on (NVL mode) / off (message window)", style: "The name of a look (ui.nvlStyles; for letters and documents. Without it, the ui.nvl look)" },
    keywords: ["full-screen text", "NVL", "novel", "sound novel"],
  },
  vertical: {
    summary: "Switch the text to vertical writing (lines run from right to left) or back to horizontal (switching clears the text). Applies to the message window and NVL mode. The default is ui.message.vertical in liminalia.json",
    params: { mode: "on (vertical) / off (horizontal)" },
    keywords: ["vertical writing", "tategaki"],
  },
  balloon: {
    summary: "Switch to speech balloons (text shown above the speaking character's sprite) or back to the message window. A line whose speaker has no sprite on screen goes in a balloon at x and y if given, or in the message window otherwise",
    params: {
      mode: "on (speech balloons) / off (message window)",
      width: "Balloon width (px; default 520)",
      x: "Left edge of the balloon when the speaker has no sprite on screen (px; write it with y)",
      y: "Top edge of the balloon when the speaker has no sprite on screen (px)",
      tail: "Tail direction. A balloon without a sprite uses down (auto is the same) or up; with a sprite, the tail points at it. none draws no tail",
      "tail-x": "Tail position (px from the balloon's left edge). If omitted, the center of the sprite (or of the balloon when there is no sprite)",
    },
    keywords: ["speech balloon", "speech bubble"],
  },
  "text-sound": {
    summary: "Play a sound as text characters appear (can differ per speaker)",
    example: "@text-sound chime.wav who=Akari every=2",
    params: {
      file: "Sound to play (path from sound; a short sound)",
      who: `${SPEAKER}. If omitted, every speaker without their own setting, and narration`,
      volume: VOLUME,
      every: "Play it every this many characters",
    },
    keywords: ["text sound", "typing sound", "beep"],
  },
  "text-sound-off": {
    summary: "Stop the sound played as text appears",
    params: { who: "Speaker name. All if omitted" },
    keywords: ["stop text sound"],
  },
  name: {
    summary: "Change the name shown in the name box (the display name) for a speaker until @name-off. The character itself (lip sync, dimming of characters who aren't speaking, balloons, voice and name color) stays the speaker. For a single line, write {name Display name} right after the speaker on that line",
    example: "@name Akari as=???",
    params: {
      who: SPEAKER,
      as: "Name to show in the name box. Use (expression) for a variable, such as a name the player entered (its value at that moment is used)",
    },
    keywords: ["display name", "name box", "???", "hide name", "true identity", "player name"],
  },
  "name-off": {
    summary: "Change a display name set with @name back to the speaker's name",
    example: "@name-off Akari",
    params: { who: "Speaker name. All if omitted" },
    keywords: ["reset display name", "reset name box"],
  },
  clear: {
    summary: "Clear the text in the message window (in NVL mode, clears all the text shown)",
    keywords: ["clear text", "clear", "new page"],
  },
  "text-speed": {
    summary: "Change the text speed",
    params: { "per-char": "Time per character" },
    keywords: ["text speed", "slow text"],
  },
  "text-speed-reset": {
    summary: "Reset the text speed to the value in Settings",
    keywords: ["reset text speed"],
  },
  "cg-unlock": {
    summary: "Unlock a CG (makes it viewable in the CG gallery of Extras without showing it)",
    params: { image: "CG image", folder: "Asset folder (match the folder of extra.cg)" },
    keywords: ["CG", "event image", "unlock", "gallery"],
  },
  "wait-click": {
    summary: "Wait for a click without showing text",
    keywords: ["wait for click", "wait"],
  },
  stop: {
    summary: "Stop in a state where clicking doesn't advance (to wait for buttons or outside input)",
    keywords: ["end", "stop", "ending"],
  },
  auto: {
    summary: "Start or stop auto mode (advances the text automatically)",
    params: { mode: "start / stop" },
    keywords: ["auto", "auto advance"],
  },
  skip: {
    summary: "Start or stop skipping",
    params: { mode: "start / stop" },
    keywords: ["skip"],
  },
  "open-screen": {
    summary: "Open a system screen or a project screen and wait until it closes",
    params: {
      screen: "save (Save) / load (Load) / log (Log) / menu (Menu) / config (Settings) / extra (Extras) / items (Items) / help (Controls) / flowchart (Flowchart), or the name of a project screen a plugin registered with system.defineScreen",
    },
    keywords: ["save screen", "load screen", "settings screen", "open system screen", "project screen", "custom screen"],
  },
  "menu-button": {
    summary: "Show or hide the button that opens the menu",
    params: { mode: "show / hide" },
    keywords: ["menu button", "quick menu", "hide"],
  },
  shortcuts: {
    summary: "Turn keyboard and mouse shortcuts (save, skip, menu and so on) on or off",
    params: { mode: "on / off" },
  },
  config: {
    summary: "Change values in Settings (only the ones you write)",
    params: {
      "bgm-volume": "Overall BGM volume (0 to 100)",
      "se-volume": "Overall sound effect volume (0 to 100)",
      "voice-volume": "Overall voice volume (0 to 100)",
      "text-speed": "Text speed (time per character)",
      "auto-wait": "Auto mode wait (time before moving to the next page)",
      "auto-click-stop": "Clicking during auto mode stops it",
    },
  },
  fullscreen: {
    summary: "Toggle between full screen and windowed",
  },
  quit: {
    summary: "Quit the game (the iOS app and browsers, which the game can't close, say so and return to the title screen)",
    params: { ask: "Ask for confirmation before quitting" },
  },
  "title-screen": {
    summary: "End the playthrough and return to the title screen (after a bad end and so on). With the kind of ending in ending, the screen fades to black and shows the kind's wording (BAD END and so on) with the name in title, then returns to the title when the player presses (the Studio flowchart also shows it as an ending)",
    params: {
      ending: "Kind of ending: bad, normal, good, true, other (no wording of its own; only title is shown) and kinds added with endingKinds in liminalia.json. The wording on screen comes from the kind (BAD END for bad and so on)",
      title: "Name of this ending only (such as \"Silence\"). Shown with the kind's wording",
      text: "End mark shown below the name (the Japanese mark for \"the end\" if omitted; The End when playing in English)",
      card: "With ending, show the ending's name before returning to the title. false returns right away (use commandDefaults to turn it off for the whole project)",
    },
    example: '@title-screen ending=bad title="Silence"',
    keywords: ["return to title", "ending", "end"],
  },
  presence: {
    summary: "Show what the player is doing in Steam Rich Presence (in the desktop version, when connected to Steam). An empty string clears it",
    example: "@presence \"Chapter 1: Waiting for Stars\"",
    params: { text: "Text to show (set up \"#Status\" as \"%status%\" in the Rich Presence localization in Steamworks)" },
  },
  "window-title": {
    summary: "Change the window (tab) title",
    example: "@window-title \"Chapter 2\"",
    params: { title: "Title" },
    keywords: ["window title"],
  },
  "open-url": {
    summary: "Open a URL in the browser (the phone apps open it in the device's browser; http, https and mailto only)",
    params: { url: "URL to open" },
  },
  autosave: {
    summary: "Autosave (resumes from the next command; goes on the autosave page of the Load screen, replacing the oldest)",
    keywords: ["autosave", "save"],
  },
  autoload: {
    summary: "Load the newest autosave and continue from there (does nothing if there is none)",
  },
  backlog: {
    summary: "Turn recording of text in the log on or off",
    params: { mode: "on (record) / off (don't record)" },
  },
  "backlog-add": {
    summary: "Add text to the log",
    example: "@backlog-add \"(The door closes.)\"",
    params: { text: "Text to add", join: "Append it to the previous log entry" },
  },
  describe: {
    summary: "Text only for reading aloud (not shown on screen; passed to screen readers and text-to-speech with the next text. Use it to describe pictures and effects)",
    example: "@describe \"A classroom at dusk. It's raining outside the window\"",
    params: { text: "Description" },
    keywords: ["describe", "accessibility", "screen reader", "alt text"],
  },
  "pause-bgm": {
    summary: "Pause the BGM",
    keywords: ["pause BGM"],
  },
  "resume-bgm": {
    summary: "Resume paused BGM",
    keywords: ["resume BGM"],
  },
  "pause-se": {
    summary: "Pause sound effects",
    params: { channel: "Channel to pause. All if omitted" },
    keywords: ["pause sound effect"],
  },
  "resume-se": {
    summary: "Resume paused sound effects",
    params: { channel: "Channel to resume. All if omitted" },
    keywords: ["resume sound effect"],
  },
  "bgm-volume": {
    summary: "Change the volume of the BGM that is playing",
    params: { volume: VOLUME, time: "Time to change" },
    keywords: ["BGM volume", "volume"],
  },
  "se-volume": {
    summary: "Change the volume of sound effects that are playing",
    params: { volume: VOLUME, channel: "Channel to change. All if omitted", time: "Time to change" },
    keywords: ["sound effect volume", "volume"],
  },
  "wait-bgm": {
    summary: "Wait until the BGM finishes (looping BGM isn't waited for)",
    keywords: ["wait for BGM"],
  },
  "wait-se": {
    summary: "Wait until sound effects finish (looping sound effects aren't waited for)",
    params: { channel: "Channel to wait for. All if omitted" },
    keywords: ["wait for sound effect"],
  },
  voice: {
    summary: "Play a voice for a line (before a text line it plays with the next line; inside the text it plays at that point)",
    params: {
      file: "Audio file",
      volume: VOLUME,
      folder: "Folder to load from (for example, voices placed in the sound effect folder of an imported project)",
      caption: "Caption (for voice not written in the text, such as laughter, sighs or words that differ from the text. Shown to players who turn on sound captions in Settings)",
      channel: "Voice channel. Voices on different channels play at the same time (two people speaking together). Two @voice lines for different speakers before the same line also play together",
      who: `${SPEAKER} of this voice. If omitted, the line's speaker. Used for lip sync and for showing both names in the name box`,
      filter: `${FILTER} for this voice. If omitted, the one set by @voice-filter`,
      "filter-strength": FILTER_STRENGTH,
    },
    keywords: ["voice", "voice line", "two speakers", "together"],
  },
  "voice-filter": {
    summary: "Keep a sound filter on voices (over the phone, radio, muffled, hall reverb). who sets it per speaker, and none removes it. It also applies right away to voices that are playing",
    example: "@voice-filter phone who=Mika",
    params: {
      filter: `${FILTER} to apply`,
      "filter-strength": FILTER_STRENGTH,
      who: `${SPEAKER}. If omitted, every speaker`,
      time: "Time to apply or remove it on voices that are playing",
    },
    keywords: ["voice", "filter", "phone", "radio", "muffled", "echo"],
  },
  "voice-auto": {
    summary: "Automatically play numbered voice files for each of a speaker's lines (a line with @voice uses that instead). With pattern it sets this up; without it, it resumes what @voice-auto-off stopped, keeping the numbers (all speakers if who is also omitted)",
    example: "@voice-auto Akari pattern=\"akari/{n:3}.ogg\"",
    params: {
      who: `${SPEAKER}. If omitted, resumes every speaker that is set up`,
      pattern: "File name pattern. {n} becomes the number ({n:3} pads it to 3 digits)",
      next: "Next number to play. Defaults to 1 when setting up, or to the number where it stopped when resuming",
      volume: "Volume (0 to 100). Only when setting up",
      folder: "Folder to load from. Only when setting up",
      start: "Start playing right after setting up (false only sets it up; start it with @voice-auto)",
    },
    keywords: ["voice", "numbered files", "auto play"],
  },
  "voice-auto-off": {
    summary: "Stop automatic playback of numbered voices (the number is kept, so @voice-auto can resume it)",
    example: "@voice-auto-off Akari",
    params: { who: "Speaker name. All if omitted" },
    keywords: ["stop auto voice"],
  },
  "stop-voice": {
    summary: "Stop the voice that is playing",
    params: { time: `${FADE_OUT}. Can also be written without a name (@stop-voice 500ms)` },
    keywords: ["stop voice"],
  },
  "wait-voice": {
    summary: "Wait until the voice finishes",
    keywords: ["wait for voice"],
  },
  "item-add": {
    summary: "Add an item (a name from items in liminalia.json). In expressions, item(\"name\") reads the count",
    params: { item: "Item name", count: "Number to add", notify: "Show a notice at the edge of the screen that it was obtained" },
    keywords: ["item", "inventory", "obtain"],
  },
  "item-remove": {
    summary: "Remove items (all of them if count is omitted)",
    params: { item: "Item name", count: "Number to remove (all if omitted)" },
    keywords: ["discard item", "inventory"],
  },
  "item-select": {
    summary: "Open the items screen, let the player pick one, and store its name in a variable (an empty string if they cancel). Useful for choosing an item to use on an investigation spot",
    params: { variable: "Variable to store the chosen item's name in", title: "Screen heading (if omitted, the standard \"Use what?\" text)" },
    keywords: ["choose item", "inventory"],
  },
  "text-input": {
    summary: "Let the player type text and store it in a variable (waits until they confirm)",
    example: "@text-input game.name prompt=\"Enter your name\" initial=\"Akari\" max=8 required=true",
    params: {
      variable: "Variable to store the entered text in",
      prompt: "Heading above the input field (such as \"Enter your name\")",
      initial: "Text already in the field",
      placeholder: "Hint shown faintly while the field is empty",
      max: "Maximum number of characters",
      required: "Don't allow confirming while the field is empty (or only spaces)",
      mode: "Kind of input. number uses the number keyboard and accepts digits only; password hides what's typed (for PINs and such)",
      pattern: "Accepted format (a regular expression; confirming is disabled until the whole text matches, like [0-9]{4})",
    },
    keywords: ["name entry", "text input", "protagonist name"],
  },
  dialog: {
    summary: "Show a confirmation dialog and wait for an answer",
    example: "@dialog \"Return to the title?\" type=confirm target=title",
    params: {
      text: "Text to show",
      type: "alert (OK only) / confirm (OK and Cancel) / input (enter text)",
      "ok-label": "OK button text. If omitted, the text for the language being played (OK in Japanese)",
      "cancel-label": "Cancel button text. If omitted, the text for the language being played (Cancel in English)",
      target: "Jump target for OK. If omitted, continues to the next line",
      "cancel-target": "Jump target for Cancel. If omitted, continues to the next line",
      variable: "Variable to store the text entered with input",
    },
    keywords: ["confirm", "dialog", "yes or no"],
  },
  peek: {
    summary: "Hide the message window for a moment and bring it back on click (the text isn't cleared)",
    keywords: ["peek", "hide message"],
  },
  "clear-vars": {
    summary: "Delete variables in bulk",
    params: { scope: "game / system / temp / all (all three)" },
  },
  "clear-stack": {
    summary: "Discard all @call return points (for example, when returning to the title from inside a subroutine)",
  },
  "sleep-game": {
    summary: "Save the current state and go to another scene (@awake-game returns to the command after this one)",
    params: { target: "Jump target" },
  },
  "awake-game": {
    summary: "Return to the state saved by @sleep-game (does nothing if no state was saved)",
    params: { "keep-variables": "Keep the current values of game variables (game.)", "keep-bgm": "Keep the BGM that is playing now" },
  },
  "break-game": {
    summary: "Discard the state saved by @sleep-game",
  },
  checkpoint: {
    summary: "Save the current state under a name (@rollback can return here)",
    params: { name: "Name" },
    keywords: ["checkpoint", "retry"],
  },
  rollback: {
    summary: "Return to a state saved by @checkpoint",
    params: {
      name: "Name of the checkpoint to return to",
      "keep-variables": "Keep the current values of game variables (game.)",
      "keep-bgm": "Keep the BGM that is playing now",
    },
    keywords: ["rewind", "retry"],
  },
  "clear-checkpoint": {
    summary: "Discard states saved by @checkpoint",
    params: { name: "Name to discard. All if omitted" },
  },
  "glossary-unlock": {
    summary: "Unlock a glossary term (terms that appear in the text unlock automatically)",
    params: { id: "Term id (an id in extra.glossary of liminalia.json)" },
    keywords: ["term", "glossary", "dictionary", "unlock"],
  },
  "replay-unlock": {
    summary: "Unlock a replay (makes it viewable in the replays of Extras without playing it)",
    params: { id: "Replay name (an id in extra.replay of liminalia.json)" },
    keywords: ["replay", "unlock"],
  },
  "replay-end": {
    summary: "End replay playback here and return to Extras (does nothing outside a replay)",
    keywords: ["end of replay"],
  },
  achieve: {
    summary: "Unlock an achievement (a notice appears only the first time). The desktop version also sends it to Steam, and the mobile version to Game Center and Google Play Games",
    params: { id: "Achievement name (an id in extra.achievements of liminalia.json)" },
    keywords: ["achievement", "trophy", "Steam"],
  },
  "achieve-progress": {
    summary: "Advance a counting achievement (goal in extra.achievements of liminalia.json). Reaching the goal unlocks it (with a notice, like @achieve). The desktop and mobile versions also send the progress to the store",
    params: {
      id: "Achievement name (an id in extra.achievements of liminalia.json that has a goal)",
      add: "Amount to add (not used when set is given)",
      set: "Set the count to this value (ignored if it's lower than the current count)",
    },
    keywords: ["achievement progress", "counting achievement", "trophy", "count"],
  },
  "check-update": {
    summary: "Check for an update and, if there is one, ask the player and install it (in the desktop version when build.update is in liminalia.json; does nothing elsewhere)",
  },
  purchase: {
    summary: "Buy a product (in-app purchases in the mobile version, store DLC in the desktop version and so on). Waits until the store screen closes; after a purchase, system.purchases.<product> becomes true",
    params: { product: "Product name (a key in build.store.products of liminalia.json)" },
  },
  "restore-purchases": {
    summary: "Restore purchases (after changing devices and so on). system.purchases.<product> becomes true for products the player owns",
  },
};

/** @choice の行（CHOICE_BLOCK）と選択肢の行（CHOICE_OPTION）。どちらも名前が choice なので別に持つ。 */
export const CHOICE_EN: Readonly<Record<"block" | "option", CommandEnglish>> = {
  block: {
    summary: "Choices. List the choice lines and close with @end",
    params: {
      timeout: "Time limit. When it runs out, the default choice is picked (without default, nothing is picked and play continues after @end). A bar shows the remaining time. It doesn't count down while a screen such as the menu or save is open",
      default: "Choice to pick when time runs out (its position from the top; if that choice is hidden or disabled, nothing is picked and play continues after @end)",
    },
    keywords: ["choice", "branch", "choose", "route"],
  },
  option: {
    summary: "Condition and appearance of a choice line",
    example: "- Examine the door -> #door if=(game.has_key) x=120 y=300",
    params: {
      locked: "When true, show the choice disabled (shows a choice whose condition isn't met instead of hiding it)",
      if: "Condition for showing it. When false, this choice isn't shown (if every choice is false, play stops without showing any)",
      call: "Call the jump target (@call), and when it hits @return, come back and show these choices again (for toggle buttons and so on)",
      image: "Button image",
      hover: "Image on mouseover",
      x: "Horizontal position of the top-left corner (px)",
      y: "Vertical position of the top-left corner (px)",
      width: "Width (px). For an image, its size if omitted",
      height: "Height (px)",
      cursor: "Mouse cursor image on hover (such as a magnifying glass on an investigation spot; the hotspot is the image's center)",
      tip: "Short tooltip on hover (such as the name of an investigation spot)",
    },
    keywords: ["choice", "branch", "choose", "route"],
  },
};

/** 共通のパラメータ（registry.ts の SKIP_PARAM、RULE_PARAMS など）の英語。 */
export const SHARED_PARAMS_EN = {
  // 演出を飛ばせるかとルール画像の引数の英語は、正本（@liminalia/sdk）と同じものを使う
  skip: SKIP_PARAM.docEn as string,
  rule: RULE_PARAMS.rule?.docEn as string,
  pattern: RULE_PARAMS.pattern?.docEn as string,
  vague: RULE_PARAMS.vague?.docEn as string,
  distance: "Distance moved for left, right, top and bottom (px)",
  volume: VOLUME,
} as const;

/** 式の関数の書き方の英語（FUNCTION_USAGE と同じ並び）。 */
export const FUNCTION_USAGE_EN: Readonly<Record<string, readonly string[]>> = {
  random: ["random()", "random(n)"],
  randint: ["randint(a, b)"],
  pick: ["pick(array)"],
  shuffle: ["shuffle(array)"],
  floor: ["floor(x)"],
  ceil: ["ceil(x)"],
  round: ["round(x)", "round(x, digits)"],
  min: ["min(a, b, …)"],
  max: ["max(a, b, …)"],
  abs: ["abs(x)"],
  clamp: ["clamp(x, low, high)"],
  sum: ["sum(array)"],
  len: ["len(string or array)"],
  includes: ["includes(string or array, value)"],
  index: ["index(string or array, value)"],
  slice: ["slice(string or array, start)", "slice(string or array, start, end)"],
  replace: ["replace(string, search, replacement)"],
  upper: ["upper(string)"],
  lower: ["lower(string)"],
  trim: ["trim(string)"],
  split: ["split(string, separator)"],
  join: ["join(array)", "join(array, separator)"],
  pad: ["pad(value, digits)", "pad(value, digits, fill)"],
  str: ["str(value)"],
  num: ["num(value)"],
  push: ["push(array, value)"],
  remove: ["remove(array, value)"],
  sort: ["sort(array)"],
  reverse: ["reverse(array)"],
  unique: ["unique(array)"],
  keys: ["keys(object)"],
  has: ["has(object, name)"],
  version_before: ['version_before(version, "1.1.0")'],
  year: ["year()"],
  month: ["month()"],
  day: ["day()"],
  hour: ["hour()"],
  minute: ["minute()"],
  weekday: ["weekday()"],
  now: ["now()"],
  item: ['item("name")'],
  visits: ['visits("#label")', 'visits("file#label")', 'visits("file")'],
  read: ['read("#label")', 'read("file#label")', 'read("file")'],
  chosen: ['chosen("choice text")'],
  lang: ["lang()"],
  platform: ["platform()"],
  app: ["app()"],
  replaying: ["replaying()"],
  chapter: ["chapter()"],
  endings: ["endings()", 'endings("bad")'],
};

/** 式の関数の説明の英語（FUNCTION_DOCS と同じ並び）。 */
export const FUNCTION_DOCS_EN: Readonly<Record<string, string>> = {
  random: "With no argument, a number from 0 up to (but not including) 1. With n, an integer from 0 up to (but not including) n",
  randint: "An integer from a to b, inclusive",
  pick: "One element picked from the array (null if it's empty)",
  shuffle: "A new array with the elements in random order",
  floor: "Round down",
  ceil: "Round up",
  round: "Round to the nearest integer. With digits, round to that many decimal places",
  min: "The smallest number",
  max: "The largest number",
  abs: "Absolute value",
  clamp: "Keep the value between low and high",
  sum: "Sum of the numbers",
  len: "Number of characters in a string, or length of an array",
  includes: "Whether it contains the value",
  index: "Position of the first occurrence of the value (-1 if not found)",
  slice: "Part of it (end is excluded; to the end if omitted; negative numbers count from the end)",
  replace: "Replace every occurrence",
  upper: "Convert letters to uppercase",
  lower: "Convert letters to lowercase",
  trim: "Remove leading and trailing whitespace",
  split: "Array of the parts divided by the separator",
  join: "String joined with the separator (empty if omitted)",
  pad: "Pad the front to the given number of digits (with 0 if fill is omitted)",
  str: "Convert to a string",
  num: "Convert to a number (null if it can't be read as a number)",
  push: "A new array with the value added at the end",
  remove: "A new array without that value",
  sort: "A new sorted array (numbers in ascending order, strings in dictionary order)",
  reverse: "A new array in reverse order",
  unique: "A new array without duplicates",
  keys: "Array of the names",
  has: "Whether the name exists",
  version_before: "Whether the version comes before the other one (1.9.0 is before 1.10.0, and 1.1.0-beta is before 1.1.0; an empty version comes before every version). Compare save.version with it when an update moves variables in old saves",
  year: "The current year (from the player's device clock)",
  month: "The current month (1 to 12)",
  day: "Today's day of the month (1 to 31)",
  hour: "The current hour (0 to 23)",
  minute: "The current minute (0 to 59)",
  weekday: "Today's day of the week (0 is Sunday, 6 is Saturday)",
  now: "The current time (milliseconds since 1970)",
  item: "How many of the item the player has (a name from items in liminalia.json; 0 if none)",
  visits: "How many times this playthrough has entered the label (or the start of the file if only a file is given). Counting starts at 1 inside the label, so it's 1 on the first visit. Saved with the game",
  read: "Whether the label (or the start of the file if only a file is given) has ever been entered in any playthrough (read status, shared by all saves)",
  chosen: "Whether this playthrough has picked the choice with that text (write ruby as the base text; use the original text, not a translation). Saved with the game",
  lang: "The language being played (one of languages in liminalia.json, such as ja or en)",
  platform: "The kind of device: pc (computer) or mobile (phone or tablet)",
  app: "Whether the game runs in an app (desktop or mobile version). false in a browser",
  replaying: "Whether a replay from Extras is playing",
  chapter: "Chapter of the current scenario file (an id from chapters in liminalia.json; empty if it belongs to no chapter)",
  endings: "Number of endings seen in any playthrough (shared by all saves). Pass a kind (bad and so on) to count only that kind. Seeing the same ending again doesn't count twice. The current playthrough's ending counts once the command that ends the play (@title-screen) runs",
};
