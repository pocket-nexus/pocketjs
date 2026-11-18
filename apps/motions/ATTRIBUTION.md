# Motion Lab attribution and permission

The motion studies reproduced by Motion Lab are original works by
[yui540](https://yui540.com/):

- [motions/53](https://yui540.com/motions/53)
- [motions/56](https://yui540.com/motions/56)
- [motions/30](https://yui540.com/motions/30)
- [motions/64](https://yui540.com/motions/64)

On August 5, 2026, yui540 offered PocketJS continued use of these four
already-ported studies on two conditions:

- Screens showing the studies carry the credit `(yui540)` near an edge.
- PocketJS obtains separate permission before porting another CSS animation
  by yui540.

PocketJS accepts both conditions. The credit is therefore part of the Motion
Lab footer, is embedded in public capture assets, and must remain visible in
any cover or thumbnail rendered from the app.

This accepted scope covers only the four studies listed above. PocketJS must
obtain yui540's permission before adding or publishing another study.

The PocketJS implementation remains in this directory so its keyframe, 3D,
browser, simulator, and device paths can continue to be developed and tested.

## Capture maintenance

Run `bun site/stamp-motion-credits.ts` after regenerating a Motion Lab GIF.
The script places `(yui540)` on every frame; `--check` verifies the dimensions,
generated marker, legibility, and frame-to-frame persistence of all ten public
GIF assets. `bun site/bake-demo-wall.ts` runs the same check before rebuilding
the homepage wall and adds a tile-level credit after four-up crops are composed.
