//! GENERATED — do not edit; run `bun contracts/spec/gen-rust.ts` (from PocketJS/).
//!
//! Source of truth: PocketJS/spec/spec.ts — every constant here mirrors it.
//! tests/contract.ts regenerates this file in-memory and byte-compares;
//! if that fails, run `bun contracts/spec/gen-rust.ts` and commit the result.

#![allow(dead_code)]
#![allow(clippy::all)]

/// Logical (and physical PSP) screen size.
pub const SCREEN_W: u32 = 480;
pub const SCREEN_H: u32 = 272;

/// Node ids are generation-tagged: id = (generation << ID_SLOT_BITS) | slot.
/// Bit 31 stays 0; id 0 = "no node" (append anchor / clear focus).
pub const ID_SLOT_BITS: u32 = 20;
pub const ID_SLOT_MASK: u32 = 0xfffff;
/// Maximum tree depth (root = depth 0). insert_before rejects inserts whose
/// parent already sits at the cap (silent no-op, stale-id contract) so every
/// recursive tree walk stays bounded on small PSP thread stacks.
pub const MAX_TREE_DEPTH: u32 = 64;
/// Node 1 (slot 1, gen 0) is the pre-created full-screen root (flex column).
pub const ROOT_ID: i32 = 1;
/// `set_style(id, STYLE_ID_NONE)` clears a node back to default style.
pub const STYLE_ID_NONE: i32 = -1;
/// f32 sentinel for `w-full`/`h-full` (prop::WIDTH/HEIGHT): 100% of the
/// parent. Any negative width/height is treated as this sentinel; it is
/// NOT animatable (tweens to/from it are no-ops).
pub const SIZE_FULL: f32 = -1.0;

/// Textures must be power-of-two and no larger than this per side.
pub const TEX_MAX_DIM: u32 = 512;
/// Texture handles are generation-tagged like node ids:
/// handle = (generation << TEX_SLOT_BITS) | slot; bit 31 stays 0.
pub const TEX_SLOT_BITS: u32 = 20;
pub const TEX_SLOT_MASK: u32 = 0xfffff;
/// Max baked font-atlas slots.
pub const MAX_FONT_SLOTS: usize = 24;
/// Transition mask value meaning "every animatable prop".
pub const TRANSITION_MASK_ALL: u32 = 0xffffffff;
/// Core tick timestep: exactly 1/60 s (fixed — enables byte-exact goldens).
pub const FIXED_DT: f32 = 1.0 / 60.0;

/// Element kinds — the `create_node` argument.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum NodeType {
    View = 0,
    Text = 1,
    Image = 2,
    Surface = 3,
}

/// UI op codes (the engine/wasm/FFI ABI identity of each `ui.*` op; 0 reserved).
/// Signatures are documented in spec.ts and docs/DESIGN.md.
pub mod op {
    pub const CREATE_NODE: u8 = 1;
    pub const DESTROY_NODE: u8 = 2;
    pub const INSERT_BEFORE: u8 = 3;
    pub const REMOVE_CHILD: u8 = 4;
    pub const SET_STYLE: u8 = 5;
    pub const SET_PROP: u8 = 6;
    pub const SET_TEXT: u8 = 7;
    pub const REPLACE_TEXT: u8 = 8;
    pub const UPLOAD_TEXTURE: u8 = 9;
    pub const SET_IMAGE: u8 = 10;
    pub const ANIMATE: u8 = 11;
    pub const CANCEL_ANIM: u8 = 12;
    pub const SET_FOCUS: u8 = 13;
    pub const LOAD_STYLES: u8 = 14;
    pub const LOAD_FONT_ATLAS: u8 = 15;
    pub const MEASURE_TEXT: u8 = 16;
    pub const SET_SPRITE: u8 = 17;
    pub const DEBUG_INSPECT: u8 = 18;
    pub const DEBUG_RECT_X_Y: u8 = 19;
    pub const DEBUG_RECT_W_H: u8 = 20;
    pub const DEBUG_PAUSE: u8 = 21;
    pub const DEBUG_STEP: u8 = 22;
    pub const LOAD_TILE_TEXTURE: u8 = 23;
    pub const FREE_TEXTURE: u8 = 24;
    pub const UPLOAD_IMG_ENTRY: u8 = 25;
    pub const SET_ACTIVE: u8 = 26;
    pub const HIT_TEST: u8 = 27;
    pub const SET_CURSOR: u8 = 28;
    pub const SET_CURSOR_POS: u8 = 29;
    pub const SVC_OPEN: u8 = 30;
    pub const SVC_POLL: u8 = 31;
    pub const SVC_SEND: u8 = 32;
    pub const LOAD_IMG_FILE: u8 = 33;
    pub const VIDEO_OPEN: u8 = 34;
    pub const VIDEO_TICK: u8 = 35;
    pub const VIDEO_TEXTURE: u8 = 36;
    pub const VIDEO_CLOSE: u8 = 37;
    pub const DEBUG_STATS: u8 = 38;
    pub const APP_TABLE: u8 = 39;
    pub const APP_LAUNCH: u8 = 40;
    pub const APP_SHOT: u8 = 41;
    pub const HIT_TEST_BOUNDS: u8 = 42;
    pub const WRAP_TEXT: u8 = 43;
    pub const SET_COMPOSITOR_SURFACE: u8 = 44;
    pub const HIT_TEST_AUXILIARY: u8 = 45;
    pub const HIT_TEST_BOUNDS_AUXILIARY: u8 = 46;
    pub const FONT_STREAM_CONFIGURE: u8 = 47;
    pub const FONT_STREAM_REQUESTS: u8 = 48;
    pub const FONT_STREAM_COMMIT: u8 = 49;
    pub const FONT_STREAM_STATS: u8 = 50;
    pub const APP_CLOSE: u8 = 51;
}

/// Property ids (u8, stable, append-only). Groups:
/// 1..63 layout | 64..95 visual | 96..127 text | 128..159 transform.
pub mod prop {
    pub const WIDTH: u8 = 1;
    pub const HEIGHT: u8 = 2;
    pub const MIN_W: u8 = 3;
    pub const MIN_H: u8 = 4;
    pub const MAX_W: u8 = 5;
    pub const MAX_H: u8 = 6;
    pub const PADDING_T: u8 = 8;
    pub const PADDING_R: u8 = 9;
    pub const PADDING_B: u8 = 10;
    pub const PADDING_L: u8 = 11;
    pub const MARGIN_T: u8 = 12;
    pub const MARGIN_R: u8 = 13;
    pub const MARGIN_B: u8 = 14;
    pub const MARGIN_L: u8 = 15;
    pub const GAP: u8 = 16;
    pub const FLEX_DIR: u8 = 17;
    pub const JUSTIFY: u8 = 18;
    pub const ALIGN: u8 = 19;
    pub const GROW: u8 = 20;
    pub const SHRINK: u8 = 21;
    pub const BASIS: u8 = 22;
    pub const FLEX_WRAP: u8 = 23;
    pub const POS_TYPE: u8 = 24;
    pub const INSET_T: u8 = 25;
    pub const INSET_R: u8 = 26;
    pub const INSET_B: u8 = 27;
    pub const INSET_L: u8 = 28;
    pub const DISPLAY: u8 = 29;
    pub const OVERFLOW: u8 = 30;
    pub const Z_INDEX: u8 = 31;
    pub const HIT_PASS: u8 = 32;
    pub const BG_COLOR: u8 = 64;
    pub const GRAD_FROM: u8 = 65;
    pub const GRAD_TO: u8 = 66;
    pub const GRAD_DIR: u8 = 67;
    pub const RADIUS: u8 = 68;
    pub const OPACITY: u8 = 69;
    pub const BORDER_COLOR: u8 = 70;
    pub const BORDER_WIDTH: u8 = 71;
    pub const SHADOW: u8 = 72;
    pub const BEVEL_OUTER_LIGHT: u8 = 77;
    pub const BEVEL_OUTER_DARK: u8 = 78;
    pub const BEVEL_INNER_LIGHT: u8 = 79;
    pub const BEVEL_INNER_DARK: u8 = 80;
    pub const BEVEL_WIDTH: u8 = 81;
    pub const GRAD_VIA: u8 = 82;
    pub const GRAD_VIA_POS: u8 = 83;
    pub const TEXT_COLOR: u8 = 96;
    pub const FONT_SLOT: u8 = 97;
    pub const TEXT_ALIGN: u8 = 98;
    pub const LINE_HEIGHT: u8 = 99;
    pub const TRACKING: u8 = 100;
    pub const TRANSLATE_X: u8 = 128;
    pub const TRANSLATE_Y: u8 = 129;
    pub const SCALE: u8 = 130;
    pub const ROTATE: u8 = 131;
    pub const SCALE_X: u8 = 132;
    pub const SCALE_Y: u8 = 133;
    pub const ORIGIN_X: u8 = 134;
    pub const ORIGIN_Y: u8 = 135;
    pub const ROTATE_X: u8 = 136;
    pub const ROTATE_Y: u8 = 137;
    pub const TRANSLATE_Z: u8 = 138;
    pub const PERSPECTIVE: u8 = 139;
    pub const ARC_START: u8 = 140;
    pub const ARC_SWEEP: u8 = 141;
    pub const ARC_WIDTH: u8 = 142;
}

/// How a prop's u32 payload is interpreted (see spec.ts VALUE_KIND).
pub mod value_kind {
    pub const F32: u8 = 0;
    pub const COLOR: u8 = 1;
    pub const INT: u8 = 2;
}

/// PROP_VALUE_KIND[prop id] -> value_kind (0xff = unassigned id).
pub const PROP_VALUE_KIND: [u8; 256] = [
    0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x02, 0x02, 0x02, 0x00, 0x00, 0x00, 0x02, 0x02, 0x00, 0x00, 0x00, 0x00, 0x02, 0x02, 0x02,
    0x02, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x01, 0x01, 0x01, 0x02, 0x00, 0x00, 0x01, 0x00, 0x02, 0xff, 0xff, 0xff, 0xff, 0x01, 0x01, 0x01,
    0x01, 0x00, 0x01, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x01, 0x02, 0x02, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
];

/// ANIM_BIT[prop id] -> transition-mask bit index (0xff = not animatable).
/// The bit order is spec.ts ANIMATABLE order — append-only.
pub const ANIM_BIT: [u8; 256] = [
    0xff, 0x00, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09,
    0x0a, 0xff, 0xff, 0xff, 0xff, 0xff, 0x0b, 0xff, 0xff, 0x0c, 0x0d, 0x0e, 0x0f, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x10, 0x11, 0x12, 0xff, 0x13, 0x14, 0x15, 0x16, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x17, 0xff, 0xff, 0x18, 0x19, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0xff, 0xff, 0x20, 0x21, 0x22, 0xff, 0x23, 0x24, 0x25, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
];

/// Bitset over prop ids: animatable props (tween/spring/transition targets).
pub const ANIMATABLE_BITS: [u64; 4] = [0x000000001e41ff06, 0x00000019000000f7, 0x000000000000773f, 0x0000000000000000];
/// Bitset over prop ids: props whose change invalidates layout.
pub const LAYOUT_DIRTY_BITS: [u64; 4] = [0x000000007fffff7e, 0x0000001e00000000, 0x0000000000000000, 0x0000000000000000];

pub const fn is_animatable(prop: u8) -> bool {
    ANIMATABLE_BITS[(prop >> 6) as usize] & (1u64 << (prop & 63)) != 0
}
pub const fn is_layout_dirtying(prop: u8) -> bool {
    LAYOUT_DIRTY_BITS[(prop >> 6) as usize] & (1u64 << (prop & 63)) != 0
}

/// flex-direction.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FlexDir {
    Row = 0,
    Col = 1,
}

/// justify-content.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Justify {
    Start = 0,
    Center = 1,
    End = 2,
    Between = 3,
    Around = 4,
}

/// align-items.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Align {
    Start = 0,
    Center = 1,
    End = 2,
    Stretch = 3,
}

/// position type.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PosType {
    Relative = 0,
    Absolute = 1,
}

/// display (None removes from layout AND paint).
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Display {
    Flex = 0,
    None = 1,
}

/// overflow (Hidden => scissor in draw).
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Overflow {
    Visible = 0,
    Hidden = 1,
}

/// text alignment within the node box.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TextAlign {
    Left = 0,
    Center = 1,
    Right = 2,
}

/// gradient direction (`bg-gradient-to-t|b|l|r`).
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum GradDir {
    ToTop = 0,
    ToBottom = 1,
    ToLeft = 2,
    ToRight = 3,
}

/// animation easing. Spring/SpringBouncy ignore durMs (physics decide); OutBack overshoots ~10%.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Easing {
    Linear = 0,
    EaseIn = 1,
    EaseOut = 2,
    EaseInOut = 3,
    OutBack = 4,
    Spring = 5,
    SpringBouncy = 6,
    CubicBezier = 7,
}

/// PSM texture pixel formats — MUST equal rust-psp TexturePixelFormat
/// (sceGuTexMode arg; verified against rust-psp/psp/src/sys/gu.rs).
/// PSM_T8 (CLUT8) uploads as: 1024-byte palette (256 x u32 ABGR), then
/// w*h index bytes.
pub mod psm {
    pub const PSM_5650: u32 = 0;
    pub const PSM_4444: u32 = 2;
    pub const PSM_8888: u32 = 3;
    pub const PSM_T8: u32 = 5;
}

/// IMG entry flags (framework/compiler/pak.ts IMG entry byte 5; v1 wrote 0).
pub mod img {
    pub const FLAG_RLE: u8 = 1; // pixel stream is PackBits-RLE
    pub const FLAG_LINEAR: u8 = 2; // bilinear sampling
}

/// TILESET pak entry (deep-zoom tile grids; full layout in spec.ts).
/// One shared 256-color palette per entry; solid tiles live in the dir.
pub mod tileset {
    pub const MAGIC: u32 = 0x53544b50; // 'PKTS' LE
    pub const VERSION: u16 = 1;
    pub const HEADER_SIZE: usize = 32;
    pub const DIR_ENTRY_SIZE: usize = 8;
    pub const ABSENT: u32 = 0xffffffff;
    pub const FLAG_RLE: u16 = 1;
    pub const FLAG_LINEAR: u16 = 2;
}

/// Host service channel limits (spec.ts SVC — pocket-svc/<app>/ mailbox).
pub mod svc {
    pub const POLL_BUF: usize = 8192;
    pub const IMG_MAX_BYTES: usize = 131072;
}

/// STREAM container (.pkst) — host-written video+audio ring file.
/// Full byte layout in spec.ts; parsed by engine/core/src/stream.rs.
pub mod stream {
    pub const MAGIC: u32 = 0x54534b50; // 'PKST' LE
    pub const VERSION: u16 = 1;
    pub const HEADER_SIZE: usize = 32;
    pub const VRING_MAGIC: u32 = 0x52564b50; // 'PKVR' LE
    pub const VRING_OFF: usize = 32;
    pub const ARING_MAGIC: u32 = 0x52414b50; // 'PKAR' LE
    pub const ARING_OFF: usize = 64;
    pub const HEADER_BLOCK_SIZE: usize = 96;
    pub const SLOT_HEADER_SIZE: usize = 32;
    pub const CHUNK_HEADER_SIZE: usize = 16;
    pub const FLAG_ENDED: u16 = 1;
}

/// SVC WIRE protocol (PKNT) — the svc mailbox over a socket.
/// Full byte layout in spec.ts; parsed by engine/core/src/wire.rs.
pub mod wire {
    pub const MAGIC: u32 = 0x544e4b50; // 'PKNT' LE
    pub const BEACON_MAGIC: u32 = 0x42444b50; // 'PKDB' LE
    pub const VERSION: u8 = 1;
    pub const HEADER_SIZE: usize = 8;
    pub const MAX_PAYLOAD: usize = 262144;
    pub const BEACON_PORT: u16 = 8621;
    pub const PORT: u16 = 8622;
    pub const MSG_PING: u8 = 0x01;
    pub const MSG_PONG: u8 = 0x02;
    pub const MSG_CTRL: u8 = 0x10;
    pub const MSG_FILE: u8 = 0x20;
    pub const MSG_STREAM_OPEN: u8 = 0x30;
    pub const MSG_STREAM_CLOSE: u8 = 0x31;
    pub const MSG_VIDEO_SLOT: u8 = 0x32;
    pub const MSG_AUDIO_CHUNK: u8 = 0x33;
    pub const MSG_STREAM_MARK: u8 = 0x34;
    pub const SLOT_HEADER_SIZE: usize = 16;
    pub const CHUNK_HEADER_SIZE: usize = 8;
    pub const MARK_SIZE: usize = 8;
    pub const SLOT_FLAG_RLE: u16 = 1;
    pub const MARK_FLAG_ENDED: u16 = 1;
}

/// STYLE TABLE (styles.bin) format constants — full layout in spec.ts.
pub mod style_table {
    pub const MAGIC: u32 = 0x54534344; // 'DCST' LE
    pub const VERSION: u16 = 2;
    pub const HEADER_SIZE: usize = 12;
    pub const TRANSITION_SIZE: usize = 12;
    pub const PROP_RECORD_SIZE: usize = 6;
    pub const VARIANT_BASE: u8 = 1;
    pub const VARIANT_FOCUS: u8 = 2;
    pub const VARIANT_ACTIVE: u8 = 4;
    pub const HAS_TRANSITION: u8 = 8;
    pub const HAS_ANIMATION: u8 = 16;
    pub const ANIM_ENTRY_HEADER_SIZE: usize = 8;
    pub const ANIM_SEGMENT_SIZE: usize = 14;
    pub const ANIM_BEZIER_EXTRA_SIZE: usize = 16;
    pub const ANIM_FILL_BACKWARDS: u8 = 1;
    pub const ANIM_FILL_FORWARDS: u8 = 2;
}

/// FONT ATLAS blob format constants — full layout in spec.ts.
pub mod font_atlas {
    pub const MAGIC: u32 = 0x41464344; // 'DCFA' LE
    pub const VERSION: u16 = 3;
    pub const HEADER_SIZE: usize = 16;
    pub const CMAP_ENTRY_SIZE: usize = 8;
    pub const FLAG_BOLD: u8 = 1;
}

/// DrawList op codes (core -> backend Vec<u32> words; layout in spec.ts).
/// Word counts incl. header: RECT 4, GRAD_RECT 6, GLYPH_RUN 3+2n,
/// TEX_QUAD 9, SCISSOR 3, SCISSOR_POP 1, TRI 7, TEX_TRI 12,
/// TEXT_RUN 8+ceil(bytes/4), SURFACE_QUAD 9.
pub mod draw_op {
    pub const RECT: u32 = 1;
    pub const GRAD_RECT: u32 = 2;
    pub const GLYPH_RUN: u32 = 3;
    pub const TEX_QUAD: u32 = 4;
    pub const SCISSOR: u32 = 5;
    pub const SCISSOR_POP: u32 = 6;
    pub const TRI: u32 = 7;
    pub const TEX_TRI: u32 = 8;
    pub const TEXT_RUN: u32 = 9;
    pub const SURFACE_QUAD: u32 = 10;
}

/// .pak container constants (byte-compatible with dreamcart's format;
/// copied from framework/bake/pak.ts + docs/pak-format.md).
pub mod pak {
    pub const MAGIC: u32 = 0x4b504344; // 'DCPK' LE
    pub const VERSION: u16 = 1;
    pub const HEADER_SIZE: usize = 32;
    pub const ENTRY_SIZE: usize = 24;
    pub const ALIGN: usize = 16;
    pub const FNV1A_OFFSET_BASIS: u32 = 0x811c9dc5;
    pub const FNV1A_PRIME: u32 = 0x01000193;
    pub const DT_U8: u8 = 0;
    pub const DT_I8: u8 = 1;
    pub const DT_U16: u8 = 2;
    pub const DT_I16: u8 = 3;
    pub const DT_U32: u8 = 4;
    pub const DT_I32: u8 = 5;
    pub const DT_F32: u8 = 6;
    pub const DT_F64: u8 = 7;
}

/// PSP button bitmask — identical on every host. Verified against
/// dreamcart web/engine.js and rust-psp/psp/src/sys/ctrl.rs (CtrlButtons).
pub mod btn {
    pub const SELECT: u32 = 0x0001;
    pub const START: u32 = 0x0008;
    pub const UP: u32 = 0x0010;
    pub const RIGHT: u32 = 0x0020;
    pub const DOWN: u32 = 0x0040;
    pub const LEFT: u32 = 0x0080;
    pub const LTRIGGER: u32 = 0x0100;
    pub const RTRIGGER: u32 = 0x0200;
    pub const ZL: u32 = 0x0400;
    pub const ZR: u32 = 0x0800;
    pub const TRIANGLE: u32 = 0x1000;
    pub const CIRCLE: u32 = 0x2000;
    pub const CROSS: u32 = 0x4000;
    pub const SQUARE: u32 = 0x8000;
}

/// frame(buttons, analog): analog packs the nub as (x << 8) | y, each
/// axis 0..255 with 128 = center. Hosts without a stick omit the arg;
/// the runtime defaults to this value (so old tapes/goldens hold).
pub const ANALOG_CENTER: u32 = 0x8080;

/// AUDIO module boundary (contracts/spec/audio.ts — `globalThis.audio`).
/// Credit-based PCM streaming; events batch to tick boundaries via poll().
/// Frames consumed on virtual tick n at 60 ticks/s (the determinism
/// contract): floor((n+1)*rate/60) - floor(n*rate/60).
pub mod audio {
    pub const OP_CREATE_STREAM: u8 = 1;
    pub const OP_DESTROY_STREAM: u8 = 2;
    pub const OP_WRITE_PCM: u8 = 3;
    pub const OP_PLAY: u8 = 4;
    pub const OP_PAUSE: u8 = 5;
    pub const OP_STOP: u8 = 6;
    pub const OP_SET_VOLUME: u8 = 7;
    pub const OP_END_STREAM: u8 = 8;
    pub const OP_POLL: u8 = 9;
    /// Accepted stream rates: integer divisors of the PSP's native 44.1 kHz.
    pub const RATES: [u32; 3] = [44100, 22050, 11025];
    pub const MAX_CHANNELS: u32 = 2;
    /// Per-stream ring capacity in SOURCE sample frames (credit ceiling).
    pub const RING_FRAMES: usize = 16384;
    pub const MAX_STREAMS: usize = 4;
    pub const EVENT_CREDIT: &str = "credit";
    pub const EVENT_UNDERRUN: &str = "underrun";
    pub const EVENT_ENDED: &str = "ended";
}

/// DB module boundary (contracts/spec/db.ts — `globalThis.db`).
/// SQLite behind five synchronous ops; rows cross as one JSON line per
/// query() call. The module owns no clock and emits no events.
pub mod db {
    pub const OP_OPEN: u8 = 1;
    pub const OP_CLOSE: u8 = 2;
    pub const OP_EXEC: u8 = 3;
    pub const OP_QUERY: u8 = 4;
    pub const OP_LAST_ERROR: u8 = 5;
    /// The in-memory database name (private to the handle).
    pub const MEMORY: &str = ":memory:";
    /// Marker key for a BLOB value inside a row or a parameter list.
    pub const BLOB_KEY: &str = "$b";
    /// Largest integer magnitude that crosses the boundary losslessly.
    pub const MAX_SAFE_INTEGER: i64 = 9007199254740991;
    pub const MAX_DATABASES: usize = 4;
    /// Result-row ceiling per query() call (exceeding it fails the op).
    pub const MAX_RESULT_ROWS: usize = 4096;
}

/// FS module boundary (contracts/spec/fs.ts — `globalThis.fs`).
/// A per-app file tree behind nine synchronous ops; every path resolves
/// under the app's own data root. No clock, no events, no mtime.
pub mod fs {
    pub const OP_READ: u8 = 1;
    pub const OP_WRITE: u8 = 2;
    pub const OP_REMOVE: u8 = 3;
    pub const OP_LIST: u8 = 4;
    pub const OP_STAT: u8 = 5;
    pub const OP_MKDIR: u8 = 6;
    pub const OP_RENAME: u8 = 7;
    pub const OP_USAGE: u8 = 8;
    pub const OP_LAST_ERROR: u8 = 9;
    /// write() modes.
    pub const WRITE_TRUNCATE: u32 = 0;
    pub const WRITE_APPEND: u32 = 1;
    /// Marker key for a bytes payload (db's blob spelling).
    pub const BLOB_KEY: &str = "$b";
    /// Maximum UTF-8 bytes in one path segment.
    pub const MAX_SEGMENT_BYTES: usize = 64;
    /// Maximum segments in a path.
    pub const MAX_DEPTH: usize = 8;
    /// Maximum total path length in bytes.
    pub const MAX_PATH_BYTES: usize = 160;
    /// Payload ceiling per read()/write() call, in bytes.
    pub const MAX_IO_BYTES: usize = 65536;
    /// Entries per list() call (paged via offset + eof).
    pub const MAX_DIR_ENTRIES: usize = 256;
}

/// NET module boundary (contracts/spec/net.ts — `globalThis.net`).
/// Bounded whole-response HTTP; completions batch to tick boundaries.
pub mod net {
    pub const OP_START: u8 = 1;
    pub const OP_TAKE: u8 = 2;
    pub const OP_CANCEL: u8 = 3;
    pub const OP_POLL: u8 = 4;
    pub const OP_LAST_ERROR: u8 = 5;
    pub const MAX_INFLIGHT: usize = 2;
    pub const MAX_REQUEST_BYTES: usize = 65536;
    pub const DEFAULT_RESPONSE_BYTES: usize = 131072;
    pub const MAX_RESPONSE_BYTES: usize = 262144;
    pub const MAX_HEADERS: usize = 32;
    pub const MAX_HEADER_BYTES: usize = 8192;
    pub const DEFAULT_TIMEOUT_MS: u32 = 30000;
    pub const MAX_TIMEOUT_MS: u32 = 120000;
    pub const MAX_REDIRECTS: usize = 3;
    pub const METHODS: [&str; 7] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
    pub const EVENT_DONE: &str = "done";
    pub const EVENT_ERROR: &str = "error";
    pub const ERROR_UNAVAILABLE: &str = "unavailable";
    pub const ERROR_INVALID_REQUEST: &str = "invalid_request";
    pub const ERROR_BUSY: &str = "busy";
    pub const ERROR_DNS: &str = "dns";
    pub const ERROR_CONNECT: &str = "connect";
    pub const ERROR_TLS: &str = "tls";
    pub const ERROR_TIMEOUT: &str = "timeout";
    pub const ERROR_REDIRECT: &str = "redirect";
    pub const ERROR_RESPONSE_TOO_LARGE: &str = "response_too_large";
    pub const ERROR_PROTOCOL: &str = "protocol";
    pub const ERROR_CANCELLED: &str = "cancelled";
    pub const ERROR_OTHER: &str = "other";
}
