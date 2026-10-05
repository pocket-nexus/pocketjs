// A guest in PocketJS's browser realm, driven through the Pocket3D kernel's
// page module, with no browser and no game: tests/pocket3d-web.test.ts runs
// this file as a process of its own (a realm owns `globalThis.ui` and
// `globalThis.frame`) and reads the JSON it prints.
//
//   bun tests/fixtures/pocket3d-web/realm.ts <staged directory>
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PROP } from "../../../contracts/spec/spec.ts";

const staged = process.argv[2]!;
const url = (name: string) => pathToFileURL(join(staged, name)).href;

// The guest, by hand: a panel of white at half strength on the primary surface, a green square on the
// second one, the service's lines read and answered. No framework, no pak.
writeFileSync(join(staged, "guest.pak"), "");
writeFileSync(join(staged, "guest.js"), `
const ui = globalThis.ui;
if (!ui.svcOpen("pocket.overlay")) throw new Error("the overlay service is not there");
const box = (root, width, height, colour) => {
  const node = ui.createNode(0);
  ui.setProp(node, ${PROP.width}, width);
  ui.setProp(node, ${PROP.height}, height);
  ui.setProp(node, ${PROP.bgColor}, colour);
  ui.insertBefore(root, node, 0);
  return node;
};
const panel = box(1, 16, 8, 0x80ffffff);
const lower = box(ui.__auxiliarySurface.root, 8, 8, 0xff00ff00);
globalThis.frame = (buttons, analog, touches, hits, surfaces) => {
  for (const line of (ui.svcPoll() ?? "").split("\\n")) {
    if (!line) continue;
    const said = JSON.parse(line);
    if (said.panel) ui.setProp(panel, ${PROP.width}, said.panel);
    if (said.lower) ui.setProp(lower, ${PROP.width}, said.lower);
  }
  if (touches) ui.svcSend(JSON.stringify({ touches: touches.length, hit: hits[0] === lower, surface: surfaces[0], buttons, offload: typeof globalThis.offload, simHz: globalThis.__simHz }));
};
`);

// A realm that starts a text worker constructs one: count them.
const workers: string[] = [];
(globalThis as Record<string, unknown>).Worker = class {
  onmessage = null;
  onerror = null;
  constructor(at: URL | string) {
    workers.push(String(at));
  }
  postMessage() {}
  terminate() {}
};

await import(url("app-instance.js"));
const { attach, realmOptions, screens } = await import(url("pocket3d-interface.js"));
const realm = (globalThis as unknown as { PocketAppInstance: { create(options: object): Promise<any> } }).PocketAppInstance;

// The plan of a device with two screens, the second under a stylus, at two samples a logical pixel.
const plan = {
  app: { id: "dev.pocket-nexus.check" },
  viewport: { logical: [32, 16], physical: [64, 32], rasterDensity: 2 },
  modality: { screens: [{ role: "primary", logical: [32, 16], touch: false }, { role: "auxiliary", logical: [24, 16], touch: true }], buttons: true, glyphs: "letters" },
};
const shape = screens(plan);
// (the game turns this guest 30 times a second, and the realm tells it so)
const { text: _none, ...options } = realmOptions({ wasm: url("pocketjs.wasm"), bundle: url("guest.js"), pak: url("guest.pak"), plan, simHz: 30 });
const instance = await realm.create({ ...options, text: false });
const ui = attach(instance, plan);
const out: Record<string, unknown> = { shape, workersWithoutText: workers.length, offloadWithoutText: typeof (globalThis as Record<string, unknown>).offload };

const pixel = (pixels: Uint8Array, width: number, x: number, y: number) => [...pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
ui.turn(0, []);
out.changedAtFirst = [ui.changed(), ui.lowerChanged()];
const first = ui.picture();
out.picture = { bytes: first.pixels.length, size: [first.width, first.height], inside: pixel(first.pixels, first.width, 10, 6), outside: pixel(first.pixels, first.width, 50, 20) };
out.lower = pixel(ui.lower(), 24, 3, 3);
out.changedAfterReading = [ui.changed(), ui.lowerChanged()];

// The game says the panel is wider: the primary surface changes, the second does not.
ui.send(JSON.stringify({ panel: 30 }) + "\n");
ui.turn(0, []);
out.changedAfterPanel = [ui.changed(), ui.lowerChanged()];
out.wider = pixel(ui.picture().pixels, 64, 50, 6);
// And the other way round.
ui.send(JSON.stringify({ lower: 20 }));
ui.turn(0, []);
out.changedAfterLower = [ui.changed(), ui.lowerChanged()];
out.lowerWider = pixel(ui.lower(), 24, 15, 3);

// A contact on the second screen, with a button held: the guest is handed both, and says so.
ui.turn(0x2000, [{ id: 1, x: 4, y: 4 }], 2);
out.heard = ui.drain().map((line: string) => JSON.parse(line));
out.drainedOnce = ui.drain().length;

// The opaque render is what it was: black where nothing is drawn, the panel over it.
const opaque = instance.render(2);
out.opaque = { inside: pixel(opaque, 64, 10, 6), outside: pixel(opaque, 64, 50, 20) };

// A realm started as before starts the text worker and gives the guest its offload.
await realm.create({ ...options, simHz: undefined });
out.workersWithText = workers.length;
out.simHzUnsaid = (globalThis as Record<string, unknown>).__simHz;
out.offloadWithText = typeof (globalThis as Record<string, unknown>).offload;
console.log(JSON.stringify(out));
process.exit(0);
