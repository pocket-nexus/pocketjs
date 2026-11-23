# MicroTS site design rules

The MicroTS site belongs to the Pocket family ([pocket.nexus](https://pocket.nexus/), [PocketJS](https://pocketjs.pocket.nexus/), [Pocket3D](https://3d.pocket.nexus/)) and follows the **PocketJS homepage look**: a near-black ground, hairline-ringed rounded cards, soft blurred shadows, Inter Tight headings and Inter body text. The reference for the ground, surfaces, type, borders, shadows, nav and footer is the PocketJS homepage, `site/home.html` and `site/assets/landing.css` in this repository: change the look there first, then carry the change into `src/styles/main.css`. MicroTS keeps **its own mark and its own accent colors** in place of the PocketJS yellow, pink and cyan.

This file describes the visual and interaction rules; the implementation is in `src/styles/main.css` (tokens and component classes) and `src/components/`. Paths that start with `src/` or `lib/` are relative to `site/microts/`; `site/…`, `apps/…` and `programs/…` paths are relative to the repository root.

---

## 1. Principles

1. **Dark theme only.** `color-scheme: dark`, `theme-color #0b0a10`. There is no light theme and no theme switch.
2. **Hairlines and soft shadows.** A raised surface has a 1px ring, `box-shadow: 0 0 0 1px rgba(255,255,255,.08)`, and a large surface (a code panel, a picture frame, a dialog) adds one blurred shadow, `0 40px 80px -40px rgba(0,0,0,.7)`. There are no offset shadows with zero blur and no borders thicker than 1px, except the 3px accent bar on top of a card and the 2px ring that marks a selection.
3. **Type carries the hierarchy.** Section headings are large Inter Tight with negative letter spacing; an uppercase kick label sits above each one. Body text is Inter. Code is the system monospace.
4. **Accents come from the mark.** Color appears in the headline gradient, the hero glows, the primary button, small dots and bars on cards, and links. Surfaces and text are neutral.
5. **State facts.** Copy states mechanisms and numbers, not slogans (see section 8).

---

## 2. Color

### 2.1 Ground and surfaces

| Token | Value | Use |
|---|---|---|
| `bg` | `#0b0a10` | Page ground, nav (at 72% opacity), playground toolbar |
| `bg-2` | `#13111b` | Tab bars, docs table headers, Start here block, Browse dialog |
| `card` | `#17151f` | Cards, toolbar buttons, console panel |
| `screen` | `#0d0c12` | Code panels, code blocks, the editor |
| `line` | `rgba(255,255,255,.08)` | Card rings, dividers, nav and footer rules |
| `line-2` | `rgba(255,255,255,.16)` | Button outlines, badge outlines, hover rings |

### 2.2 Text

| Token | Value | Contrast on `bg` | Use |
|---|---|---|---|
| `ink` | `#f6f3fb` | 18:1 | Headings, emphasis, current navigation item |
| `ink-2` | `#a9a3b8` | 8.1:1 | Body text, lead paragraphs, descriptions |
| `muted` | `#766f8a` | 4.1:1 | Kick labels, metadata, inactive tabs |
| `dim` | `#5a546b` | 2.7:1 | Console timestamps, placeholders, the build line in the footer |

### 2.3 MicroTS accents

The MicroTS mark is a **plum tile in a yellow frame with a cyan italic μ**, and a pink bar over a lilac bar on each side of the μ. `site/microts/mark.svg` is the drawing. `bun run microts:icons` copies it to `public/favicon.svg`, which the favicon and `src/components/MicroTSMark.vue` show, and rasterizes the icon family from it. The pocket.nexus homepage draws the same shapes from one `<symbol id="mts">`, in its Technology menu and its row of technology.

| Hue | Value | Light | Use |
|---|---|---|---|
| cyan (the μ) | `#3fd0e8` | `#b8f2fa` | Primary button, Run, links, focus ring, selection ring, active table-of-contents mark, first stop of the gradient |
| lilac (lower bars) | `#a98bff` | `#dccfff` | Second stop of the gradient, card accents, blockquote rule |
| pink (upper bars) | `#ff5f9e` | `#ffb8d4` | Last stop of the gradient, card accents, errors in the playground |
| yellow (frame) | `#ffd23f` | `#fff0a8` | The `In development` tag, the `edited` badge, one pipeline step |

- **Headline gradient**: `linear-gradient(90deg, cyan, lilac 55%, pink)`, clipped to text (`.grad`). It appears on the second line of the home headline and on the 404 number, and nowhere else.
- **Hero glows** (`.glow`): three radial gradients, cyan at 14%, lilac at 14% and pink at 9% opacity, 720px tall, behind the home hero, the playground start page and the 404 page.
- **Card accents** (`.hue-cyan`, `.hue-lilac`, `.hue-pink`, `.hue-yellow`) set `--hue`, `--hue-l` and `--hue-rgb` for a 3px top bar (`.card-top`), a dot, a step number (`.num`) or a tag (`.tag`) inside one card. Card grids cycle `cyan → lilac → pink → yellow`.
- Text on cyan is `#06222a` (8.9:1).
- Framework dots in code panels use the frameworks' colors: Solid `#4f88c6`, Vue `#42b883`.
- Status colors: success `#34d399`, error `#f87171`, error body text `#fecaca`, warnings `#ffd29a` (`orange-l`).
- Selected text: `rgba(63,208,232,.35)` background. Focus ring: `2px solid cyan`, `outline-offset: 3px`.

---

## 3. Typography

| Role | Typeface | Loading | Use |
|---|---|---|---|
| Display | Inter Tight 600/700/800 | Google Fonts | Headings, card titles, the wordmark, figures |
| Body | Inter 400/500/600 | Google Fonts | Body text, navigation, buttons, labels |
| Code | `ui-monospace, SFMono-Regular, Menlo, monospace` | System | Code, file tabs, paths, metadata lines |

Type scale:

| Class / element | Spec |
|---|---|
| `.h-hero` home headline, 404 | Inter Tight 800 `clamp(48px, 7.2vw, 104px)` / 0.95, letter spacing -0.045em |
| `.h-page` page title (docs, playground) | Inter Tight 800 `clamp(38px, 5vw, 60px)` / 1, -0.04em; docs titles `clamp(34px, 4.2vw, 50px)` / 1.05 |
| `.h-sec` section heading | Inter Tight 700 `clamp(34px, 4.6vw, 58px)` / 1.03, -0.035em |
| `.h-sub` sub-heading | Inter Tight 700 `clamp(24px, 2.4vw, 30px)` / 1.12, -0.025em |
| `.h-card` card title | Inter Tight 700 20px / 1.2, -0.02em |
| `.kick` label above a heading | Inter 600 13px, letter spacing .14em, uppercase, `muted` |
| `.intro` lead paragraph | Inter 18px / 1.6 (17px at ≤640px), `ink-2`, at most 680px wide; `<b>` in `ink` |
| Body | Inter 16px / 1.6; docs body text 1rem / 1.75 |
| Docs h2 / h3 | Inter Tight 700 1.7rem / 1.2 with a 1px rule above; 1.24rem / 1.3 |
| Code | 13px / 1.75 in code panels, 13px / 1.7 in docs blocks, 13px / 1.65 in the editor |
| Inline code | 0.86em monospace, `ink` on `rgba(255,255,255,.07)`, radius 5px |

A section heading is a `kick` label of 1–3 words (One source, How it compiles, Pick a model) above an `h-sec` sentence that states what the section shows. `SectionHead` renders the pair and the lead paragraph; `size="sm"` renders an `h-sub` heading without a label for groups inside a page.

---

## 4. Layout

- **Container**: `.wrap`, max width 1200px, horizontal padding 28px (18px at ≤640px).
- **Navigation**: sticky, 60px tall plus a 1px `line` rule, `rgba(11,10,16,.72)` with a 14px backdrop blur. Left: the mark (28px) + the "MicroTS" wordmark (Inter Tight 700 17px) + a "by PocketJS" badge (from `md`). Right: Docs, Playground and Family as text links in `ink-2` (`ink` for the current section and on hover), then the white GitHub pill (`.pill-white`, hidden at ≤640px).
- **Family menu**: a `card` panel, radius 18px, `line-2` ring and a `0 30px 60px -20px` shadow, listing Pocket Nexus, PocketJS, Pocket3D, Pocket Studio and Pocket Retro with the icons pocket.nexus uses, each on a `bg` tile. The Pocket3D icon is `/pocket3d-mark.svg`, which `build.ts` copies from `site/pocket3d/mark.svg`.
- **Footer**: a 1px `line` rule above, 14px `muted` text: the mark and wordmark, the site links, the copyright line with underlined links, and on its own line, in `dim` monospace, the pocketjs commit the site was built from (`built from pocketjs@<commit>`).
- **Section spacing**: 136px above each home section (96px at ≤640px); 18px gaps in card grids, 14px in dense grids.
- **Corner radii**: buttons and badges 999px; cards 22px; picture frame 20px; docs tables and code blocks 16px; Start here block 32px; toolbar buttons 10px; inner pictures 12–14px.
- **Home page**: the hero is two columns, text and a picture frame of Pocket Retro screenshots, above a three-cell facts row; the sections follow as One source, How it compiles, Pick a model, Made with MicroTS and Start here.
- **Docs page**: three columns `250px | body | 210px`. The left column is a sticky table of contents with `kick` group titles and a `rgba(255,255,255,.08)` background on the current item; the body is at most 52rem wide; the right column, "On this page", lists h2 headings and marks the one in view with a cyan 2px rule as the page scrolls (shown at ≥1280px). Below 1024px the table of contents moves into a sticky blurred `<details>` at the top. Previous/next cards sit at the bottom.
- **Playground**: the start page is an ordinary page; the workspace fills the viewport height in two columns, `editor | stage`, with no persistent preset list (see section 7).
- **Margins on full-width pages**: the workspace spans the whole window, and on workspace pages the nav bar is full width as well (`w-full px-4`) instead of the centered `.wrap`. The nav bar, workspace toolbar, editor tab bar and stage share a 16px margin: the logo, Browse and the first file tab align left; the nav links, Run and the preview panel align right. When toolbar buttons wrap, they stay right-aligned.
- Grid children that hold code or long lines carry `min-width: 0`, so a 390px-wide page does not scroll sideways.

---

## 5. Components

Component classes are defined in `@layer components` in `src/styles/main.css`.

| Class / component | Appearance | Use |
|---|---|---|
| `.btn` | Pill, Inter 600 15px, 13px × 22px padding, 1px `line-2` outline; the outline brightens on hover | Page actions |
| `.btn-pri` | Cyan fill, `#06222a` text | The main action, at most one per screen |
| `.pill-white` | `ink` fill, `bg` text, 14px | GitHub link in the nav |
| `.tool` / `.tool-go` | 2.25rem tall, radius 10px, `card` fill, 1px `line` outline, Inter 600 .84rem; `aria-pressed` turns it `ink` on `bg`; `.tool-go` is cyan | Playground toolbar and picker |
| Native `<select>` | Looks like `.tool`, but **does not use the `.tool` class and has no transitions**; hover changes the border color and nothing else | Dropdowns such as the screen size. While a dropdown is open, Firefox listens for `transitionend` on the `<select>` and rebuilds the popup menu each time a transition on `color`, `background-color` or a similar property ends (`toolkit/actors/SelectChild.sys.mjs`), which swallows a click in progress |
| `.tag` | Pill, `--hue-l` text on `--hue` at 14% | Frame rate, framework name, `open`, `In development` |
| `.badge` | Pill with a 1px `line-2` outline, `ink-2` text | Secondary metadata (line count, file names, version) |
| `.status` | Pill on `card` with a ring: a dot and a word | Playground run state |
| `.kick` | Uppercase label, see section 3 | Above headings and group titles |
| `.num` | A 24 × 3px bar and a number in `--hue`, Inter Tight 700 14px | Compiler pipeline steps |
| `.card` | `card` fill, radius 22px, 1px ring | Content panels |
| `.card-top` | A 3px bar in `--hue` along the top edge of a `.card` | Model modes, playground templates |
| `.card-link` | Ring turns `line-2` and the card rises 2px on hover | Clickable cards |
| `.frame` | Radius 20px, ring + large soft shadow | Hero screenshot frame |
| `.codepanel`, `.codetabs`, `.codetab` | `screen` panel with ring and soft shadow; a `bg-2` tab bar; tabs are monospace 13px, the selected one `ink` on `rgba(255,255,255,.08)`; `.codetab-fw` tabs carry a framework dot | Home page code samples |
| `.screen` | `screen` fill, radius 14px, ring | Code cells in the binding table |
| `CodeTabs` | A code panel (pre-rendered with Shiki); a new tab list returns to the first tab and the top, and `fill` makes the code take the remaining height and scroll; the `head` slot sits above the file tabs and the `actions` slot at the end of them | Home page code samples |
| `SectionHead` | Kick label, heading, lead paragraph | Home sections, playground start page groups |
| `.olink`, `.arrow-link` | Underline in `line-2`, `currentColor` on hover; a 600-weight `ink-2` link with an arrow | Links in copy; "Edit … in the playground →" |
| `.doc` | Docs body typography: cyan links with a 40% underline, neutral inline code, small round `muted` bullets, tables in a ringed `card` with a `bg-2` header | Rendered Markdown |
| `.code-block` | Shiki on `screen`, radius 16px, ring, language name at the top right | Docs code blocks |

**Code highlighting** uses Shiki `one-dark-pro` for all code (the same theme as the PocketJS docs and the playground editor) and is rendered at build time. The editor is CodeMirror 6 with the one-dark theme; the page's theme goes before it in the extension list, so its background is `screen` and its cursor and selection are cyan.

**Hero frame** (right side of the home page): a `.frame` with a 4:3 black picture area cycling through Pocket Retro game screenshots (the posters at `/retro/<id>/poster.png`, `image-rendering: pixelated`) every 2.6 s, and a caption with the game's title, size and author and a row of pager dots (the current one a 16px `ink` bar). The frame is not a link. Below the hero, a facts row in a ringed panel gives three facts from the lead paragraph, their figures in cyan, lilac and pink.

**One source** (home page): the code panel is the first column, and the three build paths stand to its right as cards (below it on narrow screens). The lead paragraph names Solid and Vue and links to their sites. Two framework tabs, Solid then Vue, sit in the panel's `head` slot. Picking one shows that framework's counter, its view file first (`Counter.tsx` or `Counter.vue`), then `Counter.ts`, `gen/counter.rs` and the `src/main.rs` both share (`content/home/counter-solid.md`, `counter-vue.md`, `counter-rust.md`). A link at the right of the framework tabs opens the same counter's playground preset. The view and model files are the playground starters, and both generate the same `gen/counter.rs`. The "Follow one binding" table below gives each binding in Solid TSX and in the Vue template, with one cell across both columns where the two are written the same.

**Made with MicroTS** (home page): the six games from the hero frame are buttons. Picking one gives its card a 2px cyan ring and shows its `game.ts` and a Build tab for that game in the code panel; the page does not navigate. Each game's highlighted source is a separate chunk, loaded on hover, focus or pick, and the panel keeps the previous game on screen under `LOADING` until it arrives. From the `lg` breakpoint the panel takes the height of the card grid and its code scrolls; below it the panel has a fixed height, and a pick scrolls it into view. A link in the panel's tab bar opens the picked game in the playground.

**Start here** (home page): a `bg-2` block with radius 32px and cyan and lilac radial glows in two corners holds the heading, the two actions and the terminal commands (`content/home/start.md`); the docs pages follow as a grid of link cards.

---

## 6. Motion

- Transitions are short and plain: 0.12–0.2s on color, ring and `transform`.
- Hover: a card rises 2px and its ring brightens; a button outline brightens; the `+` on a template card rotates 90°.
- The hero frame crossfades screenshots over 300ms. The running status dot blinks (`1.1s steps(1)`). The Browse dialog opens with a 0.2s rise and fade.
- Under `prefers-reduced-motion: reduce`, all transitions, animations and the hero screenshot carousel are off.

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

Template card accents (the 3px top bar): Vue SFC app cyan, Solid TSX app lilac, Pocket Retro game pink. A card lists the files in its template (main file first, entry last); the whole card is the link that creates the project, and the `+` in the top right corner rotates on hover.

The workspace fills the viewport height in two columns: `editor | stage (≥420px, 46%)`. On narrow screens the columns stack into one, with the preview first.

The leftmost toolbar item is **Browse** (a four-square icon). It opens an overlay (a native `<dialog>` on `bg-2`, radius 24px, with a `line-2` ring, a large soft shadow and a translucent blurred backdrop) with the same content as the start page in a tighter layout: card-title headings instead of section headings, 8 retro covers per row, and the example or project that is open marked with a 2px cyan ring and an `open` tag. Opening the overlay does not leave the workspace, and the editor and preview keep running. Esc, a click on the backdrop or Close dismisses it; selecting a new starting point is the one action that switches the workspace. Deleting the current project from the overlay returns to the start page.

### 7.2 Two preview paths

| Content | Preview | Visuals |
|---|---|---|
| MicroTS apps (Vue SFC, Solid TSX) | Compiled in the browser (`/pocket/compiler-worker.js`, bundled from this checkout by `lib/kit.ts`) and rendered in a same-origin iframe by `pocketjs.wasm` (the Rust UI core + software rasterizer) | Cyan accent; the status line shows resolution, frame rate, wasm memory, compile time, style count and pak size |
| Pocket Retro games | Sucrase strips the types, and the game runs as JavaScript in a Web Worker (relative imports inside the project resolve as CommonJS); the main thread draws the palette screen to a canvas, and an AudioWorklet synthesizes four channels | Pink accent; the status line shows resolution, frame rate and time per frame; the image is `pixelated` |

Neither path compiles Rust. The start page lead and the bottom of the stage both say so and link to the execution modes in TypeScript support. New retro projects have no baked assets (the image bank and tilemaps are empty; sounds are defined with `sound.set()`); projects copied from an example keep the example's assets, loaded from `/retro/<id>/`.

### 7.3 Structure and states

- Toolbar: Browse + title + framework tag. A project carries a `project` badge, and its title can be clicked to rename it; an example with changes carries an `edited` badge. On the right: Auto-run, Reset and Copy to project (examples), Share, and the yellow Run (⌘/Ctrl+Enter).
- Editor tabs: monospace, current file in `ink` on `screen` with a 2px top edge in the accent (cyan for UI, pink for retro). In an example, a changed file has a pink dot after its name. In a project, the current file (except the entry) shows `×` to delete it, a double click renames, and a `+` at the end creates a file. File names are typed inline in the tab bar; an invalid name shows a one-line pink hint below the tab bar (the template sets the allowed extensions: Vue `.vue/.ts`, Solid `.tsx/.ts`, retro `.ts`). Entry files (`main.ts`, `main.tsx`, `game.ts`) cannot be renamed or deleted.
- Stage: from top to bottom the right column holds the status line (`.status` showing Idle / Compiling / Loading / Running / Paused / Error, with a blinking green dot while running; the device dropdown, or the size from the retro `system.init`; Pause / Sound / Restart), the device shape, the key hints and run data, and the Console / About panel at the bottom. **In a normal-size window the screen and every control must fit in the viewport, and the page does not scroll**: the device scales as a whole, keeping its proportions, to the space left in the right column (the screen at most twice its logical size), and when the window is less than 780px tall the bottom panel starts collapsed. While compiling and loading, the screen is covered by `COMPILING` / `LOADING` in uppercase monospace. The scale factor is not displayed.
- Screen size: top right of the stage. For UI previews it is a dropdown; the presets come from `app.viewport.fixed.logical` in the host configs of the PocketJS example apps (`apps/*/pocket.host.config.ts`): PSP 480×272, GBA 240×160, 3DS top screen 400×240, iPod touch 320×568, iPod nano 176×132. The last entry, **Custom size…**, expands width and height inputs (32–2048). Retro previews show the current size and the text `system.init`; clicking it jumps to the `system.init()` line in the code. A size larger than the GBA screen (240×160) produces a console warning.
- Screen content: the UI preview canvas fills the largest box with the logical viewport's aspect ratio inside the device's screen, in its middle, and scales with nearest-neighbor sampling at 2× and above, with smooth scaling below 2×. The logical viewport sets the layout coordinates and nothing else; `presentation` in the app's `viewport` describes how a device maps the logical viewport onto its physical screen. Retro images match Pocket Retro: a game image up to 240 × 160 is scaled by an integer factor and centered in the GBA screen, `pixelated` at every scale.
- The logical screen sits in the device's dark glass, with no outline of its own. PocketJS Text does not wrap; content that exceeds the logical screen is clipped at its edge. When an example runs at a size other than the one it was designed for, a line in `orange-l` below the screen names the size the example was laid out for.
- Devices (`src/playground/devices.ts` + `DeviceFrame.vue`): **a picture of the real device from the front**, rendered in Blender from a 3D model, with the screen where the picture's screen is. The pictures and their profiles (where the screen, each key and each moving part are, in the picture's pixels) come from `tools/handheld-shells.ts`, and reach the app as `microts:shells` (`lib/shells.ts`); the PSP and the 3DS are the Pocket3D player's, the others are in `shells/`. `devices.ts` holds what each key is to an app; key mappings come from the pocketjs device hosts.
  | Device | Picture | Layout and input |
  |---|---|---|
  | GBA | LightningGrey's model (CC BY 4.0), its case recoloured indigo | D-pad left of the screen, A / B to the right, SELECT / START at the bottom left, L / R on the top corners. In UI apps A → ○ and B → × (`programs/gba`); retro games receive the GBA buttons unmapped |
  | PSP | Dibad's model (CC BY 4.0) | D-pad and analog nub on the left, △○×□ on the right, L / R on the shoulders, SELECT / START below the screen on the right. The nub does not respond |
  | 3DS | PocketJS's New 3DS model, lid flat | The top screen is the app's main screen; the touch screen below is the secondary screen, unused by the preview, and says so on hover. Circle pad, D-pad, ABXY (A → ○, B → ×, X → △, Y → □, `platforms/3ds/input.c`), SELECT / START; L and R are behind the hinge, so their letters stand at its ends |
  | iPod touch | thethieme's white iPhone 5 (CC BY 4.0), without the earpiece and sensor an iPod touch lacks | Touch screen input; Home belongs to the system |
  | iPod nano | PocketJS's iPod nano model, pink | Click wheel: a drag along the ring produces one UP / DOWN per 20°, a tap on MENU / ⏮ / ⏭ / ⏯ maps to △ / LEFT / RIGHT / START, and the center button → ○ (`apps/ipod-nano`) |
  | Custom size | None | A plain dark bezel about the screen; the screen accepts touch |

  The picture is the case with its moving keys taken out, and a sheet of those keys lies over it: a held key goes down into its socket and darkens, a shoulder key goes in from its edge, a moulded D-pad leans toward the arm that is held. A key printed on the face (the GBA's L and R) lights up while held. The places that take a pointer are invisible and a fifth larger than the key each way; the D-pad is one place, read in eight directions. Device controls do not take keyboard focus when pressed, so the keyboard keeps working after a button click. No picture carries a maker's name or logo: `tools/handheld-models/shells.py` takes those pieces out of the model or paints them over, and `shells/ATTRIBUTION.md` credits every model.
- Errors: an error bar with a pink rule above it at the bottom of the editor (phase tag + `file:line` + code frame); clicking it jumps to the line. The editor shows a squiggly underline at the same location, and the console logs one entry. Compiled `.vue` output does not map back to source lines, so these errors show the file name and the message without a line.
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
- Kick labels are 1–3 words (One source, How it compiles, Pick a model, Start here); the heading under a label is one sentence that the section's content backs.
- Every claim on the home page must be backed by the docs; for example, "The native app runs its view and model without a JavaScript engine" corresponds to the opening of `microts.md`.
- Label the status as it is: the repository `README.md` lists MicroTS as in development, and the home page keeps an `In development` tag above the hero headline.
- Credit third-party content with its source and license: retro games name their original authors and link to `/retro/THIRD_PARTY_NOTICES.md`.

---

## 9. Content sources

The site keeps no MicroTS docs of its own, and the games and the preview runtime are build outputs; do not edit the generated files by hand. `bun site/microts/build.ts` produces all of them except the icons, which `bun run microts:icons` writes:

| Content | Source | Generated by |
|---|---|---|
| Docs pages at `/docs/<slug>` | `site/content/docs/<slug>.md` in this repository, the same Markdown the PocketJS site renders (the pages in the MicroTS section of `site/nav.ts`, plus `typescript-support`) | Rendered at build time by the Markdown plugin in `lib/plugins.ts` (`lib/markdown.ts`) |
| Pocket Retro SDK, games and `catalog.json`; assets, posters and licenses served at `/retro/<id>/` and `/retro/` | pocket-retro at the commit pinned in `lib/retro.ts` (`sdk/`, `games/`, baked assets), plus posters rendered by `lib/retro-poster.ts` | `lib/retro.ts` writes `site/microts/.cache/retro/`; `build.ts` copies `.cache/retro/public/` to `/retro/` |
| UI preview kit at `/pocket/`; the MicroTS app examples | The compiler, runtime and `pocketjs.wasm` bundled from this checkout; examples from `apps/vue-sfc-lab` and `apps/solid-aot-lab` | `lib/kit.ts` (`buildKit`) and `bun tools/wasm.ts` |
| The Pocket3D mark | `site/pocket3d/mark.svg` | Copied by `copyStatic()` in `build.ts` |
| `favicon.svg`, `favicon.ico`, the apple-touch and manifest PNGs in `public/` | `site/microts/mark.svg` | `bun run microts:icons` (`tools/icons.ts`); the output is committed and `copyStatic()` copies `public/` |

Docs link rewriting (`rewriteHref` in `lib/markdown.ts`): `/docs/<slug>/` links to pages this site renders become in-site routes; all other root-relative links point to pocketjs.pocket.nexus.

---

## 10. Accessibility

- The focus ring is 2px cyan on every element; every clickable element is reachable by keyboard.
- Body text uses `ink` or `ink-2` (8.1:1 against the ground); `muted` (4.1:1) is reserved for uppercase labels and metadata, and `dim` for text that repeats information shown elsewhere.
- Headings are real text in one element; the gradient line of the home headline is a `<span>` inside the `<h1>`.
- The game canvas has an `aria-label` stating that it needs focus first.

---

## 11. Don'ts

- No light theme.
- No offset shadows with zero blur, no borders thicker than 1px (except the 3px card accent bar and the 2px selection ring), no dotted dividers.
- No pixel fonts, per-letter colored headings, scanlines or decorative sprites.
- No gradient text outside the home headline and the 404 number.
- No more than one cyan primary button in the same viewport.
- No new hues: accents come from the mark (cyan, lilac, pink, yellow); status colors are for status.
