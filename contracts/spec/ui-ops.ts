// Canonical UI call signatures. Numeric IDs are append-only; lifecycle,
// viewport, tick, render and allocator entry points belong to the host ABI.
// Private hooks have no portable OP number and require an explicit provider.
import { OP } from "./spec.ts";

export type UiArgKind = "i32" | "u32" | "real" | "nonnegative" | "boolean" | "string" | "bytes";
export type UiResultKind = "none" | "integer" | "real" | "boolean" | "string" | "optionalString" | "u32Array" | "bytes" | "optionalBytes";
export interface UiOperation {
  readonly id: number | null;
  readonly name: string;
  readonly args: readonly { readonly name: string; readonly kind: UiArgKind; readonly optional?: boolean }[];
  readonly result: UiResultKind;
  readonly provider: "core" | "package" | "service" | "filesystem" | "video" | "diagnostics" | "applications" | "private";
  readonly capability?: "compositor" | "auxiliary" | "physics";
  /** Typed core expression; a0... are decoded and validated before mutation. */
  readonly core?: string;
}

function arg<const Name extends string, const Kind extends UiArgKind>(
  name: Name, kind: Kind,
): { readonly name: Name; readonly kind: Kind };
function arg<const Name extends string, const Kind extends UiArgKind>(
  name: Name, kind: Kind, optional: true,
): { readonly name: Name; readonly kind: Kind; readonly optional: true };
function arg(name: string, kind: UiArgKind, optional?: true) {
  return optional ? { name, kind, optional } : { name, kind };
}

function core<
  const Name extends keyof typeof OP,
  const Args extends UiOperation["args"],
  const Result extends UiResultKind,
  const Expression extends string,
>(name: Name, args: Args, result: Result, expression: Expression): {
  readonly name: Name;
  readonly args: Args;
  readonly result: Result;
  readonly provider: "core";
  readonly core: Expression;
  readonly id: (typeof OP)[Name];
};
function core<
  const Name extends keyof typeof OP,
  const Args extends UiOperation["args"],
  const Result extends UiResultKind,
  const Expression extends string,
  const Capability extends NonNullable<UiOperation["capability"]>,
>(name: Name, args: Args, result: Result, expression: Expression, options: { readonly capability: Capability }): {
  readonly name: Name;
  readonly args: Args;
  readonly result: Result;
  readonly provider: "core";
  readonly core: Expression;
  readonly capability: Capability;
  readonly id: (typeof OP)[Name];
};
function core(
  name: keyof typeof OP, args: UiOperation["args"], result: UiResultKind,
  expression: string, options: Pick<UiOperation, "capability"> = {},
) {
  return { name, args, result, provider: "core", core: expression, ...options, id: OP[name] } as const;
}

function provider<
  const Name extends keyof typeof OP,
  const Args extends UiOperation["args"],
  const Result extends UiResultKind,
  const Provider extends Exclude<UiOperation["provider"], "core" | "private">,
>(name: Name, args: Args, result: Result, provider: Provider) {
  return { name, args, result, provider, id: OP[name] } as const;
}

function privateHook<
  const Name extends string,
  const Args extends UiOperation["args"],
  const Result extends UiResultKind,
>(name: Name, args: Args, result: Result) {
  return { name, args, result, provider: "private", id: null } as const;
}

export const UI_OPS = [
  core("createNode", [arg("type", "u32")], "integer", "ui.create_node(a0 as u8)"),
  core("destroyNode", [arg("id", "i32")], "none", "ui.destroy_node(a0)"),
  core("insertBefore",
    [arg("parent", "i32"), arg("child", "i32"), arg("anchorOr0", "i32")],
    "none", "ui.insert_before(a0, a1, a2)"),
  core("removeChild", [arg("parent", "i32"), arg("child", "i32")], "none", "ui.remove_child(a0, a1)"),
  core("setStyle", [arg("id", "i32"), arg("styleId", "i32")], "none", "ui.set_style(a0, a1)"),
  core("setProp",
    [arg("id", "i32"), arg("propId", "u32"), arg("value", "real")],
    "none", "ui.set_prop(a0, a1 as u8, a2)"),
  core("setText", [arg("id", "i32"), arg("str", "string")], "none", "ui.set_text(a0, a1)"),
  core("replaceText", [arg("id", "i32"), arg("str", "string")], "none", "ui.replace_text(a0, a1)"),
  core("uploadTexture",
    [arg("buf", "bytes"), arg("w", "u32"), arg("h", "u32"), arg("psm", "u32")],
    "integer", "ui.upload_texture(a0, a1, a2, a3)"),
  core("setImage", [arg("id", "i32"), arg("texHandle", "i32")], "none", "ui.set_image(a0, a1)"),
  core("animate",
    [arg("id", "i32"), arg("propId", "u32"), arg("to", "real"), arg("durMs", "nonnegative"), arg("easing", "u32"), arg("delayMs", "nonnegative")],
    "integer", "ui.animate(a0, a1 as u8, a2, a3, a4 as u8, a5)"),
  core("cancelAnim", [arg("animId", "i32")], "none", "ui.cancel_anim(a0)"),
  core("setFocus", [arg("idOr0", "i32")], "none", "ui.set_focus(a0)"),
  core("loadStyles", [arg("buf", "bytes")], "boolean", "ui.load_styles(a0)"),
  core("loadFontAtlas", [arg("buf", "bytes")], "boolean", "ui.load_font_atlas(a0)"),
  core("measureText",
    [arg("str", "string"), arg("fontSlot", "u32")],
    "real", "f64::from(ui.measure_text(a0, a1 as u8))"),
  core("setSprite",
    [arg("id", "i32"), arg("atlas", "i32"), arg("frames", "nonnegative"), arg("cols", "nonnegative"), arg("step", "nonnegative")],
    "none", "ui.set_sprite(a0, a1, a2, a3, a4)"),
  core("debugInspect", [arg("id", "i32")], "none", "ui.debug_inspect(a0)"),
  core("debugRectXY", [], "integer", "ui.debug_rect_xy()"),
  core("debugRectWH", [], "integer", "ui.debug_rect_wh()"),
  core("debugPause", [arg("on", "boolean")], "none", "ui.debug_pause(a0)"),
  core("debugStep", [], "none", "ui.debug_step()"),
  provider("loadTileTexture", [arg("key", "string"), arg("index", "i32")], "integer", "package"),
  core("freeTexture", [arg("handle", "i32")], "none", "ui.free_texture(a0)"),
  core("uploadImgEntry", [arg("blob", "bytes")], "integer", "ui.upload_img_entry(a0)"),
  core("setActive", [arg("id", "i32"), arg("active", "boolean")], "none", "ui.set_active(a0, a1)"),
  core("hitTest", [arg("x", "real"), arg("y", "real")], "integer", "ui.hit_test(a0 as f32, a1 as f32)"),
  core("setCursor",
    [arg("tex", "i32"), arg("hotX", "real"), arg("hotY", "real"), arg("w", "real"), arg("h", "real")],
    "none", "ui.set_cursor(a0, a1 as f32, a2 as f32, a3 as f32, a4 as f32)"),
  core("setCursorPos",
    [arg("x", "real"), arg("y", "real")],
    "none", "ui.set_cursor_pos(a0 as f32, a1 as f32)"),
  provider("svcOpen", [arg("app", "string")], "boolean", "service"),
  provider("svcPoll", [], "optionalString", "service"),
  provider("svcSend", [arg("line", "string")], "none", "service"),
  provider("loadImgFile", [arg("path", "string")], "integer", "filesystem"),
  provider("videoOpen", [arg("path", "string")], "boolean", "video"),
  provider("videoTick", [], "integer", "video"),
  provider("videoTexture", [], "integer", "video"),
  provider("videoClose", [], "none", "video"),
  provider("debugStats", [], "string", "diagnostics"),
  provider("appTable", [], "string", "applications"),
  provider("appLaunch", [arg("output", "string")], "integer", "applications"),
  provider("appShot", [], "integer", "applications"),
  core("hitTestBounds",
    [arg("x", "real"), arg("y", "real")],
    "integer", "ui.hit_test_bounds(a0 as f32, a1 as f32)"),
  core("wrapText",
    [arg("str", "string"), arg("fontSlot", "u32"), arg("maxW", "real")],
    "u32Array", "ui.wrap_text(a0, a1 as u8, a2 as f32)"),
  core("setCompositorSurface",
    [arg("id", "i32"), arg("handle", "i32"), arg("focused", "boolean")],
    "none", "ui.set_compositor_surface(a0, a1, a2)", { capability: "compositor" }),
  core("hitTestAuxiliary",
    [arg("x", "real"), arg("y", "real")],
    "integer", "ui.hit_test_auxiliary(a0 as f32, a1 as f32)", { capability: "auxiliary" }),
  core("hitTestBoundsAuxiliary",
    [arg("x", "real"), arg("y", "real")],
    "integer", "ui.hit_test_bounds_auxiliary(a0 as f32, a1 as f32)", { capability: "auxiliary" }),
  core("fontStreamConfigure", [arg("descriptor", "bytes")], "boolean", "ui.font_stream_configure(a0)"),
  core("fontStreamRequests", [], "string", "ui.font_stream_requests()"),
  core("fontStreamCommit", [arg("glyphs", "bytes")], "integer", "ui.font_stream_commit(a0)"),
  core("fontStreamStats", [], "string", "ui.font_stream_stats()"),
  provider("appClose", [arg("output", "string")], "integer", "applications"),
  core("physicsCreate",
    [arg("kind", "u32"), arg("params", "bytes")],
    "integer", "ui.physics_create_wire(a0, a1)", { capability: "physics" }),
  core("physicsApply",
    [arg("records", "bytes")],
    "none", "ui.physics_apply_wire(a0)", { capability: "physics" }),
  core("physicsDestroy", [arg("handle", "i32")], "none", "ui.physics_destroy(a0)", { capability: "physics" }),
  core("physicsEvents", [], "optionalBytes", "physics_events(ui)", { capability: "physics" }),
  core("physicsQuery",
    [arg("query", "u32"), arg("handle", "i32"), arg("a", "real", true), arg("b", "real", true), arg("c", "real", true), arg("d", "real", true)],
    "real", "ui.physics_query(a0, a1, a2, a3, a4, a5)", { capability: "physics" }),
  core("setPropBatch", [arg("records", "bytes")], "none", "set_prop_batch(ui, a0)"),
  core("takeAnimationCompletions", [], "string", "animation_completions(ui)"),
  core("fontStreamBatch", [arg("descriptor", "bytes")], "integer", "ui.font_stream_batch(a0)"),
  core("captureTexts", [arg("surface", "u32"), arg("root", "i32")], "boolean", "ui.capture_texts(a0, a1)"),
  core("capturedTexts", [arg("surface", "u32")], "string", "ui.captured_texts(a0)"),
  privateHook("__dbgActive", [], "boolean"),
  privateHook("__dbgConnected", [], "boolean"),
  privateHook("__dbgPoll", [], "optionalString"),
  privateHook("__dbgSend", [arg("line", "string")], "none"),
  privateHook("__dbgShot", [], "boolean"),
  privateHook("__reportAppAction", [arg("name", "string"), arg("value", "i32")], "none"),
] as const satisfies readonly UiOperation[];

export const UI_BINDING_PROFILES = {
  // New guests use explicit coercion: required scalars, JS ToInt32/ToUint32,
  // nonnegative duration clamping, lossy UTF-8 strings, and byte views.
  canonical: { missingNumbers: "error", nonnegative: "clamp", strings: "lossy", buffers: "arrayBufferOrView" },
  legacyC: { missingNumbers: "error", nonnegative: "clamp", strings: "emptyOnInvalidUtf8", buffers: "arrayBufferOrView" },
  idf: { missingNumbers: "zero", nonnegative: "uint32", strings: "strict", buffers: "uint8Array" },
} as const;

export const UI_LEGACY_C_OPS = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,24,25,26,27,28,29,42,57,58] as const;
export const UI_IDF_OPS = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,24,25,26,27,28,29,42,43] as const;

export function validateUiOps(): void {
  const names = new Set<string>(), ids = new Set<number>();
  for (const op of UI_OPS as readonly UiOperation[]) {
    if (names.has(op.name)) throw new Error(`duplicate UI method ${op.name}`);
    names.add(op.name);
    if (op.id !== null) {
      if (ids.has(op.id) || OP[op.name as keyof typeof OP] !== op.id) throw new Error(`UI opcode drift: ${op.name}`);
      ids.add(op.id);
    } else if (op.provider !== "private") throw new Error(`unnumbered public UI method ${op.name}`);
  }
  if (ids.size !== Object.keys(OP).length) throw new Error("UI schema does not cover OP");
}
