"""Build the locally served display face from the retained OFL source.

Source: notofonts/noto-cjk, Serif/OTF/SimplifiedChinese/NotoSerifCJKsc-Medium.otf.
Only collection headlines use it; controls retain the existing UI face.
Run with fontTools + brotli on PYTHONPATH. No runtime font network dependency.
"""
from pathlib import Path
import json
from fontTools.ttLib import TTFont
from fontTools import subset

root = Path(__file__).resolve().parents[1]
source = root / "tmp/noto-serif-sc-medium.otf"
font = TTFont(source)
critical = set(range(0x20, 0x7F))
for name in ('public/views/achievements.js', 'public/lib/place-impressions.js', 'public/lib/achievement-rules.js'):
    critical.update(map(ord, (root / name).read_text(encoding='utf-8')))
critical &= set(font.getBestCmap())
characters = set(range(0x20, 0x7F))
# GB2312 covers ordinary simplified Chinese names and headings; retain all text
# used by the local catalogue as well, including less common place-name glyphs.
for zone in range(0xA1, 0xF8):
    for position in range(0xA1, 0xFF):
        try:
            characters.update(map(ord, bytes([zone, position]).decode("gb2312")))
        except UnicodeDecodeError:
            pass
for directory in ("public/views", "public/lib", "src/demo"):
    for path in (root / directory).rglob("*"):
        if path.suffix in (".js", ".ts"):
            characters.update(map(ord, path.read_text(encoding="utf-8")))
characters &= set(font.getBestCmap())
options = subset.Options()
options.layout_features = ["kern", "palt"]
options.name_IDs = ["*"]
options.name_legacy = True
options.name_languages = ["*"]
subsetter = subset.Subsetter(options=options)
subsetter.populate(unicodes=characters)
subsetter.subset(font)
# The subset is a derivative, with its own family identity and original
# copyright + license records preserved.
for name_id, value in [(1, "Bantu Collection Serif"), (2, "Medium"),
                       (3, "BantuCollectionSerif-Medium-1"),
                       (4, "Bantu Collection Serif Medium"),
                       (6, "BantuCollectionSerif-Medium"),
                       (16, "Bantu Collection Serif"), (17, "Medium")]:
    for record in font["name"].names:
        if record.nameID == name_id:
            record.string = value.encode(record.getEncoding())
font.flavor = "woff2"
destination = root / "public/fonts/bantu-collection-serif.woff2"
font.save(destination)
small = TTFont(destination)
critical_subsetter = subset.Subsetter(options=options)
critical_subsetter.populate(unicodes=critical)
critical_subsetter.subset(small)
small.flavor = 'woff2'
primary = destination.with_name('bantu-collection-serif-title.woff2')
small.save(primary)
primary_face = ('@font-face{font-family:"Bantu Collection Serif";src:url(\'/fonts/bantu-collection-serif-title.woff2\') format(\'woff2\');font-style:normal;font-weight:500;font-display:swap;unicode-range:'
                + ','.join(f'U+{value:X}' for value in sorted(critical)) + '}')
fallback_face = '@font-face{font-family:"Bantu Collection Serif";src:url(\'/fonts/bantu-collection-serif.woff2\') format(\'woff2\');font-style:normal;font-weight:500;font-display:swap}'
css = root / 'public/product-design.css'
stylesheet = css.read_text(encoding='utf-8')
start = stylesheet.index('@font-face{font-family:"Bantu Collection Serif";')
end = stylesheet.index('.achievement-hero h2,', start)
css.write_text(stylesheet[:start] + fallback_face + '\n' + primary_face + '\n' + stylesheet[end:], encoding='utf-8')
print(json.dumps({"file": str(destination), "bytes": destination.stat().st_size,
                  "glyphs": len(font.getBestCmap()), "weight": 500,
                  "primaryBytes": primary.stat().st_size, "primaryGlyphs": len(small.getBestCmap()),
                  "license": "public/fonts/OFL-NotoSerifSC.txt"}))
