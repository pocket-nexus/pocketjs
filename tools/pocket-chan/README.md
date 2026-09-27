# Pocket Chan's art pipeline

Pocket Chan is drawn by code, not by hand. This directory holds the rig that
draws her and the baker that lays her out into the sprite atlases
`apps/pocket-chan/` ships.

```sh
python3 tools/pocket-chan/bake.py --sheet   # atlases + sprites.json, and a contact sheet to review
python3 tools/pocket-chan/look.py           # a few Looks rendered large, for eyeballing a change
bun tools/pocket-chan/shots.ts              # capture the running app from the PSP host through PPSSPP
```

`bake.py` writes into `apps/pocket-chan/`; the review renders go to
`.pocket-build/pocket-chan/`. Pillow is the only dependency.

## The rig

| File | What it holds |
| --- | --- |
| `geom.py` | polygons, splines, tapered bands, outward offset, and the supersampled cel |
| `rig.py` | the palette, the skeleton, and every part that gets drawn |
| `poses.py` | the nine clips: `frames(i, n)` returns the `Look` for frame i |
| `bake.py` | lays frames into 512x256 atlases and writes `sprites.json` |

**One `Look` is one drawn frame** — lean, head tilt, what each arm reaches for,
which eyes and mouth are on, and which props ride along. `rig.build()` turns it
into an ordered list of filled polygons in a hip-origin design space where the
hip is (0, 0) and one unit is one pixel of the 128px cell.

Two details carry most of the look:

- **Line art comes from an outward offset.** The rasteriser only fills
  polygons, so every inked part paints `outset(poly, w)` in the ink colour and
  then its own fill on top.
- **The cel supersamples into two buffers** — a colour buffer whose ground is
  the ink colour, and a coverage buffer — and box-filters both on export.
  Grounding the colour buffer in ink means a silhouette edge blends toward the
  line already surrounding it, so the downsampled RGBA carries no halo.

Arms take either angles or a `reach` target; the two-bone solve places the
elbow, which is how the poses that hold something stay attached to it when the
prop moves.

Every motion is a sine of `i / n`, so frame n-1 hands back to frame 0 without a
seam. `bake.py` fails rather than writing an atlas whose ink comes within a
pixel of a cell edge.

## The CJK face

`apps/pocket-chan/chan-cjk.otf` is a subset of Noto Sans CJK JP, cut to exactly
the characters the app spells. Regenerate it after editing any Japanese or
Chinese string:

```sh
curl -fsSL -o .pocket-build/pocket-chan/NotoSansCJKjp-Regular.otf \
  https://raw.githubusercontent.com/notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf
shasum -a 256 .pocket-build/pocket-chan/NotoSansCJKjp-Regular.otf
# 68a3fc98800b2a27b371f2fb79991daf3633bd89309d4ffaa6946fd587f375b5

bun tools/font-subset.ts .pocket-build/pocket-chan/NotoSansCJKjp-Regular.otf \
  apps/pocket-chan/chan-cjk.otf --name="Noto Sans CJK JP Pocket Chan Subset" \
  --metrics=font --scan=apps/pocket-chan/chan.ts --scan=apps/pocket-chan/app.tsx \
  --range=3000-303F,3040-30FF,4E00-9FFF,FF00-FFEF
```

`--metrics=font` keeps the source advances and side bearings. The default
(`--metrics=ink`) normalises each advance to the glyph's own ink, which suits
an icon font and collides CJK text.

The SIL Open Font License for the source face is
`assets/fonts/LICENSE-NotoSansCJK.txt`.

## Design

The palette and silhouette follow the Pocket Chan reference sheet: yellow
`#FFD400` hair with an ahoge, a black ribbon on her left and the PocketJS mark
worn as a hairpin on her right, amber eyes with a lash wing, a cropped black
jacket over a white bustier with a harness buckle, a lanyard tag, a pleated
skirt, black thigh-highs and buckled boots. The mark's own colours come from
`assets/brand/pocketjs-avatar-dark.svg`.
