"""Render the delivered PDF and check pages, text, bounds and provenance."""
import hashlib
import json
import subprocess
from pathlib import Path

import pymupdf as fitz
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
PDF = ROOT / 'submission/伴途作品介绍.pdf'
OUT = ROOT / 'tmp/submission-pdf-evidence'
OUT.mkdir(parents=True, exist_ok=True)
EXPORT = json.loads((OUT / 'export.json').read_text(encoding='utf-8'))
assert hashlib.sha256((ROOT / 'docs/作品介绍.html').read_bytes()).hexdigest() == EXPORT['sourceSha256'], 'PDF HTML source changed after export'
assert hashlib.sha256(PDF.read_bytes()).hexdigest() == EXPORT['pdfSha256'], 'PDF changed after export'
doc = fitz.open(PDF)
assert len(doc) == 8, f'Expected eight pages, found {len(doc)}'
pages = []
for number, page in enumerate(doc, 1):
    text = page.get_text()
    assert len(text.strip()) >= 100, f'Empty or image-only page {number}'
    assert '\ufffd' not in text, f'Corrupted text on page {number}'
    assert page.rect.width > page.rect.height, f'Expected landscape page {number}'
    outside = [block[:4] for block in page.get_text('blocks') if block[0] < -.5 or block[1] < -.5 or block[2] > page.rect.width + .5 or block[3] > page.rect.height + .5]
    assert not outside, f'Text exceeds page {number}: {outside}'
    links = page.get_links()
    local_links = [link for link in links if link.get('file') or str(link.get('uri', '')).lower().startswith('file:')]
    assert not local_links, f'Developer-machine link left in portable PDF page {number}'
    pages.append({'page':number, 'width':page.rect.width, 'height':page.rect.height, 'textLength':len(text), 'outsideText':outside, 'linkCount':len(links), 'developerFileLinks':local_links})
    (OUT / f'page-{number:02}.txt').write_text(text, encoding='utf-8')

subprocess.run(['pdftoppm', '-scale-to', '1600', '-png', str(PDF), str(OUT / 'page')], check=True)
images = sorted(OUT.glob('page-*.png'))
assert len(images) == 8, 'Expected one rendered image per PDF page'
font = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 22)
sheet = Image.new('RGB', (1600, 1000), '#eef3f9')
draw = ImageDraw.Draw(sheet)
for index, path in enumerate(images):
    image = Image.open(path).convert('RGB')
    image.thumbnail((390, 420), Image.Resampling.LANCZOS)
    x, y = (index % 4) * 400, (index // 4) * 500
    sheet.paste(image, (x + (400-image.width)//2, y + 48))
    draw.text((x+16, y+12), f'{index+1:02} / 08', font=font, fill='#20344e')
sheet.save(OUT / 'contact.png')
proof = {'passed':True, 'scope':'Delivered PDF page/text/provenance checks; rendered pages require visual inspection', 'pages':pages, 'renderedImages':[str(path) for path in images], 'pdf':str(PDF), 'bytes':PDF.stat().st_size, 'sha256':EXPORT['pdfSha256']}
(OUT / 'proof.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'passed':True, 'pages':len(doc), 'bytes':proof['bytes'], 'output':str(OUT)}, ensure_ascii=False))
