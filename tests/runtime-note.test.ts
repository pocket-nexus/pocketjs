import { expect, test } from "bun:test";
import { bootWorld, treeHasText } from "../hosts/sim/sim.ts";
import { runtimeWorker } from "./helpers/runtime-text-worker.ts";
import { createCanvas, ImageData } from "@napi-rs/canvas";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

test("runtime Note paints worker geometry and deletes combining graphemes through its input service", async () => {
  const worker = await runtimeWorker(), replies: string[] = [], events: unknown[] = [], sent: any[] = [];
  const source = "e\u0301AV office - proportional text";
  const offloadOps: any = {
    session: () => 1, take: () => replies.shift(), submit(raw: string) {
      const r = JSON.parse(raw); sent.push(r);
      worker.request(r.method, JSON.parse(r.payload)).then(value => replies.push(JSON.stringify({ id: r.id, payload: JSON.stringify(value) })),
        error => replies.push(JSON.stringify({ id: r.id, error: String(error) })));
      return true;
    },
  };
  offloadOps.local = offloadOps;
  const world = await bootWorld("runtime-note-main", 60, { offload: offloadOps }, ops => {
    ops.svcOpen = () => true;
    ops.svcPoll = () => events.length ? events.splice(0).map(x => JSON.stringify(x)).join("\n") + "\n" : null;
    ops.svcSend = () => {};
  });
  const settle = async (text: string) => {
    for (let frame = 0; frame < 500; frame++) {
      world.frame(0); world.tick(); await Bun.sleep(1);
      if (frame % 5 === 0 && treeHasText(world.getTree(), text)) return;
    }
    throw Error(`Editor did not display ${text}`);
  };
  try {
    events.push({ t: "load", text: source }); await settle(source);
    expect(sent.some(r => r.method === "runtime.prepare" && JSON.parse(r.payload).text === source)).toBe(true);
    if (process.env.POCKET_RUNTIME_FONT_SHOT) {
      const canvas = createCanvas(480, 272), context = canvas.getContext("2d");
      context.putImageData(new ImageData(new Uint8ClampedArray(world.render()), 480, 272), 0, 0);
      await mkdir(dirname(process.env.POCKET_RUNTIME_FONT_SHOT), { recursive: true });
      await Bun.write(process.env.POCKET_RUNTIME_FONT_SHOT, canvas.toBuffer("image/png"));
    }
    events.push({ t: "key", k: "Right" }); world.frame(0); world.tick();
    events.push({ t: "key", k: "Backspace" }); await settle("AV office - proportional text");
    expect(treeHasText(world.getTree(), source)).toBe(false);
    events.push({ t: "key", k: "Right", sh: true }); world.frame(0); world.tick();
    events.push({ t: "key", k: "Delete" }); await settle("V office - proportional text");
    expect(treeHasText(world.getTree(), "AV office - proportional text")).toBe(false);
  } finally { worker.close(); delete (globalThis as any).offload; }
}, 30000);
