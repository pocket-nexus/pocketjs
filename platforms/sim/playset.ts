// `globalThis.playset` on the desktop: the pocket-playset kernels as a dylib
// behind bun:ffi, with the same functions as the 3DS binding
// (products/3ds/src/playset.c). Games run headlessly against it in tests and
// in tools/playset-sim.ts; nothing is drawn, but `prepare` still builds the
// frame record so draw counts and culling are measurable.
//
//   import { installPlaysetSim } from "../platforms/sim/playset.ts";
//   const sim = installPlaysetSim(); // builds the dylib on first use

import { dlopen, FFIType, ptr, toArrayBuffer, type Pointer } from "bun:ffi";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PlaysetNative } from "../../framework/src/playset/index.ts";

const ROOT = resolve(import.meta.dir, "../..");
const LIB = join(ROOT, "target/release", process.platform === "darwin" ? "libpocket_playset.dylib" : "libpocket_playset.so");

function newest(dir: string): number {
  let t = 0;
  for (const f of new Bun.Glob("**/*.rs").scanSync(dir)) t = Math.max(t, statSync(join(dir, f)).mtimeMs);
  return t;
}

function ensureLibrary(): void {
  const src = join(ROOT, "engine/crates/pocket-playset/src");
  if (existsSync(LIB) && statSync(LIB).mtimeMs >= newest(src)) return;
  const r = Bun.spawnSync(["cargo", "rustc", "-p", "pocket-playset", "--release", "--crate-type", "cdylib"], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error("pocket-playset dylib build failed");
}

const F = FFIType;

export interface PlaysetSim {
  readonly native: PlaysetNative;
  /** pps_prepare: the frame record's draw and triangle counts */
  prepare(): { draws: number; tris: number; culled: number; bones: number; dynVertices: number };
  destroy(): void;
}

export function installPlaysetSim(): PlaysetSim {
  ensureLibrary();
  const lib = dlopen(LIB, {
    pps_create: { args: [F.u32, F.u32], returns: F.ptr },
    pps_destroy: { args: [F.ptr], returns: F.void },
    pps_view: { args: [F.ptr, F.u32, F.ptr], returns: F.ptr },
    pps_model: { args: [F.ptr, F.ptr, F.u32], returns: F.i32 },
    pps_node: { args: [F.ptr, F.i32, F.ptr, F.u32], returns: F.i32 },
    pps_node_set: { args: [F.ptr, F.i32, F.ptr, F.u32], returns: F.void },
    pps_node_remove: { args: [F.ptr, F.i32], returns: F.void },
    pps_env: { args: [F.ptr, F.u32, F.ptr, F.u32], returns: F.void },
    pps_terrain: { args: [F.ptr, F.u32, F.u32, F.f32, F.ptr, F.ptr, F.u32, F.ptr, F.u32], returns: F.void },
    pps_collider: { args: [F.ptr, F.u32, F.ptr, F.u32], returns: F.i32 },
    pps_colliders_clear: { args: [F.ptr], returns: F.void },
    pps_lod: { args: [F.ptr, F.u32, F.u32, F.u32], returns: F.void },
    pps_arch: { args: [F.ptr, F.ptr, F.u32], returns: F.i32 },
    pps_arch_set: { args: [F.ptr, F.i32, F.ptr, F.u32], returns: F.void },
    pps_rule: { args: [F.ptr, F.u32, F.u32, F.u32, F.f32], returns: F.i32 },
    pps_rules_clear: { args: [F.ptr], returns: F.void },
    pps_path: { args: [F.ptr, F.ptr, F.u32], returns: F.i32 },
    pps_emitter: { args: [F.ptr, F.ptr, F.u32], returns: F.i32 },
    pps_spawn: { args: [F.ptr, F.i32, F.f32, F.f32, F.f32, F.f32], returns: F.i32 },
    pps_kill: { args: [F.ptr, F.i32, F.i32], returns: F.void },
    pps_clear: { args: [F.ptr], returns: F.void },
    pps_revive: { args: [F.ptr, F.i32, F.f32], returns: F.void },
    pps_attach: { args: [F.ptr, F.i32, F.i32, F.f32, F.f32, F.f32, F.f32, F.i32], returns: F.void },
    pps_layer: { args: [F.ptr, F.i32, F.u32, F.u32, F.i32], returns: F.void },
    pps_emit: { args: [F.ptr, F.i32, F.f32, F.f32, F.f32, F.f32], returns: F.void },
    pps_fire: { args: [F.ptr, F.i32, F.i32], returns: F.void },
    pps_step: { args: [F.ptr, F.f32], returns: F.i32 },
    pps_camera: { args: [F.ptr, F.ptr, F.u32], returns: F.void },
    pps_query: { args: [F.ptr, F.u32, F.f32, F.f32, F.f32, F.f32], returns: F.f32 },
    pps_seed: { args: [F.ptr, F.u32], returns: F.void },
    pps_prepare: { args: [F.ptr, F.f32], returns: F.ptr },
  });
  const s = lib.symbols;
  let world: Pointer | null = null;
  const empty = new Float32Array(1);
  const fp = (a: Float32Array | undefined | null) => ptr(a && a.length ? a : empty);
  const n = (a: Float32Array | undefined | null) => (a ? a.length : 0);
  const xf = new Float32Array(7);
  const need = () => {
    if (!world) throw new TypeError("playset.init() first");
    return world;
  };
  const native: PlaysetNative = {
    init(capacity, particles) {
      if (!world) world = s.pps_create(capacity || 256, particles ?? 512) as Pointer;
      return world !== null;
    },
    view(which) {
      const len = new Uint32Array(1);
      const p = s.pps_view(need(), which, ptr(len)) as Pointer;
      return new Float32Array(toArrayBuffer(p, 0, len[0] * 4));
    },
    model: (d) => s.pps_model(need(), fp(d), n(d)) as number,
    node(model, x, y, z, yaw, pitch, roll, scale, flags) {
      xf.set([x, y, z, yaw, pitch, roll, scale]);
      return s.pps_node(need(), model, ptr(xf), flags & 0x7fffffff) as number;
    },
    nodeSet(node, x, y, z, yaw, pitch, roll, scale, flags) {
      xf.set([x, y, z, yaw, pitch, roll, scale]);
      s.pps_node_set(need(), node, ptr(xf), flags & 0x7fffffff);
    },
    nodeMatrix(node, model, m, flags) {
      const f = ((flags & 0x7fffffff) | 0x80000000) >>> 0;
      if (node < 0) return s.pps_node(need(), model, ptr(m), f) as number;
      s.pps_node_set(need(), node, ptr(m), f);
      return node;
    },
    nodeRemove: (node) => s.pps_node_remove(need(), node),
    env: (kind, p) => s.pps_env(need(), kind, fp(p), n(p)),
    terrain(w, h, cell, ox, oy, oz, heights, bands) {
      const o = new Float32Array([ox, oy, oz]);
      s.pps_terrain(need(), w, h, cell, ptr(o), fp(heights), n(heights), fp(bands), n(bands));
    },
    collider: (shape, p) => s.pps_collider(need(), shape, fp(p), n(p)) as number,
    collidersClear: () => s.pps_colliders_clear(need()),
    lod: (a, b, c) => s.pps_lod(need(), a, b, c),
    arch: (d) => s.pps_arch(need(), fp(d), n(d)) as number,
    archSet: (id, d) => s.pps_arch_set(need(), id, fp(d), n(d)),
    rule: (a, b, flags, value) => s.pps_rule(need(), a >>> 0, b >>> 0, flags >>> 0, value) as number,
    rulesClear: () => s.pps_rules_clear(need()),
    path: (p) => s.pps_path(need(), fp(p), n(p)) as number,
    emitter: (d) => s.pps_emitter(need(), fp(d), n(d)) as number,
    spawn: (arch, x, y, z, yaw) => s.pps_spawn(need(), arch, x, y, z, yaw) as number,
    kill: (slot, mode) => s.pps_kill(need(), slot, mode),
    revive: (slot, hp) => s.pps_revive(need(), slot, hp),
    attach: (slot, parent, x, y, z, yaw, follow) => s.pps_attach(need(), slot, parent, x, y, z, yaw, follow),
    layer: (slot, layer, mask, team) => s.pps_layer(need(), slot, layer >>> 0, mask >>> 0, team),
    emit: (e, x, y, z, count) => s.pps_emit(need(), e, x, y, z, count ?? 1),
    fire: (slot, w) => s.pps_fire(need(), slot, w),
    step: (dt) => s.pps_step(need(), dt) as number,
    camera: (d) => s.pps_camera(need(), fp(d), n(d)),
    query: (kind, a, b, c, d) => s.pps_query(need(), kind, a, b, c, d) as number,
    seed: (v) => s.pps_seed(need(), v >>> 0),
    clear: () => s.pps_clear(need()),
    now: () => performance.now() * 1000,
    renderStats(out) {
      out.fill(0);
    },
  };
  (globalThis as { playset?: PlaysetNative }).playset = native;
  return {
    native,
    prepare() {
      const p = s.pps_prepare(need(), 400 / 240) as Pointer;
      // pps_frame: 12 + 4 + 10 * 4 floats, then (pointer, count) pairs with
      // 8-byte pointers on the desktop, then tris and culled
      const at = 56 * 4;
      const head = new DataView(toArrayBuffer(p, 0, at + 72));
      const drawCount = head.getUint32(at + 8, true);
      const boneCount = head.getUint32(at + 24, true);
      const dynVertices = head.getUint32(at + 40, true);
      const tris = head.getUint32(at + 60, true);
      const culled = head.getUint32(at + 64, true);
      return { draws: drawCount, tris, culled, bones: boneCount, dynVertices };
    },
    destroy() {
      if (world) s.pps_destroy(world);
      world = null;
      delete (globalThis as { playset?: PlaysetNative }).playset;
    },
  };
}
