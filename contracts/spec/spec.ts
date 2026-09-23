// PocketJS spec — THE single source of truth for every cross-language constant.
//
// Everything the TS runtime (framework/src/), the compiler (framework/compiler/), the Rust core
// (engine/core/), the wasm host and the PSP native host agree on is pinned HERE, in
// plain data. `contracts/spec/gen-rust.ts` deterministically generates `engine/core/src/spec.rs`
// from this file; `tests/contract.ts` regenerates it in-memory and byte-compares
// against the committed file, so TS and Rust can never drift.
//
// Conventions (repo-wide, non-negotiable):
//   - Little-endian EVERYWHERE (PSP, wasm32, x86/ARM hosts are all LE).
//   - Colors are u32 ABGR: bits 0-7 = R, 8-15 = G, 16-23 = B, 24-31 = A
//     (0xAABBGGRR — the PSP GE COLOR_8888 vertex/tex format; matches the
//     dreamcart runtime's Vertex2D color, runtime/src/gfx.rs).
//   - All byte offsets in format comments are from the start of the blob
//     unless stated otherwise.
//
// If you change ANY value here: run `bun contracts/spec/gen-rust.ts`, commit the
// regenerated engine/core/src/spec.rs, and bump the relevant format VERSION if the
// change alters a binary layout.

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

/** Logical (and physical PSP) screen size. Every host renders 480x272. */
export const SCREEN_W = 480;
export const SCREEN_H = 272;

// ---------------------------------------------------------------------------
// Node types
// ---------------------------------------------------------------------------

/** Element kinds — the `type` argument of `createNode`. */
export const NODE_TYPE = {
  view: 0,
  text: 1,
  image: 2,
  /** A native-compositor slot for an installed Pocket application. */
  surface: 3,
} as const;

// ---------------------------------------------------------------------------
// Node ids
// ---------------------------------------------------------------------------
// Node handles are generation-tagged i32s: id = (generation << ID_SLOT_BITS) | slot.
// Slot = index into the core node arena; generation increments when a slot is
// reused, so a stale id from JS is detected and the op becomes a no-op.
// Bit 31 stays 0 (ids are always positive); 0 is "no node" (e.g. insertBefore
// anchor 0 = append, setFocus 0 = clear focus).

export const ID_SLOT_BITS = 20;
export const ID_SLOT_MASK = 0xfffff;
/**
 * Maximum tree depth (root = depth 0). `insertBefore` rejects inserts whose
 * parent already sits at the cap (silent no-op, same contract as stale ids).
 * This bounds every recursive tree walk (layout build/readback, paint,
 * subtree destroy) so deep runaway trees cannot overflow the small PSP
 * thread stacks. Far above any real 480x272 UI.
 */
export const MAX_TREE_DEPTH = 64;
/** Node 1 (slot 1, generation 0) is the pre-created full-screen root (flex column). */
export const ROOT_ID = 1;
/** `setStyle(id, STYLE_ID_NONE)` clears the node back to default style. */
export const STYLE_ID_NONE = -1;

/**
 * f32 sentinel for `w-full` / `h-full` (PROP.width/height): 100% of the
 * parent. This is the ONLY percentage v1 supports (docs/DESIGN.md punts the rest).
 * Any negative width/height value is treated as this sentinel by the core;
 * the sentinel is NOT animatable (animate() to/from it is a no-op).
 */
export const SIZE_FULL = -1;

// ---------------------------------------------------------------------------
// UI ops (the `ui.*` native contract — see docs/DESIGN.md table)
// ---------------------------------------------------------------------------
// Numeric codes are the engine/wasm/FFI ABI identity of each op. 0 is reserved
// (invalid/nop). Codes are append-only: never renumber, never reuse.
//
// Signatures (authoritative; hosts marshal them however they like):
//   createNode(type:i32) -> id            destroyNode(id)          [subtree]
//   insertBefore(parent, child, anchorOr0) [DOM move semantics; 0 = append]
//   removeChild(parent, child)             [keeps node alive for re-insert]
//   setStyle(id, styleId)                  [STYLE_ID_NONE clears]
//   setProp(id, propId:i32, value:f64)     [colors/enums pass u32 bits as number]
//   setText(id, str) / replaceText(id, str)         [UTF-8; text nodes only]
//   uploadTexture(buf, w, h, psm) -> handle          [pow2 <= 512, copied]
//   setImage(id, texHandle)                [texHandle < 0 clears the image —
//                                           handles are 0-based, so 0 is real]
//   animate(id, propId, to:f64, durMs, easing, delayMs) -> animId [from = current]
//   cancelAnim(animId)
//   setFocus(idOr0)                        [applies focus: variant natively]
//   setActive(id, activeInt)               [applies active: variant natively;
//                                           0/1 int — the input layer's
//                                           pressed state, spec op 26]
//   loadStyles(buf) / loadFontAtlas(buf)   [web/test hosts only; PSP feeds core
//                                           natively from the pak]
//   measureText(str, fontSlot) -> width:f32
//   setCompositorSurface(id, handle, focusedInt) [surface nodes only; handle
//                                                  < 0 clears]

export const OP = {
  createNode: 1,
  destroyNode: 2,
  insertBefore: 3,
  removeChild: 4,
  setStyle: 5,
  setProp: 6,
  setText: 7,
  replaceText: 8,
  uploadTexture: 9,
  setImage: 10,
  animate: 11,
  cancelAnim: 12,
  setFocus: 13,
  loadStyles: 14,
  loadFontAtlas: 15,
  measureText: 16,
  setSprite: 17,
  // -- DevTools (docs/DEVTOOLS.md; debug-only, default-off, never used by
  //    tests/goldens — shipped behavior is unchanged when untouched) --------
  debugInspect: 18, // set (0 = clear) the inspected node: core captures its
  //                   world AABB during paint and draws a highlight overlay
  debugRectXY: 19, //  packed x|y<<16 (i16 halves) of the last captured world
  //                   AABB; -1 if the node wasn't painted
  debugRectWH: 20, //  packed w|h<<16 of the same AABB
  debugPause: 21, //   freeze the world: tick() no-ops (draw still runs)
  debugStep: 22, //    arm exactly one tick while paused
  // -- streamed textures (deep-zoom tile canvases; see TILESET below) -------
  loadTileTexture: 23, // (pakKey: string, tileIndex: i32) -> handle | -1.
  //                      Decode ONE tile of a TILESET pak entry into a core
  //                      texture, host-side (PSP reads .rodata directly; no
  //                      JS-heap transit). Hosts without it: the framework
  //                      falls back to __pak + uploadImgEntry.
  freeTexture: 24, //     (handle) — release a texture slot. Handles are
  //                      generation-tagged (below); a freed handle is dead
  //                      and draws nothing if still referenced.
  uploadImgEntry: 25, //  (blob) -> handle | -1. Upload a self-contained IMG
  //                      entry (framework/compiler/pak.ts layout, v2: PSM_T8 palette +
  //                      optional RLE + filter flags parsed core-side).
  setActive: 26, //       (id, activeInt) — set/clear the `active:` pressed
  //                      variant natively (same machinery as setFocus). The
  //                      focus manager holds it while the press button is
  //                      down; stale ids no-op.
  // -- virtual cursor (input.cursor capability; framework/src/input.ts owns the state
  //    machine — hosts only relay these three calls) ------------------------
  hitTest: 27, //         (x: f32, y: f32) -> topmost node id at that logical
  //                      point, or 0. Paint-order hit testing: the last node
  //                      painted there whose border box contains the point
  //                      AND that paints something (bg/gradient/border/bevel/
  //                      image/text — in ANY variant: focus:/active:-styled
  //                      hotspots claim before they are hovered). Pure layout
  //                      containers — including the framework's overlay/
  //                      portal layers — pass through, the engine's stand-in
  //                      for pointer-events: none; their children are still
  //                      tested. display:none and effective-opacity-0
  //                      subtrees are skipped (paint culls them: what cannot
  //                      be seen takes no hits), overflow-hidden clips
  //                      descendants. Perspective (3D) subtrees hit as their
  //                      context root's box.
  setCursor: 28, //       (tex, hotX, hotY, w, h) — bind the cursor sprite: an
  //                      uploaded texture drawn LAST every frame (topmost),
  //                      never hit-tested, never in layout. tex < 0 hides the
  //                      cursor; w/h <= 0 draw at the texture's pixel size.
  setCursorPos: 29, //    (x: f32, y: f32) — move the cursor hotspot to a
  //                      logical point (the sprite renders offset by -hotspot;
  //                      the cursor input layer integrates the analog nub
  //                      into this once per frame).
  // -- host service channel (tethered apps; see SVC + STREAM below). A
  //    companion process on the tethered machine (PSPLINK usbhostfs) speaks
  //    JSON lines + side files with the app — the same mailbox split the
  //    DevTools bridge uses (control on jsonl, bulk bytes via files). --------
  svcOpen: 30, //         (app: string) -> bool. Probe pocket-svc/<app>/enable
  //                      under host0: then ms0:; seek in.jsonl to EOF (stale
  //                      commands from a previous run are skipped). All later
  //                      svc/video paths resolve relative to this directory.
  svcPoll: 31, //         () -> string | undefined. New COMPLETE lines from
  //                      in.jsonl since the last poll (may batch several); a
  //                      line the host is mid-writing stays for the next poll.
  svcSend: 32, //         (line: string) — append one JSON line to out.jsonl.
  loadImgFile: 33, //     (path: string) -> handle | -1. Read a small IMG-entry
  //                      file (framework/compiler/pak.ts layout) from the svc directory
  //                      into a texture — how host-rendered thumbnails and
  //                      text strips reach the GE without transiting the JS
  //                      heap or the JSON channel.
  // -- video plane (STREAM container below): a host-decoded pixel+PCM feed
  //    presented as one core texture + one audio channel. ------------------
  videoOpen: 34, //       (path: string) -> bool. Open a .pkst stream file in
  //                      the svc directory, validate headers, allocate the
  //                      plane texture (pow2 CLUT8) and start audio output.
  videoTick: 35, //       () -> frameIndex | -1. Bounded per-frame IO pump:
  //                      reads the 96-byte header block, tops up the PCM ring,
  //                      continues the current slot read, and when a slot
  //                      completes updates the plane texture in place.
  //                      Returns the source frame index of the presented
  //                      frame, -1 before the first one.
  videoTexture: 36, //    () -> handle | -1. The plane texture (stable for the
  //                      whole session; -1 when no stream is open).
  videoClose: 37, //      () — stop audio, close the stream, free the plane.
  debugStats: 38, //      () -> string. One JSON snapshot of the device's
  //                      diagnostic counters (hosts/psp/src/stats.rs: audio
  //                      underruns/reserve failures, video frames presented/
  //                      torn/lapped, svc truncation resets) plus build
  //                      identity: the app output name and the FNV-1a64 hash
  //                      of the embedded js+pak (tools/bundle-hash.ts is
  //                      the host-side twin). The devtools "devStats"
  //                      message rides this; the bridge compares the hash
  //                      against local dist/ on every hello and calls out a
  //                      stale-embed loudly. Hosts without counters simply
  //                      omit the op.
  // -- app switching (docs/LAUNCHER.md): multi-app hosts embed several bundles
  //    and swap the whole guest between them. Hosts without app switching
  //    omit all three ops (same rule as debugStats). ------------------------
  appTable: 39, //        () -> string. JSON { apps: [{output, id, title}],
  //                      current, resume }: the embedded bundle table, the
  //                      running bundle's output name, and the app that was
  //                      interrupted by the last SELECT summon (null after a
  //                      cold boot or an explicit launch).
  appLaunch: 40, //       (output: string) -> 0|1. Request a guest switch: the
  //                      host finishes the CURRENT frame (draw + present),
  //                      then tears the guest down and boots `output` from
  //                      scratch. 0 = unknown output, no switch scheduled.
  //                      Launching `current` relaunches it fresh — there is
  //                      no suspend anywhere in this protocol.
  appShot: 41, //         () -> handle | -1. Texture of the frozen frame the
  //                      SELECT summon captured: the FULL current logical
  //                      frame downscaled into 256x128 PSM_8888 (stored
  //                      squeezed — draw it at current viewport aspect to
  //                      undo it; consoles are 480x272).
  //                      Valid inside the summoned launcher guest until the
  //                      next switch; -1 otherwise.
  // -- touch hit facts (input.touch capability; docs/TOUCH.md) ---------------
  hitTestBounds: 42, //   (x: f32, y: f32) -> topmost node id at that logical
  //                      point by LAYOUT BOX alone, or 0. The same paint-order
  //                      walk as hitTest (clips, transforms, opacity culling,
  //                      display:none) minus the paints-something requirement:
  //                      pure layout containers claim their box (UIKit bounds
  //                      semantics — a finger in a list's row gap still owns
  //                      the list). This is the cold-path QUERY form of the
  //                      touch hit FACT: a host with input.touch resolves it
  //                      once per contact at the DOWN edge against the
  //                      committed frame, carries it for the contact's
  //                      lifetime, and delivers it as frame() argument 4
  //                      (`hits`, parallel to `touches`; see the frame
  //                      contract note on that argument). The guest only
  //                      issues this op when no fact channel exists (devtools
  //                      replay, injected test hosts, older wasm builds).
  // -- text wrap (the platform half of soft-wrap layout; docs/BACKENDS.md) --
  wrapText: 43, //        (str: string, fontSlot: i32, maxW: f32) -> u32[].
  //                      Soft-wrap break columns for ONE line of text under
  //                      maxW px, ascending UTF-16 code-unit indices (empty
  //                      = the line fits). The engine computes
  //                      greedy word wrap over the SAME provider that
  //                      measures and paints the slot (atlas advances, or
  //                      the native measurer for native-text apps): break
  //                      BEFORE the word that overflows, space runs hang
  //                      past maxW on the row they follow, a word wider than
  //                      a whole row splits at character level. Native-text
  //                      backends may install a host wrapper next to the
  //                      measurer (Ui::set_text_wrap — gpui's LineWrapper)
  //                      and its break positions win. Wrapped-coordinate
  //                      bookkeeping (visual rows, caret/selection mapping)
  //                      stays app-side — this op is the "where may it
  //                      break" half only. Hosts without it: applications
  //                      implement matching greedy rules over measureText.
  setCompositorSurface: 44, // (id, surfaceHandle, focusedInt). Binds an
  //                      Pocket System package surface to a NODE_TYPE.surface
  //                      node. The core emits SURFACE_QUAD in ordinary paint
  //                      order with BOTH full and clipped bounds; no image or
  //                      texture semantics are involved. focusedInt is the
  //                      shell's focus fact consumed by the native compositor
  //                      for input and scheduling. handle < 0 clears.
  // -- additional UI outputs (display.auxiliary capability) ----------------
  hitTestAuxiliary: 45, // (x: f32, y: f32) -> topmost painted node id in the
  //                      auxiliary output's logical coordinate space, or 0.
  //                      Same semantics as hitTest; never searches primary.
  hitTestBoundsAuxiliary: 46, // bounds-only twin for auxiliary touch facts.
  //                      Same semantics as hitTestBounds; never searches
  //                      primary. Hosts omit both ops without the capability.
  // Optional text.glyphs.streamed: bounded CPU handoff, never filesystem I/O.
  fontStreamConfigure: 47, // (PFS1 bytes) -> bool; attach/detach a slot cache.
  fontStreamRequests: 48, // () -> JSON of at most 32 [generation,slot,scalar] misses.
  fontStreamCommit: 49, // (PFG1 bytes) -> accepted count, at most four cells.
  fontStreamStats: 50, // () -> JSON: residency, visible misses, eviction counters.
  appClose: 51, // (output: string) -> 0|1. Native navigation only: request
  //                graceful closure of a configured child app. Never closes
  //                the shell or caller. Embedded hosts omit this operation.
} as const;

// ---------------------------------------------------------------------------
// Property ids (u8, stable, append-only within each group)
// ---------------------------------------------------------------------------
// Grouped with numeric gaps for growth:
//   1  .. 63   layout      (taffy inputs + display/overflow/z)
//   64 .. 95   visual      (paint-only box decoration)
//   96 .. 127  text        (font + text run styling)
//   128.. 159  transform   (paint-only, never relayouts)
// 0 is reserved (invalid). NEVER renumber a shipped id.

export const PROP = {
  // -- layout (1..63) --------------------------------------------------------
  width: 1, //          f32 px
  height: 2, //         f32 px
  minW: 3, //           f32 px
  minH: 4, //           f32 px
  maxW: 5, //           f32 px
  maxH: 6, //           f32 px
  paddingT: 8, //       f32 px
  paddingR: 9, //       f32 px
  paddingB: 10, //      f32 px
  paddingL: 11, //      f32 px
  marginT: 12, //       f32 px
  marginR: 13, //       f32 px
  marginB: 14, //       f32 px
  marginL: 15, //       f32 px
  gap: 16, //           f32 px (both axes)
  flexDir: 17, //       enum FlexDir
  justify: 18, //       enum Justify
  align: 19, //         enum Align (align-items)
  grow: 20, //          f32
  shrink: 21, //        f32
  basis: 22, //         f32 px
  flexWrap: 23, //      enum: 0 = nowrap, 1 = wrap
  posType: 24, //       enum PosType
  insetT: 25, //        f32 px (absolute positioning offsets)
  insetR: 26, //        f32 px
  insetB: 27, //        f32 px
  insetL: 28, //        f32 px
  display: 29, //       enum Display
  overflow: 30, //      enum Overflow (hidden => scissor in draw)
  zIndex: 31, //        i32 (paint order among siblings; layout-group id but paint-only)
  hitPass: 32, //       0|1. 1 = the node's OWN box never claims a hit (ink or
  //                    bounds walk alike); descendants are still tested — the
  //                    engine's pointer-events:none, self-only. The framework
  //                    marks its full-screen overlay/portal layers with it so
  //                    bounds hit facts (op 42) resolve through empty overlay
  //                    space to the app content beneath.

  // -- visual (64..95) -------------------------------------------------------
  bgColor: 64, //       color u32 ABGR
  gradFrom: 65, //      color u32 ABGR (gradient start; used when gradDir set)
  gradTo: 66, //        color u32 ABGR
  gradDir: 67, //       enum GradDir
  radius: 68, //        f32 px corner radius
  opacity: 69, //       f32 0..1 (multiplies subtree alpha per-vertex; see DESIGN punts)
  borderColor: 70, //   color u32 ABGR
  borderWidth: 71, //   f32 px — drawn INSET, purely visual, does NOT affect layout
  shadow: 72, //        i32 baked shadow index: 0 = none, 1 = shadow, 2 = md, 3 = lg
  // ids 73..76 reserved for per-corner radius (radiusTL/TR/BR/BL).
  //
  // Bevel rings — the classic-chrome (Win9x-era) 3D edge. Up to two nested
  // rings drawn INSET as plain rects (purely visual, never affects layout):
  // the OUTER ring hugs the border box, the INNER ring sits bevelWidth
  // inside it. Per ring, `light` paints the top+left strips and `dark` the
  // bottom+right strips; dark is emitted after light and runs the full edge
  // length, so DARK OWNS THE SHARED CORNERS (matches the 98.css box-shadow
  // stack order, where the dark shadow is listed first and paints on top).
  // Unset (alpha 0) colors emit nothing. Ignored when radius > 0 (bevels
  // are square by definition; the compiler rejects the combination).
  bevelOuterLight: 77, // color u32 ABGR
  bevelOuterDark: 78, //  color u32 ABGR
  bevelInnerLight: 79, // color u32 ABGR
  bevelInnerDark: 80, //  color u32 ABGR
  bevelWidth: 81, //      f32 px per ring (default 1)
  gradVia: 82, //         color u32 ABGR (optional middle gradient stop)
  gradViaPos: 83, //      f32 0..1; NAN = no middle stop

  // -- text (96..127) --------------------------------------------------------
  textColor: 96, //     color u32 ABGR
  fontSlot: 97, //      i32 baked atlas slot (see FONT_ATLAS)
  textAlign: 98, //     enum TextAlign
  lineHeight: 99, //    f32 px (overrides the atlas default)
  tracking: 100, //     f32 px extra advance per glyph

  // -- transform (128..159) — paint-only, never relayouts ---------------------
  translateX: 128, //   f32 px
  translateY: 129, //   f32 px
  scale: 130, //        f32 (1 = identity, about the transform origin)
  rotate: 131, //       f32 degrees (about the transform origin)
  scaleX: 132, //       f32 (1 = identity, about the transform origin)
  scaleY: 133, //       f32 (1 = identity, about the transform origin)
  originX: 134, //      f32 fraction of node width offsetting the transform
  //                    origin from the node center (-0.5 = left edge, 0 =
  //                    center, +0.5 = right edge). NOT animatable.
  originY: 135, //      f32 fraction of node height (-0.5 top .. +0.5 bottom)
  rotateX: 136, //      f32 degrees about the X axis (3D; needs a perspective root)
  rotateY: 137, //      f32 degrees about the Y axis (3D)
  translateZ: 138, //   f32 px along Z (+ toward the viewer; 3D)
  perspective: 139, //  f32 px perspective distance; > 0 makes this node a 3D
  //                    CONTEXT ROOT: its whole subtree composes 4x4 transforms
  //                    (implicit preserve-3d), projects through this distance
  //                    about the node center and painter-sorts by depth.
  //                    NOT animatable.

  // -- arc (paint-only annular sector; the "stroke arc" primitive) ------------
  arcStart: 140, //     f32 degrees, 0 = 12 o'clock, clockwise positive
  arcSweep: 141, //     f32 degrees of arc extent (negative = counterclockwise)
  arcWidth: 142, //     f32 px stroke thickness; > 0 (with sweep != 0) draws an
  //                    annular sector with ROUND CAPS instead of the bg box:
  //                    center = node center, outer radius = min(w,h)/2, color
  //                    = bgColor. Axis-aligned worlds only (rotation belongs
  //                    in arcStart).
} as const;

export type PropName = keyof typeof PROP;

// ---------------------------------------------------------------------------
// Animatable props + transition bit mapping
// ---------------------------------------------------------------------------
// ANIMATABLE is an ORDERED list: the index of a prop in this list is its
// "anim bit" — the bit used in the style-table transition `mask` (u32) and in
// core anim bookkeeping. Append-only; never reorder.
// Everything not listed here is NOT animatable (enums, focus, shadow index...).
//
// Entries at index >= 32 are BEYOND the u32 transition mask: they animate via
// baked keyframe timelines and the `animate()` op (both gate on the 256-bit
// ANIMATABLE_BITS set), but `transition-*` classes can never target them —
// the transition spawn loop skips bits >= 32.

export const ANIMATABLE: readonly PropName[] = [
  // bit 0..
  "width", //        0
  "height", //       1
  "paddingT", //     2
  "paddingR", //     3
  "paddingB", //     4
  "paddingL", //     5
  "marginT", //      6
  "marginR", //      7
  "marginB", //      8
  "marginL", //      9
  "gap", //         10
  "basis", //       11
  "insetT", //      12
  "insetR", //      13
  "insetB", //      14
  "insetL", //      15
  "bgColor", //     16  (colors lerp per ABGR channel)
  "gradFrom", //    17
  "gradTo", //      18
  "radius", //      19
  "opacity", //     20
  "borderColor", // 21
  "borderWidth", // 22
  "textColor", //   23
  "lineHeight", //  24
  "tracking", //    25
  "translateX", //  26
  "translateY", //  27
  "scale", //       28
  "rotate", //      29
  "scaleX", //      30
  "scaleY", //      31
  // -- timeline/animate()-only from here on (no transition-mask bit) ---------
  "rotateX", //     32
  "rotateY", //     33
  "translateZ", //  34
  "arcStart", //    35
  "arcSweep", //    36
  "arcWidth", //    37
];

/** Anim bit index for a prop, or -1 if not animatable. */
export function animBit(prop: PropName): number {
  return ANIMATABLE.indexOf(prop);
}

/** Transition mask value meaning "every animatable prop" (transition-all). */
export const TRANSITION_MASK_ALL = 0xffffffff;

// Props whose change invalidates layout (taffy re-run + text re-measure).
// Everything else is paint-only (redraw, no relayout).
//   - zIndex is paint-only despite living in the layout id group.
//   - borderWidth is paint-only (border draws inset).
//   - textAlign/lineHeight/tracking/fontSlot re-run the inline text layout
//     (fontSlot/lineHeight/tracking also change measured size).
export const LAYOUT_DIRTYING: readonly PropName[] = [
  "width", "height", "minW", "minH", "maxW", "maxH",
  "paddingT", "paddingR", "paddingB", "paddingL",
  "marginT", "marginR", "marginB", "marginL",
  "gap", "flexDir", "justify", "align", "grow", "shrink", "basis", "flexWrap",
  "posType", "insetT", "insetR", "insetB", "insetL", "display", "overflow",
  "fontSlot", "textAlign", "lineHeight", "tracking",
];

// ---------------------------------------------------------------------------
// Prop value encoding
// ---------------------------------------------------------------------------
// Every prop value travels as ONE u32 (style table records) or one f64 that
// carries the same u32/f32 payload (setProp / animate). The kind pins how the
// u32 is interpreted:

export const VALUE_KIND = {
  /** IEEE-754 f32 bits (dimensions, scalars, degrees). */
  f32: 0,
  /** Packed color, u32 ABGR (0xAABBGGRR). */
  color: 1,
  /** Plain integer / enum ordinal stored as u32. */
  int: 2,
} as const;

export const PROP_VALUE_KIND: Record<PropName, number> = {
  width: VALUE_KIND.f32, height: VALUE_KIND.f32,
  minW: VALUE_KIND.f32, minH: VALUE_KIND.f32,
  maxW: VALUE_KIND.f32, maxH: VALUE_KIND.f32,
  paddingT: VALUE_KIND.f32, paddingR: VALUE_KIND.f32,
  paddingB: VALUE_KIND.f32, paddingL: VALUE_KIND.f32,
  marginT: VALUE_KIND.f32, marginR: VALUE_KIND.f32,
  marginB: VALUE_KIND.f32, marginL: VALUE_KIND.f32,
  gap: VALUE_KIND.f32,
  flexDir: VALUE_KIND.int, justify: VALUE_KIND.int, align: VALUE_KIND.int,
  grow: VALUE_KIND.f32, shrink: VALUE_KIND.f32, basis: VALUE_KIND.f32,
  flexWrap: VALUE_KIND.int, posType: VALUE_KIND.int,
  insetT: VALUE_KIND.f32, insetR: VALUE_KIND.f32,
  insetB: VALUE_KIND.f32, insetL: VALUE_KIND.f32,
  display: VALUE_KIND.int, overflow: VALUE_KIND.int, zIndex: VALUE_KIND.int,
  hitPass: VALUE_KIND.int,
  bgColor: VALUE_KIND.color, gradFrom: VALUE_KIND.color, gradTo: VALUE_KIND.color,
  gradDir: VALUE_KIND.int, radius: VALUE_KIND.f32, opacity: VALUE_KIND.f32,
  borderColor: VALUE_KIND.color, borderWidth: VALUE_KIND.f32,
  shadow: VALUE_KIND.int,
  bevelOuterLight: VALUE_KIND.color, bevelOuterDark: VALUE_KIND.color,
  bevelInnerLight: VALUE_KIND.color, bevelInnerDark: VALUE_KIND.color,
  bevelWidth: VALUE_KIND.f32,
  gradVia: VALUE_KIND.color, gradViaPos: VALUE_KIND.f32,
  textColor: VALUE_KIND.color, fontSlot: VALUE_KIND.int,
  textAlign: VALUE_KIND.int, lineHeight: VALUE_KIND.f32, tracking: VALUE_KIND.f32,
  translateX: VALUE_KIND.f32, translateY: VALUE_KIND.f32,
  scale: VALUE_KIND.f32, rotate: VALUE_KIND.f32,
  scaleX: VALUE_KIND.f32, scaleY: VALUE_KIND.f32,
  originX: VALUE_KIND.f32, originY: VALUE_KIND.f32,
  rotateX: VALUE_KIND.f32, rotateY: VALUE_KIND.f32,
  translateZ: VALUE_KIND.f32, perspective: VALUE_KIND.f32,
  arcStart: VALUE_KIND.f32, arcSweep: VALUE_KIND.f32, arcWidth: VALUE_KIND.f32,
};

// ---------------------------------------------------------------------------
// Style/layout enums (ordinals are the wire values — append-only)
// ---------------------------------------------------------------------------
// gen-rust.ts turns each entry into a #[repr(u8)] Rust enum of the same name.

export const ENUMS = {
  FlexDir: { Row: 0, Col: 1 },
  Justify: { Start: 0, Center: 1, End: 2, Between: 3, Around: 4 },
  Align: { Start: 0, Center: 1, End: 2, Stretch: 3 },
  PosType: { Relative: 0, Absolute: 1 },
  Display: { Flex: 0, None: 1 },
  Overflow: { Visible: 0, Hidden: 1 },
  TextAlign: { Left: 0, Center: 1, Right: 2 },
  /** Gradient direction: `bg-gradient-to-t|b|l|r`. */
  GradDir: { ToTop: 0, ToBottom: 1, ToLeft: 2, ToRight: 3 },
  /**
   * Animation easing. Spring/SpringBouncy ignore durMs (physics decide);
   * OutBack overshoots ~10%. All tick at fixed dt = 1/60 s.
   * CubicBezier is only valid inside baked animation segments (the four
   * control values ride along in the segment record — see ANIM TABLE); the
   * `animate()` op rejects it.
   */
  Easing: {
    Linear: 0, EaseIn: 1, EaseOut: 2, EaseInOut: 3,
    OutBack: 4, Spring: 5, SpringBouncy: 6, CubicBezier: 7,
  },
} as const;

// ---------------------------------------------------------------------------
// PSM texture pixel formats
// ---------------------------------------------------------------------------
// Values MUST equal rust-psp's TexturePixelFormat (sceGuTexMode arg), as used
// by the dreamcart runtime — verified against rust-psp/psp/src/sys/gu.rs
// (Psm5650 = 0, Psm4444 = 2, Psm8888 = 3) and runtime/src/gfx3d.rs
// psm_for().

export const PSM = {
  PSM_5650: 0, // RGB 565, 16-bit (B5:G6:R5 bit order)
  PSM_4444: 2, // RGBA 4444, 16-bit
  PSM_8888: 3, // RGBA 8888, 32-bit
  PSM_T8: 5, //   CLUT8: one palette index/px + a 256 x u32 ABGR palette
  //              (rust-psp TexturePixelFormat::PsmT8 — the GE CLUT8 mode).
  //              upload_texture data layout: 1024-byte palette, then w*h
  //              index bytes. 4x smaller than 8888 — the tile-canvas format.
} as const;

/** Textures must be power-of-two and no larger than this per side. */
export const TEX_MAX_DIM = 512;

// Texture handles are generation-tagged like node ids:
//   handle = (generation << TEX_SLOT_BITS) | slot, bit 31 stays 0.
// `freeTexture` bumps the slot's generation, so a stale handle held by JS (or
// by a still-mounted image node) resolves to nothing and draws nothing —
// instead of silently sampling whatever texture reused the slot. Slots are
// reused LIFO via a free list.
export const TEX_SLOT_BITS = 20;
export const TEX_SLOT_MASK = 0xfffff;

// ---------------------------------------------------------------------------
// IMG entry flags (framework/compiler/pak.ts IMG entry, byte 5 — was reserved/0)
// ---------------------------------------------------------------------------
// v1 wrote 0 there, so v1 blobs decode identically under v2 rules.
//   bit 0  IMG_FLAG_RLE     pixel stream is PackBits-RLE (below)
//   bit 1  IMG_FLAG_LINEAR  sample with bilinear filtering (default nearest)

export const IMG_FLAG_RLE = 1 << 0;
export const IMG_FLAG_LINEAR = 1 << 1;

// PackBits-style byte RLE (the only compression the runtime knows):
//   control byte c < 128  -> copy the next c+1 literal bytes
//   control byte c >= 128 -> repeat the next byte (c - 126) times  [2..129]
// Decoded length must equal the expected pixel-stream size exactly.

/** Encode bytes with the runtime's PackBits RLE (compiler-side). */
export function packbitsEncode(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < src.length) {
    // find run length at i
    let run = 1;
    while (run < 129 && i + run < src.length && src[i + run] === src[i]) run++;
    if (run >= 2) {
      out.push(126 + run, src[i]);
      i += run;
      continue;
    }
    // literal stretch: until the next run of >= 3 (2-runs are cheaper literal)
    let end = i + 1;
    while (end < src.length && end - i < 128) {
      let r = 1;
      while (r < 3 && end + r < src.length && src[end + r] === src[end]) r++;
      if (r >= 3) break;
      end++;
    }
    out.push(end - i - 1);
    for (let k = i; k < end; k++) out.push(src[k]);
    i = end;
  }
  return new Uint8Array(out);
}

/** Decode the runtime's PackBits RLE. Returns null on malformed input. */
export function packbitsDecode(src: Uint8Array, expectedLen: number): Uint8Array | null {
  const out = new Uint8Array(expectedLen);
  let i = 0;
  let o = 0;
  while (i < src.length) {
    const c = src[i++];
    if (c < 128) {
      const n = c + 1;
      if (i + n > src.length || o + n > expectedLen) return null;
      out.set(src.subarray(i, i + n), o);
      i += n;
      o += n;
    } else {
      const n = c - 126;
      if (i >= src.length || o + n > expectedLen) return null;
      out.fill(src[i++], o, o + n);
      o += n;
    }
  }
  return o === expectedLen ? out : null;
}

// ---------------------------------------------------------------------------
// TILESET pak entry — a deep-zoom tile grid (one entry per page per mip level)
// ---------------------------------------------------------------------------
// Baked by a cooker (e.g. apps/zoomlab/gen-assets.ts), consumed one tile at a
// time by the `loadTileTexture` op. All tiles of one entry share ONE palette,
// so per-tile overhead is just the directory entry; whitespace costs nothing
// (solid tiles are encoded in the directory and drawn as plain RECTs).
//
//   Header (32 bytes):
//     off 0  u32  magic      = 0x53544b50  bytes 'P','K','T','S'
//     off 4  u16  version    = 1
//     off 6  u16  flags      bit 0 = pixel streams are PackBits-RLE
//                            bit 1 = sample with bilinear filtering
//     off 8  u16  tileW      (pow2 <= TEX_MAX_DIM)
//     off 10 u16  tileH
//     off 12 u16  cols
//     off 14 u16  rows
//     off 16 u32  paletteOff 1024 bytes, 256 x u32 ABGR
//     off 20 u32  dirOff     cols*rows x 8-byte entries, row-major
//     off 24 u32  dataOff
//     off 28 u32  reserved (0)
//
//   Dir entry (tile i at x = i % cols, y = floor(i / cols)):
//     +0  u32  off   TILESET_ABSENT = tile has no content (transparent — the
//                    canvas background shows through; loadTileTexture -> -1);
//                    if len == 0 (and off != ABSENT): SOLID tile, off is the
//                    palette index of its uniform color;
//                    else: pixel-stream byte offset relative to dataOff.
//     +4  u32  len   pixel-stream byte length (0 = solid/absent).
//
//   Pixel stream: tileW*tileH CLUT8 palette indices, raw, or PackBits-RLE
//   when flags bit 0 is set.

export const TILESET_MAGIC = 0x53544b50; // 'PKTS' LE
export const TILESET_VERSION = 1;
export const TILESET_HEADER_SIZE = 32;
export const TILESET_DIR_ENTRY_SIZE = 8;
export const TILESET_ABSENT = 0xffffffff;
export const TILESET_FLAG_RLE = 1 << 0;
export const TILESET_FLAG_LINEAR = 1 << 1;

/** Pak key family for TILESET entries. NOT fed to the core at boot — tiles
 *  stream on demand through the loadTileTexture op. */
export const keyTileset = (name: string): string => `ui:tile.${name}`;

// ---------------------------------------------------------------------------
// SVC — the host service channel (tethered companion apps)
// ---------------------------------------------------------------------------
// A companion process on the tethered machine shares a directory with the
// device (PSPLINK usbhostfs `host0:`, or the memstick root under PPSSPP) and
// speaks the DevTools mailbox split: control as JSON lines, bulk bytes as
// side files. Per app:
//
//   <root>/pocket-svc/<app>/enable    host creates; device probes at svcOpen
//   <root>/pocket-svc/<app>/in.jsonl  host -> device (appended lines)
//   <root>/pocket-svc/<app>/out.jsonl device -> host (appended lines)
//
// plus whatever side files the app's protocol names (IMG entries for
// loadImgFile, .pkst streams for videoOpen) — always svc-dir-relative paths;
// the device never opens a path outside its svc directory.

export const SVC_DIR = "pocket-svc";
/** Max bytes consumed per svcPoll (longer backlogs drain over later polls). */
export const SVC_POLL_BUF = 8192;
/** loadImgFile refuses IMG entries larger than this (they'd stall the frame —
 *  bigger assets belong in the pak or a stream). */
export const SVC_IMG_MAX_BYTES = 128 * 1024;

// ---------------------------------------------------------------------------
// STREAM container (.pkst) — a host-written video+audio ring file
// ---------------------------------------------------------------------------
// One concurrently-written file: the host (writer) appends-in-place into two
// fixed-slot rings and only THEN advances the ring's latestSeq in the header
// block, so the device (reader) never observes a half-written frame it was
// told about. The device re-checks a slot's embedded seq after reading its
// pixels — a slot the writer lapped is discarded, not presented. All offsets
// are from the start of the file; everything little-endian.
//
//   Stream header (32 bytes at off 0):
//     off 0  u32  magic     = 0x54534b50  bytes 'P','K','S','T'
//     off 4  u16  version   = 1
//     off 6  u16  flags     bit 0 = ended (source exhausted; latestSeq final)
//     off 8  u32  epoch     bumped by the writer on any discontinuity (seek,
//                           new source). The reader drops its ring positions
//                           and re-syncs to latest on a change.
//     off 12 u32  videoOff  byte offset of video slot 0 (16-aligned)
//     off 16 u32  audioOff  byte offset of audio chunk 0 (16-aligned)
//     off 20 u8[12] reserved (0)
//
//   Video ring header (32 bytes at off 32):
//     off 32 u32  magic     = 0x52564b50  bytes 'P','K','V','R'
//     off 36 u16  w         frame width  (pow2 <= TEX_MAX_DIM — the plane
//     off 38 u16  h         frame height  texture IS the frame, no crop rect;
//                           the host letterboxes/pre-squashes into w x h for
//                           the target viewport's stretch)
//     off 40 u16  fpsNum    nominal source rate (e.g. 15/1, 30000/1001);
//     off 42 u16  fpsDen    frameIndex / (fpsNum/fpsDen) = source seconds
//     off 44 u32  slotCount
//     off 48 u32  slotSize  = STREAM_SLOT_HEADER_SIZE + 1024 + w*h, 16-aligned
//     off 52 u32  latestSeq newest fully-written frame; 0 = none yet. Seq
//                           starts at 1; slot index = (seq-1) % slotCount.
//     off 56 u32  totalFrames source length in frames (0 = unknown/live)
//     off 60 u32  reserved (0)
//
//   Audio ring header (32 bytes at off 64):
//     off 64 u32  magic       = 0x52414b50  bytes 'P','K','A','R'
//     off 68 u32  sampleRate  (22050 is the tuned USB default)
//     off 72 u16  channels    (1 | 2; s16 interleaved)
//     off 74 u16  reserved (0)
//     off 76 u32  chunkFrames sample frames per chunk
//     off 80 u32  chunkCount
//     off 84 u32  latestSeq   newest fully-written chunk; 0 = none. Seq starts
//                             at 1; chunk index = (seq-1) % chunkCount.
//     off 88 u8[8] reserved (0)
//
//   The reader polls one 96-byte header-block read per tick.
//
//   Video slot (at videoOff + ((seq-1) % slotCount) * slotSize):
//     off 0  u32  seq        re-read after the pixel read: changed = lapped,
//                            discard (never present a torn frame)
//     off 4  u32  frameIndex source frame index (monotonic; the host may skip
//                            indices when it adapts its rate)
//     off 8  u16  w          must equal the ring header's w/h
//     off 10 u16  h
//     off 12 u8[20] reserved (0)
//     off 32 u8[1024]  palette, 256 x u32 ABGR
//     off 1056 u8[w*h] CLUT8 indices, row-major, raw (fixed-size slots make
//                      the reader's chunked-read plan trivial; RLE would not
//                      survive a fixed slot anyway)
//
//   Audio chunk (at audioOff + ((seq-1) % chunkCount) * chunkSize where
//   chunkSize = STREAM_CHUNK_HEADER_SIZE + chunkFrames*channels*2):
//     off 0  u32  seq
//     off 4  u32  startFrame position of the chunk's first sample frame on
//                           the source timeline (seek resets it with epoch)
//     off 8  u8[8] reserved (0)
//     off 16 s16[chunkFrames*channels] PCM, interleaved

export const STREAM_MAGIC = 0x54534b50; // 'PKST' LE
export const STREAM_VERSION = 1;
export const STREAM_HEADER_SIZE = 32;
export const STREAM_VRING_MAGIC = 0x52564b50; // 'PKVR' LE
export const STREAM_VRING_OFF = 32;
export const STREAM_ARING_MAGIC = 0x52414b50; // 'PKAR' LE
export const STREAM_ARING_OFF = 64;
/** One header-block read covers all three headers. */
export const STREAM_HEADER_BLOCK_SIZE = 96;
export const STREAM_SLOT_HEADER_SIZE = 32;
export const STREAM_CHUNK_HEADER_SIZE = 16;
export const STREAM_FLAG_ENDED = 1 << 0;

// ---------------------------------------------------------------------------
// SVC WIRE protocol (PKNT) — the svc mailbox over a socket
// ---------------------------------------------------------------------------
// The PSP reaches its companion host through PSPLINK's usbhostfs file share
// (SVC above); hosts without a shared filesystem (the Vita, over WiFi) speak
// the SAME mailbox + side-file + .pkst semantics over one TCP connection.
// One connection on purpose: TCP ordering is load-bearing — STREAM_OPEN
// precedes the JSON line announcing it, FILE pushes precede the results line
// that references them — and a second channel would reintroduce exactly the
// cross-channel races the file transport never had.
//
// Discovery: the host broadcasts a UDP beacon once a second on
// WIRE_BEACON_PORT; the datagram's SOURCE ADDRESS is the connect target.
//
//   Beacon datagram:
//     off 0  u32  magic    = 0x42444b50  bytes 'P','K','D','B'
//     off 4  u8   version  = WIRE_VERSION
//     off 5  u8   reserved (0)
//     off 6  u16  tcpPort  the WIRE listener's port
//     off 8  u8   appLen, then app id bytes (the pocket-svc app segment)
//     ...    u8   nameLen, then a display name (<= 32 bytes, for pickers)
//
// Handshake (before any frame):
//   device -> host:  u32 magic 'PKNT' · u8 version · u8 reserved ·
//                    u8 appLen · app id bytes
//   host -> device:  u32 magic 'PKNT' · u8 acceptedVersion · u8 flags (0) ·
//                    u16 reserved
// A magic/version/app mismatch closes the socket.
//
// Every subsequent message, both directions, is one frame:
//
//   Frame header (WIRE_HEADER_SIZE = 8 bytes):
//     off 0  u8   type      (WIRE_MSG)
//     off 1  u8   flags     type-specific (see below)
//     off 2  u16  reserved (0)
//     off 4  u32  payloadLen (<= WIRE_MAX_PAYLOAD; oversize closes the socket)
//
// Types (unknown types are skipped by length — forward compatible):
//   ping (h->d)        u32 token, every ~2 s; either side drops the
//   pong (d->h)        connection after ~10 s of silence. Pong echoes.
//   ctrl (both)        one UTF-8 JSON line, no trailing \n — the in.jsonl /
//                      out.jsonl mailbox semantics (<= SVC_POLL_BUF bytes).
//   file (h->d)        u16 pathLen · path (svc-relative, side_path rules) ·
//                      whole IMG-entry bytes (<= SVC_IMG_MAX_BYTES). Pushed
//                      PROACTIVELY before the ctrl line that references it,
//                      so a synchronous loadImgFile hits a warm device cache.
//   streamOpen (h->d)  u16 pathLen · path (what the announce line will name)
//                      · the verbatim 96-byte .pkst header block. The device
//                      allocates a RAM ring image (stream_rx.rs) — every
//                      streamOpen is a full ring reset.
//   streamClose (h->d) empty payload.
//   videoSlot (h->d)   u32 seq · u32 frameIndex · u16 w · u16 h ·
//                      u16 flags (bit 0 = indices PackBits-RLE) · u16 rsv ·
//                      u8[1024] palette · indices (raw w*h, or RLE decoding
//                      to exactly w*h). Applied payload-first, seq-published-
//                      after into the RAM ring, preserving the .pkst torn-
//                      frame contract verbatim.
//   audioChunk (h->d)  u32 seq · u32 startFrame · s16 PCM, exactly
//                      chunkFrames*channels samples.
//   streamMark (h->d)  u32 epoch · u16 flags (bit 0 = ended) · u16 reserved —
//                      carries bumpEpoch()/markEnded() into the ring header.

export const WIRE_MAGIC = 0x544e4b50; // 'PKNT' LE
export const WIRE_BEACON_MAGIC = 0x42444b50; // 'PKDB' LE
export const WIRE_VERSION = 1;
export const WIRE_HEADER_SIZE = 8;
export const WIRE_MAX_PAYLOAD = 256 * 1024;
/** UDP discovery beacon (host broadcasts; device listens). */
export const WIRE_BEACON_PORT = 8621;
/** The host's TCP listener for the framed protocol. */
export const WIRE_PORT = 8622;
export const WIRE_MSG = {
  ping: 0x01,
  pong: 0x02,
  ctrl: 0x10,
  file: 0x20,
  streamOpen: 0x30,
  streamClose: 0x31,
  videoSlot: 0x32,
  audioChunk: 0x33,
  streamMark: 0x34,
} as const;
/** videoSlot leading fields (seq..reserved) — the palette follows. */
export const WIRE_SLOT_HEADER_SIZE = 16;
export const WIRE_CHUNK_HEADER_SIZE = 8;
export const WIRE_MARK_SIZE = 8;
export const WIRE_SLOT_FLAG_RLE = 1 << 0;
export const WIRE_MARK_FLAG_ENDED = 1 << 0;

// ---------------------------------------------------------------------------
// Font slots
// ---------------------------------------------------------------------------
// A "font slot" is one baked (family-weight, px) atlas. The compiler derives
// the slot list from the text-size utilities used (12/14/16/18/20/24/36 px,
// regular + bold — see docs/DESIGN.md). Slot indices are assigned by the build and
// carried in each atlas header; the core just indexes a table.

// 0..6 regular / 7..13 bold (FONT_PX sizes), 14/15 the 54 px display pair,
// 16..18 monospace regular (12/14/16 px — `font-mono`, code spans).
export const MAX_FONT_SLOTS = 24;

// ---------------------------------------------------------------------------
// STYLE TABLE binary format — styles.bin  (version 2)
// ---------------------------------------------------------------------------
// Compiled by framework/compiler/tailwind.ts; parsed by engine/core/src/style.rs and (for
// tests) by decodeStyleTable below. Little-endian. Records are variable-size
// and written back-to-back with NO padding between fields or records; readers
// must use unaligned LE reads.
//
//   Header (12 bytes):
//     off 0  u32  magic      = 0x54534344  bytes 'D','C','S','T'
//     off 4  u16  version    = 2
//     off 6  u16  styleCount
//     off 8  u16  animCount  baked animation timelines (ANIM TABLE below)
//     off 10 u16  reserved   (0)
//
//   Then styleCount records, back-to-back. styleId = record index (0-based).
//
//   Record:
//     off 0  u8   flags
//              bit 0  STYLE_VARIANT_BASE    base variant present
//              bit 1  STYLE_VARIANT_FOCUS   focus: variant present
//              bit 2  STYLE_VARIANT_ACTIVE  active: variant present
//              bit 3  STYLE_HAS_TRANSITION  transition block present
//              bit 4  STYLE_HAS_ANIMATION   animation block present
//              bits 5-7 reserved (0)
//     [if STYLE_HAS_TRANSITION] transition block (12 bytes):
//       +0  u32  mask     anim-bit mask of props that transition (see
//                         ANIMATABLE order; TRANSITION_MASK_ALL = all)
//       +4  u16  durMs
//       +6  u16  delayMs
//       +8  u8   easing   (ENUMS.Easing ordinal)
//       +9  u8[3] reserved (0)
//     [if STYLE_HAS_ANIMATION] animation block (3 + 2n bytes):
//       +0  u8   animRefCount (n >= 1; CSS comma-list order — later entries
//                              override earlier ones while both write a prop)
//       +1  u16  loopFrames   whole-choreography loop period in frames; the
//                             node's animation clock wraps modulo this. 0 =
//                             play once (CSS semantics: fills decide the end
//                             state). This is the PocketJS `animate-loop-[..]`
//                             extension — plain CSS cannot loop a multi-
//                             animation choreography without a remount.
//       then n x u16 animId (index into the ANIM TABLE)
//     Then, for each PRESENT variant in order base, focus, active:
//       +0  u8   propCount
//       then propCount x 6-byte prop records:
//         +0  u8   propId    (PROP value)
//         +1  u8   reserved  (0)
//         +2  u32  value     (per PROP_VALUE_KIND: f32 bits | ABGR | int)
//
// ---------------------------------------------------------------------------
// ANIM TABLE — baked keyframe timelines (appended after the style records)
// ---------------------------------------------------------------------------
// The compiler bakes each `theme.animation` entry (one CSS `animation`
// shorthand: keyframes x duration/easing/delay/fill/direction/iterations)
// into per-prop SEGMENT lists with frame-precise endpoints (60 Hz fixed dt),
// so the core never sees percentages, calc() or cubic-bezier strings — only
// "prop P goes from bits A to bits B over frames [t0, t1) under easing E".
//
//   animCount entries, back-to-back. animId = entry index (0-based).
//
//   Anim entry:
//     +0  u16  delayFrames   frames to wait after the node's animation clock
//                            starts (style applied / loop wrap)
//     +2  u16  periodFrames  one iteration's length in frames (>= 1)
//     +4  u16  iterations    0 = infinite
//     +6  u8   fill          bit 0 ANIM_FILL_BACKWARDS (apply first-frame
//                            values during the delay — CSS backwards/both),
//                            bit 1 ANIM_FILL_FORWARDS (hold final values
//                            after the last iteration — CSS forwards/both)
//     +7  u8   trackCount
//     then trackCount x Track:
//       +0  u8   propId      (PROP value; must be ANIMATABLE)
//       +1  u8   segCount    (>= 1)
//       then segCount x Segment (14 bytes, +16 when easing == CubicBezier):
//         +0  u16  t0        segment start frame (within the iteration)
//         +2  u16  t1        segment end frame (t1 > t0)
//         +4  u32  from      raw payload (f32 bits | ABGR per the prop kind)
//         +8  u32  to
//         +12 u8   easing    ENUMS.Easing ordinal (CubicBezier = params follow)
//         +13 u8   reserved  (0)
//         [if easing == CubicBezier] 4 x u32: x1, y1, x2, y2 as f32 bits
//
// Segments are sorted by t0 and non-overlapping per track. Between segments
// the value holds at the previous segment's `to`; before the first segment it
// holds at segments[0].from; after the last it holds at last.to.

export const STYLE_MAGIC = 0x54534344; // 'DCST' LE
export const STYLE_VERSION = 2;
export const STYLE_HEADER_SIZE = 12;
export const STYLE_TRANSITION_SIZE = 12;
export const STYLE_PROP_RECORD_SIZE = 6;

export const STYLE_VARIANT_BASE = 1 << 0;
export const STYLE_VARIANT_FOCUS = 1 << 1;
export const STYLE_VARIANT_ACTIVE = 1 << 2;
export const STYLE_HAS_TRANSITION = 1 << 3;
export const STYLE_HAS_ANIMATION = 1 << 4;

export const ANIM_ENTRY_HEADER_SIZE = 8;
export const ANIM_SEGMENT_SIZE = 14;
export const ANIM_BEZIER_EXTRA_SIZE = 16;
export const ANIM_FILL_BACKWARDS = 1 << 0;
export const ANIM_FILL_FORWARDS = 1 << 1;

// ---- style table TS encoder/decoder (used by compiler + tests) ------------

export interface StyleProp {
  /** PROP id. */
  prop: number;
  /** Raw u32 payload (use f32Bits()/abgr() helpers to build it). */
  value: number;
}

export interface StyleTransition {
  /** Anim-bit mask (TRANSITION_MASK_ALL for transition-all). */
  mask: number;
  durMs: number;
  delayMs: number;
  /** ENUMS.Easing ordinal. */
  easing: number;
}

export interface StyleAnimation {
  /** ANIM TABLE indices, CSS comma-list order (later wins while writing). */
  anims: number[];
  /** Whole-choreography loop period in frames (0 = play once). */
  loopFrames: number;
}

export interface StyleRecord {
  base?: StyleProp[];
  focus?: StyleProp[];
  active?: StyleProp[];
  transition?: StyleTransition;
  animation?: StyleAnimation;
}

/** One baked animation segment: prop goes from→to over frames [t0, t1). */
export interface AnimSegment {
  t0: number;
  t1: number;
  /** Raw u32 payloads (f32Bits()/abgr()). */
  from: number;
  to: number;
  /** ENUMS.Easing ordinal. */
  easing: number;
  /** cubic-bezier(x1, y1, x2, y2) — required iff easing == CubicBezier. */
  bezier?: [number, number, number, number];
}

export interface AnimTrack {
  /** PROP id (must be ANIMATABLE). */
  prop: number;
  /** Sorted by t0, non-overlapping. */
  segments: AnimSegment[];
}

/** One baked timeline (one CSS animation shorthand entry). */
export interface AnimTimeline {
  delayFrames: number;
  periodFrames: number;
  /** 0 = infinite. */
  iterations: number;
  /** ANIM_FILL_BACKWARDS | ANIM_FILL_FORWARDS. */
  fill: number;
  tracks: AnimTrack[];
}

/** IEEE-754 f32 bits of a number, as u32 (round-trips through Math.fround). */
export function f32Bits(n: number): number {
  const buf = new DataView(new ArrayBuffer(4));
  buf.setFloat32(0, n, true);
  return buf.getUint32(0, true);
}

/** f32 value from its u32 bits (inverse of f32Bits). */
export function bitsF32(bits: number): number {
  const buf = new DataView(new ArrayBuffer(4));
  buf.setUint32(0, bits >>> 0, true);
  return buf.getFloat32(0, true);
}

/** Pack a color as u32 ABGR (0xAABBGGRR), the GE COLOR_8888 layout. */
export function abgr(r: number, g: number, b: number, a = 255): number {
  return (((a & 255) << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255)) >>> 0;
}

/** Byte size of one baked segment (bezier params ride inline). */
function segmentSize(seg: AnimSegment): number {
  return ANIM_SEGMENT_SIZE + (seg.easing === ENUMS.Easing.CubicBezier ? ANIM_BEZIER_EXTRA_SIZE : 0);
}

/** Encode a style table (+ baked animation timelines) to styles.bin bytes. */
export function encodeStyleTable(
  styles: readonly StyleRecord[],
  anims: readonly AnimTimeline[] = [],
): Uint8Array {
  if (styles.length > 0xffff) throw new Error("styles.bin: too many styles");
  if (anims.length > 0xffff) throw new Error("styles.bin: too many animations");
  // size pass
  let size = STYLE_HEADER_SIZE;
  for (const s of styles) {
    size += 1; // flags
    if (s.transition) size += STYLE_TRANSITION_SIZE;
    if (s.animation) {
      if (s.animation.anims.length === 0 || s.animation.anims.length > 0xff) {
        throw new Error("styles.bin: animation block needs 1..255 anim refs");
      }
      size += 3 + s.animation.anims.length * 2;
    }
    for (const v of [s.base, s.focus, s.active]) {
      if (!v) continue;
      if (v.length > 0xff) throw new Error("styles.bin: >255 props in a variant");
      size += 1 + v.length * STYLE_PROP_RECORD_SIZE;
    }
  }
  for (const a of anims) {
    if (a.tracks.length > 0xff) throw new Error("styles.bin: >255 tracks in an animation");
    size += ANIM_ENTRY_HEADER_SIZE;
    for (const t of a.tracks) {
      if (t.segments.length === 0 || t.segments.length > 0xff) {
        throw new Error("styles.bin: animation track needs 1..255 segments");
      }
      size += 2;
      for (const seg of t.segments) size += segmentSize(seg);
    }
  }
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, STYLE_MAGIC, true);
  dv.setUint16(4, STYLE_VERSION, true);
  dv.setUint16(6, styles.length, true);
  dv.setUint16(8, anims.length, true);
  // off 10 reserved, already 0
  let o = STYLE_HEADER_SIZE;
  for (const s of styles) {
    let flags = 0;
    if (s.base) flags |= STYLE_VARIANT_BASE;
    if (s.focus) flags |= STYLE_VARIANT_FOCUS;
    if (s.active) flags |= STYLE_VARIANT_ACTIVE;
    if (s.transition) flags |= STYLE_HAS_TRANSITION;
    if (s.animation) flags |= STYLE_HAS_ANIMATION;
    out[o++] = flags;
    if (s.transition) {
      dv.setUint32(o, s.transition.mask >>> 0, true);
      dv.setUint16(o + 4, s.transition.durMs, true);
      dv.setUint16(o + 6, s.transition.delayMs, true);
      out[o + 8] = s.transition.easing & 0xff;
      // +9..+12 reserved, already 0
      o += STYLE_TRANSITION_SIZE;
    }
    if (s.animation) {
      out[o] = s.animation.anims.length;
      dv.setUint16(o + 1, s.animation.loopFrames, true);
      o += 3;
      for (const id of s.animation.anims) {
        if (id < 0 || id >= anims.length) throw new Error(`styles.bin: bad anim id ${id}`);
        dv.setUint16(o, id, true);
        o += 2;
      }
    }
    for (const v of [s.base, s.focus, s.active]) {
      if (!v) continue;
      out[o++] = v.length;
      for (const p of v) {
        out[o] = p.prop & 0xff;
        out[o + 1] = 0;
        dv.setUint32(o + 2, p.value >>> 0, true);
        o += STYLE_PROP_RECORD_SIZE;
      }
    }
  }
  for (const a of anims) {
    dv.setUint16(o, a.delayFrames, true);
    dv.setUint16(o + 2, a.periodFrames, true);
    dv.setUint16(o + 4, a.iterations, true);
    out[o + 6] = a.fill & 0xff;
    out[o + 7] = a.tracks.length;
    o += ANIM_ENTRY_HEADER_SIZE;
    for (const t of a.tracks) {
      out[o] = t.prop & 0xff;
      out[o + 1] = t.segments.length;
      o += 2;
      for (const seg of t.segments) {
        dv.setUint16(o, seg.t0, true);
        dv.setUint16(o + 2, seg.t1, true);
        dv.setUint32(o + 4, seg.from >>> 0, true);
        dv.setUint32(o + 8, seg.to >>> 0, true);
        out[o + 12] = seg.easing & 0xff;
        out[o + 13] = 0;
        o += ANIM_SEGMENT_SIZE;
        if (seg.easing === ENUMS.Easing.CubicBezier) {
          const bz = seg.bezier;
          if (!bz) throw new Error("styles.bin: CubicBezier segment without params");
          for (let i = 0; i < 4; i++) dv.setUint32(o + i * 4, f32Bits(bz[i]), true);
          o += ANIM_BEZIER_EXTRA_SIZE;
        }
      }
    }
  }
  return out;
}

export interface DecodedStyleTable {
  styles: StyleRecord[];
  anims: AnimTimeline[];
}

/** Decode styles.bin (round-trips encodeStyleTable; used by tests). */
export function decodeStyleTable(bytes: Uint8Array): DecodedStyleTable {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== STYLE_MAGIC) throw new Error("styles.bin: bad magic");
  if (dv.getUint16(4, true) !== STYLE_VERSION) throw new Error("styles.bin: bad version");
  const count = dv.getUint16(6, true);
  const animCount = dv.getUint16(8, true);
  const styles: StyleRecord[] = [];
  let o = STYLE_HEADER_SIZE;
  for (let i = 0; i < count; i++) {
    const flags = bytes[o++];
    const s: StyleRecord = {};
    if (flags & STYLE_HAS_TRANSITION) {
      s.transition = {
        mask: dv.getUint32(o, true),
        durMs: dv.getUint16(o + 4, true),
        delayMs: dv.getUint16(o + 6, true),
        easing: bytes[o + 8],
      };
      o += STYLE_TRANSITION_SIZE;
    }
    if (flags & STYLE_HAS_ANIMATION) {
      const n = bytes[o];
      const loopFrames = dv.getUint16(o + 1, true);
      o += 3;
      const ids: number[] = [];
      for (let j = 0; j < n; j++) {
        ids.push(dv.getUint16(o, true));
        o += 2;
      }
      s.animation = { anims: ids, loopFrames };
    }
    const variants: Array<"base" | "focus" | "active"> = [];
    if (flags & STYLE_VARIANT_BASE) variants.push("base");
    if (flags & STYLE_VARIANT_FOCUS) variants.push("focus");
    if (flags & STYLE_VARIANT_ACTIVE) variants.push("active");
    for (const name of variants) {
      const n = bytes[o++];
      const props: StyleProp[] = [];
      for (let j = 0; j < n; j++) {
        props.push({ prop: bytes[o], value: dv.getUint32(o + 2, true) });
        o += STYLE_PROP_RECORD_SIZE;
      }
      s[name] = props;
    }
    styles.push(s);
  }
  const anims: AnimTimeline[] = [];
  for (let i = 0; i < animCount; i++) {
    const a: AnimTimeline = {
      delayFrames: dv.getUint16(o, true),
      periodFrames: dv.getUint16(o + 2, true),
      iterations: dv.getUint16(o + 4, true),
      fill: bytes[o + 6],
      tracks: [],
    };
    const trackCount = bytes[o + 7];
    o += ANIM_ENTRY_HEADER_SIZE;
    for (let t = 0; t < trackCount; t++) {
      const prop = bytes[o];
      const segCount = bytes[o + 1];
      o += 2;
      const segments: AnimSegment[] = [];
      for (let sIdx = 0; sIdx < segCount; sIdx++) {
        const seg: AnimSegment = {
          t0: dv.getUint16(o, true),
          t1: dv.getUint16(o + 2, true),
          from: dv.getUint32(o + 4, true),
          to: dv.getUint32(o + 8, true),
          easing: bytes[o + 12],
        };
        o += ANIM_SEGMENT_SIZE;
        if (seg.easing === ENUMS.Easing.CubicBezier) {
          seg.bezier = [
            bitsF32(dv.getUint32(o, true)),
            bitsF32(dv.getUint32(o + 4, true)),
            bitsF32(dv.getUint32(o + 8, true)),
            bitsF32(dv.getUint32(o + 12, true)),
          ];
          o += ANIM_BEZIER_EXTRA_SIZE;
        }
        segments.push(seg);
      }
      a.tracks.push({ prop, segments });
    }
    anims.push(a);
  }
  return { styles, anims };
}

// ---------------------------------------------------------------------------
// FONT ATLAS binary format  (version 3)
// ---------------------------------------------------------------------------
// One blob per font slot, baked by framework/compiler/bake-font.ts, parsed by
// engine/core/src/text.rs. Glyph coverage is stored in fixed-size cells as one
// alpha byte per pixel, generated from horizontally-biased supersampling for
// smoother subpixel positioning.
//
//   Header (16 bytes):
//     off  0  u32  magic      = 0x41464344  bytes 'D','C','F','A'
//     off  4  u16  version    = 3
//     off  6  u16  glyphCount (including gid 0 = tofu box)
//     off  8  u8   cellW      LOGICAL cell width in px
//     off  9  u8   cellH      LOGICAL cell height in px
//     off 10  u8   baseline   LOGICAL px from cell TOP to the baseline
//     off 11  u8   lineHeight default LOGICAL line advance in px
//     off 12  u8   fontSlot   slot index this atlas binds (0..MAX_FONT_SLOTS-1)
//     off 13  u8   flags      bit 0 = bold; bits 1-7 reserved (0)
//     off 14  u8   density    raster samples per logical pixel (1..255)
//     off 15  u8   reserved   (0)
//
//   cmap (glyphCount x 8 bytes) at FONT_HEADER_SIZE, SORTED ASCENDING by
//   codepoint so lookups binary-search. A codepoint miss resolves to gid 0
//   (tofu) and bumps the core's miss counter.
//     +0  u32  codepoint  (Unicode scalar)
//     +4  u16  gid        (0..glyphCount-1; index into the bitmap region)
//     +6  u8   advance    LOGICAL px advance for this glyph
//     +7  u8   xoff       LOGICAL left-side-bearing shift: px the outline was shifted
//                         RIGHT at bake so negative-LSB ink (î ï ĥ ǰ accents)
//                         stays inside the cell. Renderers place the cell at
//                         penX - xoff. 0 for most glyphs (was reserved; old
//                         atlases with 0 here remain valid).
//
//   coverage region at FONT_HEADER_SIZE + glyphCount*FONT_CMAP_ENTRY_SIZE:
//     glyphCount x (cellH*density) x (cellW*density) bytes. Each byte is alpha
//     coverage 0..255 for one raster sample, left-to-right, top row first.
//     Glyph g's rows start at
//     coverageOffset + g * (cellH*density) * (cellW*density).
//
//   gid 0 MUST be the tofu box (drawn for unmapped codepoints).
//
// Version 2 used the same 16-byte header and 8-byte cmap, with bytes 14..15
// reserved and all dimensions/metrics serving as both logical and raster px.
// New cores accept v2 as density=1; v3 separates raster coverage from stable
// logical layout metrics so a 2x target can sharpen text without relayout.

export const FONT_MAGIC = 0x41464344; // 'DCFA' LE
export const FONT_VERSION = 3;
export const FONT_HEADER_SIZE = 16;
export const FONT_CMAP_ENTRY_SIZE = 8;
export const FONT_FLAG_BOLD = 1 << 0;

// ---------------------------------------------------------------------------
// DRAWLIST op format  (core -> backend)
// ---------------------------------------------------------------------------
// The core's draw() output is a flat Vec<u32> of little-endian words (in TS a
// Uint32Array). Each op = 1 header word + fixed/derivable payload words, so a
// backend can also skip unknown ops... except there are none: the set below is
// closed per DrawList version; core and backend ship together.
//
// Word packings:
//   XY word:  bits 0-15  = x as i16 (two's complement)
//             bits 16-31 = y as i16
//   WH word:  bits 0-15  = w as u16, bits 16-31 = h as u16
//   f32s are stored as their IEEE-754 bits in one word.
//   colors are u32 ABGR.
//
// GUARANTEE (the core's CPU clip stage): every coordinate a backend receives
// is already clipped to [0, SCREEN_W] x [0, SCREEN_H] — always i16-safe, never
// negative, never off-screen. Backends do NO clipping (the PSP GE would wrap
// i16 coords otherwise).
//
// Ops (header word = op code; total word counts include the header):
//   RECT        (4 words):  op, xy, wh, color
//   GRAD_RECT   (6 words):  op, xy, wh, colorFrom, colorTo, dir (GradDir u32)
//   GLYPH_RUN   (3 + 2n):   op,
//                           word1: bits 0-7 fontSlot, bits 8-15 reserved(0),
//                                  bits 16-31 glyph count n (u16),
//                           word2: color,
//                           then n x { xy (glyph cell top-left),
//                                      word: bits 0-15 gid, bits 16-31 reserved(0) }
//   TEX_QUAD    (9 words):  op, texHandle, xy, wh, u0, v0, u1, v1 (f32 bits,
//                           normalized 0..1), color (modulate; 0xFFFFFFFF = none)
//   SCISSOR     (3 words):  op, xy, wh — push clip rect. The core emits rects
//                           already intersected with every enclosing scissor,
//                           so backends just SET the rect (a depth counter,
//                           not a rect stack, still needs the pop's restore —
//                           backends keep a stack of the received rects).
//   SCISSOR_POP (1 word):   op — restore the previous scissor (screen if empty).
//                           Core guarantees balanced SCISSOR/SCISSOR_POP.
//   TRI         (7 words):  op, xy0, xy1, xy2, color0, color1, color2 — one
//                           CPU-clipped screen-space triangle (gouraud when the
//                           corner colors differ, flat otherwise). The core
//                           emits these only for ROTATED solid/gradient boxes
//                           after Sutherland-Hodgman clipping; axis-aligned
//                           content always uses RECT/GRAD_RECT.
//   TEX_TRI     (12 words): op, texHandle, then 3 x { xy, u, v } (u/v = f32
//                           bits, normalized 0..1), color (modulate;
//                           0xFFFFFFFF = none). One CPU-clipped textured
//                           triangle — the core emits these for ROTATED image
//                           quads and for image nodes inside 3D (perspective)
//                           subtrees, UVs interpolated through the clip.
//                           Texture sampling is affine in screen space
//                           (PSP-authentic; no perspective-correct divide);
//                           the core compensates by emitting foreshortened
//                           image quads as a GRID of cells sized by the
//                           perspective variation (projectively correct UVs
//                           at every cell corner), so interior texture lines
//                           do not kink at triangle diagonals.
//   TEXT_RUN    (8 + ceil(n/4) words):
//                           op,
//                           word1: bits 0-7 fontSlot,
//                                  bits 8-15 TextAlign ordinal,
//                           originX, originY, boxW, lineHeight (f32 bits;
//                           content-box top-left + width in logical px;
//                           lineHeight NaN = the slot's default),
//                           color,
//                           byteLen (u32), then ceil(n/4) words of the run
//                           string's UTF-8 bytes packed little-endian and
//                           zero-padded. Emitted ONLY when the host installed
//                           a native text measurer (docs/BACKENDS.md) and the
//                           node's recorded provider is native; every other
//                           run keeps GLYPH_RUN, so fixed-function backends
//                           (PSP GE, PPA, software raster) never see this op.
//                           The backend decodes and shapes the bytes with the
//                           host text system. The words alone are the COMPLETE
//                           pixel truth — no side table — so DrawList
//                           snapshots, demand-render hashes and damage diffs
//                           stay exact by construction. originX/Y are f32
//                           (NOT the i16 XY packing) and are exempt from the
//                           i16 clip guarantee: a run may start off-viewport,
//                           and the core brackets any partially-clipped run
//                           in SCISSOR/SCISSOR_POP.
//   SURFACE_QUAD (9 words): op, surfaceHandle,
//                           fullX, fullY, fullW, fullH (f32 bits; the shell
//                           node's unclipped logical bounds), clipXY, clipWH
//                           (the visible integer destination after every
//                           enclosing clip), flags (bit 0 = focused).
//                           This is a native compositor instruction. It owns
//                           no pixels in software/fixed-function backends and
//                           is emitted exactly where the surface node occurs
//                           in shell painter order, so later shell ops remain
//                           above the child surface.

export const DRAW_OP = {
  rect: 1,
  gradRect: 2,
  glyphRun: 3,
  texQuad: 4,
  scissor: 5,
  scissorPop: 6,
  tri: 7,
  texTri: 8,
  textRun: 9,
  surfaceQuad: 10,
} as const;

// ---------------------------------------------------------------------------
// PAK container constants
// ---------------------------------------------------------------------------
// PocketJS packs (styles.bin, font atlases, images) reuse the dreamcart .pak
// container byte-for-byte so existing tooling can open them. Values copied
// from dreamcart framework/bake/pak.ts + docs/pak-format.md (v1).
// Header: magic u32, version u16, flags u16, entryCount u32, dirOffset u32,
// namesOffset u32, blobsOffset u32 (16-aligned), fileSize u32, reserved u32.
// Entry: keyHash(fnv1a) u32, blobOff u32, byteLen u32, nameOff u32,
// nameLen u16, dtype u8, reserved u8, reserved u32. Entries sorted by key;
// blobs 16-byte aligned.

export const PAK_MAGIC = 0x4b504344; // 'DCPK' LE
export const PAK_VERSION = 1;
export const PAK_HEADER_SIZE = 32;
export const PAK_ENTRY_SIZE = 24;
export const PAK_ALIGN = 16;
/** FNV-1a 32-bit params for entry keyHash (h ^= byte; h *= prime). */
export const PAK_FNV1A_OFFSET_BASIS = 0x811c9dc5;
export const PAK_FNV1A_PRIME = 0x01000193;

/** pak dtype codes (advisory element type of a blob). */
export const PAK_DTYPE = {
  u8: 0, i8: 1, u16: 2, i16: 3, u32: 4, i32: 5, f32: 6, f64: 7,
} as const;

// ---------------------------------------------------------------------------
// PSP button bitmask (identical on every host — Web/Bun hosts remap keys)
// ---------------------------------------------------------------------------
// Verified against dreamcart web/engine.js (BTN), framework/src/input.ts (Btn)
// and rust-psp/psp/src/sys/ctrl.rs (CtrlButtons).
//
// ZL/ZR are the one addition to the PSP set: a machine can have more shoulder
// buttons than a PSP did (a New 3DS has four), and an app that wants a HELD
// modifier has nowhere else to put it — every other bit already means
// something an app is using. They take two of the gap bits the PSP never
// assigned, so the mask stays inside the 16-bit window real PSP hardware uses
// (0x10000 is HOME and 0x20000 is HOLD there). A host without them simply
// never sets the bits, and an app must treat them as an enhancement: no
// input.buttons contract promises they exist.

export const BTN = {
  SELECT: 0x0001,
  START: 0x0008,
  UP: 0x0010,
  RIGHT: 0x0020,
  DOWN: 0x0040,
  LEFT: 0x0080,
  LTRIGGER: 0x0100,
  RTRIGGER: 0x0200,
  ZL: 0x0400,
  ZR: 0x0800,
  TRIANGLE: 0x1000,
  CIRCLE: 0x2000,
  CROSS: 0x4000,
  SQUARE: 0x8000,
} as const;

// ---------------------------------------------------------------------------
// Analog stick (the frame contract's second argument)
// ---------------------------------------------------------------------------
// Hosts call `globalThis.frame(buttons, analog)` where `analog` packs the PSP
// nub as (x << 8) | y — each axis 0..255 with 128 = center (sceCtrlReadBuffer-
// Positive's SceCtrlData.ax/ay). Hosts without a stick omit the argument; the
// runtime defaults to ANALOG_CENTER, so every pre-analog host, tape and golden
// is unchanged. Deadzone/normalization is runtime policy (framework/src/frame.ts), not
// host policy — hosts pass the raw value through.

// Touch words use bit 30 for a terminal system cancellation. Decode its ID
// with the word's legacy/wide layout; it is not an active contact. The third
// frame argument carries at most eight active words plus eight cancellations.
// Hosts preserve DOWN order; the fifth argument carries surfaces for both.
// Absence without a cancellation means ordinary UP. See docs/TOUCH.md.

// Optional sixth frame argument carries the right stick with identical packing.
// Omission reads as center; touch/hit/surface arguments retain their positions.
// The seventh carries relative-axis deltas; the eighth carries the newest fused
// MotionState (contracts/spec/motion.ts) since the previous frame, null or
// omitted when the motion driver published none.
export const ANALOG_CENTER = 0x8080;

// ---------------------------------------------------------------------------
// Fixed timestep
// ---------------------------------------------------------------------------
/** Core animation/tick timestep: exactly 1/60 s unless the realm declared
 *  another rate before its first tick (Ui::set_tick_rate; still fixed for
 *  the whole run — 1/hz s, hz at most 240). Frame content is a pure function
 *  of frame index — this is what makes byte-exact goldens possible. */
export const FIXED_DT = 1 / 60;
