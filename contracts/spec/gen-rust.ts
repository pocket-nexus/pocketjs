// Deterministic codegen: contracts/spec/{spec,audio,db,net}.ts -> engine/core/src/spec.rs.
//
// Run from PocketJS/:  bun contracts/spec/gen-rust.ts
//
// tests/contract.ts imports generateRust() and byte-compares its output against
// the committed engine/core/src/spec.rs, so the generated file can never drift from
// spec.ts. Keep this generator free of anything non-deterministic (no dates,
// no env, no object-key sorting surprises — insertion order only).

import {
  AUDIO_EVENT,
  AUDIO_MAX_CHANNELS,
  AUDIO_MAX_STREAMS,
  AUDIO_OP,
  AUDIO_RATES,
  AUDIO_RING_FRAMES,
  audioFramesForTick,
} from "./audio.ts";
import {
  DB_BLOB_KEY,
  DB_MAX_DATABASES,
  DB_MAX_RESULT_ROWS,
  DB_MAX_SAFE_INTEGER,
  DB_MEMORY,
  DB_OP,
} from "./db.ts";
import {
  FS_BLOB_KEY,
  FS_MAX_DEPTH,
  FS_MAX_DIR_ENTRIES,
  FS_MAX_IO_BYTES,
  FS_MAX_PATH_BYTES,
  FS_MAX_SEGMENT_BYTES,
  FS_OP,
  FS_WRITE_APPEND,
  FS_WRITE_TRUNCATE,
} from "./fs.ts";
import {
  NET_DEFAULT_RESPONSE_BYTES,
  NET_DEFAULT_TIMEOUT_MS,
  NET_ERROR,
  NET_EVENT,
  NET_MAX_HEADER_BYTES,
  NET_MAX_HEADERS,
  NET_MAX_INFLIGHT,
  NET_MAX_REDIRECTS,
  NET_MAX_REQUEST_BYTES,
  NET_MAX_RESPONSE_BYTES,
  NET_MAX_TIMEOUT_MS,
  NET_METHODS,
  NET_OP,
} from "./net.ts";
import {
  ANALOG_CENTER,
  ANIMATABLE,
  ANIM_BEZIER_EXTRA_SIZE,
  ANIM_ENTRY_HEADER_SIZE,
  ANIM_FILL_BACKWARDS,
  ANIM_FILL_FORWARDS,
  ANIM_SEGMENT_SIZE,
  BTN,
  IMG_FLAG_LINEAR,
  IMG_FLAG_RLE,
  PAK_ALIGN,
  PAK_DTYPE,
  PAK_ENTRY_SIZE,
  PAK_FNV1A_OFFSET_BASIS,
  PAK_FNV1A_PRIME,
  PAK_HEADER_SIZE,
  PAK_MAGIC,
  PAK_VERSION,
  DRAW_OP,
  ENUMS,
  FIXED_DT,
  FONT_CMAP_ENTRY_SIZE,
  FONT_FLAG_BOLD,
  FONT_HEADER_SIZE,
  FONT_MAGIC,
  FONT_VERSION,
  ID_SLOT_BITS,
  ID_SLOT_MASK,
  LAYOUT_DIRTYING,
  MAX_FONT_SLOTS,
  MAX_TREE_DEPTH,
  NODE_TYPE,
  OP,
  PROP,
  PROP_VALUE_KIND,
  PSM,
  ROOT_ID,
  SCREEN_H,
  SCREEN_W,
  SIZE_FULL,
  STYLE_HAS_ANIMATION,
  STYLE_HAS_TRANSITION,
  STYLE_HEADER_SIZE,
  STYLE_ID_NONE,
  STYLE_MAGIC,
  STYLE_PROP_RECORD_SIZE,
  STYLE_TRANSITION_SIZE,
  STYLE_VARIANT_ACTIVE,
  STYLE_VARIANT_BASE,
  STYLE_VARIANT_FOCUS,
  STYLE_VERSION,
  STREAM_ARING_MAGIC,
  STREAM_ARING_OFF,
  STREAM_CHUNK_HEADER_SIZE,
  STREAM_FLAG_ENDED,
  STREAM_HEADER_BLOCK_SIZE,
  STREAM_HEADER_SIZE,
  STREAM_MAGIC,
  STREAM_SLOT_HEADER_SIZE,
  STREAM_VERSION,
  STREAM_VRING_MAGIC,
  STREAM_VRING_OFF,
  SVC_IMG_MAX_BYTES,
  SVC_POLL_BUF,
  WIRE_BEACON_MAGIC,
  WIRE_BEACON_PORT,
  WIRE_CHUNK_HEADER_SIZE,
  WIRE_HEADER_SIZE,
  WIRE_MAGIC,
  WIRE_MARK_FLAG_ENDED,
  WIRE_MARK_SIZE,
  WIRE_MAX_PAYLOAD,
  WIRE_MSG,
  WIRE_PORT,
  WIRE_SLOT_FLAG_RLE,
  WIRE_SLOT_HEADER_SIZE,
  WIRE_VERSION,
  TEX_MAX_DIM,
  TEX_SLOT_BITS,
  TEX_SLOT_MASK,
  TILESET_ABSENT,
  TILESET_DIR_ENTRY_SIZE,
  TILESET_FLAG_LINEAR,
  TILESET_FLAG_RLE,
  TILESET_HEADER_SIZE,
  TILESET_MAGIC,
  TILESET_VERSION,
  TRANSITION_MASK_ALL,
  VALUE_KIND,
  type PropName,
} from "./spec.ts";
import {
  generateMicroTsRust,
  generateMicroTsNumericTypes,
  generateMicroTsStdDeclarations,
  generateMicroTsComponentTypes,
} from "./microts.ts";
export { generateMicroTsRust, generateMicroTsNumericTypes, generateMicroTsStdDeclarations, generateMicroTsComponentTypes };

/** camelCase -> SCREAMING_SNAKE_CASE (width -> WIDTH, paddingT -> PADDING_T). */
function screaming(name: string): string {
  return name.replace(/([A-Z])/g, "_$1").toUpperCase();
}

function hex(n: number, pad = 8): string {
  return "0x" + (n >>> 0).toString(16).padStart(pad, "0");
}

/** [u64; 4] bitset literal over u8 prop ids. */
function bitset(props: readonly PropName[]): string {
  const words = [0n, 0n, 0n, 0n];
  for (const p of props) {
    const id = PROP[p];
    words[id >> 6] |= 1n << BigInt(id & 63);
  }
  return `[${words.map((w) => "0x" + w.toString(16).padStart(16, "0")).join(", ")}]`;
}

/** [u8; 256] literal from a sparse map (0xff = unassigned), 16 per line. */
function u8Table(get: (id: number) => number): string {
  const rows: string[] = [];
  for (let base = 0; base < 256; base += 16) {
    const row: string[] = [];
    for (let i = base; i < base + 16; i++) row.push("0x" + get(i).toString(16).padStart(2, "0"));
    rows.push("    " + row.join(", ") + ",");
  }
  return "[\n" + rows.join("\n") + "\n]";
}

export function generateRust(): string {
  const L: string[] = [];
  const put = (s = "") => L.push(s);

  put("//! GENERATED — do not edit; run `bun contracts/spec/gen-rust.ts` (from PocketJS/).");
  put("//!");
  put("//! Source of truth: PocketJS/spec/spec.ts — every constant here mirrors it.");
  put("//! tests/contract.ts regenerates this file in-memory and byte-compares;");
  put("//! if that fails, run `bun contracts/spec/gen-rust.ts` and commit the result.");
  put("");
  put("#![allow(dead_code)]");
  put("#![allow(clippy::all)]");
  put("");

  // --- scalars ---------------------------------------------------------------
  put("/// Logical (and physical PSP) screen size.");
  put(`pub const SCREEN_W: u32 = ${SCREEN_W};`);
  put(`pub const SCREEN_H: u32 = ${SCREEN_H};`);
  put("");
  put("/// Node ids are generation-tagged: id = (generation << ID_SLOT_BITS) | slot.");
  put("/// Bit 31 stays 0; id 0 = \"no node\" (append anchor / clear focus).");
  put(`pub const ID_SLOT_BITS: u32 = ${ID_SLOT_BITS};`);
  put(`pub const ID_SLOT_MASK: u32 = ${hex(ID_SLOT_MASK, 5)};`);
  put("/// Maximum tree depth (root = depth 0). insert_before rejects inserts whose");
  put("/// parent already sits at the cap (silent no-op, stale-id contract) so every");
  put("/// recursive tree walk stays bounded on small PSP thread stacks.");
  put(`pub const MAX_TREE_DEPTH: u32 = ${MAX_TREE_DEPTH};`);
  put("/// Node 1 (slot 1, gen 0) is the pre-created full-screen root (flex column).");
  put(`pub const ROOT_ID: i32 = ${ROOT_ID};`);
  put("/// `set_style(id, STYLE_ID_NONE)` clears a node back to default style.");
  put(`pub const STYLE_ID_NONE: i32 = ${STYLE_ID_NONE};`);
  put("/// f32 sentinel for `w-full`/`h-full` (prop::WIDTH/HEIGHT): 100% of the");
  put("/// parent. Any negative width/height is treated as this sentinel; it is");
  put("/// NOT animatable (tweens to/from it are no-ops).");
  if (SIZE_FULL !== -1) throw new Error("SIZE_FULL changed; update gen-rust.ts emission");
  put("pub const SIZE_FULL: f32 = -1.0;");
  put("");
  put("/// Textures must be power-of-two and no larger than this per side.");
  put(`pub const TEX_MAX_DIM: u32 = ${TEX_MAX_DIM};`);
  put("/// Texture handles are generation-tagged like node ids:");
  put("/// handle = (generation << TEX_SLOT_BITS) | slot; bit 31 stays 0.");
  put(`pub const TEX_SLOT_BITS: u32 = ${TEX_SLOT_BITS};`);
  put(`pub const TEX_SLOT_MASK: u32 = ${hex(TEX_SLOT_MASK, 5)};`);
  put("/// Max baked font-atlas slots.");
  put(`pub const MAX_FONT_SLOTS: usize = ${MAX_FONT_SLOTS};`);
  put("/// Transition mask value meaning \"every animatable prop\".");
  put(`pub const TRANSITION_MASK_ALL: u32 = ${hex(TRANSITION_MASK_ALL)};`);
  put("/// Core tick timestep: exactly 1/60 s (fixed — enables byte-exact goldens).");
  if (FIXED_DT !== 1 / 60) throw new Error("FIXED_DT changed; update gen-rust.ts emission");
  put("pub const FIXED_DT: f32 = 1.0 / 60.0;");
  put("");

  // --- node type enum ---------------------------------------------------------
  put("/// Element kinds — the `create_node` argument.");
  put("#[repr(u8)]");
  put("#[derive(Clone, Copy, PartialEq, Eq, Debug)]");
  put("pub enum NodeType {");
  for (const [name, v] of Object.entries(NODE_TYPE)) {
    put(`    ${name[0].toUpperCase()}${name.slice(1)} = ${v},`);
  }
  put("}");
  put("");

  // --- op codes ---------------------------------------------------------------
  put("/// UI op codes (the engine/wasm/FFI ABI identity of each `ui.*` op; 0 reserved).");
  put("/// Signatures are documented in spec.ts and docs/DESIGN.md.");
  put("pub mod op {");
  for (const [name, v] of Object.entries(OP)) {
    put(`    pub const ${screaming(name)}: u8 = ${v};`);
  }
  put("}");
  put("");

  // --- prop ids ---------------------------------------------------------------
  put("/// Property ids (u8, stable, append-only). Groups:");
  put("/// 1..63 layout | 64..95 visual | 96..127 text | 128..159 transform.");
  put("pub mod prop {");
  for (const [name, v] of Object.entries(PROP)) {
    put(`    pub const ${screaming(name)}: u8 = ${v};`);
  }
  put("}");
  put("");

  // --- value kinds --------------------------------------------------------------
  put("/// How a prop's u32 payload is interpreted (see spec.ts VALUE_KIND).");
  put("pub mod value_kind {");
  for (const [name, v] of Object.entries(VALUE_KIND)) {
    put(`    pub const ${screaming(name)}: u8 = ${v};`);
  }
  put("}");
  put("");
  put("/// PROP_VALUE_KIND[prop id] -> value_kind (0xff = unassigned id).");
  const kindById = new Map<number, number>();
  for (const [name, id] of Object.entries(PROP)) {
    kindById.set(id, PROP_VALUE_KIND[name as PropName]);
  }
  put(`pub const PROP_VALUE_KIND: [u8; 256] = ${u8Table((id) => kindById.get(id) ?? 0xff)};`);
  put("");

  // --- animatable / layout-dirtying ---------------------------------------------
  put("/// ANIM_BIT[prop id] -> transition-mask bit index (0xff = not animatable).");
  put("/// The bit order is spec.ts ANIMATABLE order — append-only.");
  const animBitById = new Map<number, number>();
  ANIMATABLE.forEach((name, bit) => animBitById.set(PROP[name], bit));
  put(`pub const ANIM_BIT: [u8; 256] = ${u8Table((id) => animBitById.get(id) ?? 0xff)};`);
  put("");
  put("/// Bitset over prop ids: animatable props (tween/spring/transition targets).");
  put(`pub const ANIMATABLE_BITS: [u64; 4] = ${bitset(ANIMATABLE)};`);
  put("/// Bitset over prop ids: props whose change invalidates layout.");
  put(`pub const LAYOUT_DIRTY_BITS: [u64; 4] = ${bitset(LAYOUT_DIRTYING)};`);
  put("");
  put("pub const fn is_animatable(prop: u8) -> bool {");
  put("    ANIMATABLE_BITS[(prop >> 6) as usize] & (1u64 << (prop & 63)) != 0");
  put("}");
  put("pub const fn is_layout_dirtying(prop: u8) -> bool {");
  put("    LAYOUT_DIRTY_BITS[(prop >> 6) as usize] & (1u64 << (prop & 63)) != 0");
  put("}");
  put("");

  // --- enums ------------------------------------------------------------------
  const enumDocs: Record<string, string> = {
    FlexDir: "flex-direction.",
    Justify: "justify-content.",
    Align: "align-items.",
    PosType: "position type.",
    Display: "display (None removes from layout AND paint).",
    Overflow: "overflow (Hidden => scissor in draw).",
    TextAlign: "text alignment within the node box.",
    GradDir: "gradient direction (`bg-gradient-to-t|b|l|r`).",
    Easing:
      "animation easing. Spring/SpringBouncy ignore durMs (physics decide); OutBack overshoots ~10%.",
  };
  for (const [ename, variants] of Object.entries(ENUMS)) {
    put(`/// ${enumDocs[ename] ?? ename}`);
    put("#[repr(u8)]");
    put("#[derive(Clone, Copy, PartialEq, Eq, Debug)]");
    put(`pub enum ${ename} {`);
    for (const [vname, v] of Object.entries(variants)) {
      put(`    ${vname} = ${v},`);
    }
    put("}");
    put("");
  }

  // --- psm --------------------------------------------------------------------
  put("/// PSM texture pixel formats — MUST equal rust-psp TexturePixelFormat");
  put("/// (sceGuTexMode arg; verified against rust-psp/psp/src/sys/gu.rs).");
  put("/// PSM_T8 (CLUT8) uploads as: 1024-byte palette (256 x u32 ABGR), then");
  put("/// w*h index bytes.");
  put("pub mod psm {");
  for (const [name, v] of Object.entries(PSM)) {
    put(`    pub const ${name}: u32 = ${v};`);
  }
  put("}");
  put("");

  // --- img entry flags ------------------------------------------------------------
  put("/// IMG entry flags (framework/compiler/pak.ts IMG entry byte 5; v1 wrote 0).");
  put("pub mod img {");
  put(`    pub const FLAG_RLE: u8 = ${IMG_FLAG_RLE}; // pixel stream is PackBits-RLE`);
  put(`    pub const FLAG_LINEAR: u8 = ${IMG_FLAG_LINEAR}; // bilinear sampling`);
  put("}");
  put("");

  // --- tileset ---------------------------------------------------------------------
  put("/// TILESET pak entry (deep-zoom tile grids; full layout in spec.ts).");
  put("/// One shared 256-color palette per entry; solid tiles live in the dir.");
  put("pub mod tileset {");
  put(`    pub const MAGIC: u32 = ${hex(TILESET_MAGIC)}; // 'PKTS' LE`);
  put(`    pub const VERSION: u16 = ${TILESET_VERSION};`);
  put(`    pub const HEADER_SIZE: usize = ${TILESET_HEADER_SIZE};`);
  put(`    pub const DIR_ENTRY_SIZE: usize = ${TILESET_DIR_ENTRY_SIZE};`);
  put(`    pub const ABSENT: u32 = ${hex(TILESET_ABSENT)};`);
  put(`    pub const FLAG_RLE: u16 = ${TILESET_FLAG_RLE};`);
  put(`    pub const FLAG_LINEAR: u16 = ${TILESET_FLAG_LINEAR};`);
  put("}");
  put("");

  // --- svc / stream -----------------------------------------------------------
  put("/// Host service channel limits (spec.ts SVC — pocket-svc/<app>/ mailbox).");
  put("pub mod svc {");
  put(`    pub const POLL_BUF: usize = ${SVC_POLL_BUF};`);
  put(`    pub const IMG_MAX_BYTES: usize = ${SVC_IMG_MAX_BYTES};`);
  put("}");
  put("");
  put("/// STREAM container (.pkst) — host-written video+audio ring file.");
  put("/// Full byte layout in spec.ts; parsed by engine/core/src/stream.rs.");
  put("pub mod stream {");
  put(`    pub const MAGIC: u32 = ${hex(STREAM_MAGIC)}; // 'PKST' LE`);
  put(`    pub const VERSION: u16 = ${STREAM_VERSION};`);
  put(`    pub const HEADER_SIZE: usize = ${STREAM_HEADER_SIZE};`);
  put(`    pub const VRING_MAGIC: u32 = ${hex(STREAM_VRING_MAGIC)}; // 'PKVR' LE`);
  put(`    pub const VRING_OFF: usize = ${STREAM_VRING_OFF};`);
  put(`    pub const ARING_MAGIC: u32 = ${hex(STREAM_ARING_MAGIC)}; // 'PKAR' LE`);
  put(`    pub const ARING_OFF: usize = ${STREAM_ARING_OFF};`);
  put(`    pub const HEADER_BLOCK_SIZE: usize = ${STREAM_HEADER_BLOCK_SIZE};`);
  put(`    pub const SLOT_HEADER_SIZE: usize = ${STREAM_SLOT_HEADER_SIZE};`);
  put(`    pub const CHUNK_HEADER_SIZE: usize = ${STREAM_CHUNK_HEADER_SIZE};`);
  put(`    pub const FLAG_ENDED: u16 = ${STREAM_FLAG_ENDED};`);
  put("}");
  put("");
  put("/// SVC WIRE protocol (PKNT) — the svc mailbox over a socket.");
  put("/// Full byte layout in spec.ts; parsed by engine/core/src/wire.rs.");
  put("pub mod wire {");
  put(`    pub const MAGIC: u32 = ${hex(WIRE_MAGIC)}; // 'PKNT' LE`);
  put(`    pub const BEACON_MAGIC: u32 = ${hex(WIRE_BEACON_MAGIC)}; // 'PKDB' LE`);
  put(`    pub const VERSION: u8 = ${WIRE_VERSION};`);
  put(`    pub const HEADER_SIZE: usize = ${WIRE_HEADER_SIZE};`);
  put(`    pub const MAX_PAYLOAD: usize = ${WIRE_MAX_PAYLOAD};`);
  put(`    pub const BEACON_PORT: u16 = ${WIRE_BEACON_PORT};`);
  put(`    pub const PORT: u16 = ${WIRE_PORT};`);
  for (const [name, v] of Object.entries(WIRE_MSG)) {
    put(`    pub const MSG_${screaming(name)}: u8 = ${hex(v, 2)};`);
  }
  put(`    pub const SLOT_HEADER_SIZE: usize = ${WIRE_SLOT_HEADER_SIZE};`);
  put(`    pub const CHUNK_HEADER_SIZE: usize = ${WIRE_CHUNK_HEADER_SIZE};`);
  put(`    pub const MARK_SIZE: usize = ${WIRE_MARK_SIZE};`);
  put(`    pub const SLOT_FLAG_RLE: u16 = ${WIRE_SLOT_FLAG_RLE};`);
  put(`    pub const MARK_FLAG_ENDED: u16 = ${WIRE_MARK_FLAG_ENDED};`);
  put("}");
  put("");

  // --- style table --------------------------------------------------------------
  put("/// STYLE TABLE (styles.bin) format constants — full layout in spec.ts.");
  put("pub mod style_table {");
  put(`    pub const MAGIC: u32 = ${hex(STYLE_MAGIC)}; // 'DCST' LE`);
  put(`    pub const VERSION: u16 = ${STYLE_VERSION};`);
  put(`    pub const HEADER_SIZE: usize = ${STYLE_HEADER_SIZE};`);
  put(`    pub const TRANSITION_SIZE: usize = ${STYLE_TRANSITION_SIZE};`);
  put(`    pub const PROP_RECORD_SIZE: usize = ${STYLE_PROP_RECORD_SIZE};`);
  put(`    pub const VARIANT_BASE: u8 = ${STYLE_VARIANT_BASE};`);
  put(`    pub const VARIANT_FOCUS: u8 = ${STYLE_VARIANT_FOCUS};`);
  put(`    pub const VARIANT_ACTIVE: u8 = ${STYLE_VARIANT_ACTIVE};`);
  put(`    pub const HAS_TRANSITION: u8 = ${STYLE_HAS_TRANSITION};`);
  put(`    pub const HAS_ANIMATION: u8 = ${STYLE_HAS_ANIMATION};`);
  put(`    pub const ANIM_ENTRY_HEADER_SIZE: usize = ${ANIM_ENTRY_HEADER_SIZE};`);
  put(`    pub const ANIM_SEGMENT_SIZE: usize = ${ANIM_SEGMENT_SIZE};`);
  put(`    pub const ANIM_BEZIER_EXTRA_SIZE: usize = ${ANIM_BEZIER_EXTRA_SIZE};`);
  put(`    pub const ANIM_FILL_BACKWARDS: u8 = ${ANIM_FILL_BACKWARDS};`);
  put(`    pub const ANIM_FILL_FORWARDS: u8 = ${ANIM_FILL_FORWARDS};`);
  put("}");
  put("");

  // --- font atlas ---------------------------------------------------------------
  put("/// FONT ATLAS blob format constants — full layout in spec.ts.");
  put("pub mod font_atlas {");
  put(`    pub const MAGIC: u32 = ${hex(FONT_MAGIC)}; // 'DCFA' LE`);
  put(`    pub const VERSION: u16 = ${FONT_VERSION};`);
  put(`    pub const HEADER_SIZE: usize = ${FONT_HEADER_SIZE};`);
  put(`    pub const CMAP_ENTRY_SIZE: usize = ${FONT_CMAP_ENTRY_SIZE};`);
  put(`    pub const FLAG_BOLD: u8 = ${FONT_FLAG_BOLD};`);
  put("}");
  put("");

  // --- drawlist ------------------------------------------------------------------
  put("/// DrawList op codes (core -> backend Vec<u32> words; layout in spec.ts).");
  put("/// Word counts incl. header: RECT 4, GRAD_RECT 6, GLYPH_RUN 3+2n,");
  put("/// TEX_QUAD 9, SCISSOR 3, SCISSOR_POP 1, TRI 7, TEX_TRI 12,");
  put("/// TEXT_RUN 8+ceil(bytes/4), SURFACE_QUAD 9.");
  put("pub mod draw_op {");
  for (const [name, v] of Object.entries(DRAW_OP)) {
    put(`    pub const ${screaming(name)}: u32 = ${v};`);
  }
  put("}");
  put("");

  // --- pak ----------------------------------------------------------------------
  put("/// .pak container constants (byte-compatible with dreamcart's format;");
  put("/// copied from framework/bake/pak.ts + docs/pak-format.md).");
  put("pub mod pak {");
  put(`    pub const MAGIC: u32 = ${hex(PAK_MAGIC)}; // 'DCPK' LE`);
  put(`    pub const VERSION: u16 = ${PAK_VERSION};`);
  put(`    pub const HEADER_SIZE: usize = ${PAK_HEADER_SIZE};`);
  put(`    pub const ENTRY_SIZE: usize = ${PAK_ENTRY_SIZE};`);
  put(`    pub const ALIGN: usize = ${PAK_ALIGN};`);
  put(`    pub const FNV1A_OFFSET_BASIS: u32 = ${hex(PAK_FNV1A_OFFSET_BASIS)};`);
  put(`    pub const FNV1A_PRIME: u32 = ${hex(PAK_FNV1A_PRIME)};`);
  for (const [name, v] of Object.entries(PAK_DTYPE)) {
    put(`    pub const DT_${name.toUpperCase()}: u8 = ${v};`);
  }
  put("}");
  put("");

  // --- buttons --------------------------------------------------------------------
  put("/// PSP button bitmask — identical on every host. Verified against");
  put("/// dreamcart web/engine.js and rust-psp/psp/src/sys/ctrl.rs (CtrlButtons).");
  put("pub mod btn {");
  for (const [name, v] of Object.entries(BTN)) {
    put(`    pub const ${name}: u32 = ${hex(v, 4)};`);
  }
  put("}");
  put("");
  put("/// frame(buttons, analog): analog packs the nub as (x << 8) | y, each");
  put("/// axis 0..255 with 128 = center. Hosts without a stick omit the arg;");
  put("/// the runtime defaults to this value (so old tapes/goldens hold).");
  put(`pub const ANALOG_CENTER: u32 = ${hex(ANALOG_CENTER, 4)};`);
  put("");

  // --- audio module -------------------------------------------------------------
  // The audio MODULE's boundary (contracts/spec/audio.ts): its own op space,
  // mounted as `globalThis.audio`, independent of the ui surface. A native
  // host implementing it reads these constants; the ring/thread discipline to
  // copy is hosts/psp/src/audio.rs (currently serving the video plane).
  if (audioFramesForTick(22050, 0) !== 367 || audioFramesForTick(22050, 1) !== 368) {
    throw new Error("audioFramesForTick drifted from the pinned Bresenham formula");
  }
  put("/// AUDIO module boundary (contracts/spec/audio.ts — `globalThis.audio`).");
  put("/// Credit-based PCM streaming; events batch to tick boundaries via poll().");
  put("/// Frames consumed on virtual tick n at 60 ticks/s (the determinism");
  put("/// contract): floor((n+1)*rate/60) - floor(n*rate/60).");
  put("pub mod audio {");
  for (const [name, v] of Object.entries(AUDIO_OP)) {
    put(`    pub const OP_${screaming(name)}: u8 = ${v};`);
  }
  put(`    /// Accepted stream rates: integer divisors of the PSP's native 44.1 kHz.`);
  put(`    pub const RATES: [u32; ${AUDIO_RATES.length}] = [${AUDIO_RATES.join(", ")}];`);
  put(`    pub const MAX_CHANNELS: u32 = ${AUDIO_MAX_CHANNELS};`);
  put(`    /// Per-stream ring capacity in SOURCE sample frames (credit ceiling).`);
  put(`    pub const RING_FRAMES: usize = ${AUDIO_RING_FRAMES};`);
  put(`    pub const MAX_STREAMS: usize = ${AUDIO_MAX_STREAMS};`);
  for (const [name, v] of Object.entries(AUDIO_EVENT)) {
    put(`    pub const EVENT_${screaming(name)}: &str = ${JSON.stringify(v)};`);
  }
  put("}");
  put("");

  // --- db module -----------------------------------------------------------
  // The db MODULE's boundary (contracts/spec/db.ts): SQLite behind five
  // synchronous ops, mounted as `globalThis.db`, independent of the ui
  // surface. A native host implementing it reads these constants; the
  // reference implementation is engine/crates/pocket-db.
  put("/// DB module boundary (contracts/spec/db.ts — `globalThis.db`).");
  put("/// SQLite behind five synchronous ops; rows cross as one JSON line per");
  put("/// query() call. The module owns no clock and emits no events.");
  put("pub mod db {");
  for (const [name, v] of Object.entries(DB_OP)) {
    put(`    pub const OP_${screaming(name)}: u8 = ${v};`);
  }
  put(`    /// The in-memory database name (private to the handle).`);
  put(`    pub const MEMORY: &str = ${JSON.stringify(DB_MEMORY)};`);
  put(`    /// Marker key for a BLOB value inside a row or a parameter list.`);
  put(`    pub const BLOB_KEY: &str = ${JSON.stringify(DB_BLOB_KEY)};`);
  put(`    /// Largest integer magnitude that crosses the boundary losslessly.`);
  put(`    pub const MAX_SAFE_INTEGER: i64 = ${DB_MAX_SAFE_INTEGER};`);
  put(`    pub const MAX_DATABASES: usize = ${DB_MAX_DATABASES};`);
  put(`    /// Result-row ceiling per query() call (exceeding it fails the op).`);
  put(`    pub const MAX_RESULT_ROWS: usize = ${DB_MAX_RESULT_ROWS};`);
  put("}");
  put("");

  // --- fs module -----------------------------------------------------------
  // The fs MODULE's boundary (contracts/spec/fs.ts): a per-app file tree
  // behind nine synchronous ops, mounted as `globalThis.fs`, independent of
  // the ui surface. A native host implementing it reads these constants; the
  // reference implementation is engine/crates/pocket-fs.
  put("/// FS module boundary (contracts/spec/fs.ts — `globalThis.fs`).");
  put("/// A per-app file tree behind nine synchronous ops; every path resolves");
  put("/// under the app's own data root. No clock, no events, no mtime.");
  put("pub mod fs {");
  for (const [name, v] of Object.entries(FS_OP)) {
    put(`    pub const OP_${screaming(name)}: u8 = ${v};`);
  }
  put(`    /// write() modes.`);
  put(`    pub const WRITE_TRUNCATE: u32 = ${FS_WRITE_TRUNCATE};`);
  put(`    pub const WRITE_APPEND: u32 = ${FS_WRITE_APPEND};`);
  put(`    /// Marker key for a bytes payload (db's blob spelling).`);
  put(`    pub const BLOB_KEY: &str = ${JSON.stringify(FS_BLOB_KEY)};`);
  put(`    /// Maximum UTF-8 bytes in one path segment.`);
  put(`    pub const MAX_SEGMENT_BYTES: usize = ${FS_MAX_SEGMENT_BYTES};`);
  put(`    /// Maximum segments in a path.`);
  put(`    pub const MAX_DEPTH: usize = ${FS_MAX_DEPTH};`);
  put(`    /// Maximum total path length in bytes.`);
  put(`    pub const MAX_PATH_BYTES: usize = ${FS_MAX_PATH_BYTES};`);
  put(`    /// Payload ceiling per read()/write() call, in bytes.`);
  put(`    pub const MAX_IO_BYTES: usize = ${FS_MAX_IO_BYTES};`);
  put(`    /// Entries per list() call (paged via offset + eof).`);
  put(`    pub const MAX_DIR_ENTRIES: usize = ${FS_MAX_DIR_ENTRIES};`);
  put("}");
  put("");

  // --- net module ---------------------------------------------------------------
  put("/// NET module boundary (contracts/spec/net.ts — `globalThis.net`).");
  put("/// Bounded whole-response HTTP; completions batch to tick boundaries.");
  put("pub mod net {");
  for (const [name, v] of Object.entries(NET_OP)) {
    put(`    pub const OP_${screaming(name)}: u8 = ${v};`);
  }
  put(`    pub const MAX_INFLIGHT: usize = ${NET_MAX_INFLIGHT};`);
  put(`    pub const MAX_REQUEST_BYTES: usize = ${NET_MAX_REQUEST_BYTES};`);
  put(`    pub const DEFAULT_RESPONSE_BYTES: usize = ${NET_DEFAULT_RESPONSE_BYTES};`);
  put(`    pub const MAX_RESPONSE_BYTES: usize = ${NET_MAX_RESPONSE_BYTES};`);
  put(`    pub const MAX_HEADERS: usize = ${NET_MAX_HEADERS};`);
  put(`    pub const MAX_HEADER_BYTES: usize = ${NET_MAX_HEADER_BYTES};`);
  put(`    pub const DEFAULT_TIMEOUT_MS: u32 = ${NET_DEFAULT_TIMEOUT_MS};`);
  put(`    pub const MAX_TIMEOUT_MS: u32 = ${NET_MAX_TIMEOUT_MS};`);
  put(`    pub const MAX_REDIRECTS: usize = ${NET_MAX_REDIRECTS};`);
  put(`    pub const METHODS: [&str; ${NET_METHODS.length}] = [${NET_METHODS.map((method) => JSON.stringify(method)).join(", ")}];`);
  for (const [name, v] of Object.entries(NET_EVENT)) {
    put(`    pub const EVENT_${screaming(name)}: &str = ${JSON.stringify(v)};`);
  }
  for (const [name, v] of Object.entries(NET_ERROR)) {
    put(`    pub const ERROR_${screaming(name)}: &str = ${JSON.stringify(v)};`);
  }
  put("}");

  return L.join("\n") + "\n";
}

if (import.meta.main) {
  const out = new URL("../../engine/core/src/spec.rs", import.meta.url).pathname;
  await Bun.write(out, generateRust());
  console.log(`wrote ${out}`);
  for (const [path, source] of [
    ["../../engine/crates/microts/src/spec.rs", generateMicroTsRust()],
    ["../../framework/src/numeric-microts.ts", generateMicroTsNumericTypes()],
    ["../../framework/src/std-microts.d.ts", generateMicroTsStdDeclarations()],
    ["../../framework/src/component-types-microts.ts", generateMicroTsComponentTypes()],
  ]) {
    const target = new URL(path, import.meta.url).pathname;
    await Bun.write(target, source);
    console.log(`wrote ${target}`);
  }
}
