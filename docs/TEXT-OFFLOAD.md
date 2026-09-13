# Experimental portable text service

`text.layout.offload` executes text capabilities in a provider worker through
`io.offload`. Declare both capabilities in a Pocket v2 manifest. A supported
host profile admits this transport path; execution additionally requires a
positive session and provider-supplied fonts. An absent companion is a visible
unavailable state, with no synchronous layout fallback.

## Application API

```ts
import { createTextLayout } from "@pocketjs/framework/text-layout";

const document = createTextLayout(state => {
  if (state.status === "ready") {
    // Each row addresses one logical source line using UTF-16 from/to offsets.
    // Retain the source snapshot belonging to state.revision with its geometry.
    present(state.revision, state.rows);
  }
});
document.update("hello\nworld", { slot: 1, width: 240 });
// document.dispose() when the component is destroyed.
```

The framework pump uploads chunks and validates result pages at frame
boundaries. New revisions cancel previous delivery. Provider revision fences,
transport epochs and reconnect upload prevent stale results from becoming
current geometry. Pending input can continue updating while rendering retains
the last accepted snapshot. Applications should coalesce fast edits to avoid
starving completed snapshots.

## Execution and transport ownership

- `engine/crates/pocket-text`: one Rust engine for native and WASM execution.
  Atlas wrapping uses the same package metrics as the Rust UI renderer.
  COSMIC Text / Harfrust / Swash provide advanced shaping and rasterization.
  The font database starts empty. Hosts explicitly load `ui:font.*` atlases,
  `text:font.*` package entries or provider-side font bytes; no system font
  discovery or platform text API is involved.
- `pocket-ui-surface::offload::OffloadWorker`: generic bounded worker channels;
  handler initialization and requests execute off the native runtime thread.
  Native window presentation uses winit/softbuffer; guest layout and the shared
  `engine/core/src/compositor.rs` software painter run on a runtime worker.
- Web: `text-worker.js` instantiates the same Rust WASM engine. AppInstance
  lifecycle owns its worker and bounded credits. Ordinary browser rendering
  retains the existing iframe/WASM scheduler.
- PSP: fixed-buffer PSPLINK host0 mailbox transport. The lower-priority worker
  touches neither the allocator nor QuickJS, Ui or GE. Text execution requires
  a paired companion; the device never links the text engine.

The JSON protocol uses the existing `OffloadRequest` / `OffloadReply` envelope.
Methods are `text.capabilities`, `text.replace`, `text.edit`, `text.open`, `text.append`, `text.layout`,
`text.close`, `text.shape` and `text.raster`. Requests accept no guest paths or
URLs. Every provider instance is scoped to a package/connection and loads its
fonts before advertising readiness.

Budgets: 4096 UTF-8 bytes per record; 2500 UTF-16 units per payload (Rust results
also at most 2500 UTF-8 bytes); eight outstanding requests/documents; one reply
delivered per frame; 65536 UTF-16 units per document; at most 512 units per upload
chunk, reduced when JSON escaping requires it; inline replacements/edits accept
up to 2048 units within the same wire budget; 4096 visual rows; 32 rows per
page. OpenType requests accept 512 units and shape pages contain up to 24
glyph clusters. Raster tiles are at most 448 by 16 pixels, packed as 2-bit
coverage compatible with optional `offload.uploadCoverage`.

## Build and pair

```sh
bun tools/text-wasm.ts
bun tools/pocket.ts build --target psp --manifest apps/text-offload/pocket.json --project-root . -- --release
bun tools/text-provider.ts --usb /path/to/psplink-host0-root \
  --app dev.pocket-stack.text-offload --pak dist/text-offload-main.pak
```

The explicit local PSPLINK share is the USB pairing grant. It is scoped by a
hash of the app ID; heartbeat, epoch, device boot ID and sequence reject old
files. Keep the host0 root private. The adapter also validates packet lengths,
hashes and bounded queues. The standalone Solid demo continues its frame counter
before pairing and displays companion-produced lines when connected.

On devices with the existing authenticated LAN transport:

```sh
bun tools/text-provider.ts --address DEVICE_IP --key-file /path/to/key \
  --pak /path/to/app.pak --font /path/to/font.ttf
```

The existing 256-bit pairing key authenticates LAN sessions. The provider
executes capability handlers in a real Worker in both modes. `--font` is optional
and exposes only explicitly supplied OpenType families. Shaping support does
not automatically replace an application's baked theme text rendering.

This is an experimental framework implementation. PSP release compilation and
host-side companion tests are distinct from physical-device pairing and latency
acceptance. CPU rasterization has no GPU acceleration or platform font fallback.

## Interactive latency

The client retains only an acknowledged provider revision as an edit base.
`text.edit` transmits a UTF-16 replacement range plus inserted text; font/width
changes reuse resident text. `text.replace` handles bounded initial snapshots.
Both execute and return the first result page in one worker job. Large initial
uploads keep bounded chunks, with the final append returning the first page.
Canceled in-flight mutations invalidate the edit base; reconnect uploads a fresh
snapshot. Every path retains the same transport credits and one delivery/frame.

Reproduce the native QuickJS/worker/frame-boundary latency measurement:

```sh
bun tools/text-latency.ts --pak dist/text-offload-main.pak --slot 1
```

The harness runs the real `OffloadWorker` and Rust `Engine` at 60 Hz, reporting
accepted-layout time, frames, request count and worker compute time. It excludes
window rendering and OS input delivery. Larger documents still incur bounded
result pagination and initial upload latency; no synchronous fallback is used.
