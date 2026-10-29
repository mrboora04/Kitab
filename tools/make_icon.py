#!/usr/bin/env python3
"""Draws the launcher icon (an open book on a warm background). usage: make_icon.py out.png"""
import sys
from PIL import Image, ImageDraw

S = 4  # supersample, then downscale for smooth edges
N = 192 * S
img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([0, 0, N - 1, N - 1], radius=44 * S, fill=(196, 92, 52))

cx, top, bottom = N // 2, 52 * S, 142 * S
paper, line = (255, 248, 236), (196, 92, 52, 150)
# two pages, slightly lifted at the outer edges
d.polygon([(cx - 4 * S, top + 6 * S), (34 * S, top - 4 * S), (34 * S, bottom - 8 * S), (cx - 4 * S, bottom)], fill=paper)
d.polygon([(cx + 4 * S, top + 6 * S), (N - 34 * S, top - 4 * S), (N - 34 * S, bottom - 8 * S), (cx + 4 * S, bottom)], fill=paper)
for i in range(5):
    y = top + (16 + i * 13) * S
    d.line([(46 * S, y - 3 * S), (cx - 14 * S, y + 3 * S)], fill=line, width=4 * S)
    d.line([(cx + 14 * S, y + 3 * S), (N - 46 * S, y - 3 * S)], fill=line, width=4 * S)

img.resize((192, 192), Image.LANCZOS).save(sys.argv[1])
