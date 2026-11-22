*start
[scene_bg storage="room.jpg"]
[playbgm storage="theme.ogg"]
#ユイ
「おはよう。今日は[ruby text=はや]早いのね」[p]
#
窓の外では、[font color=0x3366cc]雨[resetfont]が上がりかけていた。[p]
[mood_line name="レン" mood="happy"]
[pause_beat time=300]
[narrate text="時計の針が進む。"]
[flash]
#レン
「[font size=32 bold=true]大事な[resetfont]話がある」[lr]
「[mark color=0xffff66]今日[endmark]のうちに」[p]
#
[nowait]一気に出る文。[endnowait]ゆっくり出る文。[p]
名前を入れてください。[p]
[edit name="f.name" maxchars=8 initial="ハル"]
[glink text="決定" target="*named"]
[s]

*named
[commit]
[cm]
[emb exp="f.name"]、と呼ぶことにした。[p]
どちらへ行く？[r]
[link target="*north"]北の道[endlink][r]
[link storage="chapter2.ks" target="*south"]南の道[endlink]
[s]

*north
[locate x=100 y=200]
[button graphic="button/rest.png" enterimg="button/rest_on.png" target="*rest"]
[clickable x=600 y=300 width=200 height=120 target="*door"]
[s]

*rest
[sleepgame storage="extra.ks" target="*gallery"]
休んだあとで、扉を開けた。[p]

*door
[pausebgm]
[changevol target=bgm volume=50 time=500]
[resumebgm]
[dialog type=confirm text="先へ進みますか？" target="*go" target_cancel="*go"]

*go
[ignore exp="f.skip_tutorial"]
説明はここまで。[p]
[endignore]
[jump storage="chapter2.ks"]
