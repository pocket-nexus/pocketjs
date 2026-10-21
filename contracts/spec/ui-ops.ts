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

export const UI_OPS = [
  {
    "name": "createNode",
    "args": [
      {
        "name": "type",
        "kind": "u32"
      }
    ],
    "result": "integer",
    "provider": "core",
    "core": "ui.create_node(a0 as u8)",
    "id": 1
  },
  {
    "name": "destroyNode",
    "args": [
      {
        "name": "id",
        "kind": "i32"
      }
    ],
    "result": "none",
    "provider": "core",
    "core": "ui.destroy_node(a0)",
    "id": 2
  },
  {
    "name": "insertBefore",
    "args": [
      {
        "name": "parent",
        "kind": "i32"
      },
      {
        "name": "child",
        "kind": "i32"
      },
      {
        "name": "anchorOr0",
        "kind": "i32"
      }
    ],
    "result": "none",
    "provider": "core",
    "core": "ui.insert_before(a0, a1, a2)",
    "id": 3
  },
  {
    "name": "removeChild",
    "args": [
      {
        "name": "parent",
        "kind": "i32"
      },
      {
        "name": "child",
        "kind": "i32"
      }
    ],
    "result": "none",
    "provider": "core",
    "core": "ui.remove_child(a0, a1)",
    "id": 4
  },
  {
    "name": "setStyle",
    "args": [
      {
        "name": "id",
        "kind": "i32"
      },
      {
        "name": "styleId",
        "kind": "i32"
      }
    ],
    "result": "none",
    "provider": "core",
    "core": "ui.set_style(a0, a1)",
    "id": 5
  },
  {
    "name": "setProp",
    "args": [
      {
        "name": "id",
        "kind": "i32"
      },
      {
        "name": "propId",
        "kind": "u32"
      },
      {
        "name": "value",
        "kind": "real"
      }
    ],
    "result": "none",
    "provider": "core",
    "core": "ui.set_prop(a0, a1 as u8, a2)",
    "id": 6
  },
  {
    "name": "setText",
    "args": [
      {
        "name": "id",
        "kind": "i32"
      },
      {
        "name": "str",
        "kind": "string"
      }
    ],
    "result": "none",
    "provider": "core",
    "core": "ui.set_text(a0, a1)",
    "id": 7
  },
  {
    "name": "replaceText",
    "args": [
      {
        "name": "id",
        "kind": "i32"
      },
      {
        "name": "str",
        "kind": "string"
      }
    ],
    "result": "none",
    "provider": "core",
    "core": "ui.replace_text(a0, a1)",
    "id": 8
  },
  {
    "name": "uploadTexture",
    "args": [
      {
        "name": "buf",
        "kind": "bytes"
      },
      {
        "name": "w",
        "kind": "u32"
      },
      {
        "name": "h",
        "kind": "u32"
      },
      {
        "name": "psm",
        "kind": "u32"
      }
    ],
    "result": "integer",
    "provider": "core",
    "core": "ui.upload_texture(a0, a1, a2, a3)",
    "id": 9
  },
  {
    "name": "setImage",
    "args": [
      {
        "name": "id",
        "kind": "i32"
      },
      {
        "name": "texHandle",
        "kind": "i32"
      }
    ],
    "result": "none",
    "provider": "core",
    "core": "ui.set_image(a0, a1)",
    "id": 10
  },
  {
    "name": "animate",
    "args": [
      {
        "name": "id",
        "kind": "i32"
      },
      {
        "name": "propId",
        "kind": "u32"
      },
      {
        "name": "to",
        "kind": "real"
      },
      {
        "name": "durMs",
        "kind": "nonnegative"
      },
      {
        "name": "easing",
        "kind": "u32"
      },
      {
        "name": "delayMs",
        "kind": "nonnegative"
      }
    ],
    "result": "integer",
    "provider": "core",
    "core": "ui.animate(a0, a1 as u8, a2, a3, a4 as u8, a5)",
    "id": 11
  },
  {
    "name": "cancelAnim",
    "args": [
      {
        "name": "animId",
        "kind": "i32"
      }
    ],
    "result": "none",
    "provider": "core",
    "core": "ui.cancel_anim(a0)",
    "id": 12
  },
  {
    "name": "setFocus",
    "args": [
      {
        "name": "idOr0",
        "kind": "i32"
      }
    ],
    "result": "none",
    "provider": "core",
    "core": "ui.set_focus(a0)",
    "id": 13
  },
  {
    "name": "loadStyles",
    "args": [
      {
        "name": "buf",
        "kind": "bytes"
      }
    ],
    "result": "boolean",
    "provider": "core",
    "core": "ui.load_styles(a0)",
    "id": 14
  },
  {
    "name": "loadFontAtlas",
    "args": [
      {
        "name": "buf",
        "kind": "bytes"
      }
    ],
    "result": "boolean",
    "provider": "core",
    "core": "ui.load_font_atlas(a0)",
    "id": 15
  },
  {
    "name": "measureText",
    "args": [
      {
        "name": "str",
        "kind": "string"
      },
      {
        "name": "fontSlot",
        "kind": "u32"
      }
    ],
    "result": "real",
    "provider": "core",
    "core": "f64::from(ui.measure_text(a0, a1 as u8))",
    "id": 16
  },
  {
    "name": "setSprite",
    "args": [
      {
        "name": "id",
        "kind": "i32"
      },
      {
        "name": "atlas",
        "kind": "i32"
      },
      {
        "name": "frames",
        "kind": "nonnegative"
      },
      {
        "name": "cols",
        "kind": "nonnegative"
      },
      {
        "name": "step",
        "kind": "nonnegative"
      }
    ],
    "result": "none",
    "provider": "core",
    "core": "ui.set_sprite(a0, a1, a2, a3, a4)",
    "id": 17
  },
  {
    "name": "debugInspect",
    "args": [
      {
        "name": "id",
        "kind": "i32"
      }
    ],
    "result": "none",
    "provider": "core",
    "core": "ui.debug_inspect(a0)",
    "id": 18
  },
  {
    "name": "debugRectXY",
    "args": [],
    "result": "integer",
    "provider": "core",
    "core": "ui.debug_rect_xy()",
    "id": 19
  },
  {
    "name": "debugRectWH",
    "args": [],
    "result": "integer",
    "provider": "core",
    "core": "ui.debug_rect_wh()",
    "id": 20
  },
  {
    "name": "debugPause",
    "args": [
      {
        "name": "on",
        "kind": "boolean"
      }
    ],
    "result": "none",
    "provider": "core",
    "core": "ui.debug_pause(a0)",
    "id": 21
  },
  {
    "name": "debugStep",
    "args": [],
    "result": "none",
    "provider": "core",
    "core": "ui.debug_step()",
    "id": 22
  },
  {
    "name": "loadTileTexture",
    "args": [
      {
        "name": "key",
        "kind": "string"
      },
      {
        "name": "index",
        "kind": "i32"
      }
    ],
    "result": "integer",
    "provider": "package",
    "id": 23
  },
  {
    "name": "freeTexture",
    "args": [
      {
        "name": "handle",
        "kind": "i32"
      }
    ],
    "result": "none",
    "provider": "core",
    "core": "ui.free_texture(a0)",
    "id": 24
  },
  {
    "name": "uploadImgEntry",
    "args": [
      {
        "name": "blob",
        "kind": "bytes"
      }
    ],
    "result": "integer",
    "provider": "core",
    "core": "ui.upload_img_entry(a0)",
    "id": 25
  },
  {
    "name": "setActive",
    "args": [
      {
        "name": "id",
        "kind": "i32"
      },
      {
        "name": "active",
        "kind": "boolean"
      }
    ],
    "result": "none",
    "provider": "core",
    "core": "ui.set_active(a0, a1)",
    "id": 26
  },
  {
    "name": "hitTest",
    "args": [
      {
        "name": "x",
        "kind": "real"
      },
      {
        "name": "y",
        "kind": "real"
      }
    ],
    "result": "integer",
    "provider": "core",
    "core": "ui.hit_test(a0 as f32, a1 as f32)",
    "id": 27
  },
  {
    "name": "setCursor",
    "args": [
      {
        "name": "tex",
        "kind": "i32"
      },
      {
        "name": "hotX",
        "kind": "real"
      },
      {
        "name": "hotY",
        "kind": "real"
      },
      {
        "name": "w",
        "kind": "real"
      },
      {
        "name": "h",
        "kind": "real"
      }
    ],
    "result": "none",
    "provider": "core",
    "core": "ui.set_cursor(a0, a1 as f32, a2 as f32, a3 as f32, a4 as f32)",
    "id": 28
  },
  {
    "name": "setCursorPos",
    "args": [
      {
        "name": "x",
        "kind": "real"
      },
      {
        "name": "y",
        "kind": "real"
      }
    ],
    "result": "none",
    "provider": "core",
    "core": "ui.set_cursor_pos(a0 as f32, a1 as f32)",
    "id": 29
  },
  {
    "name": "svcOpen",
    "args": [
      {
        "name": "app",
        "kind": "string"
      }
    ],
    "result": "boolean",
    "provider": "service",
    "id": 30
  },
  {
    "name": "svcPoll",
    "args": [],
    "result": "optionalString",
    "provider": "service",
    "id": 31
  },
  {
    "name": "svcSend",
    "args": [
      {
        "name": "line",
        "kind": "string"
      }
    ],
    "result": "none",
    "provider": "service",
    "id": 32
  },
  {
    "name": "loadImgFile",
    "args": [
      {
        "name": "path",
        "kind": "string"
      }
    ],
    "result": "integer",
    "provider": "filesystem",
    "id": 33
  },
  {
    "name": "videoOpen",
    "args": [
      {
        "name": "path",
        "kind": "string"
      }
    ],
    "result": "boolean",
    "provider": "video",
    "id": 34
  },
  {
    "name": "videoTick",
    "args": [],
    "result": "integer",
    "provider": "video",
    "id": 35
  },
  {
    "name": "videoTexture",
    "args": [],
    "result": "integer",
    "provider": "video",
    "id": 36
  },
  {
    "name": "videoClose",
    "args": [],
    "result": "none",
    "provider": "video",
    "id": 37
  },
  {
    "name": "debugStats",
    "args": [],
    "result": "string",
    "provider": "diagnostics",
    "id": 38
  },
  {
    "name": "appTable",
    "args": [],
    "result": "string",
    "provider": "applications",
    "id": 39
  },
  {
    "name": "appLaunch",
    "args": [
      {
        "name": "output",
        "kind": "string"
      }
    ],
    "result": "integer",
    "provider": "applications",
    "id": 40
  },
  {
    "name": "appShot",
    "args": [],
    "result": "integer",
    "provider": "applications",
    "id": 41
  },
  {
    "name": "hitTestBounds",
    "args": [
      {
        "name": "x",
        "kind": "real"
      },
      {
        "name": "y",
        "kind": "real"
      }
    ],
    "result": "integer",
    "provider": "core",
    "core": "ui.hit_test_bounds(a0 as f32, a1 as f32)",
    "id": 42
  },
  {
    "name": "wrapText",
    "args": [
      {
        "name": "str",
        "kind": "string"
      },
      {
        "name": "fontSlot",
        "kind": "u32"
      },
      {
        "name": "maxW",
        "kind": "real"
      }
    ],
    "result": "u32Array",
    "provider": "core",
    "core": "ui.wrap_text(a0, a1 as u8, a2 as f32)",
    "id": 43
  },
  {
    "name": "setCompositorSurface",
    "args": [
      {
        "name": "id",
        "kind": "i32"
      },
      {
        "name": "handle",
        "kind": "i32"
      },
      {
        "name": "focused",
        "kind": "boolean"
      }
    ],
    "result": "none",
    "provider": "core",
    "core": "ui.set_compositor_surface(a0, a1, a2)",
    "capability": "compositor",
    "id": 44
  },
  {
    "name": "hitTestAuxiliary",
    "args": [
      {
        "name": "x",
        "kind": "real"
      },
      {
        "name": "y",
        "kind": "real"
      }
    ],
    "result": "integer",
    "provider": "core",
    "core": "ui.hit_test_auxiliary(a0 as f32, a1 as f32)",
    "capability": "auxiliary",
    "id": 45
  },
  {
    "name": "hitTestBoundsAuxiliary",
    "args": [
      {
        "name": "x",
        "kind": "real"
      },
      {
        "name": "y",
        "kind": "real"
      }
    ],
    "result": "integer",
    "provider": "core",
    "core": "ui.hit_test_bounds_auxiliary(a0 as f32, a1 as f32)",
    "capability": "auxiliary",
    "id": 46
  },
  {
    "name": "fontStreamConfigure",
    "args": [
      {
        "name": "descriptor",
        "kind": "bytes"
      }
    ],
    "result": "boolean",
    "provider": "core",
    "core": "ui.font_stream_configure(a0)",
    "id": 47
  },
  {
    "name": "fontStreamRequests",
    "args": [],
    "result": "string",
    "provider": "core",
    "core": "ui.font_stream_requests()",
    "id": 48
  },
  {
    "name": "fontStreamCommit",
    "args": [
      {
        "name": "glyphs",
        "kind": "bytes"
      }
    ],
    "result": "integer",
    "provider": "core",
    "core": "ui.font_stream_commit(a0)",
    "id": 49
  },
  {
    "name": "fontStreamStats",
    "args": [],
    "result": "string",
    "provider": "core",
    "core": "ui.font_stream_stats()",
    "id": 50
  },
  {
    "name": "appClose",
    "args": [
      {
        "name": "output",
        "kind": "string"
      }
    ],
    "result": "integer",
    "provider": "applications",
    "id": 51
  },
  {
    "name": "physicsCreate",
    "args": [
      {
        "name": "kind",
        "kind": "u32"
      },
      {
        "name": "params",
        "kind": "bytes"
      }
    ],
    "result": "integer",
    "provider": "core",
    "core": "ui.physics_create_wire(a0, a1)",
    "capability": "physics",
    "id": 52
  },
  {
    "name": "physicsApply",
    "args": [
      {
        "name": "records",
        "kind": "bytes"
      }
    ],
    "result": "none",
    "provider": "core",
    "core": "ui.physics_apply_wire(a0)",
    "capability": "physics",
    "id": 53
  },
  {
    "name": "physicsDestroy",
    "args": [
      {
        "name": "handle",
        "kind": "i32"
      }
    ],
    "result": "none",
    "provider": "core",
    "core": "ui.physics_destroy(a0)",
    "capability": "physics",
    "id": 54
  },
  {
    "name": "physicsEvents",
    "args": [],
    "result": "optionalBytes",
    "provider": "core",
    "core": "physics_events(ui)",
    "capability": "physics",
    "id": 55
  },
  {
    "name": "physicsQuery",
    "args": [
      {
        "name": "query",
        "kind": "u32"
      },
      {
        "name": "handle",
        "kind": "i32"
      },
      {
        "name": "a",
        "kind": "real",
        "optional": true
      },
      {
        "name": "b",
        "kind": "real",
        "optional": true
      },
      {
        "name": "c",
        "kind": "real",
        "optional": true
      },
      {
        "name": "d",
        "kind": "real",
        "optional": true
      }
    ],
    "result": "real",
    "provider": "core",
    "core": "ui.physics_query(a0, a1, a2, a3, a4, a5)",
    "capability": "physics",
    "id": 56
  },
  {
    "name": "setPropBatch",
    "args": [
      {
        "name": "records",
        "kind": "bytes"
      }
    ],
    "result": "none",
    "provider": "core",
    "core": "set_prop_batch(ui, a0)",
    "id": 57
  },
  {
    "name": "takeAnimationCompletions",
    "args": [],
    "result": "string",
    "provider": "core",
    "core": "animation_completions(ui)",
    "id": 58
  },
  {
    "name": "fontStreamBatch",
    "args": [
      {
        "name": "descriptor",
        "kind": "bytes"
      }
    ],
    "result": "integer",
    "provider": "core",
    "core": "ui.font_stream_batch(a0)",
    "id": 59
  },
  {
    "name": "captureTexts",
    "args": [
      {
        "name": "surface",
        "kind": "u32"
      },
      {
        "name": "root",
        "kind": "i32"
      }
    ],
    "result": "boolean",
    "provider": "core",
    "core": "ui.capture_texts(a0, a1)",
    "id": 60
  },
  {
    "name": "capturedTexts",
    "args": [
      {
        "name": "surface",
        "kind": "u32"
      }
    ],
    "result": "string",
    "provider": "core",
    "core": "ui.captured_texts(a0)",
    "id": 61
  },
  {
    "name": "__dbgActive",
    "args": [],
    "result": "boolean",
    "provider": "private",
    "id": null
  },
  {
    "name": "__dbgConnected",
    "args": [],
    "result": "boolean",
    "provider": "private",
    "id": null
  },
  {
    "name": "__dbgPoll",
    "args": [],
    "result": "optionalString",
    "provider": "private",
    "id": null
  },
  {
    "name": "__dbgSend",
    "args": [
      {
        "name": "line",
        "kind": "string"
      }
    ],
    "result": "none",
    "provider": "private",
    "id": null
  },
  {
    "name": "__dbgShot",
    "args": [],
    "result": "boolean",
    "provider": "private",
    "id": null
  },
  {
    "name": "__reportAppAction",
    "args": [
      {
        "name": "name",
        "kind": "string"
      },
      {
        "name": "value",
        "kind": "i32"
      }
    ],
    "result": "none",
    "provider": "private",
    "id": null
  }
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
