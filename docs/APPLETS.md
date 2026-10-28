# Pocket Applets

A **Pocket Applet** is a Pocket app that a launcher runs on behalf of the
system: Pocket Shell on the 3DS runs Hacker News, YouTube, X, Discord and
Pocket Nexus as applets. An applet declares the manifest section `applet` and
accepts rules a general app does not, so that one package runs on every
launcher host, the system agent can read and operate it, and a generated
(user- or model-written) applet can be admitted by checks alone. The launcher
itself is an app, not an applet: it pairs, installs and switches.

The contract is `contracts/spec/applet.ts`. The rules run in two places:

- **Plan resolution** (`framework/src/manifest/resolve.ts`): the manifest
  rules. A manifest that breaks one does not resolve on any target, so no
  backend builds it.
- **The build** (`tools/build.ts` → `tools/applet-check.ts`): the source rules
  over the applet's import graph and the bundle budgets. A violation fails the
  build after pass 2.

`bun tools/applet-check.ts <pocket.json> [--project-root=<dir>] [--js=<bundle>
--pak=<pak>]` runs every rule outside a build; `checkApplet` is the same check
as a library, which pocket-shell runs over its applets in `bun run check:3ds`.

## The manifest section

```json
"applet": {
  "version": 1,
  "services": ["x", "glyphs"],
  "hosts": ["hacker-news.firebaseio.com"],
  "store": { "maxBytes": 65536 }
}
```

| Field | Meaning |
| --- | --- |
| `version` | **1**. A later version adds rules; a host refuses versions it does not know. |
| `summary` | One sentence on what the applet does, at most **120** characters. The console's store and Pocket Companion's list of applets show it. |
| `services` | Companion services the applet fetches (`companionService(name, path)`, `https://companion.pocket/<name>/…`). At most **8**. Pocket Companion reads this list from the package it offers and answers **403** to a service request from an app it does not offer or whose list lacks the service; the console's runtime, not the guest, names the app in each request. |
| `hosts` | Hosts the applet fetches through `net.http`. At most **8**, bare host names. |
| `store` | Persistent state: required for `data.fs`; `maxBytes` at most **4 MiB**. |

## Manifest rules

| Rule | Reason |
| --- | --- |
| One touch surface that admits **320×240** logical: `app.surfaces.auxiliary` is `fixed` at 320×240, or `adaptive` with a `{min, max}` range holding 320×240; `display.auxiliary` and `input.touch.auxiliary` are required | The surface is the unit every launcher host presents: the 3DS touch screen (320×240), the M5Stack Tab5's portrait panel above its home button (360×592), a browser frame. An adaptive applet reads the size the host chose with `auxiliaryViewport()` (`@pocketjs/framework/display`) and lays out for it. The primary display belongs to the system (the agent's stage on the 3DS). |
| `system.agent` is enhanced | The overlay is added to every applet, so the agent can summon over it, read it and act in it. |
| Capabilities come from an allowlist: text, buttons, left stick, the surface and touch, `net.http`, `ui.physics`, `audio.pcm`, `media.playback`, `data.fs`, `system.agent`, and `camera.*` | Pairing, Wi-Fi, offload workers and launcher control act for the whole console and stay with the launcher. An allowlist, not a denylist: a new capability is unavailable to applets until it is added here. |
| `framework` is `solid`; no `model: "rust"`; no `app.companions` | One UI toolkit the agent's text capture and played input know; no native code; companion work goes through declared services. |
| At most one presentation, the **full screen**: `entry` is `app.entry`, `modality` is `{screens: 1, touch: "none", buttons: true}`, no `surfaces`, no `output`. With it, `app.modality` is `{touch: "auxiliary"}`, `display.auxiliary` and `input.touch.auxiliary` move to `enhances`, and `input.buttons` is required | A device with one screen and no touch (the PSP, 480×272) runs the same program on its whole screen with its buttons. The baseline keeps serving the touch surface on dual-screen hosts. One entry means one program: the layout follows the surface size and the input follows the modality, never a second code path per device. |
| `title` at most **24** characters | The title is the springboard label and the name the agent launches the applet by. |
| `services` or `hosts` need `net.http`; `data.fs` needs `store` | Every destination and every persistent byte is declared before the applet runs. |

## Source rules

`tools/applet-check.ts` walks the import graph from `app.entry`. Comments and
types are removed by Bun's transpiler before any check, so a URL in a comment
does not count.

| Rule | Reason |
| --- | --- |
| Relative imports stay inside the project root | The applet's code is what the package carries; a shared kit (pocket-shell `shells/3ds/ui/`) lives inside the root. |
| Bare imports: `solid-js` and `@pocketjs/framework/*` modules on the applet list; `camera`, `fs` and `db` with their capability | The framework surface is the portability layer. `launcher`, `wifi`, `agent`, `devtools`, `offload` and `config` are system or build modules. |
| No dynamic `import()` | The bundle is the whole program, checked once. |
| No `eval` and no `Function` constructor | A checked applet runs the code that was checked and nothing else. |
| No `installApp`, `removeApp`, `pairCompanion`, `forgetCompanion` or `requestCatalog` from `@pocketjs/framework/link` | Installing, removing and pairing belong to the launcher. |
| Every `companionService("name", …)` names a declared service, with the name as a string literal; every `http(s)://host` names a declared host or a declared service under `companion.pocket` | The declaration is the full list of destinations. |
| The UI draws inside `AppletSurface` (`@pocketjs/framework/applet`) or `AuxiliarySurface` | The applet draws on its surface, not on the system's display. `AppletSurface` mounts on the auxiliary surface when the plan has one and on the full screen otherwise. |

## Bundle budgets

| Output | Budget | Shipped applets (3DS) |
| --- | --- | --- |
| Guest bundle (`<output>.js`) | **640 KiB** | 355 to 400 KiB |
| Pak (`<output>.pak`) | **3 MiB** | 206 KiB (Hacker News) to 2.33 MB (Pocket Nexus) |

## One program on two surfaces

`@pocketjs/framework/applet` gives an applet its surface:

| Export | Value |
| --- | --- |
| `AppletSurface` | Mounts the UI on the auxiliary surface when the plan has one, else on the primary display at its full size |
| `appletViewport()` | The surface's logical `{width, height}`: 320×240 on a 3DS, the adaptive size on a Tab5, 480×272 on a PSP |
| `appletTouch()` | Whether the surface reports contacts |
| `appletOnAuxiliary()` | Whether the UI is on the auxiliary surface |

The surface exists once the app mounts, so an applet reads the size inside
`mount()` and never at module load. On a surface without touch every control
answers a button: the d-pad moves a focus through rows and controls, ○ (A)
activates, × (B) goes back, the shoulders page and switch segments, and the
footer names the buttons that act on the current page.

## What the agent relies on

The agent reads an applet through `ui.captureTexts` (every text run painted in
the app layer, with its box) and acts with taps, drags, button presses and
typing into the system keyboard. An applet stays operable when each control
it offers shows a text label, or a count or name next to its icon, and when
a text field opens the system keyboard. These are design rules the checks do
not enforce; the sim tests of each applet drive it by its texts
(`tapText`), the way the agent does.
