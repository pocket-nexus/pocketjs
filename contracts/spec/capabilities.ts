// PocketJS capability registry.
//
// A capability id is defined by PocketJS or by a host. POCKET_CAPABILITIES
// lists the ids PocketJS defines: ones a stock host in hosts/ implements and
// tests, or ones the compiler, framework or engine of this repository acts
// on. Register an id only after one of them does. An id names stable, public
// behavior that applications can observe; it does not name hardware,
// permissions, runtime availability, backend implementations, or wire
// formats. Hosts with the same observable semantics share an id; a different
// execution level or guarantee gets a new id.
//
// A host contract may also list ids this registry does not know: the host
// defines them. Resolution against that host accepts them in `app.features`
// and records whether the host provides them; PocketJS attaches no other
// meaning to them (no dependency rule, no compile-time behavior, no engine
// bit). Ids have no namespace: a future PocketJS id avoids a name a product
// already publishes by coordination with that product.

export type CapabilityRegistry = readonly string[];

export function defineCapabilityRegistry<const T extends CapabilityRegistry>(registry: T): T {
  return registry;
}

export type CapabilityId<T extends CapabilityRegistry> = T[number];

export const POCKET_CAPABILITIES = defineCapabilityRegistry([
  "runtime.worker",
  "io.i2c",
  "io.uart",
  "input.analog.left",
  "input.analog.right",
  "input.buttons",
  // Framework-synthesized pointer for targets without a native one: the
  // analog nub steers a screen cursor, hover applies `focus:`, the press
  // button applies `active:` and clicks on release. Opt-in per app
  // (enableCursor + the input.cursor feature in app.features) — d-pad focus traversal
  // remains the portable default interaction.
  "input.cursor",
  // OS text composition: preedit renders inline at the caret with its own
  // cursor, commits arrive as ordinary text insertions, and the host docks
  // the candidate window at the caret rect the app reports. Distinct from
  // input.text — a host can have a keyboard without an IME.
  "input.ime",
  // A REAL absolute pointer (mouse/trackpad): position plus press/drag/
  // release edges, hover resolves focus. The position reaches the app with
  // no button down as well (`pointer()`). A different guarantee than
  // input.cursor's synthesized nub-pointer, hence a different id (see the
  // header rule).
  "input.pointer",
  // Wheel and trackpad scrolling at the pointer: `onScroll` in
  // @pocketjs/framework/input receives each frame's deltas, summed since the
  // previous frame, in logical px of the pointer's surface; positive dx and
  // dy move the view toward the content's right and bottom end, as
  // WheelEvent.deltaX/deltaY. The host converts wheel lines to px and
  // applies the system's scroll direction. In a build whose plan turns the
  // id off, onScroll keeps no handler. Requires input.pointer: a scroll
  // event carries the pointer's surface and position, and the runtime
  // passes no scroll in a frame without a pointer. Registered because the
  // framework acts on it; a host contract lists it when its program fills
  // the pointer's scroll (InputFrameBuilder.scroll, pocket_input_frame.scroll).
  "input.scroll",
  // A hardware text stream: layout-applied characters plus named editing
  // keys (Backspace/Enter/arrows/Home/End/…), key repeat included. The OSK
  // is the fallback spelling on targets without it.
  "input.text",
  "input.touch",
  // Touch contacts whose logical coordinates and hit facts belong to the
  // auxiliary UI surface rather than the primary viewport. Requires
  // display.auxiliary; it does not imply ordinary input.touch.
  "input.touch.auxiliary",
  // 2D bodies stepped by the UI core (ops 52..56, contracts/spec/physics.ts):
  // worlds, anchored jelly bodies, colliders, zones and particle emitters
  // that write paint-only transforms into retained nodes each tick. The wasm
  // core behind the web and sim hosts implements the whole contract, and the
  // 3ds-runtime and ipodtouch4-dev profiles advertise it because their programs
  // bind the five ops (programs/3ds; programs/native/quickjs/pocket_qjs_program.c under
  // POCKET_PHYSICS over programs/native/runtime). A target appends the id to its
  // profile only when its host binds them too.
  "ui.physics",
  // Credit-based s16 PCM streaming through the audio module's own namespace
  // (`globalThis.audio`, contracts/spec/audio.ts). Registered ahead of any
  // stock TARGET advertising it: the web dev host and the sim host implement
  // and test the whole contract, so apps can already declare the enhancement
  // and degrade cleanly where the namespace is absent. A console target
  // appends the id to its profile only when its native host ships the module
  // (the ring/thread discipline to copy is platforms/psp/audio/src/output.rs).
  "audio.pcm",
  // Microphone input on the audio module's namespace (openInput, readInput,
  // closeInput in contracts/spec/audio.ts): the host records one of its
  // inputs into a per-input ring the guest drains each tick.
  "audio.capture",
  // HTTP as a worker resource (`io.http` in @pocketjs/framework/io,
  // engine/worker): bounded streaming requests through the host's transport
  // under the limits of contracts/spec/net.ts. No UI realm has a network
  // namespace.
  "io.offload",
  "net.http",
  // MQTT 3.1.1 and 5.0 sessions as a worker resource (`io.mqtt` in
  // @pocketjs/framework/io, engine/worker): one broker connection per
  // resource, its messages streamed as records under the limits of
  // contracts/spec/mqtt.ts.
  "net.mqtt",
  // A per-app file tree behind the fs module's own namespace
  // (`globalThis.fs`, contracts/spec/fs.ts): nine synchronous ops, every
  // path confined to the app's own data root — apps cannot name, let alone
  // reach, each other's trees. The sim host (platforms/sim/fs.ts) ships the
  // whole contract; a device target appends the id to its profile only when
  // its program compiles the module in.
  "data.fs",
  // Read-only files under the game data root behind the pack module's own
  // namespace (`globalThis.pack`, contracts/spec/pack.ts): six synchronous
  // ops whose reads land in guest-owned buffers and whose loadImg decodes an
  // IMG entry to a texture without passing through the JS heap. The psp
  // program (programs/psp/src/pack_ops.rs) mounts it; the sim
  // (platforms/sim/pack.ts) and the browser (platforms/web/pack.js) implement
  // the whole contract for tests and for hosts that mount them. A target
  // appends the id only when its program compiles the module in.
  "data.pack",
  // Copy/cut/paste round-trips with the OS clipboard.
  "host.clipboard",
  // The logical viewport is runtime-mutable: the app is told about live
  // window resizes and relayouts (framework resizeViewport). Console
  // targets never provide this — their viewport is a platform constant.
  "display.viewport.live",
  // One fixed-size auxiliary UI output presented simultaneously with the
  // primary viewport by the same AppInstance.
  "display.auxiliary",
  "text.glyphs.baked",
  "text.glyphs.streamed",
  // Codepoints outside the baked charset still render: the host extends
  // the font atlases at runtime (system-font rasterization + loadFontAtlas
  // reload). Required by any app that accepts arbitrary text input.
  "text.glyphs.runtime",
  // Text measurement and shaping come from the host text system: full
  // Unicode coverage (CJK/emoji/fallback fonts) with proportional metrics
  // beyond the baked charset, and `measureText` observes the same provider
  // layout does. A different guarantee than text.glyphs.baked — pixels are
  // deterministic per host, not byte-exact across hosts — hence a different
  // id (see the header rule). Apps opt in with `app.features`; a host
  // grants it by installing a core text measurer before the guest mounts
  // (docs/BACKENDS.md).
  "text.layout.native",
  // Asynchronous worker or paired companion service; availability is session scoped.
  "text.layout.offload",
] as const);

export type PocketCapabilityId = CapabilityId<typeof POCKET_CAPABILITIES>;

/** An `app.features` entry: a registered id, which editors complete, or an
 *  id a host contract defines. */
export type FeatureId = PocketCapabilityId | (string & {});

