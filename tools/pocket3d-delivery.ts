// A game's packs brought to a console over the LAN: the pieces the console
// lacks, then the list, then (when asked) the pieces the list no longer names
// removed. The console's side is hosts/3ds/src/packs_delivery.c; the format
// and the steps are in docs/POCKET3D-PACKS.md.
//
// The paired connection (PocketRuntimeClient) carries one control line a step.
// The bytes go over a temporary HTTP endpoint on this computer that serves the
// manifest's pieces and its text under a random token, and nothing else.

import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { pocketRuntimeCrc32 } from "../contracts/spec/pocket-runtime-wire.ts";
import type { PocketRuntimeClient } from "./3ds-runtime-client.ts";
import { checkPacks, PACKS_FILE, parseManifest, pieceFile, piecesOf } from "./pocket3d-packs.ts";

/** The part of a paired client the delivery uses. */
export type DeliveryClient = Pick<PocketRuntimeClient, "host" | "sendCtrl" | "waitForCtrl">;

export interface DeliverOptions {
  /** This computer's IPv4 address as the console reaches it. Default: the interface the route to the console leaves by. */
  readonly host?: string;
  readonly port?: number;
  /** Remove the pieces the console holds that the manifest does not name. */
  readonly prune?: boolean;
  /** Have the console read each piece it holds and compare its CRC-32, instead of taking a file of the name and the size. */
  readonly verify?: boolean;
  /** For one piece. Default 5 minutes. */
  readonly timeoutMs?: number;
  readonly onPiece?: (piece: { name: string; bytes: number; had: boolean }, done: number, of: number) => void;
}

export interface Delivered {
  /** Pieces sent, and their bytes. */
  sent: number;
  bytes: number;
  /** Pieces the console had. */
  had: number;
  /** Pieces removed from the console. */
  removed: number;
  ms: number;
}

function ipv4(host: string): boolean {
  const first = Number(host.split(".")[0]);
  return isIP(host) === 4 && first > 0 && first < 224;
}

/** The local address the route to `device` leaves by. A UDP connect chooses it without sending a packet. */
export async function hostFor(device: string): Promise<string> {
  if (!ipv4(device)) throw new Error("pocket3d-delivery: the console's host must be an IPv4 address");
  const socket = createSocket("udp4");
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.connect(8131, device, resolve);
    });
    return socket.address().address;
  } finally {
    socket.close();
  }
}

/**
 * Brings the console behind `client` up to date with `directory`'s `manifest` (as `writePacks` wrote
 * them). Every piece is checked against its name before the endpoint opens. Keep the client for this
 * call alone until it settles: the console's frame loop waits during each step.
 */
export async function deliver(client: DeliveryClient, directory: string, manifest: string, options: DeliverOptions = {}): Promise<Delivered> {
  const start = performance.now();
  checkPacks(directory, manifest);
  const text = readFileSync(join(directory, manifest));
  const pieces = piecesOf(parseManifest(text.toString("utf8")));
  const host = options.host ?? (await hostFor(client.host));
  if (!ipv4(host)) throw new Error("pocket3d-delivery: this computer's host must be an IPv4 address");
  const token = randomBytes(32).toString("hex");
  const files = new Map<string, string>([[PACKS_FILE, join(directory, manifest)], ...pieces.map((piece) => [pieceFile(piece), join(directory, pieceFile(piece))] as [string, string])]);
  const server = Bun.serve({
    hostname: host,
    port: options.port ?? 0,
    // A console writes to its card between reads.
    idleTimeout: 255,
    fetch(request) {
      const url = new URL(request.url);
      const [, key, name, ...more] = url.pathname.split("/");
      const path = key === token && more.length === 0 ? files.get(name ?? "") : undefined;
      if (request.method !== "GET" || !path || url.search || request.headers.has("range")) return new Response("Not found", { status: 404 });
      const file = Bun.file(path);
      return new Response(file, { headers: { "Content-Type": "application/octet-stream", "Content-Length": String(file.size), "Cache-Control": "no-store", Connection: "close" } });
    },
  });
  const timeout = options.timeoutMs ?? 5 * 60 * 1000;
  /** One step: the answer's listener is there before the line is written, so a quick answer is not missed. */
  const step = async (answer: string, body: Record<string, unknown>, match: (message: Record<string, unknown>) => boolean = () => true) => {
    const response = client.waitForCtrl((message) => message.t === answer && match(message as Record<string, unknown>), timeout);
    const [message] = await Promise.all([response, client.sendCtrl({ t: "pocket3d.packs", ...body } as never)]);
    if ((message as Record<string, unknown>).ok !== true) throw new Error(`pocket3d-delivery: the console answered "${String((message as Record<string, unknown>).error || "no reason")}"`);
    return message as Record<string, unknown>;
  };
  const from = { host, port: server.port!, token };
  const result: Delivered = { sent: 0, bytes: 0, had: 0, removed: 0, ms: 0 };
  try {
    for (const [index, piece] of pieces.entries()) {
      const crc32 = pocketRuntimeCrc32(readFileSync(files.get(pieceFile(piece))!));
      const message = await step("pocket3d.piece", { piece: { ...from, name: piece.name, bytes: piece.bytes, crc32, ...(options.verify ? { verify: true } : {}) } }, (m) => m.name === piece.name);
      const had = message.cached === true;
      if (had) result.had++;
      else {
        result.sent++;
        result.bytes += piece.bytes;
      }
      options.onPiece?.({ name: piece.name, bytes: piece.bytes, had }, index + 1, pieces.length);
    }
    // The list last: a console that lost the connection half way still reads its old list and the pieces it names.
    await step("pocket3d.manifest", { manifest: { ...from, bytes: text.length, crc32: pocketRuntimeCrc32(text) } });
    if (options.prune) result.removed = Number((await step("pocket3d.pruned", { prune: true })).removed ?? 0);
  } finally {
    await server.stop(true);
  }
  result.ms = Math.round(performance.now() - start);
  return result;
}
