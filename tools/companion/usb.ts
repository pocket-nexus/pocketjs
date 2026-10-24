// The Pocket Link USB carrier (contracts/spec/link.ts "USB carrier"): a
// console tethered over PSPLINK reaches this companion through the file share
// usbhostfs_pc serves. The companion owns `<share>/pocket-link/`: it beats
// `ready`, reads the console's `hello` and request slots, and answers each
// request with the same net path the TCP link uses (Companion.answerNet).
//
// Everything here is polling over small files, because the share is the only
// channel: usbhostfs_pc writes what the console writes, and the console reads
// what this process renames into place. The media ring is the exception: the
// console holds it open, so it is written in place (UsbMedia).

import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  LINK_USB_BEAT_MS,
  LINK_USB_DIR,
  LINK_USB_FEATURES,
  LINK_USB_HEADER_BYTES,
  LINK_USB_KIND,
  LINK_USB_MAGIC,
  LINK_USB_MAX_JSON,
  LINK_USB_MEDIA_ACK_BYTES,
  LINK_USB_MEDIA_ACK_MAGIC,
  LINK_USB_MEDIA_CLOSED,
  LINK_USB_MEDIA_HEAD_BYTES,
  LINK_USB_MEDIA_MAGIC,
  LINK_USB_MEDIA_RING_BYTES,
  LINK_USB_SILENCE_MS,
  LINK_USB_SLOTS,
} from "../../contracts/spec/link.ts";
import { MEDIA_PACKET } from "../../contracts/spec/media.ts";
import { NET_ERROR } from "../../contracts/spec/net.ts";
import { mediaPacket, takeMediaTicket, type MediaTicket } from "../media-stream.ts";
import { NetFailure, normalizeNetRequest } from "./fetch.ts";

/** How often the slots and `hello` are read. */
const USB_POLL_MS = 10;

export function fnv1a32(bytes: Uint8Array): number {
  let h = 2166136261;
  for (const b of bytes) h = Math.imul(h ^ b, 16777619) >>> 0;
  return h >>> 0;
}

export interface UsbRecord {
  epoch: number;
  boot: number;
  seq: number;
  kind: number;
  id: number;
  beat: number;
  json: Record<string, unknown>;
  body: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One record: the 64-byte header, the JSON, the body. */
export function encodeUsbRecord(record: Omit<UsbRecord, "json"> & { json: unknown }): Uint8Array {
  const json = encoder.encode(JSON.stringify(record.json));
  if (json.length > LINK_USB_MAX_JSON) throw new Error(`USB record JSON is ${json.length} bytes, over ${LINK_USB_MAX_JSON}`);
  const out = new Uint8Array(LINK_USB_HEADER_BYTES + json.length + record.body.length);
  const view = new DataView(out.buffer);
  const words: [number, number][] = [
    [0, LINK_USB_MAGIC],
    [4, record.epoch],
    [8, record.boot],
    [12, record.seq],
    [16, record.kind],
    [20, record.id],
    [24, record.beat],
    [32, json.length],
    [36, fnv1a32(json)],
    [40, record.body.length],
    [44, fnv1a32(record.body)],
  ];
  for (const [at, value] of words) view.setUint32(at, value >>> 0, true);
  out.set(json, LINK_USB_HEADER_BYTES);
  out.set(record.body, LINK_USB_HEADER_BYTES + json.length);
  return out;
}

/** A whole, untorn record, or null (absent, short, a bad hash, not JSON). */
export function decodeUsbRecord(bytes: Uint8Array): UsbRecord | null {
  if (bytes.length < LINK_USB_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const word = (at: number) => view.getUint32(at, true);
  if (word(0) !== LINK_USB_MAGIC) return null;
  const jsonLength = word(32);
  const bodyLength = word(40);
  if (jsonLength > LINK_USB_MAX_JSON || LINK_USB_HEADER_BYTES + jsonLength + bodyLength !== bytes.length) return null;
  const json = bytes.subarray(LINK_USB_HEADER_BYTES, LINK_USB_HEADER_BYTES + jsonLength);
  const body = bytes.subarray(LINK_USB_HEADER_BYTES + jsonLength);
  if (fnv1a32(json) !== word(36) || fnv1a32(body) !== word(44)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(json));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return {
    epoch: word(4),
    boot: word(8),
    seq: word(12),
    kind: word(16),
    id: word(20),
    beat: word(24),
    json: parsed as Record<string, unknown>,
    body,
  };
}

export function readUsbRecord(path: string): UsbRecord | null {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch {
    return null;
  }
  return decodeUsbRecord(bytes);
}

/** Write under a temporary name and rename: a reader sees the old record or the new one. */
export function writeUsbRecord(path: string, record: Parameters<typeof encodeUsbRecord>[0]): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, encodeUsbRecord(record));
  renameSync(temporary, path);
}

function randomEpoch(): number {
  return (crypto.getRandomValues(new Uint32Array(1))[0]! || 1) >>> 0;
}

export interface UsbDevice {
  id: string;
  name: string;
  model: string;
  target: string;
}

/** The media ring's head (contracts/spec/link.ts "Media"). */
export function encodeMediaHead(epoch: number, generation: number, written: number, flags: number, ring = LINK_USB_MEDIA_RING_BYTES): Uint8Array {
  const out = new Uint8Array(LINK_USB_MEDIA_HEAD_BYTES);
  const view = new DataView(out.buffer);
  for (const [at, value] of [[0, LINK_USB_MEDIA_MAGIC], [4, epoch], [8, generation], [12, written], [16, flags], [20, ring]] as const) {
    view.setUint32(at, value >>> 0, true);
  }
  view.setUint32(24, fnv1a32(out.subarray(0, 24)), true);
  return out;
}

/** The console's `media.ack`: the stream bytes it consumed, for `generation`. */
export function decodeMediaAck(bytes: Uint8Array, generation: number): number | null {
  if (bytes.length < LINK_USB_MEDIA_ACK_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, LINK_USB_MEDIA_ACK_BYTES);
  if (view.getUint32(0, true) !== LINK_USB_MEDIA_ACK_MAGIC || view.getUint32(4, true) !== generation >>> 0) return null;
  if (view.getUint32(12, true) !== fnv1a32(bytes.subarray(0, 12))) return null;
  return view.getUint32(8, true);
}

/** How often a full ring reads `media.ack` again. */
const MEDIA_ACK_POLL_MS = 5;

/** One media stream at a time into `media.ring`: the ticket `media.req`
 *  names, produced here and paced by how much of the ring the console has
 *  read back in `media.ack`. */
class UsbMedia {
  private readonly ring: string;
  private readonly fd: number;
  private boot = 0;
  private seq = 0;
  private abort: AbortController | undefined;

  constructor(
    private readonly root: string,
    private readonly epoch: number,
    private readonly log: (line: string) => void,
    private readonly ringBytes = LINK_USB_MEDIA_RING_BYTES,
  ) {
    this.ring = join(root, "media.ring");
    rmSync(join(root, "media.ack"), { force: true });
    this.fd = openSync(this.ring, "w+");
    ftruncateSync(this.fd, LINK_USB_MEDIA_HEAD_BYTES + ringBytes);
    this.head(0, 0, LINK_USB_MEDIA_CLOSED);
  }

  private head(generation: number, written: number, flags: number) {
    writeSync(this.fd, encodeMediaHead(this.epoch, generation, written, flags, this.ringBytes), 0, LINK_USB_MEDIA_HEAD_BYTES, 0);
  }

  private read(generation: number): number | null {
    try {
      return decodeMediaAck(readFileSync(join(this.root, "media.ack")), generation);
    } catch {
      return null;
    }
  }

  stop() {
    this.abort?.abort();
    this.abort = undefined;
  }

  close() {
    this.stop();
    closeSync(this.fd);
  }

  poll(boot: number) {
    const record = readUsbRecord(join(this.root, "media.req"));
    if (!record || record.kind !== LINK_USB_KIND.media || record.epoch !== this.epoch || record.boot !== boot) return;
    if (record.boot === this.boot && record.seq <= this.seq) return;
    this.boot = record.boot;
    this.seq = record.seq;
    this.stop();
    const token = record.json.token;
    const ticket = typeof token === "string" && /^[0-9a-f]{64}$/.test(token) ? takeMediaTicket(token) : undefined;
    if (!ticket) {
      if (token !== undefined) this.log(`usb media #${record.seq}: no such ticket`);
      this.head(record.seq, 0, LINK_USB_MEDIA_CLOSED);
      return;
    }
    const abort = new AbortController();
    this.abort = abort;
    const revoked = () => abort.abort();
    ticket.signal.addEventListener("abort", revoked, { once: true });
    void this.stream(record.seq, ticket, abort).finally(() => {
      ticket.signal.removeEventListener("abort", revoked);
      ticket.release();
    });
  }

  private async stream(generation: number, ticket: MediaTicket, abort: AbortController) {
    const { signal } = abort;
    let written = 0;
    const started = Date.now();
    const put = async (bytes: Uint8Array) => {
      while (!signal.aborted && written + bytes.length - (this.read(generation) ?? 0) > this.ringBytes) await Bun.sleep(MEDIA_ACK_POLL_MS);
      if (signal.aborted) return false;
      for (let done = 0; done < bytes.length; ) {
        const at = (written + done) % this.ringBytes;
        const n = Math.min(bytes.length - done, this.ringBytes - at);
        writeSync(this.fd, bytes, done, n, LINK_USB_MEDIA_HEAD_BYTES + at);
        done += n;
      }
      written += bytes.length;
      this.head(generation, written, 0);
      return true;
    };
    this.head(generation, 0, 0);
    try {
      if (await put(ticket.header)) {
        let open = true;
        for await (const packet of ticket.produce(signal)) {
          if (!(open = await put(mediaPacket(packet)))) break;
        }
        if (open) await put(mediaPacket({ kind: MEDIA_PACKET.end, ptsMs: 0, data: new Uint8Array(0) }));
      }
    } catch {
      this.log(`usb media #${generation}: producer failed`);
      if (!signal.aborted) await put(mediaPacket({ kind: MEDIA_PACKET.error, ptsMs: 0, data: new TextEncoder().encode("Media source failed") }));
    } finally {
      if (this.abort === abort) this.head(generation, written, LINK_USB_MEDIA_CLOSED);
      this.log(`usb media #${generation}: ${written}B in ${Date.now() - started}ms${signal.aborted ? ", stopped" : ""}`);
    }
  }
}

/** What the carrier needs from the companion: its identity and the net path. */
export interface UsbCompanion {
  readonly id: string;
  readonly name: string;
  answerNet: import("./server.ts").Companion["answerNet"];
  log(line: string): void;
}

/** The request a slot last carried. It stays after the reply: the console's
 *  record sits in the file until its next request, and must not run twice. */
interface UsbSlot {
  boot: number;
  seq: number;
  abort: AbortController;
}

export class UsbCarrier {
  readonly root: string;
  readonly epoch = randomEpoch();
  device: (UsbDevice & { boot: number; since: number }) | undefined;
  private beat = 0;
  private lastHelloBeat = -1;
  private lastHelloAt = 0;
  private slots: (UsbSlot | undefined)[] = new Array(LINK_USB_SLOTS).fill(undefined);
  private media: UsbMedia | undefined;
  private beatTimer: ReturnType<typeof setInterval> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly companion: UsbCompanion,
    share: string,
    private readonly tuning: { beatMs?: number; pollMs?: number; mediaRingBytes?: number } = {},
  ) {
    this.root = join(resolve(share), LINK_USB_DIR);
  }

  start(): void {
    mkdirSync(this.root, { recursive: true });
    // Replies from an earlier run carry its epoch and could never match, but
    // a console that boots while they sit there would read each one once.
    for (let i = 0; i < LINK_USB_SLOTS; i += 1) rmSync(join(this.root, `net${i}.res`), { force: true });
    this.media = new UsbMedia(this.root, this.epoch, (line) => this.companion.log(line), this.tuning.mediaRingBytes);
    this.writeReady();
    this.beatTimer = setInterval(() => this.writeReady(), this.tuning.beatMs ?? LINK_USB_BEAT_MS);
    this.pollTimer = setInterval(() => this.poll(), this.tuning.pollMs ?? USB_POLL_MS);
    this.companion.log(`usb: serving ${this.root} as epoch ${this.epoch.toString(16)}`);
  }

  stop(): void {
    clearInterval(this.beatTimer);
    clearInterval(this.pollTimer);
    this.dropRequests();
    this.media?.close();
    this.media = undefined;
    rmSync(join(this.root, "ready"), { force: true });
  }

  /** The tethered console while its `hello` keeps beating. */
  linked(): (UsbDevice & { since: number }) | null {
    if (!this.device || Date.now() - this.lastHelloAt > LINK_USB_SILENCE_MS) return null;
    return this.device;
  }

  private writeReady() {
    this.beat = (this.beat + 1) >>> 0;
    const utc = Date.now();
    writeUsbRecord(join(this.root, "ready"), {
      epoch: this.epoch,
      boot: 0,
      seq: 0,
      kind: LINK_USB_KIND.ready,
      id: 0,
      beat: this.beat,
      json: {
        v: 1,
        id: this.companion.id,
        name: this.companion.name,
        features: [...LINK_USB_FEATURES],
        clock: { utc, offsetMinutes: -new Date(utc).getTimezoneOffset() },
      },
      body: new Uint8Array(0),
    });
  }

  private dropRequests() {
    for (const slot of this.slots) slot?.abort.abort();
    this.slots.fill(undefined);
    this.media?.stop();
  }

  /** One pass over `hello` and the request slots. */
  poll(): void {
    const hello = readUsbRecord(join(this.root, "hello"));
    if (hello && hello.kind === LINK_USB_KIND.hello && hello.epoch === this.epoch && hello.boot !== 0) {
      if (hello.boot !== this.device?.boot) {
        this.dropRequests();
        const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");
        this.device = {
          id: text(hello.json.device, 64),
          name: text(hello.json.name, 64),
          model: text(hello.json.model, 32),
          target: text(hello.json.target, 15),
          boot: hello.boot,
          since: Date.now(),
        };
        this.companion.log(`usb: "${this.device.name}" (${this.device.model} ${this.device.id}, ${this.device.target}) linked`);
      }
      if (hello.beat !== this.lastHelloBeat) {
        this.lastHelloBeat = hello.beat;
        this.lastHelloAt = Date.now();
      }
    }
    const device = this.device;
    if (!device) return;
    // A console that stopped beating reads nothing more from the ring.
    if (this.linked()) this.media?.poll(device.boot);
    else this.media?.stop();
    for (let i = 0; i < LINK_USB_SLOTS; i += 1) {
      const record = readUsbRecord(join(this.root, `net${i}.req`));
      if (!record || record.epoch !== this.epoch || record.boot !== device.boot) continue;
      const slot = this.slots[i];
      if (record.kind === LINK_USB_KIND.cancel) {
        // The slot keeps its seq, so the cancelled request never runs again.
        if (slot && slot.seq === record.seq) slot.abort.abort();
        continue;
      }
      if (record.kind !== LINK_USB_KIND.request || (slot && slot.seq === record.seq)) continue;
      if (slot?.boot === device.boot && record.seq < slot.seq) continue;
      slot?.abort.abort();
      const next: UsbSlot = { boot: device.boot, seq: record.seq, abort: new AbortController() };
      this.slots[i] = next;
      void this.answer(i, next, record, device);
    }
  }

  private async answer(index: number, slot: UsbSlot, record: UsbRecord, device: UsbDevice) {
    const reply = (json: unknown, body: Uint8Array = new Uint8Array(0)) => {
      if (slot.abort.signal.aborted || this.slots[index] !== slot) return;
      writeUsbRecord(join(this.root, `net${index}.res`), {
        epoch: this.epoch,
        boot: slot.boot,
        seq: slot.seq,
        kind: LINK_USB_KIND.reply,
        id: record.id,
        beat: 0,
        json,
        body,
      });
    };
    const id = record.id;
    const started = Date.now();
    let label = `usb net #${id}`;
    try {
      const { bytes, ...meta } = normalizeNetRequest(record.json);
      label = `usb net ${meta.method} ${meta.url}`;
      if (bytes !== record.body.length) throw new NetFailure(NET_ERROR.invalidRequest, `the request declared ${bytes} body bytes and carried ${record.body.length}`);
      const app = typeof record.json.app === "string" ? record.json.app : "";
      const response = await this.companion.answerNet(
        { ...meta, body: record.body },
        { app, target: device.target },
        // A media ticket's address is the TCP endpoint's; this console takes
        // the ticket through media.req, so the address only has to be valid.
        { name: device.name, address: "usb", localAddress: "127.0.0.1" },
        slot.abort.signal,
      );
      if (slot.abort.signal.aborted) return;
      this.companion.log(`${label} ${response.status} ${response.body.length}B ${Date.now() - started}ms`);
      reply(
        { t: "done", h: id, status: response.status, url: response.url, headers: response.headers, bytes: response.body.length },
        response.body,
      );
    } catch (failure) {
      if (slot.abort.signal.aborted) return;
      const f = failure instanceof NetFailure ? failure : new NetFailure(NET_ERROR.other, String(failure));
      this.companion.log(`${label} ${f.code}: ${f.message}`);
      reply({ t: "error", h: id, code: f.code, message: f.message.slice(0, 200) });
    }
  }
}
