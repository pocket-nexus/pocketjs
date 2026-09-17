import { existsSync } from "node:fs";
import { join } from "node:path";
import { createWasmUi } from "../../../hosts/web/wasm-ops.js";
import { createTouchHitFacts } from "../../../framework/src/touch.ts";
import { buildRenderConfig, type ScenarioV1 } from "../core/index.ts";
import type { NativeSimWorld } from "./native.ts";

interface EffectEvent {
  readonly t: "command" | "delivery";
  readonly frame: number;
  readonly id: number;
  readonly kind: string;
}

/**
 * Boot a source checkout with the current, versioned benchmark host.
 *
 * The host lives with the harness instead of the source checkout on purpose:
 * `perf local` must be able to measure a revision that predates benchmark-only
 * observations such as DrawList hashing. The source checkout still supplies
 * every measured product artifact: WASM core, app bundle and PAK.
 */
export async function bootNativePerfWorld(
  sourceRoot: string,
  scenario: ScenarioV1,
): Promise<NativeSimWorld> {
  const app = scenario.subject.entry;
  const wasmPath = join(sourceRoot, "hosts/web/pocketjs.wasm");
  const bundlePath = join(sourceRoot, "dist", `${app}.js`);
  const pakPath = join(sourceRoot, "dist", `${app}.pak`);
  const viewport = buildRenderConfig(scenario.params);
  const wasmBytes = await Bun.file(wasmPath).arrayBuffer();
  const wasm = await createWasmUi(wasmBytes, viewport);
  if (!wasm.drawHash) {
    throw new Error(`${scenario.id}: source WASM has no ui_draw_hash export`);
  }

  const effects: EffectEvent[] = [];
  const inbox: string[] = [];
  const outbox: string[] = [];
  const global = globalThis as Record<string, unknown>;
  global.ui = wasm.ops;
  global.__pak = existsSync(pakPath) ? await Bun.file(pakPath).arrayBuffer() : undefined;
  global.frame = undefined;
  global.audio = undefined;
  global.__pocketApp = app;
  global.__simHz = 60;
  global.__pocketEffectTrace = (event: EffectEvent) => effects.push(event);
  global.__pocketEffectDriver = undefined;
  global.__pocketDevtoolsTransport = {
    send: (line: string) => outbox.push(line),
    recv: () => (inbox.length > 0 ? inbox.shift() : null),
  };

  const source = await Bun.file(bundlePath).text();
  (0, eval)(source);
  const appFrame = global.frame as
    | ((buttons: number, analog?: number, touches?: readonly number[], hits?: readonly number[]) => void)
    | undefined;
  if (typeof appFrame !== "function") {
    throw new Error(`${scenario.id}: bundle did not install globalThis.frame`);
  }
  // `Guest::eval` drains QuickJS promise jobs before the QEMU adapter starts
  // its first frame. Give Bun's framework runtime the same microtask boundary.
  await Promise.resolve();

  const hitTestBounds = (wasm.ops as { hitTestBounds?: (x: number, y: number) => number })
    .hitTestBounds;
  const hitFacts = hitTestBounds ? createTouchHitFacts(hitTestBounds) : undefined;
  const frame = (buttons: number, analog?: number, touches?: readonly number[]): void => {
    appFrame(buttons, analog, touches, hitFacts?.(touches));
  };
  const renderScale = viewport.renderScale;

  return {
    frame,
    // Vue Vapor batches ref effects in a promise job; Solid and Octane finish
    // synchronously. The boundary is nevertheless an executor-wide host
    // contract, not a framework special case. It mirrors Guest::frame_*()
    // draining QuickJS jobs before Core tick/render.
    drainJobs: async () => {
      await Promise.resolve();
    },
    tick: wasm.tick,
    render: () => wasm.renderScaled(renderScale),
    drawHash: () => {
      const unsigned = BigInt.asUintN(64, wasm.drawHash!());
      return `fnv1a64:${unsigned.toString(16).padStart(16, "0")}`;
    },
    ticksPerFrame: 1,
    effects,
    getTree: () => {
      outbox.length = 0;
      inbox.push(JSON.stringify({ t: "getTree" }));
      frame(0);
      wasm.tick();
      for (const line of outbox) {
        const message = JSON.parse(line) as { t: string; root?: unknown };
        if (message.t === "tree") return message.root;
      }
      return null;
    },
  };
}
