# ブラウザで動かすテストの書体（test-font.ttf）を作る。pip install fonttools のうえで
#   python3 packages/web/test/e2e/fixtures/make-test-font.py
# 和文（ひらがな・カタカナ・句読点・漢字・全角）をすべて同じ四角の字形にし、横も縦も一字の送りを 1em ちょうどにする。
# 文字の範囲（上下の余白）も 1em に収める。OS の書体で測る値が変わらないように、テストの作品はこの書体で組む。
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

EM = 1000
RANGES = [(0x3000, 0x30FF), (0x4E00, 0x9FFF), (0xFF01, 0xFF60)]


def box():
    pen = TTGlyphPen(None)
    pen.moveTo((100, -40))
    pen.lineTo((100, 760))
    pen.lineTo((900, 760))
    pen.lineTo((900, -40))
    pen.closePath()
    return pen.glyph()


def empty():
    return TTGlyphPen(None).glyph()


fb = FontBuilder(EM, isTTF=True)
fb.setupGlyphOrder([".notdef", "space", "box"])
cmap = {0x20: "space", 0x3000: "space"}
for start, end in RANGES:
    for cp in range(start, end + 1):
        cmap.setdefault(cp, "box")
fb.setupCharacterMap(cmap)
fb.setupGlyf({".notdef": empty(), "space": empty(), "box": box()})
fb.setupHorizontalMetrics({".notdef": (EM, 0), "space": (EM, 0), "box": (EM, 100)})
fb.setupHorizontalHeader(ascent=880, descent=-120)
fb.setupVerticalMetrics({".notdef": (EM, 0), "space": (EM, 0), "box": (EM, 120)})
fb.setupVerticalHeader(ascent=EM // 2, descent=-EM // 2)
fb.setupNameTable({"familyName": "Liminalia Test", "styleName": "Regular"})
fb.setupOS2(version=4, sTypoAscender=880, sTypoDescender=-120, sTypoLineGap=0, usWinAscent=880, usWinDescent=120, fsSelection=0x80)
fb.setupPost()
fb.save(str(Path(__file__).with_name("test-font.ttf")))
