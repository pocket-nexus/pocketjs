// PocketJS platform capability registry.
//
// Capability ids name stable, public framework behavior that applications can
// observe. Do not name hardware, permissions, runtime availability, backend
// implementations, or wire formats. Register an id only after a stock host
// implements and tests the whole contract. Hosts with the same observable
// semantics share an id; a different execution level or guarantee gets a new
// id.

export type CapabilityRegistry = readonly string[];

export function defineCapabilityRegistry<const T extends CapabilityRegistry>(registry: T): T {
  return registry;
}

export type CapabilityId<T extends CapabilityRegistry> = T[number];

export const PRESENTATION_MODES = ["fill", "fit", "integer-fit", "native", "stretch"] as const;
export type PresentationMode = (typeof PRESENTATION_MODES)[number];
export type Viewport = readonly [width: number, height: number];

/**
 * Shell posture of a target — a semantic FIELD, deliberately not encoded in
 * the target id (ids are labels; nothing may parse them):
 *
 * - "takeover":  the app owns the whole device (consoles, fullscreen).
 * - "window":    an ordinary OS window among others.
 * - "widget":    a small always-on-top ambient surface.
 * - "kiosk":     fullscreen on a host OS, single-purpose installation.
 * - "embedded":  a surface framed inside another runtime (a launcher tile,
 *                a screen mesh in a 3D scene).
 *
 * Forms split into two viewport POLICIES: window/widget viewports are
 * runtime variables (`display.dynamicViewport` required); every other form
 * has a fixed screen (`dynamicViewport` forbidden). Apps declare viewport
 * variants per policy, not per target.
 */
export const TARGET_FORMS = ["takeover", "window", "widget", "kiosk", "embedded"] as const;
export type TargetForm = (typeof TARGET_FORMS)[number];

/** Package execution role used when role-scoped host APIs are admitted. */
export const PACKAGE_ROLES = ["application", "systemUI"] as const;
export type PackageRole = (typeof PACKAGE_ROLES)[number];

/**
 * How an application artifact executes on a device — a semantic FIELD like
 * TargetForm, and the top-level split in admission machinery:
 *
 * - "guest": one portable bundle runs on the embedded JS engine of every
 *   stock host. Admission is the RUNTIME rule this file defines — manifest
 *   `requires` ⊆ target profile `capabilities`.
 * - "aot":   the same source is recompiled natively per device by an AOT
 *   compiler family. There is no hostAbi, no
 *   ops and no runtime capability check; admission is COMPILE-TIME — the
 *   compiler derives the app's demands and checks them against a BOARD
 *   PROFILE (data, not a guest target registry entry).
 *
 * The classes scale differently on purpose: guest targets stay an inventory
 * of real, golden-tested hosts (this registry); aot boards are open-ended
 * data files validated by schema plus a physical verifier, because the MCU
 * cross product (chip × panel × input × RAM) cannot be enumerated here.
 */
export const EXECUTION_CLASSES = ["guest", "aot"] as const;
export type ExecutionClass = (typeof EXECUTION_CLASSES)[number];

/** The forms whose logical viewport is a runtime variable. */
export const DYNAMIC_FORMS: readonly TargetForm[] = ["window", "widget"];

/**
 * What a changed frame costs a target — a semantic FIELD of its display:
 *
 * - "composited": a GPU composes every frame from retained geometry; a prop
 *                 change on any subtree costs the same at the tick rate.
 * - "repaint":    a CPU repaints the pixels a change touched; a frame costs
 *                 in proportion to that area, and the host moves the pixels
 *                 of a translated opaque region instead of repainting them.
 * - "still":      the display shows one change per refresh (electronic
 *                 paper); a tween is its end value.
 *
 * Every profile states its class (`display.animation`); the compiler bakes
 * it into the plan and devices admit packages compiled for their own class.
 */
export const ANIMATION_CLASSES = ["composited", "repaint", "still"] as const;
export type AnimationClass = (typeof ANIMATION_CLASSES)[number];

/** One output as the resolver reads it: the profile surface with its
 *  physical panel size (`panel` in the host contract). */
export interface FixedDisplayProfile {
  readonly physicalViewport: Viewport;
  readonly logicalViewports: readonly Viewport[];
  readonly presentations: readonly PresentationMode[];
  /**
   * Target raster samples per logical pixel for baked text, vectors, masks,
   * and target-selected image variants. This is a rendering contract, not an
   * API capability or a promise that presentation scale has the same value.
   */
  readonly rasterDensity: number;
}

export interface DisplayProfile extends FixedDisplayProfile {
  /**
   * Present exactly when the target's form is dynamic (window/widget): any
   * logical size within [min, max] is admissible, and the host resizes the
   * core live (`display.viewport.live`). `logicalViewports` then lists the
   * DEFAULT size a plan bakes assets for. `acceptsFixed` opts the target
   * into hosting fixed-viewport apps in a size-locked window (an app-form
   * host would set it; a widget shell is not a general app frame and
   * leaves it off).
   */
  readonly dynamicViewport?: {
    readonly min: Viewport;
    readonly max: Viewport;
    readonly acceptsFixed?: boolean;
  };
  /**
   * A simultaneously presented fixed-size UI output owned by the same
   * AppInstance. Present only when the target advertises display.auxiliary.
   * Its raster density matches the primary display until packages can carry
   * per-surface raster asset variants.
   */
  readonly auxiliary?: FixedDisplayProfile;
  /** What a changed frame costs the target (contracts/spec/animation.ts). */
  readonly animation: AnimationClass;
}

/** The resolver's view of a host contract (hosts/contract.ts
 *  `targetProfile`). */
export interface TargetProfile<C extends string = string> {
  /** Presented frames per second the host can drive. */
  readonly cadences: readonly number[];
  /** Generated UI binding generation; all profiles use the shared constant. */
  readonly hostAbi: number;
  /** Device/OS substrate ("psp", "vita", "macos", …). Queryable data — the
   *  target id is only a label. */
  readonly platform: string;
  /** Shell posture (see TARGET_FORMS). */
  readonly form: TargetForm;
  readonly display: DisplayProfile;
  /** Framework APIs implemented and tested by this stock host. */
  readonly capabilities: readonly C[];
  /** APIs exposed only when a package is resolved for a System-owned role. */
  readonly roleCapabilities?: {
    readonly systemUI?: readonly C[];
  };
  /** The host contract this view was made from. A view written directly
   *  (a test registry) has none; the resolver then reads the document's
   *  facts back from the view. */
  readonly source?: import("./profile.ts").PocketProfile<C>;
}

export type TargetRegistry<C extends string = string> = Readonly<Record<string, TargetProfile<C>>>;

export function defineTargetRegistry<
  C extends string,
  const T extends TargetRegistry<C>,
>(registry: T): T {
  return registry;
}

export type TargetId<T extends TargetRegistry> = Extract<keyof T, string>;

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
  // (enableCursor + pocket.app.json requires/enhances) — d-pad focus traversal
  // remains the portable default interaction.
  "input.cursor",
  // OS text composition: preedit renders inline at the caret with its own
  // cursor, commits arrive as ordinary text insertions, and the host docks
  // the candidate window at the caret rect the app reports. Distinct from
  // input.text — a host can have a keyboard without an IME.
  "input.ime",
  // A REAL absolute pointer (mouse/trackpad): position plus press/drag/
  // release edges, hover resolves focus. A different guarantee than
  // input.cursor's synthesized nub-pointer, hence a different id (see the
  // header rule).
  "input.pointer",
  // A hardware text stream: layout-applied characters plus named editing
  // keys (Backspace/Enter/arrows/Home/End/…), key repeat included. The OSK
  // is the fallback spelling on targets without it.
  "input.text",
  "input.touch",
  // Touch contacts whose logical coordinates and hit facts belong to the
  // auxiliary UI surface rather than the primary viewport. Requires
  // display.auxiliary; it does not imply ordinary input.touch.
  "input.touch.auxiliary",
  // A System UI can place installed Pocket applications into native
  // compositor surfaces. This describes the UI API, not the host's internal
  // scheduling implementation.
  "ui.compositor-surfaces",
  // 2D bodies stepped by the UI core (ops 52..56, contracts/spec/physics.ts):
  // worlds, anchored jelly bodies, colliders, zones and particle emitters
  // that write paint-only transforms into retained nodes each tick. The wasm
  // core behind the web and sim hosts implements the whole contract, and the
  // 3ds-dev and ipodtouch4-dev profiles advertise it because their hosts bind
  // the five ops (products/3ds/src/qjs.c; programs/native/quickjs/pocket_runtime.c under
  // POCKET_PHYSICS over programs/native/cabi). A target appends the id to its
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
  // Native encoded-media playback with bounded worker handoff, audio clock,
  // pause/volume, texture output and observable decoder availability.
  "media.playback",
  // HTTP as a worker resource (`io.http` in @pocketjs/framework/io,
  // engine/worker): bounded streaming requests through the host's transport
  // under the limits of contracts/spec/net.ts. No UI realm has a network
  // namespace.
  "io.offload",
  "net.http",
  // The console's system link to a paired companion computer
  // (`globalThis.link`, contracts/spec/link.ts): pairing, link status, the
  // companion's app catalog and app installs. The 3ds-dev host owns the link
  // and also routes net.http over it.
  "link.companion",
  // The console's wireless radio and saved connections (`globalThis.wifi`,
  // contracts/spec/wifi.ts). Reads and selects; never writes a connection.
  "system.wifi",
  // The board's own controls (`globalThis.device`, contracts/spec/device.ts):
  // backlight, speaker level, power rails, plug detection, free header pins,
  // the removable card's directory listing and power off.
  "system.device",
  // Outer-camera preview texture plus an on-device QR decoder
  // (`globalThis.camera`, contracts/spec/camera.ts).
  "camera.qr",
  // Stills from the outer or inner camera kept as JPEG under the storage's
  // DCIM folder, listed, decoded for drawing and deleted (the same
  // `globalThis.camera` namespace, contracts/spec/camera.ts).
  "camera.photo",
  // The system mascot on the top screen and the agent channel to the
  // companion (`globalThis.agent`, contracts/spec/agent.ts): a guest that
  // declares it hands the top screen to the host's 3D stage and keeps its
  // whole interface on the auxiliary surface.
  "system.agent",
  // A per-app file tree behind the fs module's own namespace
  // (`globalThis.fs`, contracts/spec/fs.ts): nine synchronous ops, every
  // path confined to the app's own data root — apps cannot name, let alone
  // reach, each other's trees. The sim host (platforms/sim/fs.ts) and the
  // host-services implementation (engine/host-services/fs.c, compiled into
  // the 3DS product and the Tab5 program) ship the whole contract; a device
  // target appends the id to its profile only when its program compiles the
  // module in.
  "data.fs",
  // Copy/cut/paste round-trips with the OS clipboard.
  "host.clipboard",
  // The logical viewport is runtime-mutable: the app is told about live
  // window resizes and relayouts (framework resizeViewport). Console
  // targets never provide this — their viewport is a platform constant.
  "display.viewport.live",
  // One fixed-size auxiliary UI output presented simultaneously with the
  // primary viewport by the same AppInstance. This is not Pocket System
  // application-surface composition.
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
  // id (see the header rule). Apps opt in per plan (`enhances`); a host
  // grants it by installing a core text measurer before the guest mounts
  // (docs/BACKENDS.md).
  "text.layout.native",
  // Asynchronous worker or paired companion service; availability is session scoped.
  "text.layout.offload",
] as const);

export type PocketCapabilityId = CapabilityId<typeof POCKET_CAPABILITIES>;

/** Registered capability ids and the targets resolution reads. A target
 * may list names the registry does not know; applications cannot require
 * them. */
export interface PlatformContractRegistry<
  C extends CapabilityRegistry = CapabilityRegistry,
  T extends TargetRegistry = TargetRegistry,
> {
  readonly capabilities: C;
  readonly targets: T;
}

export function definePlatformContractRegistry<
  const C extends CapabilityRegistry,
  const T extends TargetRegistry,
>(capabilities: C, targets: T): PlatformContractRegistry<C, T> {
  return { capabilities, targets };
}
