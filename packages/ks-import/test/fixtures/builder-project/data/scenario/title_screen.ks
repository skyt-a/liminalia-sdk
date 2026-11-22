[_tb_system_call storage=system/_title_screen.ks]
[hidemenubutton]
[tb_keyconfig flag=0]
*title
[glink text="はじめから" target="*start"]
[glink text="つづきから" target="*load"]
[s]
*start
[cm]
[jump storage="room.ks" target=""]
[s]
*load
[showload]
[jump target="*title"]
