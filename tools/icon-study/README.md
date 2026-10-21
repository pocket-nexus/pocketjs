# Classic Pocket icon study

Four locally baked proposals for the iOS 6 SpringBoard and Nintendo 3DS
Homebrew Launcher. Proposal D is selected for the host assets. The study
commands only regenerate the comparison page; `bun tools/device-icons.ts`
regenerates the committed host PNGs from their host-owned SVGs.

```sh
bun tools/icon-study/bake.ts --smdh
bun tools/icon-study/serve.ts
```

Open <http://127.0.0.1:4176/>. `PORT` overrides the loopback server's port.
The baker writes PNGs, SVGs, SMDHs, a contact sheet, and a SHA-256 manifest
under `dist/icon-study/`. The page lets reviewers switch proposals, preview
three desktop backgrounds, compare the old and proposed icons at enlarged
sizes, and download individual assets. The scene labels distinguish the
illustrated desktop and HBL surroundings from actual device captures.

The `--smdh` option requires the locally installed
`devkitpro/devkitarm:latest` Docker image. It runs without networking and
uses `smdhtool` to package both optical sizes. Without the option, the page
labels its 3DS images as RGB PNG previews and hides the SMDH download.

| Proposal | Treatment |
| --- | --- |
| A / Warm enamel | Plum enamel, warm gold outline, cream controls |
| B / Plum graphite | Quiet plum surface with a single silver-white mark |
| C / Brass badge | Warm gold surface with a dark plum mark |
| D / Quiet arcade | Muted yellow, pink, and cyan from the current brand |

The iOS drawing mounts the geometry from `site/assets/favicon.svg`, recolored
for each proposal. One radial light replaces the old straight-sided gloss
shape. The outer trim uses one gradient with three stops. The baker emits
pre-masked 57, 114, and 512 px images with transparent corners; the 512 px file is a source-art preview.
The PNG supplies the display mask; the webpage supplies the outside shadow. A future installed
selection must retain `UIPrerenderedIcon`, update its versioned resource name,
and pass a fresh SpringBoard cache/visual check.

The 3DS drawings align straight stroke edges to the 48 and 24 px grids.
Each size has its own geometry, spacing, and radii. They omit the iOS bevel,
glass, and shadow. The baker decodes the actual SMDH tiled RGB565 payload and
compares every candidate pixel against its input, allowing only the format's
5/6/5-bit quantization error. The page uses those decoded images when the
SMDH pass is enabled.

## Baselines and format references

- `assets/current-ios-v4.png` is the 118×120 Retina PNG produced by
  `tools/iphone-classic-icon.ts` at commit `12bcb1b2` (Draft PR #354), copied
  from that checkout's `dist/ipodtouch4/PocketJSiPodTouch4.app/`. It is the
  user-reported v4 artwork, not a claim about the latest remote main.
- `assets/current-3ds.png` is the 48×48 `products/3ds/icon.png` from main at
  `64fc0c07`. The baseline small SMDH icon uses smdhtool's automatic reduction;
  proposals supply a separately drawn small icon.
- [Apple QA1686](https://developer.apple.com/library/archive/qa/qa1686/_index.html)
  specifies 57×57 and 114×114 for the iPhone/iPod touch home screen on iOS 6.1
  and earlier.
- [devkitPro smdhtool](https://github.com/devkitPro/3dstools/blob/master/src/smdhtool.cpp)
  accepts a 48×48 PNG and an optional 24×24 PNG, and packs tiled RGB565.

## Validation scope

The bake command checks 3DS opacity and output dimensions through fixed-size
canvas generation, SMDH magic/length, and every decoded candidate pixel. The
manifest records 20 PNG inputs and five packaged SMDH files when enabled.
The contact sheet contains native sizes and enlarged baked pixels for visual
inspection. The before/after panel also exposes nearest-neighbor inspection.

These checks do not establish physical LCD color, the installed SpringBoard
mask/cache, or HBL's on-device rendering. A selected proposal still needs
integration into host packaging and physical visual acceptance. This initial
study was inspected through its rendered contact sheet and HTTP assets;
interactive browser validation was unavailable because no browser connection
was registered in the session.
