// Regression tests for the web System child-surface upload gate
// (hosts/web/system-engine.js reconcile + hosts/web/app-instance.js +
// hosts/web/wasm-ops.js rasterRevision feature-detect).
//
// The gate skips child render()+uploadSurface() when a settled AppInstance
// produces identical pixels. These tests pin every component of the safe
// invalidation key against the counterexample matrix verified on real wasm:
// first frame, same-handle instance rebuild, same-hash viewport resize,
// in-place font/texture replacement (equal words, changed pixels), hide/show,
// failed-upload retry, independent per-surface state, and the all-dirty path.
//
// Section 1 exercises the exported gate state machine directly (no wasm);
// section 2 drives the same decisions through createWasmUi instances and a
// real shell compositor, the way mountPocketSystem's reconcile does.

import { describe, expect, test } from "bun:test";
import { createWasmUi } from "../hosts/web/wasm-ops.js";
import type { WasmUi } from "../hosts/web/wasm-ops.js";
import {
  createSurfaceGate,
  noteSurfaceUpload,
  surfaceNeedsUpload,
} from "../hosts/web/system-engine.js";
import { NODE_TYPE, PROP, ROOT_ID } from "../contracts/spec/spec.ts";

const WASM_URL = new URL("../hosts/web/pocketjs.wasm", import.meta.url);

async function bootUi(width = 480, height = 272): Promise<WasmUi> {
  return createWasmUi(await Bun.file(WASM_URL).arrayBuffer(), { width, height });
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const H = (x: number) => BigInt(x);

// ---------------------------------------------------------------------------
// Section 1: the gate state machine (counterexamples 1, 3, 7, 10, 14 +
// stale-wasm fallback + instance identity + visibility parking).
// ---------------------------------------------------------------------------

describe("System surface upload gate (state machine)", () => {
  test("counterexample 1: the first frame for an instance always uploads", () => {
    const gate = createSurfaceGate();
    // The record starts with no successful upload; upload-retry semantics
    // hinge on this initial state.
    expect(gate.clean).toBe(false);
    expect(gate.hash).toBeNull();
    expect(gate.revision).toBeNull();
    expect(surfaceNeedsUpload(gate, H(111), H(7), 240, 136)).toBe(true);
  });

  test("settled frames with the full key unchanged are skipped", () => {
    const gate = createSurfaceGate();
    noteSurfaceUpload(gate, H(111), H(7), 240, 136, true);
    expect(surfaceNeedsUpload(gate, H(111), H(7), 240, 136)).toBe(false);
  });

  test("counterexample 6: a changed draw hash forces the upload", () => {
    const gate = createSurfaceGate();
    noteSurfaceUpload(gate, H(111), H(7), 240, 136, true);
    expect(surfaceNeedsUpload(gate, H(112), H(7), 240, 136)).toBe(true);
  });

  test("counterexamples 7/8: a raster-asset revision change forces upload while the hash is equal", () => {
    const gate = createSurfaceGate();
    noteSurfaceUpload(gate, H(111), H(7), 240, 136, true);
    // The naive hash-only decision would skip here; the revision component
    // is the only thing distinguishing replaced font/texture pixels.
    expect(surfaceNeedsUpload(gate, H(111), H(8), 240, 136)).toBe(true);
    expect(surfaceNeedsUpload(gate, H(111), H(7), 240, 136)).toBe(false);
  });

  test("counterexample 3: a viewport change forces upload while the hash is equal", () => {
    const gate = createSurfaceGate();
    noteSurfaceUpload(gate, H(111), H(7), 240, 136, true);
    expect(surfaceNeedsUpload(gate, H(111), H(7), 200, 120)).toBe(true);
    expect(surfaceNeedsUpload(gate, H(111), H(7), 240, 120)).toBe(true);
    expect(surfaceNeedsUpload(gate, H(111), H(7), 240, 136)).toBe(false);
  });

  test("counterexample 10: a failed upload keeps the record dirty and the old key, so the next identical frame retries", () => {
    const gate = createSurfaceGate();
    noteSurfaceUpload(gate, H(111), H(7), 240, 136, true);
    // Hash moves to 222, the upload fails: the new key must NOT be committed.
    noteSurfaceUpload(gate, H(222), H(7), 240, 136, false);
    expect(gate.clean).toBe(false);
    expect(gate.hash).toBe(H(111));
    expect(surfaceNeedsUpload(gate, H(222), H(7), 240, 136)).toBe(true);
    // Retry succeeds: from then on the new key skips.
    noteSurfaceUpload(gate, H(222), H(7), 240, 136, true);
    expect(surfaceNeedsUpload(gate, H(222), H(7), 240, 136)).toBe(false);
  });

  test("first-frame failure is retried and a later success commits", () => {
    const gate = createSurfaceGate();
    noteSurfaceUpload(gate, H(1), H(1), 240, 136, false);
    expect(surfaceNeedsUpload(gate, H(1), H(1), 240, 136)).toBe(true);
    noteSurfaceUpload(gate, H(1), H(1), 240, 136, true);
    expect(surfaceNeedsUpload(gate, H(1), H(1), 240, 136)).toBe(false);
  });

  test("stale wasm without draw hash or raster revision uploads every frame", () => {
    const gate = createSurfaceGate();
    // Even a "successful" frame cannot park the gate when either dirty
    // signal is missing: the host can neither see word changes nor in-place
    // asset replacements.
    noteSurfaceUpload(gate, null, null, 240, 136, true);
    expect(surfaceNeedsUpload(gate, null, null, 240, 136)).toBe(true);
    const gate2 = createSurfaceGate();
    noteSurfaceUpload(gate2, H(9), null, 240, 136, true);
    expect(surfaceNeedsUpload(gate2, H(9), null, 240, 136)).toBe(true);
    const gate3 = createSurfaceGate();
    expect(surfaceNeedsUpload(gate3, null, H(9), 240, 136)).toBe(true);
  });

  test("counterexample 2: a fresh instance reopened on the same handle uploads despite a coincident key", () => {
    // The old instance parked its gate on the exact key the fresh wasm
    // instance emits on its first frame. Instance identity is the record
    // itself: closeChild discards it, openChild starts with clean=false.
    const oldGate = createSurfaceGate();
    noteSurfaceUpload(oldGate, H(111), H(7), 240, 136, true);
    expect(surfaceNeedsUpload(oldGate, H(111), H(7), 240, 136)).toBe(false);
    const newGate = createSurfaceGate();
    expect(surfaceNeedsUpload(newGate, H(111), H(7), 240, 136)).toBe(true);
  });

  test("counterexample 5: hiding does not move the record; a reshown unchanged child stays skipped, a mutated one uploads", () => {
    const gate = createSurfaceGate();
    noteSurfaceUpload(gate, H(111), H(7), 240, 136, true);
    // Hidden frames are never presented to the gate. Reshown unchanged:
    expect(surfaceNeedsUpload(gate, H(111), H(7), 240, 136)).toBe(false);
    // The background instance kept stepping (backgroundExecution="continue")
    // and its words changed while hidden:
    expect(surfaceNeedsUpload(gate, H(140), H(7), 240, 136)).toBe(true);
  });

  test("counterexample independence: two surface records do not share state", () => {
    const a = createSurfaceGate();
    const b = createSurfaceGate();
    noteSurfaceUpload(a, H(1), H(1), 240, 136, true);
    noteSurfaceUpload(b, H(2), H(1), 240, 136, true);
    expect(surfaceNeedsUpload(a, H(1), H(1), 240, 136)).toBe(false);
    expect(surfaceNeedsUpload(b, H(2), H(1), 240, 136)).toBe(false);
    // Surface B animates; A must remain parked.
    expect(surfaceNeedsUpload(b, H(3), H(1), 240, 136)).toBe(true);
    expect(surfaceNeedsUpload(a, H(1), H(1), 240, 136)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Section 2: real wasm instances + shell compositor.
// ---------------------------------------------------------------------------

/** A child Ui showing one full-size coloured view, as an AppInstance would. */
async function bootChild(
  width: number,
  height: number,
  color: number,
): Promise<{ ui: WasmUi; node: number; width: number; height: number }> {
  const ui = await bootUi(width, height);
  const node = ui.ops.createNode(NODE_TYPE.view);
  ui.ops.setProp(node, PROP.width, width);
  ui.ops.setProp(node, PROP.height, height);
  ui.ops.setProp(node, PROP.bgColor, color);
  ui.ops.insertBefore(ROOT_ID, node, 0);
  ui.tick();
  return { ui, node, width, height };
}

/** Shell Ui with one SURFACE_QUAD node bound per compositor handle. */
async function bootShell(handles: number[], bandHeight = 136): Promise<{
  ui: WasmUi;
  nodes: Map<number, number>;
}> {
  const ui = await bootUi(480, 272);
  const nodes = new Map<number, number>();
  handles.forEach((handle, idx) => {
    const node = ui.ops.createNode(NODE_TYPE.surface);
    ui.ops.setProp(node, PROP.posType, 1);
    ui.ops.setProp(node, PROP.insetT, idx * bandHeight);
    ui.ops.setProp(node, PROP.insetL, 0);
    ui.ops.setProp(node, PROP.width, 480);
    ui.ops.setProp(node, PROP.height, bandHeight);
    ui.ops.insertBefore(ROOT_ID, node, 0);
    ui.ops.setCompositorSurface!(node, handle, 0);
    nodes.set(handle, node);
  });
  ui.tick();
  return { ui, nodes };
}

interface DrivenChild {
  ui: WasmUi;
  width: number;
  height: number;
  gate: ReturnType<typeof createSurfaceGate>;
  renders: number;
  uploads: number;
  failures: number;
}

function driveChild(child: DrivenChild, shell: WasmUi, handle: number): "skip" | "upload" | "fail" {
  child.ui.tick();
  const hash = child.ui.drawHash!();
  const revision = child.ui.rasterRevision!();
  if (!surfaceNeedsUpload(child.gate, hash, revision, child.width, child.height)) {
    return "skip";
  }
  child.renders++;
  const pixels = child.ui.render().slice();
  const rc = shell.uploadCompositorSurface(handle, pixels, child.width, child.height);
  const ok = rc >= 0;
  noteSurfaceUpload(child.gate, hash, revision, child.width, child.height, ok);
  if (ok) { child.uploads++; return "upload"; }
  child.failures++;
  return "fail";
}

function asDriven(booted: Awaited<ReturnType<typeof bootChild>>): DrivenChild {
  return { ui: booted.ui, width: booted.width, height: booted.height, gate: createSurfaceGate(), renders: 0, uploads: 0, failures: 0 };
}

describe("System surface upload gate (real wasm)", () => {
  test("wasm exposes ui_raster_revision and the core bumps it only on asset changes", async () => {
    const ui = await bootUi();
    expect(typeof ui.rasterRevision).toBe("function");
    const r0 = ui.rasterRevision!();
    expect(r0).toBe(1n);
    const pixels = new Uint8Array(8 * 8 * 4).fill(255);
    const tex = ui.ops.uploadTexture(pixels, 8, 8, 3);
    expect(tex).toBeGreaterThanOrEqual(0);
    expect(ui.rasterRevision!()).toBe(r0 + 1n);
    // Layout/tick work leaves the asset token untouched.
    const node = ui.ops.createNode(NODE_TYPE.view);
    ui.ops.setProp(node, PROP.width, 10);
    ui.ops.setProp(node, PROP.height, 10);
    ui.ops.insertBefore(ROOT_ID, node, 0);
    ui.tick();
    expect(ui.rasterRevision!()).toBe(r0 + 1n);
    ui.ops.freeTexture!(tex);
    expect(ui.rasterRevision!()).toBe(r0 + 2n);
  });

  test("a stale-wasm shim reports null rasterRevision and null drawHash", async () => {
    const ui = await bootUi();
    // Feature detection is on the bound functions; emulate an old binary by
    // deleting them from the returned handle (mirrors the `ex.ui_* ? ... :
    // null` wiring in wasm-ops.js).
    (ui as { drawHash: unknown }).drawHash = null;
    (ui as { rasterRevision: unknown }).rasterRevision = null;
    const gate = createSurfaceGate();
    expect(surfaceNeedsUpload(gate, null, null, 480, 272)).toBe(true);
  });

  test("settled child: one upload, then skips, and skipped pixels match the retained upload", async () => {
    const shell = (await bootShell([1])).ui;
    const booted = await bootChild(240, 136, 0xff2040ff);
    const gate = createSurfaceGate();
    booted.ui.tick();
    const hash0 = booted.ui.drawHash!();
    const rev0 = booted.ui.rasterRevision!();
    expect(surfaceNeedsUpload(gate, hash0, rev0, 240, 136)).toBe(true);
    const uploaded0 = booted.ui.render().slice();
    expect(shell.uploadCompositorSurface(1, uploaded0, 240, 136)).toBeGreaterThanOrEqual(0);
    noteSurfaceUpload(gate, hash0, rev0, 240, 136, true);

    let renders = 1;
    for (let f = 0; f < 4; f++) {
      booted.ui.tick();
      const hash = booted.ui.drawHash!();
      const rev = booted.ui.rasterRevision!();
      expect(surfaceNeedsUpload(gate, hash, rev, 240, 136)).toBe(false);
      // Audit the gate premise: on a skipped frame a fresh rasterization is
      // byte-identical to the pixels the shell is still sampling, so the
      // skipped upload would have replaced them with the same bytes.
      expect(bytesEqual(booted.ui.render().slice(), uploaded0)).toBe(true);
      renders++; // the audit render; the reconcile path itself renders zero times
    }
    expect(renders).toBe(5); // 1 product render + 4 audits; product uploads stay 1
  });

  test("counterexample 6/all-dirty: continuously changing words never skip", async () => {
    const shell = (await bootShell([1])).ui;
    const booted = await bootChild(240, 136, 0xff2040ff);
    const child = asDriven(booted);
    let previous: bigint | null = null;
    for (let f = 0; f < 8; f++) {
      if (f > 0) booted.ui.ops.setProp(booted.node, PROP.translateX, f * 3);
      expect(driveChild(child, shell, 1)).toBe("upload");
      const hash = child.ui.drawHash!();
      if (previous !== null) expect(hash).not.toBe(previous);
      previous = hash;
    }
    expect(child.uploads).toBe(8);
    expect(child.renders).toBe(8);
  });

  test("counterexample 3: a same-words viewport resize changes the framebuffer and forces upload", async () => {
    const ui = await bootUi(480, 272);
    const node = ui.ops.createNode(NODE_TYPE.view);
    ui.ops.setProp(node, PROP.posType, 1);
    ui.ops.setProp(node, PROP.insetT, 10);
    ui.ops.setProp(node, PROP.insetL, 10);
    ui.ops.setProp(node, PROP.width, 24);
    ui.ops.setProp(node, PROP.height, 24);
    ui.ops.setProp(node, PROP.bgColor, 0xffff00ff);
    ui.ops.insertBefore(ROOT_ID, node, 0);
    ui.tick();
    const h0 = ui.drawHash!();
    const before = ui.render();
    const gate = createSurfaceGate();
    noteSurfaceUpload(gate, h0, ui.rasterRevision!(), 480, 272, true);

    ui.resizeViewport(400, 240);
    ui.tick();
    const h1 = ui.drawHash!();
    const after = ui.render();
    expect(h1).toBe(h0); // geometry words identical ...
    expect(after.length).not.toBe(before.length); // ... but the buffer resized
    expect(before.length).toBe(480 * 272 * 4);
    expect(after.length).toBe(400 * 240 * 4);
    // Hash-only would skip; the viewport component uploads.
    expect(surfaceNeedsUpload(gate, h1, ui.rasterRevision!(), 400, 240)).toBe(true);
  });

  test("counterexample 8: freeing and recycling a texture keeps words but changes pixels; the revision re-uploads", async () => {
    const ui = await bootUi();
    const o = ui.ops;
    const img = o.createNode(NODE_TYPE.image);
    o.setProp(img, PROP.width, 24);
    o.setProp(img, PROP.height, 24);
    o.setProp(img, PROP.posType, 1);
    o.setProp(img, PROP.insetT, 10);
    o.setProp(img, PROP.insetL, 10);
    o.insertBefore(ROOT_ID, img, 0);
    const solid = (r: number, g: number, b: number) => {
      const px = new Uint8Array(8 * 8 * 4);
      for (let i = 0; i < 64; i++) px.set([r, g, b, 255], i * 4);
      return px;
    };
    const texA = o.uploadTexture(solid(255, 0, 0), 8, 8, 3);
    o.setImage(img, texA);
    ui.tick();
    const h0 = ui.drawHash!();
    const rev0 = ui.rasterRevision!();
    const fb0 = ui.render().slice();
    const gate = createSurfaceGate();
    noteSurfaceUpload(gate, h0, rev0, 480, 272, true);

    // Free A, upload B (slot recycled under a new generation); the node keeps
    // the stale handle, so words are identical while the image stops drawing.
    o.freeTexture!(texA);
    const texB = o.uploadTexture(solid(0, 0, 255), 8, 8, 3);
    ui.tick();
    const h1 = ui.drawHash!();
    const rev1 = ui.rasterRevision!();
    const fb1 = ui.render().slice();
    expect(h1).toBe(h0);
    expect(bytesEqual(fb0, fb1)).toBe(false);
    expect(rev1).toBeGreaterThan(rev0);
    // A hash-only gate would wrongly skip; the revision component uploads.
    expect(surfaceNeedsUpload(gate, h1, rev0, 480, 272)).toBe(false);
    expect(surfaceNeedsUpload(gate, h1, rev1, 480, 272)).toBe(true);
    expect(texB).not.toBe(texA);
  });

  // A minimal v3 FONT ATLAS blob: one glyph (U+0041) in a 4x4 cell. Layout
  // mirrors engine/core/src/text.rs Atlas::parse (16 B header, 8 B cmap
  // entries, then coverage bytes).
  function fontAtlas(coverageValue: number): Uint8Array {
    const blob = new Uint8Array(16 + 8 + 4 * 4);
    const dv = new DataView(blob.buffer);
    dv.setUint32(0, 0x41464344, true); // FONT_MAGIC 'DCFA' LE
    dv.setUint16(4, 3, true); // FONT_VERSION 3
    dv.setUint16(6, 1, true); // glyph count
    blob[8] = 4; // cell w
    blob[9] = 4; // cell h
    blob[10] = 4; // baseline
    blob[11] = 5; // line height
    blob[12] = 0; // slot
    blob[13] = 0; // flags
    blob[14] = 1; // raster density
    dv.setUint32(16, 0x41, true); // cmap codepoint 'A'
    dv.setUint16(20, 0, true); // glyph id
    blob[22] = 4; // advance
    blob[23] = 0; // xoff
    blob.fill(coverageValue, 24);
    return blob;
  }

  test("counterexample 7: an in-place font atlas replacement keeps words identical but changes glyph pixels; revision re-uploads", async () => {
    const ui = await bootUi();
    // The HostOps wrapper discards the core's bool return by design.
    expect(() => ui.ops.loadFontAtlas!(fontAtlas(255))).not.toThrow();
    const text = ui.ops.createNode(NODE_TYPE.text);
    ui.ops.setProp(text, PROP.fontSlot, 0);
    ui.ops.setProp(text, PROP.textColor, 0xffffffff);
    ui.ops.setText(text, "A");
    ui.ops.insertBefore(ROOT_ID, text, 0);
    ui.tick();
    const h0 = ui.drawHash!();
    const rev0 = ui.rasterRevision!();
    const fb0 = ui.render().slice();
    const gate = createSurfaceGate();
    noteSurfaceUpload(gate, h0, rev0, 480, 272, true);
    let inked = 0;
    for (let i = 3; i < fb0.length; i += 4) if (fb0[i] !== 0) inked++;
    expect(inked).toBeGreaterThan(0);

    // Same header/cmap/metrics, coverage inverted: layout and DrawList words
    // stay identical while the glyph pixels change.
    ui.ops.loadFontAtlas!(fontAtlas(0));
    ui.tick();
    const h1 = ui.drawHash!();
    const rev1 = ui.rasterRevision!();
    const fb1 = ui.render().slice();
    expect(h1).toBe(h0);
    expect(rev1).toBeGreaterThan(rev0);
    expect(bytesEqual(fb0, fb1)).toBe(false);
    expect(surfaceNeedsUpload(gate, h1, rev0, 480, 272)).toBe(false);
    expect(surfaceNeedsUpload(gate, h1, rev1, 480, 272)).toBe(true);
  });

  test("counterexample 2: a brand-new instance on a reused handle emits the old instance's hash yet starts dirty", async () => {
    // Instance 1 parks a gate after its first frame.
    const first = asDriven(await bootChild(240, 136, 0xff2040ff));
    const shell1 = (await bootShell([1])).ui;
    expect(driveChild(first, shell1, 1)).toBe("upload");
    const parkedHash = first.ui.drawHash!();
    const parkedRev = first.ui.rasterRevision!();

    // closeChild disposes instance 1; a fresh wasm instance reopens handle 1
    // and builds an identical scene with an identical first-frame key.
    const shell2 = (await bootShell([1])).ui;
    const reopened = asDriven(await bootChild(240, 136, 0xff2040ff));
    expect(reopened.ui.drawHash!()).toBe(parkedHash);
    expect(reopened.ui.rasterRevision!()).toBe(parkedRev);
    expect(driveChild(reopened, shell2, 1)).toBe("upload");
    expect(reopened.uploads).toBe(1);
  });

  test("counterexample 5: hide-show uploads after hidden mutation and skips when hidden content stayed equal", async () => {
    const shell = (await bootShell([1])).ui;
    const booted = await bootChild(240, 136, 0xff2040ff);
    const child = asDriven(booted);
    expect(driveChild(child, shell, 1)).toBe("upload");

    // Hidden but still stepping (backgroundExecution="continue"): reconcile
    // never presents hidden children to the gate. The child mutates.
    for (const x of [5, 10, 15]) {
      booted.ui.ops.setProp(booted.node, PROP.translateX, x);
      booted.ui.tick();
    }
    // Re-shown mid-motion: the hash moved, so the upload is mandatory.
    child.ui.tick();
    expect(child.ui.drawHash!()).not.toBe(child.gate.hash);
    expect(
      surfaceNeedsUpload(child.gate, child.ui.drawHash!(), child.ui.rasterRevision!(), 240, 136),
    ).toBe(true);
    expect(driveChild(child, shell, 1)).toBe("upload");

    // Hidden again WITHOUT mutation: the reshown frame is still equal and
    // must not re-render or re-upload.
    booted.ui.tick();
    expect(driveChild(child, shell, 1)).toBe("skip");
    expect(child.uploads).toBe(2);
  });

  test("counterexample 10: a rejected first upload leaves the surface empty; the next unchanged frame retries and composites ground truth", async () => {
    const handles = [1];
    // Ground truth: the same frames with every upload accepted.
    const refShell = (await bootShell(handles)).ui;
    const refChild = asDriven(await bootChild(240, 136, 0xff2040ff));
    const refFrames: Uint8Array[] = [];
    for (let f = 0; f < 4; f++) {
      expect(driveChild(refChild, refShell, 1)).toBe(f === 0 ? "upload" : "skip");
      refShell.tick();
      refFrames.push(refShell.renderComposited().slice());
    }

    const shell = (await bootShell(handles)).ui;
    const child = await bootChild(240, 136, 0xff2040ff);
    const gate = createSurfaceGate();
    const gotFrames: Uint8Array[] = [];
    for (let f = 0; f < 4; f++) {
      child.ui.tick();
      const hash = child.ui.drawHash!();
      const rev = child.ui.rasterRevision!();
      if (surfaceNeedsUpload(gate, hash, rev, 240, 136)) {
        const pixels = child.ui.render().slice();
        // Frame 0: hand the wasm a truncated buffer; the compositor rejects it.
        const offered = f === 0 ? pixels.subarray(0, pixels.length - 4) : pixels;
        const rc = shell.uploadCompositorSurface(1, offered, 240, 136);
        noteSurfaceUpload(gate, hash, rev, 240, 136, rc >= 0);
        expect(rc < 0).toBe(f === 0);
      }
      shell.tick();
      gotFrames.push(shell.renderComposited().slice());
    }
    // Frame 0 genuinely has no surface; every later frame matches the
    // all-success reference because the failed key never parked the gate.
    expect(gate.clean).toBe(true);
    for (let f = 1; f < 4; f++) {
      expect(bytesEqual(gotFrames[f], refFrames[f])).toBe(true);
    }
    expect(bytesEqual(gotFrames[0], refFrames[0])).toBe(false);
  });

  test("two child surfaces gate independently: one static uploads once, the animating one uploads every frame", async () => {
    const shell = (await bootShell([1, 2])).ui;
    const a = asDriven(await bootChild(240, 136, 0xff2040ff));
    const bBoot = await bootChild(240, 136, 0xff30c060);
    const b = asDriven(bBoot);
    const results: Array<[string, string]> = [];
    for (let f = 0; f < 6; f++) {
      if (f > 0) bBoot.ui.ops.setProp(bBoot.node, PROP.translateX, f * 3);
      results.push([driveChild(a, shell, 1), driveChild(b, shell, 2)]);
      shell.tick();
      shell.renderComposited();
    }
    expect(results[0]).toEqual(["upload", "upload"]);
    for (let f = 1; f < 6; f++) expect(results[f][0]).toBe("skip");
    for (let f = 1; f < 6; f++) expect(results[f][1]).toBe("upload");
    expect(a.uploads).toBe(1);
    expect(b.uploads).toBe(6);
  });
});
