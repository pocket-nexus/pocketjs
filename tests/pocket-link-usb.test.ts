// The Pocket Link USB carrier (contracts/spec/link.ts "USB carrier",
// tools/companion/usb.ts) against a reference console written here: the
// records the PSP host writes and reads in host0:/pocket-link/, the beat
// that links it, and the media ring.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LINK_USB_DIR,
  LINK_USB_HEADER_BYTES,
  LINK_USB_KIND,
  LINK_USB_MAGIC,
  LINK_USB_MEDIA_ACK_BYTES,
  LINK_USB_MEDIA_ACK_MAGIC,
  LINK_USB_MEDIA_CLOSED,
  LINK_USB_MEDIA_HEAD_BYTES,
  LINK_USB_MEDIA_MAGIC,
} from "../contracts/spec/link.ts";
import { MEDIA, MEDIA_PACKET } from "../contracts/spec/media.ts";
import { createMediaStreamServer, mediaHeader, type MediaPacket } from "../tools/media-stream.ts";
import { Companion } from "../tools/companion/server.ts";
import { CompanionStore } from "../tools/companion/store.ts";
import { UsbCarrier, decodeUsbRecord, encodeMediaHead, encodeUsbRecord, fnv1a32, readUsbRecord, type UsbRecord } from "../tools/companion/usb.ts";

const tmpRoot = mkdtempSync(join(tmpdir(), "pocket-link-usb-"));
const share = join(tmpRoot, "host0");
const root = join(share, LINK_USB_DIR);
let companion: Companion;

beforeAll(async () => {
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
        beat,
        json: { t: "hello", device: "psp-0123456789ab", name: "PSP", model: "PSP-3000", target: "psp" },
      }),
    );
  }
}

describe("records", () => {
  test("the header layout matches link.ts", () => {
    const json = { t: "media" };
    const bytes = encodeUsbRecord({ epoch: 7, boot: 9, seq: 3, kind: LINK_USB_KIND.media, beat: 5, json });
    const view = new DataView(bytes.buffer);
    const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    expect(view.getUint32(0, true)).toBe(LINK_USB_MAGIC);
    expect([4, 8, 12, 16, 24].map((at) => view.getUint32(at, true))).toEqual([7, 9, 3, LINK_USB_KIND.media, 5]);
    expect(view.getUint32(32, true)).toBe(jsonBytes.length);
    expect(view.getUint32(36, true)).toBe(fnv1a32(jsonBytes));
    expect(bytes.length).toBe(LINK_USB_HEADER_BYTES + jsonBytes.length);
    // The magic spells PKLU in file order.
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("PKLU");
    expect(decodeUsbRecord(bytes)).toEqual({ epoch: 7, boot: 9, seq: 3, kind: LINK_USB_KIND.media, beat: 5, json });
  });

  test("a torn or corrupted record does not decode", () => {
    const bytes = encodeUsbRecord({ epoch: 1, boot: 1, seq: 1, kind: LINK_USB_KIND.hello, beat: 0, json: { a: 1 } });
    expect(decodeUsbRecord(bytes.subarray(0, bytes.length - 1))).toBeNull();
    const flipped = bytes.slice();
    flipped[flipped.length - 1] ^= 1;
    expect(decodeUsbRecord(flipped)).toBeNull();
  });
});

describe("carrier", () => {
  const psp = new Console(0x1234);

  test("ready names the companion, offers media only, and beats", async () => {
    const first = psp.ready();
    expect(first.kind).toBe(LINK_USB_KIND.ready);
    expect(first.epoch).not.toBe(0);
    expect(first.json).toMatchObject({ v: 1, id: companion.id, name: "Zero", features: ["media"] });
    expect(typeof (first.json.clock as { utc: number }).utc).toBe("number");
    await until(() => psp.ready().beat !== first.beat, 2000);
  });

  test("hello links the console", async () => {
    psp.hello();
    const linked = await until(() => companion.connected().find((entry) => entry.address === "usb"));
    expect(linked).toMatchObject({ id: "psp-0123456789ab", name: "PSP", model: "PSP-3000", target: "psp" });
  });
});

/** The PSP's media reader, as programs/psp/src/media.rs reads the ring: the
 *  head, then whole stream bytes from the ring, acknowledged in media.ack. */
class MediaReader {
  pos = 0;
  constructor(
    readonly dir: string,
    readonly generation: number,
    readonly ring: number,
  ) {}
  head() {
    const bytes = readFileSync(join(this.dir, "media.ring")).subarray(0, LINK_USB_MEDIA_HEAD_BYTES);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== LINK_USB_MEDIA_MAGIC || view.getUint32(24, true) !== fnv1a32(bytes.subarray(0, 24))) return null;
    return { epoch: view.getUint32(4, true), generation: view.getUint32(8, true), written: view.getUint32(12, true), flags: view.getUint32(16, true), ring: view.getUint32(20, true) };
  }
  ack() {
    const out = new Uint8Array(LINK_USB_MEDIA_ACK_BYTES);
    const view = new DataView(out.buffer);
    view.setUint32(0, LINK_USB_MEDIA_ACK_MAGIC, true);
    view.setUint32(4, this.generation, true);
    view.setUint32(8, this.pos, true);
    view.setUint32(12, fnv1a32(out.subarray(0, 12)), true);
    writeFileSync(join(this.dir, "media.ack"), out);
  }
  async read(n: number, ms = 3000): Promise<Uint8Array> {
    const end = Date.now() + ms;
    for (;;) {
      const head = this.head();
      if (head && head.generation === this.generation && head.written >= this.pos + n) break;
      if (head && head.generation === this.generation && head.flags & LINK_USB_MEDIA_CLOSED) throw new Error("closed");
      if (Date.now() > end) throw new Error("timed out");
      await Bun.sleep(2);
    }
    const out = new Uint8Array(n);
    const fd = openSync(join(this.dir, "media.ring"), "r");
    for (let done = 0; done < n; ) {
      const at = (this.pos + done) % this.ring;
      const k = Math.min(n - done, this.ring - at);
      readSync(fd, out, done, k, LINK_USB_MEDIA_HEAD_BYTES + at);
      done += k;
    }
    closeSync(fd);
    this.pos += n;
    this.ack();
    return out;
  }
  async packet(): Promise<{ kind: number; pts: number; data: Uint8Array }> {
    const header = await this.read(MEDIA.packetHeaderBytes);
    const view = new DataView(header.buffer);
    const size = view.getUint32(4, true);
    return { kind: header[0]!, pts: view.getUint32(8, true), data: size ? await this.read(size) : new Uint8Array(0) };
  }
}

describe("media ring", () => {
  const dir = mkdtempSync(join(tmpdir(), "pocket-link-usb-media-"));
  const logs: string[] = [];
  const RING = 4096;
  const carrier = new UsbCarrier(
    { id: "c0ffee", name: "Zero", log: (line) => logs.push(line) },
    dir,
    { beatMs: 50, pollMs: 5, mediaRingBytes: RING },
  );
  const linkDir = join(dir, LINK_USB_DIR);
  const psp = { boot: 0x77, generation: 0 };
  let server: Awaited<ReturnType<typeof createMediaStreamServer>>;
  let stopped = 0;

  beforeAll(async () => {
    carrier.start();
    server = await createMediaStreamServer({ advertiseHost: "127.0.0.1" });
    const epoch = readUsbRecord(join(linkDir, "ready"))!.epoch;
    writeFileSync(
      join(linkDir, "hello"),
      encodeUsbRecord({ epoch, boot: psp.boot, seq: 0, kind: LINK_USB_KIND.hello, beat: 1, json: { t: "hello", device: "psp-1", name: "PSP", model: "PSP", target: "psp" } }),
    );
  });
  afterAll(() => {
    carrier.stop();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const ask = (token?: string) => {
    const generation = ++psp.generation;
    writeFileSync(
      join(linkDir, "media.req"),
      encodeUsbRecord({
        epoch: readUsbRecord(join(linkDir, "ready"))!.epoch,
        boot: psp.boot,
        seq: generation,
        kind: LINK_USB_KIND.media,
        beat: 0,
        json: token === undefined ? { t: "media" } : { t: "media", token },
      }),
    );
    return new MediaReader(linkDir, generation, RING);
  };
  /** Video packets of `size` bytes each (pts 100 ms apart), then the end. */
  const packets = (count: number, size: number) => async function* (signal: AbortSignal): AsyncGenerator<MediaPacket> {
    try {
      for (let i = 0; i < count && !signal.aborted; i += 1) yield { kind: MEDIA_PACKET.video, ptsMs: i * 100, data: new Uint8Array(size).fill(i + 1) };
      while (!signal.aborted) await Bun.sleep(5);
    } finally {
      stopped += 1;
    }
  };

  test("the head layout matches link.ts", () => {
    const head = encodeMediaHead(7, 3, 1000, LINK_USB_MEDIA_CLOSED, 4096);
    const view = new DataView(head.buffer);
    expect(new TextDecoder().decode(head.subarray(0, 4))).toBe("PKLM");
    expect([4, 8, 12, 16, 20].map((at) => view.getUint32(at, true))).toEqual([7, 3, 1000, LINK_USB_MEDIA_CLOSED, 4096]);
    expect(view.getUint32(24, true)).toBe(fnv1a32(head.subarray(0, 24)));
    expect(head.length).toBe(LINK_USB_MEDIA_HEAD_BYTES);
  });

  test("a ticket's header and packets come through the ring as the TCP stream's bytes, across the wrap", async () => {
    const header = mediaHeader(0, 10_000, 12, "pal8");
    const source = server.publish(header, packets(12, 900));
    const reader = ask(source.token);
    expect(Buffer.from(await reader.read(MEDIA.headerBytes)).equals(header)).toBe(true);
    for (let i = 0; i < 12; i += 1) {
      const packet = await reader.packet();
      expect(packet.kind).toBe(MEDIA_PACKET.video);
      expect(packet.pts).toBe(i * 100);
      expect(packet.data.length).toBe(900);
      expect(packet.data.every((b) => b === i + 1)).toBe(true);
    }
    // 12 packets of 916 bytes went through a 4096-byte ring.
    expect(reader.pos).toBeGreaterThan(RING * 2);
  });

  test("the companion writes no more than the console has read back", async () => {
    const source = server.publish(mediaHeader(0, 10_000, 12, "pal8"), packets(20, 1000));
    const reader = ask(source.token);
    await until(() => (reader.head()?.generation === reader.generation && reader.head()!.written > 0 ? true : null));
    await Bun.sleep(100);
    expect(reader.head()!.written).toBeLessThanOrEqual(RING);
    await reader.read(MEDIA.headerBytes);
    await reader.packet();
    await until(() => (reader.head()!.written > RING ? true : null));
    expect(reader.head()!.written - reader.pos).toBeLessThanOrEqual(RING);
  });

  test("a new media.req stops the stream before it; a close leaves a closed head", async () => {
    const before = stopped;
    const reader = ask();
    await until(() => (reader.head()?.generation === reader.generation ? true : null));
    expect(reader.head()!.flags & LINK_USB_MEDIA_CLOSED).toBe(LINK_USB_MEDIA_CLOSED);
    expect(reader.head()!.written).toBe(0);
    await until(() => (stopped >= before + 1 ? true : null));
  });

  test("a token the companion does not hold gets a closed, empty head", async () => {
    const reader = ask("ab".repeat(32));
    await until(() => (reader.head()?.generation === reader.generation ? true : null));
    expect(reader.head()).toMatchObject({ written: 0, flags: LINK_USB_MEDIA_CLOSED });
    await expect(reader.read(1, 200)).rejects.toThrow("closed");
  });

  test("revoking the ticket stops the producer and closes the ring", async () => {
    const before = stopped;
    const source = server.publish(mediaHeader(0, 10_000, 12, "pal8"), packets(2, 100));
    const reader = ask(source.token);
    await reader.read(MEDIA.headerBytes);
    await reader.packet();
    server.revoke(source);
    await until(() => (stopped > before ? true : null));
    await until(() => (reader.head()!.flags & LINK_USB_MEDIA_CLOSED ? true : null));
  });
});
