// vapor/oracle/boot.ts — build the oracle bundle and drive it.
//
// The bundle is produced with the repo's own vue-vapor jsx pipeline
// (framework/compiler/jsx-plugin.ts), so the todo component goes through the exact
// vue-jsx-vapor transform any PocketJS vapor app does — the oracle is not a
// reimplementation of Vue, it IS Vue 3.6 vapor.

import { join } from "node:path";
import { jsxPlugin } from "../../framework/compiler/jsx-plugin.ts";
import type { StyleTable } from "../compiler/styles.ts";
import { createRootElement, installOracleDom, type VaporElement } from "./dom.ts";
import { paintGrid, type CellGrid } from "./paint.ts";

const ENTRY = join(import.meta.dir, "entry.ts");

const bundleTexts = new Map<string, string>();

async function buildOracleBundle(entry: string): Promise<string> {
  const cached = bundleTexts.get(entry);
  if (cached) return cached;
  const result = await Bun.build({
    entrypoints: [entry],
    format: "iife",
    target: "browser",
    conditions: ["browser"],
    define: {
      document: "globalThis.__vaporDocument",
      "process.env.NODE_ENV": '"production"',
      __DEV__: "false",
    },
    plugins: [jsxPlugin("vue-vapor")],
  });
  if (!result.success) {
    throw new Error(`oracle bundle failed:\n${result.logs.join("\n")}`);
  }
  const bundleText = await result.outputs[0].text();
  bundleTexts.set(entry, bundleText);
  return bundleText;
}

export interface Oracle {
  root: VaporElement;
  /** Deliver one button edge and settle vapor's scheduler. */
  press(button: number): Promise<void>;
  /** Deliver one normalized held-D-pad repeat and settle the scheduler. */
  repeat(button: number): Promise<void>;
  /** Deliver one relative-axis delta and settle vapor's scheduler. */
  axisDelta(axis: number, delta: number): Promise<void>;
  /** Current rendered grid. */
  grid(): CellGrid;
  unmount(): void;
}

export interface OracleOptions {
  width?: number;
  height?: number;
  /** compile-produced style table: class -> pair id/align for the painter */
  styles?: StyleTable;
  /** bundle entry installing the hooks; defaults to the todo entry */
  entry?: string;
}

export async function bootOracle(opts: OracleOptions = {}): Promise<Oracle> {
  const bundle = await buildOracleBundle(opts.entry ?? ENTRY);
  installOracleDom();
  const g = globalThis as Record<string, unknown>;
  g.__vaporScreenW = opts.width ?? 30;
  g.__vaporScreenH = opts.height ?? 20;
  (0, eval)(bundle);

  const hooks = globalThis as Record<string, unknown>;
  const boot = hooks.__vaporBoot as (container: unknown) => { unmount(): void };
  const pressHook = hooks.__vaporPress as (button: number) => void;
  const repeatHook = hooks.__vaporRepeat as (button: number) => void;
  const axisDeltaHook = hooks.__vaporAxisDelta as (axis: number, delta: number) => void;
  const tick = hooks.__vaporTick as () => Promise<void>;

  const root = createRootElement();
  const app = boot(root);
  await tick();

  return {
    root,
    async press(button: number) {
      pressHook(button);
      await tick();
    },
    async repeat(button: number) {
      repeatHook(button);
      await tick();
    },
    async axisDelta(axis: number, delta: number) {
      axisDeltaHook(axis, delta);
      await tick();
    },
    grid: () => paintGrid(root, opts.width ?? 30, opts.height ?? 20, opts.styles),
    unmount: () => app.unmount(),
  };
}
