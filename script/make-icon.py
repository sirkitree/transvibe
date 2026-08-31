#!/usr/bin/env python3
"""Draw the app icon: the visualizer's green bars on the strip's dark scrim.

There is no designer's .icns in the repo, and macOS gives an app without one
the blank generic document — useless for picking transvibe out of a Dock or a
Spotlight list. This draws the one thing the app actually looks like: a row of
bars in the accent green (hue 150), on the same near-black the strip uses.

Writes build/icon.iconset/*.png; iconutil turns that into build/icon.icns.
"""
import colorsys
import math
import os
from PIL import Image, ImageDraw

ACCENT_HUE = 150 / 360          # --accent, the visualizer green
SCRIM = (9, 24, 17, 255)        # --scrim, opaque: an icon has no window behind it
# Bars are relative heights, symmetric around the middle — a waveform at rest.
BARS = [0.30, 0.52, 0.74, 1.00, 0.86, 0.62, 0.86, 1.00, 0.74, 0.52, 0.30]
OUT = os.path.join(os.path.dirname(__file__), '..', 'build', 'icon.iconset')


def bar_color(t):
    """Brighter and slightly cooler toward the centre, like the lit ribbon."""
    light = 0.42 + 0.26 * t
    r, g, b = colorsys.hls_to_rgb(ACCENT_HUE, light, 0.72)
    return (int(r * 255), int(g * 255), int(b * 255), 255)


def draw(size):
    # Drawn at 4x and downsampled: PIL has no antialiased shapes of its own.
    s = size * 4
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # macOS "squircle" proportions, near enough at icon sizes.
    pad = s * 0.055
    d.rounded_rectangle([pad, pad, s - pad, s - pad], radius=s * 0.222, fill=SCRIM)

    n = len(BARS)
    span = s * 0.62
    left = (s - span) / 2
    gap = span / n
    width = gap * 0.46
    mid = s / 2
    for i, h in enumerate(BARS):
        x = left + gap * i + (gap - width) / 2
        half = (s * 0.30) * h / 2
        t = 1 - abs(i - (n - 1) / 2) / ((n - 1) / 2)
        d.rounded_rectangle([x, mid - half, x + width, mid + half],
                            radius=width / 2, fill=bar_color(t))
    return img.resize((size, size), Image.LANCZOS)


os.makedirs(OUT, exist_ok=True)
for size in (16, 32, 128, 256, 512):
    draw(size).save(os.path.join(OUT, f'icon_{size}x{size}.png'))
    draw(size * 2).save(os.path.join(OUT, f'icon_{size}x{size}@2x.png'))
print('wrote', os.path.normpath(OUT))
