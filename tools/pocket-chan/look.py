#!/usr/bin/env python3
"""Render Looks large, for eyeballing a change to the rig.

    python3 tools/pocket-chan/look.py               # frame 0 of every clip
    python3 tools/pocket-chan/look.py smile 3       # one clip, one frame

Framing comes from `bake.py`, so what this shows is what the atlas gets.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PIL import Image

import rig
from bake import CELL, ORIGIN, SCALE
from geom import Cel
from poses import CLIPS

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../.pocket-build/pocket-chan")


def render(look, phase: float = 0.0, zoom: int = 4) -> Image.Image:
    cel = Cel(CELL, CELL, rig.INK, ss=4)
    for pts, color, alpha in rig.build(look, phase):
        cel.poly([(ORIGIN[0] + x * SCALE, ORIGIN[1] + y * SCALE) for x, y in pts], color, alpha)
    return cel.image().resize((CELL * zoom, CELL * zoom), Image.NEAREST)


def sheet(tiles: list[Image.Image], path: str, cols: int = 5) -> None:
    rows = (len(tiles) + cols - 1) // cols
    w, h = tiles[0].size
    out = Image.new("RGBA", (w * cols, h * rows), (28, 22, 44, 255))
    for i, tile in enumerate(tiles):
        out.alpha_composite(tile, ((i % cols) * w, (i // cols) * h))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    out.save(path)
    print(f"{path} ({out.width}x{out.height})")


def main() -> None:
    key = sys.argv[1] if len(sys.argv) > 1 else ""
    frame = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    if key:
        clip = next((c for c in CLIPS if c.key == key), None)
        if clip is None:
            raise SystemExit(f"no clip named {key} (have: {', '.join(c.key for c in CLIPS)})")
        sheet([render(clip.build(frame, clip.frames), frame / clip.frames, zoom=5)],
              os.path.join(OUT, "look.png"), cols=1)
        return
    tiles = [render(c.build(0, c.frames), 0.0, zoom=3) for c in CLIPS]
    sheet(tiles, os.path.join(OUT, "look.png"))


if __name__ == "__main__":
    main()
