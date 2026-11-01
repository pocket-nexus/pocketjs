# Pocket Applets

**A Pocket Applet is a Pocket app that a launcher runs on behalf of the
system.** Pocket Home runs Hacker News, X, YouTube, Discord and Notes as
applets, and a launcher is an app that pairs, installs and switches between
them. An applet declares the `applet` section of the
[app contract](/docs/app-contract/) and accepts rules a general app does not.

The rules exist for three reasons:

- **One source runs on every launcher host.** An applet draws on one touch
  surface that admits **320×240** and lays itself out by the size it is given.
- **The system agent can read and operate it.** The UI is Solid on the PocketJS
  components, so the agent's text capture and played input reach every control.
- **A generated applet is admitted by checks alone.** A person or a model can
  write one, and the build proves what it may touch.

## Where applets run

An applet runs in a QuickJS guest on the PocketJS runtime. Its size limits are
small enough for a **microcontroller**: the same applet source runs on a Tab5's
ESP32-P4 and on a handheld's screen.

| Host | Processor | Surface |
| --- | --- | --- |
| M5Stack Tab5 | **ESP32-P4 microcontroller** | Adaptive, 640×360 logical on a 1280×720 panel |
| Nintendo 3DS | ARM11 | 320×240 touch screen |
| PSP | MIPS R4000 | 480×272, full screen, read by the d-pad |

The [ESP-IDF](/docs/esp-idf/) page describes the components the Tab5's firmware
is built from.

## The app contract section

```json
"applet": {
  "version": 1,
  "summary": "Your timeline, on a small screen.",
  "services": ["x", "glyphs"],
  "store": { "maxBytes": 65536 }
}
```

| Field | Meaning |
| --- | --- |
| `version` | **1**. A host refuses a version it does not know. |
| `summary` | One sentence of at most **120** characters, shown where the applet is offered. |
| `services` | Companion services the applet's worker fetches over `net.http`, at most **8**. A service the applet does not list answers **403**. |
| `store` | Persistent state, required for `data.fs`. `maxBytes` is at most **4 MiB**. |

## What an applet accepts

The rules run when a plan resolves and again when the build runs, so an applet
that breaks one does not build on any target.

| Rule | Limit |
| --- | --- |
| Guest bundle | **640 KiB** |
| Pak | **3 MiB** |
| Title | **24** characters |
| Framework | `solid`, with no native model and no companions of its own |
| Capabilities | An allowlist: text, buttons, left stick, the surface and touch, `net.http`, `ui.physics`, `audio.pcm`, `media.playback`, `data.fs`, `system.agent`, `camera.*` |
| Imports | `solid-js` and the applet's list of `@pocketjs/framework/*` modules, with relative imports inside the project root |
| Code | No dynamic `import()`, no `eval`, no `Function` constructor |
| Launcher APIs | No installing, removing or pairing: those belong to the launcher |

`bun tools/applet-check.ts <pocket.app.json>` runs every rule outside a build.
The full rules and their reasons are in
[docs/APPLETS.md](https://github.com/pocket-nexus/pocketjs/blob/main/docs/APPLETS.md).

## Drawing on the surface

`@pocketjs/framework/applet` gives an applet its surface:

```tsx
// @title Notes
import { AppletSurface } from "@pocketjs/framework/applet";
import { mount } from "@pocketjs/framework/solid";
import App from "./app.tsx";

mount(() => (
  <AppletSurface>
    <App />
  </AppletSurface>
));
```

| Export | Value |
| --- | --- |
| `AppletSurface` | Mounts the UI on the auxiliary surface when the plan has one, else on the primary display at its full size |
| `appletViewport()` | The surface's logical `{width, height}`: 320×240 on a 3DS, the adaptive size on a Tab5, 480×272 on a PSP |
| `appletTouch()` | Whether the surface reports contacts |
| `appletOnAuxiliary()` | Whether the UI is on the auxiliary surface |

The surface exists once the app mounts, so an applet reads the size inside
`mount()` and never at module load. On a surface without touch every control
answers a button.

## Staying operable by the agent

The agent reads an applet through the text it paints and acts with taps, drags,
button presses and typing into the system keyboard. An applet stays operable
when each control shows a text label, or a count or name next to its icon, and
when a text field opens the system keyboard.
