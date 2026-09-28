# The film

`/mv/` on pocketjs.dev. An original 1:19 short for PocketJS — "ポケットに空を",
*A Sky in Your Pocket*.

There is no video file and no audio file in this directory. The page ships five
ES modules, and the film is what they compute:

| File | What it is |
| --- | --- |
| `score.js` | The song. Note data for 56 bars at 176 BPM, and a synthesizer that turns it into stereo samples in plain JavaScript — no Web Audio nodes, no DOM, so it runs the same in the browser and in Bun. |
| `film.js` | The picture. `drawFrame(ctx, t)` paints one moment of the film. It reads nothing but `t`. |
| `draw.js` | The marks `film.js` is made of: rough strokes, grain, type, and the recurring motifs (the handheld, a bird, a runner, a cloud). |
| `lyrics.js` | The words and the bars they land on, plus the on-screen source and the hardware list. |
| `player.js` | The page. Synthesizes the song in a worker, then drives `drawFrame` from the AudioContext clock. |

`page.html` and `mv.css` are the room the film plays in; `site/film.ts` renders
the page around them, and `site/build.ts` copies the modules into `site/dist/mv/`.

## Why it is written this way

`drawFrame` depends only on `t`, so the film can be played against a clock or
stepped by hand. `tools/render-mv.ts` steps it: it serves this directory, points
headless Chrome at `capture.html`, calls `__mv.render(t)` once per video frame
and screenshots the canvas, while rendering the audio track from `score.js` in
Bun. The video and the web page are therefore the same film rather than two
things that have to be kept in agreement.

```sh
bun run site:verify-film                            # drive the page and check it plays
bun run site:film                                   # 1920x1080, 30 fps -> .pocket-build/validation/promo-mv/<run>/
bun tools/render-mv.ts --width 1280 --height 720    # a smaller share copy
bun tools/render-mv.ts --stills 13,45.7             # single frames, for reviewing a shot
bun tools/render-mv.ts --audio-only                 # the song as a wav
```

Rendered video stays in ignored `.pocket-build/`. `capture.html` is the
renderer's harness and is not copied into the site build.

## Timing

Everything is written in bars, so retiming the song retimes the film. The cut
list lives in `film.js`:

| Bars | Section | Shot |
| --- | --- | --- |
| 0–8 | intro | A handheld falling through deep blue, and the title |
| 8–16 | verse | Paper and blue ink: the source, a hand, the screen resolving |
| 16–24 | verse | The run, the hardware behind it, `DOM` / `CSS` / `WebView` struck out |
| 24–32 | pre-chorus | Push into the screen; the snare roll breaks the frame up |
| 32–48 | chorus | Eight shots, two bars each |
| 48–56 | outro | One device on a wide field, and the wordmark |

## Music

C major / A minor, 176 BPM, 4/4. Intro 8 bars, verse 16, pre-chorus 8, chorus
16, outro 8. Seven synthesized voices — piano, saw lead, chip square, bass, pad,
and a drum kit — into a Schroeder reverb. `tests/site-film.test.ts` pins the
song's determinism, its headroom, and that the lyric sits on the bars the
picture cuts on.
