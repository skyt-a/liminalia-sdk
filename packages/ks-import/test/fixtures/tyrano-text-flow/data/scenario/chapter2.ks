*top
[checkpoint name="before"]
#ユイ
「ここからが本番」[p]
[if exp="f.retry != 1"]
[eval exp="f.retry = 1"]
[rollback checkpoint="before"]
[endif]

*south
#
[fadeoutbgm time=500]
[skipstop]
[autostop]
[showmenubutton]
[nolog]
記録しない文。[p]
[endnolog]
[pushlog text="（ここまで読んだ）"]
[html top=100 left=100]
<div class="note">メモ</div>
[endhtml]
[clearvar exp="f.skip_tutorial"]
終わり。[p]
