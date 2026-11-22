;共通のマクロ

;間を置く
[macro name="pause_beat"]
[wait time=%time|400]
[endmacro]

;背景を替える（引数はそのまま [bg] へ）
[macro name="scene_bg"]
[bg * time=600]
[endmacro]

;機嫌で台詞を変える
[macro name="mood_line"]
[if exp="mp.mood == 'happy'"]
#ユイ
「[emb exp="mp.name"]、おはよう」[p]
[else]
#ユイ
「……[emb exp="mp.name"]」[p]
[endif]
[endmacro]

;地の文を一行出す
[macro name="narrate"]
#
[emb exp="mp.text"][p]
[endmacro]
