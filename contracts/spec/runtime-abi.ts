// Runtime C ABI. Generated declarations and prefix-compatibility fixtures
// share this authority; implementation details do not enter the records.
import { PROFILE_HASH_BYTES } from "./profile.ts";
import { callback, field as f, record, type AbiCallback, type AbiFunction, type AbiRecord } from "./driver-abi.ts";

export const RUNTIME_ABI_RULES = [
  "Runtime and driver records share the struct_size prefix compatibility rules in pocket_drivers.h.",
  "Rust API SemVer, C struct_size prefixes, closed DrawList versions, and the script binding generation hostAbi are distinct compatibility relations. hostAbi does not version C records or select a target.",
  "Runtime configurations and guest environments require POCKET_BINDING_GENERATION. hostAbi is not a per-target identifier; unsupported generations are rejected before guest initialization.",
  "Create copies the configuration and the profile facts it points to; no JSON is read at runtime. All other borrowed runtime results expire at the next call on the same instance, including failed calls, except the read-only supports_op query. The runtime owns these bytes; callers must not free them.",
  "Registration precedes boot. A renderer id binds each display to one renderer; POCKET_RENDERER_SOFTWARE selects the built-in software rasterizer. Multiple displays may share a renderer instance.",
  "Operation providers implement declared non-core ui operations. Registration copies the operation list and vtable, rejects unknown/core/duplicate operations, and precedes boot. Context storage lasts through runtime destruction. Provider dispatch may not reenter the runtime; result bytes remain valid until its next dispatch, and the runtime copies them before returning to the guest.",
  "Each tick samples inputs, invokes the guest frame once, computes layout, renders and presents. A DEFERRED renderer's frame completes at the start of the next present, so its device work overlaps the next guest turn. The platform owns threads and tick scheduling. Calls on one instance must not overlap; guest bindings may call runtime_op during initialize/evaluate/frame/collect callbacks.",
  "The guest receives the eight frame arguments and the frame's text events through pocket_guest_frame. Their wire representation and tape format are independent of the binding generation and package format. A text event names an editing key as KeyboardEvent.key does (Enter, Backspace, Delete, Escape, Tab, ArrowLeft, Home), with a held modifier in front: Control+z, Alt+ArrowLeft.",
  "Destroy completes in-flight DEFERRED frames and drains rendering and display transfers before shutting down the guest and releasing package or frame resources.",
  "An application links exactly one PocketJS Rust archive. The six pocket_host_* functions are supplied by the program and are the archive's complete host-hook contract.",
] as const;

export const RUNTIME_ABI_CONSTANTS: Readonly<Record<string, number>> = {
  POCKET_RENDERER_SOFTWARE: 0,
  POCKET_RENDERER_INVALID: 0xffffffff,
  POCKET_ARG_INTEGER: 1, POCKET_ARG_REAL: 2, POCKET_ARG_BYTES: 3,
  POCKET_RESULT_NONE: 0, POCKET_RESULT_I64: 1, POCKET_RESULT_F64: 2, POCKET_RESULT_BYTES: 3,
};

export const RUNTIME_ABI_STRUCTS: readonly AbiRecord[] = [
  record("PocketGlyphPage", "pocket_glyph_page", [f("page", "u32"), f("first", "u32"), f("count", "u32"), f("width", "u32"), f("height", "u32"), f("uv", "[f32; 4]")], "Guarded A8 page layout and requested glyph UVs; rows include the transparent one-texel guard. The caller owns output storage."),
  record("PocketTickTiming", "pocket_tick_timing", [f("index", "u64"), f("deadline", "u64"), f("skipped", "u64")], "Monotonic microsecond deadline and wall-clock slot index. Skipped slots do not advance guest simulation."),
  record("PocketProfileDisplay", "pocket_profile_display", [
    f("physical", "[u32; 2]"), f("logical", "*const u32"), f("logical_count", "usize"), f("raster_density", "u32"),
  ], "One panel: its physical size and the logical viewports an application may declare for it, as logical_count width/height pairs."),
  record("PocketProfileRange", "pocket_profile_range", [f("min", "[u32; 2]"), f("max", "[u32; 2]")], "Logical viewport bounds of a window or widget form."),
  record("PocketProfileFacts", "pocket_profile_facts", [
    f("id", "*const u8"), f("id_length", "usize"), f("tick_hz", "u32"), f("input_classes", "u32"),
    f("display", "*const PocketProfileDisplay"), f("auxiliary", "*const PocketProfileDisplay"), f("dynamic_viewport", "*const PocketProfileRange"),
    f("cadences", "*const u32"), f("cadence_count", "usize"),
    f("capabilities", "*const u8"), f("capabilities_length", "usize"),
    f("presentations", "*const u8"), f("presentations_length", "usize"),
    f("animation", "*const u8"), f("animation_length", "usize"),
  ], "The facts the runtime admits packages against, exported by pocket profile export from the program's profile document. id is the host's profile id; admission does not compare it. tick_hz is the highest cadence. cadences lists cadence_count presented frames per second; a record without them has the one cadence tick_hz. capabilities and presentations are names, each terminated by NUL, in capabilities_length and presentations_length bytes; a record without capabilities provides none, and one without presentations or animation is not compared on them. input_classes are the POCKET_INPUT_CLASS_* bits the profile's capabilities require. Null auxiliary and dynamic_viewport mean absent."),
  record("PocketRuntimeConfig", "pocket_runtime_config", [
    f("profile_hash", `[u8; ${PROFILE_HASH_BYTES}]`), f("host_abi", "u32"), f("tick_hz", "u32"),
    f("heap_limit", "usize"), f("frame_buffer_budget", "usize"),
    f("profile", "*const PocketProfileFacts"),
  ], "profile points at the exported facts; profile_hash is the SHA-256 identity of the same profile, computed by the exporter. Limits are bytes; tick_hz must equal the facts' tick_hz. No target or toolchain selection occurs here."),
  record("PocketOpArg", "pocket_op_arg", [f("tag", "u32"), f("integer", "i64"), f("real", "f64"), f("bytes", "*const u8"), f("byte_length", "usize")], "One borrowed operation argument; tag selects integer, real, or bytes. runtime_op length is the total byte length of these extensible records, including per-record padding."),
  record("PocketNamedTexture", "pocket_named_texture", [f("name", "*const u8"), f("name_length", "usize"), f("handle", "i32")]),
  record("PocketNamedSprite", "pocket_named_sprite", [f("name", "*const u8"), f("name_length", "usize"), f("handle", "i32"), f("frames", "u32"), f("columns", "u32"), f("step", "u32")]),
  record("PocketGuestEnvironment", "pocket_guest_environment", [f("host", "*const u8"), f("host_length", "usize"), f("host_abi", "u32"), f("tick_hz", "u32"), f("viewport_width", "u32"), f("viewport_height", "u32"), f("auxiliary_width", "u32"), f("auxiliary_height", "u32"), f("auxiliary_root", "i32"), f("raster_density", "u32"), f("heap_limit", "usize"), f("pak", "*const u8"), f("pak_length", "usize"), f("textures", "*const PocketNamedTexture"), f("texture_count", "usize"), f("sprites", "*const PocketNamedSprite"), f("sprite_count", "usize"), f("assets_present", "u32"), f("sim_hz", "u32")], "Metadata borrows last through initialize; pak storage remains unchanged through guest shutdown. Zero auxiliary dimensions mean no auxiliary viewport. tick_hz is the admitted package's rate; sim_hz is the host cadence, guest frames per second, published to the guest as globalThis.__simHz."),
  record("PocketRuntimeTiming", "pocket_runtime_timing", [f("tick_hz", "u32"), f("cadence_hz", "u32"), f("core_ticks", "u32")], "The booted package's rate, the host cadence it is presented at, and the core ticks each pocket_runtime_tick advances (tick_hz / cadence_hz)."),
  record("PocketResult", "pocket_result", [f("tag", "u32"), f("integer", "i64"), f("real", "f64"), f("bytes", "*const u8"), f("byte_length", "usize")], "tag selects none, integer, real, or bytes; inactive payloads are zero. Bytes are runtime-owned and borrowed until the next call on this instance."),
  record("PocketGuestFrame", "pocket_guest_frame", [
    f("buttons", "u32"), f("analog", "u32"), f("touches", "*const u32"), f("hits", "*const i32"),
    f("touch_surfaces", "*const u8"), f("touch_count", "usize"), f("right_analog", "u32"),
    f("axis_deltas", "*const PocketAxisDelta"), f("axis_delta_count", "usize"), f("motion", "*const PocketMotionState"),
    f("text", "*const PocketTextEvent"), f("text_count", "usize"),
  ], "Legacy frame argument packet encoded by the runtime, including hit facts. touches/hits/touch_surfaces have touch_count entries; text has text_count entries, the frame's text events in order. Borrowed until the guest frame callback returns."),
  record("PocketGuestV1", "pocket_guest_v1", [f("evaluate", "Option<PocketGuestEvaluateFn>"), f("frame", "Option<PocketGuestFrameFn>"), f("collect", "Option<PocketGuestCollectFn>"), f("shutdown", "Option<PocketGuestShutdownFn>"), f("initialize", "Option<PocketGuestInitializeFn>")], "Guest callbacks invoke generated bindings through pocket_runtime_op. No guest retains borrowed frame memory after frame returns."),
  record("PocketOpProviderV1", "pocket_op_provider_v1", [f("dispatch", "Option<PocketOpProviderDispatchFn>")], "Provides registered non-core operations. Arguments borrow through callback return; argument_length is the byte span of extensible pocket_op_arg records. Initialize out with its supplied struct_size and return a valid tagged result on success."),
];

const context = f("context", "*mut c_void");
const runtime = f("runtime", "*mut PocketRuntime");
export const RUNTIME_ABI_CALLBACKS: readonly AbiCallback[] = [
  callback("PocketOpProviderDispatchFn", "pocket_op_provider_dispatch_fn", [context, f("op", "u16"), f("arguments", "*const PocketOpArg"), f("argument_length", "usize"), f("out", "*mut PocketResult")]),
  callback("PocketDrawOpVisitFn", "pocket_draw_op_visit_fn", [context, f("operation", "*const PocketDrawOp")], "i32", "Synchronous visitor. Operation, clip and words borrow until callback return; do not retain them or mutate the DrawList. Return POCKET_STATUS_OK to continue or an error to stop."),
  callback("PocketGuestInitializeFn", "pocket_guest_initialize_fn", [context, runtime, f("environment", "*const PocketGuestEnvironment")]),
  callback("PocketGuestEvaluateFn", "pocket_guest_evaluate_fn", [context, runtime, f("code", "*const u8"), f("length", "usize")]),
  callback("PocketGuestFrameFn", "pocket_guest_frame_fn", [context, f("frame", "*const PocketGuestFrame")]),
  callback("PocketGuestCollectFn", "pocket_guest_collect_fn", [context]),
  callback("PocketGuestShutdownFn", "pocket_guest_shutdown_fn", [context], "void"),
];

export const RUNTIME_ABI_FUNCTIONS: readonly AbiFunction[] = [
  { name: "pocket_glyph_page_a8", args: [f("font", "*const PocketFontView"), f("glyph", "u32"), f("max_dimension", "u32"), f("pixels", "*mut u8"), f("capacity", "usize"), f("out", "*mut PocketGlyphPage")], result: "i32", doc: "Query or expand a bounded guarded A8 page through pocket-glyph-pages. max_dimension is a power of two in 8..4096. Null pixels with zero capacity queries metadata only; otherwise capacity must cover width*height. Errors leave pixels and out unchanged. Font, output bytes and metadata must not overlap." },
  { name: "pocket_tick_schedule_create", args: [f("tick_hz", "u32"), f("started", "u64"), f("max_lag_us", "u64")], result: "*mut PocketTickSchedule", doc: "Create a thread-owned monotonic deadline schedule. Invalid rate, zero lag limit, or overflow returns null. Platform code owns waits and cancellation." },
  { name: "pocket_tick_schedule_deadline", args: [f("schedule", "*const PocketTickSchedule"), f("out", "*mut u64")], result: "i32" },
  { name: "pocket_tick_schedule_poll", args: [f("schedule", "*mut PocketTickSchedule"), f("now", "u64"), f("out", "*mut PocketTickTiming"), f("ready", "*mut u32")], result: "i32", doc: "Reserve at most one due slot. Early polls set ready to zero without advancing; excessive lag skips expired wall-clock slots. Invalid output prefixes leave the schedule unchanged." },
  { name: "pocket_tick_schedule_destroy", args: [f("schedule", "*mut PocketTickSchedule")], result: "void" },
  { name: "pocket_runtime_create", args: [f("config", "*const PocketRuntimeConfig")], result: "*mut PocketRuntime" },
  { name: "pocket_runtime_set_package_source", args: [runtime, f("source", "*const PocketPackageSourceV1"), context], result: "i32" },
  { name: "pocket_runtime_set_guest", args: [runtime, f("guest", "*const PocketGuestV1"), context], result: "i32" },
  { name: "pocket_runtime_add_renderer", args: [runtime, f("renderer", "*const PocketRendererV1"), context], result: "PocketRendererId" },
  { name: "pocket_runtime_add_display", args: [runtime, f("display", "*const PocketDisplayOutputV1"), context, f("renderer", "PocketRendererId")], result: "i32" },
  { name: "pocket_runtime_add_input_source", args: [runtime, f("source", "*const PocketInputSourceV1"), context], result: "i32" },
  { name: "pocket_runtime_add_op_provider", args: [runtime, f("provider", "*const PocketOpProviderV1"), context, f("operations", "*const u16"), f("operation_count", "usize")], result: "i32" },
  { name: "pocket_runtime_boot", args: [runtime], result: "i32" },
  { name: "pocket_runtime_boot_deferred", args: [runtime], result: "i32", doc: "Admit and evaluate the package without presenting it. The program calls pocket_runtime_present before the first tick, after its native scene or host overlay is ready." },
  { name: "pocket_runtime_present", args: [runtime], result: "i32", doc: "Present the retained tree without running the guest: after boot_deferred, to retry a failed output, or to redraw it under a host overlay. A guest that failed keeps its last tree presentable; advancing it stays rejected." },
  { name: "pocket_runtime_complete_presentation", args: [runtime], result: "i32", doc: "Complete in-flight DEFERRED frames: renderer wait, flush or display wait, retire. Returns zero when none is pending. A failed completion returns its error once and invalidates that display's damage history. Call before reading a presented buffer or releasing state a pending submission reads." },
  { name: "pocket_runtime_tick", args: [runtime], result: "i32", doc: "Sample inputs, run the guest frame once, advance the core by the booted package's core_ticks, and present." },
  { name: "pocket_runtime_get_timing", args: [f("runtime", "*const PocketRuntime"), f("out", "*mut PocketRuntimeTiming")], result: "i32", doc: "After boot, the package rate and the cadence the program schedules pocket_runtime_tick at. INVALID before boot." },
  { name: "pocket_runtime_supports_op", args: [f("runtime", "*const PocketRuntime"), f("op", "u16")], result: "u32", doc: "Returns 0 or 1 without executing the operation. Does not invalidate borrowed results." },
  { name: "pocket_runtime_op", args: [runtime, f("op", "u16"), f("args", "*const c_void"), f("length", "usize"), f("out", "*mut PocketResult")], result: "i32", doc: "Generated bindings use this operation dispatcher. out bytes expire at the next call on runtime." },
  { name: "pocket_runtime_update_texture", args: [runtime, f("handle", "i32"), f("x", "u32"), f("y", "u32"), f("width", "u32"), f("height", "u32"), f("pixels", "*const u8"), f("length", "usize")], result: "i32", doc: "Overwrite the rectangle of a live 16- or 32-bit texture in place with width*height texels in its format, rows packed: the handle and the nodes drawing it stay, and the next frame repaints only the quads that sample it. Not during a guest callback; INVALID for a stale handle, an indexed texture, a rectangle outside the texture or another byte count." },
  { name: "pocket_runtime_destroy", args: [runtime], result: "void" },
  { name: "pocket_raster_draw_op", args: [f("target", "*mut PocketSurface"), f("op", "*const PocketDrawOp"), f("resources", "*const PocketRenderResources")], result: "i32", doc: "Software fallback after accelerator completion and cache visibility, within target's acquired region." },
  { name: "pocket_draw_list_visit", args: [f("list", "*const PocketDrawList"), f("resources", "*const PocketRenderResources"), f("scale", "u32"), f("visitor", "Option<PocketDrawOpVisitFn>"), context], result: "i32", doc: "Validate the complete matching-version DrawList before any callback, then visit every operation in order with inherited logical clip and positive output scale. Callback errors stop iteration and are returned unchanged. No allocation or resource lookup occurs." },
];

export const HOST_ABI_FUNCTIONS: readonly AbiFunction[] = [
  { name: "pocket_host_alloc", args: [f("size", "usize"), f("align", "usize")], result: "*mut c_void" },
  { name: "pocket_host_realloc", args: [f("pointer", "*mut c_void"), f("old_size", "usize"), f("align", "usize"), f("new_size", "usize")], result: "*mut c_void", doc: "On allocation failure return null and preserve the original allocation." },
  { name: "pocket_host_free", args: [f("pointer", "*mut c_void"), f("size", "usize"), f("align", "usize")], result: "void" },
  { name: "pocket_host_panic", args: [f("message", "*const c_char"), f("length", "usize")], result: "void", doc: "Fatal runtime failure; the program must not return from this hook." },
  { name: "pocket_host_log", args: [f("level", "i32"), f("message", "*const c_char"), f("length", "usize")], result: "void" },
  { name: "pocket_host_boot_stage", args: [f("stage", "i32")], result: "void" },
];
