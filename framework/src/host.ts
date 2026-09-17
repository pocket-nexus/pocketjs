// Host binding layer — the JS side of the `ui.*` native contract (docs/DESIGN.md
// table, codes pinned in contracts/spec/spec.ts OP). Every op is SYNCHRONOUS; the
// renderer keeps a JS mirror tree so reconciler reads never cross this
// boundary.
//
// Two host kinds:
//   - "native":   QuickJS on a framework-owned device runtime — the native
//                 bin installs a `globalThis.ui` namespace. NON-strict:
//                 unknown classes/textures bump a counter instead of throwing
//                 (a crash on hardware is worse than a missing style).
//   - "injected": web/wasm/Bun-test hosts pass their own HostOps object into
//                 render(). Strict: unknown classes/textures throw loudly.

import {
  abgr,
  PROP_VALUE_KIND,
  VALUE_KIND,
  type PropName,
} from "../../contracts/spec/spec.ts";
import type { AxisDelta } from "./relative-axis.ts";

// Replaced by tools/build.ts for manifest-driven builds. `typeof` keeps
// legacy/test bundles valid until they opt into a ResolvedBuildPlan.
declare const __POCKET_TARGET__: string;
declare const __POCKET_HOST_ABI__: number;
// Replaced by tools/build.ts in EVERY build (default 60, `--hz` declares
// another). Read at call time, not module time, so tests can exercise the
// non-60 paths through a globalThis stand-in — a bundler define replaces the
// identifier with a literal either way.
declare const __POCKET_TICK_HZ__: number;

export interface BuildHostContract {
  readonly target: string;
  readonly hostAbi: number;
}

/** The `ui.*` op surface. Node ids are generation-tagged positive i32 values;
 *  node id 0 means "none" (anchor 0 = append, setFocus 0 = clear). Texture
 *  handles have operation-specific 0-based or generation-tagged contracts. */
export interface HostOps {
  /** type: spec NODE_TYPE (0 view, 1 text, 2 image, 3 surface) → node id. */
  createNode(type: number): number;
  /** Destroys the whole subtree; frees anim tracks; clears focus if inside. */
  destroyNode(id: number): void;
  /** DOM move semantics (attached child is unlinked first); anchor 0 = append. */
  insertBefore(parent: number, child: number, anchorOr0: number): void;
  /** Detaches but keeps the node alive (Solid may re-insert it this frame). */
  removeChild(parent: number, child: number): void;
  /** styleId from the compiled style table; STYLE_ID_NONE (-1) clears. */
  setStyle(id: number, styleId: number): void;
  /** propId: spec PROP. Colors/enums pass their u32 bits as a number. */
  setProp(id: number, propId: number, value: number): void;
  /**
   * Optional fast path for many direct property writes. `records` is a
   * little-endian Float64Array payload of repeated [nodeId, propId, value]
   * triples. Semantics are exactly repeated setProp calls, including
   * cancelling an animation on the same property.
   */
  setPropBatch?(records: ArrayBuffer): void;
  /** UTF-8 text; text nodes only. */
  setText(id: number, str: string): void;
  /** Solid universal calls this on reactive text updates. */
  replaceText(id: number, str: string): void;
  /** pow2 dims ≤ 512; psm: spec PSM. Returns a texture handle. */
  uploadTexture(buf: Uint8Array, w: number, h: number, psm: number): number;
  /** texHandle < 0 clears the image (handles are 0-based: 0 is a real one). */
  setImage(id: number, texHandle: number): void;
  /** Bind a native application surface to a surface node. Optional on
   *  hosts without ui.compositor-surfaces; handle < 0 clears the binding. */
  setCompositorSurface?(id: number, handle: number, focused: number): void;
  /**
   * Bind an animated sprite atlas to an image node: `atlas` is an uploaded
   * texture (a `cols`-wide grid of `frames` cells); the core auto-plays it,
   * one cell every `step` vblanks. `frames <= 0` clears it. Zero per-frame JS.
   */
  setSprite(
    id: number,
    atlas: number,
    frames: number,
    cols: number,
    step: number,
  ): void;
  /** from = current value; easing: spec ENUMS.Easing ordinal → animId. */
  animate(
    id: number,
    propId: number,
    to: number,
    durMs: number,
    easing: number,
    delayMs: number,
  ): number;
  cancelAnim(animId: number): void;
  /** Drain [[trackId, reason]] from core; reasons: ended=0, replaced=1, dropped=2. */
  takeAnimationCompletions?(): string;
  /** 0 clears focus. Applies the `focus:` style variant natively. */
  setFocus(idOr0: number): void;
  /** Set/clear the `active:` pressed variant natively (0/1 int; stale ids
   *  no-op). Optional: older hosts predate spec op 26 — pressed visuals
   *  degrade gracefully when absent. */
  setActive?(id: number, active: number): void;

  // -- virtual cursor ops (spec ops 27..29, input.cursor). Optional: hosts
  //    that predate them simply lack them and the cursor input layer
  //    (framework/src/input.ts) falls back to the classic d-pad focus model. ----------
  /** Topmost node id at a logical point (paint-order hit testing; pure
   *  layout containers pass through — see spec op 27). 0 = none. */
  hitTest?(x: number, y: number): number;
  /** Bounds-only twin of hitTest (spec op 42): pure layout containers CLAIM
   *  their box — the touch hit fact resolver's query form. The gesture layer
   *  only calls it when the host delivers no per-contact fact (frame() arg 4). */
  hitTestBounds?(x: number, y: number): number;
  /** Auxiliary-surface twins (spec ops 45–46). Present with
   * display.auxiliary; coordinates belong to its logical viewport. */
  hitTestAuxiliary?(x: number, y: number): number;
  hitTestBoundsAuxiliary?(x: number, y: number): number;
  /** Bind the cursor sprite: an uploaded texture drawn topmost every frame,
   *  offset by its hotspot; never laid out, never hit-tested. tex < 0 hides
   *  it; w/h <= 0 draw at the texture's own pixel size. */
  setCursor?(
    tex: number,
    hotX: number,
    hotY: number,
    w: number,
    h: number,
  ): void;
  /** Move the cursor hotspot to a logical point. */
  setCursorPos?(x: number, y: number): void;
  /** web/test hosts only — on PSP the native bin feeds core from the pak. */
  loadStyles?(buf: Uint8Array): void;
  /** web/test hosts only — one call per baked font atlas blob. */
  loadFontAtlas?(buf: Uint8Array): void;
  /** Bounded external glyph cache. These ops perform no filesystem work. */
  fontStreamConfigure?(descriptor: Uint8Array): boolean;
  fontStreamRequests?(): string;
  fontStreamCommit?(glyphs: Uint8Array): number;
  fontStreamStats?(): string;
  /** PFB1 batch lease: 1 ready, 0 pending, -1 missing, -2 budget, -3 stale. */
  fontStreamBatch?(descriptor: Uint8Array): number;
  /** JS-side convenience; layout measures natively. → width in px. */
  measureText(str: string, fontSlot: number): number;
  /** Soft-wrap break columns for ONE line under maxW px (spec op 43):
   *  ascending UTF-16 code-unit indices, empty = the line fits. The engine
   *  computes greedy word wrap over the same provider that measures and
   *  paints the slot; native-text backends may install the host text
   *  system's wrapper (gpui LineWrapper) whose positions win. Optional:
   *  hosts that predate it — apps fall back to matching greedy rules over
   *  measureText. */
  wrapText?(str: string, fontSlot: number, maxW: number): number[];

  // -- streamed textures (spec ops 23..25) — deep-zoom tile canvases. Native
  //    hosts (PSP, uihost) implement loadTileTexture so tile bytes never
  //    transit the JS heap; hosts without it fall back to __pak +
  //    uploadTexture in framework/src/tiles.ts. -------------------------------------
  /** Decode tile `index` of a TILESET pak entry (`key`) into a texture.
   *  → generation-tagged handle, or -1 (absent/solid/malformed tile). */
  loadTileTexture?(key: string, index: number): number;
  /** Release a texture slot. The handle is dead afterwards (stale handles
   *  draw nothing — handles are generation-tagged, spec TEX_SLOT_BITS). */
  freeTexture?(handle: number): void;
  /** Upload a self-contained IMG entry blob (framework/compiler/pak.ts layout, incl.
   *  PSM_T8 palette + RLE/filter flags). → handle or -1. */
  uploadImgEntry?(blob: Uint8Array): number;

  // -- host service channel + video plane (spec ops 30..37). Optional: only
  //    native hosts with a tethered companion process (PSPLINK usbhostfs,
  //    PPSSPP memstick dir) implement them. Apps feature-detect: no svcOpen
  //    (or svcOpen -> false) means "not tethered" and the app shows its
  //    connect screen or falls back to a host-appropriate transport. -------
  /** Probe pocket-svc/<app>/ under the tethered share; all later svc/video
   *  paths resolve inside that directory. → whether the mailbox exists. */
  svcOpen?(app: string): boolean;
  /** New COMPLETE JSON lines from the host since the last poll (may batch
   *  several, newline-terminated); undefined when idle. One usbhostfs round
   *  trip — poll once per frame, not per read. */
  svcPoll?(): string | undefined;
  /** Append one JSON line to the app's outbox. */
  svcSend?(line: string): void;
  /** Read a small IMG-entry side file (svc-dir-relative path) into a
   *  texture — host-rendered thumbnails/text strips. → handle or -1. */
  loadImgFile?(path: string): number;
  /** Open a .pkst stream file (svc-dir-relative): validate, allocate the
   *  plane texture, start audio. → success. */
  videoOpen?(path: string): boolean;
  /** Bounded per-frame IO pump — call once per frame while a stream is
   *  open. → source frame index of the presented frame, -1 before any. */
  videoTick?(): number;
  /** The plane texture handle (stable for the session), -1 when closed. */
  videoTexture?(): number;
  /** Stop audio, close the stream, free the plane. */
  videoClose?(): void;

  // -- DevTools ops (spec ops 18..22, docs/DEVTOOLS.md). Optional: debug-only,
  //    default-off; hosts that predate them (e.g. pocket-mod) simply lack
  //    them and the shim feature-detects. ---------------------------------
  /** Set (0 = clear) the inspected node: the core captures its world AABB
   *  during paint and appends a highlight overlay on top. */
  debugInspect?(id: number): void;
  /** Packed x|y<<16 (i16 halves) of the last captured AABB; -1 if none. */
  debugRectXY?(): number;
  /** Packed w|h<<16 of the same AABB; -1 if none. */
  debugRectWH?(): number;
  /** Freeze the world: tick() no-ops (draw still runs). */
  debugPause?(on: boolean | number): void;
  /** Arm exactly one tick while paused. */
  debugStep?(): void;
  /** Native DevTools transport (PSP mailbox or paired 3DS TCP connection). */
  __dbgActive?(): boolean;
  __dbgPoll?(): string | undefined;
  __dbgSend?(line: string): void;
  /** On-demand native screenshot. The host transports bulk pixels outside
   *  the JSON control channel and its bridge converts them to PNG. */
  __dbgShot?(): boolean;
  /** OP.debugStats — one JSON snapshot of device diagnostic counters
   *  (audio/vid/svc) plus build identity (app output name + FNV-1a64 of the
   *  embedded js+pak). Hosts without counters omit the op; the devtools
   *  "stats" message replies with data: null then. */
  debugStats?(): string;

  // -- app switching (spec ops 39..41, docs/LAUNCHER.md). Optional: only
  //    multi-app hosts (the launcher EBOOT, hosts/sim's launcher runner)
  //    implement them; @pocketjs/framework/launcher feature-detects and the
  //    launcher app degrades to its empty state elsewhere. -----------------
  /** OP.appTable — JSON { apps: [{output, id, title}], current, resume }. */
  appTable?(): string;
  /** OP.appLaunch — request a whole-guest switch to `output` after the
   *  current frame presents. → 1 scheduled, 0 unknown output. */
  appLaunch?(output: string): number;
  /** OP.appShot — texture handle of the SELECT summon's frozen frame
   *  (256×128 PSM_8888), -1 when none was captured. */
  appShot?(): number;
  /** Native navigation: request graceful closure of a configured child app. */
  appClose?(output: string): number;
  /**
   * Optional host-owned acceptance sink. Applications report a completed,
   * user-visible action; hosts that do not collect hardware receipts omit it.
   * The leading underscores keep this diagnostic outside the portable OP ABI.
   */
  __reportAppAction?(name: string, value: number): void;
  /** Framework target/profile identity (for example "psp" or "vita"). */
  __host?: string;
  /** Version of the JS/native HostOps ABI implemented by this namespace. */
  __hostAbi?: number;
  /** Ticks per second of virtual time the host drives this realm at. Absent
   *  means the spec default 60 — hosts that predate per-realm rates only
   *  ever ran 60. Bundles bake their rate (`--hz`) and refuse another. */
  __tickHz?: number;
  /** Pocket System package id -> compositor surface handle. Separate from the
   *  texture namespace: compositor surfaces are not images. */
  __surfaces?: Record<string, number>;
  /** Host-created auxiliary UI root and target-owned logical viewport. This
   * is separate from __surfaces, which names Pocket System app compositor
   * handles rather than outputs of the current AppInstance. */
  __auxiliarySurface?: { readonly root: number; readonly w: number; readonly h: number };
}

/** Desktop hosts publish their logical UI size as `ui.__viewport` (the core
 *  is resized to it at mount); console hosts omit it — the spec screen is
 *  the viewport. One accessor so every consumer reads the same contract. */
export function hostViewport(ops: HostOps): { w: number; h: number } | null {
  return (
    (ops as HostOps & { __viewport?: { w: number; h: number } }).__viewport ??
    null
  );
}

export interface Host {
  ops: HostOps;
  /** Transport/ownership, deliberately independent from the target name. */
  kind: "native" | "injected";
  /** Target/profile reported by the host; "injected" for tests/web adapters. */
  target: string;
  /** Strict hosts throw on unknown class/src; native hosts count silently. */
  strict: boolean;
}

let current: Host | null = null;

export function embeddedBuildHostContract(): BuildHostContract | null {
  const target = typeof __POCKET_TARGET__ === "string" ? __POCKET_TARGET__ : "";
  const hostAbi =
    typeof __POCKET_HOST_ABI__ === "number" ? __POCKET_HOST_ABI__ : 0;
  return target && hostAbi > 0 ? { target, hostAbi } : null;
}

/** Fail before mounting when a bundle was packaged with the wrong native
 *  host, or baked for a tick rate the host does not drive. The rate check
 *  runs for every native mount — plan-less bundles bake a rate too. */
export function assertNativeHostContract(
  ops: HostOps,
  expected: BuildHostContract | null = embeddedBuildHostContract(),
): void {
  const baked =
    typeof __POCKET_TICK_HZ__ === "number" && __POCKET_TICK_HZ__ > 0
      ? __POCKET_TICK_HZ__
      : 60;
  const declared = ops.__tickHz ?? 60;
  if (declared !== baked) {
    throw new Error(
      ops.__tickHz === undefined
        ? `PocketJS: this bundle bakes ${baked} Hz virtual time but the host declares no ui.__tickHz, ` +
          "which means the 60 Hz default — declare the rate before mount and drive the surface at it " +
          "(pocket_apple set_tick_rate before eval_bundle; PocketSurfaceView.tickRate)"
        : `PocketJS: tick-rate mismatch (bundle baked at ${baked} Hz, host drives ${declared} Hz) — ` +
          "a bundle only runs correctly at the rate it was built with (`--hz`), like glyphs at their density",
    );
  }
  if (!expected) return;
  if (typeof ops.__host !== "string") {
    throw new Error(
      `PocketJS: this bundle targets "${expected.target}" but the native host predates platform ` +
        "contracts — add __host/__hostAbi to its ui namespace (see framework/src/host.ts HostOps)",
    );
  }
  if (ops.__host !== expected.target) {
    throw new Error(
      `PocketJS: native target mismatch (bundle=${expected.target}, host=${ops.__host})`,
    );
  }
  if (ops.__hostAbi !== expected.hostAbi) {
    throw new Error(
      `PocketJS: native host ABI mismatch (bundle=${expected.hostAbi}, host=${ops.__hostAbi ?? "missing"})`,
    );
  }
}

/**
 * Resolve the host: injected ops win; otherwise `globalThis.ui` (native
 * QuickJS).
 * Throws when neither exists — PocketJS cannot run without a native tree.
 *
 * A namespace is NATIVE when it self-identifies with `__host` (platform
 * contracts) — or, for hosts built before contracts existed (pocket-shell,
 * the iOS fork, shipped EBOOTs), when it carries `__textures`, which only
 * native ffi layers ever set. Those legacy hosts stay hosts/psp/non-strict with
 * target "unknown"; a bundle carrying an embedded contract refuses them with
 * an actionable migration error (assertNativeHostContract). Web/wasm
 * adapters publish `globalThis.ui` too but set neither marker and stay
 * strict-injected, exactly as before.
 */
export function detectHost(injected?: HostOps): Host {
  const native = (globalThis as { ui?: HostOps & { __textures?: unknown } }).ui;
  const nativeMarked =
    native !== undefined &&
    (typeof native.__host === "string" || native.__textures !== undefined);
  if (injected) {
    if (native !== undefined && injected === native && nativeMarked) {
      assertNativeHostContract(native);
      return {
        ops: injected,
        kind: "native",
        target: native.__host ?? "unknown",
        strict: false,
      };
    }
    return {
      ops: injected,
      kind: "injected",
      target: injected.__host ?? "injected",
      strict: true,
    };
  }
  if (native !== undefined && nativeMarked) {
    assertNativeHostContract(native);
    return {
      ops: native,
      kind: "native",
      target: native.__host ?? "unknown",
      strict: false,
    };
  }
  if (native) {
    return { ops: native, kind: "injected", target: "injected", strict: true };
  }
  throw new Error(
    "PocketJS: no host — pass HostOps to render() (web/test) or run under a native runtime (globalThis.ui)",
  );
}

/** Install the active host. Called by render(); tests may call it directly. */
export function installHost(host: Host): void {
  current = host;
}

export function getHost(): Host {
  if (!current) {
    throw new Error("PocketJS: host not installed — call render() first");
  }
  return current;
}

export function getOps(): HostOps {
  return getHost().ops;
}

const APP_ACTION_NAME = /^[a-z][a-z0-9_.-]{0,62}$/;

/**
 * Report a completed, user-visible application action to an optional native
 * acceptance sink. This is diagnostic evidence, not an input mechanism; on
 * hosts without a sink it is intentionally a no-op.
 */
export function reportAppAction(name: string, value: number): void {
  if (!APP_ACTION_NAME.test(name)) {
    throw new Error(
      "PocketJS: app action names must start with a lowercase letter and contain only a-z, 0-9, _, . or -",
    );
  }
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw new Error(
      "PocketJS: app action values must be signed 32-bit integers",
    );
  }
  getOps().__reportAppAction?.(name, value);
}

// ---------------------------------------------------------------------------
// Frame hookup
// ---------------------------------------------------------------------------
// Every host drives frames the same way: once per vblank/rAF tick it calls
// `globalThis.frame(buttons, analog?, touches?, hits?, touchSurfaces?, rightAnalog?, axisDeltas?)` with the
// PSP button bitmask (spec BTN)
// and, when the host has an analog stick, the packed nub value
// (x << 8 | y, each axis 0..255, 128 = center — spec ANALOG_CENTER). Hosts
// without a stick pass one argument; the runtime defaults to center, so every
// pre-analog host, tape and golden is unchanged. index.ts composes input
// edge-detection + the renderer's end-of-frame sweep into that entry point
// via installFrameHandler.

export function installFrameHandler(
  fn: (
    buttons: number,
    analog?: number,
    touches?: readonly number[],
    hits?: readonly number[],
    touchSurfaces?: readonly number[],
    rightAnalog?: number,
    axisDeltas?: readonly AxisDelta[],
  ) => void,
): void {
  (
    globalThis as {
      frame?: (
        buttons: number,
        analog?: number,
        touches?: readonly number[],
        hits?: readonly number[],
        touchSurfaces?: readonly number[],
        rightAnalog?: number,
        axisDeltas?: readonly AxisDelta[],
      ) => void;
    }
  ).frame = fn;
}

export type ResizeViewportHook = (width: number, height: number) => void;

/**
 * Install the native host's live-viewport callback without coupling the
 * global hook lifecycle to a particular renderer. Restores any previous hook
 * only when the installed callback still owns the slot.
 */
export function installResizeViewportHook(
  resizeViewport: ResizeViewportHook,
): () => void {
  const globals = globalThis as typeof globalThis & {
    __pocketResizeViewport?: ResizeViewportHook;
  };
  const previous = globals.__pocketResizeViewport;
  const hook: ResizeViewportHook = (width, height) =>
    resizeViewport(width, height);
  globals.__pocketResizeViewport = hook;
  return () => {
    if (globals.__pocketResizeViewport !== hook) return;
    if (previous) globals.__pocketResizeViewport = previous;
    else delete globals.__pocketResizeViewport;
  };
}

// ---------------------------------------------------------------------------
// Prop value encoding
// ---------------------------------------------------------------------------

/** Parse '#rgb' | '#rgba' | '#rrggbb' | '#rrggbbaa' into u32 ABGR. */
export function parseHexColor(s: string): number {
  let hex = s.slice(1);
  if (hex.length === 3 || hex.length === 4) {
    hex = [...hex].map(character => character + character).join("");
  }
  if (hex.length !== 6 && hex.length !== 8) {
    throw new Error(
      `PocketJS: bad color '${s}' (expected #rgb/#rgba/#rrggbb/#rrggbbaa)`,
    );
  }
  // Full-string validation: parseInt would silently accept a valid PREFIX
  // ("#ff00zz" -> 0xff00) and paint a wrong color instead of throwing.
  if (!/^[0-9a-fA-F]+$/.test(hex))
    throw new Error(`PocketJS: bad color '${s}'`);
  const n = parseInt(hex, 16);
  if (hex.length === 6) {
    return abgr((n >>> 16) & 255, (n >>> 8) & 255, n & 255, 255);
  }
  return abgr((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
}

/**
 * Encode a JS-side prop value into the single number setProp/animate carries:
 * f32 props pass through, color/int props travel as their u32 bits. Strings
 * are parsed ('#rrggbb' for colors, numeric strings otherwise).
 */
export function encodePropValue(
  prop: PropName,
  value: number | string,
): number {
  const kind = PROP_VALUE_KIND[prop];
  if (typeof value === "string") {
    if (kind === VALUE_KIND.color) return parseHexColor(value);
    const n = Number(value);
    if (Number.isNaN(n)) {
      throw new Error(
        `PocketJS: non-numeric value '${value}' for prop '${prop}'`,
      );
    }
    value = n;
  }
  if (kind === VALUE_KIND.color || kind === VALUE_KIND.int) return value >>> 0;
  return value;
}
