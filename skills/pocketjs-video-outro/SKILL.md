---
name: pocketjs-video-outro
description: Append a short PocketJS or Pocket3D animated end card to a local video (screen recording, demo capture, phone clip). Preserves the full source before transitioning to a card in the Arcade look of pocketjs.dev and 3d.pocket.nexus, with the mark, wordmark, candy pixel headline and the site's address. Use when asked to add an outro / end card / 片尾, brand a recording, or produce a shareable PocketJS or Pocket3D clip.
---

# PocketJS Video Outro

## Overview

Turns any local video into a shareable clip that ends on the PocketJS or the
Pocket3D card. The card is drawn the way the two homepages draw themselves
(`site/assets/arcade.css`): the plum `#171226` ground with soft pixel dots and a
few faint candy sprites, the product's mark with its name in white Fredoka 600 as
the sites' bars set it, and the headline as candy Press Start 2P letters, each
letter taking the next of the five hues, on the hero's marquee plate (a bezel in
the hero hue, a lip, a spark and a row of bulbs). The site's address sits at the
foot in muted Fredoka.

| `--brand` | Mark | Headline | Plate | Footer |
| --- | --- | --- | --- | --- |
| `pocketjs` (default) | `site/assets/favicon.svg` | `CREATE UI ON` / `EVERY SCREEN` / `YOU LOVE` | pink | pocketjs.dev |
| `pocket3d` | `site/pocket3d/mark.svg` | `CREATE 3D ON` / `EVERY SCREEN` / `YOU LOVE` | yellow | 3d.pocket.nexus |

The marks and both faces are bundled with the skill (`tests/video-outro.test.ts`
holds the marks and the pixel face equal to the sites' own files), so rendering
makes no network request. Headless Chrome renders the layers, then `ffmpeg`
appends the card and animates it in. **The default ending adds 2 seconds after the full
source, including a 0.35-second crossfade from its held final frame.** Use this
ending unless the user requests another duration; `--outro` and `--xfade` remain
available for that choice.

Design choices baked into the pipeline:

- **Preserve the source ending.** Play every source frame before starting the
  transition. Hold the final frame during the appended crossfade; do not dim or
  consume the source's last moments to make room for the card.
- **Crossfade first, text second.** The held final frame dissolves into the
  *empty* branded background; the type only starts animating once the transition
  has settled, so it never fights the crossfade.
- **Staggered, stepped entrance.** Logo, plate and URL start 0.12 seconds apart
  after the crossfade; the headline's lines drop in one after another inside the
  plate's slot, 0.06 seconds apart, and the last lands with the URL. Each layer
  drops in three held steps (above, halfway, a small overshoot, rest), as the
  sites' headline letters do with `steps(3)`, and fades in over the first third
  of its slot. The default card settles at 0.79 seconds and holds for 1.21
  seconds. Short custom cards compress the entrance to leave at least half the
  time after the transition for the complete lockup.
- **The hero's headline.** Press Start 2P, uppercase, per-letter candy fills with
  a plum outline, a same-hue extrusion and a stepped drop, as `site/candy.ts` and
  `arcade.css` set the hero. Each authored line stays one line; pass explicit
  line breaks instead of letting the browser choose the lockup.
- **Audio is the source's, never synthesized.** The card is silent; the original
  track is preserved and faded out by the original source's end (no voiceover).
- **Shareable SDR output.** HLG/PQ phone footage is perceptually tone-mapped to
  BT.709 before compositing, and the browser-rendered sRGB card is converted into
  the same color space. This avoids mixing an SDR card directly into HDR code values.

## Requirements

- `ffmpeg` / `ffprobe` on PATH. HDR inputs require FFmpeg 8+ for swscale's
  transfer/primaries conversion and perceptual tone mapping; SDR inputs do not.
- A Chromium-family browser (Google Chrome, Chromium, Edge, or Brave) — used only
  to screenshot the card layers. The script auto-detects it.

## Standard workflow

One Bun command produces the finished file (the driver is Bun TypeScript — this
repo keeps command wrappers in Bun, not shell scripts):

```bash
bun skills/pocketjs-video-outro/scripts/make-outro.ts -i ~/Downloads/clip.mov
# writes ~/Downloads/clip_outro.mp4  (H.264 high, yuv420p, +faststart, AAC 192k)
# default card: PocketJS, CREATE UI ON / EVERY SCREEN / YOU LOVE, pocketjs.dev
# adds 2 seconds after the full source, including a 0.35-second transition

bun skills/pocketjs-video-outro/scripts/make-outro.ts -i ~/Downloads/clip.mov --brand pocket3d
# Pocket3D card: CREATE 3D ON / EVERY SCREEN / YOU LOVE, 3d.pocket.nexus
# prints the output path on stdout; progress/summary on stderr
```

If the user supplies different positioning, preserve that copy exactly. Pass
explicit line breaks when the lockup requires them; the template keeps them:

```bash
bun skills/pocketjs-video-outro/scripts/make-outro.ts \
  -i ~/Downloads/clip.mov \
  --tagline $'Create UI on\nevery screen\nyou love'
```

For an X upload, enable the compatibility mode. It produces 30 fps CFR video,
uses a conventional 30 kHz track timebase, closes GOPs, caps bitrate, and scales
landscape/portrait footage within 1920x1080 or 1080x1900:

```bash
bun skills/pocketjs-video-outro/scripts/make-outro.ts -i ~/Downloads/clip.mov --x
# writes ~/Downloads/clip_outro_x.mp4, leaving a standard outro export untouched
```

For X-mode verification, both reported rates must be `30/1`, the timebase must be
`1/30000`, and the dimensions must stay within the orientation-aware 1080p bounds:

```bash
ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height,r_frame_rate,avg_frame_rate,time_base \
  -of default=nw=1 ~/Downloads/clip_outro_x.mp4
```

Do not report a finished video from command success alone. Verify five independent
properties: full-file decode, delivery metadata, the source ending, the visible
card and its entrance, and body-versus-tail audio. Choose a body sample that
contains source sound. The render log gives the crossfade offset, which must match
the source duration. Subtract it from the final probed duration to check that the
default ending adds 2 seconds, allowing one frame for rounding. A ten-second
source produces about 12 seconds in total.

```bash
OUTRO_VIDEO=~/Downloads/clip_outro.mp4
ffmpeg -v error -i "$OUTRO_VIDEO" -f null -                       # full decode
ffprobe -v error -select_streams v:0 \
  -show_entries \
  stream=codec_name,profile,width,height,pix_fmt,r_frame_rate,avg_frame_rate,time_base,color_range,color_space,color_transfer,color_primaries \
  -of default=nw=1 "$OUTRO_VIDEO"
ffmpeg -v error -y -sseof -0.6 -i "$OUTRO_VIDEO" \
  -frames:v 1 /tmp/pocketjs-outro-final.png
ffmpeg -v error -y -sseof -3 -i "$OUTRO_VIDEO" \
  -vf 'fps=8,scale=240:-2,tile=6x4' -frames:v 1 /tmp/pocketjs-outro-motion.jpg
ffmpeg -hide_banner -ss 2 -t 3 -i "$OUTRO_VIDEO" \
  -af volumedetect -f null - 2>&1 | rg 'mean_volume|max_volume'
ffmpeg -hide_banner -sseof -0.7 -i "$OUTRO_VIDEO" \
  -af volumedetect -f null - 2>&1 | rg 'mean_volume|max_volume'
```

Inspect both images. The final frame must show the requested copy in the bundled
pixel face without clipping, with the right mark; the motion sheet must show the
source at full brightness through its end, followed by the crossfade and the
logo → plate → lines → URL stagger. Compare the source's last frames against the export before the
transition; for HDR, apply the same tone mapping to the reference. HDR inputs must
finish as `tv`, `yuv420p`, and `bt709/bt709/bt709`. The body sample must retain audio
and the final 0.7 seconds must be effectively silent with the defaults. For a
shorter custom card, sample only the tail after the original source has ended.

## Options

| Flag | Default | Purpose |
|------|---------|---------|
| `-i` / `--input` | — (required) | input video |
| `-o` / `--output` | `<input>_outro.mp4` next to input | output path (`_outro_x.mp4` with `--x`) |
| `--brand` | `pocketjs` | `pocketjs` or `pocket3d`: mark, wordmark, plate hue, default headline and URL |
| `--tagline` | the brand's headline | headline; each newline starts a line, and each line enters on its own |
| `--url` | the brand's site | footer line; pass `--url ""` to hide it |
| `--outro` | `2` | appended end-card length in seconds, including the transition |
| `--xfade` | `0.35` | crossfade length; must be shorter than the card; `0` cuts to it |
| `--crf` / `--preset` | `18` / `medium` | x264 quality/speed |
| `--x` / `--x-compatible` | off | emit an X-safe 30fps CFR social upload |

## How it adapts to the input

- Probes width/height/fps/duration; VFR inputs use `avg_frame_rate` rather than
  treating `r_frame_rate` as the real cadence. The selected rational rate is passed
  directly to FFmpeg, avoiding floating-point timebases.
- By default the card uses the source's native resolution and selected frame rate.
  `--x` switches to 30 fps CFR and orientation-aware 1920x1080/1080x1900 bounds.
- The crossfade starts at the source duration, using cloned final frames for its
  full requested length even when the source is shorter than the transition.
- Display-matrix rotation is applied to the probed dimensions before rendering the
  card, matching FFmpeg's default autorotation for portrait phone footage.
- **Color:** SDR inputs keep the existing path. HLG and PQ inputs (including the
  HLG base layer in iPhone Dolby Vision clips) are tone-mapped to 8-bit BT.709 SDR;
  Dolby Vision metadata is intentionally not carried into the shareable H.264 file.
- **Type scales** with `scale = min(W,H)/1080`, so 720p, 1080p, and 4K all look
  proportional. The default headline keeps its three authored lines; custom copy
  preserves explicit newlines and still wraps before the frame edge.
- **Audio:** maps the source's *first* audio stream (`0:a:0`) and downmixes to
  stereo. This is deliberate — iPhone `.mov` captures carry an extra multi-channel
  spatial-audio track plus several data streams; `a:0` is the standard stereo mix.
  If the source has no audio, the output is video-only.

## Publishing a video on pocketjs.dev

There is no separate upload step — videos ship with the site deploy as
static Worker assets (Cloudflare, `site/wrangler.jsonc`; keep each file well
under the 25 MiB per-asset limit):

1. Commit the mp4 into git at `site/assets/<name>.mp4` (existing examples:
   `pocketjs-hardware-demo.mp4`, `pocketjs-demo-wall.mp4`).
2. Add a `copy(SITE + "assets/<name>.mp4", "assets/<name>.mp4")` line in
   `site/build.ts` step 4, next to the other mp4 copies. Files under
   `site/assets/blog/` (e.g. poster frames) are directory-copied
   automatically and need no explicit line.
3. Embed with a raw `<video>` tag in the page or post markdown. House
   classes: `class="w-full rounded-xl border border-line"`. Silent loops use
   `autoplay muted loop playsinline`; anything with a soundtrack must use
   `controls playsinline preload="metadata"` plus a `poster` (browsers block
   un-muted autoplay). Bake the poster with
   `ffmpeg -ss <t> -i in.mp4 -frames:v 1 -q:v 3 site/assets/blog/<name>-poster.jpg`.
4. Verify locally with `bun run site:build`, then merge to main —
   `.github/workflows/deploy.yml` runs `site:build` and
   `bunx wrangler deploy -c site/wrangler.jsonc`. Manual deploy is those same
   two commands.

## Customization & internals

- The card is `assets/outro.html`, parameterized via query string
  (`?layer=…&scale=…&brand=…&tagline=…&url=…`). Every dimension is in `rem` (the
  plate in `em` of its headline) and the script sets root font-size to
  `10px * scale`. Restyle it from `site/assets/arcade.css`, not by inventing a
  third look. The faces and their OFL licences are
  `assets/press-start-2p-latin.woff2` / `assets/OFL-PressStart2P.txt` and
  `assets/Fredoka.ttf` / `assets/OFL-Fredoka.txt`; the marks are
  `assets/pocketjs-mark.svg` and `assets/pocket3d-mark.svg`. When a site's mark
  changes, copy it here; the test fails until the copies match.
- Entrance/animation is entirely in `ffmpeg`, orchestrated by `scripts/make-outro.ts`
  (Bun TypeScript, `import { $ } from "bun"`): each element (`bg`, `logo`,
  `plate`, `line-N`, `url`) is screenshotted as its **own transparent layer** with
  the *others kept in place via `visibility: hidden`* (so absolute positions never
  shift), then composited with per-layer `fade` (alpha) + `overlay` (the stepped
  drop of `dropIn`). Change drop distances or stagger there.
- Keep new wrappers/tooling for this skill in Bun TypeScript — do not add `.sh`
  scripts (repo convention; see also `pocketjs-gba-imagegen`).
- To preview just the card without a video, screenshot the template directly:
  `"<chrome>" --headless --screenshot=card.png --window-size=1920,1080 "file://$PWD/skills/pocketjs-video-outro/assets/outro.html"`.

## Gotchas

- Chrome's headless screenshot honors `--force-device-scale-factor=1` and
  `--default-background-color=00000000`; the text layers rely on that alpha to
  composite. Don't drop those flags.
- Keep the output `yuv420p` + `+faststart` (already set) — some players choke on
  4:4:4 or non-faststart MP4s.
- `xfade` needs both sides normalized to identical size/fps/sar/pix_fmt; the graph
  does this. If you feed a variable-frame-rate capture, the `fps` filter conforms it.
- ReplayKit and other VFR captures can report a high `r_frame_rate` that represents
  their smallest frame interval, not their real cadence. Keep average-rate priority
  and the original rational expression when changing probe logic.
- Do not remove the explicit sRGB-to-BT.709 conversion from the card layers when
  changing HDR handling. Retagging Chrome's SDR PNG values as HLG/PQ is not a valid
  color conversion and makes the card shift on an HDR-aware display.
- A long headline line can approach the frame edge; the plate has
  `max-width: 92vw` and wraps between words before overflowing. A wrapped line
  still enters as one layer.
