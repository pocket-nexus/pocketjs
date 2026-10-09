# MicroTS site design rules

The MicroTS site belongs to the Pocket family ([pocket.nexus](https://pocket.nexus/), [PocketJS](https://pocketjs.pocket.nexus/), [Pocket3D](https://3d.pocket.nexus/)) and uses the family's **Arcade look**: a dark purple ground, five candy colors, hard drop shadows and pixel headings. The values are copied from `site/assets/arcade.css` and `site/assets/tokens.css` in this repository. Those two files are the reference for the family look: change them first, then carry the change into `src/styles/main.css`.

This file describes the visual and interaction rules; the implementation is in `src/styles/main.css` (tokens and component classes) and `src/components/`. Paths that start with `src/` or `lib/` are relative to `site/microts/`; `site/…`, `apps/…` and `hosts/…` paths are relative to the repository root.

---

## 1. Principles

1. **Dark theme only.** `color-scheme: dark`, `theme-color #171226`. The family has no light theme, so there is no theme switch.
2. **Hard shadows; no blurred shadows to express elevation.** Every raised element (keys, panels, labels) uses an offset shadow with zero blur, `0 Npx 0 <dark color>`, and may add one ambient shadow `0 24px 40px -22px rgba(0,0,0,.85)`.
3. **Thick borders, no hairlines.** Panels 3px, keys 2–2.5px; dividers use `3px dotted`.
4. **Pixel type is limited to headings, labels and "screens".** Body text uses a sans-serif; scanlines appear inside the code screens, the game screens and the home hero plate, and nowhere else.
5. **One hue per section.** Borders, labels, sparks and pellets inside a section take the same hue, switched with the `.hue-*` classes.
6. **State facts.** Copy states mechanisms and numbers, not slogans (see section 8).

---

## 2. Color

### 2.1 Ground and surfaces

| Token | Value | Use |
|---|---|---|
| `bg` | `#171226` | Page ground |
| `bg-2` | `#1c1630` | Badge background, editor tab bar |
| `panel` | `#231b3b` | Panels, cards |
| `panel-2` / `key` | `#2b2148` | Keys, inline code background |
| `key-hi` | `#352a58` | Key hover |
| `screen` | `#120c21` | Code screens, game screens, editor |
| `shade` | `#0e091a` | Handheld screen bezel |
| `floor` | `#120d20` | Footer |
| `out` | `#221338` | Button outlines, text on yellow, candy-text outline |
| `drop` | `#0a0614` | Every hard shadow |

### 2.2 Text

| Token | Value | Use |
|---|---|---|
| `ink` | `#fcf6ff` | Headings, emphasis |
| `ink-2` | `#cbbde2` | Body text |
| `soft` | `#a597c4` | Lead paragraphs, descriptions (contrast 6.9:1 on `bg`) |
| `muted` | `#8e80ac` | Secondary information, metadata |
| `dim` | `#6f6389` | Console timestamps, placeholders |

### 2.3 Five candy colors

Each hue has three steps, base / light / deep: base for borders, label backgrounds and candy text; light for text on dark backgrounds; deep for the bottom lip of panels (`0 6px 0 var(--hue-d)`) and the candy-text extrusion.

| Hue | base | light | deep |
|---|---|---|---|
| yellow | `#ffd23f` | `#fff0a8` | `#c99400` |
| pink | `#ff5f9e` | `#ffb8d4` | `#c23a73` |
| cyan | `#3fd0e8` | `#b8f2fa` | `#1b93a8` |
| lilac | `#a98bff` | `#dccfff` | `#7155d8` |
| orange | `#ffb45c` | `#ffdfb4` | `#cf7d1c` |

- Text on a hue background uses `#23122e` (labels) or `out`; the pink current item uses `#2a0d1c`.
- Primary button gradient `linear-gradient(180deg,#ffdc63,#ffc01f)`, text `#2a1b10`.
- Status colors: success `#34d399`, error `#f87171`, error body text `#fecaca`, error panel background `#2a0f22`.
- Selected text: yellow background with `out` text. Focus ring: `3px solid cyan`, `outline-offset: 3px`.

### 2.4 MicroTS hue assignment

The MicroTS mark is a **plum tile in a yellow frame with a cyan italic μ**, and a pink bar over a lilac bar on each side of the μ. `site/microts/mark.svg` is the drawing. `bun run microts:icons` copies it to `public/favicon.svg`, which the favicon and `src/components/MicroTSMark.vue` show, and rasterizes the icon family from it. The pocket.nexus homepage draws the same shapes from one `<symbol id="mts">`, in its Technology menu and its row of technology.

| Location | Hue | Reason |
|---|---|---|
| Home hero plate | pink | Matches the PocketJS home page; the family entry color |
| One source (the source and its three build paths) | cyan | Code screens are cyan |
| How it compiles (the compiler pipeline) | lilac | The color of the mark's lower bars, stands for the compiler |
| Pick a model (the two model modes) | yellow | A choice between options |
| Made with MicroTS (Pocket Retro) | pink | Games and entertainment content |
| Start here (commands and docs entry points) | orange | Closing call to action |
| Playground: MicroTS apps (Vue / Solid) | cyan | Same as the code screens |
| Playground: Pocket Retro games | pink | Matches the games section on the home page |

Card grids cycle through the hues `pink → cyan → yellow → lilac → orange`.

---

## 3. Typography

| Role | Typeface | Loading | Use |
|---|---|---|---|
| Body | IBM Plex Sans 400/500/600/700 | Google Fonts | 16px / 1.6; docs body text uses line height 1.72 |
| Interface | Fredoka 500/600/700 | Google Fonts | Nav keys, labels, card titles, docs h2/h3 |
| Pixel headings | Press Start 2P | Self-hosted at `/fonts/press-start-2p-latin.woff2` (copied by `build.ts` from `site/assets/fonts/`), `font-display: block`, preloaded | Candy-text headings, arcade buttons, code tabs, status text on screens |
| Monospace | IBM Plex Mono 400/500/600 | Google Fonts | Code, metadata lines, kicker |

Type scale:

| Element | Spec |
|---|---|
| Home title | `clamp(1.15rem, 3.3vw, 2.4rem)` / 1.45, candy text `--u: 3px` (2px at ≤620px) |
| Section heading | `clamp(1.05rem, 2.45vw, 1.9rem)` / 1.4, candy text |
| Docs h1 | 1.9rem / 1.5 (1.35rem on mobile), candy text |
| Docs h2 | Fredoka 600 1.5rem, preceded by a yellow pixel star |
| Docs h3 | Fredoka 600 1.18rem, `lilac-l` |
| Card title | Fredoka 600 1.18rem / 1.25 |
| Lead paragraph | 1.04rem, `soft` |
| Label `.label` | Fredoka 600 .84rem |
| kicker | IBM Plex Mono 500 13px, letter spacing .09em, uppercase, preceded by a 9px square |
| Code | IBM Plex Mono 12.5px / 1.65; editor 13px |

### Candy text (the family heading style)

The `CandyText` component splits a heading into one `span` per letter. Letter colors cycle pink/yellow/cyan/lilac/orange, and each letter stacks a two-step extrusion in the deep shade of its hue, an `out` outline and a two-step `drop` hard shadow (none of them blurred). Screen readers read one complete copy of the text (`.sr-only-text`). The `start` prop sets the hue of the first letter; adjacent headings on the same page start on different colors.

Use it on page titles and section headings and nowhere else; at most two per viewport.

---

## 4. Layout

- **Container**: `.wrap`, max width 1160px, horizontal padding `clamp(1.25rem, 4vw, 2.5rem)`.
- **Navigation**: sticky, 3.6rem tall, background `rgba(20,14,34,.92)`, with `0 3px 0 drop` along the bottom plus a 3px marquee strip (`.marquee`, five colors, 18px per segment). Left: the mark + the "MicroTS" wordmark (Fredoka 600 1.34rem) + a "by PocketJS" badge. Right: Docs, Playground, the Family dropdown and the GitHub icon key. The key for the current page is pink.
- **Family dropdown**: a panel with a 3px lilac border listing Pocket Nexus, PocketJS, Pocket3D, Pocket Studio and Pocket Retro, with the same icons as pocket.nexus. The Pocket3D icon is `/pocket3d-mark.svg`, which `build.ts` copies from `site/pocket3d/mark.svg`.
- **Footer**: `floor` background with a 14px candy-brick floor along the top edge (`.candy-floor`); links in Fredoka 600, separated by pink dots; the last line, in monospace, names the pocketjs commit the site was built from (`built from pocketjs@<commit>`).
- **Section spacing**: `clamp(2.6rem, 6.5vw, 4.2rem)` above and below.
- **Section heading** `SectionHead`: candy text + a twinkling pixel star at the top right + a row of pellets fading out to the right (a power pellet in front), followed by the lead paragraph.
- **Corner radii**: pills 999px; arcade buttons 14px; panels 22px (18px at ≤620px); inner screens 14px; keys and labels 9–10px; hero plate 26px.
- **Docs page**: three columns `250px | body | 210px`. The left column is a sticky table of contents with group titles in `pink-l` and a yellow background on the current item; the body is at most 52rem wide; the right column, "On this page", lists h2 headings and highlights the one in view as the page scrolls (shown at ≥1280px). Below 1024px the table of contents moves into a `<details>` at the top. Previous/next cards sit at the bottom.
- **Playground**: the start page is an ordinary page; the workspace fills the viewport height in two columns, `editor | stage`, with no persistent preset list (see section 7).
- **Margins on full-width pages**: the workspace spans the whole window, and on workspace pages the nav bar is full width as well (`w-full px-4`) instead of the centered `.wrap`. The nav bar, workspace toolbar, editor tab bar and stage share a 16px margin: the logo, Browse and the first file tab align left; the nav keys, Run and the preview panel align right. When toolbar buttons wrap, they stay right-aligned.

---

## 5. Components

All component classes are defined in `@layer components` in `src/styles/main.css`.

| Class / component | Appearance | Use |
|---|---|---|
| `.key` | 2.3rem tall, `key` background, 2px translucent outline, `0 3px 0 drop`; yellow on hover, sinks 3px when pressed | Nav keys |
| `.key-ico` | Square `.key`; turns cyan and rotates -8° on hover | Icon keys |
| `.btn` | Press Start 2P .74rem, 2.5px `out` outline, `0 5px 0 drop` + inner highlight; rises 2px on hover, sinks 4px when pressed | Home page action buttons |
| `.btn-primary` | Yellow gradient + yellow glow | The main action, at most one per screen |
| `.btn-heart` | A pink pixel heart in front of the label | GitHub button |
| `.tool` / `.tool-go` | Fredoka .88rem small key; takes the current hue when `aria-pressed` | Playground toolbar |
| Native `<select>` | Looks like `.tool`, but **does not use the `.tool` class and has no transitions**; hover changes the border color and nothing else | Dropdowns such as the screen size. While a dropdown is open, Firefox listens for `transitionend` on the `<select>` and rebuilds the popup menu each time a transition on `color`, `background-color` or a similar property ends (`toolkit/actors/SelectChild.sys.mjs`), which swallows a click in progress |
| `.chip` | 38px pill | Family navigation links |
| `.tag` | Pill label on a hue background | Frame rate, framework name |
| `.badge` | Small square tag with a 2px outline | Secondary metadata (line count, version) |
| `.label` | Small plate on a hue background with an inner highlight | Panel titles, status |
| `.kicker` | Uppercase monospace + a color block | Attribution line above a main title |
| `.shell` | 3px hue border, hue gradient at the top, bottom lip `0 6px 0 hue-d` | Content panel (the "handheld shell") |
| `.shell-flat` | `out` outline, `drop` bottom lip | Neutral panel |
| `.card-hover` | Rises 4px and rotates -0.5° on hover | Clickable cards |
| `.screen` | `screen` background, fine scan texture, inset shadow | Code screens, preview screens |
| `.scanlines` | Overlay of dark scanlines, one every 4px | Game screens |
| `.plate` | Dark glass plate with a 4px hue border | Home page main title |
| `.bulbs` | Row of small bulbs in four colors (yellow, pink, cyan, lilac) with gaps between them | Marquee along the bottom of the plate |
| `.spark` / `.heart` | Pixel sprites drawn through a mask: the spark in the current hue, the heart in pink | Decoration, list markers |
| `CodeTabs` | Code panel with arcade keys as tabs (pre-rendered with Shiki) | Home page code samples |
| `.doc` | Docs body typography: cyan links, yellow inline code, pink square list bullets, lilac-bordered tables | Rendered Markdown |
| `.code-block` | Shiki screen with a 3px translucent cyan border | Docs code blocks |

**Code highlighting** uses Shiki `one-dark-pro` for all code (the same theme as the PocketJS docs and the playground editor) and is rendered at build time. The editor is CodeMirror 6 with the one-dark theme, the background changed to `screen`, and a yellow cursor and selection.

**Handheld shell** (right side of the home page): lilac body, `shade` screen bezel, `out` D-pad, pink/yellow A and B buttons. The screen cycles through Pocket Retro game screenshots (the posters at `/retro/<id>/poster.png`, `image-rendering: pixelated`), and the whole device is a link to the matching playground preset.

---

## 6. Motion

- Every pixel animation uses `steps()`: headings drop in letter by letter with `drop-in .45s steps(3,end)`, 40ms apart; on section hover the letters `hop` one after another; pixel stars `twinkle 2.4s steps(1)`; bulbs `1.2s steps(1)`; status lights `blink 1.1s steps(1)`.
- Spring easing: `--ease-spring cubic-bezier(.3,1.6,.5,1)`; button rebound `cubic-bezier(.28,2.2,.45,1)`; press `.08s ease-out`.
- Hover: rise 2–4px, and may add a tilt between -0.5° and -8°.
- Under `prefers-reduced-motion: reduce`, all transitions, animations and the home page screenshot carousel are off.

---

## 7. Playground

### 7.1 Start page and workspace

The playground has two layers: **the starting point is chosen once**, and after that the workspace shows no persistent list.

| Page | Route | Content |
|---|---|---|
| Start page | `/playground` | An ordinary page (with footer). In order: **New project** (three template cards), **Your projects** (local projects, shown when there are any), **Examples** (MicroTS app cards + a grid of Pocket Retro game covers) |
| Example workspace | `/playground/<preset>` | Opens an example; edits are saved as a draft, with Reset and **Copy to project** |
| Project workspace | `/playground/p/<id>` | Opens a local project; files can be added, renamed and deleted, and the project can be renamed |
| New | `/playground/new/<vue\|solid\|retro>` | Creates a project from a template, then goes to the project workspace (without a history entry) |
| Import | `/playground/import#s=…` | Opens a project someone shared and imports it as a new local project |

Template card hues: Vue SFC app cyan, Solid TSX app lilac, Pocket Retro game pink. A card lists the files in its template (main file first, entry last); the whole card is the link that creates the project, and the `+` in the top right corner rotates on hover.

The workspace fills the viewport height in two columns: `editor | stage (≥420px, 46%)`. On narrow screens the columns stack into one, with the preview first.

The leftmost toolbar item is **Browse** (a four-square icon). It opens an overlay (a native `<dialog>` with a 3px lilac border, a `lilac-d` bottom lip and a translucent blurred backdrop) with the same content as the start page in a tighter layout: small headings instead of candy text, 8 retro covers per row, and the example or project that is open marked with a yellow border and an `open` tag. Opening the overlay does not leave the workspace, and the editor and preview keep running. Esc, a click on the backdrop or Close dismisses it; selecting a new starting point is the one action that switches the workspace. Deleting the current project from the overlay returns to the start page.

### 7.2 Two preview paths

| Content | Preview | Visuals |
|---|---|---|
| MicroTS apps (Vue SFC, Solid TSX) | Compiled in the browser (`/pocket/compiler-worker.js`, bundled from this checkout by `lib/kit.ts`) and rendered in a same-origin iframe by `pocketjs.wasm` (the Rust UI core + software rasterizer) | Cyan shell; the status line shows resolution, frame rate, wasm memory, compile time, style count and pak size |
| Pocket Retro games | Sucrase strips the types, and the game runs as JavaScript in a Web Worker (relative imports inside the project resolve as CommonJS); the main thread draws the palette screen to a canvas, and an AudioWorklet synthesizes four channels | Pink shell; the status line shows resolution, frame rate and time per frame; the image is `pixelated` |

Neither path compiles Rust. The start page lead and the bottom of the stage both say so and link to the execution modes in TypeScript support. New retro projects have no baked assets (the image bank and tilemaps are empty; sounds are defined with `sound.set()`); projects copied from an example keep the example's assets, loaded from `/retro/<id>/`.

### 7.3 Structure and states

- Toolbar: Browse + title + framework tag. A project carries a `project` badge, and its title can be clicked to rename it; an example with changes carries an `edited` badge. On the right: Auto-run, Reset and Copy to project (examples), Share, and the yellow Run (⌘/Ctrl+Enter).
- Editor tabs: monospace, current file in yellow. In an example, a changed file has a pink dot after its name. In a project, the current file (except the entry) shows `×` to delete it, a double click renames, and a `+` at the end creates a file. File names are typed inline in the tab bar; an invalid name shows a one-line pink hint below the tab bar (the template sets the allowed extensions: Vue `.vue/.ts`, Solid `.tsx/.ts`, retro `.ts`). Entry files (`main.ts`, `main.tsx`, `game.ts`) cannot be renamed or deleted.
- Stage: from top to bottom the right column holds the status line (`.label` showing Idle / Compiling / Loading / Running / Paused / Error, with a blinking green dot while running; the device dropdown, or the size from the retro `system.init`; Pause / Sound / Restart), the device shape, the key hints and run data, and the Console / About panel at the bottom. **In a normal-size window the screen and every control must fit in the viewport, and the page does not scroll**: the device shape scales as a whole, keeping its proportions, to the space left in the right column (at most 2×), and when the window is less than 780px tall the bottom panel starts collapsed. While compiling and loading, the screen is covered by `COMPILING` / `LOADING` in Press Start 2P. The scale factor is not displayed.
- Screen size: top right of the stage. For UI previews it is a dropdown; the presets come from `app.viewport.fixed.logical` in the `pocket.json` of the PocketJS example apps (`apps/*/pocket.json`): PSP 480×272, GBA 240×160, 3DS top screen 400×240, iPhone 2G/4S 320×480, iPod touch 320×568, BlackBerry Classic 360×360, iPod nano 176×132, Meizu M8 480×720. The last entry, **Custom size…**, expands width and height inputs (32–2048). Retro previews show the current size and the text `system.init`; clicking it jumps to the `system.init()` line in the code. A size larger than the GBA screen (240×160) produces a console warning.
- Screen content: the UI preview canvas fills the device's screen area (whose aspect ratio equals the logical viewport) and scales with nearest-neighbor sampling at 2× and above, with smooth scaling below 2×. The logical viewport sets the layout coordinates and nothing else; `presentation` in `pocket.json` describes how a device maps the logical viewport onto its physical screen. Retro images match Pocket Retro: a game image up to 240 × 160 is scaled by an integer factor and centered in the GBA screen, `pixelated` at every scale.
- A 2px lilac outline (`rgba(169,139,255,.55)`) plus a dark outer ring is drawn around the logical screen, so the screen edge stays visible when the app background is close to the surrounding color. PocketJS Text does not wrap; content that exceeds the logical screen is clipped at this edge. When an example runs at a size other than the one it was designed for, a line in `orange-l` below the screen names the size the example was laid out for.
- Device shapes (`src/playground/devices.ts` + `DeviceFrame.vue`): drawn after the layout of the real device for the selected screen size; key mappings come from the pocketjs device hosts.
  | Device | Layout and input |
  |---|---|
  | GBA | Landscape lilac body; D-pad left of the screen, A / B to the right, L / R on the shoulders, SELECT / START at the bottom left. In UI apps A → ○ and B → × (`hosts/gba`); retro games receive the GBA buttons unmapped |
  | PSP | Landscape oval body; D-pad and analog stick on the left, △○×□ on the right (colored symbols), L / R on the shoulders, SELECT / START below the screen on the right; HOME belongs to the system |
  | 3DS | Clamshell; the top screen is the app's main screen. The lower half has the touch screen (the secondary screen, unused by the preview), the analog stick, the D-pad, ABXY (A → ○, B → ×, X → △, Y → □, `hosts/3ds`) and SELECT / HOME / START |
  | iPhone 2G / 4S, iPod touch, Meizu M8 | Touch screen, no buttons for the app; a tap or drag on the screen is touch input, packed in the pocketjs format together with the hit-test result. The Home button belongs to the system and is drawn for display |
  | BlackBerry Classic | Square touch screen; a navigation key row (Call / ☰ Menu / trackpad / Back / End) and a full keyboard. ☰ → △; a drag on the trackpad produces direction pulses, a tap → ○. On the keyboard, Space (START) and Enter (○) produce input; the other keys do not respond |
  | iPod nano | Pink portrait body; click wheel: a drag along the ring produces one UP / DOWN per 20°, a tap on MENU / ⏮ / ⏭ / ⏯ maps to △ / LEFT / RIGHT / START, and the center button → ○ (`apps/ipod-nano`) |
  | Custom size | A screen border and nothing else; the screen accepts touch |

  The shell uses the device's colors and a hard-shadow bottom lip; keys are dark keycaps that sink when pressed. Parts that belong to the system (Home, HOME, Call, Back, End) are drawn for display and explain why on hover. Device controls do not take keyboard focus when pressed, so the keyboard keeps working after a button click.
- Errors: an error bar with a pink border at the bottom of the editor (phase tag + `file:line` + code frame); clicking it jumps to the line. The editor shows a squiggly underline at the same location, and the console logs one entry. Compiled `.vue` output does not map back to source lines, so these errors show the file name and the message without a line.
- Console: monospace, timestamps in `dim`, warnings in `orange-l`, errors in `#fecaca`.

### 7.4 Behavior

- Auto-run defaults: on for UI (recompiles 600ms after typing stops), off for retro (a rerun restarts the game from `setup()`). Adding, renaming or deleting a file also triggers one run.
- Example edits are saved per example in `localStorage`; Reset restores the original source. A project is saved whole in `localStorage` (written 400ms after typing stops, and on leaving the page); it exists in the current browser and nowhere else, and can be deleted from the start page.
- Share: an example link encodes the changed files (`/playground/<preset>#s=…`); a project link encodes all files (`/playground/import#s=…`, imported as a new project when opened). Both are deflated into the URL hash and never reach a server.
- The screen size is saved with the workspace: for an example it is stored as a separate entry (Reset restores it as well, and a changed size counts as `edited`); for a project it is stored in the project record. Share links and Copy to project carry the size. Changing the size triggers a rerun, and the console notes that a layout written for one size may need adjusting at other sizes.
- Renaming a file does not rewrite imports in other files; the console says so, and a broken import reports an error on the next run.
- Keyboard input reaches the preview once the preview screen has focus, and not before, so the preview and the editor do not compete for the arrow keys. A key pressed and released between two frames is held for the next frame.

---

## 8. Copy

- Site copy is in English, in the same register as the PocketJS docs.
- Follow the documentation rules in the repository's `CLAUDE.md`: state the mechanism directly and bold concrete engineering facts; no slogans, no personification, no empty intensifiers (simply, magic, elegant) and no adverbs modifying a verb.
- Section headings are 1–3 words (One source, How it compiles, Pick a model, Start here).
- Every claim on the home page must be backed by the docs; for example, "The native app runs its view and model without a JavaScript engine" corresponds to the opening of `microts.md`.
- Label the status as it is: the repository `README.md` lists MicroTS as in development, and the home page keeps an `In development` badge next to the hero.
- Credit third-party content with its source and license: retro games name their original authors and link to `/retro/THIRD_PARTY_NOTICES.md`.

---

## 9. Content sources

The site keeps no MicroTS docs of its own, and the games and the preview runtime are build outputs; do not edit the generated files by hand. `bun site/microts/build.ts` produces all of them except the icons, which `bun run microts:icons` writes:

| Content | Source | Generated by |
|---|---|---|
| Docs pages at `/docs/<slug>` | `site/content/docs/<slug>.md` in this repository, the same Markdown the PocketJS site renders (the pages in the MicroTS section of `site/nav.ts`, plus `typescript-support`) | Rendered at build time by the Markdown plugin in `lib/plugins.ts` (`lib/markdown.ts`) |
| Pocket Retro SDK, games and `catalog.json`; assets, posters and licenses served at `/retro/<id>/` and `/retro/` | pocket-retro at the commit pinned in `lib/retro.ts` (`sdk/`, `games/`, baked assets), plus posters rendered by `lib/retro-poster.ts` | `lib/retro.ts` writes `site/microts/.cache/retro/`; `build.ts` copies `.cache/retro/public/` to `/retro/` |
| UI preview kit at `/pocket/`; the MicroTS app examples | The compiler, runtime and `pocketjs.wasm` bundled from this checkout; examples from `apps/vue-sfc-lab` and `apps/solid-aot-lab` | `lib/kit.ts` (`buildKit`) and `bun tools/wasm.ts` |
| Press Start 2P and the Pocket3D mark | `site/assets/fonts/`, `site/pocket3d/mark.svg` | Copied by `copyStatic()` in `build.ts` |
| `favicon.svg`, `favicon.ico`, the apple-touch and manifest PNGs in `public/` | `site/microts/mark.svg` | `bun run microts:icons` (`tools/icons.ts`); the output is committed and `copyStatic()` copies `public/` |

Docs link rewriting (`rewriteHref` in `lib/markdown.ts`): `/docs/<slug>/` links to pages this site renders become in-site routes; all other root-relative links point to pocketjs.pocket.nexus.

---

## 10. Accessibility

- The focus ring is 3px cyan on every element; every clickable element is reachable by keyboard.
- Candy-text headings keep one complete readable copy of the text; the visual letters are `aria-hidden`.
- Body text colors have a contrast of at least 4.5:1 against the ground (`ink-2` and `soft` both meet it); `muted` is reserved for non-essential metadata.
- The game canvas has an `aria-label` stating that it needs focus first.

---

## 11. Don'ts

- No light theme; no gradient text in body areas.
- No 1px hairlines as primary borders; no blurred shadows to express elevation.
- No scanlines outside screens; no pixel font for body text or long sentences.
- No more than one yellow primary button in the same viewport.
- No new hues; when a new accent is needed, pick one of the five candy colors.
