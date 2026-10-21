// Candidate runtime C ABI. These declarations do not expose an implementation;
// runtime integration and old/new header link fixtures follow in later stages.
import { PROFILE_HASH_BYTES } from "./profile.ts";
import { callback, field as f, record, type AbiCallback, type AbiFunction, type AbiRecord } from "./driver-abi.ts";

export const RUNTIME_ABI_RULES = [
  "Runtime and driver records share the struct_size prefix compatibility rules in pocket_drivers.h.",
  "Rust API SemVer, C struct_size prefixes, closed DrawList versions, and the script binding generation hostAbi are distinct compatibility relations. hostAbi does not version C records or select a target.",
  "Create copies configuration and profile bytes. All other borrowed runtime results expire at the next call on the same instance, including failed calls. The runtime owns these bytes; callers must not free them.",
  "Registration precedes boot. A renderer id binds each display to one renderer; POCKET_RENDERER_SOFTWARE selects the built-in software rasterizer. Multiple displays may share a renderer instance.",
  "Each tick samples inputs, invokes the guest frame once, computes layout, renders and presents. The platform owns threads and tick scheduling. Calls on one instance must not overlap; guest bindings may call runtime_op during evaluate/frame callbacks.",
  "The guest receives the existing eight frame arguments through pocket_guest_frame. Introducing this ABI does not change their wire representation, tapes, packages, or binding generation.",
  "Destroy drains rendering and display transfers before shutting down the guest and releasing package or frame resources.",
  "An application links exactly one PocketJS Rust archive. The six pocket_host_* functions are supplied by the program and are the archive's complete host-hook contract.",
] as const;

export const RUNTIME_ABI_CONSTANTS: Readonly<Record<string, number>> = {
  POCKET_RENDERER_SOFTWARE: 0,
  POCKET_RENDERER_INVALID: 0xffffffff,
  POCKET_RESULT_NONE: 0, POCKET_RESULT_I64: 1, POCKET_RESULT_F64: 2, POCKET_RESULT_BYTES: 3,
};

export const RUNTIME_ABI_STRUCTS: readonly AbiRecord[] = [
  record("PocketRuntimeConfig", "pocket_runtime_config", [
    f("profile_hash", `[u8; ${PROFILE_HASH_BYTES}]`), f("host_abi", "u32"), f("tick_hz", "u32"),
    f("heap_limit", "usize"), f("frame_buffer_budget", "usize"),
    f("profile_json", "*const u8"), f("profile_json_length", "usize"),
  ], "profile_json is the canonical profile projection defined by profile.ts; profile_hash is its SHA-256. Limits are bytes; tick_hz must equal the projection's tickHz. No target or toolchain selection occurs here."),
  record("PocketResult", "pocket_result", [f("tag", "u32"), f("integer", "i64"), f("real", "f64"), f("bytes", "*const u8"), f("byte_length", "usize")], "tag selects none, integer, real, or bytes; inactive payloads are zero. Bytes are runtime-owned and borrowed until the next call on this instance."),
  record("PocketGuestFrame", "pocket_guest_frame", [
    f("buttons", "u32"), f("analog", "u32"), f("touches", "*const u32"), f("hits", "*const i32"),
    f("touch_surfaces", "*const u8"), f("touch_count", "usize"), f("right_analog", "u32"),
    f("axis_deltas", "*const PocketAxisDelta"), f("axis_delta_count", "usize"), f("motion", "*const PocketMotionState"),
  ], "Legacy frame argument packet encoded by the runtime, including hit facts. touches/hits/touch_surfaces have touch_count entries. Borrowed until the guest frame callback returns."),
  record("PocketGuestV1", "pocket_guest_v1", [f("evaluate", "Option<PocketGuestEvaluateFn>"), f("frame", "Option<PocketGuestFrameFn>"), f("collect", "Option<PocketGuestCollectFn>"), f("shutdown", "Option<PocketGuestShutdownFn>")], "Guest callbacks invoke generated bindings through pocket_runtime_op. No guest retains borrowed frame memory after frame returns."),
];

const context = f("context", "*mut c_void");
const runtime = f("runtime", "*mut PocketRuntime");
export const RUNTIME_ABI_CALLBACKS: readonly AbiCallback[] = [
  callback("PocketGuestEvaluateFn", "pocket_guest_evaluate_fn", [context, runtime, f("code", "*const u8"), f("length", "usize")]),
  callback("PocketGuestFrameFn", "pocket_guest_frame_fn", [context, f("frame", "*const PocketGuestFrame")]),
  callback("PocketGuestCollectFn", "pocket_guest_collect_fn", [context]),
  callback("PocketGuestShutdownFn", "pocket_guest_shutdown_fn", [context], "void"),
];

export const RUNTIME_ABI_FUNCTIONS: readonly AbiFunction[] = [
  { name: "pocket_runtime_create", args: [f("config", "*const PocketRuntimeConfig")], result: "*mut PocketRuntime" },
  { name: "pocket_runtime_set_package_source", args: [runtime, f("source", "*const PocketPackageSourceV1"), context], result: "i32" },
  { name: "pocket_runtime_set_guest", args: [runtime, f("guest", "*const PocketGuestV1"), context], result: "i32" },
  { name: "pocket_runtime_add_renderer", args: [runtime, f("renderer", "*const PocketRendererV1"), context], result: "PocketRendererId" },
  { name: "pocket_runtime_add_display", args: [runtime, f("display", "*const PocketDisplayOutputV1"), context, f("renderer", "PocketRendererId")], result: "i32" },
  { name: "pocket_runtime_add_input_source", args: [runtime, f("source", "*const PocketInputSourceV1"), context], result: "i32" },
  { name: "pocket_runtime_boot", args: [runtime], result: "i32" },
  { name: "pocket_runtime_tick", args: [runtime], result: "i32" },
  { name: "pocket_runtime_op", args: [runtime, f("op", "u16"), f("args", "*const c_void"), f("length", "usize"), f("out", "*mut PocketResult")], result: "i32", doc: "Generated bindings use this operation dispatcher. out bytes expire at the next call on runtime." },
  { name: "pocket_runtime_destroy", args: [runtime], result: "void" },
  { name: "pocket_raster_draw_op", args: [f("target", "*mut PocketSurface"), f("op", "*const PocketDrawOp"), f("resources", "*const PocketRenderResources")], result: "i32", doc: "Software fallback after accelerator completion and cache visibility, within target's acquired region." },
];

export const HOST_ABI_FUNCTIONS: readonly AbiFunction[] = [
  { name: "pocket_host_alloc", args: [f("size", "usize"), f("align", "usize")], result: "*mut c_void" },
  { name: "pocket_host_realloc", args: [f("pointer", "*mut c_void"), f("old_size", "usize"), f("align", "usize"), f("new_size", "usize")], result: "*mut c_void", doc: "On allocation failure return null and preserve the original allocation." },
  { name: "pocket_host_free", args: [f("pointer", "*mut c_void"), f("size", "usize"), f("align", "usize")], result: "void" },
  { name: "pocket_host_panic", args: [f("message", "*const c_char"), f("length", "usize")], result: "void", doc: "Fatal runtime failure; the program must not return from this hook." },
  { name: "pocket_host_log", args: [f("level", "i32"), f("message", "*const c_char"), f("length", "usize")], result: "void" },
  { name: "pocket_host_boot_stage", args: [f("stage", "i32")], result: "void" },
];
