import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const companion of [true, false]) test(`${companion ? "companion" : "mailbox"} service owns requests, failures and asset namespace`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "pocket-service-"));
  const sent: any[] = [], incoming: string[] = [], replies: any[] = [], assets: string[] = [], events: any[] = [];
  let session = 1, opened = 0;
  (globalThis as any).offload = { session: () => session, take: () => incoming.shift(), submit: (raw: string) => { sent.push(JSON.parse(raw)); return true; } };
  try {
    const build = await Bun.build({ entrypoints: [join(import.meta.dir, "fixtures/service-client-entry.ts")], outdir: directory, target: "bun",
      define: { __POCKET_FEATURES__: JSON.stringify({ "io.offload": companion }) } });
    expect(build.success).toBe(true);
    const { createServiceClient, installHost, runServicePumps } = await import(build.outputs[0].path);
    installHost({ kind: "injected", target: "test", strict: false, ops: {
      svcOpen: (name: string) => { expect(name).toBe("fixture"); opened++; return true; },
      svcSend: (raw: string) => sent.push(JSON.parse(raw)), svcPoll: () => incoming.splice(0).join("\n"),
      loadImgFile: (file: string) => { assets.push(file); return 7; }, videoOpen: (file: string) => { assets.push(file); return true; },
    } });
    const client = createServiceClient("fixture", { timeoutFrames: 80 });
    const step = (n = 1) => { for (let i = 0; i < n; i++) runServicePumps(); };
    client.subscribe((event: any) => events.push(event));
    client.send({ t: "read", id: 42 }, (reply: any) => replies.push(reply)); step();
    if (companion) {
      expect(opened).toBe(0);
      const request = sent.shift(); expect(request.method).toBe("fixture.command");
      incoming.push(JSON.stringify({ id: request.id, payload: '{"job":1}' })); step(20);
      const poll = sent.shift(); expect(poll.method).toBe("fixture.poll");
      incoming.push(JSON.stringify({ id: poll.id, payload: '{"state":"done","value":{"t":"ready"}}' })); step();
    } else { incoming.push(JSON.stringify({ t: "ready", id: sent.shift().id })); step(5); }
    expect(replies).toEqual([{ t: "ready", id: 42 }]);
    expect(client.image("thumbs/card.img")).toBe(7); expect(client.openStream("media/one.pkst")).toBe(true);
    expect(opened).toBe(1); // Reopening a mailbox would discard unread replies.
    expect(client.image("../private")).toBe(-1); expect(assets).toEqual(["thumbs/card.img", "media/one.pkst"]);
    client.send({ t: "slow", id: 43 }, (reply: any) => replies.push(reply)); step(81);
    expect(replies[1]).toMatchObject({ t: "error", id: 43, message: "Service operation timed out" });
    if (companion) {
      client.send({ t: "late", id: 44 }, (reply: any) => replies.push(reply)); step();
      session = 2; step();
      expect(events).toEqual([{ t: "offline" }]);
      expect(replies.filter(reply => reply.id === 44)).toHaveLength(1);
    }
    client.dispose();
  } finally { delete (globalThis as any).offload; rmSync(directory, { recursive: true, force: true }); }
});
