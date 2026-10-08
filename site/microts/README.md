# MicroTS site

Website, documentation and playground for **MicroTS**, the ahead-of-time mode of
PocketJS that compiles Vue single-file components, Solid TSX views and
TypeScript models into Rust. Deployed to `microts.pocket.nexus` by the
`microts` job in `.github/workflows/deploy.yml`.

- **Home**: what MicroTS compiles and how, with the counter from the guide and
  the Pocket Retro games.
- **Docs**: the MicroTS section of `site/nav.ts` plus `typescript-support`,
  rendered at build time from `site/content/docs/` with marked and Shiki. The
  same Markdown files build the pocketjs.dev pages; links to pages this site
  does not render go to pocketjs.pocket.nexus.
- **Playground**: a start page to pick a template, one of your projects or an
  example, then an editor and a live preview. Projects are stored in
  `localStorage`; files can be added, renamed and deleted, and a project can be
  shared as a link. Previews run in the browser:
  - MicroTS apps (Vue SFC and Solid TSX counters, `apps/vue-sfc-lab`,
    `apps/solid-aot-lab`) compile in a Web Worker and render through
    `pocketjs.wasm`, the Rust UI core built for `wasm32-unknown-unknown`.
  - [Pocket Retro](https://github.com/pocket-nexus/pocket-retro) games run as
    JavaScript in a Web Worker against the Pocket Retro SDK; a canvas shows the
    palette screen and an AudioWorklet port of the GBA mixer plays the sound.

  Neither path compiles Rust. The native builds are described in the docs.

Visual rules are in [DESIGN.md](DESIGN.md).

## Develop

From the repository root:

```sh
bun install
bun run microts:dev          # http://127.0.0.1:8150, rebuilds on change and reloads the page
bun run microts:build        # -> site/microts/dist/
bun run microts:preview      # serve site/microts/dist/ as built
bun run microts:typecheck    # vue-tsc over src/, lib/ and kit/
```

The build runs `bun tools/wasm.ts`, so it needs Cargo with the
`wasm32-unknown-unknown` target. It also fetches the pinned pocket-retro commit
over HTTPS on the first run.

`dist/` is a single-page app: the host serves `index.html` for paths without a
file (`wrangler.jsonc` sets `not_found_handling` to `single-page-application`),
and the router renders the 404 page.

## Build

`build.ts` bundles everything with `Bun.build`; there is no Vite.

| Output | Source |
|---|---|
| `index.html`, `assets/main-*.js`, `assets/chunk-*.js` | `src/`; `.vue` files compile through `@vue/compiler-sfc` in `lib/plugins.ts`; each page and each preset's sources are a separate chunk |
| `assets/site-*.css` | `src/styles/main.css` through `bunx @tailwindcss/cli`, followed by the SFC `<style>` blocks |
| `assets/retro-worker.js`, `assets/retro-mixer.js` | the retro game worker and the audio worklet |
| `pocket/` | the UI preview kit (`lib/kit.ts`): `kit/` compiler worker and preview iframe, the framework subpaths, Vue Vapor and Solid runtimes, `hosts/web/pocketjs.wasm`, Inter |
| `retro/<id>/` | baked assets and a poster frame per game (`lib/retro.ts`) |
| `fonts/`, `pocket3d-mark.svg` | copied from `site/assets/fonts/` and `site/pocket3d/mark.svg` |

The app imports build-time data through virtual modules (`src/env.d.ts` has
their types): `microts:docs`, `microts:files/<kind>/<name>`,
`microts:retro-catalog`, `microts:retro-sources` and `microts:build`.

### Pocket Retro

`lib/retro.ts` checks out `RETRO_COMMIT` from pocket-retro into
`.cache/pocket-retro/` and generates `.cache/retro/` (both gitignored): the SDK
with `sdk/assets.ts` replaced by a runtime loader, the game sources, baked
assets, and a poster from a headless run of each game (`lib/retro-poster.ts`).
The output is reused until the commit changes. To update the games, change
`RETRO_COMMIT`. To try a local pocket-retro checkout, set
`POCKET_RETRO_DIR=../pocket-retro`; the build then regenerates on every run.

`bun site/microts/build.ts --prepare` runs this step alone; `microts:typecheck`
runs it first because `retro` resolves to the generated SDK.

## Layout

```text
build.ts, serve.ts     build and dev server
lib/                   Bun plugins, Markdown rendering, preview kit and Pocket Retro builders
kit/                   browser compiler and preview runtime, bundled into /pocket/
content/home/          code snippets shown on the home page
src/docs/              which docs pages render (catalog.ts) and the sidebar (nav.ts)
src/pages/             Home, Docs, Playground start page, Playground, 404
src/playground/        presets, templates, project storage, editor, device frames, retro host, UI preview
src/styles/main.css    Tailwind v4 theme tokens and the Arcade component classes
```

## Licenses

Bundled third-party content keeps its own license, published next to it:
PocketJS (`/pocket/LICENSE.txt`), Inter (`/pocket/fonts/LICENSE.txt`), Press
Start 2P (`/fonts/OFL-PressStart2P.txt`), and the Pocket Retro SDK and games
(`/retro/LICENSE.txt`, `/retro/THIRD_PARTY_NOTICES.md`).
