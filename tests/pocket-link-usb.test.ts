// The Pocket Link USB carrier (contracts/spec/link.ts "USB carrier",
// tools/companion/usb.ts) against a reference console written here: the
// records the PSP host writes and reads in host0:/pocket-link/, net round
// trips to a local server, errors, cancels, stale and torn records.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LINK_USB_DIR, LINK_USB_HEADER_BYTES, LINK_USB_KIND, LINK_USB_MAGIC } from "../contracts/spec/link.ts";
import { NET_ERROR } from "../contracts/spec/net.ts";
import { Companion } from "../tools/companion/server.ts";
import { CompanionStore } from "../tools/companion/store.ts";
import { decodeUsbRecord, encodeUsbRecord, fnv1a32, readUsbRecord, type UsbRecord } from "../tools/companion/usb.ts";

const tmpRoot = mkdtempSync(join(tmpdir(), "pocket-link-usb-"));
const share = join(tmpRoot, "host0");
const root = join(share, LINK_USB_DIR);
let companion: Companion;
let web: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(async () => {
  web = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/slow") await Bun.sleep(400);
      if (url.pathname === "/echo") return new Response(await request.arrayBuffer(), { headers: { "x-method": request.method } });
      return new Response(`hello ${url.pathname}`, { headers: { "content-type": "text/plain" } });
    },
  });
  base = `http://127.0.0.1:${web.port}`;
  companion = new Companion({
    store: new CompanionStore(join(tmpRoot, "store")),
    name: "Zero",
    port: 0,
    host: "127.0.0.1",
    beacon: false,
    allowPrivate: true,
    usb: [share],
  });
  await companion.start();
});

afterAll(async () => {
  await companion.stop();
  web.stop(true);
  rmSync(tmpRoot, { recursive: true, force: true });
});

const until = async <T,>(read: () => T | null | undefined, ms = 2000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
};

/** The PSP side, as platforms/psp/io/src/link.rs writes it: plain writes, no rename. */
class Console {
  seq = [0, 0];
  nextId = 1;
  constructor(readonly boot: number) {}
  ready(): UsbRecord {
    const record = readUsbRecord(join(root, "ready"));
    if (!record) throw new Error("no ready record");
    return record;
  }
  hello(beat = 1) {
    const epoch = this.ready().epoch;
    writeFileSync(
      join(root, "hello"),
      encodeUsbRecord({
        epoch,
        boot: this.boot,
        seq: 0,
        kind: LINK_USB_KIND.hello,
        id: 0,
        beat,
        json: { t: "hello", device: "psp-0123456789ab", name: "PSP", model: "PSP-3000", target: "psp" },
        body: new Uint8Array(0),
      }),
    );
  }
  request(slot: number, meta: Record<string, unknown>, body = new Uint8Array(0), epoch = this.ready().epoch) {
    const id = this.nextId++;
    const seq = ++this.seq[slot]!;
    writeFileSync(
      join(root, `net${slot}.req`),
      encodeUsbRecord({
        epoch,
        boot: this.boot,
        seq,
        kind: LINK_USB_KIND.request,
        id,
        beat: 0,
        json: { t: "net", id, app: "dev.pocket-nexus.hn", bytes: body.length, ...meta },
        body,
      }),
    );
    return { id, seq };
  }
  cancel(slot: number, id: number) {
    writeFileSync(
      join(root, `net${slot}.req`),
      encodeUsbRecord({
        epoch: this.ready().epoch,
        boot: this.boot,
        seq: this.seq[slot]!,
        kind: LINK_USB_KIND.cancel,
        id,
        beat: 0,
        json: { t: "net.cancel", id },
        body: new Uint8Array(0),
      }),
    );
  }
  reply(slot: number, seq: number): UsbRecord | null {
    const record = readUsbRecord(join(root, `net${slot}.res`));
    return record && record.boot === this.boot && record.seq === seq && record.kind === LINK_USB_KIND.reply ? record : null;
  }
}

describe("records", () => {
  test("the header layout matches link.ts", () => {
    const json = { t: "x" };
    const body = new Uint8Array([1, 2, 3]);
    const bytes = encodeUsbRecord({ epoch: 7, boot: 9, seq: 3, kind: LINK_USB_KIND.request, id: 42, beat: 5, json, body });
    const view = new DataView(bytes.buffer);
    const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    expect(view.getUint32(0, true)).toBe(LINK_USB_MAGIC);
    expect([4, 8, 12, 16, 20, 24].map((at) => view.getUint32(at, true))).toEqual([7, 9, 3, LINK_USB_KIND.request, 42, 5]);
    expect(view.getUint32(32, true)).toBe(jsonBytes.length);
    expect(view.getUint32(36, true)).toBe(fnv1a32(jsonBytes));
    expect(view.getUint32(40, true)).toBe(3);
    expect(view.getUint32(44, true)).toBe(fnv1a32(body));
    expect(bytes.length).toBe(LINK_USB_HEADER_BYTES + jsonBytes.length + 3);
    // The magic spells PKLU in file order.
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("PKLU");
    expect(decodeUsbRecord(bytes)?.json).toEqual(json);
  });

  test("a torn or corrupted record does not decode", () => {
    const bytes = encodeUsbRecord({ epoch: 1, boot: 1, seq: 1, kind: 3, id: 1, beat: 0, json: { a: 1 }, body: new Uint8Array(8) });
    expect(decodeUsbRecord(bytes.subarray(0, bytes.length - 1))).toBeNull();
    const flipped = bytes.slice();
    flipped[flipped.length - 1] ^= 1;
    expect(decodeUsbRecord(flipped)).toBeNull();
  });
});

describe("carrier", () => {
  const psp = new Console(0x1234);

  test("ready names the companion, offers net and beats", async () => {
    const first = psp.ready();
    expect(first.kind).toBe(LINK_USB_KIND.ready);
    expect(first.epoch).not.toBe(0);
    expect(first.json).toMatchObject({ v: 1, id: companion.id, name: "Zero", features: ["net"] });
    expect(typeof (first.json.clock as { utc: number }).utc).toBe("number");
    await until(() => psp.ready().beat !== first.beat, 2000);
  });

  test("hello links the console", async () => {
    psp.hello();
    const linked = await until(() => companion.connected().find((entry) => entry.address === "usb"));
    expect(linked).toMatchObject({ id: "psp-0123456789ab", name: "PSP", model: "PSP-3000", target: "psp" });
  });

  test("a GET comes back as a done event with its body", async () => {
    const { id, seq } = psp.request(0, { url: `${base}/item/1`, method: "GET", maxBytes: 4096 });
    const reply = await until(() => psp.reply(0, seq));
    expect(reply.id).toBe(id);
    expect(reply.json).toMatchObject({ t: "done", h: id, status: 200, bytes: 13 });
    expect((reply.json.headers as Record<string, string>)["content-type"]).toBe("text/plain");
    expect(new TextDecoder().decode(reply.body)).toBe("hello /item/1");
  });

  test("a POST body reaches the server", async () => {
    const body = new TextEncoder().encode("pocket");
    const { seq } = psp.request(1, { url: `${base}/echo`, method: "POST" }, body);
    const reply = await until(() => psp.reply(1, seq));
    expect(reply.json).toMatchObject({ t: "done", status: 200, bytes: 6 });
    expect(new TextDecoder().decode(reply.body)).toBe("pocket");
  });

  test("a malformed request is answered with an error event", async () => {
    const { id, seq } = psp.request(0, { url: "ftp://example.com/" });
    const reply = await until(() => psp.reply(0, seq));
    expect(reply.json).toMatchObject({ t: "error", h: id, code: NET_ERROR.invalidRequest });
    expect(reply.body.length).toBe(0);
  });

  test("a cancelled request is never answered, and its record never runs again", async () => {
    const { id, seq } = psp.request(1, { url: `${base}/slow` });
    await Bun.sleep(50);
    psp.cancel(1, id);
    await Bun.sleep(600);
    expect(psp.reply(1, seq)).toBeNull();
  });

  test("a request from another epoch is stale", async () => {
    const { seq } = psp.request(0, { url: `${base}/stale` }, new Uint8Array(0), (psp.ready().epoch + 1) >>> 0);
    await Bun.sleep(200);
    expect(psp.reply(0, seq)).toBeNull();
  });

  test("a torn request waits until it is whole", async () => {
    const id = psp.nextId++;
    const seq = ++psp.seq[0]!;
    const whole = encodeUsbRecord({
      epoch: psp.ready().epoch,
      boot: psp.boot,
      seq,
      kind: LINK_USB_KIND.request,
      id,
      beat: 0,
      json: { t: "net", id, app: "dev.pocket-nexus.hn", bytes: 0, url: `${base}/torn` },
      body: new Uint8Array(0),
    });
    writeFileSync(join(root, "net0.req"), whole.subarray(0, whole.length - 3));
    await Bun.sleep(150);
    expect(psp.reply(0, seq)).toBeNull();
    writeFileSync(join(root, "net0.req"), whole);
    const reply = await until(() => psp.reply(0, seq));
    expect(new TextDecoder().decode(reply.body)).toBe("hello /torn");
  });

  test("a new boot drops the previous boot's requests", async () => {
    const before = psp.request(1, { url: `${base}/slow` });
    await Bun.sleep(50);
    const rebooted = new Console(0x5678);
    rebooted.hello();
    await Bun.sleep(600);
    expect(psp.reply(1, before.seq)).toBeNull();
    const { seq } = rebooted.request(0, { url: `${base}/after` });
    const reply = await until(() => rebooted.reply(0, seq));
    expect(new TextDecoder().decode(reply.body)).toBe("hello /after");
  });

  test("replies are written whole: the file is a complete record", () => {
    const bytes = readFileSync(join(root, "net0.res"));
    expect(decodeUsbRecord(bytes)).not.toBeNull();
  });
});
