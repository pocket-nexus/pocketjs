# Pocket Applets

A **Pocket Applet** is a Pocket app that a launcher runs on behalf of the
system: Pocket Shell on the M5Stack Tab5 and the Nintendo 3DS runs Hacker
News, GitHub, X, YouTube, Discord, Notes and the other applets of
[pocket-nexus/applets](https://github.com/pocket-nexus/applets), and Omarchy
Pocket runs them in windows. An applet declares the app contract section
`applet` and accepts rules a general app does not, so that one package runs
on every launcher host, the system agent can read and operate it, and a
generated (user- or model-written) applet can be admitted by checks alone. The launcher
itself is an app, not an applet: it pairs, installs and switches.

The contract is `contracts/spec/applet.ts`. The rules run in two places:

- **Plan resolution** (`framework/src/manifest/resolve.ts`): the app contract
  rules. An app contract that breaks one does not resolve on any target, so no
  backend builds it.
- **The build** (`tools/build.ts` → `tools/applet-check.ts`): the source rules
  over the applet's import graph and the bundle budgets. A violation fails the
  build after pass 2.

`bun tools/applet-check.ts <pocket.app.json> [--project-root=<dir>] [--js=<bundle>
--pak=<pak>]` runs every rule outside a build; `checkApplet` is the same check
as a library, which pocket-nexus/applets runs over every applet in `bun run
check` (`test/applets.test.ts`).

## The app contract section

```json
"applet": {
  "version": 1,
  "services": ["x", "glyphs"],
  "store": { "maxBytes": 65536 }
}
```

| Field | Meaning |
| --- | --- |
| `version` | **1**. A later version adds rules; a host refuses versions it does not know. |
| `summary` | One sentence on what the applet does, at most **120** characters. The console's store and Pocket Hub's list of applets show it. |
| `services` | Companion services the applet's worker fetches at `https://companion.pocket/<name>/…` through `io.http`. At most **8**. Pocket Hub reads this list from the package it offers and answers **403** to a service the app does not declare. |
| `hosts` | Host names outside the companion that the applet's worker fetches, at most **16**, each a lower-case DNS name. A host that installs applets from a store (Omarchy Pocket) lists them before an install, and its `http` node refuses any other host to an app the store installed. |
| `store` | Persistent state: required for `data.fs`; `maxBytes` at most **4 MiB**. |

## App contract rules

| Rule | Reason |
| --- | --- |
| One touch surface that admits **320×240** logical: `app.surfaces.auxiliary` is `fixed` at 320×240, or `adaptive` with a `{min, max}` range holding 320×240; `display.auxiliary` and `input.touch.auxiliary` are required | The surface is the unit every launcher host presents: the 3DS touch screen (320×240), the M5Stack Tab5's landscape surface (640×360 logical on its 1280×720 panel), an Omarchy Pocket window, a browser frame. An adaptive applet reads the size the host chose with `auxiliaryViewport()` (`@pocketjs/framework/display`) and lays out for it. The primary display belongs to the system (the agent's stage on the 3DS). |
| `system.agent` is enhanced | The overlay is added to every applet, so the agent can summon over it, read it and act in it. |
| Capabilities come from an allowlist: text, buttons, left stick, the surface and touch, `net.http`, `ui.physics`, `audio.pcm`, `media.playback`, `data.fs`, `system.agent`, and `camera.*` | Pairing, Wi-Fi, offload workers and launcher control act for the whole console and stay with the launcher. An allowlist, not a denylist: a new capability is unavailable to applets until it is added here. |
| `framework` is `solid`; no `model: "rust"`; no `app.companions` | One UI toolkit the agent's text capture and played input know; no native code; companion work goes through declared services. |
| At most one presentation, the **full screen**: `entry` is `app.entry`, `modality` is `{screens: 1, touch: "none", buttons: true}`, no `surfaces`, no `output`. With it, `app.modality` is `{touch: "auxiliary"}`, `display.auxiliary` and `input.touch.auxiliary` move to `enhances`, and `input.buttons` is required | A device with one screen and no touch (the PSP, 480×272) runs the same program on its whole screen with its buttons. The baseline keeps serving the touch surface on dual-screen hosts. One entry means one program: the layout follows the surface size and the input follows the modality, never a second code path per device. The PSP host runs no worker yet, so an applet with `domains.worker` does not resolve for it. |
| `title` at most **24** characters | The title is the springboard label and the name the agent launches the applet by. |
| `services` needs `net.http` | A companion service is an HTTP destination of the applet's worker, and the capability admits the worker's `io.http` resource. |
| `data.fs` needs `store` | Every persistent byte is declared before the applet runs. |

## The applet's worker

An applet's UI realm has no network. **HTTP is the `io.http` resource of the
worker its app contract declares** (`domains.worker`, [WORKER.md](WORKER.md)),
with one `http` node: the worker fetches the applet's services at
`https://companion.pocket/<name>/…` and returns each answer to the UI over the
declared channels. The UI publishes and observes those channels with
`@pocketjs/framework/worker/channels`, which the source rules admit when the
app contract declares `net.http`.

```json
"domains": {
  "worker": {
    "entry": "hn/worker.ts",
    "nodes": [{ "name": "http", "kind": "http" }],
    "channels": [
      { "name": "request", "kind": "ring", "direction": "ui-to-worker", "recordBytes": 1024, "capacity": 4 },
      { "name": "response", "kind": "ring", "direction": "worker-to-ui", "recordBytes": "host", "capacity": "host" }
    ]
  }
}
```

The UI drains a ring once a frame, so a ring's records times its bytes is what
reaches the UI per frame. A channel sized `"host"` takes the target's
(`worker.channels` in its host contract), and the worker reads the size it got
from `io.channel(name).recordBytes`.

| Limit | Every host | A host contract may state |
| --- | --- | --- |
| One `io.http` descriptor: URL, method, headers and body as JSON | **1024 bytes** (`WORKER_LIMITS.payloadBytes`) | |
| A channel record; records a ring holds | **1024 bytes**; **8** | `worker.channels`, up to **64 KiB** and **256** |
| One response body | **256 KiB** | `worker.http.responseBytes`; the UI reads it as `platform.httpResponseBytes` |

The source rules walk the UI's import graph from `app.entry`. The worker
bundle (`tools/build-worker.ts`) resolves only the modules whose domain is
`worker`.

## A service's owner setup

A companion service that needs something from its owner declares it as an
`OwnerSetup` (Pocket Hub's `tools/companion/setup.ts`), and **the companion answers
`/_setup` the same way for every service**, so one setup page in an applet
serves any of them. The wire types are `contracts/spec/owner-setup.ts`:

| Kind | What the companion does |
| --- | --- |
| **Field** | A value the owner types once: a key from a vendor's dashboard, an instance URL. Checked against the field's pattern and kept in `<store>/services/<name>/setup.json` (**0600**). `/_setup` answers whether a field is set and never a secret's value. |
| **Vendor tool** | A vendor's own program the service runs, which the companion may not bundle or pass on. It is fetched from the vendor when the owner consents to the vendor's terms (the consent is kept), SHA-256 checked when the spec pins one, unpacked into `<store>/services/<name>/tools/<id>/<digest>/`, and fetched again after `refreshAfterDays`, the old build kept until the new one is in place. A tool consented to and not in place is fetched when the service starts. After a failed fetch the background refresh waits **10 minutes**; a fetch places its build only if the consent it started under still holds. |
| **Prompt** | Something the owner does elsewhere, shown while it waits: confirm a code at a vendor's page (`code`), pick this device in a vendor's app (`pick`). |

| Request | Answer |
| --- | --- |
| `GET /<service>/_setup` | `SetupState`: the fields with `set`, the tools with `state` (`unavailable`, `absent`, `fetching`, `ready`, `failed`), `consented` and the bytes fetched, the prompt, and `ready` |
| `POST /<service>/_setup {field, value}` / `{field, clear: true}` | sets or forgets a field |
| `POST /<service>/_setup {tool, consent: true}` / `{tool, update: true}` / `{tool, remove: true}` | accepts the terms and fetches, fetches again (**400** without the consent), or stops a fetch, deletes the tool and withdraws the consent |

A refused change answers **400** with `{error}`. A service with no setup
answers **404** at `/_setup`. A program a service keeps running (its own
helper, a vendor tool) runs under `Supervised` (Pocket Hub's `tools/companion/supervise.ts`):
started again when it exits after **1 s**, doubling to **30 s**, with its
arguments and environment read at each start. A stop waits for the program
to exit and kills it after **2 s**; a start waits for the run it replaces. It
does not outlive its supervisor: with `pidFile`, a start first stops the run
the file names when that process is the same program, and the supervisor's
exit stops it.

## Source rules

`tools/applet-check.ts` walks the import graph from `app.entry`. Comments and
types are removed by Bun's transpiler before any check, so a URL in a comment
does not count.

| Rule | Reason |
| --- | --- |
| Relative imports stay inside the project root | The applet's code is what the package carries; a shared kit (`ui/` and `kit/` in pocket-nexus/applets) lives inside the root. |
| Bare imports: `solid-js` and `@pocketjs/framework/*` modules on the applet list; `camera` with a `camera.*` capability, `fs` with `data.fs`, `worker/channels` with `net.http` | The framework surface is the portability layer. `launcher`, `wifi`, `agent`, `devtools`, `offload` and `config` are system or build modules. |
| No dynamic `import()` | The bundle is the whole program, checked once. |
| No `eval` and no `Function` constructor | A checked applet runs the code that was checked and nothing else. |
| No `installApp`, `removeApp`, `pairCompanion`, `forgetCompanion` or `requestCatalog` from `@pocketjs/framework/link` | Installing, removing and pairing belong to the launcher. |
| The UI draws inside `AppletSurface` (`@pocketjs/framework/applet`) or `AuxiliarySurface` | The applet draws on its surface, not on the system's display. `AppletSurface` mounts on the auxiliary surface when the plan has one and on the full screen otherwise. |

## Bundle budgets

| Output | Budget | 3DS builds |
| --- | --- | --- |
| Guest bundle (`<output>.js`) | **640 KiB** | 315 KiB (Camera) to 502 KiB (GitHub), built with PocketJS 0.16.0 |
| Pak (`<output>.pak`) | **3 MiB** | 174 KiB (Camera) to 479 KiB (Notes), built with PocketJS 0.16.0; 2.33 MB for Pocket Nexus (`apps/nexus`) |

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
