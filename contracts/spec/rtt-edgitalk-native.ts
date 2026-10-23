// Shared definition notes for the RT-Thread / Edgi-Talk (M55) native ABI.
//
// The M55 port **reuses** hosts/esp-idf C components and the same Rust crates
// (ui-core, render-rgb565, abi, runtime). Layouts must stay in lockstep with
// contracts/spec/idf-native.ts — do not fork struct field lists here.
//
// Consumers: tools/rt-thread-edgitalk-contracts.ts (honest stub / reuse).

import {
  IDF_NATIVE_CALLBACKS,
  IDF_NATIVE_STRUCTS,
} from "./idf-native.ts";

/** Host key matching hosts/rt-thread-edgitalk/native/toolchains.json */
export const RTT_EDGITALK_TARGET = "edgitalk-m55" as const;

/** Rust target triple for Cortex-M55 hard-float */
export const RTT_EDGITALK_RUST_TARGET = "thumbv8m.main-none-eabihf" as const;

/**
 * ABI surfaces that must remain identical to the ESP-IDF host.
 * GuestOps / HostOps package admission and ui/render C layouts are shared.
 */
export const RTT_EDGITALK_ABI_LOCKSTEP = [
  {
    name: "GuestOps / HostOps (package PHST admission)",
    idfSpec: "contracts/spec/idf-host.ts + pocket-package.ts",
    sharedHeaders: [
      "hosts/esp-idf/components/pocketjs_package/include/pocketjs/package.h",
      "hosts/esp-idf/components/pocketjs_package/include/pocketjs/package_format.h",
    ],
    note: "Edgi still borrows platform: esp-idf in pocket.host.json (issue #2).",
  },
  {
    name: "UI core native structs",
    idfSpec: "contracts/spec/idf-native.ts (component: core)",
    sharedHeaders: [
      "hosts/esp-idf/components/pocketjs_ui_core/include/pocketjs/ui_types.h",
      "hosts/esp-idf/components/pocketjs_ui_core/include/pocketjs/native_ui.h",
    ],
    note: "Generated/checked by tools/esp-idf-contracts.ts; M55 links same layouts.",
  },
  {
    name: "RGB565 renderer native structs",
    idfSpec: "contracts/spec/idf-native.ts (component: renderer)",
    sharedHeaders: [
      "hosts/esp-idf/components/pocketjs_render_rgb565/include/pocketjs/render_types.h",
      "hosts/esp-idf/components/pocketjs_render_rgb565/include/pocketjs/native_renderer.h",
    ],
    note: "prepare / render_strip / commit transaction identical to ESP software path.",
  },
  {
    name: "Rust abi crate",
    idfSpec: "hosts/esp-idf/native/abi (from idf-native.ts)",
    sharedHeaders: ["hosts/esp-idf/native/abi/src/lib.rs"],
    note: "thumbv8m is 32-bit; size/align asserts for pointer=4 must hold.",
  },
] as const;

/** Re-export IDF layouts so RTT tooling can import one module. */
export const RTT_EDGITALK_NATIVE_STRUCTS = IDF_NATIVE_STRUCTS;
export const RTT_EDGITALK_NATIVE_CALLBACKS = IDF_NATIVE_CALLBACKS;

/**
 * RTT-only surfaces that are **not** yet under automated contract check.
 * Listed so CI/docs stay honest (no fake green).
 */
export const RTT_EDGITALK_UNENFORCED = [
  {
    name: "ESP→RT shims (esp_err / heap_caps / log)",
    paths: [
      "hosts/rt-thread-edgitalk/native/include/esp_err.h",
      "hosts/rt-thread-edgitalk/native/include/esp_heap_caps.h",
      "hosts/rt-thread-edgitalk/native/include/esp_log.h",
      "hosts/rt-thread-edgitalk/native/pocketjs_rt_compat.c",
    ],
    todo: "Optional layout/API smoke vs IDF headers; not required for UI ABI lockstep.",
  },
  {
    name: "Board hooks (pocketjs_host_board.h)",
    paths: ["hosts/rt-thread-edgitalk/native/include/pocketjs/pocketjs_host_board.h"],
    todo: "Product-defined; no generated contract. Document only.",
  },
  {
    name: "Host platform id / CLI registration",
    paths: ["apps/edgitalk-m55-smoke/pocket.host.json"],
    todo: "platform still esp-idf — https://github.com/1024971823/pocketjs/issues/2",
  },
] as const;
