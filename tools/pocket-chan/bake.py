#!/usr/bin/env python3
"""Bake Pocket Chan's clips into PSP sprite atlases.

    python3 tools/pocket-chan/bake.py                  # write apps/pocket-chan/
    python3 tools/pocket-chan/bake.py --sheet          # + a contact sheet to review

Each clip becomes one 512x256 RGBA PNG holding eight 128x128 cells in a 4x2
grid — the pow2 atlas dimensions `framework/compiler/pak.ts` requires — plus a
`sprites.json` row naming the grid and the vblanks per frame. `tools/build.ts`
reads both and bakes `ui:sprite.<file>` entries into the pak.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PIL import Image

import rig
from geom import Cel
from poses import CLIPS

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "apps" / "pocket-chan"

CELL = 128
COLS = 4
ROWS = 2
SCALE = 0.86          # design units -> cell pixels
ORIGIN = (64.0, 86.0)  # where the hip lands inside a cell
MARGIN = 1            # cell pixels that must stay empty on every side
PSM_4444 = 2           # halves atlas texture memory on the PSP (pak.ts PSM)


def draw_frame(cel: Cel, look, phase: float, ox: float, oy: float) -> None:
    for pts, color, alpha in rig.build(look, phase):
        cel.poly([(ox + x * SCALE, oy + y * SCALE) for x, y in pts], color, alpha)


def bake_clip(clip) -> Image.Image:
    """One atlas. Each frame is rendered into its OWN cell-sized surface and
    pasted, so a pose that reaches past the cell can never bleed into the
    neighbouring frame — which is exactly what a shared canvas would let it
    do, and what the margin check below refuses to ship."""
    atlas = Image.new("RGBA", (CELL * COLS, CELL * ROWS), (0, 0, 0, 0))
    for i in range(clip.frames):
        cel = Cel(CELL, CELL, rig.INK, ss=4)
        draw_frame(cel, clip.build(i, clip.frames), i / clip.frames, ORIGIN[0], ORIGIN[1])
        img = cel.image()
        box = img.getchannel("A").getbbox()
        if box is None:
            raise SystemExit(f"{clip.key} frame {i}: drew nothing")
        if box[0] < MARGIN or box[1] < MARGIN or box[2] > CELL - MARGIN or box[3] > CELL - MARGIN:
            raise SystemExit(
                f"{clip.key} frame {i}: ink at {box} reaches the {CELL}px cell edge — "
                f"lower SCALE or move ORIGIN in tools/pocket-chan/bake.py"
            )
        atlas.paste(img, ((i % COLS) * CELL, (i // COLS) * CELL))
    return atlas


def contact_sheet(images: dict[str, Image.Image], path: Path) -> None:
    pad = 8
    w = CELL * COLS + pad * 2
    h = CELL * ROWS + pad * 2
    sheet = Image.new("RGBA", (w, h * len(images)), (28, 22, 44, 255))
    for i, img in enumerate(images.values()):
        sheet.alpha_composite(img, (pad, i * h + pad))
    sheet = sheet.resize((sheet.width * 2, sheet.height * 2), Image.NEAREST)
    sheet.save(path)
    print(f"sheet: {path} ({sheet.width}x{sheet.height})")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sheet", action="store_true", help="also write a review contact sheet")
    ap.add_argument("--out", default=str(OUT))
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    manifest: dict[str, dict] = {}
    images: dict[str, Image.Image] = {}
    total = 0
    for clip in CLIPS:
        img = bake_clip(clip)
        name = f"chan-{clip.key}.png"
        img.save(out / name, optimize=True)
        size = (out / name).stat().st_size
        total += size
        images[name] = img
        manifest[name] = {
            "cols": COLS,
            "rows": ROWS,
            "frames": clip.frames,
            "step": clip.step,
            "psm": PSM_4444,
        }
        print(f"{name}: {img.width}x{img.height}, {clip.frames} frames, step {clip.step}, {size} bytes")
    (out / "sprites.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"sprites.json: {len(manifest)} atlases, {total} bytes of PNG")

    if args.sheet:
        review = ROOT / ".pocket-build" / "pocket-chan"
        review.mkdir(parents=True, exist_ok=True)
        contact_sheet(images, review / "sheet.png")


if __name__ == "__main__":
    main()
