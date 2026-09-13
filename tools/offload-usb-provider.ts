/** App-scoped PSPLINK companion pairing. The explicit host0 directory is the
 * trust boundary; immutable generations and sequence checks fence stale files.
 * File IO belongs to this provider, capability code to its Worker. */
import {
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type {
  OffloadReply,
  OffloadRequest,
} from "../contracts/spec/offload.ts";
export const USB_MAGIC = 0x31424f50,
  USB_HEADER = 64;
export const usbSlot = (app: string) =>
  createHash("sha256").update(app).digest("hex").slice(0, 16);
export function usbHash(bytes: Uint8Array) {
  let h = 2166136261;
  for (const b of bytes) h = Math.imul(h ^ b, 16777619) >>> 0;
  return h;
}
export function usbPacket(
  epoch: number,
  boot: number,
  sequence: number,
  id: number,
  payload: Uint8Array,
) {
  if (payload.length > 4096) throw Error("USB record budget exceeded");
  const b = Buffer.alloc(USB_HEADER + payload.length);
  for (const [at, value] of [
    [0, USB_MAGIC],
    [4, epoch],
    [8, boot],
    [12, sequence],
    [20, id],
    [32, payload.length],
    [36, usbHash(payload)],
  ])
    b.writeUInt32LE(value >>> 0, at);
  b.set(payload, USB_HEADER);
  return b;
}
export function connectOffloadUsbProvider(options: {
  directory: string;
  app: string;
  worker: string | URL;
  data?: unknown;
  log?: (message: string) => void;
}) {
  const root = resolve(
    options.directory,
    "pocket-offload",
    usbSlot(options.app),
  );
  mkdirSync(root, { recursive: true });
  const epoch = randomBytes(4).readUInt32LE() || 1;
  const worker = new Worker(options.worker, { type: "module" });
  let stopped = false,
    heartbeat = 0,
    serial = 0,
    ready = false;
  const pending = new Map<
      number,
      { slot: number; boot: number; seq: number; id: number; deadline: number }
    >(),
    seen = Array(8).fill("");
  const publish = (name: string, bytes: Uint8Array) => {
    const path = resolve(root, name);
    writeFileSync(path + ".tmp", bytes);
    renameSync(path + ".tmp", path);
  };
  const offline = () => {
    try {
      unlinkSync(resolve(root, "ready"));
    } catch {}
  };
  offline();
  const close = () => {
    stopped = true;
    clearInterval(timer);
    offline();
    worker.terminate();
    pending.clear();
  };
  worker.onerror = close;
  worker.onmessage = ({
    data,
  }: MessageEvent<OffloadReply & { ready?: boolean }>) => {
    if (stopped) return;
    if (data.ready) {
      ready = true;
      return;
    }
    const p = pending.get(data.id);
    if (!p) return close();
    pending.delete(data.id);
    if (seen[p.slot] !== `${p.boot}/${p.seq}`) return;
    const payload = Buffer.from(JSON.stringify({ ...data, id: p.id }));
    if (payload.length > 4096) return close();
    publish(`res${p.slot}`, usbPacket(epoch, p.boot, p.seq, p.id, payload));
  };
  const timer = setInterval(() => {
    if (stopped || !ready) return;
    if ([...pending.values()].some((p) => Date.now() > p.deadline))
      return close();
    const beat = Buffer.alloc(64);
    beat.writeUInt32LE(USB_MAGIC, 0);
    beat.writeUInt32LE(epoch, 4);
    beat.writeUInt32LE(++heartbeat >>> 0, 8);
    publish("ready", beat);
    for (let slot = 0; slot < 8; slot++) {
      try {
        const path = resolve(root, `req${slot}`);
        // The file may be replaced while read: never allocate from its size.
        const fd = openSync(path, "r");
        let bytes: Buffer;
        try {
          const bounded = Buffer.alloc(4161);
          let length = 0;
          while (length < bounded.length) {
            const read = readSync(
              fd,
              bounded,
              length,
              bounded.length - length,
              null,
            );
            if (!read) break;
            length += read;
          }
          bytes = bounded.subarray(0, length);
        } finally {
          closeSync(fd);
        }
        if (
          bytes.length < 64 ||
          bytes.length > 4160 ||
          bytes.readUInt32LE(0) !== USB_MAGIC ||
          bytes.readUInt32LE(4) !== epoch
        )
          continue;
        const boot = bytes.readUInt32LE(8),
          seq = bytes.readUInt32LE(12),
          length = bytes.readUInt32LE(32),
          identity = `${boot}/${seq}`;
        if (
          identity === seen[slot] ||
          !length ||
          length > 4096 ||
          bytes.length !== 64 + length ||
          usbHash(bytes.subarray(64)) !== bytes.readUInt32LE(36)
        )
          continue;
        const request = JSON.parse(
          bytes.subarray(64).toString(),
        ) as OffloadRequest;
        if (
          request.v !== 1 ||
          !Number.isSafeInteger(request.id) ||
          request.id < 1 ||
          typeof request.method !== "string" ||
          typeof request.payload !== "string" ||
          request.payload.length > 2500
        )
          continue;
        if (
          pending.size >= 8 ||
          [...pending.values()].some((p) => p.slot === slot)
        )
          continue;
        seen[slot] = identity;
        const id = ++serial;
        pending.set(id, {
          slot,
          boot,
          seq,
          id: request.id,
          deadline: Date.now() + 9000,
        });
        worker.postMessage({ ...request, id });
      } catch {
        /* Missing, partial or replaced records are retried by sequence. */
      }
    }
  }, 20);
  worker.postMessage({ init: options.data });
  options.log?.(`Paired USB companion directory: ${root}`);
  return { close, root };
}
