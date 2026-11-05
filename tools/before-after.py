#!/usr/bin/env python3
"""Compose a labelled before/after image from a bench run (needs Pillow).

    python3 tools/before-after.py bench-out/<run> docs/media/before-after.png \
        --region 120,170,240,150 --zoom 3 --caption "..."

Left: one photo upscaled 2× with Lanczos. Right: the merged burst (mean).
Both are 2× outputs of the same scene; the region is in crop pixels.

Real bursts have no ground truth, so pass the two crops directly instead:
    python3 tools/before-after.py --before b.png --after a.png out.png --caption "..."
"""
import argparse, json, os
from PIL import Image, ImageDraw, ImageFont

ap = argparse.ArgumentParser()
ap.add_argument('run', nargs='?')
ap.add_argument('out')
ap.add_argument('--region', default='120,170,240,150')
ap.add_argument('--zoom', type=int, default=3)
ap.add_argument('--caption', default='')
ap.add_argument('--before')
ap.add_argument('--after')
ap.add_argument('--frames', type=int, default=4)
a = ap.parse_args()

x, y, w, h = map(int, a.region.split(','))
if a.before:   # real burst: no results.json, no ground truth
    res, gain, frames = None, None, a.frames
    src = {'single-lanczos': a.before, 'mean': a.after}
else:
    res = json.load(open(os.path.join(a.run, 'results.json')))
    by = {r['method']: r for r in res['results']}
    gain, frames = by['mean']['psnr'] - by['single-lanczos']['psnr'], res['frames']
    src = {n: os.path.join(a.run, f'crop_{n}.png') for n in ('single-lanczos', 'mean')}

def tile(name):
    im = Image.open(src[name]).convert('RGB').crop((x, y, x + w, y + h))
    return im.resize((w * a.zoom, h * a.zoom), Image.NEAREST)

left, right = tile('single-lanczos'), tile('mean')
font_path = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
bold = ImageFont.truetype(font_path.replace('.ttf', '-Bold.ttf'), 22)
small = ImageFont.truetype(font_path, 17)
pad, gap, head, foot = 20, 12, 44, 64
W = left.width * 2 + gap + 2 * pad
H = left.height + head + foot + pad
img = Image.new('RGB', (W, H), (22, 24, 29))
d = ImageDraw.Draw(img)
img.paste(left, (pad, head))
img.paste(right, (pad + left.width + gap, head))
d.text((pad, 12), 'One photo, upscaled 2× (Lanczos)', font=bold, fill=(215, 218, 224))
d.text((pad + left.width + gap, 12), f'{frames} photos merged (mean), same 2× size', font=bold, fill=(232, 162, 58))
cap = a.caption or (f'Simulated {res["frames"]}-shot burst made from a real {res["groundTruth"]} '
                    f'(sub-pixel shifts, noise, JPEG). Shown at {a.zoom * 100}% zoom. '
                    f'Measured gain over one photo: {gain:+.2f} dB PSNR (whole image).')
d.text((pad, head + left.height + 12), cap, font=small, fill=(170, 176, 187))
d.text((pad, head + left.height + 36), 'Burst Super-Res · free tool from the Sony A6000/A6400 Hacking Guide · docodethatmatters.com',
       font=small, fill=(125, 132, 146))
os.makedirs(os.path.dirname(a.out) or '.', exist_ok=True)
img.save(a.out, optimize=True)
print('wrote', a.out, img.size)
