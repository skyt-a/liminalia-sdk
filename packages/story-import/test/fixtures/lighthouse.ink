// 灯台の小さな話（取り込みのテスト用に書いたもの）
VAR oil = 1
VAR met = false
CONST FULL = 3
INCLUDE parts/keeper.ink

# bg: shore_evening.png
潮のにおいのする坂を、灯台に向かってのぼっていく。<>
足もとで砂が鳴った。
-> lighthouse

=== lighthouse ===
# bgm: waves.ogg
灯台守: {met: また来たね。|はじめまして。} #voice: keeper/001.ogg
~ met = true
油は残り{oil}缶。
{ oil:
- 0: 油はもう無い。
- 1: 油は一缶だけ。
- else: 油は足りている。
}
* [油を足す]
  ~ oil += 1
  灯台守: 助かるよ。
  -> lamp
* {oil > 1} [話を聞く]
  -> talk
+ [帰る]
  -> END

= lamp
{oil >= FULL: 灯りが明るくなった。|灯りは、まだ少し弱い。}
{&波が寄せる。|波が返る。}
-> lighthouse

=== talk ===
-> greeting ->
灯台守: 昔の話をしようか。
* 「聞かせてください」[]と頼んだ。
  灯台守: ありがとう。
  ** [うなずく]
     黙ってうなずいた。
  ** [笑う]
     少し笑った。
  -- (heard) 話は長かった。
* (later) [「また今度」]
  灯台守: そうか。
- 灯台守: それじゃあ、またね。
{ lighthouse > 1:
  何度も来てくれたね。
- else:
  はじめての夜だね。
}
{stopping:
  - 帰り道は暗い。
  - 帰り道は、もう慣れた。
}
# shake
-> END
