import { describe, expect, it } from "vitest";
import { check, CORE_COMMANDS, createRegistry, parse } from "@liminalia/lang";
import { castFromTatieSettings, collectCharas, convert, convertJsAssignments, convertJsExpression, mergeCast, type ConvertOptions } from "../src/index.ts";
import { combinePlugins } from "@liminalia/plugin-host";
import std from "@liminalia/std/commands";

const STD_SPECS = combinePlugins([std]).specs;

const speakers = new Set(["ユイ", "レン", "ハル"]);
const lim = (ks: string) => convert(ks, "t.ks", { speakers }).text;
const codes = (ks: string) => convert(ks, "t.ks", { speakers }).diagnostics.map((d) => d.code);

describe("本文", () => {
  it("話者の切り替えと [p] が一行ずつの台詞になる", () => {
    const ks = "[tb_start_text mode=1 ]\n# ユイ\n「おはよう」[p]\n#\nユイの声で眠気が消える。[p]\n[_tb_end_text]";
    expect(lim(ks)).toBe("ユイ「おはよう」\nユイの声で眠気が消える。\n");
  });

  it("引用符で始まる話者の本文は英語の台詞（話者名と引用符のあいだに半角の空白）。話者名に紛れる地の文はエスケープする", () => {
    const ks = '[tb_start_text mode=1 ]\n# ユイ\n"Good morning."[p]\n# レン\n“Wait!”[p]\n#\nユイ "x" と書いた。[p]\n[_tb_end_text]';
    expect(lim(ks)).toBe('ユイ "Good morning."\nレン “Wait!”\n\\ユイ "x" と書いた。\n');
    expect(codes(ks)).toEqual([]);
  });

  it("[l] は {click}、[r] は {br}、ルビは {r …}", () => {
    expect(lim("ただ一言、[l]「よかったら」[r]と[srb text=たそがれ]黄昏[erb]で。[p]")).toBe("ただ一言、{click}「よかったら」{br}と{r 黄昏|たそがれ}で。\n");
  });

  it("auto_ruby の本文中の記法 ｜対象《ルビ》 も {r …}。記法として閉じていないものは文字のまま", () => {
    expect(lim("その｜黄昏《トワイライト》を、|夜《よる》に。[p]")).toBe("その{r 黄昏|トワイライト}を、{r 夜|よる}に。\n");
    expect(lim("《白い本》と｜《x》と｜y[p]")).toBe("《白い本》と｜《x》と｜y\n");
  });

  it("本文中の { } \\ と、行頭の記号・話者名に紛れる地の文をエスケープする", () => {
    expect(lim("a{b}c\\\\d[p]")).toBe("a\\{b\\}c\\\\d\n");
    expect(lim("_@マーク[p]\nユイ「……」と言った。[p]")).toBe("\\@マーク\n\\ユイ「……」と言った。\n");
  });

  it("本文の外の [l] と空の [p] はクリック待ちの命令", () => {
    expect(lim("[show_note text=a]\n[l]")).toBe("@show-note text=a\n@wait-click\n");
  });

  it("行の途中の命令は {@…}、同じ行で閉じる [delay] は {speed …}", () => {
    expect(lim("「[delay speed=600]……[resetdelay]は？」[p]")).toBe("「{speed 600ms ……}は？」\n");
    expect(lim('ごちそうさま！[l][playse storage="se/bell.mp3"]あ。[p]')).toBe("ごちそうさま！{click}{@se se/bell.mp3}あ。\n");
  });

  it("行末の半角空白は落とす", () => {
    expect(lim("窓を開けた。 [p]")).toBe("窓を開けた。\n");
  });
});

describe("命令", () => {
  it("TyranoScript の既定値を補ったうえで、新形式の既定値と同じものは書かない", () => {
    // bg の time は TyranoScript の既定が 3000ms
    expect(lim('[bg storage="room.jpg"]')).toBe("@bg room.jpg time=3s\n");
    expect(lim('[bg storage="room.jpg" time=0 method=crossfade wait=true]')).toBe("@bg room.jpg\n");
    // chara_hide は TyranoScript では既定で待つ
    expect(lim("[chara_hide name=レン time=300]")).toBe("@chara-hide レン time=300ms wait=true\n");
  });

  it("作品側の変換表（profile）で、プラグインのタグを組み込みの命令にできる", () => {
    const profile = {
      chara_pose: (pm: Record<string, string>) => ({
        name: "chara",
        positional: [pm.name ?? "", pm.face ?? "normal"],
        named: [["at", pm.pos ?? "center", "center"]] as [string, string, string | null][],
      }),
    };
    expect(convert('[chara_pose name="ユイカ" face="smile" pos="left"]', "t.ks", { profile }).text).toBe("@chara ユイカ smile at=left\n");
  });

  it("音", () => {
    expect(lim('[playse volume="70" buf="2" storage="se/a b.mp3" html5=true]')).toBe('@se "se/a b.mp3" channel=2 volume=70\n');
    expect(lim("[stopbgm time=600 fadeout=true]")).toBe("@stop-bgm time=600ms\n");
  });

  it("色と暗転", () => {
    expect(lim('[mask time="1000" effect="fadeIn" color="0xFFFFFF"]')).toBe("@mask color=#ffffff time=1s\n");
  });

  it("飛び先とラベル", () => {
    expect(lim('*start\n[jump storage="chapter2.ks" target="*harbor"]\n[jump target=*start]')).toBe(
      "# start\n@jump chapter2#harbor\n@jump #start\n",
    );
  });

  it("選択肢", () => {
    const ks = '[glink text="北の道" target="*a"]\n[glink text="南の道" storage="ep.ks" target="*b"]\n[s]';
    expect(lim(ks)).toBe("@choice\n  - 北の道 -> #a\n  - 南の道 -> ep#b\n@end\n");
  });

  it("選択肢のタグの cond は、@if で囲まずにその選択肢の行の if=(式) にする", () => {
    const ks = [
      '[glink text="北の道" target="*a" cond="f.north==false"]',
      '[glink text="南の道" target="*a" x=10 cond="f.north==true&&sf.clear"]',
      '[glink text="戻る" target="*a"]',
      "[s]",
      "*a",
    ].join("\n");
    const r = convert(ks, "t.ks", { speakers });
    expect(r.text).toBe("@choice\n  - 北の道 -> #a if=(game.north==false)\n  - 南の道 -> #a if=(game.north==true&&system.clear)\n  - 戻る -> #a\n@end\n\n# a\n");
    expect(r.diagnostics).toEqual([]);
    expect(r.map.slice(0, 5).map((o) => o?.kind ?? null)).toEqual(["choice", "option", "option", "option", "choice-end"]);
    expect(parse(r.text, "t.lim").diagnostics).toEqual([]);
    // [button] [clickable] [link] の cond も同じ。変換できない式は報告して条件なしで出す
    expect(lim('[button graphic=ok.png target=*a cond="tf.ok"]\n[clickable width=3 height=4 target=*a cond="!tf.ok"]\n[s]\n*a')).toBe(
      "@choice\n  - -> #a if=(temp.ok) image=ok.png\n  - -> #a if=(!temp.ok) width=3 height=4\n@end\n\n# a\n",
    );
    expect(lim('[link target=*a cond="f.n>1"]行く[endlink][r]\n[link target=*a]戻る[endlink]\n[s]\n*a')).toBe("@choice\n  - 行く -> #a if=(game.n>1)\n  - 戻る -> #a\n@end\n\n# a\n");
    expect(codes('[glink text="北" target="*a" cond="$(\'#x\').length"]\n[s]\n*a')).toEqual(["manual-cond"]);
  });

  it("if と cond", () => {
    expect(lim('[if exp="f.a==1"]\nA[p]\n[else]\nB[p]\n[endif]')).toBe("@if game.a==1\n  A\n@else\n  B\n@end\n");
    expect(lim('[jump target=*x cond="tf.go"]\n*x')).toBe("@if temp.go\n  @jump #x\n@end\n\n# x\n");
  });

  it("対応のないタグは汎用の形で書き出して数える", () => {
    const r = convert("[fx_speedline dir=left time=300 density=0.65 wait=false]", "t.ks");
    expect(r.text).toBe("@fx-speedline dir=left time=300 density=0.65 wait=false\n");
    expect(r.stats.byTag.fx_speedline).toEqual({ generic: 1 });
  });

  it("iscript は @script に入れて手作業の対象にする", () => {
    const r = convert('[iscript]\n$(".a").hide();\n[endscript]', "t.ks");
    expect(r.text).toBe('@script\n  $(".a").hide();\n@end\n');
    expect(r.diagnostics.map((d) => d.message)).toEqual(["[iscript] の JS は書き直しが必要です（jQuery を使用）"]);
  });

  it("書き出した結果は新形式として構文エラーなく読める", () => {
    const ks = "[tb_start_text mode=1 ]\n# ハル\n「[delay speed=600]……[resetdelay]は？」[p]\n[_tb_end_text]\n[l]\n*end";
    expect(parse(lim(ks), "t.lim", { speakers }).diagnostics).toEqual([]);
    expect(codes(ks)).toEqual([]);
  });
});

describe("TyranoScript 標準の立ち絵", () => {
  const define = [
    '[chara_new name="yuika" storage="y/normal.png" jname="ユイ"]',
    '[chara_face name="yuika" face="smile" storage="y/smile.png"]',
    '[chara_new name="ren" storage="r/normal.png" jname="レン" reflect="true"]',
    '[chara_new name="haru" storage="h/normal.png"]',
  ].join("\n");
  const charas = collectCharas([{ file: "system/chara_define.ks", source: define }]).defs;
  const run = (ks: string, extra: Partial<ConvertOptions> = {}) => convert(ks, "t.ks", { speakers: new Set(["ユイ", "レン"]), charas, ...extra });
  const text = (ks: string, extra: Partial<ConvertOptions> = {}) => run(ks, extra).text;
  const warnings = (ks: string) => run(ks).diagnostics.map((d) => d.code);

  it("[chara_show] は TyranoScript の既定（time=1000・wait=true・自動配置・反転の記憶・表示中なら何もしない）を書き出す", () => {
    expect(text('[chara_show name="yuika"]')).toBe("@chara yuika default at=auto time=1s wait=true if-hidden=true\n");
    expect(text('[chara_show name="ren" face="" time="0" wait="false"]')).toBe("@chara ren default at=auto flip=true if-hidden=true\n");
    expect(text('[chara_show name="yuika" face="smile" top="50" reflect="true" time="0"]')).toBe("@chara yuika smile at=auto y=50 flip=true wait=true if-hidden=true\n");
    // 消したばかりと分かっていれば if-hidden は要らない
    expect(text('[chara_hide name="yuika" time="0"]\n[chara_show name="yuika" time="0"]')).toBe("@chara-hide yuika wait=true\n@chara yuika default at=auto wait=true\n");
  });

  it("[chara_show] の zindex は @chara の z=（既定の 1 は書かない。0 は .lim の既定と同じ重なりになるので知らせる）", () => {
    expect(text('[chara_show name="yuika" zindex="5" time="0"]')).toBe("@chara yuika default at=auto z=5 wait=true if-hidden=true\n");
    expect(text('[chara_show name="yuika" zindex="-2" time="0"]')).toBe("@chara yuika default at=auto z=-2 wait=true if-hidden=true\n");
    expect(text('[chara_show name="yuika" zindex="1" time="0"]')).toBe("@chara yuika default at=auto wait=true if-hidden=true\n");
    expect(text('[chara_show name="yuika" zindex="&f.z" time="0"]')).toBe("@chara yuika default at=auto z=(game.z) wait=true if-hidden=true\n");
    expect(warnings('[chara_show name="yuika" zindex="5" time="0"]')).toEqual([]);
    expect(warnings('[chara_show name="yuika" zindex="0" time="0"]')).toEqual(["chara-zindex"]);
    expect(warnings('[chara_show name="yuika" zindex="top" time="0"]')).toEqual(["lossy-param"]);
    expect(check(parse(text('[chara_show name="yuika" zindex="5"]'), "t.lim", { speakers: [] }), { registry: createRegistry(CORE_COMMANDS) }).filter((d) => d.severity === "error")).toEqual([]);
  });

  it("[chara_hide] の pos_mode=false は、自動配置した立ち絵があるときだけ知らせる", () => {
    const codes = (ks: string) => run(ks).diagnostics.map((d) => d.code);
    expect(codes('[chara_show name="yuika" left="0" time="0"]\n[chara_hide name="yuika" pos_mode="false" time="0"]')).toEqual([]);
    expect(codes('[chara_show name="ren" time="0"]\n[chara_hide name="yuika" pos_mode="false" time="0"]')).toEqual(["lossy-param"]);
  });

  it("[voconfig] は設定だけの @voice-auto（話者は名前欄の名前、{number} は {n}）、[vostart] / [vostop] は再開と停止", () => {
    const ks = '[voconfig sebuf="2" name="yuika" vostorage="yuika_{number}.ogg" number="1"]\n[vostart]\n[vostop]';
    expect(text(ks)).toBe("@voice-auto ユイ pattern=yuika_{n}.ogg next=1 folder=sound start=false\n@voice-auto\n@voice-auto-off\n");
    expect(warnings(ks)).toEqual(["lossy-param"]);
    expect(parse(text(ks), "t.lim", { speakers: ["ユイ"] }).diagnostics).toEqual([]);
  });

  it("left があれば座標で置く（top が無ければ 0）。pos_mode=false なら left が無くても 0", () => {
    expect(text('[chara_show name="yuika" left="-40" time="0"]')).toBe("@chara yuika default x=-40 y=0 wait=true if-hidden=true\n");
    expect(text('[chara_config pos_mode="false"]\n[chara_show name="yuika" time="0"]')).toBe("@chara yuika default x=0 y=0 wait=true if-hidden=true\n");
    expect(text('[chara_show name="yuika" time="0"]', { charaConfig: { posMode: false, time: "600", memory: false, talkAnim: "none" } })).toBe(
      "@chara yuika default x=0 y=0 wait=true if-hidden=true\n",
    );
  });

  it("[chara_mod] は差分を書いた @chara。立ち絵セット・位置・反転は、出ていて同じ値と分かっているものだけ省く（@chara は出ている人物の今の値を保つため）。time の既定は [chara_config] の time", () => {
    expect(text('[chara_mod name="yuika" face="smile"]')).toBe("@chara yuika smile appearance=default at=auto flip=false time=600ms wait=true\n");
    expect(text('[chara_config time="200"]\n[chara_mod name="yuika" face="smile" wait="false"]')).toBe("@chara yuika smile appearance=default at=auto flip=false time=200ms\n");
    const ks = '[chara_show name="yuika" left="10" time="0"]\n[chara_mod name="yuika" face="smile" cross="false"]\n[chara_mod name="yuika" reflect="true" time="0"]';
    expect(text(ks)).toBe(
      [
        "@chara yuika default x=10 y=0 wait=true if-hidden=true",
        "@chara yuika smile cross=false time=600ms wait=true",
        "@chara yuika smile flip=true wait=true",
        "",
      ].join("\n"),
    );
    // 位置が分からず pos_mode=false なら (0, 0) にして知らせる
    expect(run('[chara_config pos_mode="false"]\n[chara_mod name="yuika" face="smile" time="0"]').diagnostics.map((d) => d.code)).toEqual(["chara-position-unknown"]);
  });

  it("storage の直接指定は、定義済みの画像ならその表情、そうでなければファイル名を表情名にしてキャストに足す", () => {
    const r = run('[chara_mod name="yuika" storage="y/smile.png" time="0"]\n[chara_mod name="yuika" storage="y/extra/cry.png" time="0"]');
    expect(r.text).toBe("@chara yuika smile appearance=default at=auto flip=false wait=true\n@chara yuika cry wait=true\n");
    expect(r.variants).toEqual(new Map([["yuika", new Map([["cry", "y/extra/cry.png"]])]]));
    // 表情名がほかの画像とぶつかるときは拡張子を除いたパス
    expect(text('[chara_mod name="yuika" storage="other/smile.png" time="0"]')).toBe("@chara yuika other/smile appearance=default at=auto flip=false wait=true\n");
  });

  it("[chara_show] の storage は次に face なしで出すときの表情になる。消すと default に戻る（memory=false）", () => {
    const ks = [
      '[chara_show name="yuika" storage="y/smile.png" time="0"]',
      '[chara_hide name="yuika" time="0"]',
      '[chara_mod name="yuika" face="smile"]',
      '[chara_show name="yuika" time="0"]',
      '[chara_hide name="yuika" time="0"]',
      '[chara_show name="yuika" time="0"]',
    ].join("\n");
    expect(text(ks)).toBe(
      [
        "@chara yuika smile at=auto wait=true if-hidden=true",
        "@chara-hide yuika wait=true",
        // 消えている立ち絵への [chara_mod] は、次に出す表情を変えるだけ
        "@chara yuika smile at=auto wait=true",
        "@chara-hide yuika wait=true",
        "@chara yuika default at=auto wait=true",
        "",
      ].join("\n"),
    );
    expect(warnings(ks)).toEqual(["chara-mod-hidden"]);
  });

  it("話者は名前欄に出る文字列（name なら jname、jname が空なら名前欄も空）。`#名前:表情` は [chara_mod]", () => {
    const ks = "[tb_start_text mode=1 ]\n#yuika:smile\n「おはよう」[p]\n#レン\n「ああ」[p]\n#haru\n「……」[p]\n#店員\n「いらっしゃい」[p]\n[_tb_end_text]";
    const r = run(ks, { speakers: new Set(["ユイ", "レン", "店員"]) });
    expect(r.text).toBe("@chara yuika smile appearance=default at=auto flip=false time=600ms wait=true\nユイ「おはよう」\nレン「ああ」\n「……」\n店員「いらっしゃい」\n");
    expect(r.diagnostics).toEqual([]);
    // talk_anim があると、表情は待たずに一瞬で変わる（話し始めた人物を跳ねさせる @chara-config jump=true にもなる）
    expect(text('[chara_config talk_anim="up"]\n#ユイ:smile')).toBe("@chara-config jump=true\n@chara yuika smile appearance=default at=auto flip=false\n");
  });

  it("未定義のキャラクター・表情は手作業の対象（TyranoScript ではエラーで止まる）", () => {
    const r = run('[chara_show name="nobody"]\n[chara_mod name="yuika" face="angry"]');
    expect(r.text).toBe("// TODO ks: [chara_show name=nobody]\n// TODO ks: [chara_mod name=yuika face=angry]\n");
    expect(r.diagnostics.map((d) => [d.severity, d.code])).toEqual([
      ["error", "undefined-chara"],
      ["error", "undefined-face"],
    ]);
    expect(r.stats.byTag).toMatchObject({ chara_show: { manual: 1 }, chara_mod: { manual: 1 } });
  });

  it("定義を渡さなければ、ファイルの中の定義だけを使う（定義が無ければ確かめない）", () => {
    expect(convert(`${define}\n#yuika\n「やあ」[p]`, "t.ks").text).toBe("ユイ「やあ」\n");
    expect(convert('[chara_show name="ユイカ" face="smile" time="0"]', "t.ks").text).toBe("@chara ユイカ smile at=auto wait=true if-hidden=true\n");
  });

  it("意味を保てない引数と、自動配置の外に置いた立ち絵が自動配置で並べ直される箇所を報告する", () => {
    const ks = '[chara_show name="ren" left="10" time="0"]\n[chara_show name="yuika" layer="1" zindex="3" time="0"]\n[chara_config talk_focus="brightness" effect="linear" anim="false"]';
    const r = run(ks);
    expect(r.diagnostics.map((d) => [d.code, d.message])).toEqual([
      ["lossy-param", "[chara_show] の layer=1 は変換していません"],
      ["chara-position-mixed", "TyranoScript ではここで自動配置の外に置いた ren も並べ直されますが、.lim では元の位置のままです"],
      ["lossy-param", "[chara_config] の anim=false は変換していません"],
    ]);
  });

  it("[chara_config] の話者の強調・動き・並べ直しは @chara-config、吹き出しのタグは @balloon にする", () => {
    expect(text('[chara_config talk_focus="brightness" brightness_value="50" talk_anim="up" pos_change_time="400" effect="easeOutQuad"]')).toBe(
      "@chara-config focus=dim dim=0.5 jump=true move-time=400ms easing=ease-out\n",
    );
    expect(text("[tb_fuki_start]\n[fuki_stop]")).toBe("@balloon on\n@balloon off\n");
  });

  it("キャストの既定の立ち絵セットが default 以外なら、[chara_*] の @chara は appearance=default を書く", () => {
    const cast = { yuika: { defaultAppearance: "casual", appearances: { casual: { variants: {} }, default: { variants: { default: { image: "y/normal.png" } } } } } };
    expect(text('[chara_show name="yuika" time="0"]', { cast })).toBe("@chara yuika default appearance=default at=auto wait=true if-hidden=true\n");
  });

  it("作品側の変換表に同じタグがあればそちらを使う（`#名前:表情` の表情も）", () => {
    const profile = {
      chara_mod: (pm: Record<string, string>) => ({ name: "chara", positional: [pm.name ?? "", pm.face ?? ""], named: [] }),
      chara_show: (pm: Record<string, string>) => ({ name: "chara", positional: [pm.name ?? "", "normal"], named: [["at", "left", null]] as [string, string, string | null][] }),
    };
    expect(text('[chara_show name="yuika"]\n#ユイ:smile', { profile })).toBe("@chara yuika normal at=left\n@chara yuika smile\n");
  });
});

describe("立ち絵プラグイン tatie", () => {
  const settings = {
    schemaVersion: 2,
    characters: {
      yuika: {
        defaultAppearance: "uniform",
        appearances: {
          uniform: { label: "制服", variants: { normal: { storage: "y/u_normal.png", frame: { width: 500, height: 800, positions: { left: { left: 10, top: 20 } } } } } },
          casual: { variants: { smile: { storage: "y/c_smile.png", cacheKey: 3 } } },
        },
      },
      // 旧形式（立ち絵セットなし）
      ren: { variants: { normal: { storage: "r/normal.png", frame: { positions: { center: { left: "300", top: "40" }, stage: { left: 5, top: 6 } } } } } },
    },
  };
  const cast = castFromTatieSettings(settings);
  const charas = collectCharas([{ file: "d.ks", source: '[chara_new name="yuika" storage="y/normal.png"]\n[chara_new name="ren" storage="r/normal.png"]' }]).defs;
  const run = (ks: string) => convert(ks, "t.ks", { charas, cast });

  it("設定をキャストにする（旧形式も読み、枠は tatie の既定で埋める）", () => {
    expect(cast).toEqual({
      yuika: {
        defaultAppearance: "uniform",
        appearances: {
          uniform: {
            label: "制服",
            variants: {
              normal: {
                image: "y/u_normal.png",
                frame: { width: 500, height: 800, positions: { left: { left: 10, top: 20 }, center: { left: 0, top: 0 }, right: { left: 0, top: 0 } } },
              },
            },
          },
          casual: {
            variants: {
              smile: {
                image: "y/c_smile.png",
                cacheKey: "3",
                frame: { width: 632, height: 843, positions: { left: { left: 0, top: 0 }, center: { left: 0, top: 0 }, right: { left: 0, top: 0 } } },
              },
            },
          },
        },
      },
      ren: {
        appearances: {
          default: {
            label: "標準",
            variants: {
              normal: {
                image: "r/normal.png",
                frame: {
                  width: 632,
                  height: 843,
                  positions: { left: { left: 0, top: 0 }, center: { left: 300, top: 40 }, right: { left: 0, top: 0 }, stage: { left: 5, top: 6 } },
                },
              },
            },
          },
        },
      },
    });
  });

  it("[chara_new] 由来のキャストに重ねると、同じ立ち絵セットの同じ差分は tatie が勝つ", () => {
    const base = { yuika: { appearances: { default: { variants: { normal: { image: "a.png" }, smile: { image: "b.png" } } }, uniform: { variants: { normal: { image: "x.png" } } } } } };
    expect(mergeCast(base, cast).yuika).toEqual({
      defaultAppearance: "uniform",
      appearances: {
        default: { variants: { normal: { image: "a.png" }, smile: { image: "b.png" } } },
        uniform: { label: "制服", variants: { normal: cast.yuika!.appearances.uniform!.variants.normal } },
        casual: cast.yuika!.appearances.casual,
      },
    });
  });

  it("[tatie] は既定（time=500・wait=false・cross=true・position=center・reflect=false）を引き継いだ @chara。mode=show は if-hidden=true", () => {
    // ファイルの頭では出ているか分からないので、立ち絵セット・位置・反転も書く（tatie は書かなければ既定に戻す）
    expect(run('[tatie name="yuika" variant="normal"]').text).toBe("@chara yuika normal appearance=uniform at=center flip=false time=500ms\n");
    expect(
      run('[tatie name="yuika" appearance="casual" variant="smile" position="right" mode="show" time="300" wait="true" cross="false" reflect="true"]').text,
    ).toBe("@chara yuika smile appearance=casual at=right flip=true cross=false time=300ms wait=true if-hidden=true\n");
    expect(run('[tatie name="ren" variant="normal" position="stage" show_only="true" time="0"]').text).toBe("@chara ren normal at=stage if-hidden=true\n");
  });

  it("tatie が黙って既定に戻す立ち絵セット・立ち位置は、既定に直して知らせる。無い差分・キャラクターは手作業の対象", () => {
    const r = run('[tatie name="yuika" appearance="swim" variant="normal" position="far" time="0"]');
    expect(r.text).toBe("@chara yuika normal appearance=uniform at=center flip=false\n");
    expect(r.diagnostics.map((d) => d.code)).toEqual(["tatie-fallback", "tatie-fallback"]);
    const bad = run('[tatie name="yuika" variant="angry"]\n[tatie name="nobody" variant="normal"]');
    expect(bad.diagnostics.map((d) => d.code)).toEqual(["undefined-tatie", "undefined-tatie"]);
    expect(bad.stats.byTag.tatie).toEqual({ manual: 2 });
  });

  it("[tatie] のあとの [chara_mod] は、tatie で出した立ち絵セット・立ち位置のまま表情を変える", () => {
    expect(run('[tatie name="yuika" appearance="casual" variant="smile" position="left" time="0"]\n[chara_mod name="yuika" reflect="true" time="0"]').text).toBe(
      "@chara yuika smile appearance=casual at=left flip=false\n@chara yuika smile flip=true wait=true\n",
    );
    // 画像を替えると、TyranoScript では tatie の枠のまま画像だけが替わる
    expect(run('[tatie name="yuika" variant="normal" time="0"]\n[chara_mod name="yuika" face="default" time="0"]').diagnostics.map((d) => d.code)).toEqual(["chara-mod-on-tatie"]);
  });
});

describe("JS の式", () => {
  it("変数名・比較・文字列を直す", () => {
    expect(convertJsExpression("f.a === 'x' && tf.b != sf.c")).toBe('game.a == "x" && temp.b != system.c');
  });

  it("文字列の書き逃しを JS と同じに読む", () => {
    // \' ・ \\ はそのまま、\n ・ \xNN ・ \uNNNN ・ \u{…} ・ 八進数は JS と同じに読み替える。知らない書き逃しはその字
    expect(convertJsExpression("'a\\'b'")).toBe('"a\'b"');
    expect(convertJsExpression("'p\\\\q'")).toBe('"p\\\\q"');
    expect(convertJsExpression("'x\\ny'")).toBe('"x\\ny"');
    expect(convertJsExpression("'\\x41BC'")).toBe('"ABC"');
    expect(convertJsExpression("'\\u3042'")).toBe('"あ"');
    expect(convertJsExpression("'\\u{1F600}'")).toBe('"😀"');
    expect(convertJsExpression("'\\101'")).toBe('"A"');
    expect(convertJsExpression("'\\8'")).toBe('"8"');
    // 代入文の中の文字列も同じ読み方
    expect(convertJsAssignments("f.a = 'x\\ny'")).toEqual(['@set game.a = "x\\ny"']);
  });

  it(".lim に書けない字を含む文字列は変換しない（手作業に回す）", () => {
    // .lim の式は \" ・ \\ ・ \n の書き逃しだけ読める。タブ・改ページ・NUL などは書けず、
    // JSON.stringify の \t や \uXXXX をそのまま書くと .lim が \t → t と読み違えて別の内容に変わる
    for (const src of ["'x\\ty'", "'x\\ry'", "'\\b'", "'\\f'", "'\\v'", "'\\0'", "'\\x0c'"]) {
      expect(convertJsExpression(src)).toBeNull();
    }
    expect(convertJsAssignments("f.a = 'x\\ty'")).toBeNull();
  });

  it("変換できないものは null", () => {
    expect(convertJsExpression("$('.a').length > 0")).toBeNull();
    expect(convertJsExpression("mp.flag == '1'")).toBeNull();
    expect(convertJsExpression("Math.random() > 0.5")).toBeNull();
  });

  it("代入の並び", () => {
    expect(convertJsAssignments("f.a=1; tf.b += 2; f.c++")).toEqual(["@set game.a = 1", "@set temp.b += 2", "@set game.c += 1"]);
    expect(convertJsAssignments("if (f.a) { f.b = 1 }")).toBeNull();
  });
});

describe("本文の書き方になるタグ", () => {
  it("[emb] は {= 式}、[ruby] は次の一文字のルビ", () => {
    expect(lim('今日は[emb exp="f.day"]日目。[ruby text=かん]漢[ruby text=じ]字[p]')).toBe("今日は{= game.day}日目。{r 漢|かん}{r 字|じ}\n");
  });

  it("[font] は {b} {i} {c} {size} になり、行をまたいで続く。[resetfont]・[er]・[ct]・[cm] で戻る", () => {
    expect(lim("[font color=0xff0000 bold=true size=30]赤[p]まだ赤[resetfont]戻る[p]")).toBe("{b {c #ff0000 {size 30 赤}}}\n{b {c #ff0000 {size 30 まだ赤}}}戻る\n");
    expect(lim("[font italic=true]斜め[er]普通[p]")).toBe("{i 斜め}{@clear}普通\n");
  });

  it("台詞の装飾は開きの括弧の内側から（括弧の前に { があると台詞にならない）", () => {
    expect(lim("#ユイ\n[font color=0x3366cc]「青い声」[p]")).toBe("ユイ「{c #3366cc 青い声」}\n");
  });

  it("[mark] 〜 [endmark] は {mark 色 …}", () => {
    expect(lim("[mark color=0xffff66]ここ[endmark]だけ[p]")).toBe("{mark #ffff66 ここ}だけ\n");
  });

  it("[nowait] は同じ行で閉じれば {speed 0ms …}、行をまたげば @text-speed 0ms と元の速さ", () => {
    expect(lim("[nowait]一度に[endnowait]出る[p]")).toBe("{speed 0ms 一度に}出る\n");
    expect(lim("[delay speed=50]\n[nowait]\nA[p]\n[endnowait]\nB[p]")).toBe("@text-speed 50ms\n@text-speed 0ms\nA\n@text-speed 50ms\nB\n");
  });

  it("[lr] は {click}{br}、[hidemessage] は @peek", () => {
    expect(lim("一行目[lr]二行目[p]\n[hidemessage]")).toBe("一行目{click}{br}二行目\n@peek\n");
  });
});

describe("対応の無い条件のタグ", () => {
  it("[if] の無い [else]・[elsif]・[endif] と、[ignore] の無い [endignore] は、例外にせずコメントにして報告する", () => {
    const r = convert('[else]\nA[p]\n[elsif exp="f.a"]\n[endif]\n[endignore]\n[if exp="f.b"]\nB[p]\n[endif]', "t.ks", { speakers });
    expect(r.text).toBe(["// TODO ks: [else]", "A", "// TODO ks: [elsif]", "// TODO ks: [endif]", "// TODO ks: [endignore]", "@if game.b", "  B", "@end", ""].join("\n"));
    expect(r.diagnostics.map((d) => [d.code, d.line])).toEqual([
      ["orphan-branch", 1],
      ["orphan-branch", 3],
      ["orphan-endif", 4],
      ["orphan-branch", 5],
    ]);
    expect(r.stats.byTag.else).toEqual({ manual: 1 });
  });
});

describe("選択肢になるタグ", () => {
  it("[link] 〜 [endlink] と [s] は @choice。前の本文は {noclick} の一行になり、クリックを待たずに選択肢を出す", () => {
    // 問いかけの行末の [r] は {br} のまま残し（書き戻しで戻す）、選択肢のあいだの [r] は落とす
    const r = convert("どうする？[r]\n[link target=*a]行く[endlink][r]\n[link storage=next.ks target=*b]戻る[endlink]\n[s]\n*a\n*b", "t.ks", { speakers });
    expect(r.text).toBe("どうする？{br}{noclick}\n\n@choice\n  - 行く -> #a\n  - 戻る -> next#b\n@end\n\n# a\n\n# b\n");
    expect(r.diagnostics.map((d) => d.code)).toEqual([]);
  });

  it("[p] で終わらない本文のあとの [glink] と [s] も、{noclick} でクリックを待たない。[p] で終われば待つ", () => {
    expect(lim('どっちへ？\n[glink text="北" target="*a"]\n[s]\n*a')).toBe("どっちへ？{noclick}\n\n@choice\n  - 北 -> #a\n@end\n\n# a\n");
    expect(lim('どっちへ？[p]\n[glink text="北" target="*a"]\n[s]\n*a')).toBe("どっちへ？\n\n@choice\n  - 北 -> #a\n@end\n\n# a\n");
    expect(lim("止まる。\n[s]")).toBe("止まる。{noclick}\n@stop\n");
  });

  it("[button] は画像の選択肢、[clickable] は押せる範囲。座標は [locate] からも取る", () => {
    expect(lim("[locate x=10 y=20]\n[button graphic=ok.png enterimg=ok_on.png target=*a]\n[clickable width=30 height=40 x=1 y=2 target=*b]\n[s]")).toBe(
      "@choice\n  - -> #a image=ok.png hover=ok_on.png x=10 y=20\n  - -> #b x=1 y=2 width=30 height=40\n@end\n",
    );
  });

  it("システムのボタン（role）は理由付きの手作業", () => {
    const r = convert("[button graphic=save.png role=save]", "t.ks");
    expect(r.stats.byTag.button).toEqual({ manual: 1 });
    expect(r.diagnostics[0]?.message).toContain("システム画面");
  });

  it("常に出ているボタン（fix=true）は @hud-button、[clearfix] は @hud-button-off。cond= は置くときに一度だけ見る", () => {
    expect(lim("[button fix=true graphic=ui/memo.png enterimg=ui/memo_on.png x=1180 y=20 target=*memo name=memo]\n本文。[p]\n[clearfix name=memo]\n[clearfix]\n*memo")).toBe(
      "@hud-button memo image=ui/memo.png hover=ui/memo_on.png x=1180 y=20 call=#memo\n本文。\n@hud-button-off memo\n@hud-button-off\n\n# memo\n",
    );
    expect(lim("[button fix=true graphic=map.png storage=map.ks target=*top cond=f.has_map]")).toBe("@if game.has_map\n  @hud-button map image=map.png call=map#top\n@end\n");
    const src = lim("[button fix=true graphic=ui/memo.png target=*memo]\n*memo\n[return]");
    expect(check(parse(src, "t.lim", { speakers: [...speakers] }), { registry: createRegistry(CORE_COMMANDS, STD_SPECS), speakers: [...speakers] }).filter((d) => d.severity === "error")).toEqual([]);
  });

  it("[edit] と決定のボタン一つは @text-input と @jump。[commit] は要らない", () => {
    expect(lim('[edit name="f.name" maxchars=8 initial="ハル"]\n[glink text=決定 target=*ok]\n[s]\n*ok\n[commit]')).toBe(
      "@text-input game.name initial=ハル max=8\n@jump #ok\n\n# ok\n",
    );
  });

  it("[dialog]", () => {
    expect(lim('[dialog type=input text="名前は？" name="tf.answer" target_cancel=*back]\n*back')).toBe(
      "@dialog 名前は？ type=input cancel-target=#back variable=temp.answer\n\n# back\n",
    );
    expect(lim('[dialog text="保存しました"]')).toBe("@dialog 保存しました\n");
  });
});

describe("システム画面・音・状態のタグ", () => {
  it("システム画面への要求", () => {
    expect(lim("[skipstart][cancelskip][autostart][showload][hidemenubutton][stop_keyconfig][tb_keyconfig flag=1][screen_full][close][autosave][nolog][endnolog]")).toBe(
      "@skip start\n@skip stop\n@auto start\n@open-screen load\n@menu-button hide\n@shortcuts off\n@shortcuts on\n@fullscreen\n@quit\n@autosave\n@backlog off\n@backlog on\n",
    );
    expect(lim('[title name="第二章"][web url="https://example.com/a b"][pushlog text=メモ join=true]')).toBe(
      '@window-title 第二章\n@open-url "https://example.com/a b"\n@backlog-add メモ join=true\n',
    );
    expect(lim("[configdelay speed=20][autoconfig speed=1500 clickstop=false][bgmopt volume=70 tag_volume=40][seopt volume=60]")).toBe(
      "@config text-speed=20ms\n@config auto-wait=1500ms auto-click-stop=false\n@config bgm-volume=70\n@bgm-volume 40\n@config se-volume=60\n",
    );
  });

  it("JS の入っていない [html] は @html（name・left・top は名前・x・y）。中身の行はそのまま写す", () => {
    expect(lim('[html name=note left=40 top=60]\n<div class="note">\n  <b>メモ</b>\n</div>\n[endhtml]')).toBe('@html note x=40 y=60\n<div class="note">\n<b>メモ</b>\n</div>\n@end\n');
    expect(codes("[html]\n<p>a</p>\n[endhtml]")).toEqual([]);
  });

  it("JS・ほかのタグの入った [html] は手作業に回す", () => {
    for (const inner of ["<script>alert(1)</script>", '<div onclick="go()">a</div>', '<img src="javascript:x">', "<p>[emb exp=f.a]</p>"]) {
      expect(lim(`[html]\n${inner}\n[endhtml]`)).not.toContain("@html");
      expect(codes(`[html]\n${inner}\n[endhtml]`)).toContain("unsupported-tag");
    }
  });

  it("[position] は縦書きだけを @vertical にする", () => {
    expect(lim('[position layer=message0 vertical=true][position vertical="false" left=40]')).toBe("@vertical on\n@vertical off\n");
    expect(lim("[position left=40 top=500]")).toBe("\n");
  });

  it("音（音量は 0〜100、時間はミリ秒）", () => {
    expect(lim("[pausebgm][resumebgm][pausese buf=1][resumese][changevol volume=30 time=1000][changevol target=se buf=2 volume=80]")).toBe(
      "@pause-bgm\n@resume-bgm\n@pause-se channel=1\n@resume-se\n@bgm-volume 30 time=1s\n@se-volume 80 channel=2\n",
    );
    expect(lim("[fadeoutbgm time=50][fadeinse storage=a.ogg time=800 buf=1][xchgbgm storage=b.ogg time=1500][wbgm][wse]")).toBe(
      "@stop-bgm time=100ms\n@se a.ogg channel=1 time=800ms\n@bgm b.ogg time=1500ms\n@wait-bgm\n@wait-se\n",
    );
  });

  it("変数の消去と、一時的に別の場面へ行って戻る", () => {
    expect(lim("[clearvar][clearvar exp=f.flag][clearsysvar][clearstack][clearstack stack=anim]")).toBe(
      "@clear-vars all\n@set game.flag = null\n@clear-vars system\n@clear-stack\n",
    );
    expect(lim("[sleepgame storage=extra.ks target=*cg][awakegame variable_over=false][breakgame]")).toBe("@sleep-game extra#cg\n@awake-game keep-variables=false\n@break-game\n");
    expect(lim("[checkpoint name=a][rollback checkpoint=a bgm_over=true][clear_checkpoint]")).toBe("@checkpoint a\n@rollback a keep-bgm=true\n@clear-checkpoint\n");
  });

  it("[ignore] は条件を反転した @if", () => {
    expect(lim("[ignore exp=f.seen]初めて[p][endignore]")).toBe("@if !(game.seen)\n  初めて\n@end\n");
  });

  it("TyranoBuilder のマクロ", () => {
    expect(lim("[tb_replay id=end_a]")).toBe("@replay-unlock end_a\n@awake-game\n");
    // [ptext] / [freeimage] に展開して、それぞれの変換に任せる
    expect(convert("[tb_ptext_show text=見出し x=10 anim=false][tb_ptext_hide time=300]", "t.ks").text).toBe("@ptext layer=2 text=見出し x=10\n@freeimage layer=2 time=300\n");
  });

  it("このエンジンで扱わないタグは、理由付きの警告か手作業", () => {
    const r = convert("[position left=10][loadjs storage=a.js][wt]", "t.ks");
    expect(r.text).toBe("\n");
    expect(r.stats.byTag).toEqual({ position: { dropped: 1 }, loadjs: { manual: 1 }, wt: { dropped: 1 } });
    expect(r.diagnostics.map((d) => [d.severity, d.code])).toEqual([
      ["warning", "unsupported-tag"],
      ["error", "unsupported-tag"],
      ["warning", "unsupported-tag"],
    ]);
  });
});

describe("マクロと &式・%引数", () => {
  it("[macro] は @define。%引数|既定値・mp の参照・型は渡す先の命令から決まる", () => {
    const ks = '[macro name=beat]\n[wait time=%time|500]\n[if exp="mp.loud==\'yes\'"]\n[quake count=%count]\n[endif]\n[endmacro]\n[beat time=300 loud=yes]';
    expect(lim(ks)).toBe(
      '// [macro name=beat]（t.ks:1）\n@define beat(time: duration = 500ms, loud: string = "", count: number = 5)\n  @wait (time)\n  @if loud=="yes"\n    @quake count=(count)\n  @end\n@end\n\n@beat time=300ms loud=yes\n',
    );
  });

  it("* はマクロの引数をすべて渡す（引数は呼び出し側が渡している名前）", () => {
    expect(lim("[macro name=show_bg][bg * time=0][endmacro]\n[show_bg storage=a.jpg method=fadeIn]")).toBe(
      '// [macro name=show_bg]（t.ks:1）\n@define show-bg(storage: string = "", method: string = "")\n  @bg (storage) method=(method)\n@end\n\n@show-bg storage=a.jpg method=fadeIn\n',
    );
  });

  it("引数名の _ は - になり、中の式では _ で参照する", () => {
    expect(lim("[macro name=greet][emb exp=mp.first_name][p][endmacro]\n[greet first_name=ハル]")).toBe(
      '// [macro name=greet]（t.ks:1）\n@define greet(first-name: string = "")\n  {= first_name}\n@end\n\n@greet first-name=ハル\n',
    );
  });

  it("別のファイルのマクロを呼ぶと @use を書く", () => {
    const macros = new Map([["beat", { ks: "beat", name: "beat", library: "macros", params: new Map() }]]);
    expect(convert("[beat]", "t.ks", { macros }).text).toBe("@use macros\n\n@beat\n");
  });

  it("本文として取り込まないファイルへの [call] は書き出さない", () => {
    const r = convert('[call storage="system/common.ks"]', "t.ks", { skipCalls: new Set(["system/common.ks"]) });
    expect(r.text).toBe("\n");
    expect(r.diagnostics.map((d) => d.code)).toEqual(["skipped-call"]);
  });

  it("&式 はどのタグでも (式) になる。式にできない位置なら手作業", () => {
    expect(lim("[bg storage=&f.room time=0]")).toBe("@bg (game.room)\n");
    expect(codes("[jump storage=&f.next]")).toEqual(["manual-target", "manual-entity"]);
  });
});
