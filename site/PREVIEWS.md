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
