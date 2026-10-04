# Local site preview

```sh
bun run site:preview
```

Open **http://127.0.0.1:4173/** to preview the production homepage. The
selected layout keeps the original video Hero, pixel headline, description,
buttons, and technical chapters, with a compact app strip below the buttons.
Pocket Shell, OpenStrike, Pocket Voxel, and PSPMAN link to their setup details.
The Ecosystem section retains its existing engineering examples and articles,
with device filters and additional cases.

The PSP motion demo shows its loading placeholder inside the reserved demo
viewport. It loads when the section approaches the screen.

Use `--port=4174` for another port, or `--no-build` to serve an existing
`site/dist/`. Earlier A/B/C study routes and their comparison controls are
retired; the preview serves the same output that is deployed.

To inspect the docs navigation, open `/docs/overview/` below 1000 CSS pixels
wide. The sticky **Browse docs** disclosure contains the same sections and
active page as the desktop sidebar. It works without JavaScript, supports
keyboard activation, and scrolls internally when the directory exceeds the
screen.

## pocket.nexus

```sh
bun run nexus:preview
```

Open **http://127.0.0.1:4190/** to preview the Pocket Nexus homepage. The
preview serves `site/nexus/public/` as the `pocket-nexus` Worker does: the
homepage at `/` and `404.html` for unknown paths. The page has no build step.

After editing `site/nexus/mark.svg` or the homepage layout, run
`bun run nexus:icons`. It rasterizes the favicon family from the mark and
captures `og-image.png` from the homepage at 1200x630 with reduced motion,
with the top bar, button and hint hidden.

## 3d.pocket.nexus

```sh
bun run pocket3d:preview
```

Open **http://127.0.0.1:4191/** to preview the Pocket3D homepage. The preview
serves `site/pocket3d/public/` as the `pocket3d` Worker does. The page has no
build step: `public/index.html` carries its styles and script inline.

| Route | Contents |
| --- | --- |
| `/` | The homepage: the extruded title, a strip of console captures, and four chapters with one diagram each |
| `/logo/` | The mark study, in the preview only: six extrusions of the PocketJS mark beside the cube and the flat mark, with sliders for turn, tilt, depth and camera distance |

The title holds one pose and leans about two degrees toward the pointer. With
reduced motion set, the title stays still, the diagrams show their final state
and the capture strip scrolls by hand.

`site/pocket3d/logo/` sits outside `public/`, so the Worker does not deploy
it. Its `mark3d.js` draws the mark: it extrudes the PocketJS outline, turns it
and projects it to an SVG string. `site/pocket3d/mark.svg`,
`public/favicon.svg` and the mark inlined in the homepage and `404.html` are
its `brick` option. To change the mark, pick or tune an option on `/logo/`,
then write the same string to those four places;
`tests/site-pocket3d.test.ts` fails while they differ.

After the mark or `site/pocket3d/og-card.html` changes, run
`bun run pocket3d:icons`. It rasterizes the favicon family from the mark and
captures `og-image.png` from the card page at 1200x630. The card page loads
Titan One and Fredoka from Google Fonts, so the command needs a network.

`site/pocket3d/title-card.html` is the art of the title card that Pocket3D
games show at launch. `bun tools/pocket3d-title.ts` bakes it into
`engine/pocket3d/crates/pocket3d-title/`; that crate's README has the steps.

The captures in `public/assets/` are WebP encodings of frames from Pocket
Maneuver, Pocket Atlas and OpenStrike. The measured figures are the ones
recorded in those repositories' READMEs.
