[_tb_system_call storage=system/_scene1.ks]

[cm  ]
[bg  time="1000"  method="crossfade"  storage="room.jpg"  ]
[tb_show_message_window  ]
[tb_start_text mode=1 ]
#
朝の光が差し込んでいた。[p]
# ユイ
「おはよう。今日は｜早《はや》いのね」[p]
「[srb text="けさ"]今朝[erb]は雨だったから」[p]
#
窓の外では、雨が上がりかけていた。[p]
[_tb_end_text]

[chara_show  name="yui"  face="smile"  time="500"  ]
[tb_start_text mode=1 ]
# レン
「大事な話がある」[p]
「あとで話す」[p]
[_tb_end_text]

[tb_eval  exp="f.met=1"  name="met"  cmd="="  op="t"  val="1"  val_2="undefined"  ]
[glink  color="black"  storage="scene1.ks"  target="*north"  text="北へ行く"  width="700"  ]
[glink  color="black"  storage="scene1.ks"  target="*south"  text="南へ行く"  width="700"  ]
[glink  color="black"  storage="scene1.ks"  target="*north"  text="もう一度"  width="700"  cond="f.met==1"  ]
[s  ]
*north

[tb_start_text mode=1 ]
#
北の道を進んだ。[p]
[_tb_end_text]

[jump  storage="scene2.ks"  target=""  ]
*south

[if exp="f.met==1"]
[tb_start_text mode=1 ]
#
南の道は静かだった。[p]
[_tb_end_text]

[endif]
[playbgm  volume="100"  time="1000"  loop="true"  storage="theme.ogg"  ]
[jump  storage="scene2.ks"  target=""  ]
