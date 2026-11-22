# 素材と訳のある Ren'Py の作品（取り込みの例）
define e = Character(_("エイル"))

label start:
    scene bg room with fade
    play music main_theme fadein 1.0
    "部屋は静かだった。"
    show eileen happy
    e "おはよう。"
    play sound "audio/bell.ogg"
    menu:
        e "どうする？"
        "出かける":
            e "行こう。"
        "家にいる":
            "家で過ごした。"
    return
