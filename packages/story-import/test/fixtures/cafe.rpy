# 喫茶店の短い話（Ren'Py の取り込みの例）
define e = Character("エイル", color="#c8ffc8")
define m = Character(_("店主"))
define narrator_name = "ぼく"
default coffee = 0
default met = False
default persistent.cleared = False
image bg cafe = "backgrounds/cafe.jpg"

init python:
    def helper():
        return 1

label start:
    scene bg cafe with fade
    play music "audio/morning.ogg" fadein 1.0
    "扉を開けると、ベルが鳴った。"
    show eileen happy at left with dissolve
    e "いらっしゃい、[narrator_name]さん。"
    e "今日は{b}特別な{/b}豆があるの。{w}飲んでいく？"
    call order
    if coffee >= 2:
        e "たくさん飲んだね。"
    elif coffee == 1:
        e "おいしかった？"
    else:
        "結局、何も飲まなかった。"
    $ count = 0
    while count < 2:
        $ count += 1
        "時計が鳴った。"
    jump .leave

label .leave:
    hide eileen with dissolve
    stop music fadeout 2.0
    $ persistent.cleared = True
    "店を出た。"
    return

label order:
    menu:
        e "何にする？"
        "コーヒー":
            $ coffee += 1
            m "どうぞ。"
            jump order
        "もう一杯" if coffee >= 1:
            $ coffee += 1
            m "おかわりです。"
        "やめておく":
            pass
    return
