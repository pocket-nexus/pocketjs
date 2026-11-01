// The podcasts service's stream through ffmpeg, as a console's media worker
// reads it: `codec=pal8` names PAL8 and opens with one picture ahead of the
// audio, because the 3DS and Tab5 workers start their speaker after the first
// decoded picture; the default stays rgb565 with audio alone for a GPU host.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MEDIA, MEDIA_CODEC, type MediaSource } from "../contracts/spec/media.ts";
import { createPodcastsService, findFfmpeg } from "../tools/companion/services/podcasts.ts";

const directory = mkdtempSync(join(tmpdir(), "pocket-podcasts-"));
const SECONDS = 1;

/** One second of a 16-bit stereo tone as a WAV file. */
function wav(): Buffer {
  const frames = MEDIA.sampleRate * SECONDS;
  const out = Buffer.alloc(44 + frames * 4);
  out.write("RIFF", 0); out.writeUInt32LE(36 + frames * 4, 4); out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(2, 22);
  out.writeUInt32LE(MEDIA.sampleRate, 24); out.writeUInt32LE(MEDIA.sampleRate * 4, 28);
  out.writeUInt16LE(4, 32); out.writeUInt16LE(16, 34); out.write("data", 36); out.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    const sample = Math.round(Math.sin((i * Math.PI * 2 * 440) / MEDIA.sampleRate) * 8000);
    out.writeInt16LE(sample, 44 + i * 4);
    out.writeInt16LE(sample, 46 + i * 4);
  }
  return out;
}

let audio: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  const body = wav();
  audio = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(new Uint8Array(body), { headers: { "content-type": "audio/wav" } }) });
});
afterAll(() => {
  audio.stop(true);
  rmSync(directory, { recursive: true, force: true });
});

async function play(query: string): Promise<MediaSource> {
  const service = createPodcastsService({ storeDir: directory, log: () => {} });
  const response = await service.handle({
    method: "GET",
    path: "/play",
    query: new URLSearchParams(`url=${encodeURIComponent(`http://127.0.0.1:${audio.port}/episode.wav`)}&at=0&duration=${SECONDS}${query}`),
    body: new Uint8Array(0),
    maxBytes: 4096,
    console: { name: "test", address: "127.0.0.1", localAddress: "127.0.0.1" },
    signal: new AbortController().signal,
  });
  expect(response?.status).toBe(200);
  return (JSON.parse(new TextDecoder().decode(response!.body)) as { source: MediaSource }).source;
}

/** The whole stream, granting a credit per media packet as the worker does. */
function receive(source: MediaSource): Promise<{ header: Buffer; kinds: number[]; packets: Buffer[]; wire: Buffer }> {
  return new Promise((done, reject) => {
    const socket = createConnection(source.port, source.host, () => socket.write(source.token));
    let bytes = Buffer.alloc(0);
    let at = MEDIA.headerBytes;
    const kinds: number[] = [];
    const packets: Buffer[] = [];
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, chunk as Buffer]);
      while (bytes.length >= at + MEDIA.packetHeaderBytes) {
        const size = bytes.readUInt32LE(at + 4);
        if (bytes.length < at + MEDIA.packetHeaderBytes + size) break;
        const kind = bytes[at]!;
        kinds.push(kind);
        packets.push(bytes.subarray(at, at + MEDIA.packetHeaderBytes + size));
        at += MEDIA.packetHeaderBytes + size;
        if (kind === 1 || kind === 2) socket.write(Buffer.of(1));
      }
    });
    socket.on("error", reject);
    socket.on("close", () => done({ header: bytes.subarray(0, MEDIA.headerBytes), kinds, packets, wire: bytes }));
  });
}

const ffmpegInstalled = findFfmpeg() !== null;

test.skipIf(!ffmpegInstalled)("codec=pal8 opens with one picture the native worker accepts, then the audio", async () => {
  const { header, kinds, packets } = await receive(await play("&codec=pal8"));
  expect(header.readUInt16LE(14)).toBe(MEDIA_CODEC.pal8);
  expect(kinds[0]).toBe(1);
  expect(kinds.filter((kind) => kind === 1)).toHaveLength(1);
  expect(kinds.filter((kind) => kind === 2).length).toBeGreaterThan(10);
  expect(kinds.at(-1)).toBe(3);

  // The firmware's own validators read the bytes: media_wire.h, as the Tab5 and the 3DS compile it.
  writeFileSync(join(directory, "wire.bin"), Buffer.concat([header, packets[0]!]));
  writeFileSync(join(directory, "check.c"), `#include "media_wire.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
int main(int argc,char **argv) {
  unsigned char h[32],p[16]; static unsigned char body[4096],ref[512*256]; MediaPal8 state={0};
  FILE *f=fopen(argv[1],"rb"); assert(f);
  assert(fread(h,1,32,f)==32); assert(media_header_valid(h)); assert(media_u16(h+14)==MEDIA_CODEC_PAL8);
  assert(fread(p,1,16,f)==16); assert(media_packet_valid(p)); assert(p[0]==1);
  size_t n=media_u32(p+4); assert(n<=sizeof body); assert(fread(body,1,n,f)==n);
  assert(media_pal8_apply(&state,ref,body,n));
  fclose(f); return 0;
}`);
  const compile = Bun.spawnSync(["cc", "-std=c11", "-I", resolve("engine/host-services"), join(directory, "check.c"), "-o", join(directory, "check")]);
  expect(compile.exitCode, compile.stderr.toString()).toBe(0);
  const run = Bun.spawnSync([join(directory, "check"), join(directory, "wire.bin")]);
  expect(run.exitCode, run.stderr.toString()).toBe(0);
}, 30_000);

test.skipIf(!ffmpegInstalled)("the default stays rgb565 with audio alone", async () => {
  const { header, kinds } = await receive(await play(""));
  expect(header.readUInt16LE(14)).toBe(MEDIA_CODEC.rgb565);
  expect(kinds.includes(1)).toBe(false);
  expect(kinds.filter((kind) => kind === 2).length).toBeGreaterThan(10);
}, 30_000);
