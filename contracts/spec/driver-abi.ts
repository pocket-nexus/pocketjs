// Candidate device ABI; freeze follows the out-of-tree integration gate.
// No runtime implementation or platform selection belongs in this schema.
import { INPUT_ABI_CONSTANTS, MOTION_VALUES } from "./input.ts";
import { DRAW_LIST_VERSION } from "./spec.ts";
import { MOTION_METADATA_TYPES } from "./motion.ts";

export interface AbiField { readonly name: string; readonly type: string; readonly doc?: string }
export interface AbiRecord { readonly name: string; readonly cName: string; readonly fields: readonly AbiField[]; readonly doc?: string }
export interface AbiCallback { readonly name: string; readonly cName: string; readonly args: readonly AbiField[]; readonly result: string; readonly doc?: string }
export interface AbiFunction { readonly name: string; readonly args: readonly AbiField[]; readonly result: string; readonly doc?: string }
export const field = (name: string, type: string, doc?: string): AbiField => ({ name, type, ...(doc ? { doc } : {}) });
export const record = (name: string, cName: string, fields: readonly AbiField[], doc?: string): AbiRecord => ({ name, cName, fields: [field("struct_size", "usize"), ...fields], ...(doc ? { doc } : {}) });
export const callback = (name: string, cName: string, args: readonly AbiField[], result = "i32", doc?: string): AbiCallback => ({ name, cName, args, result, ...(doc ? { doc } : {}) });
const f = field;
const context = f("context", "*mut c_void");

export const DRIVER_ABI_RULES = [
  "This is a candidate ABI; out-of-tree integration must pass before v1 is frozen.",
  "Every record starts with struct_size in bytes. Read only complete fields within min(struct_size, known size). Missing callbacks are unsupported; ignore unknown trailing fields. Appended fields must not increase record alignment; use a pointer for new over-aligned data. Callers initialize output struct_size to their writable capacity; callees must not write beyond it.",
  "Record arrays are packed records: advance by each element's struct_size, not the consumer's sizeof. Each size includes padding to that record's alignment; validate the size, alignment and enclosing buffer bounds before reading a prefix, and never cast a short prefix into a full-sized record. A zero count permits a null pointer. A nonzero count requires the caller to provide valid readable storage for every element including its announced size; pointers and counts cannot prove the underlying allocation extent.",
  "Status zero means success; negative values mean errors. Callback absence is unsupported. Driver context and vtables remain valid until runtime destruction, after all outstanding work has been drained. Runtime calls occur on its single owning thread.",
  "PIPELINED_ACQUIRE requires CPU-visible double staging buffers and device frame storage. After flush, acquire may return the other buffer while the first transfer is pending; at most two transfers are pending. Never return storage still read by a transfer. Missing this flag requires display wait before reacquisition.",
  "Lifecycle: acquire, render, renderer wait, flush, display wait, retire. Each display has its own submission. A shared resource remains live until its last referencing submission retires.",
  "An IMMEDIATE renderer's frame completes before present returns. A DEFERRED renderer's frame stays in flight through the next guest turn; the runtime completes it at the next present, pocket_runtime_complete_presentation, a display refresh, or runtime destruction, before acquiring that display again.",
  "QUEUED_FLUSH requires a device-owned target. The device starts a flushed transfer only after the rendering already submitted to the target completes and guards its scanout buffers itself. With a DEFERRED renderer the runtime calls flush after render and before renderer wait; completion then runs renderer wait, display wait, retire. Without the flag a DEFERRED frame is flushed at completion, after renderer wait.",
  "CPU-visible targets require immediate rendering. Device-owned targets must complete rendering before flush starts, except on a QUEUED_FLUSH display. Acquired regions are exclusive until flush; nobody writes them until display wait returns.",
  "render and flush errors are terminal: drain or cancel all submitted work before returning an error. Both wait callbacks return only after completion or cancellation on success AND error; there is no in-progress or recoverable timeout result. Reset hung hardware before returning failure.",
  "Ordinary render borrows end on return. Deferred work must use driver-owned copies. render_zero_copy is a separate unsafe contract: the caller keeps every frame resource alive and unchanged through renderer wait, including error returns. At most one zero-copy frame is in flight before the next script mutation.",
  "Retire runs after rendering and display transfer stop accessing memory. Destroy and application replacement drain all submissions and tokens before freeing resources. A failed frame invalidates the buffer's damage history. A failed DEFERRED completion is reported by the call that completes it and invalidates only that display's history.",
  "Software fallback requires a CPU-visible target, drained accelerator work, cache visibility, and writes restricted to the acquired region. Only the baseline eight operations have software fallback; textRun and surfaceQuad need profile-declared native support.",
  "DrawList has a closed operation set without per-operation lengths. Headers and the runtime archive must share the DrawList version. No unknown-operation skipping or renderer fallback chain is defined.",
] as const;

export const DRIVER_ABI_CONSTANTS: Readonly<Record<string, number>> = {
  ...INPUT_ABI_CONSTANTS,
  POCKET_DRAW_LIST_VERSION: DRAW_LIST_VERSION,
  POCKET_PIXEL_FORMAT_RGB565: 0, POCKET_PIXEL_FORMAT_RGBA8888: 1, POCKET_PIXEL_FORMAT_ARGB8888: 2,
  POCKET_PIXEL_FORMAT_BGR888: 3, POCKET_PIXEL_FORMAT_GRAY8: 4, POCKET_PIXEL_FORMAT_GRAY4: 5, POCKET_PIXEL_FORMAT_MONO1: 6,
  POCKET_DISPLAY_ROLE_PRIMARY: 0, POCKET_DISPLAY_ROLE_AUXILIARY: 1,
  POCKET_TARGET_CPU_VISIBLE: 0, POCKET_TARGET_DEVICE_OWNED: 1,
  POCKET_SYNC_IMMEDIATE: 0, POCKET_SYNC_DEFERRED: 1,
  POCKET_VSYNC_NONE: 0, POCKET_VSYNC_DEVICE: 1, POCKET_VSYNC_CLOCK: 2,
  POCKET_DISPLAY_DOUBLE_BUFFERED: 1, POCKET_DISPLAY_PARTIAL_REFRESH: 2, POCKET_DISPLAY_FRAME_STORAGE: 4,
  POCKET_DISPLAY_DEVICE_ROTATION: 8, POCKET_DISPLAY_DEVICE_SCALING: 16, POCKET_DISPLAY_PIPELINED_ACQUIRE: 64,
  POCKET_DISPLAY_QUEUED_FLUSH: 128, POCKET_DISPLAY_RETAINED_MOVE: 256,
  POCKET_STATUS_OK: 0, POCKET_STATUS_UNSUPPORTED: -1, POCKET_STATUS_INVALID: -2, POCKET_STATUS_FAILED: -3,
  POCKET_PACKAGE_STORAGE_VERIFIED: 1,
};

// Motion members and metadata are derived from the existing fused-motion spec.
const pascal = (name: string) => name[0]!.toUpperCase() + name.slice(1);
const snake = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const motionRecords: AbiRecord[] = Object.entries(MOTION_VALUES).map(([name, spec]) => record(
  `PocketMotion${pascal(name)}`, `pocket_motion_${snake(name)}`,
  [f("value", `[f32; ${spec.components.length}]`), ...spec.metadata.filter(key => key !== "timestamp").map(key => f(snake(key), MOTION_METADATA_TYPES[key]))],
));

export const DRIVER_ABI_STRUCTS: readonly AbiRecord[] = [
  record("PocketRect", "pocket_rect", [f("x", "u32"), f("y", "u32"), f("width", "u32"), f("height", "u32")]),
  record("PocketBufferIdentity", "pocket_buffer_identity", [f("buffer", "u64"), f("generation", "u64")], "Identity of the retained output pixels updated by this frame, stable until the next frame_identity call. Use one identity per physical framebuffer, or one for panel GRAM. Change generation after resets, external pixel writes or changed output rules."),
  record("PocketSurface", "pocket_surface", [f("pixels", "*mut u8"), f("byte_length", "usize"), f("region", "*const PocketRect"), f("stride_bytes", "usize"), f("pixel_format", "u32")], "CPU-writable storage for region; row stride is in bytes, including packed Gray4/Mono1 rows."),
  record("PocketTarget", "pocket_target", [f("kind", "u32"), f("region", "*const PocketRect"), f("pixel_format", "u32"), f("surface", "*mut PocketSurface"), f("device_handle", "u64")], "CPU_VISIBLE uses surface; DEVICE_OWNED uses device_handle. The inactive payload is zero/null."),
  record("PocketDisplayDescriptor", "pocket_display_descriptor", [f("role", "u32"), f("width", "u32"), f("height", "u32"), f("pixel_format", "u32"), f("stride_bytes", "usize"), f("target_kind", "u32"), f("flags", "u32"), f("refresh_width", "u32"), f("refresh_height", "u32"), f("window_x_alignment", "u32"), f("window_y_alignment", "u32"), f("vsync_source", "u32")], "Dimensions are physical pixels. Refresh granularity and window alignments are positive. Flags describe buffering, GRAM, rotation, scaling and queued flush ordering."),
  record("PocketRendererDescriptor", "pocket_renderer_descriptor", [f("pixel_formats", "*const u32"), f("pixel_format_count", "usize"), f("target_kind", "u32"), f("synchronization", "u32"), f("draw_list_version", "u32"), f("zero_copy", "u32")], "Facts used by present to select a strategy; no negotiation. pixel_formats stays valid for the driver lifetime. zero_copy is 0 or 1."),
  record("PocketDrawList", "pocket_draw_list", [f("words", "*const u32"), f("word_count", "usize"), f("version", "u32")]),
  record("PocketLogicalClip", "pocket_logical_clip", [f("x0", "i32"), f("y0", "i32"), f("x1", "i32"), f("y1", "i32")], "Half-open inherited clip in logical viewport coordinates."),
  record("PocketDrawOp", "pocket_draw_op", [f("words", "*const u32"), f("word_count", "usize"), f("clip", "*const PocketLogicalClip"), f("scale", "u32")], "One complete operation from the matching DrawList generation. Missing/null clip uses the logical viewport; missing scale uses 1. Present scale must be positive. Word layouts are defined by spec.ts."),
  record("PocketTextureView", "pocket_texture_view", [f("pixels", "*const u8"), f("byte_length", "usize"), f("width", "u32"), f("height", "u32"), f("psm", "u32"), f("palette", "*const u8"), f("palette_byte_length", "usize"), f("revision", "u64"), f("linear", "u32")], "psm is the existing DrawList texture format, independent of display pixel_format. Borrowed pixels and palette follow the frame borrow."),
  record("PocketFontView", "pocket_font_view", [f("bitmap", "*const u8"), f("byte_length", "usize"), f("cell_width", "u32"), f("cell_height", "u32"), f("raster_density", "u32"), f("glyph_count", "u32")]),
  record("PocketRenderResources", "pocket_render_resources", [f("context", "*const c_void"), f("viewport_width", "f32"), f("viewport_height", "f32"), f("raster_revision", "u64"), f("texture", "Option<PocketTextureFn>"), f("font_atlas", "Option<PocketFontAtlasFn>"), f("texture_revision", "Option<PocketTextureRevisionFn>"), f("font_revision", "Option<PocketFontRevisionFn>"), f("font_texture_width", "Option<PocketFontTextureWidthFn>")], "Absent version callbacks use raster_revision; absent font_texture_width uses full coverage width. Read-only resource lookups; views borrow the frame's resources."),
  record("PocketFrameInput", "pocket_frame_input", [f("list", "*const PocketDrawList"), f("resources", "*const PocketRenderResources"), f("damage", "*const PocketRect"), f("damage_count", "usize"), f("target", "*const PocketTarget")]),
  record("PocketAxisSample", "pocket_axis_sample", [f("axis", "u32"), f("value", "f32")]),
  record("PocketAxisDelta", "pocket_axis_delta", [f("axis", "u32"), f("delta", "i32")], "Signed millidegrees, preserving the existing relative-axis frame wire format."),
  record("PocketPointer", "pocket_pointer", [f("surface", "u32"), f("x", "f32"), f("y", "f32"), f("buttons", "u32")]),
  record("PocketContact", "pocket_contact", [f("surface", "u32"), f("id", "u32"), f("x", "f32"), f("y", "f32"), f("cancelled", "u32")]),
  record("PocketCancelledContact", "pocket_cancelled_contact", [f("surface", "u32"), f("id", "u32")]),
  record("PocketTextEvent", "pocket_text_event", [f("kind", "u32"), f("text", "*const u8"), f("byte_length", "usize"), f("selection_start", "u32"), f("selection_end", "u32"), f("repeat", "u32")], "Text is borrowed UTF-8. Composition selections use UTF-8 byte offsets; repeat is 0 or 1."),
  ...motionRecords,
  record("PocketMotionState", "pocket_motion_state", [f("timestamp", "u64"), ...Object.keys(MOTION_VALUES).map(name => f(snake(name), `*const PocketMotion${pascal(name)}`))], "Timestamp is monotonic microseconds. A null member is unavailable; quality/reference/epoch semantics come from motion.ts."),
  record("PocketInputFrame", "pocket_input_frame", [f("buttons", "u32"), f("axes", "*const PocketAxisSample"), f("axis_count", "usize"), f("relative", "*const PocketAxisDelta"), f("relative_count", "usize"), f("pointer", "*const PocketPointer"), f("contacts", "*const PocketContact"), f("contact_count", "usize"), f("cancelled", "*const PocketCancelledContact"), f("cancelled_count", "usize"), f("text", "*const PocketTextEvent"), f("text_count", "usize"), f("motion", "*const PocketMotionState")]),
  record("PocketInputFrameBuilder", "pocket_input_frame_builder", [context, f("append", "Option<PocketInputAppendFn>")], "append copies a driver's contribution before returning; the driver need not retain borrowed input memory. Runtime merges sources and resolves hit facts once."),
  record("PocketDisplayOutputV1", "pocket_display_output_v1", [f("descriptor", "Option<PocketDisplayDescriptorFn>"), f("acquire", "Option<PocketDisplayAcquireFn>"), f("flush", "Option<PocketDisplayFlushFn>"), f("wait", "Option<PocketDisplayWaitFn>"), f("vsync", "Option<PocketDisplayVsyncFn>"), f("frame_identity", "Option<PocketDisplayFrameIdentityFn>"), f("move_pixels", "Option<PocketDisplayMoveFn>"), f("host_damage", "Option<PocketDisplayHostDamageFn>")]),
  record("PocketRendererV1", "pocket_renderer_v1", [f("descriptor", "Option<PocketRendererDescriptorFn>"), f("render", "Option<PocketRenderFn>"), f("wait", "Option<PocketRenderWaitFn>"), f("retire", "Option<PocketRenderRetireFn>"), f("render_zero_copy", "Option<PocketRenderZeroCopyFn>")]),
  record("PocketInputSourceV1", "pocket_input_source_v1", [f("classes", "Option<PocketInputClassesFn>"), f("poll", "Option<PocketInputPollFn>")]),
  record("PocketPackageStorage", "pocket_package_storage", [f("bytes", "*const u8"), f("length", "usize"), f("release", "Option<PocketPackageReleaseFn>"), f("release_context", "*mut c_void"), f("flags", "u32")], "Storage a source transfers through take. bytes stay valid and unchanged until the runtime calls release with release_context, bytes and length; a null release means they outlive the runtime. POCKET_PACKAGE_STORAGE_VERIFIED in flags states that the owner verified the package's FNV-1a64 footer and variant hashes of these exact bytes, so the runtime admits them without its own hash pass."),
  record("PocketPackageSourceV1", "pocket_package_source_v1", [f("length", "Option<PocketPackageLengthFn>"), f("all", "Option<PocketPackageAllFn>"), f("range", "Option<PocketPackageRangeFn>"), f("take", "Option<PocketPackageTakeFn>")], "all and take are optional; range supports sources without contiguous storage. Returned all bytes remain borrowed until the next call on this source. take transfers the package without a copy; without it, or when it returns UNSUPPORTED, the runtime copies the bytes through all or range."),
  record("PocketClockV1", "pocket_clock_v1", [f("now", "Option<PocketClockNowFn>"), f("sleep_until", "Option<PocketClockSleepUntilFn>")]),
];

export const DRIVER_ABI_CALLBACKS: readonly AbiCallback[] = [
  callback("PocketTextureFn", "pocket_texture_fn", [f("context", "*const c_void"), f("handle", "i32"), f("out", "*mut PocketTextureView")]),
  callback("PocketTextureRevisionFn", "pocket_texture_revision_fn", [f("context", "*const c_void"), f("handle", "i32"), f("out", "*mut u64")]),
  callback("PocketFontRevisionFn", "pocket_font_revision_fn", [f("context", "*const c_void"), f("slot", "u8"), f("out", "*mut u64")]),
  callback("PocketFontTextureWidthFn", "pocket_font_texture_width_fn", [f("context", "*const c_void"), f("slot", "u8"), f("out", "*mut u32")]),
  callback("PocketFontAtlasFn", "pocket_font_atlas_fn", [f("context", "*const c_void"), f("slot", "u8"), f("out", "*mut PocketFontView")]),
  callback("PocketDisplayFrameIdentityFn", "pocket_display_frame_identity_fn", [context, f("out", "*mut PocketBufferIdentity")], "i32", "Optional. Unsupported or an absent callback requires full redraws. Called once before a frame; does not publish output or invalidate pending device access."),
  callback("PocketDisplayDescriptorFn", "pocket_display_descriptor_fn", [context, f("out", "*mut PocketDisplayDescriptor")]),
  callback("PocketDisplayAcquireFn", "pocket_display_acquire_fn", [context, f("region", "*const PocketRect"), f("out", "*mut PocketTarget")]),
  callback("PocketDisplayFlushFn", "pocket_display_flush_fn", [context, f("regions", "*const PocketRect"), f("region_count", "usize"), f("token", "*mut u64")], "i32", "On error all submitted transfer work is stopped before return."),
  callback("PocketDisplayWaitFn", "pocket_display_wait_fn", [context, f("token", "u64")], "i32", "Consumes token. Both success and error guarantee the display no longer accesses target memory."),
  callback("PocketDisplayVsyncFn", "pocket_display_vsync_fn", [context], "u32"),
  callback("PocketDisplayMoveFn", "pocket_display_move_fn", [context, f("destination", "*const PocketRect"), f("dx", "i32"), f("dy", "i32")], "i32", "RETAINED_MOVE displays only. Called after frame_identity and before the frame's first acquire: every retained pixel of destination takes the value of the pixel at (-dx, -dy) from it. The display completes the move before any later flush writes. UNSUPPORTED declines this move: the pixels stay and the runtime repaints destination. Any other error leaves destination undefined; the runtime repaints the whole target next frame."),
  callback("PocketDisplayHostDamageFn", "pocket_display_host_damage_fn", [context, f("out", "*mut PocketRect"), f("capacity", "usize"), f("count", "*mut usize")], "i32", "Optional. Called once per frame after frame_identity and the frame's move, before its first acquire: up to capacity physical rectangles the display needs repainted besides the frame's own damage, such as a host overlay whose face changed or whose pixels a move carried along. The runtime repaints them this frame."),
  callback("PocketRendererDescriptorFn", "pocket_renderer_descriptor_fn", [context, f("out", "*mut PocketRendererDescriptor")]),
  callback("PocketRenderFn", "pocket_render_fn", [context, f("frame", "*const PocketFrameInput"), f("submission", "*mut u64")], "i32", "Frame borrows end on return. On error all submitted render work is stopped."),
  callback("PocketRenderWaitFn", "pocket_render_wait_fn", [context, f("submission", "u64")], "i32", "Both success and error guarantee the renderer no longer accesses frame memory."),
  callback("PocketRenderRetireFn", "pocket_render_retire_fn", [context, f("submission", "u64")], "void", "Consumes submission after render wait and display wait; releases driver-owned frame resources."),
  callback("PocketRenderZeroCopyFn", "pocket_render_zero_copy_fn", [context, f("frame", "*const PocketFrameInput"), f("submission", "*mut u64")], "i32", "UNSAFE: keep every borrowed frame resource alive and unchanged until render wait returns. A null callback cannot be used for zero-copy work."),
  callback("PocketInputAppendFn", "pocket_input_append_fn", [context, f("frame", "*const PocketInputFrame")]),
  callback("PocketInputClassesFn", "pocket_input_classes_fn", [context], "u32"),
  callback("PocketInputPollFn", "pocket_input_poll_fn", [context, f("builder", "*mut PocketInputFrameBuilder")]),
  callback("PocketPackageLengthFn", "pocket_package_length_fn", [context, f("out", "*mut usize")]),
  callback("PocketPackageAllFn", "pocket_package_all_fn", [context, f("bytes", "*mut *const u8"), f("length", "*mut usize")]),
  callback("PocketPackageRangeFn", "pocket_package_range_fn", [context, f("offset", "usize"), f("buffer", "*mut u8"), f("capacity", "usize"), f("read", "*mut usize")]),
  callback("PocketPackageTakeFn", "pocket_package_take_fn", [context, f("out", "*mut PocketPackageStorage")], "i32", "Transfers the whole package: out describes storage of the length the length callback reported. After success the source may refuse all and range. UNSUPPORTED keeps the copying path."),
  callback("PocketPackageReleaseFn", "pocket_package_release_fn", [context, f("bytes", "*const u8"), f("length", "usize")], "void", "Releases storage a take transferred, after the runtime's last read of it."),
  callback("PocketClockNowFn", "pocket_clock_now_fn", [context], "u64", "Monotonic microseconds."),
  callback("PocketClockSleepUntilFn", "pocket_clock_sleep_until_fn", [context, f("deadline", "u64")], "void"),
];
