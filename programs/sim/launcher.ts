// programs/sim/launcher.ts — the multi-app host policy over bootWorld
// (docs/LAUNCHER.md "Hosts"): the SAME protocol programs/psp/src/switch.rs implements
// on the PSP, driven per virtual frame with no screen and no wall clock.
//
// One inner SimWorld is alive at a time. The runner owns the summon chord:
// for non-launcher guests it strips SELECT from every mask and, on a
// host-tracked SELECT press-edge, finishes that frame, captures + downscales
// the framebuffer, and swaps to the launcher guest with `resume` set. The
// three app* ops (spec 39..41) are installed on every guest's ui namespace,
// exactly like the native ffi does.
//
//   const world = await bootLauncherWorld({ hz: 60 });
//   world.step(0);                 // one virtual frame (host policy + guest)
//   world.step(BTN.SELECT);        // summons the launcher after this frame
//   world.current()                // -> "launcher-main"
//
// Determinism: every input is virtual (masks in, worlds re-evaled from
// dist/, bilinear shot in pure doubles) — two identical step sequences
// produce byte-identical framebuffers and switch logs.

import { existsSync, readFileSync } from "node:fs";
import { BTN, PSM } from "../../contracts/spec/spec.ts";
import { bootWorld, fnv1a, type SimWorld } from "./sim.ts";
import { SHOT_W, SHOT_H, downscaleShot } from "./shot.ts";

const ROOT = new URL("../..", import.meta.url).pathname;
const REGISTRY_JSON = ROOT + "dist/launcher-registry.json";

export interface LauncherApp {
  output: string;
  id: string;
  title: string;
}

export interface SwitchEvent {
  /** Virtual frame index (across the whole run) AFTER which the swap happened. */
  frame: number;
  to: string;
  reason: "boot" | "summon" | "launch";
  /** resume context handed to the incoming guest (summon only). */
  resume: string | null;
}

export interface LauncherWorldOptions {
  /** Embedded app table (docs/LAUNCHER.md registry). Default: dist/launcher-registry.json. */
  apps?: LauncherApp[];
  /** The launcher bundle's output name (app 0 of the embed). */
  launcher?: string;
  hz?: number;
  /** Boot into this output (default: the launcher, like the EBOOT). */
  boot?: string;
}

export interface LauncherWorld {
  /** One virtual frame: host summon policy, then the guest's frame + core
   *  catch-up ticks, then any scheduled guest swap. */
  step(mask?: number, analog?: number): Promise<void>;
  render(): Uint8Array;
  hash(): string;
  getTree(): unknown;
  current(): string;
  resume(): string | null;
  switches: SwitchEvent[];
  /** Total virtual frames stepped. */
  frames(): number;
}

export async function bootLauncherWorld(options: LauncherWorldOptions = {}): Promise<LauncherWorld> {
  const launcher = options.launcher ?? "launcher-main";
  const hz = options.hz ?? 60;
  const apps: LauncherApp[] =
    options.apps ??
    ((): LauncherApp[] => {
      if (!existsSync(REGISTRY_JSON)) {
        throw new Error(
          "launcher-sim: dist/launcher-registry.json missing — run `bun tools/launcher.ts scan` first",
        );
      }
      const parsed = JSON.parse(readFileSync(REGISTRY_JSON, "utf8")) as { apps: LauncherApp[] };
      return parsed.apps.map(({ output, id, title }) => ({ output, id, title }));
    })();
  const known = new Set<string>([launcher, ...apps.map((a) => a.output)]);

  let current = options.boot ?? launcher;
  if (!known.has(current)) throw new Error(`launcher-sim: unknown boot app ${current}`);
  let resume: string | null = null;
  let pending: { to: string; reason: "summon" | "launch" } | null = null;
  let shot: Uint8Array | null = null;
  let prevMask = 0;
  let frame = 0;
  const switches: SwitchEvent[] = [];
  let world: SimWorld = null as unknown as SimWorld;

  const installOps = (ops: Record<string, unknown>) => {
    let shotHandle: number | null = null;
    ops.appTable = () =>
      JSON.stringify({
        apps: apps.map(({ output, id, title }) => ({ output, id, title })),
        current,
        resume,
      });
    ops.appLaunch = (output: string): number => {
      if (!known.has(output)) return 0;
      pending = { to: output, reason: "launch" };
      return 1;
    };
    ops.appShot = (): number => {
      if (!shot) return -1;
      if (shotHandle === null) {
        const upload = ops.uploadTexture as (
          buf: Uint8Array,
          w: number,
          h: number,
          psm: number,
        ) => number;
        shotHandle = upload(shot, SHOT_W, SHOT_H, PSM.PSM_8888);
      }
      return shotHandle;
    };
  };

  const boot = async (to: string, reason: SwitchEvent["reason"]) => {
    world = await bootWorld(to, hz, undefined, installOps);
    current = to;
    switches.push({ frame, to, reason, resume });
  };

  await boot(current, "boot");

  return {
    async step(mask = 0, analog?: number): Promise<void> {
      let guestMask = mask;
      if (current !== launcher) {
        // The system chord: guests never see SELECT; a press-edge summons.
        guestMask &= ~BTN.SELECT;
        if (mask & BTN.SELECT && !(prevMask & BTN.SELECT)) {
          pending = { to: launcher, reason: "summon" };
        }
      }
      prevMask = mask;
      world.frame(guestMask, analog);
      for (let t = 0; t < world.ticksPerFrame; t++) world.tick();
      frame++;
      if (pending) {
        const { to, reason } = pending;
        pending = null;
        if (reason === "summon") {
          // The frozen frame is the guest's LAST presented frame — captured
          // after the frame that carried the press, before teardown.
          shot = downscaleShot(world.render());
          resume = current;
        } else {
          shot = null;
          resume = null;
        }
        await boot(to, reason);
      }
    },
    render: () => world.render(),
    hash: () => fnv1a(world.render()),
    getTree: () => world.getTree(),
    current: () => current,
    resume: () => resume,
    switches,
    frames: () => frame,
  };
}
