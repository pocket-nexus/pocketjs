// hosts/sim/console-3ds.ts — a 3DS-shaped console around bootBundle for
// system-app simulation: the two screens (400x240 top, 320x240 touch
// bottom), the 3DS app table (spec ops 39/40 with its version/bytes/launcher/
// lastError fields), and the Pocket Link, Wi-Fi, camera and NET fakes, all
// advanced once per virtual frame. Wall time is not an input: Date.now()
// reads a virtual clock while guest code runs.
//
//   const console3ds = await bootConsole3ds({ js, pak, apps: [...], link: {...} });
//   console3ds.run(30);
//   console3ds.tap(40, 200);                 // bottom-screen stylus tap
//   console3ds.press(BTN.CIRCLE);            // A
//   console3ds.texts("auxiliary");           // every painted text
//   console3ds.launches                      // appLaunch() calls

import { bootBundle, type BundleWorld, type SimNode, type SimSurface } from "./sim.ts";
import { createSimLinkHost, type SimInstalledApp, type SimLinkFixture, type SimLinkHost } from "./link.ts";
import { createSimWifiHost, type SimWifiFixture, type SimWifiHost } from "./wifi.ts";
import { createSimCameraHost, type SimCameraHost } from "./camera.ts";
import { createSimNetHost, type SimNetHost, type SimNetRoute } from "./net.ts";
import { createSimAgentHost, type SimAgentHost } from "./agent.ts";

export const TOP_SCREEN: [number, number] = [400, 240];
export const BOTTOM_SCREEN: [number, number] = [320, 240];

export interface Console3dsApp extends SimInstalledApp {}

export interface Console3dsOptions {
  js: string;
  pak?: string;
  /** Installed mini-apps (the launcher's own entry is not among them). */
  apps?: Console3dsApp[];
  /** Output name of the system launcher. Default "home-main". */
  launcher?: string;
  /** Output name of the running bundle. Default: the launcher. */
  current?: string;
  resume?: string | null;
  lastError?: { output: string; message: string } | null;
  link?: SimLinkFixture | null;
  wifi?: SimWifiFixture | null;
  /** Mount the camera module. Default true. */
  camera?: boolean;
  /** NET routes; omitted = no NET module. */
  net?: Readonly<Record<string, SimNetRoute>>;
  /** Mount the agent namespace (contracts/spec/agent.ts); omitted = none. */
  agent?: { available?: boolean };
  /** Virtual epoch at boot, ms. Default 2026-10-19T01:41:00Z. */
  epochMs?: number;
}

export interface Console3ds {
  world: BundleWorld;
  link: SimLinkHost | null;
  wifi: SimWifiHost | null;
  camera: SimCameraHost | null;
  net: SimNetHost | null;
  agent: SimAgentHost | null;
  /** The table appTable() reports. */
  apps: Console3dsApp[];
  /** Every appLaunch() call, in order. */
  launches: string[];
  /** One frame with this input, then the guest's promise jobs (a native
   *  host runs them after every frame); throws the guest's failure. */
  step(input?: Parameters<BundleWorld["step"]>[0]): Promise<void>;
  run(frames: number): Promise<void>;
  /** A stylus tap on the bottom screen: held `hold` frames, then lifted and settled. */
  tap(x: number, y: number, hold?: number): Promise<void>;
  /** A straight stylus drag on the bottom screen over `frames` frames. */
  drag(x0: number, y0: number, x1: number, y1: number, frames?: number): Promise<void>;
  /** One button pulse, then `settle` idle frames. */
  press(button: number, settle?: number): Promise<void>;
  /** Visible texts on a surface, in tree order. */
  texts(surface?: SimSurface): string[];
  /** The box of the last painted text equal to `text` (the one drawn on top), or null. */
  locate(text: string, surface?: SimSurface): [number, number, number, number] | null;
  /** Tap the middle of the bottom-screen text `text`; throws when it is not on screen. */
  tapText(text: string): Promise<void>;
  tree(surface?: SimSurface): SimNode | null;
  now(): number;
}

const DEFAULT_EPOCH = Date.UTC(2026, 9, 19, 1, 41, 0);

function locateText(node: SimNode | null, text: string, size: [number, number], box: SimNode["rect"] = null): SimNode["rect"] {
  if (!node || node.hidden) return null;
  const rect = node.rect ?? box;
  let found: SimNode["rect"] = null;
  // A multi-line text is located by its line: an even share of its box.
  const lines = node.text?.split("\n") ?? [];
  const line = lines.indexOf(text);
  if (line >= 0 && rect) {
    const [x, y0, w, h0] = rect;
    const h = h0 / lines.length;
    const y = y0 + line * h;
    if (x < size[0] && y < size[1] && x + w > 0 && y + h > 0) found = [x, y, w, h];
  }
  for (const child of node.children) found = locateText(child, text, size, rect) ?? found;
  return found;
}

/** Painted texts in tree order: a <Text> element carries the box, the run
 *  under it the characters. Boxes wholly off the surface are skipped, and an
 *  embossed label (the same text twice in a row) is listed once. A text of
 *  several lines is listed line by line. */
function flatTexts(node: SimNode | null, size: [number, number], out: string[], box: SimNode["rect"] = null): string[] {
  if (!node || node.hidden) return out;
  const rect = node.rect ?? box;
  if (node.text && rect) {
    const [x, y, w, h] = rect;
    const onScreen = x < size[0] && y < size[1] && x + w > 0 && y + h > 0;
    if (onScreen && out[out.length - 1] !== node.text) {
      if (node.text.includes("\n")) out.push(...node.text.split("\n"));
      else out.push(node.text);
    }
  }
  for (const child of node.children) flatTexts(child, size, out, rect);
  return out;
}

export async function bootConsole3ds(options: Console3dsOptions): Promise<Console3ds> {
  const launcher = options.launcher ?? "home-main";
  const apps: Console3dsApp[] = (options.apps ?? []).map((app) => ({ ...app }));
  const launches: string[] = [];
  const current = options.current ?? launcher;
  const linkHost = options.link === null ? null : createSimLinkHost(options.link ?? {}, {
    onInstalled(app) {
      const index = apps.findIndex((entry) => entry.id === app.id);
      if (index >= 0) apps[index] = { ...app };
      else apps.push({ ...app });
    },
    onRemove(appId) {
      const index = apps.findIndex((entry) => entry.id === appId);
      if (index < 0 || apps[index]!.output === current) return false;
      apps.splice(index, 1);
      return true;
    },
  });
  const wifiHost = options.wifi === null ? null : createSimWifiHost(options.wifi ?? {});
  const cameraHost = options.camera === false ? null : createSimCameraHost();
  const netHost = options.net ? createSimNetHost(options.net) : null;
  const agentHost = options.agent ? createSimAgentHost(options.agent) : null;

  let epoch = options.epochMs ?? DEFAULT_EPOCH;
  const realNow = Date.now;
  const virtual = <T>(run: () => T): T => {
    Date.now = () => epoch;
    try {
      return run();
    } finally {
      Date.now = realNow;
    }
  };

  const g = globalThis as Record<string, unknown>;
  g.link = linkHost?.ns;
  g.wifi = wifiHost?.ns;
  g.camera = cameraHost?.ns;
  g.net = netHost?.ns;
  g.agent = agentHost?.ns;

  // The bundle evaluates after bootBundle's first await, so the virtual
  // clock covers the whole boot, not just its synchronous start.
  Date.now = () => epoch;
  const booting = bootBundle({
      js: options.js,
      pak: options.pak,
      viewport: { width: TOP_SCREEN[0], height: TOP_SCREEN[1], auxiliary: BOTTOM_SCREEN },
      ops(ops) {
        ops.appTable = () =>
          JSON.stringify({
            apps: apps.map((app) => ({ ...app })),
            current,
            resume: options.resume ?? null,
            launcher,
            lastError: options.lastError ?? null,
          });
        ops.appLaunch = (output: string): number => {
          if (output !== launcher && !apps.some((app) => app.output === output)) return 0;
          launches.push(output);
          return 1;
        };
        ops.appShot = () => -1;
      },
    });
  let world: BundleWorld;
  try {
    world = await booting;
  } finally {
    Date.now = realNow;
  }
  if (world.failure) throw new Error(`${world.failure.message}\n${world.failure.stack}`);

  // Promise jobs the frame queued run before the next frame, in order.
  const drain = () => new Promise<void>((resolve) => setImmediate(resolve));
  const step = async (input?: Parameters<BundleWorld["step"]>[0]) => {
    const ok = virtual(() => world.step(input));
    epoch += 1000 / world.hz;
    linkHost?.tick();
    wifiHost?.tick();
    netHost?.tick();
    if (!ok) throw new Error(`${world.failure?.message}\n${world.failure?.stack}`);
    Date.now = () => epoch;
    try {
      await drain();
    } finally {
      Date.now = realNow;
    }
  };
  const run = async (frames: number) => {
    for (let frame = 0; frame < frames; frame++) await step();
  };

  return {
    world,
    link: linkHost,
    wifi: wifiHost,
    camera: cameraHost,
    net: netHost,
    agent: agentHost,
    apps,
    launches,
    step,
    run,
    async tap(x, y, hold = 3) {
      for (let frame = 0; frame < hold; frame++) await step({ touches: [{ x, y }], surface: "auxiliary" });
      await run(2);
    },
    async drag(x0, y0, x1, y1, frames = 12) {
      for (let frame = 0; frame <= frames; frame++) {
        const t = frame / frames;
        await step({ touches: [{ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t }], surface: "auxiliary" });
      }
      await run(2);
    },
    async press(button, settle = 2) {
      await step({ buttons: button });
      await run(settle);
    },
    texts: (surface = "primary") => flatTexts(world.tree(surface), surface === "auxiliary" ? BOTTOM_SCREEN : TOP_SCREEN, []),
    tree: (surface = "primary") => world.tree(surface),
    locate: (text, surface = "auxiliary") => locateText(world.tree(surface), text, surface === "auxiliary" ? BOTTOM_SCREEN : TOP_SCREEN),
    async tapText(text) {
      const rect = locateText(world.tree("auxiliary"), text, BOTTOM_SCREEN);
      if (!rect) throw new Error(`console-3ds: "${text}" is not on the bottom screen`);
      const x = Math.max(1, Math.min(BOTTOM_SCREEN[0] - 2, rect[0] + Math.min(rect[2], 40) / 2));
      const y = Math.max(1, Math.min(BOTTOM_SCREEN[1] - 2, rect[1] + rect[3] / 2));
      for (let frame = 0; frame < 3; frame++) await step({ touches: [{ x, y }], surface: "auxiliary" });
      await run(2);
    },
    now: () => epoch,
  };
}
