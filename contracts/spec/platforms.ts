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
 *   compiler family (Pocket Vapor, Pocket Static). There is no hostAbi, no
 *   ops and no runtime capability check; admission is COMPILE-TIME — the
 *   compiler derives the app's demands and checks them against a BOARD
 *   PROFILE (data, not a registry entry — see vapor/BOARDS.md).
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
}

export interface TargetProfile<C extends string = string> {
  /** JS/native HostOps wire generation embedded by the selected backend. */
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
  "input.analog.left",
  "input.analog.right",
  "input.buttons",
  // Framework-synthesized pointer for targets without a native one: the
  // analog nub steers a screen cursor, hover applies `focus:`, the press
  // button applies `active:` and clicks on release. Opt-in per app
  // (enableCursor + pocket.json requires/enhances) — d-pad focus traversal
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
  // Credit-based s16 PCM streaming through the audio module's own namespace
  // (`globalThis.audio`, contracts/spec/audio.ts). Registered ahead of any
  // stock TARGET advertising it: the web dev host and the sim host implement
  // and test the whole contract, so apps can already declare the enhancement
  // and degrade cleanly where the namespace is absent. A console target
  // appends the id to its profile only when its native host ships the module
  // (the ring/thread discipline to copy is hosts/psp/src/audio.rs).
  "audio.pcm",
  // Native encoded-media playback with bounded worker handoff, audio clock,
  // pause/volume, texture output and observable decoder availability.
  "media.playback",
  // Bounded whole-response HTTP through `fetch()` and the net module's own
  // namespace (`globalThis.net`, contracts/spec/net.ts). Transport adapters
  // remain host-owned; the browser dev host, deterministic sim and reference
  // core exercise the contract without granting network access to every host.
  "io.offload",
  "net.http",
  // SQLite behind the db module's own namespace (`globalThis.db`,
  // contracts/spec/db.ts): five synchronous ops, rows as one JSON line per
  // query() call, per-app storage the host confines. Registered ahead of any
  // stock TARGET advertising it: the sim host and the engine/crates/pocket-db
  // reference core implement and test the whole contract, so apps can already
  // declare the requirement and fail admission where the module is absent. A
  // device target appends the id to its profile only when its native host
  // ships the module.
  "data.sqlite",
  // A per-app file tree behind the fs module's own namespace
  // (`globalThis.fs`, contracts/spec/fs.ts): nine synchronous ops, every
  // path confined to the app's own data root — apps cannot name, let alone
  // reach, each other's trees. Registered ahead of any stock TARGET
  // advertising it: the sim host and the engine/crates/pocket-fs reference
  // core implement and test the whole contract, so apps can already declare
  // the requirement and fail admission where the module is absent. A device
  // target appends the id to its profile only when its native host ships
  // the module.
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

/**
 * Production profiles advertise only capabilities delivered by stock hosts —
 * the registry is an inventory of REAL, tested hosts, never a combinatorial
 * grammar. Ids are LABELS: consoles keep bare device names ("psp"), host-
 * windowed targets read `<platform>-<form>` ("macos-widget") by convention,
 * and no tooling may parse an id — platform/form are queryable fields on the
 * profile.
 */
export const POCKET_TARGETS = defineTargetRegistry<PocketCapabilityId, {
  readonly psp: TargetProfile<PocketCapabilityId>;
  readonly vita: TargetProfile<PocketCapabilityId>;
  readonly pocketbook: TargetProfile<PocketCapabilityId>;
  readonly "macos-widget": TargetProfile<PocketCapabilityId>;
  readonly "macos-app": TargetProfile<PocketCapabilityId>;
  readonly "linux-app": TargetProfile<PocketCapabilityId>;
  readonly "web-app": TargetProfile<PocketCapabilityId>;
}>({
  psp: {
    hostAbi: 1,
    platform: "psp",
    form: "takeover",
    display: {
      physicalViewport: [480, 272],
      logicalViewports: [[480, 272]],
      // integer-fit at scale 1 is the portable spelling of the native PSP
      // surface and can be satisfied unchanged by higher-resolution hosts.
      presentations: ["native", "integer-fit"],
      rasterDensity: 1,
    },
    capabilities: [
      "input.analog.left",
      "input.buttons",
      // USB companion transport only; text never executes on the device.
      "io.offload",
      "text.layout.offload",
      "input.cursor",
      // hosts/psp/src/audio_mod.rs: the audio module mounted as
      // globalThis.audio (4-stream mixer on one 44.1 kHz normal channel).
      "audio.pcm",
      "text.glyphs.baked",
    ],
  },
  vita: {
    hostAbi: 2,
    platform: "vita",
    form: "takeover",
    display: {
      physicalViewport: [960, 544],
      logicalViewports: [[480, 272]],
      presentations: ["integer-fit"],
      rasterDensity: 2,
    },
    capabilities: [
      "input.analog.left",
      "input.buttons",
      "input.cursor",
      "input.touch",
      "text.glyphs.baked",
    ],
  },
  // PocketBook e-readers (inkview): hosts/pocketbook reuses the backend-
  // agnostic ui surface + the core software rasterizer. Same logical viewport
  // and density as vita (480×272 @2x → a 960×544 render). physicalViewport is
  // that nominal 2x surface — NOT the raw panel — so integer-fit apps validate
  // (real panels vary by model, e.g. Verse 1024×758, Era Color 1264×1680, and
  // are not integer multiples of 480×272); the host queries the actual panel at
  // runtime and integer-fit centers the 960×544 render on it. No analog nub;
  // a REAL capacitive pointer instead of the synthesized cursor. Color panels
  // (Era Color) blit RGB, grayscale panels (Verse) blit Gray8.
  pocketbook: {
    hostAbi: 5,
    platform: "pocketbook",
    form: "takeover",
    display: {
      physicalViewport: [960, 544],
      logicalViewports: [[480, 272]],
      presentations: ["integer-fit"],
      rasterDensity: 2,
    },
    capabilities: ["input.buttons", "input.touch", "text.glyphs.baked"],
  },
  // The flat pocket-widget shell (examples/note-widget is the stock host):
  // a resizable always-on-top window whose logical viewport IS the window,
  // rendered at density 2 for Retina. No nub, no synthesized cursor — the
  // pointer is real, text comes from the keyboard/IME, and unseen glyphs
  // bake at runtime. A widget shell is not a general app frame, so it does
  // not accept fixed-viewport apps (a future macos-app target would).
  "macos-widget": {
    hostAbi: 3,
    platform: "macos",
    form: "widget",
    display: {
      physicalViewport: [840, 1120],
      logicalViewports: [[420, 560]],
      dynamicViewport: { min: [240, 180], max: [4096, 4096] },
      presentations: ["native"],
      rasterDensity: 2,
    },
    capabilities: [
      "input.buttons",
      "input.ime",
      "input.pointer",
      "input.text",
      "host.clipboard",
      "display.viewport.live",
      "text.glyphs.baked",
      "text.glyphs.runtime",
    ],
  },
  // Portable desktop host: winit presentation, Rust software rendering and
  // AppSupervisor on a runtime worker, text in independent offload workers.
  "macos-app": {
    hostAbi: 4,
    platform: "macos",
    form: "window",
    display: {
      physicalViewport: [1440, 960],
      logicalViewports: [[720, 480]],
      dynamicViewport: { min: [240, 180], max: [4096, 4096], acceptsFixed: true },
      presentations: ["native"],
      rasterDensity: 2,
    },
    capabilities: [
      "input.buttons",
      "display.viewport.live",
      "text.glyphs.baked",
      "io.offload",
      "text.layout.offload",
    ],
    roleCapabilities: {
      systemUI: ["ui.compositor-surfaces"],
    },
  },
  // The same portable host on Linux, at one raster sample per logical pixel.
  "linux-app": {
    hostAbi: 4,
    platform: "linux",
    form: "window",
    display: {
      physicalViewport: [1280, 800],
      logicalViewports: [[800, 600]],
      dynamicViewport: { min: [240, 180], max: [4096, 4096], acceptsFixed: true },
      presentations: ["native"],
      rasterDensity: 1,
    },
    capabilities: [
      "input.buttons",
      "display.viewport.live",
      "text.glyphs.baked",
      "io.offload",
      "text.layout.offload",
    ],
    roleCapabilities: {
      systemUI: ["ui.compositor-surfaces"],
    },
  },
  // Browser Pocket System host: one iframe JavaScript Realm and one wasm Ui
  // per package, scheduled and composited by hosts/web/system-engine.js. The
  // shell viewport follows the browser canvas; acceptsFixed admits installed
  // console-shaped applications inside compositor surfaces.
  "web-app": {
    hostAbi: 4,
    platform: "web",
    form: "window",
    display: {
      physicalViewport: [800, 600],
      logicalViewports: [[800, 600]],
      dynamicViewport: { min: [320, 240], max: [4096, 4096], acceptsFixed: true },
      presentations: ["native"],
      rasterDensity: 1,
    },
    capabilities: [
      "input.buttons",
      "display.viewport.live",
      "text.glyphs.baked",
      "io.offload",
      "text.layout.offload",
    ],
    roleCapabilities: {
      systemUI: ["ui.compositor-surfaces"],
    },
  },
});

export type PocketTargetId = TargetId<typeof POCKET_TARGETS>;

export interface PlatformContractRegistry<
  C extends CapabilityRegistry = CapabilityRegistry,
  T extends TargetRegistry<CapabilityId<C>> = TargetRegistry<CapabilityId<C>>,
> {
  readonly capabilities: C;
  readonly targets: T;
}

export function definePlatformContractRegistry<
  const C extends CapabilityRegistry,
  const T extends TargetRegistry<CapabilityId<C>>,
>(capabilities: C, targets: T): PlatformContractRegistry<C, T> {
  return { capabilities, targets };
}

export const POCKET_PLATFORM_CONTRACTS = definePlatformContractRegistry(
  POCKET_CAPABILITIES,
  POCKET_TARGETS,
);
